import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { runReview } from "../src/review";
import { ReviewEvidenceCaptureFailure, TOOL_ONLY_HISTORY_NOTICE } from "../src/review-evidence";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { isActiveTaskState } from "../src/execution/task-state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";
import { removeReviewBundle } from "../src/bundle";
import { GenericCliAdapter } from "../src/adapters/generic-cli";
import * as reviewActivity from "../src/activation/review-activity";
import type { ModelAdapterRequest } from "../src/adapters/types";
import type { ReviewResult } from "../src/schema";
import { Key, matchesKey } from "pi-session-host-tui";
import { setMenuTuiHost } from "../src/settings/menu";
import { createTuiSettingsContext, KEY_DOWN, KEY_ENTER } from "./menu-tui-fakes";
const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
import * as checkpoints from "../src/review-checkpoint";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import { countingPassReviewerWithPromptDump, createSessionRuntime, extractBundleDir, indexTestConfig, testAgentDir, trigger, triggerAgentEnd } from "./entrypoint-harness";

const fixtureEnvKeys = ["HOME", "GIT_CEILING_DIRECTORIES", "PI_REVIEW_GATE_CONFIG", "PI_REVIEW_GATE_DISABLED"] as const;
type FixtureRuntime = ReturnType<typeof createSessionRuntime>;
type FixtureSetupProbe = (stage: "beforeActivation" | "afterStartup", owned: { root: string; rt: FixtureRuntime }) => Promise<void>;

