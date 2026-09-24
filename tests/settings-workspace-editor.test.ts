/**
 * Issue #26: the scheduled-task workspace directory field.
 *
 * Pins the one bespoke settings surface: in an interactive TUI where the host
 * pi-tui `Editor` is embeddable, the field shows that editor — created via the
 * shared host-agnostic adapter and peer loader — prefilled with the staged
 * workspace, with a minimal directory-only Tab autocomplete provider attached
 * through the public `setAutocompleteProvider` seam:
 *
 * - Only `/...` and `~`/`~/...` tokens complete; directories only (symlinks
 *   to directories count, files and broken links never); `~/` stays displayed
 *   while expansion happens only for filesystem lookup.
 * - The editor is the single draft: prefill via setText, submit resolves with
 *   the editor's own text, Esc cancels, exactly one settle.
 * - No usable custom surface (no Editor class, no terminal geometry, no
 *   `custom` at all) degrades to the public `ui.editor` prefill, then the
 *   legacy `ui.input`; host-load failures fail closed into that chain.
 * - Invalid directories are not silently accepted: completion is a
 *   convenience and Save-time validation remains the authority.
 *
 * Real-host tests drive the installed Pi's actual pi-tui Editor (skipped when
 * the peer is unresolvable in this environment). They verify Tab completion
 * of real directories, including `~/` display preservation. What they cannot
 * verify headlessly: a human watching the box render, and Ctrl+G external
 * editing — that control belongs to the host's own editor surface (the public
 * `ui.editor` path for ordinary fields), asserted at the seam level in
 * settings-text-fields.test.ts.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostEditorProvider } from "../src/host-editor";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  createDirectoryAutocompleteProvider,
  createWorkspaceEditorComponent,
  editWorkspaceDirectory,
  setWorkspaceEditorTuiHost,
  WORKSPACE_EDITOR_HINT,
  WORKSPACE_EDITOR_TITLE,
} from "../src/settings/workspace-editor";
import { createFakeMenuTuiHost, IDENTITY_THEME, KEY_DOWN, KEY_ENTER, loadRealPiTuiModule } from "./menu-tui-fakes";

const GEOMETRY_TUI = { terminal: { rows: 40 }, requestRender(): void {} };
const signal = (): AbortSignal => new AbortController().signal;
async function settle(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider unit tests (real temp directories; `~` via the homeDir seam)
// ---------------------------------------------------------------------------

test("directory provider completes only existing directories for / and ~ tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ws-prov-"));
  const home = join(root, "home");
  await mkdir(join(home, "beta", "inner"), { recursive: true });
  await mkdir(join(home, "berlin"), { recursive: true });
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "gamma", "inner"), { recursive: true });
  await writeFile(join(root, "file.txt"), "");
  await symlink(join(root, "alpha"), join(root, "link-to-alpha"));
  await symlink("no-such-target-anywhere", join(root, "broken"));

  const provider = createDirectoryAutocompleteProvider({ homeDir: () => home });
  const values = (result: Awaited<ReturnType<typeof provider.getSuggestions>>): string[] | null =>
    result ? result.items.map((item) => item.value) : null;

  // Absolute token: prefix-filtered, directories only, trailing slash.
  assert.deepEqual(values(await provider.getSuggestions([`${root}/a`], 0, `${root}/a`.length, { signal: signal() })), [`${root}/alpha/`]);

  // Directory listing at the token's parent: symlinks to directories count;
  // files and broken links never do.
  assert.deepEqual(values(await provider.getSuggestions([`${root}/`], 0, `${root}/`.length, { signal: signal() })), [
    `${root}/alpha/`,
    `${root}/gamma/`,
    `${root}/home/`,
    `${root}/link-to-alpha/`,
  ]);

  // `~/...` keeps the user's spelling in the suggestions; lookup expands.
  assert.deepEqual(values(await provider.getSuggestions(["~/be"], 0, 4, { signal: signal() })), ["~/berlin/", "~/beta/"]);
  assert.equal((await provider.getSuggestions(["~/be"], 0, 4, { signal: signal() }))?.prefix, "~/be");

  // Bare `~` and `~/` list the home directory; no doubled slashes.
  assert.deepEqual(values(await provider.getSuggestions(["~"], 0, 1, { signal: signal() })), ["~/berlin/", "~/beta/"]);
  assert.deepEqual(values(await provider.getSuggestions(["~/"], 0, 2, { signal: signal() })), ["~/berlin/", "~/beta/"]);

  // Nested `~/...` keeps the tilde spelling at every depth, not just level 1.
  assert.deepEqual(values(await provider.getSuggestions(["~/beta/i"], 0, 8, { signal: signal() })), ["~/beta/inner/"]);

  // Root-parented tokens stay absolute: a suggestion must never rewrite an
  // entered `/...` token into a relative one (e.g. /Users + Tab → Users/).
  const rootItems = await provider.getSuggestions(["/"], 0, 1, { signal: signal() });
  assert.ok(rootItems && rootItems.items.length > 0, "the filesystem root yields directory suggestions");
  assert.ok(
    rootItems!.items.every((item) => item.value.startsWith("/")),
    `root-parented suggestions stay absolute: ${JSON.stringify(rootItems!.items.slice(0, 3))}`,
  );

  // A prefixed root token (first letter of a real root-level directory) filters
  // but still yields only absolute spellings.
  const realRootDirs = (await readdir("/", { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(realRootDirs.length > 0, "the filesystem root has directories");
  const prefix = realRootDirs[0]!.charAt(0);
  const prefixedRoot = await provider.getSuggestions([`/${prefix}`], 0, `${prefix}`.length + 1, { signal: signal() });
  assert.ok(prefixedRoot, `prefixed root token yields suggestions: /${prefix}`);
  assert.ok(
    prefixedRoot!.items.every((item) => item.value.startsWith("/")),
    `prefixed root-parented suggestions stay absolute: ${JSON.stringify(prefixedRoot!.items.slice(0, 3))}`,
  );

  // Non-path tokens are never completed (no cwd anchoring for relatives).
  assert.equal(await provider.getSuggestions(["hello world"], 0, 11, { signal: signal() }), null);
  assert.equal(await provider.getSuggestions(["relative/dir"], 0, 14, { signal: signal() }), null);
  assert.equal(await provider.getSuggestions([""], 0, 0, { signal: signal() }), null);

  // `~user`-style spellings are not completable: the shared path rule leaves
  // them literal, so they must never anchor a readdir at the process cwd.
  assert.equal(await provider.getSuggestions(["~user"], 0, 5, { signal: signal() }), null);
  assert.equal(provider.shouldTriggerFileCompletion?.(["~user"], 0, 5), false);

  // A missing parent yields no suggestions; nothing is invented.
  assert.equal(await provider.getSuggestions([`${root}/missing/sub`], 0, `${root}/missing/sub`.length, { signal: signal() }), null);

  // The editor's file-completion trigger flag follows the same token rule.
  assert.equal(provider.shouldTriggerFileCompletion?.(["/x"], 0, 2), true);
  assert.equal(provider.shouldTriggerFileCompletion?.(["~/x"], 0, 3), true);
  assert.equal(provider.shouldTriggerFileCompletion?.(["plain"], 0, 5), false);
});

test("directory provider applyCompletion replaces exactly the token before the cursor", () => {
  const provider = createDirectoryAutocompleteProvider();
  const item = { value: "/opt/tools/", label: "/opt/tools/" };
  const line = "/opt/to rest";
  const col = "/opt/to".length;

  const out = provider.applyCompletion([line], 0, col, item, "/opt/to");
  assert.deepEqual(out.lines, ["/opt/tools/ rest"]);
  assert.equal(out.cursorCol, "/opt/tools/".length);
  assert.equal(out.cursorLine, 0);

  // Other lines are untouched.
  const out2 = provider.applyCompletion(["keep", line], 1, col, item, "/opt/to");
  assert.deepEqual(out2.lines, ["keep", "/opt/tools/ rest"]);
});

// ---------------------------------------------------------------------------
// Component tests with a fake host editor (deterministic settle semantics)
// ---------------------------------------------------------------------------

interface FakeWorkspaceEditor {
  focused: boolean;
  onSubmit?: (text: string) => void;
  text: string;
  provider?: unknown;
  setText(text: string): void;
  getExpandedText(): string;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
  setAutocompleteProvider(provider: unknown): void;
}

function fakeHostWithEditor(): { host: HostEditorProvider; instances: FakeWorkspaceEditor[] } {
  const instances: FakeWorkspaceEditor[] = [];
  class Editor implements FakeWorkspaceEditor {
    focused = false;
    onSubmit?: (text: string) => void;
    text = "";
    provider?: unknown;
    constructor(_tui: unknown, _theme: unknown) {
      instances.push(this);
    }
    setText(text: string): void {
      this.text = text;
    }
    getExpandedText(): string {
      return this.text;
    }
    handleInput(data: string): void {
      if (data === "\x15") {
        this.text = ""; // ctrl+u: delete to line start (single-line editor)
      } else if (data === "\r") {
        const value = this.text.trim();
        this.text = "";
        this.onSubmit?.(value);
      } else if (data.length === 1 && data >= " ") {
        this.text += data;
      }
    }
    render(_width: number): string[] {
      return [`[editor:${this.text}]`];
    }
    invalidate(): void {}
    setAutocompleteProvider(provider: unknown): void {
      this.provider = provider;
    }
  }
  return { host: { Editor }, instances };
}

/** A minimal live-manager stand-in whose cancel binding matches Esc/Ctrl+C. */
const CANCEL_MANAGER = {
  matches(data: string, keybinding: string): boolean {
    return keybinding === "tui.select.cancel" && (data === "\x1b" || data === "\x03");
  },
};

