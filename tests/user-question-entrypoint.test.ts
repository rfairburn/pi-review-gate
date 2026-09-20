import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";
import { setHostKeybindingLoader } from "../src/host-keybindings";
import { USER_QUESTION_STATUS_KEY, questionShortcutLabel } from "../src/user-question";

const indexTestConfig = {
  enabled: true,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
} as const;

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRuntimeRole: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  // Hermetic top-level surface: an inherited executor role would divert
  // activate() to the executor runtime branch (orchestrated workers set it).
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
  setHostKeybindingLoader(undefined);
});

interface EntrypointFixture {
  dir: string;
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: Map<string, any>;
  shortcuts: Map<string, { description?: string; handler: (ctx: unknown) => unknown }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  notices: string[];
  sent: Array<{ message: string; options?: unknown }>;
  sessionManager: object;
}

async function makeFixture(options: { withShortcutApi?: boolean } = {}): Promise<EntrypointFixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-questions-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ ...indexTestConfig, review: { activeReviewers: [] } }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;

  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const statuses: EntrypointFixture["statuses"] = [];
  const notices: string[] = [];
  const sent: EntrypointFixture["sent"] = [];
  const sessionManager = { id: "entrypoint-session" };
  const pi: Record<string, unknown> = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options?: unknown) { sent.push({ message, options }); return Promise.resolve(); },
    ui: {
      setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
    },
  };
  if (options.withShortcutApi !== false) {
    pi.registerShortcut = (shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) => {
      shortcuts.set(shortcut, options);
    };
  }
  await activate(pi);
  return { dir, hooks, tools, shortcuts, statuses, notices, sent, sessionManager };
}

async function trigger(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of hooks.get(name) ?? []) {
    await handler(...args);
  }
}

/** The interactive TUI host's session context — the only mode that accepts questions. */
function tuiContext(fixture: EntrypointFixture): Record<string, unknown> {
  return { cwd: fixture.dir, ui: {}, sessionManager: fixture.sessionManager, mode: "tui" };
}

