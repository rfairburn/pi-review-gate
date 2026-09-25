/**
 * The shared native text field seam (src/native-text-field.ts) for every
 * extension-owned interactive TUI text field outside /review-settings and
 * AskUserQuestion (issue #26): the staged subtask form (title, instructions,
 * acceptance criteria, relevant context, target workspace), the no-argument
 * steering instruction, and the private reviewer answer editor.
 *
 * Two tiers, mirroring the bridge test split:
 *
 * 1. Wiring tier (always runs, fake host): in an interactive TUI (mode
 *    "tui") these fields open through the same host-wired native editor
 *    bridge — never `ui.editor`/`ui.input` — with the shared leading-`/`
 *    file routing (a `/se` token forces the provider's file branch, and no
 *    slash-command item can appear or execute); submitted raw text stages or
 *    steers verbatim. On non-interactive hosts the public chains are
 *    preserved exactly: the multi-line editor first for the staged form, the
 *    input-first chain (editor behind a cancelled input) for steering, and
 *    the reviewer answer notice delivery when the TUI's native seams are
 *    unavailable.
 *
 * 2. Real-host tier (installed Pi; skip-or-fail via
 *    PI_REVIEW_GATE_REQUIRE_PI_HOST): `/se` in the staged subtask form's Task
 *    title field and in the steering instruction field never lists slash
 *    commands — the forced file branch normally answers nothing for `/se`,
 *    and these tests pin no slash-command items plus raw-text
 *    staging/steering regardless of what the file branch returns. The
 *    positive filesystem listing for a leading-`/` token in a non-Workspace
 *    field is pinned in tests/native-editor-absolute-workspace.test.ts (for
 *    `/`).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import { registerCommands } from "../src/commands";
import type { ReviewGateConfig } from "../src/config";
import {
  ENTER,
  REAL_IDENTITY_THEME,
  createBridgeUi,
  createRealKeybindingsManager,
  fakeHost,
  fakeKeybindingsManager,
  loadRealBridgeHost,
  realHostAfter,
  settle,
  skipOrFail,
  typeText,
} from "./bridge-fakes";
import type { BridgeComponent } from "./bridge-fakes";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import type { NativeEditorFieldUi } from "../src/native-editor-bridge";

// ---------------------------------------------------------------------------
// Shared execution-command harness (mirrors the subtask-command tests)
// ---------------------------------------------------------------------------

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

function executionTool(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

function executionHarness(options: { slowExecutor?: boolean } = {}) {
  const tools: Array<Record<string, any>> = [];
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand(name: string, commandOptions: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandlers.set(name, commandOptions.handler);
    },
    setToolActive() {},
    getActiveTools: () => ["read", "bash"],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "fake": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1" as const,
          args: options.slowExecutor
            ? ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"]
            : undefined,
        },
      },
    },
    execution: {
      deferredPiTools: undefined,
      workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 4 } },
      routes: {
        execute: [{ resourceId: "default" }],
        research: [],
      },
    },
    ui: { subtasksViewExpanded: false },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: () => {},
  });
  manager.sync();
  return { tools, commandHandlers, manager };
}

async function cleanup(manager: ExecutionToolManager, roots: string[]): Promise<void> {
  await manager.shutdown();
  await manager.detach();
  for (const root of roots) await rm(root, { recursive: true, force: true });
}

function executionIdOf(message: string | undefined): string {
  const match = message?.match(/exec-[0-9a-f-]+/);
  assert.ok(match, `expected an execution handle in: ${message}`);
  return match[0]!;
}

function taskIdOf(message: string | undefined, index: number): string {
  const matches = message?.match(/task-[0-9a-f-]+/g) ?? [];
  assert.ok(matches.length > index, `expected task handle ${index} in: ${message}`);
  return matches[index]!;
}

/**
 * A TUI-mode command context UI around the shared bridge simulator:
 * select/confirm are scripted by title (defaulting to the first option), and
 * every text field opens through the host-wired native editor bridge —
 * ui.editor/ui.input throw, so the seam must never be used in TUI mode.
 */