test("workspace editor component prefills the staged value and settles exactly once on submit", () => {
  const { host, instances } = fakeHostWithEditor();
  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: CANCEL_MANAGER,
    current: "/staged/dir",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  });
  assert.ok(component);

  const editor = instances[0]!;
  assert.equal(editor.text, "/staged/dir", "the staged workspace is the editor's prefill (single draft)");
  assert.equal(typeof (editor.provider as { getSuggestions?: unknown } | undefined)?.getSuggestions, "function", "provider attached through the public seam");

  const frame = component.render(80).join("\n");
  assert.ok(frame.includes(WORKSPACE_EDITOR_TITLE), `title renders: ${frame}`);
  assert.ok(frame.includes(WORKSPACE_EDITOR_HINT), `hint renders: ${frame}`);

  component.focused = true;
  assert.equal(editor.focused, true, "focus propagates to the host editor");

  component.handleInput("\r");
  assert.equal(doneCount, 1);
  assert.equal(doneValue, "/staged/dir", "submit resolves with the editor's own text");

  // Late input after settle is ignored; no second draft, no second settle.
  component.handleInput("x");
  component.handleInput("\r");
  assert.equal(doneCount, 1);
});

test("workspace editor component: typed edits submit; Esc cancels with undefined", () => {
  const { host } = fakeHostWithEditor();
  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: CANCEL_MANAGER,
    current: "/base",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  })!;

  for (const ch of "-edited") component.handleInput(ch);
  component.handleInput("\r");
  assert.equal(doneCount, 1);
  assert.equal(doneValue, "/base-edited", "the editor's live text is the submitted value");

  const second = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: CANCEL_MANAGER,
    current: "/base",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  })!;
  second.handleInput("\x1b");
  assert.equal(doneCount, 2);
  assert.equal(doneValue, undefined, "Esc cancels with undefined (staged value unchanged)");
  second.handleInput("x");
  second.handleInput("\r");
  assert.equal(doneCount, 2, "no settle after cancel");
});

