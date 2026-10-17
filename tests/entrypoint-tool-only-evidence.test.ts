import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { mock } from "node:test";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { runReview } from "../src/review";
import { ReviewEvidenceCaptureFailure } from "../src/review-evidence";
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

async function fixture(evidence: Record<string, boolean> = {}, primaryEnabled = true, maxCorrectionCycles = indexTestConfig.maxCorrectionCycles as number) {
  const root = await mkdtemp(join(__dirname, "primary-tool-evidence-"));
  const cwd = join(root, "workspace");
  const priorHome = process.env.HOME;
  const home = join(root, "home");
  await mkdir(home);
  process.env.HOME = home;
  await mkdir(cwd);
  const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
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
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  rt.pi.registerCommand = (name, options) => { commands.set(name, options.handler); };
  const warnings: string[] = [];
  Object.assign(rt.pi, { sendMessage(message: { content: string }) { warnings.push(message.content); } });
  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
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
  const dispose = async () => {
    mock.restoreAll();
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
    if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  };
  return { root, cwd, configPath, calls, prompt, rt, commands, warnings, restored, start, writeScript, end, settings, dispose };
}

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
    await writeFile(join(f.cwd, "REPORT"), "UNOBSERVED_REPORT\n");
    await writeFile(join(f.cwd, "SCRIPT"), "UNOBSERVED_SCRIPT\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
    assert.equal((await f.restored())?.state.reviewWindow, undefined);
  } finally { await f.dispose(); }
});

test("real settings apply resets/warns only Primary Off->On; disable retains evidence and establishes new snapshot baseline", async () => {
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
          assert.match(f.warnings.join("\n"), /tool-only-fallback/);
          await f.writeScript("CURRENT_WORK_SURVIVES\n");
        }
        if (enabled) await f.end();
        else await assert.rejects(f.end(), /acquisition failed/);
        failure.mock.restore();
        if (!enabled) {
          await assert.rejects(readFile(f.calls, "utf8"), /ENOENT/);
          assert.doesNotMatch(f.rt.notices.join("\n"), /tool-only-fallback/);
          assert.equal((await f.restored())!.state.reviewWindow!.baseline?.kind, "checkpoint");
          return;
        }
        assert.equal(await readFile(f.calls, "utf8"), "1");
        assert.match(f.rt.sent[0]!.message, /tool-only-fallback/);
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
      assert.doesNotMatch(f.rt.notices.join("\n"), /tool-only-fallback/);
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
      assert.ok(f.warnings.some((warning) => warning.includes("tool-only-fallback")));
      mock.restoreAll();
      await f.writeScript("REAL_CAPTURE_FALLBACK_WORK\n");
      await f.end();
      assert.equal(await readFile(f.calls, "utf8"), "1");
      assert.match(f.rt.sent[0]!.message, /Review evidence method: tool-only\./);
      assert.match(f.rt.sent[0]!.message, /new snapshot baseline covers subsequent work only/);
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
    assert.doesNotMatch(f.rt.notices.join("\n"), /tool-only-fallback/);
    loaded.mock.restore();
    mock.method(GenericCliAdapter.prototype, "run", async (request: ModelAdapterRequest): Promise<ReviewResult> => ({ reviewerId: request.id, verdict: "error", summary: "injected reviewer failure", findings: [], error: "invalid_output" }));
    await f.commands.get("review-now")!("", f.rt.ctx);
    assert.match(f.rt.sent[0]!.message, /injected reviewer failure/);
    assert.doesNotMatch(f.rt.sent[0]!.message, /tool-only-fallback/);
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
    assert.match(f.rt.sent[0]!.message, /Review evidence method: snapshot/);
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
    assert.match(f.rt.sent.at(-1)!.message, /Review evidence method: tool-only/);
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
    assert.equal(f.warnings.filter((warning) => warning.includes("Review evidence method: tool-only-fallback")).length, 2);
    assert.equal(await readFile(f.calls, "utf8"), "2");
    capture.mock.restore();
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    await writeFile(join(f.cwd, "REPORT"), "SNAPSHOT_RECOVERED_REPORT\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "3");
    assert.match(f.rt.sent[2]!.message, /Review evidence method: snapshot/);
    assert.doesNotMatch(f.rt.sent[2]!.message, /tool-only-fallback/);
    const bundle = extractBundleDir(f.rt.sent[2]!.message, 3);
    assert.match(await readFile(join(bundle, "reviews/0003/patch.diff"), "utf8"), /SNAPSHOT_RECOVERED_REPORT/);
    assert.equal(f.warnings.filter((warning) => warning.includes("Review evidence method: tool-only-fallback")).length, 2);
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

test("disabling tool-only honors opted-in acquisition fallback without resetting retained work or latching preference", async () => {
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
    assert.match(f.warnings.at(-1)!, /preference disabled.*will be retried/);
    assert.match(f.warnings.at(-1)!, /tool-only-fallback/);
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
        assert.match(f.warnings.at(-1)!, /\/review-continue: WARNING: Review evidence method: tool-only-fallback/);
        assert.match(f.rt.sent.at(-1)!.message, /tool-only-fallback/);
        assert.equal(after.pendingModelDeliveries.at(-1)!.kind, "review_authorization");
        assert.equal(after.pendingModelDeliveries.at(-1)!.status, "delivered");
      } else {
        assert.equal(afterWindow.lastCappedFollowUp, beforeWindow.lastCappedFollowUp);
        assert.equal(afterWindow.correctionCycles, beforeWindow.correctionCycles);
        assert.deepEqual(afterWindow.reviewHistory, beforeWindow.reviewHistory);
        assert.equal(after.pendingModelDeliveries.length, before.pendingModelDeliveries.length);
        assert.doesNotMatch(f.warnings.join("\n"), /tool-only-fallback/);
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
    assert.doesNotMatch(f.warnings.join("\n"), /Primary tool-only evidence disabled\./);
    await trigger(f.rt.hooks, "before_agent_start", { cwd: f.cwd }, f.rt.ctx);
    assert.match(f.warnings.at(-1)!, /Primary tool-only evidence disabled\./);
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
      if (message.content.includes("Review evidence method: tool-only-fallback")) {
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
    assert.match(f.warnings.at(-1)!, /tool-only-fallback/);
    await f.writeScript("WORK_AFTER_MANDATORY_WARNING\n");
    await f.end();
    assert.equal(await readFile(f.calls, "utf8"), "1");
  } finally { failWarning = false; await f.dispose(); }
});