async function fixture(evidence: Record<string, boolean> = {}, primaryEnabled = true, maxCorrectionCycles = indexTestConfig.maxCorrectionCycles as number, setupProbe?: FixtureSetupProbe) {
  const priorEnv = fixtureEnvKeys.map((key) => [key, process.env[key]] as const);
  const root = await mkdtemp(join(await realpath(tmpdir()), "primary-tool-evidence-"));
  let runtime: FixtureRuntime | undefined;
  let activationStarted = false;
  let activationCompleted = false;
  // Own the allocation before the first setup await, not only after startup.
  const dispose = async () => {
    try {
      mock.restoreAll();
      const failures: unknown[] = [];
      if (activationStarted) {
        // One failed handler must not prevent other registered owners settling.
        for (const shutdown of runtime?.hooks.get("session_shutdown") ?? []) {
          try { await shutdown({ type: "session_shutdown", reason: "quit" }, runtime!.ctx); }
          catch (error) { failures.push(error); }
        }
        if (!activationCompleted || !runtime?.hooks.get("session_shutdown")?.length) {
          failures.push(new Error("activation incomplete; owned lifecycle settlement cannot be confirmed"));
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, `Primary evidence fixture cleanup uncertain; preserved owned root: ${root}`);
      }
      // mkdtemp returned this exact root; never infer ownership from a prefix.
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) { throw new Error(`Primary evidence fixture removal incomplete; remaining artifacts may be at: ${root}`, { cause: error }); }
    } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  try {
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(home);
    process.env.HOME = home;
    await mkdir(cwd);
    process.env.GIT_CEILING_DIRECTORIES = root;
    const configPath = join(root, "config.json");
    const calls = join(root, "calls");
    const prompt = join(root, "prompt");
    const sessionFile = join(root, "conversation.jsonl");
    await writeFile(sessionFile, "");
    await writeFile(join(cwd, "SCRIPT"), "BEFORE_SCRIPT\n");
    await writeFile(configPath, JSON.stringify({ ...indexTestConfig, maxCorrectionCycles, retainBundles: "always",
      youShouldKnow: { enabled: false, completionGuidance: false },
      externalAgents: agentCatalog(countingPassReviewerWithPromptDump("fake", calls, prompt)),
      review: { primaryReviewers: [{ source: "external", id: "fake" }], primaryEnabled, evidence },
    }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const rt = createSessionRuntime("primary-evidence", sessionFile, cwd);
    runtime = rt;
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
    rt.pi.registerCommand = (name, options) => { commands.set(name, options.handler); };
    const warnings: string[] = [];
    Object.assign(rt.pi, { sendMessage(message: { content: string }) { warnings.push(message.content); } });
    await setupProbe?.("beforeActivation", { root, rt });
    activationStarted = true;
    await activate(rt.pi);
    activationCompleted = true;
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
    await setupProbe?.("afterStartup", { root, rt });
    const store = new SessionStateStore({ sessionId: "primary-evidence", sessionFile, cwd });
    const restored = () => store.restore(cwd, { agentDir: testAgentDir, sessionId: "primary-evidence" });
    const start = async (text = "change SCRIPT") => {
      await trigger(rt.hooks, "input", { cwd, source: "user", text }, rt.ctx);
      await trigger(rt.hooks, "before_agent_start", { cwd }, rt.ctx);
    };
    const writeScript = async (content: string) => {
      const input = { path: "SCRIPT", content };
      await trigger(rt.hooks, "tool_call", { toolName: "write", input }, rt.ctx);
      await writeFile(join(cwd, "SCRIPT"), content);
      await trigger(rt.hooks, "tool_result", { toolName: "write", input, result: { content: [{ type: "text", text: "written" }] } }, rt.ctx);
    };
    const end = () => triggerAgentEnd(rt.hooks, { cwd, messages: [{ role: "assistant", content: "done" }] }, rt.ctx);
    const settings = async (steps: Array<string | undefined>) => {
      let i = 0;
      await commands.get("review-settings")!("", { ...rt.ctx, scopedModels: [], ui: {
        select: async (_title: string, options: string[]) => {
          assert.ok(i < steps.length, `unexpected menu: ${options.join(" | ")}`);
          const prefix = steps[i++];
          if (prefix === undefined) return undefined;
          const match = options.find((option) => option.trimStart().startsWith(prefix));
          assert.ok(match, `missing ${prefix}: ${options.join(" | ")}`);
          return match;
        },
        notify: (message: string) => rt.notices.push(message),
      } });
      assert.equal(i, steps.length);
    };
    return { root, cwd, configPath, calls, prompt, rt, commands, warnings, restored, start, writeScript, end, settings, dispose };
  } catch (setupError) {
    try { await dispose(); }
    catch (cleanupError) {
      // Keep the original failure (including identity); disclose why artifacts remain.
      try { console.error("Primary evidence fixture setup cleanup failed:", cleanupError); }
      finally { throw setupError; }
    }
    throw setupError;
  }
}

for (const stage of ["beforeActivation", "afterStartup"] as const) {
  for (const priorMode of ["set", "unset"] as const) {
    test(`fixture ${stage} setup failure restores ${priorMode} environment and settles before owned root removal`, async () => {
      const incoming = fixtureEnvKeys.map((key) => [key, process.env[key]] as const);
      const sentinel = await mkdtemp(join(await realpath(tmpdir()), "primary-setup-sentinel-"));
      const entered = gate(), release = gate();
      const setupError = new Error(`injected ${stage} setup failure`);
      let root: string | undefined;
      let attempt: Promise<unknown> | undefined;
      let shutdownSettled = false;
      try {
        // A synthetic caller's state, not the live user's home or config.
        const home = join(sentinel, "home"), config = join(sentinel, "config.json");
        await mkdir(home);
        await writeFile(join(home, ".gitconfig"), "CALLER_GIT_CONFIG\n");
        await writeFile(config, "CALLER_CONFIG_MUST_NOT_CHANGE\n");
        const values = [home, sentinel, config, "1"];
        fixtureEnvKeys.forEach((key, i) => {
          if (priorMode === "unset") delete process.env[key];
          else process.env[key] = values[i];
        });
        const expected = fixtureEnvKeys.map((key) => [key, process.env[key]]);
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        attempt = fixture({}, true, 3, async (point, owned) => {
          if (point !== stage) return;
          root = owned.root;
          assert.equal(process.env.HOME, join(root, "home"));
          assert.equal(process.env.GIT_CEILING_DIRECTORIES, root);
          assert.equal(process.env.PI_REVIEW_GATE_CONFIG, join(root, "config.json"));
          assert.equal(process.env.PI_REVIEW_GATE_DISABLED, undefined);
          if (stage === "beforeActivation") assert.equal(owned.rt.hooks.size, 0);
          else {
            assert.ok(owned.rt.hooks.get("session_shutdown")!.length > 0);
            owned.rt.hooks.get("session_shutdown")!.push(async () => {
              entered.resolve();
              await release.promise;
              assert.ok((await stat(owned.root)).isDirectory(), "owned files must survive until lifecycle settlement");
              assert.equal(process.env.HOME, join(owned.root, "home"));
              shutdownSettled = true;
            });
          }
          throw setupError;
        });
        // Observe rejection immediately even if an earlier barrier assertion fails.
        void attempt.catch(() => {});
        if (stage === "afterStartup") {
          await atBarrier(entered.promise, "partial-setup shutdown");
          assert.ok(root);
          assert.ok((await stat(root)).isDirectory());
          assert.equal(shutdownSettled, false);
          release.resolve();
        }
        await assert.rejects(attempt, (error) => error === setupError);
        assert.ok(root);
        assert.equal(shutdownSettled, stage === "afterStartup");
        assert.deepEqual(fixtureEnvKeys.map((key) => [key, process.env[key]]), expected);
        assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir, "outer harness ownership is unchanged");
        await assert.rejects(stat(root), { code: "ENOENT" });
        assert.deepEqual((await readdir(sentinel)).sort(), ["config.json", "home"]);
        assert.deepEqual(await readdir(home), [".gitconfig"]);
        assert.equal(await readFile(join(home, ".gitconfig"), "utf8"), "CALLER_GIT_CONFIG\n");
        assert.equal(await readFile(config, "utf8"), "CALLER_CONFIG_MUST_NOT_CHANGE\n");
      } finally {
        release.resolve();
        await attempt?.catch(() => {});
        for (const [key, value] of incoming) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(sentinel, { recursive: true, force: true });
      }
    });
  }
}

test("fixture preserves the original setup error and owned artifacts when registered shutdown is uncertain", async (t) => {
  const incoming = fixtureEnvKeys.map((key) => [key, process.env[key]]);
  const setupError = new Error("injected post-startup setup failure");
  const cleanupError = new Error("injected owned shutdown failure");
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
  let root: string | undefined;
  let shutdownFailed = false, laterOwnerSettled = false, runtimeSettled = false;
  let retryOwner: (() => Promise<void>) | undefined;
  try {
    await assert.rejects(fixture({}, true, 3, async (stage, owned) => {
      if (stage !== "afterStartup") return;
      root = owned.root;
      // The real runtime shutdown handlers run first. This resource-free test
      // owner then fails once; later owners must still be given their shutdown.
      retryOwner = async () => {
        if (!shutdownFailed) { shutdownFailed = true; throw cleanupError; }
      };
      owned.rt.hooks.get("session_shutdown")!.push(retryOwner, async () => { laterOwnerSettled = true; });
      throw setupError;
    }), (error) => error === setupError);
    assert.ok(root);
    assert.equal(shutdownFailed, true);
    assert.equal(laterOwnerSettled, true);
    assert.deepEqual(fixtureEnvKeys.map((key) => [key, process.env[key]]), incoming);
    assert.ok((await stat(root)).isDirectory(), "uncertain cleanup must preserve the owned allocation");
    assert.equal(await readFile(join(root, "workspace", "SCRIPT"), "utf8"), "BEFORE_SCRIPT\n");
    assert.equal(diagnostics.length, 1);
    const diagnostic = diagnostics[0]![1];
    assert.ok(diagnostic instanceof AggregateError);
    assert.match(diagnostic.message, /cleanup uncertain; preserved owned root:/);
    assert.ok(diagnostic.message.includes(root));
    assert.deepEqual(diagnostic.errors, [cleanupError]);
    runtimeSettled = true;
  } finally {
    // Only the injected, resource-free owner remains unconfirmed. Confirm it
    // separately before removing this test's positively identified allocation.
    await retryOwner?.();
    if (root && runtimeSettled) await rm(root, { recursive: true, force: true });
  }
});

test("production tool-only retains concrete SCRIPT before/after; post-pass external REPORT cannot churn review", async () => {
  const f = await fixture({ primaryToolOnly: true });
  try {
    await f.start();
    await f.writeScript("AFTER_SCRIPT\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
    const bundle = extractBundleDir(f.rt.sent[0]!.message, 1);
    const side = await readFile(join(bundle, "reviews/0001/side-effect.patch.diff"), "utf8");
    assert.match(side, /BEFORE_SCRIPT/);
    assert.match(side, /AFTER_SCRIPT/);
    const metadata = JSON.parse(await readFile(join(bundle, "reviews/0001/metadata.json"), "utf8"));
    assert.equal(metadata.evidenceMethod, "tool-only");
    assert.equal(metadata.exactSnapshotReviewed, false);
    assert.match(f.rt.sent[0]!.message, /NOT certification of an exact workspace snapshot/);
    assert.equal((await f.restored())?.state.reviewWindow?.baseline?.kind, "tool");
    // Both an unrelated external addition and a later external edit to an
    // already-observed candidate are invisible to this retained evidence method.
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('REPORT','UNOBSERVED_REPORT\\n')"], { cwd: f.cwd, timeout: 5000 });
    await writeFile(join(f.cwd, "SCRIPT"), "UNOBSERVED_SCRIPT\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
    assert.equal((await f.restored())?.state.reviewWindow, undefined);
  } finally { await f.dispose(); }
});

test("real settings apply warns Tools + workspace changes → Tools only reset; inverse retains evidence and establishes baseline", async () => {
  const f = await fixture({}, false);
  try {
    await f.start();
    await f.writeScript("PENDING_SCRIPT\n");
    await f.end();
    const original = (await f.restored())!.state.reviewWindow!;
    const count = original.evidence.events.length;
    assert.ok(count > 0);
    // Cancelled Primary edit, menu navigation and independent scopes are no-op
    // controls for the current Primary evidence window.
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Cancel"]);
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, count);
    await f.settings(["Reviewers", "Evidence methods", "Isolated worktree", "InPlace", "Snapshot-failure", "Back", "Back", undefined]);
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, count);
    assert.equal(f.warnings.length, 0);
    const diskBefore = await readFile(f.configPath, "utf8");
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", undefined]);
    assert.equal(await readFile(f.configPath, "utf8"), diskBefore, "root Escape is session-only");
    const reset = (await f.restored())!.state.reviewWindow!;
    assert.equal(reset.baseline?.kind, "tool");
    assert.equal(reset.evidence.events.length, 0);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0]!, /Primary evidence method changed: Tools \+ workspace changes → Tools only\./);
    assert.match(f.warnings[0]!, /outstanding reviewer findings, correction requirements and pending deliveries remain in force/);
    assert.doesNotMatch(f.warnings[0]!, /Off|On|enabled|disabled/);
    assert.match(f.warnings[0]!, /CURRENT.*RESET/);
    assert.match(f.rt.notices.join("\n"), /CURRENT.*RESET/);
    await f.settings(["Save changes"]);
    assert.equal(f.warnings.length, 1, "unchanged Save must not reset again");
    assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).review.evidence.primaryToolOnly, true);
    await f.start("new tool work");
    await f.writeScript("RETAIN_THIS_TOOL_WORK\n");
    await f.end();
    const retainedCount = (await f.restored())!.state.reviewWindow!.evidence.events.length;
    assert.ok(retainedCount > 0);
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Save changes"]);
    const disabled = (await f.restored())!.state.reviewWindow!;
    assert.equal(disabled.baseline?.kind, "checkpoint");
    assert.equal(disabled.evidence.events.length, retainedCount);
    assert.match(f.warnings.at(-1)!, /Primary evidence method changed: Tools only → Tools \+ workspace changes\./);
    assert.match(f.warnings.at(-1)!, /Existing tool evidence was retained and a NEW snapshot baseline established/);
    assert.match(f.warnings.at(-1)!, /Earlier Tools only reviews do not certify that baseline/);
    assert.doesNotMatch(f.warnings.at(-1)!, /Off|On|enabled|disabled/);
    await f.start("snapshot edit after disable");
    await writeFile(join(f.cwd, "REPORT"), "SNAPSHOT_AFTER_DISABLE\n");
    await f.end();
    await f.commands.get("review-now")!("", f.rt.ctx);
    const bundle = extractBundleDir(f.rt.sent[0]!.message, 1);
    const patch = await readFile(join(bundle, "reviews/0001/patch.diff"), "utf8");
    assert.match(patch, /SNAPSHOT_AFTER_DISABLE/);
    const side = await readFile(join(bundle, "reviews/0001/side-effect.patch.diff"), "utf8");
    assert.match(side, /RETAIN_THIS_TOOL_WORK/);
  } finally { await f.dispose(); }
});

