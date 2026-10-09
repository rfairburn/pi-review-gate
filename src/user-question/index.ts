/**
 * Pending-question registration for the top-level extension (issue #95).
 *
 * Wires the three approved surfaces together:
 *
 * - The AskUserQuestion tool, registered before session_start so it enters
 *   the deferred-tool authorization boundary like every other top-level tool
 *   (active by default under Pi's registered-tool policy, discoverable through
 *   tool_search, reasserted by the deferred manager).
 * - A persistent collapsed panel above the chat editor (a widget): it shows
 *   only "Pending questions · Press <chord>" — never question text — while
 *   questions are pending, stays visible through chat output without taking
 *   focus, and is removed when no questions remain.
 * - The pending-question list UI behind the approved shortcut
 *   (Ctrl+Alt+Up; Ctrl+Option+Up on macOS), registered only when the chord is
 *   not already used by a built-in Pi binding. When registration is
 *   impossible (no shortcut API, occupied chord, non-TUI host) the surface is
 *   unavailable and AskUserQuestion fails closed with an explicit result —
 *   questions are never silently dropped or answered for the user.
 *
 * The free-text answer row embeds the SAME host-wired native editor instance
 * the /review-settings text fields use, acquired through the shared bridge
 * (src/native-editor-bridge.ts) BEFORE the list's `ctx.ui.custom` slot opens
 * — no nested second modal, no second editing engine. When the host's native
 * seams are unavailable the row renders an unavailable line: the question
 * stays pending and the choices/Decline still work.
 *
 * Session isolation: the controller is bound to the session identity
 * (SessionManager object) at session_start; every registration, presentation,
 * and submission rechecks it, so a question can never be presented in, or
 * answered into, another session after switch/new/fork, and stale UI
 * callbacks are rejected.
 */

import { findOccupiedHostBindings } from "../host-keybindings";
import { resolveLiveKeybindings } from "../host-editor";
import {
  acquireNativeEditorField,
  abortActiveNativeEditorField,
  type NativeEditorFieldHandle,
  type NativeEditorFieldSemantics,
} from "../native-editor-bridge";
import { registerHook, sendNotice } from "../pi";
import { UserQuestionController, type QuestionSubmitSource } from "./controller";
import {
  createQuestionListComponent,
  QUESTION_LIST_SHORTCUT_KEY,
  type QuestionUiTheme,
} from "./components";
import {
  loadQuestionTuiHost,
} from "./pi-tui-host";
import { createUserQuestionTool } from "./tool";

/** Widget key for the persistent collapsed pending-question panel (above the editor). */
export const USER_QUESTION_PANEL_KEY = "review-gate-pending-questions";

/**
 * The only line the collapsed panel ever shows: a notification plus the
 * platform chord. Question text must never appear while collapsed.
 */
export function pendingQuestionPanelLine(): string {
  return `Pending questions · Press ${questionShortcutLabel()}`;
}

const QUESTION_LIST_DESCRIPTION = "Open the pending-question list (answer, defer, or decline model questions)";

/** Platform label for the approved chord; Alt is Option on macOS. */
export function questionShortcutLabel(): string {
  return process.platform === "darwin" ? "Ctrl+Option+Up" : "Ctrl+Alt+Up";
}

export interface UserQuestionSurface {
  controller: UserQuestionController;
  /** True when the question list UI (shortcut) could be registered. */
  uiAvailable: boolean;
  /**
   * Set from session_start: registration alone is not enough — only an
   * interactive TUI host can dispatch keys into the list, so availability
   * also requires the session's mode to be "tui".
   */
  setInteractiveUi(value: boolean): void;
  /**
   * Rebind the panel's widget sink to a session_start context. The installed
   * host exposes widgets through the event context (`ctx.ui.setWidget`), not
   * through the extension API object, and the session context's live ui
   * getter keeps the host's wrapped setWidget in the call chain. Every call
   * retires the previous sink (best-effort clear of its own panel only) — a
   * new session never renders through an old session's surface. Per-press
   * shortcut contexts are NOT sinks: their fresh raw ui bypasses observers
   * of the session surface.
   */
  noteContext(ctx: unknown): void;
  /**
   * Reconcile the persistent panel with current state. Called from
   * session_start in addition to the state-change hook: a new session never
   * inherits another session's panel, and an unusable session identity must
   * clear any stale one even though beginSession does not notify.
   */
  syncPanel(): void;
}

/** True only for an interactive TUI session context (the sole key-dispatching host mode). */
export function contextIsInteractiveTui(ctx: unknown): boolean {
  if (!isRecord(ctx)) return false;
  try {
    // The host context resolves `mode` lazily; a stale/invalidated runner
    // throws, and that must read as "not interactive", never as available.
    return (ctx as { mode?: unknown }).mode === "tui";
  } catch {
    return false;
  }
}

