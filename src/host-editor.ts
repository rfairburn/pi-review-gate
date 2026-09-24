/**
 * Host-agnostic chat-editor adapter (issue #185).
 *
 * One small reusable internal seam for embedding the running Pi host's chat
 * Editor (pi-tui's `Editor`) inside an extension custom component. The
 * AskUserQuestion free-text row (issue #182) consumes it today; the
 * /review-settings UI (issue #26) is the anticipated next consumer. The
 * adapter carries exactly the host wiring every embedded editor needs —
 * creation, theme, and live-keybinding resolution — and nothing else:
 *
 * - Creation: {@link createHostEditor} constructs the host Editor against
 *   the TUI the host injected into the custom component, styled with a
 *   minimal EditorTheme (the app's muted border color; the editor's
 *   autocomplete list never opens because no provider is set, so its
 *   select-list styling is identity-mapped). A TUI without terminal
 *   geometry, a missing Editor class (unit tests, SEA/binary hosts), or a
 *   failing constructor yields undefined so the caller keeps its own
 *   fallback editor.
 * - Live keybindings: {@link pointHostEditorModuleAtLiveKeybindings} points
 *   the standalone pi-tui module's global keybinding state at the live
 *   manager the host injects into every custom component (since pi >= 0.86
 *   the bundled chunk keeps a fresh default-only copy — same strategy as
 *   src/settings/menu.ts). {@link resolveLiveKeybindings} then picks the
 *   effective KeybindingsManager: the injected live manager first, then the
 *   provider module's own default resolution; without either, no key can be
 *   interpreted and every press is ignored.
 *
 * The adapter never copies editing behavior: the editor remains the single
 * source of truth for draft text and cursor, and every editing keystroke
 * resolves through the host's live KeybindingsManager exactly as in the main
 * chat editor, including user keybindings.json overrides.
 */

/** Select-list styling the host editor theme requires (never visible: no autocomplete provider is set). */
export interface HostEditorSelectListTheme {
  selectedPrefix(text: string): string;
  selectedText(text: string): string;
  description(text: string): string;
  scrollInfo(text: string): string;
  noMatch(text: string): string;
}

/** Theme for the host editor component (border + select-list styling). */
export interface HostEditorTheme {
  borderColor(text: string): string;
  selectList: HostEditorSelectListTheme;
}

/**
 * The host chat-editor surface an embedded editor drives. Mirrors the pi-tui
 * Editor contract; the editor is the single source of truth for the draft
 * text and cursor — the embedding component never stores a copy.
 */
export interface HostEditor {
  /** Focus flag consumed by the TUI for IME cursor placement; the component propagates it. */
  focused: boolean;
  /** Fired by the editor's own submit action with expanded, trimmed text. */
  onSubmit?: (text: string) => void;
  /** Fired after every content change (raw stored text, paste markers included). */
  onChange?: (text: string) => void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  setText(text: string): void;
  /** Stored text with paste markers expanded to their actual content. */
  getExpandedText(): string;
}

/**
 * The host pi-tui surface the adapter needs for editor creation and live
 * keybindings. A provider may expose any subset; the corresponding wiring
 * then simply does not apply (no Editor: the caller keeps its fallback).
 */
export interface HostEditorProvider {
  /** The pi-tui Editor class (host chat editor), when the module exposes it. */
  Editor?: new (tui: unknown, theme: HostEditorTheme) => HostEditor;
  /** The loaded module's public setKeybindings(); see pointHostEditorModuleAtLiveKeybindings. */
  setKeybindings?(keybindings: unknown): void;
  /** The module-global KeybindingsManager (default resolution). */
  getKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined;
}

/**
 * Builds the host chat editor for an embedded free-text row, or undefined so
 * the caller keeps its built-in fallback editor. One instance per embedding
 * session; the caller owns lifecycle (focus, submit wiring, disposal).
 */
export function createHostEditor(
  provider: HostEditorProvider | undefined,
  tui: unknown,
  theme: unknown,
): HostEditor | undefined {
  const EditorCtor = provider?.Editor;
  if (!EditorCtor || !isUsableTui(tui)) return undefined;
  try {
    return new EditorCtor(tui, buildHostEditorTheme(theme));
  } catch {
    // A failing constructor degrades to the fallback editor.
    return undefined;
  }
}

/**
 * Points the provider module's global keybinding state at the live
 * KeybindingsManager the host injected into the custom component. Best-effort
 * and idempotent per component open: a failing sync must not break the
 * component (the injected manager still drives it).
 */
export function pointHostEditorModuleAtLiveKeybindings(
  provider: HostEditorProvider | undefined,
  injected: unknown,
): void {
  if (typeof provider?.setKeybindings !== "function" || !isLiveKeybindingsManager(injected)) return;
  try {
    provider.setKeybindings(injected);
  } catch {
    // Best-effort; the injected manager still drives the component.
  }
}

/**
 * Resolves the effective KeybindingsManager for a custom component: the
 * host-injected live manager (built-in defaults plus the user's
 * keybindings.json) first, then the provider module's own default
 * resolution; without either, no key can be interpreted and every press is
 * ignored.
 */
export function resolveLiveKeybindings(
  injected: unknown,
  provider: HostEditorProvider | undefined,
): { matches(data: string, keybinding: string): boolean } {
  const candidates: unknown[] = [injected];
  if (typeof provider?.getKeybindings === "function") {
    try {
      candidates.push(provider.getKeybindings());
    } catch {
      // Keep the chain moving; the fallback is best-effort.
    }
  }
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.matches === "function") {
      const matches = candidate.matches.bind(candidate);
      return { matches: (data, keybinding) => Boolean(matches(data, keybinding)) };
    }
  }
  return { matches: () => false };
}

/** The host editor renders against the TUI's terminal geometry. */
function isUsableTui(tui: unknown): boolean {
  if (!isRecord(tui)) return false;
  const terminal = (tui as Record<string, unknown>).terminal;
  return isRecord(terminal) && typeof (terminal as Record<string, unknown>).rows === "number";
}

/**
 * EditorTheme for an embedded editor: the app's muted border color (its
 * autocomplete list never opens — no provider is set — so only the border
 * styling is ever visible).
 */
function buildHostEditorTheme(theme: unknown): HostEditorTheme {
  const identity = (text: string): string => text;
  return {
    borderColor: (text) => safeThemeFg(theme, "borderMuted", text),
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
}

function safeThemeFg(theme: unknown, color: string, text: string): string {
  if (isRecord(theme) && typeof theme.fg === "function") {
    try {
      return String((theme.fg as (color: string, text: string) => unknown)(color, text));
    } catch {
      // Unknown color in a non-standard theme; plain text keeps the border.
    }
  }
  return text;
}

/** True only for a real KeybindingsManager instance (live defaults + overrides). */
function isLiveKeybindingsManager(value: unknown): boolean {
  return isRecord(value) && typeof value.matches === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
