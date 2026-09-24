/**
 * The scheduled-task workspace directory field for /review-settings
 * (issue #26).
 *
 * This is the one settings text field with a bespoke editor surface. In an
 * interactive Pi TUI where the host's own pi-tui `Editor` can be embedded
 * (host-provided peer, never a hard dependency), it shows exactly that editor
 * — created through the shared host-agnostic adapter (src/host-editor.ts,
 * issue #185) and loaded with the shared peer loader
 * (src/host-peer-loader.ts, issue #185) — prefilled with the currently staged
 * workspace, plus Pi's own native path completion:
 *
 * - The host module's `CombinedAutocompleteProvider` is constructed with no
 *   slash commands and the actual host session cwd carried on the command
 *   context (`ctx.cwd`) as its base path, then attached through the editor's
 *   public `setAutocompleteProvider` seam. This extension carries no
 *   completion algorithm of its own: token recognition, relative/`~`/absolute
 *   handling, platform behavior, the selectable list UI, and selection keys
 *   are all inherited from Pi as-is — including its limitations (a line that
 *   starts with `/` is the host editor's slash-command context, so absolute
 *   paths complete only where the host's own chat editor does; files appear
 *   in the list alongside directories).
 * - The editor is the single source of truth for the draft: this component
 *   never stores or copies text, and submit resolves with the editor's own
 *   expanded, trimmed output. Esc first lets the host editor dismiss a
 *   visible native completion list (its public `isShowingAutocomplete`
 *   seam); only with no list visible does it cancel (`undefined` — the
 *   staged value is unchanged). Enter submits.
 * - Save-time validation is unchanged: an entered path that is not an
 *   existing directory is rejected at Save, so selecting a file from the
 *   completion list cannot bypass the workspace-directory boundary.
 *
 * Everywhere else — no `custom` (RPC/print), host module unloadable, missing
 * Editor or CombinedAutocompleteProvider class, no terminal geometry, or no
 * session cwd on the command context — the field degrades to the shared text
 * seam (src/settings/text-input.ts): public `ui.editor` prefill first, then
 * the legacy `ui.input`. Host loading failures fail closed into that chain;
 * they never surface as a broken menu or a second draft. No private Pi member
 * is touched; both surfaces attach through public seams only.
 */

import {
  createHostEditor,
  pointHostEditorModuleAtLiveKeybindings,
  resolveLiveKeybindings,
  type HostEditorProvider,
} from "../host-editor";
import { loadHostPeerModule } from "../host-peer-loader";
import type { MenuCustomFactory } from "./menu";
import { editSettingText, type SettingTextInputUi } from "./text-input";

const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

/** Title shared by every surface of this field (custom, editor, input). */
export const WORKSPACE_EDITOR_TITLE = "Authorized target workspace directory";
/** Static key hint line under the embedded editor box. */
export const WORKSPACE_EDITOR_HINT = "Tab completes paths · Enter submits · Esc dismisses the list, then cancels";