// #303: independently reviewed landings may advance the snapshot interval,
// but cannot retroactively certify work preceding a recovery/policy baseline.
for (const strategy of ["raw", "git"] as const) {
  for (const mode of ["disable-distinct", "disable-shared", "fallback", "snapshot"] as const) {
    test(`${strategy} parent advancement preserves historical coverage: ${mode}`, async () => {
      const historical = mode !== "snapshot";
      const f = await fixture(mode.startsWith("disable") ? { primaryToolOnly: true }
        : mode === "fallback" ? { snapshotFailureFallback: true } : {}, true, 3, async (stage, owned) => {
        if (stage === "beforeActivation" && strategy === "git") {
          await initGitRepo(join(owned.root, "workspace"), { SCRIPT: "BEFORE_SCRIPT\n" });
        }
      });
      let controller: BackgroundExecutionController | undefined;
      const ownedExecutionRoots = new Set<string>();
      try {
        if (mode === "fallback") {
          // Exercise the real initial-fallback -> recovered snapshot path,
          // not a history flag injected into a checkpoint fixture.
          const failed = mock.method(checkpoints, "captureReviewCheckpoint", async () => ({
            status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const,
          }));
          await f.start();
          assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "tool");
          failed.mock.restore();
        } else await f.start();
        await f.writeScript("EARLIER_TOOL_SCRIPT\n");
        if (mode.startsWith("disable")) {
          await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Save changes"]);
        }
        if (mode !== "disable-shared") {
          // Real review settlement arms a distinct after-checkpoint on the
          // exchange, while the window retains its accumulated baseline.
          await f.end();
          await f.start("continue parent work while a reviewed worker lands");
          if (mode === "fallback") {
            // Recovery itself establishes a shared NEW baseline. A subsequent
            // real snapshot review supplies the distinct exchange owner.
            await writeFile(join(f.cwd, "REPORT"), "SUBSEQUENT_SNAPSHOT_INTERVAL\n");
            await f.end();
            await f.start("continue after snapshot recovery review");
          }
        }
        const state = (await f.restored())!.state;
        const scope = { agentDir: testAgentDir, sessionId: "primary-evidence" };
        state.checkpointScope = scope;
        const window = state.reviewWindow!;
        const oldWindow = window.baseline;
        const oldExchange = window.activeExchange?.baseline;
        assert.ok(oldWindow?.kind === "checkpoint" && oldExchange?.kind === "checkpoint");
        assert.equal(oldWindow.descriptor.kind, strategy);
        assert.equal(Boolean(oldWindow.toolOnlyHistory), historical);
        assert.equal(Boolean(oldExchange.toolOnlyHistory), historical);
        assert.equal(JSON.stringify(oldWindow.descriptor) === JSON.stringify(oldExchange.descriptor), mode === "disable-shared");
        const events = structuredClone(window.evidence.events);
        await writeFile(join(f.cwd, "REPORT"), "PARENT_CONTEXT_REMAINS_REVIEWABLE\n");
        const script = join(f.root, "landing.cjs");
        await writeFile(script, `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{
          fs.writeFileSync('LANDED','INDEPENDENTLY_REVIEWED_WORKER\\n');
          console.log(JSON.stringify({type:'assistant',text:'landed requested file'}));
        });`);
        const configured = JSON.parse(await readFile(f.configPath, "utf8"));
        const config = normalizeConfig({ ...configured,
          review: { ...configured.review, subtaskEnabled: true, reviewLandedChanges: true,
            subtaskReviewers: [{ source: "external", id: "fake" }] },
          externalAgents: { ...configured.externalAgents, worker: { adapter: "run-as-binary", command: process.execPath,
            execution: { protocol: "pi-review-executor-jsonl-v1", args: [script] } } },
          execution: { maxWorkers: 1, subtaskNotifications: "quiet",
            workerResources: { worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
            routes: { execute: [{ resourceId: "worker" }], research: [] } },
        });
        const store = new SessionStateStore({ sessionId: "primary-evidence", sessionFile: join(f.root, "advanced.jsonl"), cwd: f.cwd });
        controller = new BackgroundExecutionController({ config, state, cwd: () => f.cwd, pi: {},
          onAssociationsChanged: (associations) => store.save(state, associations, config),
        });
        const started = await controller.start([{ title: "reviewed landing", instructions: "Write LANDED only.", acceptanceCriteria: ["LANDED exists"] }]);
        ownedExecutionRoots.add(started.root);
        await waitFor(() => !isActiveTaskState(controller!.inspect(started.executionId).tasks[0]!.state), 60_000);
        const landed = controller.inspect(started.executionId).tasks[0]!;
        if (landed.waveRoot) ownedExecutionRoots.add(landed.waveRoot);
        assert.equal(landed.state, "landed", landed.error ?? landed.summary);
        assert.equal(await readFile(join(f.cwd, "LANDED"), "utf8"), "INDEPENDENTLY_REVIEWED_WORKER\n");
        const owners = [window.baseline, window.activeExchange?.baseline];
        const now = await checkpoints.captureReviewCheckpoint(f.cwd, "after-reviewed-landing", { scope });
        assert.equal(now.status, "ok");
        if (now.status !== "ok") throw new Error("after-checkpoint capture failed");
        for (const [index, owner] of owners.entries()) {
          assert.ok(owner?.kind === "checkpoint");
          assert.notDeepEqual(owner.descriptor, [oldWindow, oldExchange][index]!.descriptor, "both checkpoint owners actually advance");
          const compared = await checkpoints.compareReviewCheckpoints(f.cwd, owner.descriptor, now.value, { scope });
          assert.equal(compared.status, "ok");
          if (compared.status !== "ok") throw new Error("comparison failed");
          const paths = compared.value.changes.map(change => change.path);
          assert.ok(paths.includes("REPORT"), "pre-existing parent work remains reviewable");
          assert.equal(paths.includes("LANDED"), false, "successfully reviewed worker bytes are selectively advanced");
        }
        assert.deepEqual(window.evidence.events, events, "advancement does not reset earlier tool evidence");
        const durable = await store.restore(f.cwd, scope);
        assert.deepEqual(durable!.state.reviewWindow!.baseline, owners[0]);
        assert.deepEqual(durable!.state.reviewWindow!.activeExchange!.baseline, owners[1]);
        // Inspect only the next actual reviewer invocation, not disclosure
        // left in the prompt dump by the earlier review or worker reviewer.
        await writeFile(f.prompt, "");
        const result = await runReview({ cwd: f.cwd, request: "Assess the retained parent history and REPORT.",
          before: window.baseline!, config, evidence: window.evidence, window, checkpointScope: scope });
        assert.equal(result.result?.verdict, "pass");
        assert.ok(result.bundleDir && result.reviewSequence);
        const reviewDir = join(result.bundleDir, "reviews", String(result.reviewSequence).padStart(4, "0"));
        const metadata = JSON.parse(await readFile(join(reviewDir, "metadata.json"), "utf8"));
        const request = await readFile(join(reviewDir, "request.md"), "utf8");
        const prompt = await readFile(f.prompt, "utf8");
        assert.deepEqual({
          ownerHistory: owners.map(owner => owner?.kind === "checkpoint" && Boolean(owner.toolOnlyHistory)),
          bundleDisclosure: request.includes(TOOL_ONLY_HISTORY_NOTICE),
          reviewerDisclosure: prompt.includes(TOOL_ONLY_HISTORY_NOTICE),
          exactSnapshotReviewed: metadata.exactSnapshotReviewed,
        }, { ownerHistory: [historical, historical], bundleDisclosure: historical, reviewerDisclosure: historical,
          exactSnapshotReviewed: !historical });
        const side = await readFile(join(reviewDir, "side-effect.patch.diff"), "utf8");
        const patch = await readFile(join(reviewDir, "patch.diff"), "utf8");
        assert.match(`${patch}\n${side}`, /BEFORE_SCRIPT/);
        assert.match(`${patch}\n${side}`, /EARLIER_TOOL_SCRIPT/);
        assert.match(prompt, /EARLIER_TOOL_SCRIPT/);
        assert.match(patch, /PARENT_CONTEXT_REMAINS_REVIEWABLE/);
      } finally {
        // Confirm all owned children/lifecycle owners settle before removal;
        // a cleanup failure preserves the fixture rather than guessing safety.
        await controller?.shutdown();
        await controller?.detach();
        await f.dispose();
        for (const root of ownedExecutionRoots) await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const initial of [true, false]) {
  for (const enabled of [false, true]) {
    test(`${initial ? "initial" : "settlement"} acquisition failure: fallback ${enabled ? "On preserves evidence with durable truthful basis" : "Off blocks"}`, async () => {
      const f = await fixture({ snapshotFailureFallback: enabled });
      try {
        if (!initial) { await f.start(); await f.writeScript("CURRENT_WORK_SURVIVES\n"); }
        const failure = mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const }));
        if (initial && !enabled) {
          await assert.rejects(f.start(), /baseline capture failed/);
          assert.equal(f.warnings.length, 0);
          return;
        }
        if (initial) {
          await f.start();
          const baseline = (await f.restored())!.state.reviewWindow!.baseline;
          assert.equal(baseline?.kind, "tool");
          assert.ok(baseline?.kind === "tool" && baseline.fallback);
          assert.match(f.warnings.join("\n"), /Tools only \(snapshot-failure fallback\)/);
          await f.writeScript("CURRENT_WORK_SURVIVES\n");
        }
        if (enabled) await f.end();
        else await assert.rejects(f.end(), /acquisition failed/);
        failure.mock.restore();
        if (!enabled) {
          await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/);
          assert.doesNotMatch(f.rt.notices.join("\n"), /Tools only \(snapshot-failure fallback\)/);
          assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
          return;
        }
        assert.equal(await readFile(f.calls, "utf8"), "1");
        assert.match(f.rt.sent[0]!.message, /Tools only \(snapshot-failure fallback\)/);
        assert.match(f.rt.sent[0]!.message, /CURRENT tool evidence was preserved, not reset/);
        const bundle = extractBundleDir(f.rt.sent[0]!.message, 1);
        assert.match(await readFile(join(bundle, "reviews/0001/side-effect.patch.diff"), "utf8"), /CURRENT_WORK_SURVIVES/);
        const metadata = JSON.parse(await readFile(join(bundle, "reviews/0001/metadata.json"), "utf8"));
        assert.equal(metadata.evidenceMethod, "tool-only-fallback");
        assert.equal(metadata.exactSnapshotReviewed, false);
        const baseline = (await f.restored())!.state.reviewWindow!.baseline;
        if (initial) assert.ok(baseline?.kind === "tool" && baseline.fallback);
        else assert.equal(baseline?.kind, "checkpoint", "later fallback preserves the valid historical basis for retry");
        assert.doesNotMatch(f.rt.notices.join("\n"), /CURRENT Primary collected evidence.*RESET/);
      } finally { await f.dispose(); }
    });
  }
}

