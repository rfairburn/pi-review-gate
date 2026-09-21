// Extension entrypoint uncertain-transmission suites: durable uncertainty when
// the automatic review transmission cannot be confirmed, bounded diagnostics,
// fail-closed persistence failures, shutdown races, and in-session notice
// deduplication against pre-existing uncertain records.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { freezeReviewWindowConfig } from "../src/state";
import { SessionStateStore } from "../src/session-state";
import {
  indexTestConfig,
  trigger,
} from "./entrypoint-harness";
async function createUncertainTransmissionHarness(input: {
  dir: string;
  sessionFile: string;
  diagnostic?: string;
  beforeThrow?: () => void | Promise<void>;
}): Promise<{
  mkRuntime: (sessionId: string) => {
    hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
    notices: string[];
    followUps: Array<{ message: string; options: unknown }>;
    pi: unknown;
    ctx: unknown;
  };
}> {
  await writeFile(join(input.dir, "index.ts"), "before\n", "utf8");
  const configPath = join(input.dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed',findings:[]})))",
      ],
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
      { source: "external", id: "fake" }
    ] },
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;

  const mkRuntime = (sessionId: string) => {
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand() {},
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
        if (input.diagnostic === undefined) return;
        return Promise.resolve(input.beforeThrow?.()).then(() => {
          throw new Error(input.diagnostic);
        });
      },
    };
    // The in-session notice channel lives on the hook context, not on the raw
    // extension object: notices are collected only through ctx.ui.notify so
    // the tests prove uncertain-delivery notices reach the user-visible
    // channel that agent_settled actually targets.
    const ctx = {
      cwd: input.dir,
      ui: {
        notify(message: string) { notices.push(message); },
      },
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => input.sessionFile,
        getCwd: () => input.dir,
      },
    };
    return { hooks, notices, followUps, pi, ctx };
  };

  return { mkRuntime };
}

