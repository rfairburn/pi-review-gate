/**
 * Issue #26: the scheduled-task workspace directory field (native Pi path
 * completion).
 *
 * Pins the one bespoke settings surface: in an interactive TUI where the host
 * pi-tui `Editor` can be embedded, the field shows that editor — created via
 * the shared host-agnostic adapter and peer loader — prefilled with the staged
 * workspace, with the host module's own
 * `CombinedAutocompleteProvider([], sessionCwd)` attached through the public
 * `setAutocompleteProvider` seam. The extension carries no completion algorithm
 * of its own: token recognition, relative/`~`/absolute handling, platform
 * behavior, the selectable list UI, and selection keys are all inherited from
 * Pi as-is — including its limitations (a line starting with `/` is the host
 * editor's slash-command context, so absolute paths complete only where the
 * host's own chat editor does; files appear in the list alongside directories).
 *
 * - The editor is the single draft: prefill via setText, submit resolves with
 *   the editor's own text, Esc first dismisses a visible native completion
 *   list (the public `isShowingAutocomplete` seam) and only then cancels,
 *   exactly one settle.
 * - No usable custom surface (no Editor or CombinedAutocompleteProvider
 *   class, no terminal geometry, no session cwd, no `custom` at all) degrades
 *   to the public `ui.editor` prefill, then the legacy `ui.input`; host-load
 *   failures fail closed into that chain. No process.cwd anchor is invented.
 * - Invalid directories are not silently accepted: completion is a
 *   convenience and Save-time validation remains the authority — selecting a
 *   file from the list cannot bypass the workspace-directory boundary.
 *
 * Real-host tests drive the installed Pi's actual pi-tui Editor and
 * CombinedAutocompleteProvider (skipped when the peer is unresolvable in this
 * environment). What they cannot verify headlessly: a human watching the box
 * render, and Ctrl+G external editing — that control belongs to the host's own
 * editor surface (the public `ui.editor` path for ordinary fields), asserted
 * at the seam level in settings-text-fields.test.ts.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostEditorProvider } from "../src/host-editor";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  createWorkspaceEditorComponent,
  editWorkspaceDirectory,
  setWorkspaceEditorTuiHost,
  WORKSPACE_EDITOR_HINT,
  WORKSPACE_EDITOR_TITLE,
} from "../src/settings/workspace-editor";
import {
  createFakeMenuTuiHost,
  IDENTITY_THEME,
  KEY_DOWN,
  KEY_ENTER,
  loadRealPiTuiModule,
} from "./menu-tui-fakes";

const GEOMETRY_TUI = { terminal: { rows: 40 }, requestRender(): void {} };

async function settle(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal live-manager stand-in whose cancel binding matches Esc/Ctrl+C. */
const CANCEL_MANAGER = {
  matches(data: string, keybinding: string): boolean {
    return keybinding === "tui.select.cancel" && (data === "\x1b" || data === "\x03");
  },
};

// ---------------------------------------------------------------------------
// Fake host (wiring only — never a reimplementation of Pi completion)
// ---------------------------------------------------------------------------

interface FakeWorkspaceEditor {
  focused: boolean;
  onSubmit?: (text: string) => void;
  text: string;
  provider?: unknown;
  /** Test-controlled visibility of the native completion list (Esc seam). */
  showingAutocomplete: boolean;
  received: string[];
}

interface FakeNativeProvider {
  commands: unknown[];
  basePath: string;
}

/**
 * Structural stand-ins for the host module's two public classes. They record
 * construction arguments and the attached provider so the wiring (public
 * seams, session-cwd anchor) is verifiable without a loadable peer; they do
 * not reimplement Pi completion behavior — that is exercised against the real
 * host in the integration tests below.
 */
function fakeHostWithEditor(): { host: HostEditorProvider; instances: FakeWorkspaceEditor[]; providers: FakeNativeProvider[] } {
  const instances: FakeWorkspaceEditor[] = [];
  const providers: FakeNativeProvider[] = [];
  class Editor implements FakeWorkspaceEditor {
    focused = false;
    onSubmit?: (text: string) => void;
    text = "";
    provider?: unknown;
    showingAutocomplete = false;
    received: string[] = [];
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
      this.received.push(data);
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
    isShowingAutocomplete(): boolean {
      return this.showingAutocomplete;
    }
  }
  class NativeProvider implements FakeNativeProvider {
    readonly commands: unknown[];
    readonly basePath: string;
    constructor(commands: unknown[], basePath: string) {
      this.commands = commands;
      this.basePath = basePath;
      providers.push(this);
    }
  }
  return { host: { Editor, CombinedAutocompleteProvider: NativeProvider }, instances, providers };
}

