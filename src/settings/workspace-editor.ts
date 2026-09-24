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
 * workspace, plus a minimal directory-only Tab autocomplete provider attached
 * through the editor's public `setAutocompleteProvider` seam:
 *
 * - Only `/...`, bare `~`, and `~/...` tokens complete; anything else —
 *   including `~user` and relative spellings — leaves Tab alone and is never
 *   anchored against an arbitrary cwd.
 * - Suggestions are existing directories only (symlinks to directories
 *   count); the `~/...` spelling the user typed is preserved in the displayed
 *   suggestions at every depth, root-parented listings stay absolute, and
 *   expansion happens only for filesystem lookup.
 * - Completion replaces exactly the token before the cursor and leaves the
 *   cursor after the inserted path; a directory carries a trailing `/` so a
 *   following Tab descends into it (the host's file-completion convention).
 * - The editor is the single source of truth for the draft: this component
 *   never stores or copies text, and submit resolves with the editor's own
 *   expanded, trimmed output. Esc cancels (`undefined` — the staged value is
 *   unchanged); Enter submits.
 *
 * Everywhere else — no `custom` (RPC/print), host module unloadable, no
 * Editor class, no terminal geometry — the field degrades to the shared text
 * seam (src/settings/text-input.ts): public `ui.editor` prefill first, then
 * the legacy `ui.input`. Host loading failures fail closed into that chain;
 * they never surface as a broken menu or a second draft. Validation and the
 * Save path are unchanged: an entered directory that does not exist is still
 * rejected at Save, so completion can never silently accept an invalid
 * directory. No private Pi member (e.g. ExtensionEditorComponent's internal
 * editor) is touched; the provider attaches through public surface only.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
/** Bound on one suggestion list; keeps huge directories responsive. */
const MAX_SUGGESTIONS = 50;

/** Title shared by every surface of this field (custom, editor, input). */
export const WORKSPACE_EDITOR_TITLE = "Authorized target workspace directory";
/** Static key hint line under the embedded editor box. */
export const WORKSPACE_EDITOR_HINT = "Tab completes directories · Enter submits · Esc cancels";

/** The UI surface this seam needs (host ctx.ui or a structural mock). */
export interface WorkspaceEditorUi extends SettingTextInputUi {
  /** Host custom TUI component (Pi hosts only); guarded by `mode === "tui"`. */
  custom?(factory: MenuCustomFactory): Promise<string | undefined>;
  /** Host run mode ("tui" | "rpc" | ...); carried from the command context. */
  mode?: string;
}

// ---------------------------------------------------------------------------
// Directory-only Tab autocomplete provider (structural pi-tui contract)
// ---------------------------------------------------------------------------

export interface DirectoryAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface DirectoryAutocompleteSuggestions {
  items: DirectoryAutocompleteItem[];
  prefix: string;
}

/** The structural pi-tui AutocompleteProvider surface this field drives. */
export interface DirectoryAutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<DirectoryAutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: DirectoryAutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

export interface DirectoryAutocompleteProviderOptions {
  /** Test seam: the home directory used for `~` expansion (default: os.homedir()). */
  homeDir?: () => string;
}

/** The path token ending at the cursor on its line, plus where it starts. */
function pathTokenAt(lines: string[], cursorLine: number, cursorCol: number): { token: string; start: number } {
  const line = lines[cursorLine] ?? "";
  const end = Math.min(cursorCol, line.length);
  let start = end;
  while (start > 0 && !/\s/.test(line[start - 1]!)) start -= 1;
  return { token: line.slice(start, end), start };
}

/**
 * True for the only spellings this field completes: `/...`, bare `~`, and
 * `~/...`. Anything else — including `~user` (which the shared path rule
 * leaves literal) and relative spellings — never completes, so no suggestion
 * can ever be anchored against the process cwd.
 */
function isCompletableToken(token: string): boolean {
  return token.startsWith("/") || token === "~" || token.startsWith("~/");
}

/**
 * Builds the directory-only Tab autocomplete provider. Suggestions are
 * existing directories under the token's parent (or the token itself when it
 * ends in `/`); `~/...` tokens display `~/...` suggestions at every depth,
 * root-parented listings stay absolute, and filesystem lookup uses the
 * expanded spelling only. Any read failure yields no suggestions rather than
 * an error — completion is a convenience, and the Save-time validation remains
 * the authority on what is accepted.
 */
/**
 * Expands a leading `~`/`~/...` against the provider's own home seam (not
 * os.homedir() directly, so tests can point `~` at a fixture directory).
 */
function expandTilde(token: string, home: string): string {
  if (token === "~") return home;
  if (token.startsWith("~/")) return join(home, token.slice(2));
  return token;
}

export function createDirectoryAutocompleteProvider(
  options: DirectoryAutocompleteProviderOptions = {},
): DirectoryAutocompleteProvider {
  const home = (): string => options.homeDir?.() ?? homedir();

  return {
    async getSuggestions(lines, cursorLine, cursorCol, { signal }) {
      const { token } = pathTokenAt(lines, cursorLine, cursorCol);
      if (!isCompletableToken(token)) return null;
      const expanded = expandTilde(token, home());
      let base: string;
      let namePrefix: string;
      if (expanded === home()) {
        // `~` or `~/`: list the home directory itself.
        base = home();
        namePrefix = "";
      } else if (expanded === "/" || expanded.endsWith("/")) {
        // `~/` expands to `${home}/`; normalize so displays never double-slash.
        base = expanded === "/" ? "/" : expanded.replace(/\/+$/, "");
        namePrefix = "";
      } else {
        base = dirname(expanded);
        namePrefix = basename(expanded);
        if (!namePrefix) return null;
      }
      let entries;
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch {
        // Missing/unreadable parent (including a not-yet-existing final
        // component): no suggestions, nothing to report.
        return null;
      }
      if (signal.aborted) return null;
      const items: DirectoryAutocompleteItem[] = [];
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        let isDirectory = entry.isDirectory();
        if (!isDirectory && entry.isSymbolicLink()) {
          try {
            isDirectory = (await stat(join(base, entry.name))).isDirectory();
          } catch {
            // Broken symlink: not a directory.
          }
        }
        if (!isDirectory) continue;
        if (namePrefix.length > 0 && !entry.name.startsWith(namePrefix)) continue;
        // Display on the spelling the user typed: `~`/`~/...` tokens keep the
        // tilde at every depth (expansion was lookup-only), and root-parented
        // listings stay absolute — a suggestion must never rewrite an entered
        // `/...` token into a relative one.
        const homePath = home();
        let displayBase: string;
        if (base === homePath) {
          displayBase = "~";
        } else if (token.startsWith("~/") && base.startsWith(`${homePath}/`)) {
          displayBase = `~${base.slice(homePath.length)}`;
        } else {
          displayBase = base;
        }
        const display = `${displayBase.endsWith("/") ? displayBase : `${displayBase}/`}${entry.name}/`;
        items.push({ value: display, label: display });
        if (items.length >= MAX_SUGGESTIONS) break;
      }
      return { items, prefix: token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, _prefix) {
      // Recompute the token from live line state rather than trusting the
      // passed prefix: the replacement is exactly what precedes the cursor on
      // that line, whatever the host recorded.
      const { start } = pathTokenAt(lines, cursorLine, cursorCol);
      const end = Math.min(cursorCol, (lines[cursorLine] ?? "").length);
      const line = lines[cursorLine] ?? "";
      const newLines = [...lines];
      newLines[cursorLine] = line.slice(0, start) + item.value + line.slice(end);
      return { lines: newLines, cursorLine, cursorCol: start + item.value.length };
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const { token } = pathTokenAt(lines, cursorLine, cursorCol);
      return isCompletableToken(token);
    },
  };
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
  if (!mod || typeof mod.Editor !== "function") return undefined;
  const provider: HostEditorProvider = {};
  provider.Editor = mod.Editor as HostEditorProvider["Editor"];
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
// The embedded-editor component (host Editor + directory Tab completion)
// ---------------------------------------------------------------------------

export interface WorkspaceEditorComponentOptions {
  /** The loaded pi-tui host surface (Editor constructor + keybinding wiring). */
  host: HostEditorProvider;
  /** The TUI the host injected into the custom component factory. */
  tui: unknown;
  /** The host theme (fg/bold when present; plain text otherwise). */
  theme: unknown;
  /** The live KeybindingsManager the host injects (may be absent). */
  keybindings: unknown;
  /** The currently staged workspace, prefilled and editable. */
  current: string;
  /** Directory provider override (tests); a default one is built otherwise. */
  provider?: DirectoryAutocompleteProvider;
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
  const editor = createHostEditor(options.host, options.tui, options.theme);
  if (!editor) return undefined;
  // Point the standalone pi-tui module's global keybinding state at the live
  // manager (same strategy as src/settings/menu.ts and the question UI), then
  // resolve the effective manager for this component's own cancel handling.
  pointHostEditorModuleAtLiveKeybindings(options.host, options.keybindings);
  const keybindings = resolveLiveKeybindings(options.keybindings, options.host);
  if (options.current) editor.setText(options.current);
  const provider = options.provider ?? createDirectoryAutocompleteProvider();
  if (typeof editor.setAutocompleteProvider === "function") {
    try {
      editor.setAutocompleteProvider(provider);
    } catch {
      // A failing attach leaves the editor without completion — still a fully
      // editable field; nothing is invented to paper over it.
    }
  }
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
      // Esc / Ctrl+C cancel before the editor sees them (the host app would
      // otherwise treat Escape as abort); everything else is the editor's.
      if (keybindings.matches(data, "tui.select.cancel")) {
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
 * interactive TUI with a loadable host Editor, embeds that editor with
 * directory Tab completion; otherwise degrades through the shared text seam
 * (public `ui.editor` prefill, then legacy `ui.input`). Resolves `undefined`
 * on cancel — the staged value is left unchanged.
 */
export async function editWorkspaceDirectory(
  ui: WorkspaceEditorUi,
  current: string,
): Promise<string | undefined> {
  if (ui.mode === "tui" && typeof ui.custom === "function") {
    // Resolution must stay fail-safe at the call site: any loader failure
    // degrades to the shared text seam instead of breaking the menu.
    const host = await resolveWorkspaceTuiHost().catch(() => undefined);
    if (host) {
      try {
        return await ui.custom((tui, theme, keybindings, done) => {
          const component = createWorkspaceEditorComponent({ host, tui, theme, keybindings, current, done });
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
