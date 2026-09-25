/**
 * Issue #26 follow-up: native absolute-path completion for every interactive
 * field presented through the shared host-wired native editor bridge
 * (src/native-editor-bridge.ts) — settings text fields of every kind and the
 * AskUserQuestion free-text row alike — plus the fail-closed submit-takeover
 * hardening.
 *
 * Three tiers:
 *
 * 1. Decorator contract (always runs): a scripted provider pins that every
 *    field wraps the host-provided autocomplete provider — first-line
 *    leading-slash tokens are forced to the provider's own file branch and
 *    their returned absolute prefix is masked with a same-length neutral
 *    sentinel — while relative/`~/@` tokens, command arguments, and later
 *    lines delegate untouched; the decoration is unconditional, with no
 *    per-field opt-in. No second completer or matcher: generation and
 *    application stay the wrapped provider's own code.
 * 2. Fail-closed takeover (always runs): a nonassignable onSubmit — or one
 *    whose setter silently no-ops — fails acquisition closed (no field
 *    presented, prior factory restored, no chat send) even with no live key
 *    matcher. The old degraded Enter-interception path could reach the host's
 *    chat submitter in exactly that situation; it is gone.
 * 3. Real-host integration (installed Pi; skipped unless resolvable, enforced
 *    via PI_REVIEW_GATE_REQUIRE_PI_HOST): `/`, `/se`, and nested absolute
 *    paths list filesystem entries in the ordinary file-list layout — never
 *    slash commands — in the Workspace field AND in non-Workspace settings
 *    text fields, Enter applies a visible path selection before submitting, a
 *    nonexistent absolute path shows no command suggestions and raw text is
 *    submitted verbatim, relative completion is unchanged, and the full
 *    /review-settings menu/Save flow stages a completed existing directory
 *    while rejecting a missing target or a file selected from the list.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  editTextWithNativeEditor,
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
} from "../src/native-editor-bridge";
import type { NativeEditorFieldUi, NativeEditorFactory } from "../src/native-editor-bridge";
import { createFakeMenuTuiHost, KEY_DOWN, KEY_ENTER } from "./menu-tui-fakes";
import {
  ENTER,
  ESCAPE,
  TAB,
  CTRL_U,
  REAL_IDENTITY_THEME,
  createBridgeUi,
  createFakeCustomEditorClass,
  createRealKeybindingsManager,
  fakeHost,
  fakeKeybindingsManager,
  loadRealBridgeHost,
  realHostAfter,
  settle,
  skipOrFail,
  typeText,
} from "./bridge-fakes";
import type { FakeBridgeEditor } from "./bridge-fakes";

// ---------------------------------------------------------------------------
// Tier 1: the field-scoped decorator contract (fake host, scripted provider)
// ---------------------------------------------------------------------------

interface ScriptedCall {
  force?: boolean;
  before: string;
}

/** A provider that records its request options and answers per branch. */
function scriptedProvider(): { provider: unknown; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
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
      return { items: [{ value: "review-settings", label: "review-settings" }], prefix: before };
    },
    applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
  };
  return { provider, calls };
}

async function openFakeField(
  options: { provider?: unknown } = {},
): Promise<{ instance: FakeBridgeEditor; result: Awaited<ReturnType<typeof editTextWithNativeEditor>> }> {
  const instances: FakeBridgeEditor[] = [];
  setNativeEditorHost(fakeHost(instances));
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    drivers: [(component) => component.handleInput?.(ENTER)],
  });
  const result = await editTextWithNativeEditor(ui, {
    title: "T",
    prefill: "",
  });
  return { instance: instances[0]!, result };
}