/** The UI surface this seam needs (host ctx.ui or a structural mock). */
export interface WorkspaceEditorUi extends SettingTextInputUi {
  /** Host custom TUI component (Pi hosts only); guarded by `mode === "tui"`. */
  custom?(factory: MenuCustomFactory): Promise<string | undefined>;
  /** Host run mode ("tui" | "rpc" | ...); carried from the command context. */
  mode?: string;
  /** The host session's working directory, carried from the command context. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Host resolution (shared peer loader + test seams, same pattern as menu.ts)
// ---------------------------------------------------------------------------

let hostOverride: HostEditorProvider | undefined;
let hostLoadPromise: Promise<HostEditorProvider | undefined> | undefined;
let hostEntryProvider: (() => string | undefined) | undefined;

/** Test seam: inject a fake pi-tui host, or clear the override with undefined. */
export function setWorkspaceEditorTuiHost(host: HostEditorProvider | undefined): void {
  hostOverride = host;
  hostLoadPromise = undefined;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 */
export function setWorkspaceEditorTuiHostEntryProvider(provider: (() => string | undefined) | undefined): void {
  hostEntryProvider = provider;
  hostLoadPromise = undefined;
}

function resolveWorkspaceTuiHost(): Promise<HostEditorProvider | undefined> {
  if (hostOverride !== undefined) return Promise.resolve(hostOverride);
  hostLoadPromise ??= loadWorkspaceTuiHost();
  return hostLoadPromise;
}

async function loadWorkspaceTuiHost(): Promise<HostEditorProvider | undefined> {
  const mod = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: hostEntryProvider, packageMainFallback: true });
  // Feature-detect both public surfaces on the same host module; without
  // either one the field degrades to the shared text seam.
  if (!mod || typeof mod.Editor !== "function" || typeof mod.CombinedAutocompleteProvider !== "function") return undefined;
  const provider: HostEditorProvider = {};
  provider.Editor = mod.Editor as HostEditorProvider["Editor"];
  provider.CombinedAutocompleteProvider = mod.CombinedAutocompleteProvider as HostEditorProvider["CombinedAutocompleteProvider"];
  if (typeof mod.setKeybindings === "function") {
    provider.setKeybindings = (keybindings) => {
      (mod.setKeybindings as (keybindings: unknown) => void)(keybindings);
    };
  }
  if (typeof mod.getKeybindings === "function") {
    provider.getKeybindings = () => {
      const manager = (mod.getKeybindings as () => unknown)();
      return isRecord(manager) && typeof manager.matches === "function"
        ? manager as unknown as { matches(data: string, keybinding: string): boolean }
        : undefined;
    };
  }
  return provider;
}

// ---------------------------------------------------------------------------
// The embedded-editor component (host Editor + native path completion)
// ---------------------------------------------------------------------------

export interface WorkspaceEditorComponentOptions {
  /** The loaded pi-tui host surface (Editor + CombinedAutocompleteProvider + keybinding wiring). */
  host: HostEditorProvider;
  /** The TUI the host injected into the custom component factory. */
  tui: unknown;
  /** The host theme (fg/bold when present; plain text otherwise). */
  theme: unknown;
  /** The live KeybindingsManager the host injects (may be absent). */
  keybindings: unknown;
  /** The currently staged workspace, prefilled and editable. */
  current: string;
  /** The host session's working directory anchoring native path completion. */
  cwd: string;
  done: (value: string | undefined) => void;
}

export interface WorkspaceEditorComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  /** Focus flag consumed by the TUI for IME cursor placement; propagated to the editor. */
  focused: boolean;
}

/**
 * Builds the custom component around one host Editor instance, or undefined
 * so the caller degrades (no usable TUI geometry, missing Editor class, or a
 * failing constructor). The editor owns the draft end to end — no copy is
 * kept here — and exactly one of submit/cancel ever reaches `done`.
 */
