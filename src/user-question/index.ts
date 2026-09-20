/**
 * Pending-question registration for the top-level extension (issue #95).
 *
 * Wires the three approved surfaces together:
 *
 * - The AskUserQuestion tool, registered before session_start so it enters
 *   the deferred-tool authorization boundary like every other top-level tool
 *   (active by default under Pi's registered-tool policy, discoverable through
 *   search_tools, reasserted by the deferred manager).
 * - A compact pending indicator in the extension status line: one short
 *   segment while questions are pending, cleared when none remain.
 * - The pending-question list UI behind the approved shortcut
 *   (Ctrl+Alt+Up; Ctrl+Option+Up on macOS), registered only when the chord is
 *   not already used by a built-in Pi binding. When registration is
 *   impossible (no shortcut API, occupied chord, non-TUI host) the surface is
 *   unavailable and AskUserQuestion fails closed with an explicit result —
 *   questions are never silently dropped or answered for the user.
 *
 * Session isolation: the controller is bound to the session identity
 * (SessionManager object) at session_start; every registration, presentation,
 * and submission rechecks it, so a question can never be presented in, or
 * answered into, another session after switch/new/fork, and stale UI
 * callbacks are rejected.
 */

import { findOccupiedHostBindings } from "../host-keybindings";
import { sendNotice, setStatus } from "../pi";
import { UserQuestionController, type QuestionSubmitSource } from "./controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY, type QuestionUiTheme } from "./components";
import { loadQuestionTuiHost } from "./pi-tui-host";
import { createUserQuestionTool } from "./tool";

/** Extension status key for the compact pending indicator. */
export const USER_QUESTION_STATUS_KEY = "review-gate-questions";

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
    onStateChange: () => refreshIndicator(pi, controller),
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
        // tests (and diagnostics) await the open attempt.
        handler: (ctx: unknown) => openQuestionList(pi, controller, ctx),
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
    await ui.custom((_tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => {
      const component = createQuestionListComponent({
        controller,
        keybindings: resolveUiKeybindings(keybindings, tuiHost),
        theme: toUiTheme(theme),
        tuiHost,
        shortcutLabel: questionShortcutLabel(),
        onDone: () => done(undefined),
      });
      component.setSourceProbe(sourceProbeOf(ctx));
      return component;
    });
  } catch {
    // The host surfaced the failure itself (error banner); the questions
    // remain pending and the indicator stays visible.
  }
}

function resolveUiKeybindings(
  injected: unknown,
  tuiHost: { getKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined } | undefined,
): { matches(data: string, keybinding: string): boolean } {
  // Prefer the host's live manager (built-in defaults plus the user's
  // keybindings.json); fall back to pi-tui's module-global default
  // resolution; without either, no key can be interpreted and every press is
  // ignored (the raw chord match in the component still closes the list).
  const candidates: unknown[] = [injected];
  if (typeof tuiHost?.getKeybindings === "function") {
    try {
      candidates.push(tuiHost.getKeybindings());
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

function refreshIndicator(pi: unknown, controller: UserQuestionController): void {
  const pending = controller.listPending().length;
  // Questions can only be pending while the shortcut is registered and the
  // session is interactive, so naming the chord here is always actionable.
  setStatus(
    pi,
    USER_QUESTION_STATUS_KEY,
    pending > 0
      ? `${pending} pending question${pending === 1 ? "" : "s"} · ${questionShortcutLabel()}`
      : undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