test("every field wraps the host provider: leading-slash tokens force the file branch and mask the prefix", async (t) => {
  const { provider, calls } = scriptedProvider();
  t.after(() => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });
  const { instance, result } = await openFakeField({ provider });
  assert.equal(result.kind, "value");

  const wrapped = instance.provider as {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<{ items: unknown[]; prefix: string } | null>;
  };
  assert.notEqual(wrapped, provider, "the host provider is wrapped, not used bare");

  // First-line leading-slash tokens (no space): forced to the file branch,
  // returned absolute prefix masked with a same-length neutral sentinel.
  const slash = await wrapped.getSuggestions(["/var"], 0, 4, { signal: new AbortController().signal });
  assert.equal(slash?.prefix, "\u0000var", "the leading / is masked (same length)");
  assert.deepEqual(calls.at(-1), { force: true, before: "/var" }, "the native file branch was forced");

  const nested = await wrapped.getSuggestions(["/var/log"], 0, 8, { signal: new AbortController().signal });
  assert.equal(nested?.prefix, "\u0000var/log", "nested absolute tokens are masked too");
  assert.deepEqual(calls.at(-1), { force: true, before: "/var/log" });

  // Everything else delegates untouched (no forced flag added, no masking).
  const relative = await wrapped.getSuggestions(["docs/"], 0, 5, { signal: new AbortController().signal });
  assert.equal(relative?.prefix, "docs/", "relative tokens are not masked");
  assert.equal(calls.at(-1)!.force, undefined, "relative tokens are not forced");

  const tilde = await wrapped.getSuggestions(["~/a"], 0, 3, { signal: new AbortController().signal });
  assert.equal(tilde?.prefix, "~/a", "tilde tokens are not masked");
  assert.equal(calls.at(-1)!.force, undefined, "tilde tokens are not forced");

  const argument = await wrapped.getSuggestions(["/model g"], 0, 8, { signal: new AbortController().signal });
  assert.equal(argument?.prefix, "/model g", "command-argument tokens keep their prefix");
  assert.equal(calls.at(-1)!.force, undefined, "command arguments are not forced");

  const laterLine = await wrapped.getSuggestions(["x", "/var"], 1, 4, { signal: new AbortController().signal });
  assert.equal(laterLine?.prefix, "/var", "later lines keep the host provider's own behavior");
  assert.equal(calls.at(-1)!.force, undefined, "later lines are not forced");

  // Re-wiring with an already-decorated provider must not double-wrap.
  instance.setAutocompleteProvider(wrapped);
  assert.equal(instance.provider, wrapped, "a decorated provider passes through unchanged");
});

test("a second field wraps the host provider too: the decoration is unconditional, with no opt-in switch", async (t) => {
  const { provider } = scriptedProvider();
  t.after(() => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });
  const { instance, result } = await openFakeField({ provider });
  assert.equal(result.kind, "value");
  assert.notEqual(instance.provider, provider, "wrapping needs no opt-in: every field is decorated");
  // A first-line leading-slash token routes to the file branch in a
  // non-Workspace field exactly as in the Workspace one.
  const wrapped = instance.provider as {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<{ items: unknown[]; prefix: string } | null>;
  };
  const slash = await wrapped.getSuggestions(["/se"], 0, 3, { signal: new AbortController().signal });
  assert.equal(slash?.prefix, "\u0000se", "the leading / is masked (same length)");
  assert.deepEqual(slash?.items, [{ value: "/var/", label: "var/" }], "the file branch answered, not the command branch");
});

// ---------------------------------------------------------------------------
// Tier 2: fail-closed submit takeover (fake host, exotic onSubmit surfaces)
// ---------------------------------------------------------------------------

/**
 * A hand-wired ui whose host editor exposes onSubmit through an accessor the
 * bridge cannot take over. `keybindings` is null on purpose: with no live key
 * matcher, the old degraded Enter-interception path could not have stopped a
 * chat send — acquisition must fail closed instead of presenting a field.
 */
function lockedSubmitUi(mode: "throw" | "silent"): {
  ui: NativeEditorFieldUi;
  chatSubmits: string[];
  slotFactory: () => unknown;
  customCalled: () => boolean;
} {
  const instances: FakeBridgeEditor[] = [];
  const Base = createFakeCustomEditorClass(instances);
  class LockedSubmitEditor extends Base {
    private chatSubmit?: (text: string) => void;
    constructor(tui: unknown, theme: unknown, keybindings: unknown) {
      super(tui, theme, keybindings);
      Object.defineProperty(this, "onSubmit", {
        get: (): ((text: string) => void) | undefined => this.chatSubmit,
        set: (_value: (text: string) => void): void => {
          if (mode === "throw") throw new Error("onSubmit is read-only on this host");
        },
        configurable: true,
      });
    }
  }
  const chatSubmits: string[] = [];
  let factory: NativeEditorFactory | undefined;
  let customWasCalled = false;
  const ui: NativeEditorFieldUi = {
    setEditorComponent(next: NativeEditorFactory | undefined): void {
      factory = next;
      if (!next) return;
      const editor = next({}, REAL_IDENTITY_THEME, null) as FakeBridgeEditor & { chatSubmit?: (text: string) => void };
      // The host exposes the chat submitter through the accessor's backing
      // property (its own wiring succeeded; only foreign assignments fail).
      editor.chatSubmit = (text: string) => chatSubmits.push(text);
    },
    getEditorComponent(): NativeEditorFactory | undefined {
      return factory;
    },
    custom: async (): Promise<string | undefined> => {
      customWasCalled = true;
      return "a field must not be presented";
    },
    notify(): void {},
  };
  setNativeEditorHost({ CustomEditor: LockedSubmitEditor as never });
  return { ui, chatSubmits, slotFactory: () => factory, customCalled: () => customWasCalled };
}