for (const reason of ["aborted", "checkpoint_digest_mismatch", "capture_inconsistent", "git_failed"] as const) {
  test(`enabled fallback does not admit ${reason}`, async () => {
    const f = await fixture({ snapshotFailureFallback: true });
    try {
      await f.start();
      await f.writeScript("MUST_STAY_PENDING\n");
      mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason }));
      await assert.rejects(f.end(), /capturing after-checkpoint failed/);
      await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/);
      assert.doesNotMatch(f.rt.notices.join("\n"), /Tools only \(snapshot-failure fallback\)/);
      assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
    } finally { await f.dispose(); }
  });
}

test("actual raw content-open failure qualifies; raw storage and record-publication failures do not", async () => {
  for (const stage of ["content", "storage", "publication"] as const) {
    const f = await fixture({ snapshotFailureFallback: true });
    try {
      const open = fsPromises.open;
      const mkdirOriginal = fsPromises.mkdir;
      const rename = fsPromises.rename;
      if (stage === "content") mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
        if (String(args[0]) === join(f.cwd, "SCRIPT")) throw Object.assign(new Error("injected acquisition EACCES"), { code: "EACCES" });
        return open(...args);
      });
      if (stage === "storage") mock.method(fsPromises, "mkdir", async (...args: Parameters<typeof mkdirOriginal>) => {
        if (String(args[0]).includes("/checkpoints")) throw Object.assign(new Error("injected storage EACCES"), { code: "EACCES" });
        return mkdirOriginal(...args);
      });
      if (stage === "publication") mock.method(fsPromises, "rename", async (...args: Parameters<typeof rename>) => {
        if (String(args[1]).endsWith("/record.json")) throw Object.assign(new Error("injected publication EIO"), { code: "EIO" });
        return rename(...args);
      });
      if (stage !== "content") {
        await assert.rejects(f.start(), /baseline capture failed/);
        assert.equal(f.warnings.length, 0);
        continue;
      }
      await f.start();
      assert.ok(f.warnings.some((warning) => warning.includes("Tools only (snapshot-failure fallback)")));
      mock.restoreAll();
      await f.writeScript("REAL_CAPTURE_FALLBACK_WORK\n");
      await f.end();
      assert.equal(await readFile(f.calls, "utf8"), "1");
      assert.match(f.rt.sent[0]!.message, /Review evidence method: Tools only\./);
      assert.match(f.rt.sent[0]!.message, /new Tools \+ workspace changes snapshot baseline covers subsequent work only/);
      const recovered = (await f.restored())!.state.reviewWindow!.baseline;
      assert.ok(recovered?.kind === "checkpoint" && recovered.toolOnlyHistory);
      assert.match(f.warnings.join("\n"), /Snapshot capture recovered/);
    } finally { await f.dispose(); }
  }
});

test("fallback cannot rescue a damaged existing baseline or a reviewer error", async () => {
  const f = await fixture({ snapshotFailureFallback: true });
  try {
    await f.start();
    await f.writeScript("PENDING\n");
    const loaded = mock.method(checkpoints, "loadReviewCheckpoint", async () => ({ status: "failed" as const, reason: "checkpoint_digest_mismatch" as const }));
    await assert.rejects(f.end(), /verifying baseline/);
    assert.doesNotMatch(f.rt.notices.join("\n"), /Tools only \(snapshot-failure fallback\)/);
    loaded.mock.restore();
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => ({ reviewerId: request.id, verdict: "error", summary: "injected reviewer failure", findings: [], error: "invalid_output" }));
    await f.commands.get("review-now")!("", f.rt.ctx);
    assert.match(f.rt.sent[0]!.message, /injected reviewer failure/);
    assert.doesNotMatch(f.rt.sent[0]!.message, /Tools only \(snapshot-failure fallback\)/);
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
  } finally { await f.dispose(); }
});