test("workspace editor component prefills the staged value, attaches native completion anchored to the session cwd, and settles exactly once on submit", () => {
  const { host, instances, providers } = fakeHostWithEditor();
  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: CANCEL_MANAGER,
    current: "/staged/dir",
    cwd: "/session/cwd",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  });
  assert.ok(component);

  const editor = instances[0]!;
  assert.equal(editor.text, "/staged/dir", "the staged workspace is the editor's prefill (single draft)");
  assert.ok(editor.provider, "provider attached through the public seam");
  assert.deepEqual(providers[0]?.commands, [], "constructed with no slash commands");
  assert.equal(providers[0]?.basePath, "/session/cwd", "anchored to the host session cwd, not process.cwd");

  const frame = component.render(80).join("\n");
  assert.ok(frame.includes(WORKSPACE_EDITOR_TITLE), `title renders: ${frame}`);
  assert.ok(frame.includes(WORKSPACE_EDITOR_HINT), `hint renders: ${frame}`);

  component.focused = true;
  assert.equal(editor.focused, true, "focus propagates to the host editor");

  component.handleInput("\r");
  assert.equal(doneCount, 1);
  assert.equal(doneValue, "/staged/dir", "submit resolves with the editor's own text");

  component.handleInput("\r");
  assert.equal(doneCount, 1, "exactly one settle");
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
    cwd: "/session/cwd",
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
    cwd: "/session/cwd",
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

test("workspace editor component: Esc dismisses a visible completion list first, then cancels", () => {
  const { host, instances } = fakeHostWithEditor();
  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = createWorkspaceEditorComponent({
    host,
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: CANCEL_MANAGER,
    current: "",
    cwd: "/session/cwd",
    done: (value) => {
      doneValue = value;
      doneCount += 1;
    },
  })!;

  const editor = instances[0]!;
  editor.showingAutocomplete = true; // a native list is visible
  component.handleInput("\x1b");
  assert.equal(doneCount, 0, "first Esc does not cancel while the list is visible");
  assert.ok(editor.received.includes("\x1b"), "the first Esc is forwarded to the host editor (it dismisses its own list)");

  editor.showingAutocomplete = false; // the host editor dismissed it
  component.handleInput("\x1b");
  assert.equal(doneCount, 1, "second Esc cancels");
  assert.equal(doneValue, undefined, "cancel leaves the staged value unchanged");
});

// ---------------------------------------------------------------------------
// Degradation chain: custom host editor -> public editor -> legacy input
// ---------------------------------------------------------------------------

function degradeUi(options: { mode?: string; customTui?: unknown; withEditor?: boolean; withInput?: boolean; cwd?: string }): {
  ui: unknown;
  editorCalls: Array<{ title: string; prefill?: string }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
  run: () => Promise<string | undefined>;
} {
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  let editorIndex = 0;
  let inputIndex = 0;
  const ui: Record<string, unknown> = {
    mode: options.mode ?? "tui",
    notify(): void {},
  };
  if (options.cwd !== undefined) ui.cwd = options.cwd;
  if (options.customTui !== undefined) {
    ui.custom = (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> =>
      new Promise((resolve) => {
        const component = factory(options.customTui, IDENTITY_THEME, CANCEL_MANAGER, resolve);
        (component as { render?(width: number): string[] })?.render?.(80);
      });
  }
  if (options.withEditor ?? true) {
    ui.editor = async (title: string, prefill?: string) => {
      editorCalls.push({ title, prefill });
      return ["public-editor-value"][editorIndex++];
    };
  }
  if (options.withInput ?? false) {
    ui.input = async (title: string, placeholder?: string) => {
      inputCalls.push({ title, placeholder });
      return ["legacy-input-value"][inputIndex++];
    };
  }
  return {
    ui,
    editorCalls,
    inputCalls,
    run: () => editWorkspaceDirectory(ui as never, "/current/dir"),
  };
}

test("a host without an Editor class degrades to the public editor prefill", async (t) => {
  setWorkspaceEditorTuiHost({}); // truthy provider, no Editor class
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: GEOMETRY_TUI, cwd: "/session/cwd" });
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
});

