// User-runnable real-hook restart smoke:
// npm run build:test && node --test dist-test/tests/entrypoint-unified-restart.test.js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { activate } from "../src/index";
import { SESSION_STATE_QUARANTINE_MARKER, SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import {
  countingPassReviewerWithPromptDump, createSessionRuntime, indexTestConfig,
  stableJsonForTest, trigger, triggerAgentEnd,
} from "./entrypoint-harness";

const exec = promisify(execFile);
const sessionId = "restart-smoke";
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Restart Smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Restart Smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...gitEnv, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES } })).stdout;
}

// Everything created by this fixture stays in the compiled test's ignored
// directory. A fresh activate() and new hook map model process restart without
// replacing the persistent Pi session identity or reusing in-memory state.
async function fixture(gitRoot: boolean) {
  const root = await mkdtemp(join(__dirname, "unified-restart-smoke-"));
  const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = root;
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "session");
  await mkdir(cwd);
  await mkdir(sessionDir);
  const sessionFile = join(sessionDir, "conversation.jsonl");
  await writeFile(sessionFile, "");
  const callsPath = join(sessionDir, "calls.txt");
  const promptPath = join(sessionDir, "prompt.txt");
  const configPath = join(sessionDir, "config.json");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    retainBundles: "always",
    externalAgents: agentCatalog(countingPassReviewerWithPromptDump("fake", callsPath, promptPath)),
    review: {
      primaryReviewers: [{ source: "external", id: "fake" }],
      subtaskReviewers: [{ source: "external", id: "fake" }],
      primaryEnabled: true,
    },
  }));
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  if (gitRoot) {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "core.autocrlf", "false");
  }
  await writeFile(join(cwd, "keep.txt"), "untouched clean tracked\n");
  await writeFile(join(cwd, "work.txt"), "original\n");
  if (gitRoot) {
    await git(cwd, "add", "keep.txt", "work.txt");
    await git(cwd, "commit", "-q", "-m", "seed");
    await writeFile(join(cwd, "work.txt"), "staged baseline\n");
    await git(cwd, "add", "work.txt");
    await writeFile(join(cwd, "work.txt"), "staged baseline\nunstaged baseline\n");
  }
  await writeFile(join(cwd, "loose.bin"), Buffer.from([0, 255, 3, 8]));
  const store = new SessionStateStore({ sessionId, sessionFile, cwd });
  return { root, cwd, sessionFile, callsPath, promptPath, store, async cleanup() {
    if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
    await rm(root, { recursive: true, force: true });
  } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function activateSession(
  f: Fixture, reason: "startup" | "reload" = "startup",
  commands?: Map<string, (args: string, ctx: unknown) => Promise<void>>,
) {
  const rt = createSessionRuntime(sessionId, f.sessionFile, f.cwd);
  if (commands) rt.pi.registerCommand = (name, options) => { commands.set(name, options.handler); };
  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason }, rt.ctx);
  return rt;
}
async function arm(f: Fixture) {
  const rt = await activateSession(f);
  await trigger(rt.hooks, "input", { cwd: f.cwd, source: "user", text: "edit work and binary only" }, rt.ctx);
  await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
  const window = (await f.store.restore(f.cwd))?.state.reviewWindow;
  assert.equal(window?.baseline?.kind, "checkpoint", "actual preprompt armed a durable unified baseline");
  assert.equal(window?.activeExchange?.baseline?.kind, "checkpoint");
  if (window?.baseline?.kind !== "checkpoint") throw new Error("missing checkpoint");
  return { rt, baseline: window.baseline.descriptor };
}
async function settle(f: Fixture, rt: Awaited<ReturnType<typeof activateSession>>, marker: string) {
  await writeFile(join(f.cwd, "work.txt"), `${(await readFile(join(f.cwd, "work.txt"), "utf8"))}${marker}\n`);
  await writeFile(join(f.cwd, "loose.bin"), Buffer.from([0, 254, 3, 8]));
  await trigger(rt.hooks, "tool_call", { cwd: f.cwd, toolName: "bash", input: { command: "echo edit" } }, rt.ctx);
  await triggerAgentEnd(rt.hooks, {
    cwd: f.cwd, messages: [{ role: "assistant", content: "edited work and binary" }],
  }, rt.ctx);
  assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "1", `reviewer calls; notices: ${rt.notices.join(" | ")}`);
  assert.match(rt.notices.join("\n"), /review gate: passed/);
  const window = (await f.store.restore(f.cwd))?.state.reviewWindow;
  assert.equal(window?.reviewHistory.at(-1)?.verdict, "pass");
  assert.deepEqual(window.exchanges.at(-1)?.workspaceChanges.map((c) => [c.path, c.status]).sort(), [
    ["loose.bin", "modified"], ["work.txt", "modified"],
  ]);
  assert.equal(window.exchanges.at(-1)?.workspaceChanges.find((c) => c.path === "loose.bin")?.binary, true);
  const prompt = await readFile(f.promptPath, "utf8");
  assert.match(prompt, new RegExp(marker));
  assert.match(prompt, /loose\.bin/);
  assert.doesNotMatch(prompt, /untouched clean tracked/);
  return window;
}

