// Issue #175 primary runtime slice: the stored `primaryEnabled` toggle
// suppresses automatic primary-agent review at settlement (shared by Execute
// and Orchestrate) while manual /review-now and /ask-reviewer stay gated by
// the selected reviewers and the master setting. With automatic review off,
// the window's baseline, exchanges, evidence, and persisted history keep
// accumulating across quick turns; exchanges settle without any synthetic
// PASS, queued user input is not stranded, and background readiness never
// defers a review that will not run.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import {
  countingPassReviewer,
  extractBundleDir,
  indexTestConfig,
  trigger,
  triggerAgentEnd,
  waitForCondition,
} from "./entrypoint-harness";

// Row formatting mirrors src/settings/command.ts alignedSettingsRows so the
// scripted /review-settings selections match the rendered menu exactly.
const ROOT_SETTING_LABELS = [
  "Operating mode",
  "Mode cycle hotkey",
  "Worker resources",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Deferred Pi tools",
  "Subtasks view",
  "Web",
] as const;
const REVIEW_SETTING_LABELS = [
  "Automatic primary review",
  "Automatic subtask review",
  "Review landed changes",
  "Primary reviewers",
  "Subtask reviewers",
] as const;

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function rootReviewersRow(value: string): string {
  return alignedTestRow("Reviewers", value, ROOT_SETTING_LABELS);
}

function reviewSettingsRow(label: (typeof REVIEW_SETTING_LABELS)[number], value: string): string {
  return alignedTestRow(label, value, REVIEW_SETTING_LABELS);
}

/** Drive /review-settings through a scripted selection sequence. */
async function runReviewSettings(
  rt: ToggleRuntime,
  selections: Array<string | undefined>,
): Promise<void> {
  const handler = rt.commands.get("review-settings");
  assert.ok(handler, "review-settings command is registered");
  let index = 0;
  await handler("", {
    scopedModels: [],
    ui: {
      async select(_title: string, options: string[]) {
        const value = selections[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      async input() { return undefined; },
      notify(message: string, type?: string) { rt.notices.push(type ? `${type}: ${message}` : message); },
    },
  });
}

interface ToggleRuntime {
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  notices: string[];
  followUps: Array<{ message: string; options: unknown }>;
  entries: Array<{ type: string; data: unknown }>;
  pi: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

/**
 * Minimal top-level runtime capturing every command. Without a session
 * identity (no appendEntry/sessionManager) no state store is created, so the
 * suite stays in-memory unless a test opts into persistence explicitly.
 */
function createToggleRuntime(cwd: string): ToggleRuntime {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notices: string[] = [];
  const followUps: Array<{ message: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
  };
  const ctx = { cwd, ui: { notify: (message: string) => notices.push(message) } };
  return { hooks, commands, notices, followUps, entries: [], pi, ctx };
}

/** Persistent variant bound to one conversation session file. */
function createPersistentToggleRuntime(sessionId: string, sessionFile: string, cwd: string): ToggleRuntime {
  const base = createToggleRuntime(cwd);
  base.pi.appendEntry = (type: string, data: unknown) => { base.entries.push({ type, data }); };
  base.ctx.sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getCwd: () => cwd,
  };
  return base;
}

async function writeToggleConfig(
  dir: string,
  review: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ invocationPath: string }> {
  const invocationPath = join(dir, "reviewer-invocations.txt");
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    externalAgents: agentCatalog(countingPassReviewer("fake", invocationPath)),
    review,
    ...extra,
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  return { invocationPath };
}

const FAKE_PRIMARY = [{ source: "external", id: "fake" }];

async function runTurn(
  rt: ToggleRuntime,
  dir: string,
  request: string,
  file: { name: string; content: string },
): Promise<void> {
  await trigger(rt.hooks, "input", { cwd: dir, text: request, source: "user" });
  await trigger(rt.hooks, "before_agent_start", { cwd: dir });
  await writeFile(join(dir, file.name), file.content, "utf8");
  await trigger(rt.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: `echo ${file.name}` } });
  await triggerAgentEnd(rt.hooks, {
    cwd: dir,
    messages: [{ role: "assistant", content: `completed: ${request}` }],
  });
}