test("Primary policy apply during an active reviewer defers reset until settlement and next run", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  try {
    await f.start();
    await f.writeScript("RUNNING_REVIEW_EVIDENCE\n");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => {
      entered(); await gate;
      return { reviewerId: request.id, verdict: "pass", summary: "original snapshot review", findings: [] };
    });
    const ending = f.end();
    await started;
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Save changes"]);
    assert.match(f.warnings.join("\n"), /pending until the running review settles/);
    assert.doesNotMatch(f.warnings.join("\n"), /CURRENT Primary collected evidence.*RESET/);
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
    finish!();
    await ending;
    assert.match(f.rt.sent[0]!.message, /Review evidence method: Tools \+ workspace changes/);
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    assert.match(f.warnings.join("\n"), /CURRENT Primary collected evidence.*RESET/);
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 0);
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "tool");
  } finally { finish?.(); await f.dispose(); }
});

test("tool-only correction inverse is reviewed and manual reviewer questions need no workspace capture", async () => {
  const f = await fixture({ primaryToolOnly: true });
  try {
    let reviews = 0;
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => {
      reviews++;
      return { reviewerId: request.id, verdict: reviews === 1 ? "needs_changes" : "pass", summary: reviews === 1 ? "restore the original SCRIPT" : "validated inverse", findings: [] };
    });
    await f.start();
    await f.writeScript("BAD_SCRIPT\n");
    await f.end();
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await f.writeScript("BEFORE_SCRIPT\n");
    await f.end();
    assert.equal(reviews, 2);
    const bundle = extractBundleDir(f.rt.sent[1]!.message, 2);
    const inverse = await readFile(join(bundle, "exchanges/0002/side-effects.patch"), "utf8");
    assert.match(inverse, /-BAD_SCRIPT/);
    assert.match(inverse, /\+BEFORE_SCRIPT/);
    mock.method(checkpoints, "captureReviewCheckpoint", async () => { throw new Error("tool-only question must not capture workspace"); });
    await f.commands.get("ask-reviewer")!("Does the inverse meet the request?", f.rt.ctx);
    assert.equal(reviews, 3);
    assert.match(f.rt.sent.at(-1)!.message, /Review evidence method: Tools only/);
  } finally { await f.dispose(); }
});

test("tool-only missing observations permits disclosed claims/context review without summary-only pass churn", async () => {
  const f = await fixture({ primaryToolOnly: true });
  try {
    await f.start("assess the supplied context");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
    assert.match(f.rt.sent[0]!.message, /No structured tool observations were collected/);
    assert.match(await readFile(f.prompt, "utf8"), /summaries and context are claims, not verified actions/);
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await writeFile(join(f.cwd, "REPORT"), "outside-only report\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
  } finally { await f.dispose(); }
});

test("snapshot preference retries each review: repeated failures warn each time; recovered snapshot captures outside edits", async () => {
  const f = await fixture({ snapshotFailureFallback: true });
  try {
    await f.start();
    await f.writeScript("FALLBACK_ONE\n");
    const capture = mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const }));
    await f.end();
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await f.writeScript("FALLBACK_TWO\n");
    await f.end();
    assert.equal(capture.mock.callCount(), 2);
    assert.equal(f.warnings.filter((warning) => warning.includes("Review evidence method: Tools only (snapshot-failure fallback)")).length, 2);
    assert.equal(await readFile(f.calls, "utf8"), "2");
    capture.mock.restore();
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await writeFile(join(f.cwd, "REPORT"), "SNAPSHOT_RECOVERED_REPORT\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "3");
    assert.match(f.rt.sent[2]!.message, /Review evidence method: Tools \+ workspace changes/);
    assert.doesNotMatch(f.rt.sent[2]!.message, /Tools only \(snapshot-failure fallback\)/);
    const bundle = extractBundleDir(f.rt.sent[2]!.message, 3);
    assert.match(await readFile(join(bundle, "reviews/0003/patch.diff"), "utf8"), /SNAPSHOT_RECOVERED_REPORT/);
    assert.equal(f.warnings.filter((warning) => warning.includes("Review evidence method: Tools only (snapshot-failure fallback)")).length, 2);
  } finally { await f.dispose(); }
});

test("explicit evidence reset preserves outstanding correction requirements, budget and delivery history", async () => {
  const f = await fixture();
  try {
    let reviews = 0;
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => {
      reviews++;
      return { reviewerId: request.id, verdict: reviews === 1 ? "needs_changes" : "pass", summary: reviews === 1 ? "ORIGINAL_CORRECTION_REQUIRED" : "validated correction", findings: [] };
    });
    await f.start();
    await f.writeScript("REQUIRES_CORRECTION\n");
    await f.end();
    const before = (await f.restored())!.state;
    assert.equal(before.reviewWindow!.reviewHistory.at(-1)!.verdict, "needs_changes");
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", undefined]);
    const after = (await f.restored())!.state;
    assert.deepEqual(after.reviewWindow!.reviewHistory, before.reviewWindow!.reviewHistory);
    assert.equal(after.reviewWindow!.correctionCycles, before.reviewWindow!.correctionCycles);
    assert.equal(after.reviewWindow!.activeExchange!.reviewResponseMode, "correction");
    assert.deepEqual(after.pendingModelDeliveries, before.pendingModelDeliveries);
    assert.equal(after.reviewWindow!.evidence.events.length, 0);
    assert.match(f.warnings.join("\n"), /correction requirements and pending deliveries remain in force/);
    // Even an event-free response must validate the outstanding correction;
    // the reset cannot turn it into an unchanged passing response.
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await f.end();
    assert.equal(reviews, 2);
    const bundle = extractBundleDir(f.rt.sent[1]!.message, 2);
    assert.match(await readFile(join(bundle, "reviews/0002/request.md"), "utf8"), /ORIGINAL_CORRECTION_REQUIRED/);
  } finally { await f.dispose(); }
});

test("production Ctrl+S in the evidence submenu persists and resets Primary exactly once", async () => {
  const f = await fixture({}, false);
  try {
    await f.start();
    await f.writeScript("PRE_CTRL_S_EVIDENCE\n");
    await f.end();
    const menu = createTuiSettingsContext([
      [...Array.from({ length: 6 }, () => KEY_DOWN), KEY_ENTER],
      [...Array.from({ length: 5 }, () => KEY_DOWN), KEY_ENTER],
      [KEY_ENTER],
      ["\x13"],
    ]);
    setMenuTuiHost({ ...menu.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
    const base = menu.context as { ui: Record<string, unknown> };
    try {
      await f.commands.get("review-settings")!("", { ...f.rt.ctx, ...base,
        ui: { ...base.ui, notify: (message: string) => f.rt.notices.push(message) },
      });
    } finally { setMenuTuiHost(undefined); }
    assert.equal(menu.exhausted(), false);
    assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).review.evidence.primaryToolOnly, true);
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 0);
    assert.equal(f.warnings.filter((warning) => warning.includes("collected evidence was RESET")).length, 1);
  } finally { await f.dispose(); }
});