export function createWorkspaceEditorComponent(
  options: WorkspaceEditorComponentOptions,
): WorkspaceEditorComponent | undefined {
  // Pi's own native path completion: no slash commands, anchored to the host
  // session cwd. Relative/~/absolute handling, list UI, and selection keys
  // are all inherited from the host as-is. The provider class is part of the
  // feature-detect contract (see loadWorkspaceTuiHost): without it — or a
  // failing construction — the field degrades like any other missing surface.
  const ProviderCtor = options.host.CombinedAutocompleteProvider;
  if (typeof ProviderCtor !== "function") return undefined;
  let provider: unknown;
  try {
    provider = new ProviderCtor([], options.cwd);
  } catch {
    return undefined;
  }
  const editor = createHostEditor(options.host, options.tui, options.theme);
  if (!editor || typeof editor.setAutocompleteProvider !== "function" || typeof editor.isShowingAutocomplete !== "function") {
    return undefined;
  }
  try {
    editor.setAutocompleteProvider(provider);
  } catch {
    // Without an attached native provider, use the public editor fallback
    // rather than presenting a custom field that silently lacks completion.
    return undefined;
  }
  // Point the standalone pi-tui module's global keybinding state at the live
  // manager (same strategy as src/settings/menu.ts and the question UI), then
  // resolve the effective manager for this component's own cancel handling.
  pointHostEditorModuleAtLiveKeybindings(options.host, options.keybindings);
  const keybindings = resolveLiveKeybindings(options.keybindings, options.host);
  if (options.current) editor.setText(options.current);
  let focused = false;
  let settled = false;
  const finish = (value: string | undefined): void => {
    if (settled) return;
    settled = true;
    options.done(value);
  };
  editor.onSubmit = (text) => finish(text);
  const styled = toStyledTheme(options.theme);
  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      editor.focused = value;
    },
    render(width: number): string[] {
      const box = editor.render(Math.max(1, width));
      return [styled.title(WORKSPACE_EDITOR_TITLE), ...box, styled.hint(WORKSPACE_EDITOR_HINT)];
    },
    handleInput(data: string): void {
      if (settled) return;
      // Esc / Ctrl+C: let the host editor dismiss a visible native completion
      // list first; only with no list visible does it cancel this field.
      if (keybindings.matches(data, "tui.select.cancel")) {
        if (typeof editor.isShowingAutocomplete === "function" && editor.isShowingAutocomplete()) {
          editor.handleInput(data);
          return;
        }
        finish(undefined);
        return;
      }
      editor.handleInput(data);
    },
    invalidate(): void {
      editor.invalidate();
    },
  };
}

// ---------------------------------------------------------------------------
// The settings seam: custom host editor → public editor → legacy input
// ---------------------------------------------------------------------------

/**
 * Edits the staged workspace directory for one scheduled task. In an
 * interactive TUI with a loadable host Editor and CombinedAutocompleteProvider
 * (and a session cwd on the command context), embeds that editor with Pi's
 * native path completion; otherwise degrades through the shared text seam
 * (public `ui.editor` prefill, then legacy `ui.input`). Resolves `undefined`
 * on cancel — the staged value is left unchanged.
 */
export async function editWorkspaceDirectory(
  ui: WorkspaceEditorUi,
  current: string,
): Promise<string | undefined> {
  const cwd = typeof ui.cwd === "string" && ui.cwd.length > 0 ? ui.cwd : undefined;
  if (ui.mode === "tui" && typeof ui.custom === "function" && cwd !== undefined) {
    // Resolution must stay fail-safe at the call site: any loader failure
    // degrades to the shared text seam instead of breaking the menu.
    const host = await resolveWorkspaceTuiHost().catch(() => undefined);
    if (host) {
      try {
        return await ui.custom((tui, theme, keybindings, done) => {
          const component = createWorkspaceEditorComponent({ host, tui, theme, keybindings, current, cwd, done });
          // No usable editor surface: throw so the host closes the custom
          // slot and we degrade to the public path below.
          if (!component) throw new Error("host editor unavailable");
          return component;
        });
      } catch {
        // Fail closed into the shared seam (public editor, then input).
      }
    }
  }
  return editSettingText(ui, WORKSPACE_EDITOR_TITLE, current);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StyledTheme {
  title(text: string): string;
  hint(text: string): string;
}

function toStyledTheme(theme: unknown): StyledTheme {
  const fg = (color: string, text: string): string => {
    if (isRecord(theme) && typeof theme.fg === "function") {
      try {
        return String((theme.fg as (color: string, text: string) => unknown)(color, text));
      } catch {
        // Unknown color in a non-standard theme; plain text keeps the line.
      }
    }
    return text;
  };
  const bold = (text: string): string => {
    if (isRecord(theme) && typeof theme.bold === "function") {
      try {
        return String((theme.bold as (text: string) => unknown)(text));
      } catch {
        // Unknown color in a non-standard theme; plain text keeps the line.
        return text;
      }
    }
    return text;
  };
  return {
    title: (text) => fg("accent", bold(text)),
    hint: (text) => fg("dim", text),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