/**
 * Register the pending-question surfaces. Returns undefined on hosts without
 * the tool-registration API (the executor runtime never calls this).
 */
export function registerUserQuestions(pi: unknown): UserQuestionSurface | undefined {
  if (!isRecord(pi) || typeof pi.registerTool !== "function") return undefined;

  let shortcutRegistered = false;
  // registerShortcut exists in every host mode (it only records the entry),
  // so registration alone cannot prove a UI exists: RPC/print/JSON hosts
  // accept the registration but can never dispatch keys into the list. The
  // session_start hook confirms the live mode before any question is accepted.
  let interactiveUi = false;
  const controller = new UserQuestionController({
    pi,
    uiAvailable: () => shortcutRegistered && interactiveUi,
    onStateChange: () => refreshPanel(),
  });

  // The panel is only actionable while the shortcut is registered, the
  // session is interactive, and a usable session identity is bound; in every
  // other state it must be cleared so a stale or unanswerable panel can
  // never be shown.
  const canShowPanel = (): boolean =>
    shortcutRegistered && interactiveUi && controller.currentSessionIdentity() !== undefined;

  // The installed host exposes the widget surface only through the event
  // context (ctx.ui); the extension API object carries no ui member. The
  // panel's widget sink is bound to the SESSION context captured at
  // session_start, whose live ctx.ui getter re-resolves per access so the
  // host's wrapped setWidget stays in the call chain for every refresh.
  // Per-press shortcut contexts carry a fresh RAW ui that bypasses any
  // observer of the session surface: they drive the list (ui.custom, native
  // editor, idle probe) but never become the panel's sink — a clear through
  // one would reach the TUI while leaving observers with a stale presence.
  let uiContextSource: Record<string, unknown> | undefined;
  /** Bumped on every session-bound rebind; fences in-flight UI openings. */
  let bindingGeneration = 0;
  const noteContext = (ctx: unknown): void => {
    // Session boundary: retire the previous sink first, using it only for a
    // best-effort clear of any panel it displayed — never to show the new
    // session's questions. A throwing or missing UI on the replacement
    // retires the old sink too (fail closed: no panel).
    const previous = uiContextSource;
    if (previous) {
      try {
        const ui = previous.ui;
        if (isRecord(ui) && typeof ui.setWidget === "function") {
          ui.setWidget(USER_QUESTION_PANEL_KEY, undefined, { placement: "aboveEditor" });
        }
      } catch {
        // A stale context's getter may throw; the host clears its own
        // widgets on invalidation.
      }
    }
    bindingGeneration += 1;
    uiContextSource = isRecord(ctx) ? ctx : undefined;
  };
  const resolveWidgetSurface = ():
    | { setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void }
    | undefined => {
    if (uiContextSource) {
      try {
        // Resolve the session context's ui live on every refresh (the host's
        // getter re-resolves per access); a stale context throws and leaves
        // no surface — the panel then simply does not render, and the host
        // clears widgets on invalidation.
        const ui = uiContextSource.ui;
        if (isRecord(ui) && typeof ui.setWidget === "function") {
          return ui as {
            setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
          };
        }
      } catch {
        // Stale context (session invalidated); no usable surface remains.
      }
    }
    return undefined;
  };
  const refreshPanel = (): void => {
    const surface = resolveWidgetSurface();
    if (!surface) return; // No widget surface (or a stale one): nothing to show or clear.
    try {
      // Stated explicitly rather than relying on the host's documented
      // "aboveEditor" default: the panel must stay above the chat editor,
      // separate from the below-editor subtask/background indicators.
      surface.setWidget(
        USER_QUESTION_PANEL_KEY,
        canShowPanel() && controller.listPending().length > 0 ? [pendingQuestionPanelLine()] : undefined,
        { placement: "aboveEditor" },
      );
    } catch {
      // The UI context may have gone stale during shutdown; the host clears
      // extension widgets itself when a session is invalidated.
    }
  };

  // Session reset (/new, /resume, quit/fork) fires session_shutdown before
  // the host's own resetExtensionUI() clears the editor slot; settle an open
  // native field as a cancel and put the displaced chat draft back so the
  // reset carries the draft — not a partial answer — into the default editor.
  registerHook(pi, "session_shutdown", () => {
    abortActiveNativeEditorField();
  });

  pi.registerTool(createUserQuestionTool(controller, { shortcutLabel: questionShortcutLabel() }));

  if (typeof pi.registerShortcut === "function") {
    const occupancy = findOccupiedHostBindings(QUESTION_LIST_SHORTCUT_KEY);
    if (occupancy.resolved && occupancy.bindings.length > 0) {
      // Never steal a known host binding: name the collision and leave the
      // surface unavailable; AskUserQuestion then fails closed per question.
      void sendNotice(
        pi,
        `review gate: pending-question shortcut '${questionShortcutLabel()}' is also used by built-in Pi binding(s) (${occupancy.bindings.join(", ")}); the question list cannot be opened and AskUserQuestion reports questions as unavailable`,
      );
    } else {
      pi.registerShortcut(QUESTION_LIST_SHORTCUT_KEY, {
        description: QUESTION_LIST_DESCRIPTION,
        // The returned promise is ignored by the host dispatcher but lets
        // tests (and diagnostics) await the open attempt. A shortcut press
        // carries a fresh per-press context whose raw ui bypasses observers
        // of the session surface; it drives the list only and never becomes
        // the panel's widget sink (that stays bound to session_start).
        handler: (ctx: unknown) => {
          return openQuestionList(pi, controller, ctx, () => bindingGeneration);
        },
      });
      shortcutRegistered = true;
    }
  }

  return {
    controller,
    uiAvailable: shortcutRegistered,
    setInteractiveUi: (value: boolean) => {
      interactiveUi = value;
    },
    noteContext: (ctx: unknown) => noteContext(ctx),
    syncPanel: () => refreshPanel(),
  };
}

