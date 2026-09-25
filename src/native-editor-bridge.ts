/**
 * The host-wired native editor bridge for extension text fields (issue #26).
 *
 * One reusable public-API surface for presenting an editable text field that
 * is the running Pi host's own main-prompt editor — not a lookalike. Two
 * consumers share every acquisition and restoration step:
 *
 * - The interactive /review-settings text fields route through
 *   {@link editTextWithNativeEditor}: the bridge installs the factory, opens
 *   its own non-overlay `ctx.ui.custom` slot around the captured instance
 *   (title + editor + hint), and resolves with the submitted value, a cancel,
 *   or an unavailable reason.
 * - The AskUserQuestion list/choices modal routes through
 *   {@link acquireNativeEditorField}: the bridge installs the factory BEFORE
 *   the list's own `ctx.ui.custom` slot opens (installing it mid-list would
 *   make the host swap the visible component), and hands back the SAME
 *   host-wired instance for the modal to embed in its free-text row — no
 *   nested second modal, no second editing engine. The modal owns the
 *   editing episodes (Enter submits the whole answer, Esc returns to the
 *   choice rows with the draft kept) and calls `handle.finish()` when its
 *   slot closes.
 *
 * Shared mechanics for both:
 *
 * - Acquisition: the bridge temporarily installs a factory through the host's
 *   public `ctx.ui.setEditorComponent` seam. The host creates one instance of
 *   the bridge's thin CustomEditor subclass with its own TUI, editor theme,
 *   and live KeybindingsManager, wires the default editor's onSubmit/onChange
 *   onto it, carries the current chat draft into it, attaches the host's own
 *   autocomplete provider (native path completion, the fd-backed `@` picker),
 *   and copies its app-level action handlers (Ctrl+C clear, Ctrl+G external
 *   editor, image paste, ...). The bridge captures that SAME instance; there
 *   is never a copy of it.
 * - Prefill: the host captures the chat draft before a custom slot opens, so
 *   the field prefill is applied after that capture (settings: inside its own
 *   wrapper factory; questions: `handle.prepare("")` inside the list's
 *   factory — the displaced draft must never show or submit as the field's
 *   value). On close the host restores the captured draft into the instance,
 *   and the bridge's ownership-checked factory swap carries it back to the
 *   prior editor — the chat draft survives every open/close exactly once.
 * - Keys: Enter runs Pi's own submit path unmodified (autocomplete confirm,
 *   backslash-Enter workaround, state clear) and settles through the
 *   consumer's {@link NativeEditorFieldSemantics} because the native submit
 *   callback is taken over — the host wires it to the chat submitter when it
 *   creates the instance, so a field can never send a chat message even
 *   under keybinding divergence. If that takeover cannot be assigned and
 *   verified on an exotic host, acquisition fails closed (no field is
 *   presented) instead of degrading: without the takeover, Enter could reach
 *   the chat submitter whenever no live key matcher exists to intercept it.
 *   Esc settles as cancel-equivalent only after
 *   dismissing a visible completion list (the first Esc closes the list),
 *   and Ctrl+D on an empty editor settles instead of exiting Pi; both are
 *   intercepted in the subclass's handleInput using the same KeybindingsManager
 *   the host injected, because the host wires those keys to the chat
 *   editor's interrupt/exit handlers. Everything else — Tab completion,
 *   `@` file picking, cursor/history keys, Ctrl+C clear, Ctrl+G external
 *   editing, image paste, Shift+Enter/Ctrl+J newlines, and every other
 *   app-level action — is Pi's own editor code running unmodified.
 * - Ownership: on finish or failure the bridge restores exactly the factory
 *   `getEditorComponent` reported before this field opened — and only if the
 *   slot still holds the factory this field installed. A foreign editor owned
 *   by another extension is never clobbered; a one-time info notice names the
 *   situation when it occurs.
 * - Session reset: for quit, new, resume, and fork Pi emits `session_shutdown`
 *   before its own `resetExtensionUI()` clears the editor slot. {@link abortActiveNativeEditorField}
 *   (wired to that hook by the settings command and the question surface)
 *   settles the open field as a cancel, ends any open editing episode so the
 *   embedding UI settles too, and puts the displaced chat draft back into the
 *   instance so the host's reset carries the draft — not the field's partial
 *   text — into the default editor. On `/reload` the order is reversed:
 *   `resetExtensionUI()` runs first (carrying the field's partial text into
 *   the default editor), and the abort then only prevents a hang by settling
 *   the field. The bridge never touches the slot after an abort: the host
 *   owns it from that point on.
 * - Fail closed: an interactive TUI without the required seams (settings:
 *   custom + setEditorComponent/getEditorComponent; questions:
 *   setEditorComponent/getEditorComponent), or whose agent module cannot be
 *   loaded, resolves `{ kind: "unavailable" }` and the caller notifies; no
 *   non-parity fallback field is presented. Non-interactive hosts keep their
 *   clearly identified public `ui.editor`/`ui.input` chain (see
 *   src/settings/text-input.ts).
 * - Absolute-path completion (opt-in): a field that passes
 *   `absolutePathSuggestions` (the scheduled-task Workspace directory) gets
 *   one field-scoped decorator over the host-provided autocomplete provider,
 *   installed by overriding the public `setAutocompleteProvider` on the
 *   field's CustomEditor subclass. For first-line leading-slash tokens with
 *   no space (`/`, `/var`, nested absolute paths) it forces the provider's
 *   own native FILE branch — never the slash-command branch — and masks the
 *   returned prefix's leading `/` with a same-length neutral sentinel, so
 *   the editor renders its ordinary file-list layout and its own
 *   applyCompletion takes the file-path branch (no `/command ` insertion).
 *   Every other token (relative, `~/`, `@`, command arguments, later lines)
 *   delegates untouched; all suggestion generation and application stays
 *   Pi's own code — no second completer, matcher, or enumeration. All other
 *   settings fields and the question free-text row keep the host provider
 *   exactly as wired (a leading `/` there remains the chat editor's
 *   slash-command context).
 * - Paste observation: {@link NativeEditorFieldOptions.onHostInsert} is an
 *   observation-only seam of the settings entry point. The host's native
 *   image-paste handler inserts through the editor instance's public
 *   `insertTextAtCursor`, so the bridge wraps that one method on the captured
 *   instance and reports exactly the text Pi's own handler chose to insert
 *   (for an image paste: the temp file path). The bridge performs no
 *   clipboard access, no path interpretation, and copies no asset; callers
 *   may use the observation to learn paste provenance without touching Pi's
 *   native handler.
 *
 * No private Pi member is touched: every attachment point is a public seam —
 * setEditorComponent, getEditorComponent, custom, and the editor's public
 * methods. The agent package and pi-tui are host-provided peers loaded
 * through the shared loader (src/host-peer-loader.ts), never hard
 * dependencies.
 */