test("a throwing automatic transmission is durably uncertain and surfaced once in-session without rejecting agent_settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-transmission-"));
  const sessionFile = join(dir, "uncertain-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable: the follow-up channel rejected the review transmission",
    });

    // First session: the automatic review passes and the follow-up transport
    // throws. The delivery must be durably uncertain and surfaced exactly
    // once in-session, and agent_settled must resolve rather than reject.
    const first = mkRuntime("uncertain-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "change index", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "agent_end", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "agent_settled", { cwd: dir }, first.ctx);

    assert.equal(first.followUps.length, 1, "the transport was attempted exactly once");
    const uncertainNotices = first.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1, "exactly one in-session uncertain notice");
    assert.match(uncertainNotices[0] ?? "", /delivery [0-9a-f]{64} is uncertain/);
    assert.match(uncertainNotices[0] ?? "", /transport unavailable/);
    assert.match(uncertainNotices[0] ?? "", /inspect .*\/reviews\/0001/);
    assert.doesNotMatch(uncertainNotices[0] ?? "", /was not delivered/);

    // The delivery is durably uncertain in the persisted state.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string; diagnostic?: string; invocationDir?: string }> };
    };
    const delivery = persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(delivery, "the review transmission has a durable delivery record");
    assert.equal(delivery.status, "uncertain");
    assert.match(delivery.diagnostic ?? "", /transport unavailable/);

    // Restart recovery must not re-dispatch the uncertain delivery and must
    // not duplicate the in-session notice: the recovery notice is the
    // existing manual-inspection protocol, without the transport diagnostic.
    const resumed = mkRuntime("uncertain-conversation");
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.equal(resumed.followUps.length, 0, "restart must not re-dispatch an uncertain delivery");
    const resumedUncertain = resumed.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(resumedUncertain.length, 1, "recovery emits the existing manual-inspection notice once");
    assert.match(resumedUncertain[0] ?? "", /was not duplicated automatically/);
    assert.doesNotMatch(resumedUncertain[0] ?? "", /transport unavailable/, "the in-session diagnostic notice is not duplicated on restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uncertain transmission notices bound long transport diagnostics with visible truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-truncation-"));
  const sessionFile = join(dir, "truncation-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    const longDiagnostic = `provider transport rejected the follow-up with a verbose internal trace: ${'x'.repeat(400)}`;
    const { mkRuntime } = await createUncertainTransmissionHarness({ dir, sessionFile, diagnostic: longDiagnostic });

    const runtime = mkRuntime("truncation-conversation");
    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);
    await trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx);

    const uncertainNotices = runtime.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1);
    const notice = uncertainNotices[0] ?? "";
    const marker = "… (truncated)";
    const bounded = longDiagnostic.replace(/\s+/g, " ").trim().slice(0, 200 - marker.length);
    assert.ok(notice.includes(`${bounded}${marker}`), "the notice carries the bounded diagnostic including its marker");
    assert.match(notice, /… \(truncated\)/);
    assert.ok(notice.length < longDiagnostic.length, "the notice is bounded below the raw diagnostic length");
    assert.doesNotMatch(notice, /x{400}/, "the diagnostic tail is not echoed into the notice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing uncertain-state persist rejects agent_settled without emitting the uncertainty notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-persist-"));
  const sessionFile = join(dir, "uncertain-persist-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const statePath = `${sessionFile}.pi-review-gate-state.json`;

  try {
    // The transport throws AND the persist of the uncertain transition itself
    // fails: the follow-up channel first makes the state directory read-only
    // so the uncertain-state save cannot become durable. The exception must
    // keep propagating (agent_settled rejects) and no uncertainty notice may
    // be emitted, because no durable uncertain transition was established.
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable: the follow-up channel rejected the review transmission",
      beforeThrow: async () => {
        await chmod(dir, 0o555);
      },
    });

    const runtime = mkRuntime("uncertain-persist-conversation");
    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);
    await assert.rejects(
      trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx),
      /EACCES|permission denied/,
      "agent_settled must reject when the uncertain transition never became durable",
    );

    assert.equal(
      runtime.notices.filter((notice) => notice.includes("is uncertain")).length,
      0,
      "no in-session uncertainty notice without a durable uncertain transition",
    );

    // The durable record never reached uncertain: the last successful save
    // happened while the dispatch was still in flight.
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string }> };
    };
    const record = persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(record, "the queued review transmission has a durable delivery record");
    assert.equal(record.status, "dispatching");
  } finally {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown before uncertain-state persistence does not masquerade as a durable uncertainty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-shutdown-"));
  const sessionFile = join(dir, "uncertain-shutdown-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");
  let shutdownMidDispatch: (() => Promise<void>) | undefined;

  try {
    // The session shuts down while the follow-up dispatch is in flight: the
    // shutdown hook force-persists the record as `dispatching`, and every
    // persistence after that is a silent no-op. The transport then throws and
    // the uncertain transition never becomes durable, so the exception must
    // propagate (agent_settled rejects) with no uncertainty notice.
    const { mkRuntime } = await createUncertainTransmissionHarness({
      dir,
      sessionFile,
      diagnostic: "transport unavailable during shutdown",
      beforeThrow: () => shutdownMidDispatch?.(),
    });

    const runtime = mkRuntime("uncertain-shutdown-conversation");
    shutdownMidDispatch = () => trigger(
      runtime.hooks,
      "session_shutdown",
      { type: "session_shutdown", reason: "quit" },
      runtime.ctx,
    );

    await activate(runtime.pi);
    await trigger(runtime.hooks, "session_start", { type: "session_start", reason: "startup" }, runtime.ctx);
    await trigger(runtime.hooks, "input", { cwd: dir, text: "change index", source: "user" }, runtime.ctx);
    await trigger(runtime.hooks, "before_agent_start", { cwd: dir }, runtime.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(runtime.hooks, "agent_end", { cwd: dir }, runtime.ctx);

    await assert.rejects(
      trigger(runtime.hooks, "agent_settled", { cwd: dir }, runtime.ctx),
      /transport unavailable during shutdown/,
      "agent_settled must reject when the uncertain transition was never durably saved",
    );
    assert.equal(
      runtime.notices.filter((notice) => notice.includes("is uncertain")).length,
      0,
      "no in-session uncertainty notice without a durable uncertain transition",
    );

    // The durable record was last saved by the forced shutdown persist while
    // the dispatch was still in flight: `dispatching`, never `uncertain`.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { pendingModelDeliveries: Array<{ kind: string; status: string }> };
    };
    assert.equal(
      persisted.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission")?.status,
      "dispatching",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing uncertain delivery record cannot duplicate the in-session notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-uncertain-dedupe-"));
  const sessionFile = join(dir, "dedupe-conversation.jsonl");
  await writeFile(sessionFile, "", "utf8");

  try {
    // Runtime A completes a full pass cycle with a working follow-up channel.
    const working = await createUncertainTransmissionHarness({ dir, sessionFile });
    const first = working.mkRuntime("dedupe-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "change index", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "agent_end", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "agent_settled", { cwd: dir }, first.ctx);
    assert.equal(first.followUps.length, 1);

    // Durable state now holds a delivered review_transmission record and the
    // still-open review window. Rewrite the record to a pre-existing
    // uncertain state (without its delivery receipt, as if the prior dispatch
    // had been left uncertain) and rewind the review sequence so the next
    // automatic transmission is a deduplicated rediscovery of that record.
    const store = new SessionStateStore({ sessionId: "dedupe-conversation", sessionFile, cwd: dir });
    const restored = await store.restore(dir);
    assert.ok(restored, "persisted conversation state restores");
    const record = restored.state.pendingModelDeliveries.find((entry) => entry.kind === "review_transmission");
    assert.ok(record, "runtime A persisted the review transmission delivery record");
    assert.equal(record.status, "delivered");
    const invocationDir = record.invocationDir;
    assert.ok(invocationDir);
    const window = restored.state.reviewWindow;
    assert.ok(window, "runtime A persisted an open review window");
    assert.equal(window.bundleDir, dirname(dirname(invocationDir)));
    await rm(join(invocationDir, "delivery.json"), { force: true });
    record.status = "uncertain";
    record.diagnostic = "The prior dispatch was left uncertain.";
    window.nextReviewSequence = 1;
    // Re-freeze the restored window against the same settings the runtime
    // loaded and save with the frozen config so the sidecar carries the
    // canonical selection digest, exactly as the production runtime persists it.
    freezeReviewWindowConfig(restored.state, normalizeConfig(JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"))));
    await store.save(restored.state, restored.execution, restored.state.reviewWindow?.reviewConfig);

    // Runtime B: recovery surfaces the pre-existing uncertainty once via the
    // manual-inspection protocol. A second review whose transmission
    // deduplicates against the uncertain record must not emit a second
    // in-session uncertainty notice and must not re-send the follow-up.
    const second = working.mkRuntime("dedupe-conversation");
    await activate(second.pi);
    await trigger(second.hooks, "session_start", { type: "session_start", reason: "resume" }, second.ctx);
    assert.equal(second.followUps.length, 0, "recovery does not re-dispatch an uncertain delivery");
    await trigger(second.hooks, "input", { cwd: dir, text: "change index again", source: "user" }, second.ctx);
    await trigger(second.hooks, "before_agent_start", { cwd: dir }, second.ctx);
    await writeFile(join(dir, "index.ts"), "after again\n", "utf8");
    await trigger(second.hooks, "agent_end", { cwd: dir }, second.ctx);
    await assert.rejects(
      trigger(second.hooks, "agent_settled", { cwd: dir }, second.ctx),
      /uncertain prior dispatch/,
      "a pre-existing uncertain record is not masked as fresh transport uncertainty",
    );

    assert.equal(second.followUps.length, 0, "no duplicate transmission was sent");
    const uncertainNotices = second.notices.filter((notice) => notice.includes("is uncertain"));
    assert.equal(uncertainNotices.length, 1, "exactly one in-session uncertainty notice: the recovery notice");
    assert.match(uncertainNotices[0] ?? "", /was not duplicated automatically/);
    assert.doesNotMatch(second.notices.join("\n"), /was not retried automatically/, "no second uncertainty notice for the pre-existing uncertain record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
