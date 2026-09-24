/**
 * Pending-question registration for the top-level extension (issue #95).
 *
 * Wires the three approved surfaces together:
 *
 * - The AskUserQuestion tool, registered before session_start so it enters
 *   the deferred-tool authorization boundary like every other top-level tool
 *   (active by default under Pi's registered-tool policy, discoverable through
 *   search_tools, reasserted by the deferred manager).
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
 * Host editor creation, theming, and live-keybinding wiring for the free-text
 * row are shared with other extension surfaces through the host-agnostic
 * adapter in src/host-editor.ts (issue #185).
 *
 * Session isolation: the controller is bound to the session identity
 * (SessionManager object) at session_start; every registration, presentation,
 * and submission rechecks it, so a question can never be presented in, or
 * answered into, another session after switch/new/fork, and stale UI
 * callbacks are rejected.
 */

import { findOccupiedHostBindings } from "../host-keybindings";
import {
  createHostEditor,
  pointHostEditorModuleAtLiveKeybindings,
  resolveLiveKeybindings,
} from "../host-editor";
import { sendNotice } from "../pi";
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
   * Capture the live UI surface from a dispatch context (session hooks,
   * shortcut). The installed host exposes widgets through the event context
   * (`ctx.ui.setWidget`), not through the extension API object, so the panel
   * keeps the most recent context that carries a usable setWidget.
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
  // context (ctx.ui); the extension API object carries no ui member. Keep the
  // most recent dispatch context that carries a usable setWidget and resolve
  // its ui live on every refresh (the host's getter re-resolves per access; a
  // stale context throws and is skipped, leaving no surface — the panel then
  // simply does not render, and the host clears widgets on invalidation).
  let uiContextSource: Record<string, unknown> | undefined;
  const noteContext = (ctx: unknown): void => {
    if (!isRecord(ctx)) return;
    try {
      const ui = ctx.ui;
      if (isRecord(ui) && typeof ui.setWidget === "function") uiContextSource = ctx;
    } catch {
      // A stale context's getter may throw; keep the previous surface.
    }
  };
  const resolveWidgetSurface = ():
    | { setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void }
    | undefined => {
    if (uiContextSource) {
      try {
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
        // always carries a live context; note it so the panel can refresh
        // through it even if an earlier hook context went stale.
        handler: (ctx: unknown) => {
          noteContext(ctx);
          return openQuestionList(pi, controller, ctx);
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

async function openQuestionList(pi: unknown, controller: UserQuestionController, ctx: unknown): Promise<void> {
  const identity = sessionManagerOf(ctx);
  // Recheck the originating session before presenting anything: a stale
  // context (session switched/newed/forked after the key was pressed) must
  // not open another session's questions.
  if (!controller.isSessionBound(identity)) return;
  if (controller.listPending().length === 0) {
    await sendNotice(pi, "review gate: no pending questions");
    return;
  }
  const ui = isRecord(ctx) ? (ctx as Record<string, unknown>).ui : undefined;
  if (!isRecord(ui) || typeof ui.custom !== "function") {
    await sendNotice(
      pi,
      `review gate: the pending-question list UI is not available in this host; questions stay pending (${controller.listPending().length} pending)`,
    );
    return;
  }
  // Load the host pi-tui helpers (width-safe text + raw key matching). A
  // failure degrades rendering/input matching but never blocks the list.
  const tuiHost = await loadQuestionTuiHost().catch(() => undefined);
  try {
    await ui.custom((tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => {
      // Point the standalone pi-tui module's global keybinding state at the
      // app's live manager and resolve the effective manager through the
      // shared host-agnostic adapter (src/host-editor.ts, issue #185). Since
      // pi >= 0.86 the bundled chunk keeps its own inlined copy, so a loaded
      // standalone module is a fresh default-only state; without this the
      // embedded chat editor would not see the user's keybindings.json
      // overrides (same strategy as src/settings/menu.ts).
      pointHostEditorModuleAtLiveKeybindings(tuiHost, keybindings);
      const component = createQuestionListComponent({
        controller,
        keybindings: resolveLiveKeybindings(keybindings, tuiHost),
        theme: toUiTheme(theme),
        tuiHost,
        shortcutLabel: questionShortcutLabel(),
        createAnswerEditor: () => createHostEditor(tuiHost, tui, theme),
        onDone: () => done(undefined),
      });
      component.setSourceProbe(sourceProbeOf(ctx));
      return component;
    });
  } catch {
    // The host surfaced the failure itself (error banner); the questions
    // remain pending and the panel stays visible.
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

/** Live idle probe from the dispatch-time context; see QuestionSubmitSource. */
function sourceProbeOf(ctx: unknown): QuestionSubmitSource | undefined {
  if (!isRecord(ctx) || typeof ctx.isIdle !== "function") return undefined;
  const isIdle = ctx.isIdle.bind(ctx);
  return {
    isIdle: () => {
      try {
        return isIdle();
      } catch {
        // A stale probe must not break delivery: treat as idle (plain send).
        return true;
      }
    },
  };
}

function sessionManagerOf(ctx: unknown): unknown {
  if (!isRecord(ctx)) return undefined;
  const value = (ctx as Record<string, unknown>).sessionManager;
  return typeof value === "object" && value !== null ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