function tuiBridgeUi(
  options: {
    keybindings?: unknown;
    provider?: unknown;
    theme?: unknown;
    drivers: Array<(component: BridgeComponent) => void | Promise<void>>;
    selectAnswers?: Record<string, string>;
  },
): NativeEditorFieldUi & { select(title: string, options: string[]): Promise<string | undefined>; confirm(title: string, message: string): Promise<boolean | undefined> } {
  const { ui } = createBridgeUi({
    keybindings: options.keybindings ?? fakeKeybindingsManager(),
    theme: options.theme,
    provider: options.provider,
    drivers: options.drivers,
  });
  return {
    ...ui,
    // The seam must never fall back to these in TUI mode; they exist only so
    // the command-level availability checks (input or editor) pass.
    input: async (title: string) => {
      throw new Error(`ui.input must not be used in TUI mode: ${title}`);
    },
    editor: async (title: string) => {
      throw new Error(`ui.editor must not be used in TUI mode: ${title}`);
    },
    select: async (_title: string, choices: string[]) => options.selectAnswers?.[choices[0] ?? ""] ?? undefined,
    confirm: async () => true,
  } as never;
}

/**
 * The host provider's command list for these tests — the leak sentinel: no
 * leading-slash field may ever render one of these names or descriptions.
 */
const HOST_COMMANDS = [
  { name: "settings", description: "Host settings" },
  { name: "session", description: "Session commands" },
  { name: "subtasks", description: "Background subtasks" },
  { name: "review-settings", description: "Review gate settings" },
];

/** pi-tui CombinedAutocompleteProvider's public constructor surface. */
type HostProviderCtor = new (commands: Array<{ name: string; description?: string }>, basePath: string) => unknown;

// ---------------------------------------------------------------------------
// Tier 1: wiring (fake host)
// ---------------------------------------------------------------------------

test("TUI staged subtask form opens the shared native field; a `/se` token routes to the file branch and stages raw text", async (t) => {
  const instances: any[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { tools, commandHandlers, manager } = executionHarness({ slowExecutor: true });
  let root: string | undefined;
  t.after(async () => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
    await cleanup(manager, root ? [root] : []);
  });

  // A provider that answers its command branch unless the file branch is forced.
  const calls: Array<{ force?: boolean; before: string }> = [];
  const provider = {
    getSuggestions: async (
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ) => {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      calls.push({ force: options.force, before });
      if (options.force) return { items: [{ value: "/var/", label: "var/" }], prefix: before };
      return { items: [{ value: "settings", label: "settings" }], prefix: before };
    },
    applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
  };

  const selectAnswers: Record<string, string> = {};
  const ui = tuiBridgeUi({
    keybindings: fakeKeybindingsManager(),
    provider,
    drivers: [
      async (component) => {
        // Task title: the screenshot token `/se`.
        typeText(component, "/se");
        await settle(60);
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("/se"), `the token is the draft: ${frame}`);
        assert.ok(!frame.includes("settings"), `no slash-command item is rendered: ${frame}`);
        component.handleInput?.(ENTER); // stage the raw token as the title
      },
      async (component) => {
        typeText(component, "Check the docs");
        await settle(10);
        component.handleInput?.(ENTER); // Task instructions
      },
      async (component) => {
        typeText(component, "done");
        await settle(10);
        component.handleInput?.(ENTER); // Acceptance criteria
      },
      async (component) => {
        component.handleInput?.(ENTER); // Relevant context: left blank
      },
      async (component) => {
        component.handleInput?.(ENTER); // Target workspace: left blank (session cwd)
      },
    ],
  });

  // Scripted selects keyed by the first option they should accept.
  const scripted = {
    ...ui,
    select: async (_title: string, choices: string[]) => {
      const answer = choices[0];
      if (answer) selectAnswers[answer] = answer;
      return answer;
    },
    confirm: async () => true,
  };

  let notice = "";
  const ctxUi = {
    ...scripted,
    notify(message: string): void {
      notice = message;
    },
  };
  await commandHandlers.get("subtask-add")!("", { mode: "tui", ui: ctxUi });

  assert.match(notice, /execute group exec-/);
  const executionId = executionIdOf(notice);
  const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  const inspection = (await inspect("form-tui-inspect", { executionId, taskId: taskIdOf(notice, 0) }, undefined, undefined, {})).details as any;
  assert.equal(inspection.tasks[0]?.definition?.title, "/se", "the raw token was staged as the title");
  assert.equal(inspection.tasks[0]?.definition?.instructions, "Check the docs");
  assert.deepEqual(inspection.tasks[0]?.definition?.acceptanceCriteria, ["done"]);
  assert.equal(inspection.tasks[0]?.definition?.relevantContext, undefined);
  root = inspection.root as string;
  // The field-scoped decorator forced the host provider's own file branch for
  // the leading-slash token and masked its returned prefix; the command branch
  // was never consulted for `/se`.
  const wrapped = instances[0]?.provider as {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<{ items: unknown[]; prefix: string } | null>;
  };
  assert.notEqual(wrapped, provider, "the field editor wraps the host provider");
  const slash = await wrapped.getSuggestions(["/se"], 0, 3, { signal: new AbortController().signal });
  assert.equal(slash?.prefix, "\u0000se", "the leading / is masked (same length)");
  assert.deepEqual(slash?.items, [{ value: "/var/", label: "var/" }], "the file branch answered, not the command branch");
  const titleCall = calls.find((call) => call.before === "/se");
  assert.ok(titleCall, "the leading-slash token reached the provider");
  assert.equal(titleCall?.force, true, "the file branch was forced (never the command branch)");
  assert.equal(calls.filter((call) => call.force !== true && call.before === "/se").length, 0, "the command branch was never consulted for `/se`");
});