test("a host without a CombinedAutocompleteProvider class degrades to the public editor prefill", async (t) => {
  const { host } = fakeHostWithEditor();
  setWorkspaceEditorTuiHost({ Editor: host.Editor }); // Editor only, no provider class
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: GEOMETRY_TUI, cwd: "/session/cwd" });
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
});

for (const [missingSeam, changeHost] of [
  ["setAutocompleteProvider", (prototype: Record<string, unknown>) => { delete prototype.setAutocompleteProvider; }],
  ["isShowingAutocomplete", (prototype: Record<string, unknown>) => { delete prototype.isShowingAutocomplete; }],
  ["working provider attachment", (prototype: Record<string, unknown>) => {
    prototype.setAutocompleteProvider = () => { throw new Error("host provider attach failed"); };
  }],
] as const) {
  test(`a host Editor without ${missingSeam} degrades to the public editor prefill`, async (t) => {
    const { host } = fakeHostWithEditor();
    changeHost((host.Editor as unknown as { prototype: Record<string, unknown> }).prototype);
    setWorkspaceEditorTuiHost(host);
    t.after(() => setWorkspaceEditorTuiHost(undefined));

    const harness = degradeUi({ customTui: GEOMETRY_TUI, cwd: "/session/cwd" });
    assert.equal(await harness.run(), "public-editor-value");
    assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
  });
}

test("a host Editor without terminal geometry degrades to the public editor prefill", async (t) => {
  setWorkspaceEditorTuiHost(fakeHostWithEditor().host);
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: { requestRender(): void {} }, cwd: "/session/cwd" }); // no terminal.rows
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
});

test("a TUI without a session cwd degrades to the public editor prefill (no process.cwd anchor)", async (t) => {
  const { host, providers } = fakeHostWithEditor();
  setWorkspaceEditorTuiHost(host);
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  const harness = degradeUi({ customTui: GEOMETRY_TUI }); // no cwd on the command context
  const value = await harness.run();

  assert.equal(value, "public-editor-value");
  assert.deepEqual(harness.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);
  assert.equal(providers.length, 0, "no completion provider is constructed without a session cwd");
});

test("without custom (RPC) the field uses the public editor; without that too, legacy input", async () => {
  const withEditor = degradeUi({ mode: "rpc" });
  assert.equal(await withEditor.run(), "public-editor-value");
  assert.deepEqual(withEditor.editorCalls, [{ title: WORKSPACE_EDITOR_TITLE, prefill: "/current/dir" }]);

  const legacy = degradeUi({ mode: "rpc", withEditor: false, withInput: true });
  assert.equal(await legacy.run(), "legacy-input-value");
  assert.deepEqual(legacy.inputCalls, [{ title: WORKSPACE_EDITOR_TITLE, placeholder: "/current/dir" }], "legacy input keeps its placeholder semantics");
});

// ---------------------------------------------------------------------------
// Real-host integration (installed Pi's pi-tui Editor + native provider;
// skipped when the peer is unresolvable in this environment)
// ---------------------------------------------------------------------------

function realHost(mod: Record<string, unknown>): HostEditorProvider {
  return {
    Editor: mod.Editor as HostEditorProvider["Editor"],
    CombinedAutocompleteProvider: mod.CombinedAutocompleteProvider as HostEditorProvider["CombinedAutocompleteProvider"],
  };
}

function realKeybindingsManager(mod: Record<string, unknown>): { matches(data: string, kb: string): boolean } {
  const manager = new (mod.KeybindingsManager as new (a: unknown, b: unknown) => { matches(data: string, kb: string): boolean })(mod.TUI_KEYBINDINGS, {});
  (mod.setKeybindings as (keybindings: unknown) => void)(manager);
  return manager;
}

async function makeDocsFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-ws-real-"));
  await mkdir(join(root, "docs", "assets"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "");
  await writeFile(join(root, "docs", "intro.md"), "");
  await mkdir(join(root, "other"), { recursive: true });
  return root;
}