function assertNoAutomaticReview(rt: ToggleRuntime): void {
  const text = rt.notices.join("\n");
  assert.doesNotMatch(text, /review gate: passed/);
  assert.doesNotMatch(text, /changes requested/);
  assert.doesNotMatch(text, /automatic review deferred/);
  assert.doesNotMatch(text, /no configured reviewer is currently available/);
  assert.equal(rt.followUps.length, 0);
}

test("primary off: turns settle without reviewers and the accumulated window serves /review-now", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-off-"));
  const sessionFile = join(dir, "conversation-a.jsonl");
  try {
    await writeFile(sessionFile, "", "utf8");
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    });

    const rt = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    await runTurn(rt, dir, "add the first file", { name: "a.ts", content: "one\n" });
    await runTurn(rt, dir, "add the second file", { name: "b.ts", content: "two\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);

    // Persisted state after two quick turns: the window is still open with its
    // original baseline and both exchanges settled — and no review history, so
    // no synthetic PASS was recorded.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const persisted = await store.restore(dir);
    assert.ok(persisted);
    const window = persisted.state.reviewWindow;
    assert.ok(window, "the review window stays open while automatic review is off");
    assert.ok(window.baseline, "the original baseline is preserved for accumulated review");
    assert.deepEqual(window.reviewHistory, [], "no synthetic PASS enters the persisted history");
    assert.equal(window.exchanges.length, 2);
    assert.equal(window.requestHistory.length, 2);

    // Manual /review-now runs the selected primary reviewers against every
    // change accumulated since the window baseline.
    await rt.commands.get("review-now")?.("", rt.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    assert.equal(rt.followUps.length, 1);
    const bundleDir = extractBundleDir(rt.followUps[0]?.message ?? "", 1);
    const patch = await readFile(join(bundleDir, "reviews", "0001", "patch.diff"), "utf8");
    assert.match(patch, /a\.ts/);
    assert.match(patch, /b\.ts/);
    // The second turn's input was processed normally (not stranded in the
    // queued-input ledger): it is part of the request context.
    const request = await readFile(join(bundleDir, "reviews", "0001", "request.md"), "utf8");
    assert.match(request, /add the first file/);
    assert.match(request, /add the second file/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("primary on: automatic review keeps its existing settlement behavior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-on-"));
  try {
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: true,
    });

    const rt = createToggleRuntime(dir);
    await activate(rt.pi);
    await runTurn(rt, dir, "make the change", { name: "index.ts", content: "changed\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    assert.equal(rt.followUps.length, 1);
    assert.match(rt.followUps[0]?.message ?? "", /Complete immutable pass evidence/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("both layers off: automatic primary review stays suppressed and manual review remains available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-both-off-"));
  try {
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
      subtaskEnabled: false,
    });

    const rt = createToggleRuntime(dir);
    await activate(rt.pi);
    await runTurn(rt, dir, "make the change", { name: "index.ts", content: "changed\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);

    // The selected reviewer set is still available to the manual command.
    await rt.commands.get("review-now")?.("", rt.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restoring with primary off preserves the open window and reviews accumulated changes manually", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-off-restore-"));
  const sessionFile = join(dir, "conversation-a.jsonl");
  try {
    await writeFile(sessionFile, "", "utf8");
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    });

    // Session 1: one turn settles without a reviewer and persists.
    const first = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await runTurn(first, dir, "implement the feature", { name: "a.ts", content: "one\n" });
    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(first);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // The persisted window carries the settled exchange and baseline, with no
    // review history entry of any kind.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const persisted = await store.restore(dir);
    assert.ok(persisted);
    assert.deepEqual(persisted.state.reviewWindow?.reviewHistory, []);
    assert.equal(persisted.state.reviewWindow?.exchanges.length, 1);
    assert.ok(persisted.state.reviewWindow?.baseline);

    // Session 2 resumes the same conversation: the window restores, a further
    // turn still settles without automatic review, and /review-now covers both
    // turns.
    const resumed = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /restored conversation state revision/);

    await runTurn(resumed, dir, "continue the feature", { name: "b.ts", content: "two\n" });
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(resumed);

    await resumed.commands.get("review-now")?.("", resumed.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(resumed.notices.join("\n"), /review gate: passed/);
    const bundleDir = extractBundleDir(resumed.followUps[0]?.message ?? "", 1);
    const patch = await readFile(join(bundleDir, "reviews", "0001", "patch.diff"), "utf8");
    assert.match(patch, /a\.ts/);
    assert.match(patch, /b\.ts/);
    await trigger(resumed.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, resumed.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("primary off: active background work neither defers review nor wakes the orchestrator", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-off-background-"));
  let background: ChildProcess | undefined;
  try {
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    });

    const rt = createToggleRuntime(dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "input", { cwd: dir, text: "make a background-assisted change", source: "user" });
    await trigger(rt.hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    background = spawn(process.execPath, ["-e", "setTimeout(()=>{},350)"], {
      detached: true,
      stdio: "ignore",
    });
    background.unref();
    assert.ok(background.pid);
    await trigger(rt.hooks, "tool_result", {
      cwd: dir,
      toolName: "ShellStart",
      result: { content: [{ type: "text", text: `Started "tests" as job1 (pid ${background.pid}); currently running.\nFuture wake triggers (not current events): exit.\nYou will be notified automatically; do not poll.` }] },
      isError: false,
    });
    await triggerAgentEnd(rt.hooks, { cwd: dir, messages: [{ role: "assistant", content: "background still running" }] });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    // No automatic review was scheduled, so nothing may be reported as
    // deferred or blocked on background readiness.
    assert.doesNotMatch(rt.notices.join("\n"), /automatic review deferred/);
    assert.doesNotMatch(rt.notices.join("\n"), /background readiness could not be verified/);

    // After the job exits, no completion wake may arrive either: there is no
    // deferred automatic review to resume.
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    assert.equal(rt.followUps.length, 0);
    assert.doesNotMatch(rt.notices.join("\n"), /previously blocked review reached an idle transition/);

    // A following turn settles normally and the manual command still works.
    await runTurn(rt, dir, "verify the background output", { name: "check.ts", content: "ok\n" });
    await rt.commands.get("review-now")?.("", rt.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    if (background?.pid) {
      try { process.kill(-background.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("toggling primary off mid-deferral keeps the completion wake and resumes without a reviewer", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-off-middeferral-"));
  let background: ChildProcess | undefined;
  try {
    // Primary starts ON so the deferral (and its completion wake) is armed by
    // the ordinary on-path settlement.
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: true,
    });

    const rt = createToggleRuntime(dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "input", { cwd: dir, text: "make a background-assisted change", source: "user" });
    await trigger(rt.hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    background = spawn(process.execPath, ["-e", "setTimeout(()=>{},400)"], {
      detached: true,
      stdio: "ignore",
    });
    background.unref();
    assert.ok(background.pid);
    await trigger(rt.hooks, "tool_result", {
      cwd: dir,
      toolName: "ShellStart",
      result: { content: [{ type: "text", text: `Started "tests" as job1 (pid ${background.pid}); currently running.\nFuture wake triggers (not current events): exit.\nYou will be notified automatically; do not poll.` }] },
      isError: false,
    });
    await triggerAgentEnd(rt.hooks, { cwd: dir, messages: [{ role: "assistant", content: "background still running" }] });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assert.match(rt.notices.join("\n"), /automatic review deferred while 1 background process group/);

    // The user turns automatic primary review off while the deferral is in
    // flight; the saved toggle takes effect on the live configuration.
    await runReviewSettings(rt, [
      rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
      reviewSettingsRow("Automatic primary review", "On"),
      "Back",
      "Save changes",
    ]);
    const saved = JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"));
    assert.equal(saved.review.primaryEnabled, false);

    // The completion wake still arrives once the job exits: it resumes the
    // unfinished original request even though automatic review is now off.
    await waitForCondition(() => rt.followUps.length === 1);
    assert.match(rt.followUps[0]?.message ?? "", /previously blocked review reached an idle transition/);
    assert.deepEqual(rt.followUps[0]?.options, { deliverAs: "followUp", triggerTurn: true });

    // The resumed turn settles through the off path: no reviewer runs.
    await trigger(rt.hooks, "before_agent_start", { cwd: dir });
    await triggerAgentEnd(rt.hooks, { cwd: dir, messages: [{ role: "assistant", content: "verified background output" }] });
    await assert.rejects(access(invocationPath), /ENOENT/);
    assert.doesNotMatch(rt.notices.join("\n"), /review gate: passed/);

    // The accumulated change is still available for the manual command.
    await rt.commands.get("review-now")?.("", rt.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    if (background?.pid) {
      try { process.kill(-background.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("master off with primary off: settlement preserves the window for reviewer questions exactly as before", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-master-off-"));
  const sessionFile = join(dir, "conversation-a.jsonl");
  try {
    await writeFile(sessionFile, "", "utf8");
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    }, { enabled: false });

    const rt = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
    await runTurn(rt, dir, "make the change", { name: "index.ts", content: "changed\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);

    // Same disposition as the master-off settlement on the on path: the window
    // is not kept open but moved to the reviewer-question slot.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const persisted = await store.restore(dir);
    assert.ok(persisted);
    assert.equal(persisted.state.reviewWindow, undefined);
    const questionWindow = persisted.state.lastQuestionWindow;
    assert.ok(questionWindow, "the window is preserved for reviewer questions");
    assert.ok(questionWindow.baseline);
    assert.deepEqual(questionWindow.reviewHistory, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted run with primary off leaves the window and its unsettled exchange intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-abort-off-"));
  const sessionFile = join(dir, "conversation-a.jsonl");
  try {
    await writeFile(sessionFile, "", "utf8");
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    });

    const rt = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
    await trigger(rt.hooks, "input", { cwd: dir, text: "make the change", source: "user" });
    await trigger(rt.hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "partial\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    await triggerAgentEnd(rt.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "interrupted" }],
      signal: controller.signal,
    });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);

    // Same disposition as the on path's abort branch: the window and its
    // baseline survive for the next turn, and the exchange is not settled.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const persisted = await store.restore(dir);
    assert.ok(persisted);
    const window = persisted.state.reviewWindow;
    assert.ok(window, "the aborted run's window survives for the next turn");
    assert.ok(window.baseline);
    assert.equal(window.exchanges.length, 0, "the abort skips exchange settlement exactly like the on path");
    assert.ok(window.activeExchange, "the active exchange stays open across the abort");
    assert.deepEqual(window.reviewHistory, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review-pause composes with primary off: exchanges still collect without a reviewer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-paused-off-"));
  const sessionFile = join(dir, "conversation-a.jsonl");
  try {
    await writeFile(sessionFile, "", "utf8");
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    });

    const rt = createPersistentToggleRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
    await rt.commands.get("review-pause")?.("", rt.pi);

    await runTurn(rt, dir, "first paused change", { name: "a.ts", content: "one\n" });
    await runTurn(rt, dir, "second paused change", { name: "b.ts", content: "two\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);

    // Pause semantics are preserved under the off path: every turn's exchange
    // is still collected and the window stays open, with no verdict recorded.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const persisted = await store.restore(dir);
    assert.ok(persisted);
    const window = persisted.state.reviewWindow;
    assert.ok(window, "the paused window stays open");
    assert.ok(window.baseline);
    assert.equal(window.exchanges.length, 2, "each turn's exchange is still collected while paused and off");
    assert.equal(window.activeExchange, undefined);
    assert.deepEqual(window.reviewHistory, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("primary off in execute mode: the shared primary reviewer set still gates manual review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-primary-off-execute-"));
  try {
    await writeToggleConfig(dir, {
      primaryReviewers: FAKE_PRIMARY,
      subtaskReviewers: FAKE_PRIMARY,
      primaryEnabled: false,
    }, { operatingMode: "execute" });

    const rt = createToggleRuntime(dir);
    await activate(rt.pi);
    await runTurn(rt, dir, "make the change", { name: "index.ts", content: "changed\n" });

    const invocationPath = join(dir, "reviewer-invocations.txt");
    await assert.rejects(access(invocationPath), /ENOENT/);
    assertNoAutomaticReview(rt);

    // The same primary reviewer set selected for orchestration serves the
    // manual command in execute mode.
    await rt.commands.get("review-now")?.("", rt.pi);
    assert.equal(await readFile(invocationPath, "utf8"), "1");
    assert.match(rt.notices.join("\n"), /review gate: passed/);

    // And /ask-reviewer consults the same selected set while automatic review
    // stays off.
    await rt.commands.get("ask-reviewer")?.("is this correct?", { isIdle: () => true, ui: { notify: (m: string) => rt.notices.push(m) } });
    assert.equal(await readFile(invocationPath, "utf8"), "2");
    const steer = rt.followUps.find((entry) => entry.options && (entry.options as { deliverAs?: string }).deliverAs === "steer");
    assert.ok(steer, "the reviewer answer is steered into the turn");
    assert.match(steer.message, /Reviewer note from \/ask-reviewer:/);
    await trigger(rt.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, rt.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