test("explicit worker policies are independent of Primary, and tool-only identity never claims exact candidate review", async () => {
  const f = await fixture({ primaryToolOnly: true });
  let directBundle: string | undefined;
  try {
    const config = normalizeConfig(JSON.parse(await readFile(f.configPath, "utf8")));
    const before = await createWorkspaceSnapshot(f.cwd, config);
    await writeFile(join(f.cwd, "REPORT"), "WORKER_SNAPSHOT_POLICY\n");
    const snapshot = await runReview({ cwd: f.cwd, request: "explicit worker snapshot", before, config,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: false, scope: "worktree" },
    });
    directBundle = snapshot.bundleDir;
    assert.equal(snapshot.evidenceMethod, "snapshot");
    assert.match(await readFile(join(directBundle!, "reviews/0001/patch.diff"), "utf8"), /WORKER_SNAPSHOT_POLICY/);
    await removeReviewBundle(directBundle!); directBundle = undefined;
    await f.start();
    await f.writeScript("WORKER_TOOL_CONTENT\n");
    await f.end();
    const evidence = (await f.restored())!.state.reviewWindow!.evidence;
    const identity = { baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40) };
    const tool = await runReview({ cwd: f.cwd, request: "explicit worker tool evidence", before, config, evidence,
      evidencePolicy: { toolOnly: true, snapshotFailureFallback: false, scope: "worktree" },
      changeIdentity: identity,
      exactChange: { changedPaths: ["REPORT"], patch: "EXACT_PATCH_MUST_NOT_BECOME_TOOL_EVIDENCE", truncated: false, omitted: [] },
    });
    directBundle = tool.bundleDir;
    assert.equal(tool.evidenceMethod, "tool-only");
    const prompt = await readFile(join(directBundle!, "reviews/0001/reviewer-context.md"), "utf8");
    assert.match(prompt, /checkpoint\/landing association only/);
    assert.match(prompt, /does NOT certify this exact candidate snapshot/);
    assert.doesNotMatch(prompt, /EXACT_PATCH_MUST_NOT_BECOME_TOOL_EVIDENCE/);
    assert.match(prompt, /WORKER_TOOL_CONTENT/);
    assert.deepEqual(JSON.parse(await readFile(join(directBundle!, "current/change-identity.json"), "utf8")), identity);
    await removeReviewBundle(directBundle!); directBundle = undefined;
    const fallback = await runReview({ cwd: f.cwd, request: "worker's preceding acquisition failed", before, config, evidence,
      evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" },
      evidenceCaptureFailure: new ReviewEvidenceCaptureFailure("owned review-evidence acquisition unavailable"),
      changeIdentity: identity,
    });
    directBundle = fallback.bundleDir;
    assert.equal(fallback.evidenceMethod, "tool-only-fallback");
    const metadata = JSON.parse(await readFile(join(directBundle!, "reviews/0001/metadata.json"), "utf8"));
    assert.equal(metadata.evidenceMethod, "tool-only-fallback");
    assert.equal(metadata.evidenceScope, "worktree");
    assert.equal(metadata.exactSnapshotReviewed, false);
  } finally {
    if (directBundle) await removeReviewBundle(directBundle);
    await f.dispose();
  }
});

test("worker acquisition handoff cannot bypass fallback Off, cancellation, or a typed baseline's integrity", async () => {
  const f = await fixture({ snapshotFailureFallback: true });
  try {
    await f.start();
    const config = normalizeConfig(JSON.parse(await readFile(f.configPath, "utf8")));
    const before = (await f.restored())!.state.reviewWindow!.baseline!;
    const input = { cwd: f.cwd, request: "external acquisition handoff", before, config,
      evidenceCaptureFailure: new ReviewEvidenceCaptureFailure("actual preceding evidence acquisition failure"),
      checkpointScope: { agentDir: testAgentDir, sessionId: "primary-evidence" },
    };
    await assert.rejects(runReview({ ...input, evidencePolicy: { toolOnly: false, snapshotFailureFallback: false, scope: "worktree" } }), /preceding evidence acquisition failure/);
    const controller = new AbortController(); controller.abort(new Error("cancelled before handoff"));
    await assert.rejects(runReview({ ...input, signal: controller.signal, evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" } }), /cancelled before handoff/);
    const window = (await f.restored())!.state.reviewWindow!;
    const wrongKind = await createWorkspaceSnapshot(f.cwd, config);
    await assert.rejects(runReview({ ...input, before: wrongKind, window, evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" } }), /mixed evidence baseline kinds/);
    mock.method(checkpoints, "loadReviewCheckpoint", async () => ({ status: "failed" as const, reason: "checkpoint_digest_mismatch" as const }));
    await assert.rejects(runReview({ ...input, evidencePolicy: { toolOnly: false, snapshotFailureFallback: true, scope: "worktree" } }), /verifying baseline/);
    await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/);
  } finally { await f.dispose(); }
});

test("Primary Tools only → Tools + workspace changes capture failure names methods and retains evidence fail-closed", async () => {
  const f = await fixture({ primaryToolOnly: true }, false);
  try {
    await f.start();
    await f.writeScript("RETAIN_WHEN_SNAPSHOT_FAILS\n");
    await f.end();
    const before = (await f.restored())!.state.reviewWindow!;
    const warningsBefore = [...f.warnings];
    mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const }));
    await assert.rejects(f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", undefined]), (error: Error) => {
      assert.match(error.message, /Primary Tools only → Tools \+ workspace changes could not establish a new snapshot baseline/);
      assert.match(error.message, /prior evidence retained; repair and retry before further work/);
      assert.doesNotMatch(error.message, /disabling|disabled|Off|On/);
      return true;
    });
    const after = (await f.restored())!.state.reviewWindow!;
    assert.deepEqual(after.baseline, before.baseline);
    assert.deepEqual(after.evidence, before.evidence);
    await assert.rejects(trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx), /Tools only → Tools \+ workspace changes could not establish/);
    assert.deepEqual(f.warnings, warningsBefore, "failed transition must not disclose fallback or a successful method change");
  } finally { await f.dispose(); }
});

