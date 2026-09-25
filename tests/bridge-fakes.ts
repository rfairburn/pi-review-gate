/**
 * Shared fakes and host-resolution helpers for the native editor bridge tests
 * (tests/native-editor-bridge.test.ts) and the settings flow tests that drive
 * a TUI context through the same bridge.
 *
 * Two fidelity tiers, as in the bridge test file:
 * - The structural CustomEditor stand-in + createBridgeUi host simulator pin
 *   the wiring contract (always runs).
 * - loadRealBridgeHost et al. resolve the installed Pi for integration tests
 *   (skip-or-fail via PI_REVIEW_GATE_REQUIRE_PI_HOST).
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { NativeEditorFieldUi, NativeEditorHost } from "../src/native-editor-bridge";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { findInstalledAgentDirs, IDENTITY_THEME } from "./menu-tui-fakes";

export const GEOMETRY_TUI = { terminal: { rows: 40 }, requestRender(): void {} };

/** The app-level key defaults shipped with pi 0.87.1 (non-Windows). */
export const APP_KEY_DEFAULTS: Record<string, string> = {
  "app.interrupt": "escape",
  "app.clear": "ctrl+c",
  "app.exit": "ctrl+d",
  "app.editor.external": "ctrl+g",
  "app.clipboard.pasteImage": "ctrl+v",
};

export const ENTER = "\r";
export const ESCAPE = "\x1b";
export const CTRL_C = "\x03";
export const CTRL_D = "\x04";
export const CTRL_G = "\x07";
export const CTRL_V = "\x16";
export const CTRL_U = "\x15";
export const TAB = "\t";
export const SHIFT_ENTER = "\x1b[13;2u";

