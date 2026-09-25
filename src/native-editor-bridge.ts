/**
 * The host-wired native editor bridge for extension text fields (issue #26).
 *
 * One reusable public-API surface for presenting an editable text field that
 * is the running Pi host's own main-prompt editor — not a lookalike. Every
 * interactive /review-settings text field (and, later, other extension text
 * surfaces) routes through {@link editTextWithNativeEditor}:
 *
 * - Acquisition: the bridge temporarily installs a factory through the host's
 *   public `ctx.ui.setEditorComponent` seam. The host creates one instance of
 *   the bridge's thin CustomEditor subclass with its own TUI, editor theme,
 *   and live KeybindingsManager, wires the default editor's onSubmit/onChange
 *   onto it, carries the current chat draft into it, attaches the host's own
 *   autocomplete provider (native path completion, the fd-backed `@` picker),
 *   and copies its app-level action handlers (Ctrl+C clear, Ctrl+G external
 *   editor, image paste, ...). The bridge then embeds that SAME instance in a
 *   non-overlay `ctx.ui.custom` component — one draft, one editor, no copy.
 * - Prefill: the host captures the chat draft before the custom slot opens,
 *   so the field prefill is applied inside the wrapper factory (after that
 *   capture). On close the host restores the captured draft into the instance,
 *   and the bridge's ownership-checked factory swap carries it back to the
 *   prior editor — the chat draft survives every open/close exactly once.
 * - Keys: field semantics are intercepted in the subclass's handleInput using
 *   the same KeybindingsManager the host injected (Enter submits the field
 *   value, Esc cancels after dismissing a visible completion list, Ctrl+D on
 *   an empty editor cancels instead of exiting). Everything else — Tab
 *   completion, `@` file picking, cursor/history keys, Ctrl+C clear, Ctrl+G
 *   external editing, image paste, Shift+Enter/Ctrl+J newlines — is Pi's own
 *   editor code running unmodified. The native submit path is additionally
 *   taken over (the host wires it to the chat submitter), so a field can
 *   never send a chat message even under keybinding divergence.
 * - Ownership: on submit, cancel, or failure the bridge restores exactly the
 *   factory `getEditorComponent` reported before this field opened — and only
 *   if the slot still holds the factory this field installed. A foreign
 *   editor owned by another extension is never clobbered; a one-time info
 *   notice names the situation when it occurs.
 * - Session reset: for quit, new, resume, and fork Pi emits `session_shutdown`
 *   before its own `resetExtensionUI()` clears the editor slot. {@link abortActiveNativeEditorField}
 *   (wired to that hook by the settings command) resolves the open field as a
 *   cancel and puts the displaced chat draft back into the instance so the
 *   host's reset carries the draft — not the field's partial text — into the
 *   default editor. On `/reload` the order is reversed: `resetExtensionUI()`
 *   runs first (carrying the field's partial text into the default editor),
 *   and the abort then only prevents a hang by settling the field. The bridge
 *   never touches the slot after an abort: the host owns it from that point on.
 * - Fail closed: an interactive TUI without the required seams (custom +
 *   setEditorComponent/getEditorComponent), or whose agent module cannot be
 *   loaded, resolves `{ kind: "unavailable" }` and the caller notifies; no
 *   non-parity fallback field is presented. Non-interactive hosts keep their
 *   clearly identified public `ui.editor`/`ui.input` chain (see
 *   src/settings/text-input.ts).
 * - Paste observation: {@link NativeEditorFieldOptions.onHostInsert} is an
 *   optional, observation-only seam. The host's native image-paste handler
 *   inserts through the editor instance's public `insertTextAtCursor`, so the
 *   bridge wraps that one method on the captured instance and reports exactly
 *   the text Pi's own handler chose to insert (for an image paste: the temp
 *   file path). The bridge performs no clipboard access, no path
 *   interpretation, and copies no asset; callers may use the observation to
 *   learn paste provenance without touching Pi's native handler.
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
 * replacement still goes through the same realpath/package.json validation.
 */
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
  /** Bridge-owned: true while a field is open around this instance. */
  fieldActive: boolean;
  /** Bridge-owned: settle callback for the open field (exactly one call). */
  onFieldSettle?: (value: string | undefined) => void;
}

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
) => NativeEditorBaseInstance;

/**
 * Builds the field editor class over the host's CustomEditor. The subclass
 * adds exactly three intercepted outcomes (submit/cancel/empty-exit) plus the
 * settle callback; every other keystroke reaches Pi's own editor code.
 */