test("Tools only → Tools + workspace changes honors opted-in acquisition fallback without resetting retained work or latching preference", async () => {
  const f = await fixture({ primaryToolOnly: true, snapshotFailureFallback: true }, false);
  try {
    await f.start();
    await f.writeScript("RETAIN_WHILE_DISABLING\n");
    await f.end();
    const count = (await f.restored())!.state.reviewWindow!.evidence.events.length;
    const failed = mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const }));
    await f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", undefined]);
    const fallback = (await f.restored())!.state.reviewWindow!;
    assert.equal(fallback.evidence.events.length, count);
    assert.ok(fallback.baseline?.kind === "tool" && fallback.baseline.fallback);
    assert.match(f.warnings.at(-1)!, /preference changed: Tools only → Tools \+ workspace changes.*will be retried/);
    assert.match(f.warnings.at(-1)!, /Tools only \(snapshot-failure fallback\)/);
    assert.doesNotMatch(f.warnings.at(-1)!, /RESET/);
    failed.mock.restore();
    await f.start("continued work with snapshot preference");
    await f.writeScript("CONTINUED_RETAINED_WORK\n");
    await f.end();
    const recovered = (await f.restored())!.state.reviewWindow!;
    assert.ok(recovered.baseline?.kind === "checkpoint" && recovered.baseline.toolOnlyHistory);
    assert.equal(recovered.evidence.events.length, count + 2);
    assert.match(f.warnings.at(-1)!, /Snapshot capture recovered/);
  } finally { await f.dispose(); }
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function atBarrier(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out at ${label}`)), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test("settings applied during owned pre-review persistence cannot change that review's captured evidence policy", async () => {
  const f = await fixture();
  const entered = gate(), release = gate(), deferred = gate();
  let ending: Promise<void> | undefined;
  let changing: Promise<void> | undefined;
  try {
    await f.start();
    await f.writeScript("PRE_REVIEW_PERSISTENCE_BARRIER\n");
    const originalSave = SessionStateStore.prototype.save;
    let blocked = false;
    mock.method(SessionStateStore.prototype, "save", async function(this: SessionStateStore, ...args: Parameters<SessionStateStore["save"]>) {
      if (args[0].reviewInProgress && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return originalSave.apply(this, args);
    });
    const host = f.rt.pi as typeof f.rt.pi & { sendMessage: (message: { content: string }) => unknown };
    const sendMessage = host.sendMessage;
    mock.method(host, "sendMessage", (message: { content: string }) => {
      if (message.content.includes("pending until the running review settles")) deferred.resolve();
      return sendMessage(message);
    });
    ending = f.end();
    await atBarrier(entered.promise, "pre-review save");
    changing = f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Save changes"]);
    await atBarrier(deferred.promise, "deferred policy warning");
    assert.doesNotMatch(f.warnings.join("\n"), /collected evidence was RESET/);
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
    release.resolve();
    await Promise.all([ending, changing]);
    const bundle = extractBundleDir(f.rt.sent[0]!.message, 1);
    const metadata = JSON.parse(await readFile(join(bundle, "reviews/0001/metadata.json"), "utf8"));
    assert.equal(metadata.evidenceMethod, "snapshot");
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 2);
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "tool");
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 0);
    assert.equal(f.warnings.filter((notice) => notice.includes("collected evidence was RESET")).length, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([ending, changing].filter((promise): promise is Promise<void> => promise !== undefined));
    await f.dispose();
  }
});

for (const stage of ["persist", "sendMessage"] as const) {
  test(`an incomplete Primary transition retries ${stage} and blocks work without resetting later evidence again`, async () => {
    const f = await fixture();
    let fail = true;
    try {
      await f.start();
      await f.writeScript("BEFORE_EXPLICIT_RESET\n");
      await f.end();
      assert.equal(await readFile(f.calls, "utf8"), "1");
      await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
      const issuedInput = { path: "SCRIPT", content: "AFTER_ONCE_ONLY_RESET\n" };
      await trigger(f.rt.hooks, "tool_call", { toolName: "write", input: issuedInput }, f.rt.ctx);
      if (stage === "persist") {
        const save = SessionStateStore.prototype.save;
        mock.method(SessionStateStore.prototype, "save", async function(this: SessionStateStore, ...args: Parameters<SessionStateStore["save"]>) {
          if (fail && args[0].reviewWindow?.baseline?.kind === "tool") throw new Error("injected transition persist failure");
          return save.apply(this, args);
        });
      } else {
        const host = f.rt.pi as typeof f.rt.pi & { sendMessage: (message: { content: string }) => unknown };
        const sendMessage = host.sendMessage;
        mock.method(host, "sendMessage", (message: { content: string }) => {
          if (fail && message.content.includes("collected evidence was RESET")) throw new Error("injected transition sendMessage failure");
          return sendMessage(message);
        });
      }
      await assert.rejects(f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", undefined]), /injected transition/);
      // An already-admitted write can complete after the reset, but a new
      // tool call must be blocked until mandatory completion succeeds.
      await writeFile(join(f.cwd, "SCRIPT"), issuedInput.content);
      await trigger(f.rt.hooks, "tool_result", { toolName: "write", input: issuedInput,
        result: { content: [{ type: "text", text: "completed AFTER_ONCE_ONLY_RESET" }] },
      }, f.rt.ctx);
      await assert.rejects(f.writeScript("BLOCKED_NEW_TOOL\n"), /injected transition/);
      assert.equal(await readFile(join(f.cwd, "SCRIPT"), "utf8"), issuedInput.content);
      await assert.rejects(trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx), /injected transition/);
      await assert.rejects(f.end(), /injected transition/);
      assert.equal(await readFile(f.calls, "utf8"), "1", "no review may run before mandatory completion succeeds");
      assert.equal(f.warnings.filter((notice) => notice.includes("collected evidence was RESET")).length, 0);
      fail = false;
      await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
      await f.end();
      const window = (await f.restored())!.state.reviewWindow!;
      assert.equal(window.evidence.events.length, 1);
      assert.equal(window.evidence.events[0]!.phase, "tool_result");
      assert.match(window.evidence.events[0]!.detail!, /AFTER_ONCE_ONLY_RESET/);
      assert.equal(f.warnings.filter((notice) => notice.includes("collected evidence was RESET")).length, 1);
      await f.settings(["Save changes"]);
      assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 1);
      assert.equal(f.warnings.filter((notice) => notice.includes("collected evidence was RESET")).length, 1);
    } finally { fail = false; await f.dispose(); }
  });
}

for (const scenario of [
  "off", "on", "storage", "cleanup", "integrity", "corrupt-retained-basis", "cancelled",
] as const) {
  test(`capped /review-continue ${scenario}: acquisition fallback preserves authority and fails closed outside its scope`, async () => {
    const f = await fixture({ snapshotFailureFallback: scenario !== "off" }, true, 1);
    try {
      let reviews = 0;
      mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => {
        reviews++;
        return { reviewerId: request.id, verdict: "needs_changes", summary: "CAP_REQUIRED_CORRECTION", findings: [] };
      });
      await f.start();
      await f.writeScript("CORRECTION_ONE\n");
      await f.end();
      await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
      await f.writeScript("CORRECTION_TWO\n");
      await f.end();
      assert.equal(reviews, 2);
      const before = (await f.restored())!.state;
      const beforeWindow = before.reviewWindow!;
      assert.ok(beforeWindow.lastCappedFollowUp);
      assert.equal(beforeWindow.correctionCycles, 1);
      assert.equal(beforeWindow.reviewHistory.at(-1)!.disposition, "sent_at_cap");
      const controller = new AbortController();
      mock.method(checkpoints, "captureReviewCheckpoint", async () => {
        if (scenario === "cancelled") controller.abort(new Error("cancelled during continuation acquisition"));
        return scenario === "storage"
          ? { status: "failed" as const, reason: "raw_checkpoint_failed" as const, detail: "injected storage failure" }
          : scenario === "cleanup"
            ? { status: "failed" as const, reason: "untracked_unreadable" as const, detail: "unconfirmed cleanup" }
            : { status: "failed" as const, reason: scenario === "integrity" ? "checkpoint_digest_mismatch" as const : "patch_too_large" as const, evidenceCaptureFailure: true as const };
      });
      let restoreLoad: (() => void) | undefined;
      if (scenario === "corrupt-retained-basis") {
        const fault = mock.method(checkpoints, "loadReviewCheckpoint", async () => ({ status: "failed" as const, reason: "checkpoint_digest_mismatch" as const }));
        restoreLoad = () => fault.mock.restore();
      }
      const continuation = f.commands.get("review-continue")!("", { ...f.rt.ctx, signal: controller.signal });
      if (scenario === "on") await continuation;
      else await assert.rejects(continuation, scenario === "corrupt-retained-basis" ? /verifying continuation basis/ : /response checkpoint failed/);
      restoreLoad?.();
      const after = (await f.restored())!.state;
      const afterWindow = after.reviewWindow!;
      assert.deepEqual(afterWindow.evidence, beforeWindow.evidence);
      assert.deepEqual(afterWindow.baseline, beforeWindow.baseline);
      assert.deepEqual(afterWindow.activeExchange!.baseline, beforeWindow.activeExchange!.baseline);
      assert.deepEqual(after.pendingModelDeliveries.slice(0, before.pendingModelDeliveries.length), before.pendingModelDeliveries);
      if (scenario === "on") {
        assert.equal(afterWindow.lastCappedFollowUp, undefined);
        assert.equal(afterWindow.correctionCycles, 0);
        assert.equal(afterWindow.activeExchange!.reviewResponseMode, "correction");
        assert.equal(afterWindow.reviewHistory.at(-1)!.disposition, "held_then_sent");
        assert.match(f.warnings.at(-1)!, /\/review-continue: WARNING: Review evidence method: Tools only \(snapshot-failure fallback\)/);
        assert.match(f.rt.sent.at(-1)!.message, /Tools only \(snapshot-failure fallback\)/);
        assert.equal(after.pendingModelDeliveries.at(-1)!.kind, "review_authorization");
        assert.equal(after.pendingModelDeliveries.at(-1)!.status, "delivered");
      } else {
        assert.equal(afterWindow.lastCappedFollowUp, beforeWindow.lastCappedFollowUp);
        assert.equal(afterWindow.correctionCycles, beforeWindow.correctionCycles);
        assert.deepEqual(afterWindow.reviewHistory, beforeWindow.reviewHistory);
        assert.equal(after.pendingModelDeliveries.length, before.pendingModelDeliveries.length);
        assert.doesNotMatch(f.warnings.join("\n"), /Tools only \(snapshot-failure fallback\)/);
      }
      assert.equal(reviews, 2, "continuation authorization must not invoke a reviewer itself");
    } finally { await f.dispose(); }
  });
}

test("capped continuation retries a first-capture fallback and preserves its historical coverage limit on recovery", async () => {
  const f = await fixture({ snapshotFailureFallback: true }, true, 1);
  try {
    let reviews = 0;
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => {
      reviews++;
      return { reviewerId: request.id, verdict: "needs_changes", summary: "CORRECTION_STILL_REQUIRED", findings: [] };
    });
    const failure = mock.method(checkpoints, "captureReviewCheckpoint", async () => ({ status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const }));
    await f.start();
    await f.writeScript("FIRST_TOOL_CORRECTION\n");
    await f.end();
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await f.writeScript("SECOND_TOOL_CORRECTION\n");
    await f.end();
    const before = (await f.restored())!.state.reviewWindow!;
    assert.ok(before.lastCappedFollowUp);
    assert.equal(before.baseline!.kind, "tool");
    failure.mock.restore();
    await f.commands.get("review-continue")!("", f.rt.ctx);
    const after = (await f.restored())!.state.reviewWindow!;
    assert.ok(after.baseline?.kind === "checkpoint" && after.baseline.toolOnlyHistory);
    assert.deepEqual(after.activeExchange!.baseline, after.baseline);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.activeExchange!.reviewResponseMode, "correction");
    assert.equal(after.correctionCycles, 0);
    assert.equal(after.lastCappedFollowUp, undefined);
    assert.equal(reviews, 2);
    assert.match(f.warnings.at(-1)!, /snapshot capture recovered; a NEW baseline covers subsequent work only/);
    assert.match(f.rt.sent.at(-1)!.message, /no pre-work snapshot covers that interval/);
  } finally { await f.dispose(); }
});

test("disabling releases an unused capture when automatic review acquires ownership during capture", async () => {
  const f = await fixture({ primaryToolOnly: true });
  const captured = gate(), releaseCapture = gate(), owned = gate();
  let changing: Promise<void> | undefined;
  let ending: Promise<void> | undefined;
  try {
    await f.start();
    await f.writeScript("TOOL_WORK_DURING_DISABLE_CAPTURE\n");
    const capture = checkpoints.captureReviewCheckpoint;
    const release = checkpoints.releaseReviewCheckpoint;
    let held = false;
    let unused: checkpoints.ReviewCheckpointDescriptor | undefined;
    const released: checkpoints.ReviewCheckpointDescriptor[] = [];
    mock.method(checkpoints, "captureReviewCheckpoint", async (...args: Parameters<typeof capture>) => {
      const result = await capture(...args);
      if (args[1].startsWith("policy-") && !held) {
        held = true;
        assert.equal(result.status, "ok");
        if (result.status === "ok") unused = result.value;
        captured.resolve();
        await releaseCapture.promise;
      }
      return result;
    });
    mock.method(checkpoints, "releaseReviewCheckpoint", async (...args: Parameters<typeof release>) => {
      released.push(args[1]);
      return release(...args);
    });
    const beginOwned = reviewActivity.beginOwnedReviewActivity;
    mock.method(reviewActivity, "beginOwnedReviewActivity", () => {
      const token = beginOwned();
      owned.resolve();
      return token;
    });
    const reviews = require("../src/review") as typeof import("../src/review");
    const run = reviews.runReview;
    let observedOwnedBasis = false;
    mock.method(reviews, "runReview", async (input: Parameters<typeof run>[0]) => {
      assert.ok("kind" in input.before && input.before.kind === "tool");
      assert.equal(input.window!.baseline!.kind, "tool", "settings must not publish into the owned window");
      assert.equal(input.window!.activeExchange!.baseline!.kind, "tool");
      observedOwnedBasis = true;
      return run(input);
    });
    changing = f.settings(["Reviewers", "Evidence methods", "Primary /", "Back", "Back", "Save changes"]);
    await atBarrier(captured.promise, "disable snapshot capture");
    assert.ok(unused);
    ending = f.end();
    await atBarrier(owned.promise, "automatic review ownership");
    assert.equal((await f.restored())!.state.reviewWindow!.baseline!.kind, "tool");
    releaseCapture.resolve();
    await Promise.all([changing, ending]);
    assert.equal(observedOwnedBasis, true);
    assert.equal(released.filter((descriptor) => descriptor === unused).length, 1);
    const load = await checkpoints.loadReviewCheckpoint(f.cwd, unused!, { scope: { agentDir: testAgentDir, sessionId: "primary-evidence" } });
    assert.notEqual(load.status, "ok", "the unused policy checkpoint must not leak");
    assert.equal(await readFile(f.calls, "utf8"), "1");
    const bundle = extractBundleDir(f.rt.sent[0]!.message, 1);
    const metadata = JSON.parse(await readFile(join(bundle, "reviews/0001/metadata.json"), "utf8"));
    assert.equal(metadata.evidenceMethod, "tool-only");
    assert.match(f.warnings.join("\n"), /pending until the running review settles/);
    assert.doesNotMatch(f.warnings.join("\n"), /Primary evidence method changed: Tools only → Tools \+ workspace changes\./);
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    assert.match(f.warnings.at(-1)!, /Primary evidence method changed: Tools only → Tools \+ workspace changes\./);
    assert.equal((await f.restored())!.state.reviewWindow!.evidence.events.length, 2);
  } finally {
    releaseCapture.resolve();
    await Promise.allSettled([changing, ending].filter((promise): promise is Promise<void> => promise !== undefined));
    await f.dispose();
  }
});

test("initial fallback notification failure leaves initialization unarmed and retries the warning before work", async () => {
  const f = await fixture({ snapshotFailureFallback: true });
  let failWarning = true;
  try {
    let captureAttempts = 0;
    let warningAttempts = 0;
    mock.method(checkpoints, "captureReviewCheckpoint", async () => {
      captureAttempts++;
      return { status: "failed" as const, reason: "patch_too_large" as const, evidenceCaptureFailure: true as const };
    });
    const host = f.rt.pi as typeof f.rt.pi & { sendMessage: (message: { content: string }) => unknown };
    const sendMessage = host.sendMessage;
    mock.method(host, "sendMessage", (message: { content: string }) => {
      if (message.content.includes("Review evidence method: Tools only (snapshot-failure fallback)")) {
        warningAttempts++;
        if (failWarning) throw new Error("injected initial fallback sendMessage failure");
      }
      return sendMessage(message);
    });
    await assert.rejects(f.start(), /initial fallback sendMessage failure/);
    await f.commands.get("review-now")!("", f.rt.ctx);
    assert.match(f.rt.notices.at(-1)!, /no active review window with a baseline/);
    const unarmed = (await f.restored())!.state.reviewWindow!;
    assert.equal(unarmed.baseline, undefined);
    assert.equal(unarmed.activeExchange?.baseline, undefined);
    assert.equal(warningAttempts, 1);
    assert.equal(f.warnings.length, 0);
    await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/);
    // Keep any observation that arrives while initialization is retryable.
    await trigger(f.rt.hooks, "tool_result", { toolName: "bash", input: { command: "echo retained observation" },
      result: { content: [{ type: "text", text: "RETAINED_WHILE_INITIALIZATION_FAILED" }] },
    }, f.rt.ctx);
    failWarning = false;
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    const armed = (await f.restored())!.state.reviewWindow!;
    assert.ok(armed.baseline?.kind === "tool" && armed.baseline.fallback);
    assert.equal(armed.evidence.events.length, 1);
    assert.match(armed.evidence.events[0]!.detail!, /RETAINED_WHILE_INITIALIZATION_FAILED/);
    assert.equal(captureAttempts, 2, "retry must not reuse an undisclosed armed basis");
    assert.equal(warningAttempts, 2);
    assert.match(f.warnings.at(-1)!, /Tools only \(snapshot-failure fallback\)/);
    await f.writeScript("WORK_AFTER_MANDATORY_WARNING\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
  } finally { failWarning = false; await f.dispose(); }
});