// ---------------------------------------------------------------------------
// Degradation chain: custom host editor → public editor → legacy input
// ---------------------------------------------------------------------------

interface DegradeHarness {
  ui: unknown;
  editorCalls: Array<{ title: string; prefill?: string }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
}

function degradeUi(options: { mode?: string; customTui?: unknown; withEditor?: boolean; withInput?: boolean }): DegradeHarness & { run: () => Promise<string | undefined> } {
  const harness: DegradeHarness = { ui: undefined, editorCalls: [], inputCalls: [] };
  let editorIndex = 0;
  let inputIndex = 0;
  const ui: Record<string, unknown> = {
    mode: options.mode ?? "tui",
    notify(): void {},
  };
  if (options.customTui !== undefined) {
    ui.custom = (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> =>
      new Promise((resolve) => {
        const component = factory(options.customTui, IDENTITY_THEME, CANCEL_MANAGER, resolve);
        (component as { render?(width: number): string[] })?.render?.(80);
      });
  }
  if (options.withEditor ?? true) {
    ui.editor = async (title: string, prefill?: string) => {
      harness.editorCalls.push({ title, prefill });
      return ["public-editor-value"][editorIndex++];
    };
  }
  if (options.withInput ?? false) {
    ui.input = async (title: string, placeholder?: string) => {
      harness.inputCalls.push({ title, placeholder });
      return ["legacy-input-value"][inputIndex++];
    };
  }
  harness.ui = ui;
  return { ...harness, run: () => editWorkspaceDirectory(ui as never, "/current/dir") };
}

test("a host without an Editor class degrades to the public editor prefill", async (t) => {
  setWorkspaceEditorTuiHost({}); // truthy provider, no Editor class
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: GEOMETRY_TUI });
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
  assert.equal(harness.inputCalls.length, 0);
});