function realComponent(mod: Record<string, unknown>, cwd: string, current: string, onDone: (value: string | undefined) => void) {
  const component = createWorkspaceEditorComponent({
    host: realHost(mod),
    tui: GEOMETRY_TUI,
    theme: IDENTITY_THEME,
    keybindings: realKeybindingsManager(mod),
    current,
    cwd,
    done: onDone,
  });
  assert.ok(component, "the real host editor embeds in the component");
  component.focused = true;
  return component as { render(width: number): string[]; handleInput(data: string): void };
}

const typeText = (component: { handleInput(data: string): void }, text: string): void => {
  for (const ch of text) component.handleInput(ch);
};

test("real host editor: docs/ + first Tab opens a native selectable list of folders and files", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const root = await makeDocsFixture();
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  let doneCount = 0;
  const component = realComponent(mod, root, "", () => {
    doneCount += 1;
  });

  typeText(component, "docs/");
  await settle();
  // The first Tab opens the native selectable list (the user's screenshot case).
  component.handleInput("\t");
  await settle();
  const frame = component.render(200).join("\n"); // wide enough to avoid list truncation
  assert.ok(frame.includes("assets/"), `folder listed: ${frame}`);
  assert.ok(frame.includes("guide.md"), `file listed (the native provider lists files too): ${frame}`);
  assert.ok(frame.includes("intro.md"), `second file listed: ${frame}`);
  assert.ok(!frame.includes("other"), "anchored to the passed session cwd, not process.cwd");
  assert.equal(doneCount, 0, "opening the list does not submit");
});

test("real host editor: native keys select a folder from the list and Enter submits it", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }


  const root = await makeDocsFixture();
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = realComponent(mod, root, "", (value) => {
    doneValue = value;
    doneCount += 1;
  });

  typeText(component, "docs/");
  await settle();
  component.handleInput("\t"); // open the list (assets/ highlighted first: directories sort first)
  await settle();
  const frame = component.render(200).join("\n");
  assert.ok(frame.includes("assets/"), `list is open: ${frame}`);

  component.handleInput("\t"); // apply the highlighted folder with the native key
  await settle();
  component.handleInput(KEY_ENTER);
  assert.equal(doneCount, 1);
  assert.equal(doneValue, "docs/assets/", "submit carries the natively selected folder (relative to the session cwd)");
});

test("real host editor: arrow keys move the native selection to a file; Esc then cancels unchanged", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const root = await makeDocsFixture();
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = realComponent(mod, root, "", (value) => {
    doneValue = value;
    doneCount += 1;
  });

  typeText(component, "docs/");
  await settle();
  component.handleInput("\t"); // open the list
  await settle();
  component.handleInput(KEY_DOWN); // move the native selection to the next item (guide.md)
  await settle();
  component.handleInput("\t"); // apply it
  await settle();
  const frame = component.render(200).join("\n");
  assert.ok(frame.includes("docs/guide.md"), `the natively selected file is in the draft: ${frame}`);

  // The list closed with the applied completion, so a single Esc cancels.
  component.handleInput("\x1b");
  assert.equal(doneCount, 1);
  assert.equal(doneValue, undefined, "Esc after an applied completion cancels (staged value unchanged)");
});

test("real host editor: Esc dismisses a visible completion list first, then cancels", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const root = await makeDocsFixture();
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  let doneValue: string | undefined = "sentinel";
  let doneCount = 0;
  const component = realComponent(mod, root, "", (value) => {
    doneValue = value;
    doneCount += 1;
  });

  typeText(component, "docs/");
  await settle();
  component.handleInput("\t"); // open the list
  await settle();
  assert.ok(component.render(200).join("\n").includes("assets/"), "the list is visible");

  component.handleInput("\x1b"); // first Esc: the host editor dismisses its own list
  await settle();
  const frame = component.render(200).join("\n");
  assert.equal(doneCount, 0, "first Esc does not cancel while the list is visible");
  assert.ok(!frame.includes("assets/"), `the list was dismissed: ${frame}`);
  assert.ok(frame.includes("docs/"), "the draft text survives the dismissal");

  component.handleInput("\x1b"); // second Esc: cancel the field
  assert.equal(doneCount, 1);
  assert.equal(doneValue, undefined, "cancel leaves the staged value unchanged");
});

/** Points the native provider's `~` expansion at a fixture home (os.homedir reads $HOME). */
function withFixtureHome(home: string, t: { after(callback: () => void): void }): void {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  t.after(() => {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
  });
}