for (const kind of ["git", "raw"] as const) {
  test(`${kind}: actual hooks restore original compact descriptor, then review only post-capture edits`, async () => {
    const f = await fixture(kind === "git");
    try {
      const beforeStatus = kind === "git" ? await git(f.cwd, "status", "--porcelain=v1") : undefined;
      const { baseline } = await arm(f);
      assert.equal(baseline.kind, kind);
      if (kind === "git") assert.equal(await git(f.cwd, "status", "--porcelain=v1"), beforeStatus);
      const armedSidecar = JSON.parse(await readFile(f.store.path, "utf8")) as {
        state: { reviewWindow: { baseline: { descriptor: unknown }; activeExchange: { baseline: { $checkpointRef: unknown } } } };
      };
      assert.deepEqual(armedSidecar.state.reviewWindow.baseline.descriptor, baseline);
      assert.ok(armedSidecar.state.reviewWindow.activeExchange.baseline.$checkpointRef);
      assert.doesNotMatch(JSON.stringify(armedSidecar.state.reviewWindow.baseline), /"files"|contentB64|stagedPatchB64/);
      // Abandon the first hook map without settling or shutting down: exactly
      // the persisted session identity, config and workspace survive.
      const resumed = await activateSession(f, "reload");
      assert.match(resumed.notices.join("\n"), /restored conversation state revision/);
      const restored = (await f.store.restore(f.cwd))?.state.reviewWindow;
      assert.equal(restored?.reviewHistory.length, 0, "restart must not synthesize a pass");
      assert.deepEqual(restored?.baseline?.kind === "checkpoint" ? restored.baseline.descriptor : undefined, baseline);
      assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "missing");
      await trigger(resumed.hooks, "before_agent_start", { cwd: f.cwd }, resumed.ctx);
      await settle(f, resumed, "after restart reviewed edit");
    } finally { await f.cleanup(); }
  });
}