test("a host Editor without terminal geometry degrades to the public editor prefill", async (t) => {
  setWorkspaceEditorTuiHost(fakeHostWithEditor().host);
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: { requestRender(): void {} } }); // no terminal.rows
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
});

test("without custom (RPC) the field uses the public editor; without that too, legacy input", async () => {
  const withEditor = degradeUi({ mode: "rpc", withInput: true });
  assert.equal(await withEditor.run(), "public-editor-value");
  assert.deepEqual(withEditor.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);

  const legacy = degradeUi({ mode: "rpc", withEditor: false, withInput: true });
  assert.equal(await legacy.run(), "legacy-input-value");
  assert.deepEqual(legacy.inputCalls, [{ title: WORKSPACE_EDITOR_TITLE, placeholder: "/current/dir" }], "legacy input keeps its placeholder semantics");
});

// ---------------------------------------------------------------------------
// Real-host integration (installed Pi's pi-tui Editor; skipped when absent)
// ---------------------------------------------------------------------------

test("real host editor: Tab completes existing directories and submits the completed path", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pi-ws-real-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  await writeFile(join(root, "file.txt"), "");

  const host: HostEditorProvider = { Editor: mod.Editor as HostEditorProvider["Editor"] };
  setWorkspaceEditorTuiHost(host);
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const manager = new (mod.KeybindingsManager as new (a: unknown, b: unknown) => { matches(data: string, kb: string): boolean })(mod.TUI_KEYBINDINGS, {});
  (mod.setKeybindings as ((keybindings: unknown) => void))(manager);

  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: manager,
    current: "",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  });
  assert.ok(component, "the real host editor embeds in the component");
  component.focused = true;

  const type = (text: string): void => {
    for (const ch of text) component.handleInput(ch);
  };
  type(`${root}/a`);
  await settle();
  let frame = component.render(200).join("\n"); // wide enough to avoid list truncation
  assert.ok(frame.includes("alpha/"), `directory suggestion rendered: ${frame}`);
  assert.ok(!frame.includes("file.txt"), "files are never suggested");

  // Tab applies the highlighted completion (the only prefix match).
  component.handleInput("\t");
  await settle();
  component.handleInput(KEY_ENTER);
  assert.equal(doneCount, 1);
  assert.equal(doneValue, `${root}/alpha/`, "submit carries the completed directory");
});

test("real host editor: ~/ suggestions keep the tilde spelling", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "pi-ws-realhome-"));
  await mkdir(join(home, "beta"), { recursive: true });
  await mkdir(join(home, "berlin"), { recursive: true });

  const host: HostEditorProvider = { Editor: mod.Editor as HostEditorProvider["Editor"] };
  setWorkspaceEditorTuiHost(host);
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const manager = new (mod.KeybindingsManager as new (a: unknown, b: unknown) => { matches(data: string, kb: string): boolean })(mod.TUI_KEYBINDINGS, {});
  (mod.setKeybindings as ((keybindings: unknown) => void))(manager);

  let doneValue: string | undefined = "sentinel";
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: manager,
    current: "",
    provider: createDirectoryAutocompleteProvider({ homeDir: () => home }),
    done: (value) => {
      doneValue = value;
    },
  });
  assert.ok(component);
  component.focused = true;

  for (const ch of "~/be") component.handleInput(ch);
  component.handleInput("\t"); // Tab: force directory completion
  await settle();
  const frame = component.render(200).join("\n");
  assert.ok(frame.includes("~/berlin/"), `~/ spelling preserved in suggestions: ${frame}`);
  assert.ok(frame.includes("~/beta/"), `~/ spelling preserved in suggestions: ${frame}`);

  // Tab applies the highlighted ~/... completion; Enter submits it verbatim.
  component.handleInput("\t");
  await settle();
  component.handleInput(KEY_ENTER);
  assert.equal(doneValue, "~/berlin/", "the tilde spelling is what the field submits (Save expands it)");
});

// ---------------------------------------------------------------------------
// Full /review-settings flow: invalid directories are not silently accepted
// ---------------------------------------------------------------------------

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
  "Scheduled tasks",
  "Web",
] as const;

type FlowStep = (component: { render?(width: number): string[]; handleInput?(data: string): void }) => void | Promise<void>;