test("real host provider: ~/ completions keep the native tilde spelling", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "pi-ws-realhome-"));
  await mkdir(join(home, "berlin"), { recursive: true });
  await mkdir(join(home, "beta"), { recursive: true });
  withFixtureHome(home, t);

  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => setWorkspaceEditorTuiHost(undefined));

  let doneValue: string | undefined = "sentinel";
  const component = realComponent(mod, home, "", (value) => {
    doneValue = value;
  });

  typeText(component, "~/be");
  component.handleInput("\t"); // Tab: native path completion
  await settle();
  const frame = component.render(200).join("\n");
  assert.ok(frame.includes("berlin/"), `suggestion listed: ${frame}`);
  assert.ok(frame.includes("beta/"), `suggestion listed: ${frame}`);

  // Tab applies the highlighted ~/... completion; the tilde spelling survives.
  component.handleInput("\t");
  await settle();
  const draft = component.render(200).join("\n");
  assert.ok(draft.includes("~/berlin/"), `~/ spelling preserved in the applied draft: ${draft}`);
  component.handleInput(KEY_ENTER);
  assert.equal(doneValue, "~/berlin/", "the tilde spelling is what the field submits (Save expands it)");
});

test("real host provider: an absolute home prefix completes as-is, never rewritten to ~/", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "pi-ws-realabs-"));
  await mkdir(join(home, "berlin"), { recursive: true });
  await mkdir(join(home, "beta"), { recursive: true });
  withFixtureHome(home, t);

  // Drive the host's own provider directly (the same class the editor gets):
  // an exact-home absolute prefix keeps its absolute spelling at completion.
  const ProviderCtor = mod.CombinedAutocompleteProvider as new (commands: never[], basePath: string) => {
    getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<{ items: Array<{ value: string }>; prefix: string } | null>;
  };
  const provider = new ProviderCtor([], process.cwd());
  const token = `${home}/b`;
  const result = await provider.getSuggestions([token], 0, token.length, { signal: new AbortController().signal, force: true });
  assert.ok(result, "forced file completion yields suggestions for an absolute home prefix");
  assert.deepEqual(
    result.items.map((item) => item.value),
    [`${home}/berlin/`, `${home}/beta/`],
    "an exact-home absolute prefix stays absolute when Pi completes it",
  );

  // Inherited host limitation, pinned as-is: a line starting with `/` is the
  // editor's slash-command context (no commands are registered here), so the
  // natural trigger yields nothing — no leading-slash shim is added.
  assert.equal(await provider.getSuggestions([token], 0, token.length, { signal: new AbortController().signal }), null);
});

// ---------------------------------------------------------------------------
// Full /review-settings flow: Save validation stays the authority
// ---------------------------------------------------------------------------

type FlowStep = (component: { render?(width: number): string[]; handleInput?(data: string): void }) => void | Promise<void>;