for (const mode of ["throw", "silent"] as const) {
  test(`a ${mode === "throw" ? "nonassignable" : "silently no-op'ing"} onSubmit fails acquisition closed with no key matcher and no chat send`, async (t) => {
    t.after(() => {
      setNativeEditorHost(undefined);
      __resetActiveNativeEditorFieldForTest();
    });
    const fixture = lockedSubmitUi(mode);

    const result = await editTextWithNativeEditor(fixture.ui, { title: "T", prefill: "p" });
    assert.deepEqual(result, { kind: "unavailable", reason: "the native submit path could not be taken over" });
    assert.equal(fixture.customCalled(), false, "no field was presented");
    // The no-chat-send guarantee follows from the refusal itself: with no
    // field presented, no user input can reach this instance. At the raw
    // instance level the hole is real — native Enter on an untaken-over
    // editor routes through the host wiring (chatSubmit) — which is exactly
    // why a failed takeover refuses the field instead of degrading to Enter
    // interception (the old path only intercepted while a live key matcher
    // existed, and this fixture has none).
    assert.equal(fixture.slotFactory(), undefined, "the prior (default) factory was restored");
    assert.deepEqual(fixture.chatSubmits, [], "no chat message was sent");
  });
}

// ---------------------------------------------------------------------------
// Tier 3: real-host integration (installed Pi's CustomEditor + pi-tui)
// ---------------------------------------------------------------------------

/** The host provider's command list for these tests — the leak sentinel. */
const HOST_COMMANDS = [
  { name: "review-settings", description: "Review gate settings" },
  { name: "settings", description: "Host settings" },
];

/** pi-tui CombinedAutocompleteProvider's public constructor surface. */
type HostProviderCtor = new (commands: Array<{ name: string; description?: string }>, basePath: string) => unknown;

/** The rendered frame with the hardware-cursor marker and ANSI styles stripped. */
function plainFrame(component: { render?(width: number): string[] }): string {
  return component
    .render!(200)
    .join("\n")
    .replace(/\x1b_pi:c\x07/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

async function makeAbsoluteFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-abs-ws-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  await writeFile(join(root, "guide.md"), "guide\n");
  return root;
}

test("real host: Workspace / lists filesystem directories, never slash commands", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    draft: "chat draft",
    drivers: [
      async (component) => {
        typeText(component, "/");
        await settle(300); // the natural trigger request completes
        const frame = component.render!(200).join("\n");
        assert.ok(
          /(^|\n)[ \t]*(→|  )\S+\//.test(frame),
          `a filesystem directory entry is listed: ${frame}`,
        );
        assert.ok(!frame.includes("review-settings"), `no slash-command item leaked: ${frame}`);
        assert.ok(!frame.includes("Review gate settings"), `no command description leaked: ${frame}`);
        component.handleInput?.(ESCAPE); // first Esc dismisses the list
        await settle();
        component.handleInput?.(ESCAPE); // second Esc cancels the field
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "cancel" });
});

test("real host: Workspace /subtasks (nonexistent) shows no command suggestions; Enter submits the raw text", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "/subtasks");
        await settle(300);
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("/subtasks"), `the typed token is the draft: ${frame}`);
        assert.ok(!frame.includes("review-settings"), `no slash-command item offered: ${frame}`);
        assert.ok(!frame.includes("Host settings"), `no command description offered: ${frame}`);
        assert.ok(!/(^|\n)[ \t]*→[ \t]/.test(frame), `no completion list is visible for a missing path: ${frame}`);
        component.handleInput?.(ENTER); // submits the raw text as the field value
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "/subtasks" });
});