test("activate registers AskUserQuestion and the pending-question shortcut", async () => {
  const fixture = await makeFixture();
  try {
    const tool = fixture.tools.get("AskUserQuestion");
    assert.ok(tool, "AskUserQuestion is registered at the top level");
    assert.equal(fixture.shortcuts.has("ctrl+alt+up"), true, "the approved chord is registered");
    const shortcut = fixture.shortcuts.get("ctrl+alt+up")!;
    assert.match(shortcut.description ?? "", /pending-question list/i);

    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));

    // A registered question updates the compact indicator.
    const result = await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((result.details as { status: string }).status, "pending");
    const indicator = [...fixture.statuses].reverse().find((entry) => entry.key === USER_QUESTION_STATUS_KEY);
    assert.ok(indicator, "the compact indicator is set");
    assert.match(indicator!.text ?? "", /1 pending question/);
    assert.ok(
      (indicator!.text ?? "").includes(questionShortcutLabel()),
      `the indicator names the approved chord: ${indicator!.text}`,
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the shortcut handler opens only for questions of its own session", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });

    // A stale context (another session's identity) must not open the list.
    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler;
    await handler({ ui: {}, sessionManager: { id: "other" } });
    assert.equal(fixture.sent.length, 0);
    assert.ok(!fixture.notices.some((notice) => /no pending questions/.test(notice)), "stale contexts are ignored silently");

    // The current session with no pending questions gets a notice instead of an empty list.
    await trigger(fixture.hooks, "session_shutdown", { cwd: fixture.dir }, tuiContext(fixture));
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    await handler({ ui: {}, sessionManager: fixture.sessionManager, isIdle: () => true });
    assert.ok(fixture.notices.some((notice) => /no pending questions/.test(notice)));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("an occupied chord is not registered and the tool fails closed", async () => {
  setHostKeybindingLoader(() => ({
    "app.message.dequeue": ["alt+up"],
    "some.builtin": ["ctrl+alt+up"],
  }));
  const fixture = await makeFixture();
  try {
    assert.equal(fixture.shortcuts.has("ctrl+alt+up"), false, "the colliding chord is never registered");
    assert.ok(fixture.notices.some((notice) => /pending-question shortcut/.test(notice) && /some\.builtin/.test(notice)));
    const tool = fixture.tools.get("AskUserQuestion");
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((result.details as { status: string; reason: string }).status, "rejected");
    assert.equal((result.details as { reason: string }).reason, "unavailable");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("hosts without the shortcut API keep the tool but fail closed per question", async () => {
  const fixture = await makeFixture({ withShortcutApi: false });
  try {
    assert.ok(fixture.tools.has("AskUserQuestion"));
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await fixture.tools.get("AskUserQuestion").execute(
      "c1",
      { question: "Which database?" },
      undefined,
      undefined,
      { sessionManager: fixture.sessionManager },
    );
    assert.equal((result.details as { status: string; reason: string }).status, "rejected");
    assert.equal((result.details as { reason: string }).reason, "unavailable");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("non-TUI host modes fail closed for every question, sync included", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const fixture = await makeFixture();
    try {
      assert.ok(fixture.tools.has("AskUserQuestion"), `${mode}: the tool still registers`);
      // The host exposes a session identity and UI surface, but not key input:
      // only mode "tui" may accept questions.
      const context = { cwd: fixture.dir, ui: {}, sessionManager: fixture.sessionManager, mode };
      await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, context);
      const tool = fixture.tools.get("AskUserQuestion");

      const asyncResult = await tool.execute(
        "c1",
        { question: "Which database?" },
        undefined,
        undefined,
        { sessionManager: fixture.sessionManager, mode },
      );
      assert.equal((asyncResult.details as { status: string }).status, "rejected", `${mode}: async`);
      assert.equal((asyncResult.details as { reason: string }).reason, "unavailable", `${mode}: async`);

      // A sync call must be rejected up front — never create a wait that no
      // one can ever answer or decline.
      const syncResult = await tool.execute(
        "c2",
        { question: "Which database?", mode: "sync" },
        undefined,
        undefined,
        { sessionManager: fixture.sessionManager, mode },
      );
      assert.equal((syncResult.details as { status: string }).status, "rejected", `${mode}: sync`);
      assert.equal((syncResult.details as { reason: string }).reason, "unavailable", `${mode}: sync`);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("session shutdown settles a pending sync question and clears the indicator", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    const running = tool.execute("c1", { question: "Which database?", mode: "sync" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    await trigger(fixture.hooks, "session_shutdown", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await running;
    assert.equal((result.details as { status: string }).status, "interrupted");
    const lastIndicator = [...fixture.statuses].reverse().find((entry) => entry.key === USER_QUESTION_STATUS_KEY);
    assert.equal(lastIndicator?.text, undefined, "the indicator is cleared for the settled session");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

function fakeKeybindings() {
  const bindings: Record<string, string[]> = {
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\x1b"],
  };
  return { matches(data: string, keybinding: string): boolean { return (bindings[keybinding] ?? []).includes(data); } };
}

/**
 * End-to-end through the production wiring: shortcut handler → ui.custom
 * factory → question list component → controller → host sendUserMessage.
 */
test("an answer submitted from the opened list is delivered through the host user-message path", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database?", choices: ["SQLite", "Postgres"] }, undefined, undefined, { sessionManager: fixture.sessionManager });

    let openedComponent: any;
    const custom = (factory: (...args: unknown[]) => unknown) => {
      openedComponent = factory({}, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, fakeKeybindings(), () => undefined);
      return Promise.resolve();
    };
    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler;
    // Busy at submission time → steering delivery.
    await handler({ ui: { custom }, sessionManager: fixture.sessionManager, isIdle: () => false });
    assert.ok(openedComponent, "the list component was opened through the factory");
    const rendered = openedComponent.render(80).join("\n");
    assert.match(rendered, /Pending questions \(1\)/);

    openedComponent.handleInput("\r"); // open answer view (first question selected)
    openedComponent.handleInput("\x1b[B"); // row 2: Postgres
    openedComponent.handleInput("\r"); // confirm the choice
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": Postgres/);
    assert.deepEqual(fixture.sent[0]!.options, { deliverAs: "steer" }, "busy delivery uses steering");

    // A second question answered while idle uses the plain path.
    await tool.execute("c2", { question: "Include raw counts?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    let openedSecond: any;
    const customSecond = (factory: (...args: unknown[]) => unknown) => {
      openedSecond = factory({}, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, fakeKeybindings(), () => undefined);
      return Promise.resolve();
    };
    await handler({ ui: { custom: customSecond }, sessionManager: fixture.sessionManager, isIdle: () => true });
    openedSecond.handleInput("\r"); // open answer view (no choices → Type row selected)
    openedSecond.handleInput("\r"); // start editing
    openedSecond.handleInput("yes");
    openedSecond.handleInput("\r"); // submit
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(fixture.sent.length, 2);
    assert.match(fixture.sent[1]!.message, /Answer to pending question "Include raw counts\?": yes/);
    assert.equal(fixture.sent[1]!.options, undefined, "idle delivery uses the plain path");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the shortcut label is platform-specific", () => {
  const label = questionShortcutLabel();
  assert.ok(["Ctrl+Alt+Up", "Ctrl+Option+Up"].includes(label));
});