test("non-TUI staged subtask form keeps the editor/input chain; the bridge is never opened", async (t) => {
  const instances: any[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { tools, commandHandlers, manager } = executionHarness({ slowExecutor: true });
  let root: string | undefined;
  t.after(async () => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
    await cleanup(manager, root ? [root] : []);
  });

  const prompts: string[] = [];
  let notice = "";
  const ui = {
    select: async (title: string, choices: string[]) => {
      prompts.push(`select:${title}`);
      return title === "Submit a subtask" ? "Create a new execution group" : title === "Execution kind" ? "execute" : choices[0];
    },
    confirm: async (): Promise<boolean> => true,
    editor: async (title: string, prefill?: string) => {
      prompts.push(`editor:${title}:${prefill ?? ""}`);
      if (title === "Task title") return "/se";
      if (title === "Task instructions") return "Check the docs";
      if (title === "Acceptance criteria (one per line)") return "done";
      return "";
    },
    input: async (title: string) => {
      prompts.push(`input:${title}`);
      throw new Error("input must not be used while an editor exists");
    },
    notify(message: string): void {
      notice = message;
    },
  };

  await commandHandlers.get("subtask-add")!("", { mode: "rpc", ui });
  assert.match(notice, /execute group exec-/);
  const executionId = executionIdOf(notice);
  const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  const inspection = (await inspect("form-rpc-inspect", { executionId, taskId: taskIdOf(notice, 0) }, undefined, undefined, {})).details as any;
  assert.equal(inspection.tasks[0]?.definition?.title, "/se");
  assert.ok(prompts.some((entry) => entry.startsWith("editor:Task title")), `the editor chain was used: ${prompts.join(", ")}`);
  assert.ok(!prompts.some((entry) => entry.startsWith("input:")), "the editor-first chain is preserved");
  root = inspection.root as string;
});

test("steering keeps the input-first chain on non-interactive hosts; a cancelled input falls through to the editor", async (t) => {
  const { tools, commandHandlers, manager } = executionHarness({ slowExecutor: true });
  let root: string | undefined;
  t.after(async () => cleanup(manager, root ? [root] : []));

  let notice = "";
  const startUi = {
    select: async () => undefined,
    notify(message: string): void {
      notice = message;
    },
  };
  await commandHandlers.get("subtask-add")!("Survey the recovery docs", { ui: startUi });
  assert.match(notice, /execute group exec-/);
  const executionId = executionIdOf(notice);
  const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  const inspection = (await inspect("steer-before", { executionId, taskId: taskIdOf(notice, 0) }, undefined, undefined, {})).details as any;
  const taskId = inspection.tasks[0]?.taskId as string;
  root = inspection.root as string;

  const prompts: string[] = [];
  const steerUi = {
    select: async (_title: string, choices: string[]) => choices[0],
    input: async (title: string) => {
      prompts.push(`input:${title}`);
      return undefined; // cancelled input: the pre-bridge chain opens the editor
    },
    editor: async (title: string, prefill?: string) => {
      prompts.push(`editor:${title}:${prefill ?? ""}`);
      return "Focus on the docs directory";
    },
    notify(): void {},
  };
  await commandHandlers.get("subtask-steer")!("", { ui: steerUi });
  const after = (await inspect("steer-after", { executionId, taskId }, undefined, undefined, {})).details as any;
  assert.ok(
    (after.tasks[0]?.commands ?? []).some((command: any) => command.action === "steer" && /Focus on the docs directory/.test(String(command.text))),
    `the steered instruction was queued: ${JSON.stringify(after.tasks[0]?.commands)}`,
  );
  assert.deepEqual(prompts, ["input:Steering instruction", "editor:Steering instruction:"], "input first, editor behind the cancelled input");
});