export async function settle(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The structural CustomEditor stand-in (wiring tier only — real behavior is
// exercised against the installed Pi in the integration tier below).
// ---------------------------------------------------------------------------

export interface FakeBridgeEditor {
  focused: boolean;
  /** Bridge-owned settle callback, set while a field is open around the instance. */
  onFieldSettle?: (value: string | undefined) => void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  actionHandlers: Map<string, () => void>;
  setAutocompleteProvider(provider: unknown): void;
  provider?: unknown;
  text: string;
  showingList: boolean;
  received: string[];
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  setText(text: string): void;
  getText(): string;
  getExpandedText(): string;
  isShowingAutocomplete(): boolean;
  insertTextAtCursor(text: string): void;
}

/**
 * A minimal editor that mirrors the native key outcomes the bridge passes
 * through (printable append, Ctrl+U clear, Tab opens a fake list, Enter
 * confirms the visible list or submits, Esc dismisses the visible list). It is
 * a stand-in for wiring only — it does not reimplement Pi completion.
 */
export function createFakeCustomEditorClass(
  instances: FakeBridgeEditor[],
): new (tui: unknown, theme: unknown, keybindings: unknown) => FakeBridgeEditor {
  return class FakeCustomEditor {
    focused = false;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    actionHandlers = new Map<string, () => void>();
    provider?: unknown;
    text = "";
    showingList = false;
    received: string[] = [];

    constructor(_tui: unknown, _theme: unknown, _keybindings: unknown) {
      instances.push(this as unknown as FakeBridgeEditor);
    }

    setAutocompleteProvider(provider: unknown): void {
      this.provider = provider;
    }

    setText(text: string): void {
      this.text = text;
      this.onChange?.(text);
    }

    getText(): string {
      return this.text;
    }

    getExpandedText(): string {
      return this.text;
    }

    isShowingAutocomplete(): boolean {
      return this.showingList;
    }

    insertTextAtCursor(text: string): void {
      if (!text) return;
      this.text += text;
      this.onChange?.(this.text);
    }

    handleInput(data: string): void {
      this.received.push(data);
      if (data === CTRL_U) {
        this.text = "";
        return;
      }
      if (data === TAB && /[/@~]$/.test(this.text)) {
        this.showingList = true;
        return;
      }
      if (data === ENTER) {
        if (this.showingList) {
          // Native selection confirm: apply, close the list, no submit.
          this.showingList = false;
          this.text += "assets/";
          return;
        }
        const value = this.text.trim();
        this.text = "";
        this.onSubmit?.(value);
        return;
      }
      if (data === ESCAPE && this.showingList) {
        this.showingList = false;
        return;
      }
      if (data.length === 1 && data >= " ") this.text += data;
    }

    render(_width: number): string[] {
      const lines = [`[field:${this.text}]`];
      if (this.showingList) lines.push("-> assets/", "   guide.md");
      return lines;
    }

    invalidate(): void {}
  };
}

// ---------------------------------------------------------------------------
// Faithful simulation of the host's two public behaviors around the bridge
// ---------------------------------------------------------------------------

export interface BridgeComponent {
  render?(width: number): string[];
  handleInput?(data: string): void;
  focused?: boolean;
}

export interface BridgeUiState {
  /** The chat draft held by the default editor. */
  draft: string;
  /** The installed editor factory (undefined = default editor). */
  slotFactory: unknown;
  /** What the default editor's onSubmit (the chat submitter) received. */
  chatSubmits: string[];
  /** Host-level exit/interrupt handler invocations (must stay 0 in a field). */
  shutdowns: number;
  notices: Array<{ message: string; type?: string }>;
}

/**
 * The simulator drives the bridge's installed factory exactly like the host
 * does; the editor class itself comes from the host set through
 * setNativeEditorHost (the bridge's own resolution path).
 */
export interface BridgeUiOptions {
  /** The live keybindings manager the host injects. */
  keybindings?: unknown;
  /** The editor theme the host passes to factories (defaults to IDENTITY_THEME). */
  theme?: unknown;
  /** The chat draft before the field opens. */
  draft?: string;
  /** A foreign editor factory already installed by another extension. */
  priorFactory?: unknown;
  /** The host's autocomplete provider, attached like the real host does. */
  provider?: unknown;
  /**
   * Additional app-level handlers the host copies onto CustomEditor instances
   * (action -> factory bound to the created instance). The default app.clear
   * simulation (single: clear, double within 500ms: exit) is always present;
   * entries here override or extend it.
   */
  appHandlers?: Record<string, (editor: FakeBridgeEditor) => () => void>;
  /** The host's onPasteImage wiring (its terminal act on the instance). */
  onPasteImage?: (editor: FakeBridgeEditor) => () => void;
  /** One driver per custom() call, in order. */
  drivers: Array<(component: BridgeComponent) => void | Promise<void>>;
}

/**
 * Builds a ui whose setEditorComponent/custom faithfully mirror
 * InteractiveMode.setCustomEditorComponent and showExtensionCustom (the public
 * seam contract the bridge relies on), recording chat submits, host exits, and
 * notices. The installed factory is invoked exactly like the host invokes it;
 * the returned instance is what the bridge captures.
 */
export function createBridgeUi(options: BridgeUiOptions): { ui: NativeEditorFieldUi; state: BridgeUiState } {
  const state: BridgeUiState = {
    draft: options.draft ?? "chat draft",
    slotFactory: options.priorFactory,
    chatSubmits: [],
    shutdowns: 0,
    notices: [],
  };
  const defaultEditor = {
    getText: (): string => state.draft,
    setText: (text: string): void => {
      state.draft = text;
    },
  };
  let instance: { getText(): string; setText(text: string): void } = defaultEditor;
  let driverIndex = 0;

  const ui: NativeEditorFieldUi = {
    setEditorComponent(factory) {
      state.slotFactory = factory;
      if (!factory) {
        // Restore the default editor with text from the custom editor.
        state.draft = instance.getText();
        instance = defaultEditor;
        return;
      }
      const currentText = instance.getText();
      // The host invokes the installed factory (the bridge's own wrapper).
      const editor = factory(GEOMETRY_TUI, options.theme ?? IDENTITY_THEME, options.keybindings ?? null) as FakeBridgeEditor;
      // Wire up callbacks from the default editor (the chat submitter).
      editor.onSubmit = (text) => {
        state.chatSubmits.push(text);
      };
      editor.onChange = (): void => {};
      // Copy text from the previous editor.
      editor.setText(currentText);
      if (options.provider !== undefined) editor.setAutocompleteProvider(options.provider);
      // If extending CustomEditor, copy app-level handlers (duck typing).
      if (editor.actionHandlers instanceof Map) {
        if (!editor.onEscape) editor.onEscape = () => { state.shutdowns += 1; };
        if (!editor.onCtrlD) editor.onCtrlD = () => { state.shutdowns += 1; };
        let lastSigint = 0;
        const defaultAppHandlers: Record<string, () => void> = {
          "app.clear": () => {
            const now = Date.now();
            if (now - lastSigint < 500) state.shutdowns += 1;
            else {
              editor.setText("");
              lastSigint = now;
            }
          },
        };
        for (const [action, handler] of Object.entries(defaultAppHandlers)) {
          editor.actionHandlers.set(action, handler);
        }
        for (const [action, make] of Object.entries(options.appHandlers ?? {})) {
          editor.actionHandlers.set(action, make(editor));
        }
      }
      if (options.onPasteImage && !editor.onPasteImage) {
        editor.onPasteImage = options.onPasteImage(editor);
      }
      instance = editor;
    },
    getEditorComponent() {
      return state.slotFactory as never;
    },
    custom(factory) {
      return new Promise<string | undefined>((resolve, reject) => {
        // showExtensionCustom captures the saved text BEFORE the factory.
        const savedText = instance.getText();
        let closed = false;
        const close = (result: string | undefined): void => {
          if (closed) return;
          closed = true;
          // restoreEditor(): put the saved text back into this.editor.
          instance.setText(savedText);
          resolve(result);
        };
        Promise.resolve(factory(GEOMETRY_TUI, options.theme ?? IDENTITY_THEME, options.keybindings ?? null, close))
          .then((component) => {
            if (closed) return;
            const driver = options.drivers[driverIndex++];
            void (async () => {
              (component as BridgeComponent).render?.(80);
              await driver?.(component as BridgeComponent);
            })().catch(reject);
          })
          .catch((error) => {
            if (!closed) {
              instance.setText(savedText);
              reject(error);
            }
          });
      });
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      state.notices.push({ message, type });
    },
  };
  return { ui, state };
}

/** A live-manager stand-in matching the pi 0.87.1 defaults for the keys tested. */
export function fakeKeybindingsManager(): { matches(data: string, keybinding: string): boolean } {
  const table: Record<string, string[]> = {
    "tui.input.submit": [ENTER],
    "app.interrupt": [ESCAPE],
    "app.exit": [CTRL_D],
    "app.clear": [CTRL_C],
  };
  return {
    matches(data: string, keybinding: string): boolean {
      return (table[keybinding] ?? []).includes(data);
    },
  };
}

export function fakeHost(instances: FakeBridgeEditor[]): NativeEditorHost {
  return { CustomEditor: createFakeCustomEditorClass(instances) as never };
}

// ---------------------------------------------------------------------------
// Real-host resolution (installed Pi's CustomEditor + pi-tui)
// Resolution uses only the explicit test-only install when set
// (PI_REVIEW_GATE_INSTALLED_AGENT points to the package directory in CI),
// otherwise discovers installed agents through findInstalledAgentDirs; under
// PI_REVIEW_GATE_REQUIRE_PI_HOST=1 a missing host fails via skipOrFail.
// ---------------------------------------------------------------------------
export const REAL_IDENTITY_THEME: Record<string, unknown> = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  borderColor: (_color: unknown, text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};

/** Registers the standard real-host test teardown. */
export const realHostAfter = (t: { after(fn: () => void): void }): void => {
  t.after(() => {
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });
};

export interface RealBridgeHost {
  host: NativeEditorHost;
  tui: Record<string, unknown>;
}

/** Resolves the installed Pi's agent package (import-only ESM main entry). */
export async function loadRealBridgeAgent(agentDir: string): Promise<Record<string, unknown> | undefined> {
  const agentPath = join(agentDir, "dist", "index.js");
  try {
    return require(agentPath) as Record<string, unknown>;
  } catch {
    try {
      return (await import(pathToFileURL(agentPath).href)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

export function isRecordWithMatches(value: unknown): value is { matches(data: string, keybinding: string): boolean } {
  return typeof value === "object" && value !== null && typeof (value as { matches?: unknown }).matches === "function";
}

export async function loadRealBridgeHost(): Promise<RealBridgeHost | undefined> {
  for (const agentDir of findInstalledAgentDirs()) {
    let tui: Record<string, unknown>;
    try {
      const requireFromAgent = createRequire(join(agentDir, "package.json"));
      tui = requireFromAgent("@earendil-works/pi-tui") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof tui.Editor !== "function" || typeof tui.CombinedAutocompleteProvider !== "function") continue;
    const agent = await loadRealBridgeAgent(agentDir);
    if (!agent || typeof agent.CustomEditor !== "function") continue;
    const host: NativeEditorHost = { CustomEditor: agent.CustomEditor as NativeEditorHost["CustomEditor"] };
    if (typeof tui.setKeybindings === "function") {
      host.tuiSetKeybindings = (keybindings) => (tui.setKeybindings as (keybindings: unknown) => void)(keybindings);
    }
    if (typeof tui.getKeybindings === "function") {
      host.tuiGetKeybindings = () => {
        const manager = (tui.getKeybindings as () => unknown)();
        return isRecordWithMatches(manager) ? manager : undefined;
      };
    }
    return { host, tui };
  }
  return undefined;
}

/**
 * The live KeybindingsManager the tests inject: pi-tui's public manager over
 * the public TUI definitions plus the app-level defaults shipped with pi
 * 0.87.1 (the agent package does not export its own manager or definitions).
 */
export function createRealKeybindingsManager(
  tui: Record<string, unknown>,
): { matches(data: string, keybinding: string): boolean } {
  const definitions = {
    ...(tui.TUI_KEYBINDINGS as Record<string, unknown>),
    ...Object.fromEntries(Object.entries(APP_KEY_DEFAULTS).map(([id, keys]) => [id, { defaultKeys: keys, description: "" }])),
  };
  const manager = new (tui.KeybindingsManager as new (definitions: unknown, userBindings: unknown) => { matches(data: string, keybinding: string): boolean })(definitions, {});
  (tui.setKeybindings as (keybindings: unknown) => void)(manager);
  return manager;
}

/**
 * Resolves the real fd/fdfind binary pi-tui's `@` picker needs.
 *
 * Resolution order: the explicit test-only path (PI_REVIEW_GATE_FD, exported
 * by CI from its own provisioning step so the check never depends on ambient
 * PATH variance), then PATH. This helper only reads the environment — it
 * never mutates PATH or any other variable, so a test cannot leak a skip (or
 * a pass) into a later test through environment changes.
 */
export function findFdBinary(): string | undefined {
  const explicit = process.env.PI_REVIEW_GATE_FD;
  if (explicit && existsSync(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of ["fd", "fdfind"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function makeDocsFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-real-"));
  await mkdir(join(root, "docs", "assets"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "");
  await writeFile(join(root, "docs", "intro.md"), "");
  await mkdir(join(root, "other"), { recursive: true });
  return root;
}

export const typeText = (component: BridgeComponent, text: string): void => {
  for (const ch of text) component.handleInput?.(ch);
};

/** Skip-or-fail gate: PI_REVIEW_GATE_REQUIRE_PI_HOST=1 makes a missing host a hard failure. */
export function skipOrFail(t: { skip(message?: string): void }, message: string): void {
  if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") {
    const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
    const hint = pinned && message.includes("no installed Pi")
      ? ` (pinned package: ${pinned}; check its package.json, dist/index.js, and pi-tui dependency)`
      : "";
    throw new Error(`required Pi host unavailable: ${message}${hint}`);
  }
  t.skip(message);
}