function flowHarness(steps: FlowStep[]): {
  ctx: unknown;
  notifyCalls: Array<{ message: string; type?: string }>;
  editorCalls: Array<{ title: string; prefill?: string }>;
  customCount(): number;
} {
  let stepIndex = 0;
  let customCount = 0;
  const frames: string[][] = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  const ctx = {
    mode: "tui",
    scopedModels: [],
    ui: {
      custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
        customCount += 1;
        return new Promise((resolve) => {
          const component = factory(GEOMETRY_TUI, IDENTITY_THEME, CANCEL_MANAGER, resolve) as {
            render?(width: number): string[];
            handleInput?(data: string): void;
            focused?: boolean;
          };
          component.focused = true;
          const frame = component.render?.(80);
          if (Array.isArray(frame)) frames.push(frame);
          void (async () => {
            await steps[stepIndex++]?.(component);
          })();
        });
      },
      async select(): Promise<string | undefined> {
        throw new Error("plain select must not be used in TUI mode with a loadable host");
      },
      async editor(title: string, prefill?: string): Promise<string | undefined> {
        editorCalls.push({ title, prefill });
        return undefined;
      },
      notify(message: string, type?: string): void {
        notifyCalls.push({ message, type });
      },
    },
  };
  return { ctx, notifyCalls, editorCalls, customCount: () => customCount };
}

const keys = (...sequence: string[]): FlowStep => (component) => {
  for (const key of sequence) component.handleInput?.(key);
};

async function writeFlowConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-flow-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly check",
        cron: "30 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Check the docs for staleness",
        workspace: dir,
      },
    },
  }), "utf8");
  return { dir, configPath };
}

test("full flow: a typed non-existent directory is rejected at Save, never silently accepted", async (t) => {
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setWorkspaceEditorTuiHost(fakeHostWithEditor().host);
  t.after(() => {
    setMenuTuiHost(undefined);
    setWorkspaceEditorTuiHost(undefined);
  });

  const { dir, configPath } = await writeFlowConfig();
  const config = (await import("../src/config")).normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
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

  const invalid = "/nonexistent-xyz-123";
  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.("\x15"); // Ctrl+U: clear the prefilled staged value
      for (const ch of invalid) component.handleInput?.(ch);
      component.handleInput?.(KEY_ENTER); // submit the typed (invalid) path
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (row 14) → Save changes (row 16)
    keys("\x1b"), // failed save re-shows the root menu; Esc leaves without saving
  ]);

  assert.ok(handler, "the /review-settings command registered");
  await handler("", harness.ctx);

  assert.ok(
    harness.notifyCalls.some((call) => call.type === "error" && /not an existing directory/.test(call.message)),
    `Save validation rejected the invalid directory: ${JSON.stringify(harness.notifyCalls)}`,
  );
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, dir, "the staged workspace is unchanged");
  // Six menus plus the workspace editor surface and the post-failure root
  // re-show; the field used the custom host editor, not a second draft.
  assert.equal(harness.customCount(), 8);
  assert.equal(harness.editorCalls.length, 0);
});

test("full flow: Tab completion in the embedded editor stages an existing directory through Save", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  const host: HostEditorProvider = { Editor: mod.Editor as HostEditorProvider["Editor"] };
  setWorkspaceEditorTuiHost(host);
  t.after(() => {
    setMenuTuiHost(undefined);
    setWorkspaceEditorTuiHost(undefined);
  });

  const root = await mkdtemp(join(tmpdir(), "pi-ws-flowreal-"));
  await mkdir(join(root, "alpha"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  const manager = new (mod.KeybindingsManager as new (a: unknown, b: unknown) => { matches(data: string, kb: string): boolean })(mod.TUI_KEYBINDINGS, {});
  (mod.setKeybindings as ((keybindings: unknown) => void))(manager);

  const { dir, configPath } = await writeFlowConfig();
  const config = (await import("../src/config")).normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
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

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks
    keys(KEY_ENTER), // list → task entry
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.("\x15"); // Ctrl+U: clear the prefilled staged value
      for (const ch of `${root}/a`) component.handleInput?.(ch);
      component.handleInput?.("\t"); // Tab: directory completion
      await settle();
      const frame = component.render!(200).join("\n"); // wide enough to avoid list truncation
      assert.ok(frame.includes("alpha/"), `Tab rendered the directory suggestion: ${frame}`);
      component.handleInput?.("\t"); // apply the highlighted completion
      await settle();
      component.handleInput?.(KEY_ENTER); // submit
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show → Back
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show → Save changes
  ]);

  assert.ok(handler, "the /review-settings command registered");
  await handler("", harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, `${root}/alpha/`, "the completed directory is staged and saved");
});