// ---------------------------------------------------------------------------
// Reviewer answer editor (commands.ts) — wiring tier
// ---------------------------------------------------------------------------

function askReviewerConfig(): ReviewGateConfig {
  return {
    enabled: true,
    review: {
      activeReviewers: [{ source: "external", id: "fake" }],
    },
    externalAgents: {
      "fake": {
        adapter: "generic-cli",
        command: process.execPath,
        args: [],
        review: {
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "let s='';",
              "process.stdin.on('data',c=>s+=c);",
              "process.stdin.on('end',()=>{",
              "const ok=s.includes('Reviewer question:')&&s.includes('does this plan look right?');",
              "process.stdout.write(JSON.stringify(ok",
              "?{verdict:'pass',summary:'reviewer answer ready',guidance:'Answer:\\n\\n```ts\\nconst ready = true;\\n```',findings:[]}",
              ":{verdict:'needs_changes',summary:'question text was not passed through',findings:[]}));",
              "});",
            ].join(""),
          ],
          timeoutMs: 15000,
        },
      },
    },
  } as unknown as ReviewGateConfig;
}

async function askReviewerHarness() {
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const userMessages: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(message: string) {
      userMessages.push(message);
    },
  };
  const state = createState();
  const dir = await mkdtempForReview();
  registerCommands({
    pi,
    cwd: () => dir,
    config: askReviewerConfig(),
    state,
  } as never);
  return { commands, userMessages, state, dir };
}

async function mkdtempForReview(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "prg-native-field-review-"));
}

test("TUI reviewer answer opens through the bridge with the answer as prefill; Enter submits it, never ui.editor", async (t) => {
  const instances: any[] = [];
  setNativeEditorHost(fakeHost(instances));
  const harness = await askReviewerHarness();
  t.after(async () => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
    await rm(harness.dir, { recursive: true, force: true });
  });

  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    drivers: [
      async (component) => {
        const frame = component.render!(200).join("\n");
        assert.match(frame, /reviewer answer ready/, `the answer is the editable prefill: ${frame}`);
        component.handleInput?.(ENTER); // submit the prefilled answer unchanged
      },
    ],
  });
  const editorCalls: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      ...ui,
      // The seam must be used instead of the editor in TUI mode.
      editor: async (title: string) => {
        editorCalls.push(title);
        return undefined;
      },
    },
  };

  await harness.commands.get("ask-reviewer-interactive")?.("does this plan look right?", ctx);
  assert.deepEqual(editorCalls, [], "the bridge field was used, not ui.editor");
  assert.equal(harness.userMessages.length, 1, "the submitted answer was steered into the turn");
  assert.match(harness.userMessages[0] ?? "", /reviewer answer ready/);
});