for (const [kind, damage] of [
  ["raw", "corrupt record"], ["raw", "missing record"],
  ["git", "corrupt record"], ["git", "missing pin"],
] as const) {
  test(`${kind}: ${damage} preserves old evidence and reviews only edits after fresh restart capture`, async () => {
    const f = await fixture(kind === "git");
    try {
      const { baseline } = await arm(f);
      assert.equal(baseline.kind, kind);
      // The authenticated old review has a queued pass that must never be
      // replayed after its checkpoint is lost.
      const old = JSON.parse(await readFile(f.store.path, "utf8"));
      old.state.reviewWindow.reviewHistory.push({
        sequence: 1, source: "automatic", disposition: "sent_for_observation",
        verdict: "pass", reviewerResults: [],
      });
      old.state.pendingModelDeliveries.push({
        deliveryId: "old-pass", kind: "review_authorization", channel: "follow_up",
        message: "stale old pass", status: "queued", createdAt: "old",
      });
      const { integritySha256: _hash, ...unsigned } = old;
      old.integritySha256 = createHash("sha256").update(stableJsonForTest(unsigned)).digest("hex");
      const sidecar = `${JSON.stringify(old)}\n`;
      await writeFile(f.store.path, sidecar);
      await writeFile(join(f.cwd, "work.txt"), "edit already present before restart\n");
      let damagedRecord: string | undefined;
      if (baseline.kind === "raw") {
        const record = join(f.cwd, ".pi-review-gate", "checkpoints", `${baseline.windowId}-${baseline.owner}`, "record.json");
        damagedRecord = record;
        if (damage === "missing record") await rm(record);
        else await writeFile(record, "corrupt owned record");
      } else if (baseline.kind === "git") {
        if (damage === "missing pin") await git(f.cwd, "update-ref", "-d", baseline.checkpoint.ref);
        else {
          damagedRecord = join(baseline.checkpoint.gitDir, "pi-review-gate", "checkpoints", baseline.checkpoint.windowId, `arm-${baseline.checkpoint.armId}`, "record.json");
          await writeFile(damagedRecord, "corrupt owned record");
        }
      }
      const resumed = await activateSession(f, "reload");
      assert.match(resumed.notices.join("\n"), /previous review cannot resume/);
      assert.match(resumed.notices.join("\n"), /Already-present edits become the new baseline/);
      assert.doesNotMatch(resumed.notices.join("\n"), /review gate: passed/);
      assert.equal(resumed.sent.length, 0, "old queued authorization cannot be delivered");
      const preserved = (await readdir(join(f.root, "session"))).filter((name) => name.includes(SESSION_STATE_QUARANTINE_MARKER));
      assert.equal(preserved.length, 1);
      assert.equal(await readFile(join(f.root, "session", preserved[0]!), "utf8"), sidecar);
      if (damagedRecord) {
        assert.equal(await readFile(damagedRecord, "utf8").catch(() => "missing"),
          damage === "missing record" ? "missing" : "corrupt owned record", "old owned record was not released");
      }
      const fresh = (await f.store.restore(f.cwd))?.state;
      assert.equal(fresh?.pendingModelDeliveries.find((d) => d.deliveryId === "old-pass")?.status, "cancelled");
      assert.equal(fresh?.reviewWindow?.reviewHistory.length, 0);
      assert.equal(fresh?.reviewWindow?.baseline?.kind, "checkpoint");
      assert.notDeepEqual(fresh?.reviewWindow?.baseline?.kind === "checkpoint" ? fresh.reviewWindow.baseline.descriptor : undefined, baseline);
      assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "missing");
      await trigger(resumed.hooks, "before_agent_start", { cwd: f.cwd }, resumed.ctx);
      const window = await settle(f, resumed, "post-reset reviewed edit");
      assert.doesNotMatch(window.exchanges.at(-1)?.workspacePatch ?? "", /\+edit already present before restart/);
      assert.doesNotMatch(await readFile(f.promptPath, "utf8"), /\+edit already present before restart/);
      assert.equal(resumed.sent.some((message) => JSON.stringify(message).includes("stale old pass")), false);
    } finally { await f.cleanup(); }
  });
}

for (const failure of ["quarantine", "fresh save"] as const) {
  test(`${failure} failure blocks both agent settlement and manual review after checkpoint damage`, async () => {
    const f = await fixture(false);
    const quarantine = SessionStateStore.prototype.quarantine;
    const save = SessionStateStore.prototype.save;
    try {
      const { baseline } = await arm(f);
      assert.equal(baseline.kind, "raw");
      const original = await readFile(f.store.path, "utf8");
      if (baseline.kind !== "raw") return;
      const record = join(f.cwd, ".pi-review-gate", "checkpoints", `${baseline.windowId}-${baseline.owner}`, "record.json");
      await rm(record);
      if (failure === "quarantine") {
        SessionStateStore.prototype.quarantine = async function () {
          if (this.path === f.store.path) throw Object.assign(new Error("injected quarantine failure"), { code: "EIO" });
          return quarantine.call(this);
        };
      } else {
        let injected = false;
        SessionStateStore.prototype.save = async function (state, associations, config) {
          const next = state.reviewWindow?.baseline;
          if (!injected && this.path === f.store.path && next?.kind === "checkpoint"
            && JSON.stringify(next.descriptor) !== JSON.stringify(baseline)) {
            injected = true;
            throw Object.assign(new Error("injected fresh save failure"), { code: "EIO" });
          }
          return save.call(this, state, associations, config);
        };
      }
      const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
      const resumed = await activateSession(f, "reload", commands);
      assert.match(resumed.notices.join("\n"), failure === "quarantine"
        ? /could not be quarantined|persisted conversation state was not restored/
        : /fresh checkpoint could not be durably captured/);
      assert.doesNotMatch(resumed.notices.join("\n"), /review gate: passed/);
      assert.equal(await readFile(f.store.path, "utf8").catch(() => "missing"),
        failure === "quarantine" ? original : "missing", "no failed restart may overwrite the old sidecar");
      if (failure === "fresh save") {
        const preserved = (await readdir(join(f.root, "session"))).filter((name) => name.includes(SESSION_STATE_QUARANTINE_MARKER));
        assert.equal(preserved.length, 1);
        assert.equal(await readFile(join(f.root, "session", preserved[0]!), "utf8"), original);
      }
      assert.ok(commands.has("review-now"));
      await commands.get("review-now")!("", resumed.ctx);
      await commands.get("review-continue")!("", resumed.ctx);
      await commands.get("ask-reviewer")!("test", resumed.ctx);
      await commands.get("ask-reviewer-interactive")!("test", resumed.ctx);
      assert.match(resumed.notices.join("\n"), /\/review-now blocked/);
      await assert.rejects(trigger(resumed.hooks, "before_agent_start", { cwd: f.cwd }, resumed.ctx), /fresh checkpoint restart failed/);
      // Even an unexpected settlement without a new agent start cannot pass.
      await writeFile(join(f.cwd, "work.txt"), "changed after failed restart\n");
      await triggerAgentEnd(resumed.hooks, { cwd: f.cwd, messages: [{ role: "assistant", content: "edit" }] }, resumed.ctx);
      assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "missing");
      assert.equal(resumed.sent.length, 0);
      assert.doesNotMatch(resumed.notices.join("\n"), /review gate: passed/);
    } finally {
      SessionStateStore.prototype.quarantine = quarantine;
      SessionStateStore.prototype.save = save;
      await f.cleanup();
    }
  });
}