test("real host: Workspace nested absolute path — Enter applies the visible selection, second Enter submits", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const root = await makeAbsoluteFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, root);
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, `${root}/a`);
        await settle(300);
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("alpha/"), `the matching directory is listed: ${frame}`);
        assert.ok(!frame.includes("review-settings"), `no slash-command item leaked: ${frame}`);
        component.handleInput?.(ENTER); // applies the visible selection — does not submit
        await settle(150);
        const applied = component.render!(200).join("\n");
        assert.ok(applied.includes(`${root}/alpha/`), `the selection was applied to the draft: ${applied}`);
        assert.ok(!/(^|\n)[ \t]*→[ \t]/.test(applied), `the list closed with the application: ${applied}`);
        component.handleInput?.(ENTER); // now the field submits
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: `${root}/alpha/` });
});

test("real host: `/se` in a non-Workspace settings field never lists slash commands and submits raw text", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "/se");
        await settle(300);
        const frame = plainFrame(component);
        assert.ok(frame.includes("/se"), `the typed token is the draft: ${frame}`);
        assert.ok(!frame.includes("review-settings"), `no slash-command item offered: ${frame}`);
        assert.ok(!frame.includes("Review gate settings"), `no command description offered: ${frame}`);
        assert.ok(!frame.includes("Host settings"), `no host command offered: ${frame}`);
        component.handleInput?.(ENTER); // submits the raw text as the field value
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Other field", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "/se" });
});

test("real host: `/` in a non-Workspace settings field lists filesystem entries, never slash commands", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, process.cwd());
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "/");
        await settle(300); // the natural trigger request completes
        const frame = plainFrame(component);
        assert.ok(
          /(^|\n)[ \t]*(→|  )\S+\//.test(frame),
          `a filesystem directory entry is listed in a non-Workspace field: ${frame}`,
        );
        assert.ok(!frame.includes("review-settings"), `no slash-command item leaked: ${frame}`);
        assert.ok(!frame.includes("Review gate settings"), `no command description leaked: ${frame}`);
        assert.ok(!frame.includes("Host settings"), `no host command leaked: ${frame}`);
        component.handleInput?.(ESCAPE);
        await settle();
        component.handleInput?.(ESCAPE);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Scheduled task name", prefill: "" });
  assert.deepEqual(result, { kind: "cancel" });
});

test("real host: native relative completion is unchanged in a non-Workspace field", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  realHostAfter(t);

  const root = await makeAbsoluteFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const provider = new (loaded.tui.CombinedAutocompleteProvider as HostProviderCtor)(HOST_COMMANDS, root);
  const { ui } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    provider,
    drivers: [
      async (component) => {
        typeText(component, "al");
        component.handleInput?.(TAB); // forced single-match auto-apply, exactly as in the chat editor
        await settle(300);
        const frame = component.render!(200).join("\n");
        assert.ok(frame.includes("alpha/"), `the relative completion applied natively: ${frame}`);
        component.handleInput?.(ENTER);
      },
    ],
  });

  const result = await editTextWithNativeEditor(ui, { title: "Workspace", prefill: "" });
  assert.deepEqual(result, { kind: "value", value: "alpha/" });
});

// ---------------------------------------------------------------------------
// Tier 3 (full flow): the real /review-settings menu and Save boundary
// ---------------------------------------------------------------------------

type FlowStep = (component: { render?(width: number): string[]; handleInput?(data: string): void }) => void | Promise<void>;

interface FlowHarness {
  ctx: unknown;
  notifyCalls: Array<{ message: string; type?: string }>;
  customCount(): number;
}

function flowHarness(
  steps: FlowStep[],
  options: { cwd?: string; keybindings?: unknown; theme?: unknown; provider?: unknown },
): FlowHarness {
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const { ui } = createBridgeUi({
    keybindings: options.keybindings ?? fakeKeybindingsManager(),
    theme: options.theme,
    provider: options.provider,
    draft: "chat draft",
    drivers: steps,
  });
  let customCount = 0;
  const wrapped = {
    ...ui,
    custom(factory: Parameters<NonNullable<typeof ui.custom>>[0]): Promise<string | undefined> {
      customCount += 1;
      return ui.custom!(factory);
    },
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
    async select(): Promise<string | undefined> {
      throw new Error("plain select must not be used in TUI mode with a loadable host");
    },
    async editor(): Promise<string | undefined> {
      throw new Error("the field used the embedded host editor, not a second draft");
    },
  };
  const ctx = {
    mode: "tui",
    scopedModels: [],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ui: wrapped,
  };
  return { ctx, notifyCalls, customCount: () => customCount };
}

