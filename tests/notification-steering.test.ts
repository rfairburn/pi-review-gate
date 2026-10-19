/**
 * Issue #452 send-path proof: eligible review/notification deliveries steer at
 * the actual send point instead of waiting for the natural stop, while their
 * durable identity (recorded `channel`, delivery id, message bytes, receipt
 * key) and genuine review-held user input admission are preserved.
 *
 * These are direct send integrations: the fake host records exactly what the
 * production delivery code called, so a "follow-up" regression fails here even
 * though the persisted record still says `channel: "follow_up"`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import {
  deliverAutomaticTransmission,
  recoverPendingModelDeliveries,
  releaseQueuedUserInputs,
} from "../src/activation/pending-delivery";
import { modelDeliveryId, queueModelDelivery } from "../src/durable-delivery";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import type { ReviewRunOutput } from "../src/review";
import { createState, rememberUserRequest } from "../src/state";
import { writeReviewDeliveryReceipt } from "../src/transmission";
import { fakeNeedsChangesConfig } from "./helpers";

interface Sent {
  message: string;
  options: unknown;
}

function recordingPi() {
  const sent: Sent[] = [];
  const messages: Array<{ content: unknown; delivery: unknown }> = [];
  const notices: string[] = [];
  const pi = {
    ui: { notify(message: string) { notices.push(message); } },
    sendUserMessage(message: string, options?: unknown) {
      sent.push({ message, options });
    },
    sendMessage(message: { content?: unknown }, delivery: unknown) {
      messages.push({ content: message?.content, delivery });
    },
  };
  return { pi, sent, messages, notices };
}

async function withDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an automatic review transmission steers, preserving its durable identity and bytes (#452)", async () => {
  await withDir("prg-notify-steer-", async (invocationDir) => {
    const state = createState();
    const { pi, sent } = recordingPi();
    const message = "Review pass 1 transmission for the implementing model.\n\nGate verdict: pass\n";
    await deliverAutomaticTransmission(
      pi,
      pi,
      state,
      { invocationDir } as unknown as ReviewRunOutput,
      "passed",
      message,
      () => true,
      async () => true,
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.message, message, "the delivered message bytes must be unchanged");
    assert.deepEqual(sent[0]!.options, { deliverAs: "steer" }, "the automatic transmission must steer at the send point");

    const delivery = state.pendingModelDeliveries[0]!;
    // The recorded channel is the durable identity axis: it keeps its stored
    // value even though the send lane is steering.
    assert.equal(delivery.channel, "follow_up");
    assert.equal(
      delivery.deliveryId,
      modelDeliveryId({ kind: "review_transmission", channel: "follow_up", invocationDir, action: "passed", message }),
      "the delivery id (and therefore the receipt key) must not change",
    );
    assert.equal(delivery.status, "delivered");

    const receipt = JSON.parse(await readFile(join(invocationDir, "delivery.json"), "utf8")) as {
      deliveries?: Array<{ action?: string; idempotencyKey?: string }>;
    };
    assert.equal(receipt.deliveries?.[0]?.idempotencyKey, delivery.deliveryId);
    assert.equal(receipt.deliveries?.[0]?.action, "passed");
  });
});

test("recovered pending notifications steer while held user input stays held (#452)", async () => {
  await withDir("prg-notify-recover-", async (invocationDir) => {
    const state = createState();
    const { pi, sent, notices } = recordingPi();
    const transmissionMessage = "Recovered review transmission bytes.";
    const authorizationMessage = "Review found blocking issues.\n\n1. index.ts - missing guard";
    const heldInput = "please also update the docs";

    const transmission = queueModelDelivery(state, {
      kind: "review_transmission",
      channel: "follow_up",
      invocationDir,
      action: "passed",
      message: transmissionMessage,
    });
    const authorization = queueModelDelivery(state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: authorizationMessage,
    });
    const held = queueModelDelivery(state, {
      deliveryId: "queued-user-input:window:1",
      kind: "queued_user_input",
      channel: "follow_up",
      message: heldInput,
    });
    state.queuedUserInputsDuringReview.push(heldInput);

    await recoverPendingModelDeliveries({
      pi,
      state,
      persist: async () => {},
      isSessionActive: () => true,
      notify: async (message) => { notices.push(message); },
    });

    assert.deepEqual(sent.map((entry) => entry.message), [transmissionMessage, authorizationMessage]);
    assert.deepEqual(sent.map((entry) => entry.options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
    // Genuine review-held input is not released by recovery: it is preserved
    // with its record and only the release path below may deliver it.
    assert.equal(sent.some((entry) => entry.message === heldInput), false);
    assert.equal(held.status, "queued");
    assert.deepEqual(state.queuedUserInputsDuringReview, [heldInput]);
    assert.ok(notices.some((notice) => notice.includes("remain queued")));

    // Durable identity is untouched for every record, including the recovery.
    assert.equal(transmission.channel, "follow_up");
    assert.equal(transmission.deliveryId, modelDeliveryId({
      kind: "review_transmission", channel: "follow_up", invocationDir, action: "passed", message: transmissionMessage,
    }));
    assert.equal(authorization.channel, "follow_up");
    assert.equal(authorization.deliveryId, modelDeliveryId({
      kind: "review_authorization", channel: "follow_up", message: authorizationMessage,
    }));

    // A second recovery is idempotent: the receipt suppresses the transmission
    // and nothing already delivered is sent again.
    await recoverPendingModelDeliveries({
      pi,
      state,
      persist: async () => {},
      isSessionActive: () => true,
      notify: async (message) => { notices.push(message); },
    });
    assert.equal(sent.length, 2);
  });
});

test("an unrecognized persisted delivery kind is preserved and never sent or acknowledged (#452)", async () => {
  await withDir("prg-notify-unknown-", async (invocationDir) => {
    const state = createState();
    const { pi, sent, notices } = recordingPi();
    const knownMessage = "Recognized notification bytes.";
    const corruptMessage = "corrupt persisted notification";
    const known = queueModelDelivery(state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: knownMessage,
    });
    // Restore only member-unvalidates the array, so an unknown kind can reach
    // recovery. It carries an invocationDir with a matching receipt to prove
    // the allowlist runs before any receipt-based acknowledgement.
    const corrupt = queueModelDelivery(state, {
      deliveryId: "corrupt-delivery:1",
      kind: "unrecognized_notification" as never,
      channel: "follow_up",
      invocationDir,
      action: "passed",
      message: corruptMessage,
    });
    await writeReviewDeliveryReceipt(invocationDir, "passed", corruptMessage, corrupt.deliveryId);

    await recoverPendingModelDeliveries({
      pi,
      state,
      persist: async () => {},
      isSessionActive: () => true,
      notify: async (message) => { notices.push(message); },
    });

    assert.deepEqual(sent.map((entry) => entry.message), [knownMessage]);
    assert.deepEqual(sent[0]!.options, { deliverAs: "steer" });
    assert.equal(known.status, "delivered");
    // Fail closed: preserved, still queued, diagnosed, and never acknowledged.
    assert.equal(sent.some((entry) => entry.message === corruptMessage), false);
    assert.equal(corrupt.status, "queued");
    assert.match(corrupt.diagnostic ?? "", /unrecognized/i);
    assert.ok(notices.some((notice) => notice.includes("unrecognized kind") && notice.includes(corrupt.deliveryId)));
    assert.equal(corrupt.channel, "follow_up");

    // Idempotent: a later recovery still refuses to send or acknowledge it.
    await recoverPendingModelDeliveries({
      pi,
      state,
      persist: async () => {},
      isSessionActive: () => true,
      notify: async (message) => { notices.push(message); },
    });
    assert.equal(sent.length, 1);
    assert.equal(corrupt.status, "queued");
  });
});

test("releasing genuine review-held user input keeps the follow-up admission (#452)", async () => {
  const state = createState();
  const { pi, sent } = recordingPi();
  const heldInput = "hold this until the review finishes";
  const delivery = queueModelDelivery(state, {
    deliveryId: "queued-user-input:window:2",
    kind: "queued_user_input",
    channel: "follow_up",
    message: heldInput,
  });
  state.queuedUserInputsDuringReview.push(heldInput);

  await releaseQueuedUserInputs(pi, state, () => true, async () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message, heldInput, "held input bytes must be unchanged");
  assert.deepEqual(sent[0]!.options, { deliverAs: "followUp" }, "genuine held input keeps its follow-up release");
  assert.equal(delivery.status, "delivered");
  assert.deepEqual(state.queuedUserInputsDuringReview, []);
});

test("a background-completion resume steers into a still-active run instead of waiting for its settlement (#452)", { timeout: 15_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("process-group readiness proof is POSIX-specific");
    return;
  }
  const { pi, messages, notices } = recordingPi();
  const state = createState();
  rememberUserRequest(state, "implement the change");
  state.reviewWindow!.baseline = { kind: "tool", cwd: process.cwd(), capturedAt: new Date().toISOString() };
  const config = fakeNeedsChangesConfig();
  const coordinator = createReviewTurnCoordinator({
    pi,
    state,
    config,
    cancellation: createReviewCancellationCoordinator(),
    scopedModels: () => [],
    isSessionActive: () => true,
    observeCwd() {},
    cwd: () => process.cwd(),
    syncExecutionContext() {},
    checkpointRestartBlocked: () => undefined,
    effectiveReviewConfig: () => config,
    persist: async () => {},
    persistAutomaticDelivery: async () => true,
    // No shell controller: this exercises the legacy ShellStart-readiness
    // fallback whose resume notification used to wait for agentRunActive.
    backgroundShell: () => undefined,
    reviewReadiness: () => [],
    reapplyDeferredTools() {},
    orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
  });

  // One positively owned, detached process stands in for a live background
  // job's process group; it exits only when this test stops it.
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { detached: true, stdio: "ignore" });
  dummy.unref();
  t.after(async () => {
    if (dummy.exitCode === null && dummy.signalCode === null) {
      dummy.kill("SIGTERM");
      await once(dummy, "exit");
    }
  });
  assert.ok(dummy.pid);
  coordinator.observeBackgroundToolResult("ShellStart", {
    details: { kind: "pi-review-bg-shell", event: "started", id: "job1", label: "dummy", pid: dummy.pid, processGroupId: dummy.pid },
  });
  assert.equal(coordinator.currentBackgroundReadiness().running.length, 1);

  // Settle a run while readiness is blocked: automatic review defers and arms
  // the completion resume watcher.
  await coordinator.armAgentRun([{ cwd: process.cwd() }]);
  await coordinator.onAgentSettled([{ ui: pi.ui }]);
  assert.ok(notices.some((notice) => notice.includes("automatic review deferred")));

  // A new run is already active when the background job finishes. The resume
  // must steer at that run's next supported boundary, not wait for settlement.
  await coordinator.armAgentRun([{ cwd: process.cwd() }]);
  dummy.kill("SIGTERM");
  await once(dummy, "exit");

  const deadline = Date.now() + 8_000;
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(messages.length, 1, "the background-completion resume did not reach the still-active run");
  assert.deepEqual(messages[0]!.delivery, { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(coordinator.currentBackgroundReadiness().running, []);
});