import { loadHostPeerModule } from "./host-peer-loader";
import { pointHostEditorModuleAtLiveKeybindings, type HostEditorProvider } from "./host-editor";

const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** The main editor factory as installed through the host's public seam. */
export type NativeEditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => unknown;

/** The non-overlay custom component factory (`ctx.ui.custom`). */
export type NativeEditorCustomFactory = (
  tui: { requestRender?(force?: boolean): void },
  theme: unknown,
  keybindings: unknown,
  done: (value: string | undefined) => void,
) => unknown;

/** The structural UI surface the bridge needs (host ctx.ui or a mock). */
export interface NativeEditorFieldUi {
  /** Non-overlay custom component slot (Pi TUI hosts). */
  custom?(factory: NativeEditorCustomFactory): Promise<string | undefined>;
  /** Public Pi seam: install/replace the main editor factory. */
  setEditorComponent?(factory: NativeEditorFactory | undefined): void;
  /** Public Pi seam: read the installed main editor factory (undefined = default). */
  getEditorComponent?(): NativeEditorFactory | undefined;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

/** Options for one native editor field. */
export interface NativeEditorFieldOptions {
  /** Title rendered above the editor (may be multi-line). */
  title: string;
  /** Editable prefill for the field. Applied after the host captures the chat draft. */
  prefill?: string;
  /** Optional key-hint line under the editor (the bridge default when omitted). */
  hint?: string;
  /**
   * Observation-only paste seam: called with exactly the text Pi's own
   * handlers insert into the field through the editor's public
   * `insertTextAtCursor` (for a native image paste: the temp file path Pi
   * wrote). The bridge does no clipboard access, path heuristics, or asset
   * copying; it only reports what the native handler inserted.
   */
  onHostInsert?: (text: string) => void;
  /**
   * Opt into native absolute-path completion for this field (the
   * scheduled-task Workspace directory only): first-line leading-slash
   * tokens (`/`, `/var`, nested absolute paths) get the host provider's own
   * file suggestions in its ordinary file-list layout — never slash-command
   * items. See the module documentation for the field-scoped decorator.
   */
  absolutePathSuggestions?: boolean;
}

/** The outcome of one native editor field. */
export type NativeEditorFieldResult =
  | { kind: "value"; value: string }
  | { kind: "cancel" }
  | { kind: "unavailable"; reason: string };

/** Default key-hint line under the embedded editor. */
export const NATIVE_EDITOR_FIELD_HINT =
  "Enter submits · Esc dismisses the list, then cancels · Tab completes · Ctrl+C clears · Ctrl+G external editor";

// ---------------------------------------------------------------------------
// Host resolution (shared peer loader + test seams)
// ---------------------------------------------------------------------------

/** The loaded host surface the bridge drives. */
export interface NativeEditorHost {
  /** The agent package's CustomEditor class (extends pi-tui Editor). */
  CustomEditor: new (tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) => NativeEditorBaseInstance;
  /** pi-tui setKeybindings(): sync the module-global keybinding state. */
  tuiSetKeybindings?(keybindings: unknown): void;
  /** pi-tui getKeybindings(): the module-global KeybindingsManager. */
  tuiGetKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined;
}

let hostOverride: NativeEditorHost | undefined;
let hostLoadPromise: Promise<NativeEditorHost | undefined> | undefined;
let hostEntryProvider: (() => string | undefined) | undefined;

/** Test seam: inject a fake host, or clear the override with undefined. */
export function setNativeEditorHost(host: NativeEditorHost | undefined): void {
  hostOverride = host;
  hostLoadPromise = undefined;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation. */
export function setNativeEditorHostEntryProvider(provider: (() => string | undefined) | undefined): void {
  hostEntryProvider = provider;
  hostLoadPromise = undefined;
}

function resolveNativeEditorHost(): Promise<NativeEditorHost | undefined> {
  if (hostOverride !== undefined) return Promise.resolve(hostOverride);
  hostLoadPromise ??= loadNativeEditorHost();
  return hostLoadPromise;
}

// ---------------------------------------------------------------------------
// The field editor: a thin CustomEditor subclass with field semantics
// ---------------------------------------------------------------------------

/**
 * The public pi-tui Editor surface the bridge drives on the captured
 * instance. Mirrors the host-editor adapter contract plus the two methods
 * the bridge observes/wraps.
 */
export interface NativeEditorBaseInstance {
  focused: boolean;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  setText(text: string): void;
  getText(): string;
  /** Stored text with paste markers expanded to their actual content. */
  getExpandedText?(): string;
  /** Whether the native completion list is currently visible. */
  isShowingAutocomplete?(): boolean;
  /** Public insertion seam the host's paste handlers use. */
  insertTextAtCursor?(text: string): void;
}

/** The captured instance plus the bridge-owned field state. */
export interface FieldEditorInstance extends NativeEditorBaseInstance {
  /** Bridge-owned: true while an editing episode is open around this instance. */
  fieldActive: boolean;
  /** Bridge-owned: settle callback for the open editing episode (exactly one call). */
  onFieldSettle?: (value: string | undefined) => void;
  /** Bridge-owned: routes the host-wired native submit path through the field semantics. */
  nativeSubmit(text: string): void;
}

/**
 * Per-consumer key semantics for the settled Enter. The shared part — the
 * native submit path (list-first Esc, empty-editor Ctrl+D never exits Pi,
 * nothing ever forwarded to the host's chat-interrupt path) stays in the
 * bridge; this hook only decides what a settled submit carries.
 */
export interface NativeEditorFieldSemantics {
  /**
   * Called with the text Pi's own submit path produced (paste markers
   * expanded, trimmed) — the host clears the editor state before invoking
   * it. The value to settle, or null to stay open. The settings field
   * settles whatever the editor held (an empty submit clears the setting);
   * the question free-text row stays open on an empty draft so nothing is
   * ever submitted by accident. Note: returning null for non-empty text
   * discards the draft (the native path already cleared it); neither
   * consumer does this.
   */
  onSubmitKey(submittedText: string): string | undefined | null;
}

/** The settings field semantics: Enter always settles with the field value. */
const SETTINGS_FIELD_SEMANTICS: NativeEditorFieldSemantics = {
  onSubmitKey: (text) => text,
};

interface KeyMatcher {
  matches(data: string, keybinding: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type NativeEditorCtor = new (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  options?: unknown,
) => FieldEditorInstance;

// ---------------------------------------------------------------------------
// Field-scoped absolute-path completion (Workspace opt-in)
// ---------------------------------------------------------------------------

/** One public pi-tui autocomplete item. */
export interface NativeAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/** The public pi-tui suggestion result. */
export interface NativeAutocompleteSuggestions {
  items: NativeAutocompleteItem[];
  prefix: string;
}

/** The public pi-tui AutocompleteProvider surface the bridge decorates. */
export interface NativeAutocompleteProvider {
  /** Characters that should naturally trigger this provider at token boundaries. */
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<NativeAutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: NativeAutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** Marker so a re-wired provider is not decorated twice. */
const ABSOLUTE_WORKSPACE_PROVIDER_MARKER = "pi-review-gate:absolute-workspace-provider";

/** Same-length neutral replacement for the leading `/` of an absolute prefix. */
const MASKED_ABSOLUTE_PREFIX_LEAD = "\u0000";

/**
 * True exactly where the host editor treats the token as a slash command:
 * first line, a leading-slash token (ignoring leading whitespace), no space
 * inside it. Command-argument tokens (`/model g`) and later lines are not.
 */
function isLeadingSlashCommandToken(lines: string[], cursorLine: number, cursorCol: number): boolean {
  if (cursorLine !== 0) return false;
  const before = (lines[0] ?? "").slice(0, cursorCol);
  const trimmed = before.trimStart();
  return trimmed.startsWith("/") && !trimmed.includes(" ");
}

/** Masks the leading `/` of an absolute prefix with a same-length sentinel. */
function maskAbsolutePrefixLead(prefix: string): string {
  return prefix.startsWith("/") ? MASKED_ABSOLUTE_PREFIX_LEAD + prefix.slice(1) : prefix;
}

/**
 * Wraps the host-provided autocomplete provider for a field opted into
 * absolute-path mode (the scheduled-task Workspace). For first-line
 * leading-slash tokens it forces the provider's own native FILE branch — so
 * `/`, `/var`, and nested absolute paths list filesystem entries instead of
 * slash commands — and masks the returned prefix's leading `/` with a
 * same-length neutral sentinel. The mask keeps the editor on its ordinary
 * file-list layout (never the two-column command layout), makes its own
 * applyCompletion take the file-path branch (never the slash-command
 * insertion that would stage `/command ` text), and keeps its Enter-confirm
 * from falling through to a submit right after applying. Every other token —
 * relative paths, `~/`, `@`, command arguments, later lines — delegates
 * untouched, and all suggestion generation and application stays Pi's own
 * code: no second completer, matcher, or enumeration.
 */
function wrapAbsoluteWorkspaceProvider(provider: unknown): unknown {
  if (!isRecord(provider) || typeof provider.getSuggestions !== "function") return provider;
  const base = provider as NativeAutocompleteProvider & Record<PropertyKey, unknown>;
  if (base[ABSOLUTE_WORKSPACE_PROVIDER_MARKER] === true) return provider;
  const decorated: NativeAutocompleteProvider = {
    // Forwarded live so the editor's trigger-character setup sees exactly
    // what the host provider advertises.
    get triggerCharacters() {
      return base.triggerCharacters;
    },
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const forced = isLeadingSlashCommandToken(lines, cursorLine, cursorCol);
      const suggestions = await base.getSuggestions(lines, cursorLine, cursorCol, {
        ...options,
        ...(forced ? { force: true } : {}),
      });
      if (!suggestions || !forced) return suggestions;
      return { ...suggestions, prefix: maskAbsolutePrefixLead(suggestions.prefix) };
    },
    // Delegated verbatim: the masked prefix is what routes the native
    // applyCompletion to its file-path branch.
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  };
  if (typeof base.shouldTriggerFileCompletion === "function") {
    decorated.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
      base.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
  }
  Object.defineProperty(decorated, ABSOLUTE_WORKSPACE_PROVIDER_MARKER, { value: true });
  return decorated;
}

/** Per-class options for the field editor subclass. */
interface FieldEditorClassOptions {
  /** Opt into native absolute-path completion (the Workspace field only). */
  absolutePathSuggestions?: boolean;
}

/**
 * Builds the field editor class over the host's CustomEditor. The subclass
 * adds exactly two intercepted outcomes (Esc cancel-equivalent, empty-editor
 * Ctrl+D) plus the settle callback; every other keystroke — including Enter —
 * reaches Pi's own editor code, whose submit path is taken over on the
 * captured instance (acquisition fails closed when that takeover cannot be
 * assigned and verified). With `absolutePathSuggestions` the class also
 * overrides the public setAutocompleteProvider to install the field-scoped
 * absolute-path decorator ({@link wrapAbsoluteWorkspaceProvider}).
 */
function createFieldEditorClass(
  Base: NativeEditorCtor,
  resolveKeyMatcher: () => KeyMatcher | undefined,
  semantics: NativeEditorFieldSemantics,
  options: FieldEditorClassOptions,
): new (tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) => FieldEditorInstance {
  class FieldEditor extends Base {
    fieldActive = false;
    onFieldSettle?: (value: string | undefined) => void;

    handleInput(data: string): void {
      if (this.fieldActive) {
        const matcher = resolveKeyMatcher();
        if (matcher) {
          // List-first: while the completion list is visible, Esc belongs to
          // the editor (it dismisses the list); only after that does it act
          // as cancel-equivalent.
          const listVisible = typeof this.isShowingAutocomplete === "function" && this.isShowingAutocomplete();
          if (!listVisible) {
            if (matcher.matches(data, "app.interrupt")) {
              // Cancel-equivalent. Never forwarded: the host wires this key's
              // app-level handler to the chat editor's interrupt path.
              this.settleField(undefined);
              return;
            }
            if (matcher.matches(data, "app.exit") && this.getText().length === 0) {
              // Empty-editor exit would quit Pi; in a field it settles as
              // cancel-equivalent instead.
              this.settleField(undefined);
              return;
            }
          }
        }
      }
      super.handleInput(data);
    }

    /** The host-wired native submit path, routed through the same semantics. */
    nativeSubmit(text: string): void {
      if (!this.fieldActive) return;
      const value = semantics.onSubmitKey(text);
      if (value !== null) this.settleField(value);
    }

    private settleField(value: string | undefined): void {
      if (!this.fieldActive) return;
      this.fieldActive = false;
      this.onFieldSettle?.(value);
    }
  }
  let fieldClass = FieldEditor as unknown as new (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    options?: unknown,
  ) => FieldEditorInstance;
  if (options.absolutePathSuggestions) {
    // Workspace path mode only: route the host's provider attachment
    // (and any later re-attachment) through the absolute-path decorator.
    // The base is typed with the public pi-tui seam required (the host
    // CustomEditor always has it) without widening the structural instance
    // contract other consumers check against.
    const inner = fieldClass as unknown as new (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      options?: unknown,
    ) => FieldEditorInstance & { setAutocompleteProvider(provider: unknown): void };
    fieldClass = class AbsoluteWorkspaceFieldEditor extends inner {
      setAutocompleteProvider(provider: unknown): void {
        super.setAutocompleteProvider(wrapAbsoluteWorkspaceProvider(provider));
      }
    } as unknown as typeof fieldClass;
  }
  return fieldClass;
}

// ---------------------------------------------------------------------------
// One open field at a time
// ---------------------------------------------------------------------------

interface ActiveFieldSession {
  ui: NativeEditorFieldUi;
  /** The factory getEditorComponent reported before this field opened. */
  priorFactory: unknown;
  /** The factory this field installed (identity-checked on restore). */
  ourFactory: unknown;
  captured: FieldEditorInstance;
  /** The chat draft displaced by the prefill, for session-reset restoration. */
  savedDraft: string;
  /** True once the wrapper factory captured the displaced draft. */
  draftCaptured: boolean;
  /** True once the bridge session is over (episode settle, abort, or finish). */
  settled: boolean;
  /** True once the ownership-checked restore has run (or been waived by an abort). */
  finished: boolean;
  /** False after an abort: the host owns the slot from that point on. */
  restoreOnFinish: boolean;
  settle: (value: string | undefined) => void;
}

let activeSession: ActiveFieldSession | undefined;
let foreignOwnershipNoticed = false;

/**
 * Resolves the open field as a cancel without touching the editor slot.
 * Wired to Pi's `session_shutdown` hook, which fires before the host's own
 * resetExtensionUI() clears the slot: the displaced chat draft is put back
 * into the captured instance so that reset carries the draft — not the
 * field's partial text — into the default editor. Any open editing episode
 * is ended so the embedding UI settles with the field. Idempotent and safe
 * when no field is open.
 */
export function abortActiveNativeEditorField(): void {
  const session = activeSession;
  if (!session || session.settled) return;
  session.settled = true;
  session.finished = true;
  session.restoreOnFinish = false;
  if (activeSession === session) activeSession = undefined;
  if (session.draftCaptured) {
    try {
      session.captured.setText(session.savedDraft);
    } catch {
      // The instance may already be gone; the host's reset still owns the slot.
    }
  }
  const captured = session.captured;
  if (captured && captured.fieldActive) {
    captured.fieldActive = false;
    try {
      captured.onFieldSettle?.(undefined);
    } catch {
      // A broken embedding callback must not block the abort.
    }
  }
  session.settle(undefined);
}

/**
 * Test-only: clears a stuck active field session (e.g. after a test driver
 * threw before the field could settle) so later tests do not cascade-fail
 * with "a native editor field is already open".
 */
export function __resetActiveNativeEditorFieldForTest(): void {
  const session = activeSession;
  if (!session) return;
  session.settled = true;
  session.finished = true;
  activeSession = undefined;
}

// ---------------------------------------------------------------------------
// Shared install / restore core
// ---------------------------------------------------------------------------

interface InstallResult {
  ok: boolean;
  session?: ActiveFieldSession;
  captured?: FieldEditorInstance;
  reason?: string;
}

/**
 * Installs the field editor factory through the host's public seam, captures
 * the synchronously created instance, and takes the native submit path over.
 * Shared by both entry points; on failure the prior factory is restored
 * before the reason is reported. `absolutePathSuggestions` opts this one
 * field into the Workspace absolute-path completion decorator.
 */
function installFieldEditor(
  ui: NativeEditorFieldUi,
  host: NativeEditorHost,
  semantics: NativeEditorFieldSemantics,
  absolutePathSuggestions: boolean,
): InstallResult {
  const getEditorComponent = ui.getEditorComponent!;
  const setEditorComponent = ui.setEditorComponent!;

  let priorFactory: unknown;
  try {
    priorFactory = getEditorComponent();
  } catch {
    return { ok: false, reason: "getEditorComponent failed" };
  }

  // Key matching for the intercepted outcomes: the live manager the host
  // injects first, then the pi-tui module global — the same source the
  // editor's own key handling uses after the best-effort sync below.
  let injectedManager: unknown;
  const resolveKeyMatcher = (): KeyMatcher | undefined => {
    const live = injectedManager;
    if (isRecord(live) && typeof live.matches === "function") {
        const matches = live.matches.bind(live);
        return { matches: (data, keybinding) => Boolean(matches(data, keybinding)) };
      }
    try {
      const manager = host.tuiGetKeybindings?.();
      if (isRecord(manager) && typeof manager.matches === "function") {
        const matches = manager.matches.bind(manager);
        return { matches: (data, keybinding) => Boolean(matches(data, keybinding)) };
      }
    } catch {
      // No usable matcher: the mandatory native submit takeover below still
      // prevents a chat send.
    }
    return undefined;
  };

  const FieldClass = createFieldEditorClass(
    host.CustomEditor as unknown as NativeEditorCtor,
    resolveKeyMatcher,
    semantics,
    { absolutePathSuggestions },
  );
  let captured: FieldEditorInstance | undefined;
  const ourFactory: NativeEditorFactory = (tui, theme, keybindings) => {
    injectedManager = keybindings;
    // The host creates the instance synchronously; capture it for embedding.
    captured = new FieldClass(tui, theme, keybindings);
    return captured;
  };

  try {
    setEditorComponent(ourFactory);
  } catch {
    tryRestorePrior(getEditorComponent, setEditorComponent, ourFactory, priorFactory);
    return { ok: false, reason: "installing the field editor failed" };
  }
  const instance = captured;
  if (!instance) {
    // The host did not create the instance synchronously (unsupported).
    tryRestorePrior(getEditorComponent, setEditorComponent, ourFactory, priorFactory);
    return { ok: false, reason: "the host did not create the field editor synchronously" };
  }

  // The host wired onSubmit to the chat submitter when it created the
  // instance; taking this assignment over is what keeps a field from ever
  // sending a chat message (the native Enter is the normal route). If the
  // takeover cannot be assigned and verified on an exotic host, acquisition
  // fails closed instead of degrading: without the takeover, Enter could
  // reach the chat submitter whenever no live key matcher exists to
  // intercept it, so no field is presented at all.
  const submitTakeover = (text: string): void => instance.nativeSubmit(text);
  let submitTakenOver = false;
  try {
    instance.onSubmit = submitTakeover;
    submitTakenOver = instance.onSubmit === submitTakeover;
  } catch {
    submitTakenOver = false;
  }
  if (!submitTakenOver) {
    tryRestorePrior(getEditorComponent, setEditorComponent, ourFactory, priorFactory);
    return { ok: false, reason: "the native submit path could not be taken over" };
  }

  let session: ActiveFieldSession | undefined;
  try {
    // Point the standalone pi-tui module's global keybinding state at the live
    // manager (same strategy as src/settings/menu.ts): the base Editor resolves
    // its keys through that module global on every input, so without this the
    // instance would not see the user's keybindings.json overrides.
    const keybindingProvider: HostEditorProvider = {};
    if (host.tuiSetKeybindings) keybindingProvider.setKeybindings = host.tuiSetKeybindings;
    pointHostEditorModuleAtLiveKeybindings(keybindingProvider, injectedManager);

    session = {
      ui,
      priorFactory,
      ourFactory,
      captured: instance,
      savedDraft: "",
      draftCaptured: false,
      settled: false,
      finished: false,
      restoreOnFinish: true,
      settle: () => {},
    };
    activeSession = session;

    if (priorFactory !== undefined && !foreignOwnershipNoticed) {
      foreignOwnershipNoticed = true;
      ui.notify?.(
        "Another extension currently owns the main editor; this field uses it temporarily and restores it on close.",
        "info",
      );
    }

    return { ok: true, session, captured: instance };
  } catch {
    // Never leave the slot holding our factory without a live session to
    // restore it, and never leave the one-field latch held for a dead
    // session: an escaping failure (e.g. a throwing notify surface) would
    // otherwise make every later acquisition report "already open".
    if (session && activeSession === session) activeSession = undefined;
    tryRestorePrior(getEditorComponent, setEditorComponent, ourFactory, priorFactory);
    return { ok: false, reason: "preparing the field editor failed" };
  }
}

/**
 * Restores the prior editor factory — but only if the slot still holds the
 * factory this field installed. After an abort (session reset) or any other
 * ownership change the host owns the slot and is left alone.
 */
function tryRestorePrior(
  getEditorComponent: () => NativeEditorFactory | undefined,
  setEditorComponent: (factory: NativeEditorFactory | undefined) => void,
  ourFactory: unknown,
  priorFactory: unknown,
): void {
  try {
    if (getEditorComponent() === ourFactory) {
      setEditorComponent(priorFactory as NativeEditorFactory | undefined);
    }
  } catch {
    // The slot already moved or the host is broken: never clobber whatever
    // owns it now.
  }
}

/**
 * Ends one bridge session: releases the one-field-at-a-time guard, then —
 * unless an abort waived restoration — best-effort restores the displaced
 * chat draft into the instance and swaps back the prior factory.
 */
function finishSession(session: ActiveFieldSession): void {
  if (session.finished) return;
  session.finished = true;
  if (activeSession === session) activeSession = undefined;
  if (!session.restoreOnFinish) return;
  // Normal custom() close already restores the chat draft, but a rejecting
  // host may not. Never copy a partial field value into the prior chat editor.
  // Touch the instance only while our factory still owns the slot.
  try {
    if (session.draftCaptured && session.ui.getEditorComponent?.() === session.ourFactory) {
      session.captured?.setText(session.savedDraft);
    }
  } catch {
    // Restoration remains best-effort if the host editor itself has failed.
  }
  tryRestorePrior(
    session.ui.getEditorComponent!,
    session.ui.setEditorComponent!,
    session.ourFactory,
    session.priorFactory,
  );
}

// ---------------------------------------------------------------------------
// Entry point: settings fields (own custom slot)
// ---------------------------------------------------------------------------

/**
 * Presents one editable text field as the host's own main-prompt editor and
 * resolves with its submitted value, a cancel, or an unavailable reason.
 * See the module documentation for the full contract.
 */
export async function editTextWithNativeEditor(
  ui: NativeEditorFieldUi,
  options: NativeEditorFieldOptions,
): Promise<NativeEditorFieldResult> {
  if (activeSession !== undefined) {
    // Fields are sequential; a second concurrent swap would clobber the first.
    return { kind: "unavailable", reason: "a native editor field is already open" };
  }
  const custom = ui.custom;
  const setEditorComponent = ui.setEditorComponent;
  const getEditorComponent = ui.getEditorComponent;
  if (typeof custom !== "function" || typeof setEditorComponent !== "function" || typeof getEditorComponent !== "function") {
    return { kind: "unavailable", reason: "the host UI is missing the custom/setEditorComponent/getEditorComponent seams" };
  }

  const host = await resolveNativeEditorHost().catch(() => undefined);
  if (!host) {
    return { kind: "unavailable", reason: "the running Pi's editor module is not loadable" };
  }
  if (activeSession !== undefined) {
    // Re-checked after the await: two overlapping opens must not both install.
    return { kind: "unavailable", reason: "a native editor field is already open" };
  }

  const installed = installFieldEditor(ui, host, SETTINGS_FIELD_SEMANTICS, options.absolutePathSuggestions === true);
  if (!installed.ok || !installed.session || !installed.captured) {
    return { kind: "unavailable", reason: installed.reason ?? "installing the field editor failed" };
  }
  const session = installed.session;
  const instance = installed.captured;

  let customFailure = false;
  try {
    const result = await new Promise<string | undefined>((resolve) => {
      session.settle = resolve;
      // A rejecting custom slot is unavailable, not a user cancellation.
      // Keep its failure observable to callers without an unhandled rejection.
      const fail = (): void => {
        if (!session.settled) {
          customFailure = true;
          session.settled = true;
          resolve(undefined);
        }
      };
      try {
        Promise.resolve(
          custom((_tui, theme, _keybindings, done) =>
            buildFieldComponent(instance, options, done, session, theme),
          ),
        ).catch(fail);
      } catch {
        fail();
      }
    });
    return customFailure
      ? { kind: "unavailable", reason: "the custom component slot failed" }
      : result === undefined ? { kind: "cancel" } : { kind: "value", value: result };
  } catch {
    return { kind: "unavailable", reason: "the custom component slot failed" };
  } finally {
    finishSession(session);
  }
}

// ---------------------------------------------------------------------------
// Entry point: embedding in a caller-owned custom component (question list)
// ---------------------------------------------------------------------------

/**
 * The handle for one acquired native editor field embedded in a custom
 * component the caller already owns (the AskUserQuestion list/choices modal).
 */
export interface NativeEditorFieldHandle {
  /** The host-wired instance to embed. It is the single source of truth for the draft text and cursor. */
  readonly instance: FieldEditorInstance;
  /**
   * Record the displaced chat draft and apply the embedding UI's prefill —
   * the question free-text row passes "" so the field starts empty and the
   * displaced draft can never show or submit as its value. Must be called
   * from within the custom component factory (after the host captured its
   * saved text) and before any embedded input; a failing prefill rejects the
   * caller's factory, which restores the host editor.
   */
  prepare(prefill?: string): void;
  /**
   * Ownership-checked restore of the prior editor factory plus best-effort
   * chat-draft restoration. Call exactly once when the surrounding custom
   * slot closes; a no-op after an abort (the host owns the slot) or repeat.
   */
  finish(): void;
}

export type NativeEditorFieldAcquireResult =
  | { kind: "acquired"; handle: NativeEditorFieldHandle }
  | { kind: "unavailable"; reason: string };

/**
 * Acquires the host-wired native editor for embedding in a custom component
 * the caller already owns. Unlike {@link editTextWithNativeEditor} this does
 * not open a slot of its own — the caller's (already-open or about-to-open)
 * non-overlay `ctx.ui.custom` component renders and drives the SAME instance
 * the host wired, so no nested second modal and no second editing engine
 * exist. The caller must:
 *
 * - call `handle.prepare(prefill)` from within its custom component factory
 *   (after the host captured its saved text) before any embedded input;
 * - manage the editing episodes on `handle.instance` (`fieldActive` +
 *   `onFieldSettle`, both bridge-owned fields);
 * - call `handle.finish()` exactly once when its custom slot closes.
 *
 * Acquisition must happen BEFORE the caller's custom slot opens: installing
 * the factory mid-slot would make the host swap the visible component. When
 * the seams or the host module are unavailable the result is `{ kind:
 * "unavailable" }` and the caller keeps its fail-closed behavior (no
 * non-parity fallback field).
 */
export async function acquireNativeEditorField(
  ui: NativeEditorFieldUi,
  options: { semantics: NativeEditorFieldSemantics },
): Promise<NativeEditorFieldAcquireResult> {
  if (activeSession !== undefined) {
    // Fields are sequential; a second concurrent swap would clobber the first.
    return { kind: "unavailable", reason: "a native editor field is already open" };
  }
  const setEditorComponent = ui.setEditorComponent;
  const getEditorComponent = ui.getEditorComponent;
  if (typeof setEditorComponent !== "function" || typeof getEditorComponent !== "function") {
    return { kind: "unavailable", reason: "the host UI is missing the setEditorComponent/getEditorComponent seams" };
  }

  const host = await resolveNativeEditorHost().catch(() => undefined);
  if (!host) {
    return { kind: "unavailable", reason: "the running Pi's editor module is not loadable" };
  }
  if (activeSession !== undefined) {
    // Re-checked after the await: two overlapping opens (e.g. a repeated
    // shortcut chord during the cold host-module load) must not both install.
    return { kind: "unavailable", reason: "a native editor field is already open" };
  }

  // The question free-text row keeps the host's shared main-chat provider
  // behavior exactly as wired — no absolute-path opt-in.
  const installed = installFieldEditor(ui, host, options.semantics, false);
  if (!installed.ok || !installed.session || !installed.captured) {
    return { kind: "unavailable", reason: installed.reason ?? "installing the field editor failed" };
  }
  const session = installed.session;
  const instance = installed.captured;

  let prepared = false;
  const handle: NativeEditorFieldHandle = {
    instance,
    prepare(prefill?: string): void {
      if (prepared) return;
      prepared = true;
      // The host captured the chat draft before this factory ran; record it
      // for session-reset restoration, then apply the prefill (which may be
      // an empty string: the displaced draft must not show in the field).
      try {
        session.savedDraft = instance.getText();
        session.draftCaptured = true;
      } catch {
        session.savedDraft = "";
      }
      if (prefill !== undefined) {
        // A failing prefill rejects the caller's custom factory, which
        // restores the host editor instead of presenting wrong content.
        instance.setText(prefill);
      }
    },
    finish(): void {
      if (session.finished) return;
      session.settled = true;
      finishSession(session);
    },
  };
  return { kind: "acquired", handle };
}

// ---------------------------------------------------------------------------
// The embedded component around the captured instance (settings entry point)
// ---------------------------------------------------------------------------

interface StyledTheme {
  title(text: string): string;
  hint(text: string): string;
}

function toStyledTheme(theme: unknown): StyledTheme {
  const safeFg = (color: string, text: string): string => {
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
    title: (text) => safeFg("accent", bold(text)),
    hint: (text) => safeFg("dim", text),
  };
}

function buildFieldComponent(
  captured: FieldEditorInstance,
  options: NativeEditorFieldOptions,
  done: (value: string | undefined) => void,
  session: ActiveFieldSession,
  theme: unknown,
): unknown {
  // Exactly one settle: the host's done() closes the custom slot (restoring
  // the captured draft into the instance), then our own promise resolves so
  // the ownership-checked factory swap can run. An abort (session reset)
  // settles through session.settle without done — the host is tearing down.
  const settle = (value: string | undefined): void => {
    if (session.settled) return;
    session.settled = true;
    try {
      done(value);
    } catch {
      // The host's close failed; our resolution still settles the field.
    }
    session.settle(value);
  };
  captured.fieldActive = true;
  captured.onFieldSettle = settle;

  // Observation-only paste seam: wrap the one public method the host's native
  // handlers (image paste, plain-text clipboard insert) call on this exact
  // instance. No clipboard access, no path interpretation, no asset copying.
  if (options.onHostInsert) {
    const observer = options.onHostInsert;
    const native = typeof captured.insertTextAtCursor === "function" ? captured.insertTextAtCursor.bind(captured) : undefined;
    if (native) {
      captured.insertTextAtCursor = (text: string): void => {
        native(text);
        try {
          observer(text);
        } catch {
          // Observation must never break the native insertion.
        }
      };
    }
  }

  // The host captured the chat draft before this factory ran; record it for
  // session-reset restoration, then apply the field prefill (which may be an
  // empty string: the displaced draft must not show in the field).
  try {
    session.savedDraft = captured.getText();
    session.draftCaptured = true;
  } catch {
    session.savedDraft = "";
  }
  if (options.prefill !== undefined) {
    // Never show or submit the displaced chat draft as the field's value.
    // A failing prefill rejects custom(), which restores the host editor and
    // reports the field as unavailable instead of presenting wrong content.
    captured.setText(options.prefill);
  }

  const styled = toStyledTheme(theme);
  const titleLines = options.title.split("\n").map((line) => styled.title(line));
  const hintLine = [styled.hint(options.hint ?? NATIVE_EDITOR_FIELD_HINT)];
  let focused = false;
  return {
    get focused(): boolean {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      try {
        captured.focused = value;
      } catch {
        // Focus propagation is best-effort; input still reaches the editor.
      }
    },
    render(width: number): string[] {
      const w = Math.max(1, width);
      return [...titleLines, ...captured.render(w), ...hintLine];
    },
    handleInput(data: string): void {
      if (!session.settled) captured.handleInput(data);
    },
    invalidate(): void {
      try {
        captured.invalidate();
      } catch {
        // The editor owns its own invalidation state.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Host loading (real implementation)
// ---------------------------------------------------------------------------

async function loadNativeEditorHost(): Promise<NativeEditorHost | undefined> {
  const agent = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, { entryProvider: hostEntryProvider, packageMainFallback: true });
  if (!agent || typeof agent.CustomEditor !== "function") return undefined;
  const tui = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: hostEntryProvider, packageMainFallback: true });
  const host: NativeEditorHost = { CustomEditor: agent.CustomEditor as NativeEditorHost["CustomEditor"] };
  if (tui) {
    if (typeof tui.setKeybindings === "function") {
      host.tuiSetKeybindings = (keybindings) => (tui.setKeybindings as (keybindings: unknown) => void)(keybindings);
    }
    if (typeof tui.getKeybindings === "function") {
      host.tuiGetKeybindings = () => {
        const manager = (tui.getKeybindings as () => unknown)();
        return isRecord(manager) && typeof manager.matches === "function"
          ? (manager as { matches(data: string, keybinding: string): boolean })
          : undefined;
      };
    }
  }
  return host;
}