const keys = (...sequence: string[]): FlowStep => (component) => {
  for (const key of sequence) component.handleInput?.(key);
};

async function writeFlowConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-abs-flow-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ scheduledTasks: { "task-abcdef12": { name: "Nightly check", cron: "30 2 * * *", enabled: true, kind: "execute", instructions: "Check the docs for staleness", workspace: dir } } }, null, 2));
  return { dir, configPath };
}

async function registerFlowCommand(configPath: string): Promise<(ctx: unknown) => Promise<void>> {
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(handler, "the /review-settings command registered");
  return (ctx) => handler!("", ctx);
}

test("real host: full flow stages a completed existing absolute directory through Save", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  setNativeEditorHost(loaded.host);
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  const root = await makeAbsoluteFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dir, configPath } = await writeFlowConfig();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = await registerFlowCommand(configPath);
  const providerCtor = loaded.tui.CombinedAutocompleteProvider as HostProviderCtor;

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.(CTRL_U); // clear the prefilled staged value
      typeText(component, `${root}/a`);
      await settle(300);
      const frame = component.render!(200).join("\n");
      assert.ok(frame.includes("alpha/"), `the existing directory is listed: ${frame}`);
      assert.ok(!frame.includes("review-settings"), `no slash-command item leaked: ${frame}`);
      component.handleInput?.(TAB); // apply the visible selection natively
      await settle(150);
      const applied = component.render!(200).join("\n");
      assert.ok(applied.includes(`${root}/alpha/`), `the completed path is the draft: ${applied}`);
      component.handleInput?.(ENTER); // submit the field
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
  ], { cwd: dir, keybindings: createRealKeybindingsManager(loaded.tui), theme: REAL_IDENTITY_THEME, provider: new providerCtor(HOST_COMMANDS, dir) });

  await run(harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, `${root}/alpha/`, "the completed directory is staged and saved");
});

for (const target of ["missing", "file"] as const) {
  test(`real host: full flow rejects a ${target} absolute target at Save`, async (t) => {
    const loaded = await loadRealBridgeHost();
    if (!loaded) {
      skipOrFail(t, "no installed Pi is resolvable in this environment");
      return;
    }
    setNativeEditorHost(loaded.host);
    const menuHost = createFakeMenuTuiHost();
    setMenuTuiHost(menuHost);
    t.after(() => {
      setMenuTuiHost(undefined);
      setNativeEditorHost(undefined);
      __resetActiveNativeEditorFieldForTest();
    });

    const root = await makeAbsoluteFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const { dir, configPath } = await writeFlowConfig();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const before = await readFile(configPath, "utf8");
    const run = await registerFlowCommand(configPath);
    const providerCtor = loaded.tui.CombinedAutocompleteProvider as HostProviderCtor;

    const harness = flowHarness([
      keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
      keys(KEY_ENTER), // list → task entry (row 0)
      keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
      async (component) => {
        component.handleInput?.(CTRL_U); // clear the prefilled staged value
        if (target === "missing") {
          typeText(component, `${root}/missing-dir`);
          await settle(300);
          const frame = component.render!(200).join("\n");
          assert.ok(!/(^|\n)[ \t]*→[ \t]/.test(frame), `no list for a missing target: ${frame}`);
        } else {
          typeText(component, `${root}/gui`);
          await settle(300);
          const frame = component.render!(200).join("\n");
          assert.ok(frame.includes("guide.md"), `the file is selectable from the native list: ${frame}`);
          component.handleInput?.(TAB); // select the file from the list
          await settle(150);
        }
        component.handleInput?.(ENTER); // submit the field
      },
      keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
      keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
      keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
      keys(ESCAPE), // failed save re-shows the root menu; Esc leaves without saving
    ], { cwd: dir, keybindings: createRealKeybindingsManager(loaded.tui), theme: REAL_IDENTITY_THEME, provider: new providerCtor(HOST_COMMANDS, dir) });

    await run(harness.ctx);

    assert.ok(
      harness.notifyCalls.some((call) => call.type === "error" && /not an existing directory/.test(call.message)),
      `Save validation rejected the ${target} target: ${JSON.stringify(harness.notifyCalls)}`,
    );
    assert.equal(await readFile(configPath, "utf8"), before, "the config file is byte-unchanged after a failed save");
  });
}