function createFieldEditorClass(
  Base: NativeEditorCtor,
  resolveKeyMatcher: () => KeyMatcher | undefined,
): new (tui: unknown, theme: unknown, keybindings: unknown, options?: unknown) => FieldEditorInstance {
  class FieldEditor extends Base {
    fieldActive = false;
    onFieldSettle?: (value: string | undefined) => void;

    handleInput(data: string): void {
      if (this.fieldActive) {
        const matcher = resolveKeyMatcher();
        if (matcher) {
          const listVisible = typeof this.isShowingAutocomplete === "function" && this.isShowingAutocomplete();
          if (!listVisible) {
            if (matcher.matches(data, "tui.input.submit")) {
              this.settleField(this.submittedText());
              return;
            }
            if (matcher.matches(data, "app.interrupt")) {
              // Cancel the field. Never forwarded: the host wires this key's
              // app-level handler to the chat editor's interrupt path.
              this.settleField(undefined);
              return;
            }
            if (matcher.matches(data, "app.exit") && this.getText().length === 0) {
              // Empty-editor exit would quit Pi; in a field it cancels.
              this.settleField(undefined);
              return;
            }
          }
        }
      }
      super.handleInput(data);
    }

    /** Expanded (paste markers resolved), trimmed — the native submit semantics. */
    private submittedText(): string {
      const raw = typeof this.getExpandedText === "function" ? this.getExpandedText() : this.getText();
      return raw.trim();
    }

    private settleField(value: string | undefined): void {
      if (!this.fieldActive) return;
      this.fieldActive = false;
      this.onFieldSettle?.(value);
    }
  }
  return FieldEditor as unknown as new (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    options?: unknown,
  ) => FieldEditorInstance;
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
  captured: FieldEditorInstance | undefined;
  /** The chat draft displaced by the prefill, for session-reset restoration. */
  savedDraft: string;
  /** True once the wrapper factory captured the displaced draft. */
  draftCaptured: boolean;
  settled: boolean;
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
 * field's partial text — into the default editor. Idempotent and safe when
 * no field is open.
 */
export function abortActiveNativeEditorField(): void {
  const session = activeSession;
  if (!session || session.settled) return;
  session.settled = true;
  session.restoreOnFinish = false;
  if (session.draftCaptured) {
    try {
      session.captured?.setText(session.savedDraft);
    } catch {
      // The instance may already be gone; the host's reset still owns the slot.
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
  activeSession = undefined;
}

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

  let priorFactory: unknown;
  try {
    priorFactory = getEditorComponent();
  } catch {
    return { kind: "unavailable", reason: "getEditorComponent failed" };
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
      // No usable matcher: the native submit takeover below still prevents a chat send.
    }
    return undefined;
  };

  const FieldClass = createFieldEditorClass(host.CustomEditor, resolveKeyMatcher);
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
    return { kind: "unavailable", reason: "installing the field editor failed" };
  }
  const instance = captured;
  if (!instance) {
    // The host did not create the instance synchronously (unsupported).
    tryRestorePrior(getEditorComponent, setEditorComponent, ourFactory, priorFactory);
    return { kind: "unavailable", reason: "the host did not create the field editor synchronously" };
  }

  // The host wired onSubmit to the chat submitter when it created the
  // instance; take the native submit path over so a field can never send a
  // chat message (the intercepted Enter is the normal route).
  try {
    instance.onSubmit = (text: string) => instance.onFieldSettle?.(text);
  } catch {
    // A non-assignable onSubmit would still be caught by the interception.
  }

  const session: ActiveFieldSession = {
    ui,
    priorFactory,
    ourFactory,
    captured: instance,
    savedDraft: "",
    draftCaptured: false,
    settled: false,
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
          custom((_tui, theme, keybindings, done) =>
            buildFieldComponent(host, instance, options, done, session, theme, keybindings),
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

function finishSession(session: ActiveFieldSession): void {
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
// The embedded component around the captured instance
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
  host: NativeEditorHost,
  captured: FieldEditorInstance,
  options: NativeEditorFieldOptions,
  done: (value: string | undefined) => void,
  session: ActiveFieldSession,
  theme: unknown,
  injectedKeybindings: unknown,
): unknown {
  // Point the standalone pi-tui module's global keybinding state at the live
  // manager (same strategy as src/settings/menu.ts and the question UI) so
  // the editor's own key handling and the bridge's interception agree.
  const keybindingProvider: HostEditorProvider = {};
  if (host.tuiSetKeybindings) keybindingProvider.setKeybindings = host.tuiSetKeybindings;
  pointHostEditorModuleAtLiveKeybindings(keybindingProvider, injectedKeybindings);

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
