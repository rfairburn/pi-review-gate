/** Unknown artifact/setup exceptions must not turn run return into stop proof. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerCommands } from "../src/commands";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { beginAgentRun, createState, rememberUserRequest, snapshotReviewBaseline } from "../src/state";
import { recordToolCallEvidence, recordToolResultEvidence } from "../src/evidence";
import { waitForPromiseBounded } from "../src/adapters/process";
import { fakeNeedsChangesConfig } from "./helpers";

for (const path of ["automatic", "review-now", "ask-reviewer"] as const) {
  test(`${path}: /review-cancel races an unknown invocation-artifact exception`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "prg-cancel-unknown-"));
    const cwd = join(root, "repo");
    const cancellation = createReviewCancellationCoordinator();
    const state = createState();
    let pending: Promise<unknown> | undefined;
    let coordinator: ReturnType<typeof createReviewTurnCoordinator> | undefined;
    let fail!: (error: Error) => void;
    let prepared!: () => void;
    const reachedPreparation = new Promise<void>((resolve) => { prepared = resolve; });
    const artifactWrite = new Promise<void>((_resolve, reject) => { fail = reject; });
    void artifactWrite.catch(() => undefined); // Also own rejection on partial fixture setup.
    const failure = new Error("private invocation artifact error");
    try {
      await mkdir(cwd);
      execFileSync("git", ["init", "-q"], { cwd });
      await writeFile(join(cwd, "index.ts"), "before\n");
      rememberUserRequest(state, "change index");
      const window = state.reviewWindow!;
      const snapshotOptions = { maxFileBytes: 1048576, maxSnapshotBytes: 52428800 };
      window.baseline = snapshotReviewBaseline(await createWorkspaceSnapshot(cwd, snapshotOptions));
      const baseline = window.baseline;
      // Automatic review requires agent tool activity: model the agent's write
      // tool around the actual write; command paths stay filesystem-only controls.
      const write = { toolName: "write", toolInput: { path: "index.ts", content: "after\n" } };
      if (path === "automatic") beginAgentRun(state);
      const exchangeSequence = path === "automatic" ? window.activeExchange!.sequence : undefined;
      if (path === "automatic") await recordToolCallEvidence({ state: window.evidence, cwd, ...write, snapshotOptions, exchangeSequence });
      await writeFile(join(cwd, "index.ts"), "after\n");
      if (path === "automatic") recordToolResultEvidence({ state: window.evidence, ...write, result: { content: [{ type: "text", text: "Wrote index.ts" }] }, exchangeSequence });
      const config = fakeNeedsChangesConfig();
      const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
      const notices: string[] = [];
      const sent: string[] = [];
      const ctx = { ui: { notify(message: string) { notices.push(message); }, setStatus() {} } };
      const pi = { registerCommand(name: string, options: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, options); },
        sendUserMessage(message: string) { sent.push(message); } };
      let preparedOnce = false;
      const prepare = () => {
        if (preparedOnce) return Promise.resolve();
        preparedOnce = true;
        prepared();
        return artifactWrite;
      };
      registerCommands({ pi, cwd: () => cwd, config, state, cancellation, onStateChanged: prepare });
      let saves = 0;
      coordinator = createReviewTurnCoordinator({
        pi, state, config, cancellation, scopedModels: () => [], isSessionActive: () => true,
        observeCwd() {}, cwd: () => cwd, syncExecutionContext() {}, checkpointRestartBlocked: () => undefined,
        effectiveReviewConfig: () => config, persist: async () => { if (++saves === 2) await prepare(); }, persistAutomaticDelivery: async () => true,
        backgroundShell: () => undefined, reviewReadiness: () => [], reapplyDeferredTools() {},
        orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
      });
      const owner = path === "automatic" ? coordinator.onAgentSettled([ctx]) : commands.get(path)!.handler(path === "review-now" ? "" : "is this safe?", ctx);
      // Own the rejection before permitting the injected persistence failure.
      pending = owner.then(() => undefined, (error: unknown) => error);
      assert.equal((await waitForPromiseBounded(reachedPreparation, 5000)).kind, "fulfilled", "bounded invocation preparation");
      const cancel = commands.get("review-cancel")!.handler("", ctx);
      fail(failure);
      await cancel;
      assert.equal(await pending, failure, "original artifact failure still propagates");
      assert.equal(notices.filter((message) => message.includes("cancelled;")).length, 1);
      assert.match(notices.join("\n"), /cancelled; reviewer process termination unconfirmed; cleanup uncertain/);
      assert.doesNotMatch(notices.join("\n"), /reviewer processes stopped|private invocation artifact error/);
      assert.equal(sent.length, 0);
      assert.equal(window.baseline, baseline);
      assert.equal(cancellation.current(), undefined);
    } finally {
      fail(failure);
      cancellation.current()?.requestCancel("manual");
      await pending;
      await coordinator?.shutdownReview();
      if (state.reviewWindow?.bundleDir) await rm(state.reviewWindow.bundleDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}