test("TUI reviewer answer with unavailable native seams fails closed to the notice delivery; never a fallback editor", async (t) => {
  const instances: any[] = [];
  setNativeEditorHost(fakeHost(instances));
  const harness = await askReviewerHarness();
  t.after(async () => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
    await rm(harness.dir, { recursive: true, force: true });
  });

  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify(message: string): void {
        notices.push(message);
      },
    },
  };

  await harness.commands.get("ask-reviewer-interactive")?.("does this plan look right?", ctx);
  assert.equal(harness.userMessages.length, 0, "nothing was steered: no field was presented");
  assert.match(notices.join("\n"), /reviewer answer ready/, `the answer text was delivered as the existing notice: ${notices.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// Tier 2: real host (installed Pi's CustomEditor + pi-tui)
// ---------------------------------------------------------------------------

test("real host: staged subtask form Task title `/se` never lists slash commands and stages raw text", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);
  const { tools, commandHandlers, manager } = executionHarness({ slowExecutor: true });
  let root: string | undefined;
  t.after(async () => cleanup(manager, root ? [root] : []));

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const selectAnswers: Record<string, string> = {};
  let notice = "";
  const ui = tuiBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "/se");
        await settle(300); // the natural trigger request completes
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("/se"), `the typed token is the draft: ${frame}`);
        assert.ok(!frame.includes("review-settings"), `no review-settings command offered: ${frame}`);
        assert.ok(!frame.includes("Host settings"), `no host command offered: ${frame}`);
        assert.ok(!frame.includes("Session commands"), `no session command offered: ${frame}`);
        assert.ok(!frame.includes("Background subtasks"), `no subtasks command offered: ${frame}`);
        component.handleInput?.(ENTER); // stage the raw token as the title
      },
      async (component) => {
        typeText(component, "Check the docs");
        await settle(10);
        component.handleInput?.(ENTER); // Task instructions
      },
      async (component) => {
        typeText(component, "done");
        await settle(10);
        component.handleInput?.(ENTER); // Acceptance criteria
      },
      async (component) => {
        component.handleInput?.(ENTER); // Relevant context: left blank
      },
      async (component) => {
        component.handleInput?.(ENTER); // Target workspace: left blank (session cwd)
      },
    ],
  });

  const scripted = {
    ...ui,
    select: async (_title: string, choices: string[]) => {
      const answer = choices[0];
      if (answer) selectAnswers[answer] = answer;
      return answer;
    },
    confirm: async () => true,
    notify(message: string): void {
      notice = message;
    },
  };

  await commandHandlers.get("subtask-add")!("", { mode: "tui", ui: scripted });
  assert.match(notice, /execute group exec-/, `the group was started: ${notice}`);
  const executionId = executionIdOf(notice);
  const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  const inspection = (await inspect("form-real-inspect", { executionId, taskId: taskIdOf(notice, 0) }, undefined, undefined, {})).details as any;
  assert.equal(inspection.tasks[0]?.definition?.title, "/se", "the raw token was staged through the real host editor");
  root = inspection.root as string;
});

test("real host: steering instruction `/se` never lists slash commands and steers raw text", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);
  const { tools, commandHandlers, manager } = executionHarness({ slowExecutor: true });
  let root: string | undefined;
  t.after(async () => cleanup(manager, root ? [root] : []));

  let notice = "";
  await commandHandlers.get("subtask-add")!("Survey the recovery docs", { ui: { select: async () => undefined, notify(message: string): void { notice = message; } } });
  assert.match(notice, /execute group exec-/);
  const executionId = executionIdOf(notice);
  const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
  const before = (await inspect("steer-before", { executionId, taskId: taskIdOf(notice, 0) }, undefined, undefined, {})).details as any;
  const taskId = before.tasks[0]?.taskId as string;
  root = before.root as string;

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const ui = tuiBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "/se");
        await settle(300);
        const frame = component.render!(200).join("\n");
        assert.ok(!frame.includes("review-settings"), `no slash-command item offered: ${frame}`);
        assert.ok(!frame.includes("Host settings"), `no host command offered: ${frame}`);
        component.handleInput?.(ENTER); // steer the raw token
      },
    ],
  });
  const steerCtx = {
    mode: "tui",
    ui: {
      ...ui,
      select: async (_title: string, choices: string[]) => choices[0],
      notify(): void {},
    },
  };
  await commandHandlers.get("subtask-steer")!("", steerCtx);

  const after = (await inspect("steer-after", { executionId, taskId }, undefined, undefined, {})).details as any;
  assert.ok(
    (after.tasks[0]?.commands ?? []).some((command: any) => command.action === "steer" && String(command.text) === "/se"),
    `the steered instruction landed: ${JSON.stringify(after.tasks[0]?.commands)}`,
  );
});