function flowHarness(steps: FlowStep[], options: { cwd?: string; keybindings?: unknown } = {}): {
  ctx: unknown;
  notifyCalls: Array<{ message: string; type?: string }>;
  editorCalls: Array<{ title: string; prefill?: string }>;
  customCount(): number;
} {
  let stepIndex = 0;
  let customCount = 0;
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  const keybindings = options.keybindings ?? CANCEL_MANAGER;
  const ctx = {
    mode: "tui",
    scopedModels: [],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ui: {
      custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
        customCount += 1;
        return new Promise((resolve) => {
          const component = factory(GEOMETRY_TUI, IDENTITY_THEME, keybindings, resolve) as {
            render?(width: number): string[];
            handleInput?(data: string): void;
            focused?: boolean;
          };
          component.focused = true;
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
  await writeFile(configPath, JSON.stringify({ scheduledTasks: { "task-abcdef12": { name: "Nightly check", cron: "30 2 * * *", enabled: true, kind: "execute", instructions: "Check the docs for staleness", workspace: dir } } }, null, 2));
  return { dir, configPath };
}

async function registerFlowHandler(configPath: string): Promise<(ctx: unknown) => Promise<void>> {
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
  assert.ok(handler, "the /review-settings command registered");
  return (ctx) => handler!("", ctx);
}

test("full flow: a typed non-existent directory is rejected at Save, never silently accepted", async (t) => {
  const fake = fakeHostWithEditor();
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setWorkspaceEditorTuiHost(fake.host);
  t.after(() => {
    setMenuTuiHost(undefined);
    setWorkspaceEditorTuiHost(undefined);
  });

  const { dir, configPath } = await writeFlowConfig();
  const before = await readFile(configPath, "utf8");
  const run = await registerFlowHandler(configPath);

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
  ], { cwd: dir });

  await run(harness.ctx);

  assert.ok(
    harness.notifyCalls.some((call) => call.type === "error" && /not an existing directory/.test(call.message)),
    `Save validation rejected the invalid directory: ${JSON.stringify(harness.notifyCalls)}`,
  );
  assert.equal(await readFile(configPath, "utf8"), before, "the config file is byte-unchanged after a failed save");
  assert.equal(harness.editorCalls.length, 0, "the field used the embedded host editor, not a second draft");
  assert.equal(harness.customCount(), 8, "seven menus plus the workspace editor surface");
});

test("full flow: a file selected from the native completion list cannot pass Save", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => {
    setMenuTuiHost(undefined);
    setWorkspaceEditorTuiHost(undefined);
  });

  // Fixture home: the native list under ~/docs/ holds a folder and a file.
  const home = await mkdtemp(join(tmpdir(), "pi-ws-flowfile-"));
  await mkdir(join(home, "docs", "assets"), { recursive: true });
  await writeFile(join(home, "docs", "guide.md"), "");
  withFixtureHome(home, t);

  const { configPath } = await writeFlowConfig();
  const before = await readFile(configPath, "utf8");
  const run = await registerFlowHandler(configPath);

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.("\x15"); // Ctrl+U: clear the prefilled staged value
      for (const ch of "~/docs/") component.handleInput?.(ch);
      component.handleInput?.("\t"); // Tab: open the native list (assets/ highlighted first)
      await settle();
      const frame = component.render!(200).join("\n");
      assert.ok(frame.includes("guide.md"), `the file is in the native list: ${frame}`);
      component.handleInput?.(KEY_DOWN); // move the native selection to the file
      await settle();
      component.handleInput?.("\t"); // apply it
      await settle();
      assert.ok(component.render!(200).join("\n").includes("docs/guide.md"), "the selected file is in the draft");
      component.handleInput?.(KEY_ENTER); // submit the completed file path
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (row 14) → Save changes (row 16)
    keys("\x1b"), // failed save re-shows the root menu; Esc leaves without saving
  ], { cwd: home, keybindings: realKeybindingsManager(mod) });

  await run(harness.ctx);

  assert.ok(
    harness.notifyCalls.some((call) => call.type === "error" && /not an existing directory/.test(call.message)),
    `Save validation rejected the completed file: ${JSON.stringify(harness.notifyCalls)}`,
  );
  assert.equal(await readFile(configPath, "utf8"), before, "selecting a file cannot bypass the directory boundary");
});

test("full flow: native Tab completion stages an existing directory through Save", async (t) => {
  const mod = await loadRealPiTuiModule();
  if (!mod) {
    t.skip("pi-tui is not resolvable in this environment");
    return;
  }
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setWorkspaceEditorTuiHost(realHost(mod));
  t.after(() => {
    setMenuTuiHost(undefined);
    setWorkspaceEditorTuiHost(undefined);
  });

  // Fixture home: the native provider completes ~/a to ~/alpha/.
  const home = await mkdtemp(join(tmpdir(), "pi-ws-flowreal-"));
  await mkdir(join(home, "alpha"), { recursive: true });
  await mkdir(join(home, "beta"), { recursive: true });
  withFixtureHome(home, t);

  const { configPath } = await writeFlowConfig();
  const run = await registerFlowHandler(configPath);

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.("\x15"); // Ctrl+U: clear the prefilled staged value
      for (const ch of "~/a") component.handleInput?.(ch);
      component.handleInput?.("\t"); // Tab: the single native match (~/alpha/) applies directly
      await settle();
      assert.ok(component.render!(200).join("\n").includes("~/alpha/"), "the folder completion is in the draft");
      component.handleInput?.(KEY_ENTER); // submit
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (row 14) → Save changes (row 16)
  ], { cwd: home, keybindings: realKeybindingsManager(mod) });

  await run(harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // expandHomePath joins the home prefix with the remainder verbatim, so the
  // native directory completion's trailing slash is preserved in the save.
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, join(home, "alpha/"), "the completed directory is staged (expanded) and saved");
});
