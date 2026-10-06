// #301 entrypoint regressions through real activate() hooks: raw (non-Git)
// checkpoints always live in <agentDir>/sessions/pi-review-gate/<live session>/
// for in-memory (no session file) and persisted sessions alike — including a
// conversation file inside the workspace — and never inside the workspace.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { rawReviewCheckpointRecordPath, type ReviewCheckpointDescriptor } from "../src/review-checkpoint";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import {
  countingPassReviewerWithPromptDump,
  indexTestConfig,
  testAgentDir,
  trigger,
  triggerAgentEnd,
} from "./entrypoint-harness";

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "prg-entry-session-storage-")));
  const cwd = join(base, "workspace");
  const support = join(base, "support");
  await mkdir(cwd);
  await mkdir(support);
  const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = base;
  const configPath = join(support, "review-gate.json");
  const promptPath = join(support, "prompt.txt");
  const callsPath = join(support, "calls.txt");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    externalAgents: agentCatalog(countingPassReviewerWithPromptDump("fake", callsPath, promptPath)),
    review: { primaryReviewers: [{ source: "external", id: "fake" }], primaryEnabled: true },
  }));
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  await writeFile(join(cwd, "work.txt"), "baseline\n");
  return {
    base, cwd, promptPath, callsPath,
    async cleanup() {
      if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
      await rm(base, { recursive: true, force: true });
    },
  };
}

function runtime(sessionId: string, cwd: string, sessionFile: string | undefined) {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notices: string[] = [];
  const sent: Array<{ message: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerCommand() {},
    appendEntry() {},
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    // --no-session/in-memory sessions keep a live session id but no file.
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getCwd: () => cwd },
  };
  return { hooks, notices, sent, pi, ctx };
}

async function namespaceRecords(sessionId: string): Promise<string[]> {
  const namespace = join(testAgentDir, "sessions", "pi-review-gate", sessionId, "checkpoints");
  const records: string[] = [];
  for (const workspace of await readdir(namespace).catch(() => [])) {
    for (const owner of await readdir(join(namespace, workspace))) records.push(join(namespace, workspace, owner, "record.json"));
  }
  return records;
}

test("an in-memory session without a session file reviews with external checkpoints and persists nothing", async () => {
  const f = await fixture();
  try {
    const rt = runtime("ephemeral-session", f.cwd, undefined);
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
    await trigger(rt.hooks, "input", { cwd: f.cwd, source: "user", text: "edit the work file" }, rt.ctx);
    await trigger(rt.hooks, "before_agent_start", { cwd: f.cwd }, rt.ctx);
    assert.ok((await namespaceRecords("ephemeral-session")).length >= 1, "baseline armed in the live session namespace");
    await writeFile(join(f.cwd, "work.txt"), "baseline\nreviewed edit\n");
    await triggerAgentEnd(rt.hooks, { cwd: f.cwd, messages: [{ role: "assistant", content: "edited" }] }, rt.ctx);
    // Review is not disabled merely because there is no session file.
    assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "1", rt.notices.join(" | "));
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    assert.match(await readFile(f.promptPath, "utf8"), /reviewed edit/);
    // No checkpoint folder and no conversation/sidecar persistence anywhere.
    assert.deepEqual(await readdir(f.cwd), ["work.txt"]);
    assert.deepEqual((await readdir(f.base)).sort(), ["support", "workspace"]);
    assert.deepEqual((await readdir(testAgentDir)).sort(), ["sessions"]);
    assert.deepEqual(await readdir(join(testAgentDir, "sessions")), ["pi-review-gate"]);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally { await f.cleanup(); }
});

test("a conversation file inside the workspace still uses external checkpoints and resumes them", async () => {
  const f = await fixture();
  try {
    const sessionFile = join(f.cwd, "conversation.jsonl");
    await writeFile(sessionFile, "");
    const first = runtime("in-tree-session", f.cwd, sessionFile);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: f.cwd, source: "user", text: "edit the work file" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: f.cwd }, first.ctx);
    const store = new SessionStateStore({ sessionId: "in-tree-session", sessionFile, cwd: f.cwd });
    const armed = (await store.restore(f.cwd))?.state.reviewWindow?.baseline;
    assert.equal(armed?.kind, "checkpoint");
    if (armed?.kind !== "checkpoint" || armed.descriptor.kind !== "raw") throw new Error("expected raw baseline");
    const descriptor: Extract<ReviewCheckpointDescriptor, { kind: "raw" }> = armed.descriptor;
    assert.equal(descriptor.sessionId, "in-tree-session");
    // Never dirname(sessionFile): the record is in the agent-data namespace.
    await access(rawReviewCheckpointRecordPath({ agentDir: testAgentDir, sessionId: "in-tree-session" }, f.cwd, descriptor));
    assert.deepEqual((await readdir(f.cwd)).sort(), ["conversation.jsonl", "conversation.jsonl.pi-review-gate-state.json", "work.txt"]);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Same-implementation persisted recovery: the resumed live session
    // re-derives the same external location and verifies the record.
    const resumed = runtime("in-tree-session", f.cwd, sessionFile);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /restored conversation state revision/);
    assert.doesNotMatch(resumed.notices.join("\n"), /cannot resume|not restored/);
    await trigger(resumed.hooks, "before_agent_start", { cwd: f.cwd }, resumed.ctx);
    await writeFile(join(f.cwd, "work.txt"), "baseline\nresumed edit\n");
    await triggerAgentEnd(resumed.hooks, { cwd: f.cwd, messages: [{ role: "assistant", content: "edited" }] }, resumed.ctx);
    assert.equal(await readFile(f.callsPath, "utf8").catch(() => "missing"), "1", resumed.notices.join(" | "));
    assert.match(await readFile(f.promptPath, "utf8"), /resumed edit/);
    assert.ok(!(await readdir(f.cwd)).includes(".pi-review-gate"));
    await trigger(resumed.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, resumed.ctx);
  } finally { await f.cleanup(); }
});