/** Bind the controller to a session (session_start). */
export function userQuestionsBeginSession(controller: UserQuestionController | undefined, identity: unknown): void {
  controller?.beginSession(identity);
}

/** Settle every pending question and waiter (session_shutdown). */
export function userQuestionsEndSession(controller: UserQuestionController | undefined): void {
  controller?.endSession();
}

// ----------------------------------------------------------------------
// Question list UI
// ----------------------------------------------------------------------

async function openQuestionList(
  pi: unknown,
  controller: UserQuestionController,
  ctx: unknown,
  bindingGenerationNow: () => number,
): Promise<void> {
  const identity = sessionManagerOf(ctx);
  // Recheck the originating session before presenting anything: a missing or
  // throwing identity is rejected outright (undefined would otherwise read as
  // "some session is bound"), and a stale context (session switched/newed/
  // forked after the key was pressed) must not open another session's
  // questions.
  if (identity === undefined || !controller.isSessionBound(identity)) return;
  const openedAt = bindingGenerationNow();
  const stale = (): boolean => bindingGenerationNow() !== openedAt;
  if (controller.listPending().length === 0) {
    await sendNotice(pi, "review gate: no pending questions");
    return;
  }
  // Resolve the per-press ui guarded: a stale context's getter may throw,
  // and that must fail closed — never reject the handler (the dispatcher
  // ignores its promise) or retarget the widget sink.
  let ui: unknown;
  try {
    ui = isRecord(ctx) ? (ctx as Record<string, unknown>).ui : undefined;
  } catch {
    return; // A throwing ui getter: unavailable.
  }
  let custom: unknown;
  try {
    custom = isRecord(ui) ? ui.custom : undefined;
  } catch {
    return; // A throwing custom getter: unavailable.
  }
  if (!isRecord(ui) || typeof custom !== "function") {
    await sendNotice(
      pi,
      `review gate: the pending-question list UI is not available in this host; questions stay pending (${controller.listPending().length} pending)`,
    );
    return;
  }
  // Load the host pi-tui helpers (width-safe text + raw key matching). A
  // failure degrades rendering/input matching but never blocks the list.
  const tuiHost = await loadQuestionTuiHost().catch(() => undefined);
  // A session rebind during the load retargets this press: the same
  // SessionManager object may be reused across /new/resume, so the identity
  // check alone cannot see it. Never open a stale context's UI.
  if (stale()) return;
  // Acquire the host-wired native editor BEFORE the custom slot opens:
  // installing the factory mid-slot would make the host swap the visible
  // component. Unavailable seams keep the list open with an unavailable
  // free-text row (choices/Decline still work) — no non-parity fallback.
  // The acquisition sees a generation-guarded view of the per-press ui: if
  // the session rebinds during its internal host load, the install seam goes
  // inert so the stale press's editor is never installed into the
  // replacement session's slot. Reads and notifications forward untouched
  // (receivers preserved); the bridge then fails closed (no instance).
  // Read each seam once and guarded: a stale context's getter may throw,
  // and that must fail closed — never reject the handler (the dispatcher
  // ignores its promise).
  let setEditorComponent: ((factory: unknown) => void) | undefined;
  let getEditorComponent: (() => unknown) | undefined;
  let notifyUi: ((message: string, type?: string) => void) | undefined;
  try {
    const set = ui.setEditorComponent;
    const get = ui.getEditorComponent;
    const notify = ui.notify;
    setEditorComponent = typeof set === "function" ? set as (factory: unknown) => void : undefined;
    getEditorComponent = typeof get === "function" ? get as () => unknown : undefined;
    notifyUi = typeof notify === "function" ? notify as (message: string, type?: string) => void : undefined;
  } catch {
    return; // A throwing seam getter: unavailable.
  }
  // The factory this press installed (sentinel until then), so a stale
  // ownership-checked restore can still undo its own install.
  const NO_INSTALLED_FACTORY = Symbol("no-installed-factory");
  let installedFactory: unknown = NO_INSTALLED_FACTORY;
  const acquisitionUi: Record<string, unknown> = {
    notify: notifyUi ? (message: string, type?: string) => notifyUi.call(ui, message, type) : undefined,
    setEditorComponent: setEditorComponent
      ? (factory: unknown) => {
          if (stale()) {
            // Never install into a replacement session's slot. The single
            // exception is undoing this press's own install: the bridge's
            // ownership-checked restore only runs while the slot still holds
            // our factory.
            let current: unknown;
            try {
              current = getEditorComponent ? getEditorComponent.call(ui) : undefined;
            } catch {
              return; // Unreadable slot: leave it alone.
            }
            if (current !== installedFactory) return;
          }
          installedFactory = factory;
          setEditorComponent.call(ui, factory);
        }
      : undefined,
    getEditorComponent: getEditorComponent ? () => getEditorComponent.call(ui) : undefined,
  };
  const acquired = await acquireNativeEditorField(acquisitionUi, { semantics: QUESTION_FIELD_SEMANTICS });
  // A session rebind during the acquisition retargets this press as well.
  if (stale()) {
    if (acquired.kind === "acquired") acquired.handle.finish();
    return;
  }
  const handle: NativeEditorFieldHandle | undefined =
    acquired.kind === "acquired" ? acquired.handle : undefined;
  try {
    // The captured method keeps its original ui receiver: receiver-dependent
    // SDK methods and foreign forwarding wrappers rely on it.
    await custom.call(ui, (_tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => {
      // The host captured its saved text before this factory ran; record it
      // and start the field empty so the displaced chat draft can never show
      // or submit as an answer.
      handle?.prepare("");
      const component = createQuestionListComponent({
        controller,
        keybindings: resolveLiveKeybindings(keybindings, tuiHost),
        theme: toUiTheme(theme),
        tuiHost,
        shortcutLabel: questionShortcutLabel(),
        nativeField: handle?.instance,
        isStale: stale,
        onDone: () => done(undefined),
      });
      component.setSourceProbe(sourceProbeOf(ctx));
      return component;
    });
  } catch {
    // The host surfaced the failure itself (error banner); the questions
    // remain pending and the panel stays visible.
  } finally {
    // Ownership-checked restore of the prior editor factory; a no-op after a
    // session-reset abort (the host owns the slot from that point on).
    handle?.finish();
  }
}

function toUiTheme(theme: unknown): QuestionUiTheme {
  if (isRecord(theme) && typeof theme.fg === "function" && typeof theme.bold === "function") {
    const fg = theme.fg.bind(theme);
    const bold = theme.bold.bind(theme);
    return {
      fg: (color, text) => String(fg(color, text)),
      bold: (text) => String(bold(text)),
    };
  }
  // Degraded (non-Pi hosts, tests): plain text, no styling.
  return { fg: (_color, text) => text, bold: (text) => text };
}

/**
 * The question free-text row's field semantics for the shared bridge: Enter
 * settles with the submitted answer text, or stays open on an empty draft so
 * nothing is ever submitted by accident (Esc/empty-Ctrl+D settle as
 * cancel-equivalent through the bridge and return to the choice rows with
 * the draft kept).
 */
const QUESTION_FIELD_SEMANTICS: NativeEditorFieldSemantics = {
  onSubmitKey: (text) => (text.length > 0 ? text : null),
};

/** Live idle probe from the dispatch-time context; see QuestionSubmitSource. */
function sourceProbeOf(ctx: unknown): QuestionSubmitSource | undefined {
  if (!isRecord(ctx)) return undefined;
  let isIdle: unknown;
  try {
    isIdle = (ctx as Record<string, unknown>).isIdle;
  } catch {
    return undefined; // A throwing getter: probe unavailable.
  }
  if (typeof isIdle !== "function") return undefined;
  const isIdleFn = (isIdle as () => boolean).bind(ctx);
  return {
    isIdle: () => {
      try {
        return isIdleFn();
      } catch {
        // A stale probe must not break delivery: treat as idle (plain send).
        return true;
      }
    },
  };
}

function sessionManagerOf(ctx: unknown): unknown {
  if (!isRecord(ctx)) return undefined;
  let value: unknown;
  try {
    value = (ctx as Record<string, unknown>).sessionManager;
  } catch {
    return undefined; // A throwing getter: identity unavailable.
  }
  return typeof value === "object" && value !== null ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