test("authentic old-format review window cuts over without migrating or replaying its pass", async () => {
  const f = await fixture(false);
  try {
    await arm(f);
    const sidecar = JSON.parse(await readFile(f.store.path, "utf8")) as {
      version: number; reviewerSelectionDigest?: string; integritySha256: string;
      state: { reviewWindow: {
        baseline: unknown; baselineArmed?: boolean; activeExchange: { baseline?: unknown }; reviewHistory: unknown[];
      }; pendingModelDeliveries: unknown[] };
    };
    sidecar.version = 3;
    sidecar.state.reviewWindow.baseline = {
      cwd: f.cwd, capturedAt: "old", files: [], omissions: [], omissionsTruncated: false,
    };
    delete sidecar.state.reviewWindow.activeExchange.baseline;
    delete sidecar.state.reviewWindow.baselineArmed;
    sidecar.state.reviewWindow.reviewHistory = [{
      sequence: 1, source: "automatic", disposition: "sent_for_observation", verdict: "pass", reviewerResults: [],
    }];
    sidecar.state.pendingModelDeliveries = [{
      deliveryId: "old", kind: "review_authorization", channel: "follow_up",
      message: "old pass", status: "queued", createdAt: "now",
    }];
    delete sidecar.reviewerSelectionDigest;
    const { integritySha256: _oldHash, ...unsigned } = sidecar;
    sidecar.integritySha256 = createHash("sha256").update(stableJsonForTest(unsigned)).digest("hex");
    await writeFile(f.store.path, JSON.stringify(sidecar));
    // A pre-existing edit at cutover belongs to the new baseline, not to an
    // old claimed pass or to a reconstructed diff from the retired format.
    await writeFile(join(f.cwd, "work.txt"), "before cutover edit\n");
    const resumed = await activateSession(f, "reload");
    assert.match(resumed.notices.join("\n"), /restored conversation state revision/);
    assert.equal(resumed.sent.length, 0, "old queued review authorization is never delivered");
    assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "missing");
    const cutover = (await f.store.restore(f.cwd))?.state;
    assert.equal(cutover?.reviewWindow, undefined, "old review and its fake pass were dropped");
    assert.equal(cutover?.pendingModelDeliveries[0]?.status, "cancelled");
    await trigger(resumed.hooks, "input", { cwd: f.cwd, source: "user", text: "review new changes" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: f.cwd }, resumed.ctx);
    const fresh = (await f.store.restore(f.cwd))?.state.reviewWindow;
    assert.equal(fresh?.reviewHistory.length, 0, "fresh window must not carry old verdict");
    assert.equal(fresh?.baseline?.kind, "checkpoint");
    assert.equal(fresh?.baseline?.kind === "checkpoint" ? fresh.baseline.descriptor.kind : undefined, "raw");
    const window = await settle(f, resumed, "post cutover reviewed edit");
    assert.match(window.exchanges.at(-1)?.workspacePatch ?? "", /post cutover reviewed edit/);
    assert.doesNotMatch(window.exchanges.at(-1)?.workspacePatch ?? "", /\+before cutover edit/);
    const stored = await readFile(f.store.path, "utf8");
    assert.doesNotMatch(stored, /"files"\s*:/, "new window never migrates old inline snapshot");
  } finally { await f.cleanup(); }
});
