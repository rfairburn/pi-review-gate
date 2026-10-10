/**
 * Pure keyboard sidebar controller and bounded roster/form renderer for the
 * optional custom session host terminal sidebar (#323).
 *
 * Each sidebar row is an independent native process; the main UI is its
 * nativePTY frame, so this module renders ONLY the sidebar-owned panes: the
 * roster snapshot (top-level public agent/input/activity metadata), the
 * New/Edit forms, and the deliberate saved-conversation picker. It returns
 * plain, bounded lines at the supplied pane
 * geometry — `render()` for the focused pane, `renderRoster()`/`renderForm()`
 * for the wide layout that shows both at once. The compositor owns offsets,
 * composition over the native frame, the real TTY, and resizing.
 *
 * Hard boundaries of this module (pure frontend):
 *
 * - No process, PTY, network, filesystem, config, Git, or model work. All
 *   lifecycle/roster truth arrives as `SidebarItem` DTOs from the backend;
 *   launch/workspace validation stays in the backend. No host module is
 *   imported — in particular no TerminalSurface.
 * - UI actions never stop an instance directly: hiding the sidebar,
 *   confirming an item, abandoning a form, or asking to remove or stop a
 *   row only emits visibility/select/create/quit/remove/stop-remove action
 *   DTOs; the backend decides what they mean and performs any process stop.
 *   The sidebar itself never signals a process or deletes persistent files.
 * - Escape in MAIN focus is never intercepted (it stays native input, e.g.
 *   native menu cancellation); while MAIN is focused every chunk — including
 *   `q`/Ctrl+C and terminal-native bytes like bracketed pastes and Kitty key
 *   releases — is forwarded unchanged except the reserved, configurable
 *   toggle chord (legacy and Kitty packets both honored via the real
 *   matchesKey). The reserved chord is two-step: hidden -> show and focus
 *   the sidebar; visible with MAIN focus -> focus the sidebar without a
 *   visibility (resize) action; sidebar-owned focus -> hide and return to
 *   main. Only initial presses act; repeats/releases are consumed.
 * - Each native session renders as a fixed-height card: 5 rows expanded
 *   (default) or 3 collapsed, toggled per card with Space and persisted by
 *   id. Row 1 is ONLY the sanitized canonical title; status (selection
 *   marker, observed/unknown agent/input state), honest background counts
 *   (unknown is never shown as zero), and generic activity follow below.
 *   Scrolling keeps the complete highlighted card visible or falls back to
 *   the too-small pane, and selection-targeted keys (Enter, edit,
 *   stop/remove) act only on an entry the last roster render completely
 *   drew at its current height and order; hiding or overlaying the roster
 *   forgets it.
 * - `d` (and Delete, or x when Delete is the reserved toggle) stops/removes
 *   the highlighted session row: an exited row removes immediately; a settled
 *   error row without a live process requests the same deliberate removal
 *   (the manager stays authoritative and may still refuse); a live owned
 *   process stops only after explicit confirmation unless complete idleness
 *   is positively observed (unknown is never idle); a row with no owned
 *   process and no confirmed exit is refused with a bounded notice.
 *   The stop confirmation freezes the target id and never retargets a later
 *   highlighted row; the quit host confirmation stays separate.
 * - Roster/form/error text is sanitized (C0/C1/DEL and ANSI/OSC/APC
 *   sequences stripped) and bounded before it can appear in a rendered line.
 *   Generated hint text wraps across reserved footer rows instead of being
 *   ellipsized; geometry that cannot show the hints plus a usable pane falls
 *   back to a truthful too-small message.
 *   Only fixed generated SGR (bold 1, inverse 7/27, explicit 0 resets at row
 *   boundaries) is ever emitted; untrusted ESC/OSC-52/title/window commands
 *   can never reach the composed frame. Real pi-tui key matching
 *   (legacy, modifyOtherKeys, and Kitty CSI-u packets) plus the native Editor
 *   adapter provide field editing, grapheme-safe caret movement, and bounded
 *   single-line input.
 * - Editable fields use the native Editor adapter; roster and surrounding form
 *   labels remain plain text + generated SGR.
 *
 * Stable DTO/API surface for future root-host phases: `SidebarItem`,
 * `SidebarAction`, `SidebarControllerOptions`, and `SidebarController` with
 * the getters/setters documented below. Internal shapes may evolve.
 */

import {
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  type KeyId,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "pi-session-host-tui";
import { resolve } from "node:path";
import {
	createSessionHostTextField,
	type SessionHostFieldRejection,
	type SessionHostFieldSubmission,
	type SessionHostTextField,
} from "./field-editor";
import { isValidNativeSessionId, isValidRenameName, type SessionHostNativeSession } from "./protocol";

/** One roster row: a top-level snapshot of one host-owned instance. */
export interface SidebarItem {
  readonly id: string;
  readonly label: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly lifecycle: "starting" | "alive" | "exited" | "error";
  /** True only while the host still owns the instance's native process handle. */
  readonly hasLiveProcess?: boolean;
  /**
   * True only for a remembered conversation that owns no process and cannot be
   * restarted (its row is a bounded placeholder, not a session). Such an entry
   * is never activatable: Enter must not change focus or input ownership.
   */
  readonly unavailable?: boolean;
  /** true/false when observed; null means unknown (never rendered as false). */
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  /** Generic top-level activity lines; at most 2 are rendered, sanitized. */
  readonly activity: readonly string[];
	/** Last validated canonical native conversation identity and display name. */
	readonly nativeSession?: SessionHostNativeSession | null;
  readonly exitCode?: number;
  /**
   * Observed OWNERSHIP count of unsettled background task work from
   * protocol/backend telemetry: active/queued logical work plus every retained
   * cleanup/recovery anchor. Only a nonnegative safe integer is accepted;
   * anything else (including absence) is stored and rendered as unknown, never
   * inferred as zero. This conservative channel gates stop/remove confirmation;
   * it is never used for the displayed activity number.
   */
  readonly backgroundTasks?: number | null;
  /** Observed ownership count of background shell jobs not yet confirmed settled. */
  readonly backgroundShells?: number | null;
  /**
   * Observed ACTIVITY-INTENT count of admitted/running background task work.
   * Same honesty rules as backgroundTasks: anything but a nonnegative safe
   * integer is unknown, never zero. This is the number the card displays and
   * the state behind the running/idle line; an absent value is unknown, never
   * a fallback to the ownership count.
   */
  readonly activeTasks?: number | null;
  /** Observed activity-intent count of starting/running background shells. */
  readonly activeShells?: number | null;
}

/**
 * One saved-conversation row for the deliberate picker (issue 323): identity
 * and canonical caption only. Never a transcript, tool argument, question
 * text, or credential — the read-only listing API guarantees that shape.
 */
export interface SidebarSavedRow {
  readonly id: string;
  readonly file: string;
  readonly caption: string;
  /**
   * The exact recorded workspace (cwd) for this saved conversation, when the
   * catalog supplied one. Display-only metadata: it never affects admission,
   * ordering, or the opaque id/file. Absent/empty means "unavailable".
   */
  readonly cwd?: string;
}

/** Actions the sidebar asks the backend to perform. */
export type SidebarAction =
  | { readonly type: "forward"; readonly data: string }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "resume-row"; readonly requestId: number; readonly id: string }
  | { readonly type: "resume-row-cancel"; readonly requestId: number }
  /**
   * Stop an owned live session and remove its row. confirmed:false is a
   * known-idle request the parent revalidates with fresh idle state;
   * confirmed:true followed a deliberate confirmation of the frozen target.
   */
  | { readonly type: "stop-remove"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "edit"; readonly id: string; readonly nativeSession: SessionHostNativeSession }
  /** Open the saved-conversation picker and list the shared native catalog. */
  | { readonly type: "saved-list"; readonly requestId: number }
  /** Cancel an outstanding listing (dismiss or shutdown); Main aborts its signal. */
  | { readonly type: "saved-cancel"; readonly requestId: number }
  /** Deliberately open one listed conversation as a new independently owned child. */
  | { readonly type: "saved-open"; readonly requestId: number; readonly file: string; readonly sessionId: string }
  | {
      readonly type: "create";
      readonly requestId: number;
      readonly workspace: string;
    }
  | {
      readonly type: "rename";
      readonly requestId: number;
      readonly id: string;
      readonly expectedSessionId: string;
      readonly expectedSessionEpoch: number;
      readonly name: string;
    }
  | { readonly type: "quit" }
  | { readonly type: "visibility"; readonly visible: boolean };

export interface SidebarControllerOptions {
  /** Canonical native KeyId or a bounded known alternative (e.g. "f8"). */
  readonly toggleKey?: string;
  /** Suggested editable workspace path pre-filled in the New session form. */
  readonly initialWorkspace?: string;
  /** Host-startup cwd used by the native path completer for relative input. */
  readonly workspaceBasePath?: string;
  /** Optional Main-owned factory; production supplies current native keybindings and external-editor ownership. */
  readonly createTextField?: (options: SidebarFieldFactoryOptions) => SidebarFieldFactoryResult;
  /** Redraw hook for asynchronous native completion and Editor invalidation. */
  readonly onInvalidate?: () => void;
  /** Initial visibility (default true: the empty welcome picker shows). */
  readonly initialVisible?: boolean;
  readonly onAction?: (action: SidebarAction) => void;
}

export interface SidebarFieldFactoryOptions {
  readonly kind: "name" | "path";
  readonly initialText: string;
  readonly onInvalidate: () => void;
  readonly onSubmit: (submission: SessionHostFieldSubmission) => void;
  readonly onCancel: () => void;
  readonly onReject: (reason: SessionHostFieldRejection) => void;
}

export interface SidebarFieldFactoryResult {
  readonly field: SessionHostTextField;
  readonly matchesCancel?: (data: string) => boolean;
  /**
   * Optional matcher for the field's effective submit key. The submission
   * provenance fence consumes the held submit key's repeat/release, so it must
   * follow the native field's configured binding (e.g. `tui.input.submit`),
   * not assume unmodified Enter.
   */
  readonly matchesSubmit?: (data: string) => boolean;
  readonly notice?: string;
  readonly hints?: {
    readonly submit: string;
    readonly cancel: string;
    readonly complete: string;
    readonly clear: string;
    readonly externalEditor: string;
  };
}

export type SidebarFocus = "main" | "sidebar" | "form" | "confirm";

/**
 * The complete set of generated SGR sequences this renderer may ever embed
 * in a returned line (always between explicit `\x1b[0m` row boundaries).
 */
export const SIDEBAR_GENERATED_SGR_ALLOWLIST: ReadonlySet<string> = new Set([
  "0",
  "1",
  "7",
  "27",
  "1;7",
  // Focus-domain title highlights: blue for the sidebar-selected navigation
  // target, white for the actual active Main conversation (native focus).
  "1;34",
  "1;97",
]);

/** Sidebar-selected navigation-target title highlight (blue). */
const SGR_SELECTION_BLUE = "\x1b[1;34m";
/** Actual active Main conversation title highlight (white). */
const SGR_ACTIVE_MAIN_WHITE = "\x1b[1;97m";

interface SidebarEntry {
  /** Internal key; real item ids are namespaced with "item:" to stay unique. */
  readonly key: string;
  readonly kind: "item" | "saved" | "new" | "quit";
  readonly item?: SidebarItem;
}

interface DisplayedRosterRegion {
  readonly row: number;
  readonly height: number;
  readonly entry: SidebarEntry;
}

interface DisplayedSavedRow {
  readonly paneRow: number;
  readonly index: number;
  readonly entry: SidebarSavedRow;
}

const DEFAULT_TOGGLE_KEY = "alt+left";
// The pinned matcher knows legacy F1-F12 packets but not parameterized CSI
// forms. These tables cover only standard function-key codes with no key
// modifier (Caps/Num Lock bits are ignored, matching public matcher behavior).
const FUNCTION_KEY_BY_TILDE_CODE: Readonly<Record<string, string>> = {
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};
const FUNCTION_KEY_BY_CSI_FINAL: Readonly<Record<string, string>> = {
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};
const FUNCTION_KEY_TILDE_EVENT = /^\x1b\[(\d+);(\d+)(?::([123]))?~$/;
const FUNCTION_KEY_LETTER_EVENT = /^\x1b\[1;(\d+)(?::([123]))?([PQRS])$/;
const PATH_FIELD_MAX_CODEPOINTS = 2048;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DEFAULT_FORM_HINTS = {
  submit: "enter",
  cancel: "esc",
  complete: "tab",
  clear: "ctrl+c",
  externalEditor: "ctrl+g",
};
/** Native-session card heights: title, status, background (+2 activity). */
const CARD_COLLAPSED_ROWS = 3;
const CARD_EXPANDED_ROWS = 5;
const ACTIVITY_LINES_MAX = CARD_EXPANDED_ROWS - CARD_COLLAPSED_ROWS;
const ACTIVITY_INPUT_MAX_CODEPOINTS = 400;
const SAVED_CAPTION_MAX_CODEPOINTS = 256;
/** Bounded recorded-workspace (cwd) display limit; the raw catalog keeps the full value for admission. */
const SAVED_WORKSPACE_MAX_CODEPOINTS = 4096;
/** Fixed reserved details-area height between the saved list and the footer. */
const SAVED_DETAILS_ROWS = 3;
const ITEM_LABEL_INPUT_MAX_CODEPOINTS = 400;
const ERROR_TEXT_MAX_CODEPOINTS = 300;
const ROSTER_MIN_COLS = 12;
const ROSTER_MIN_ROWS = 4;
const FORM_MIN_COLS = 24;
const FORM_MIN_ROWS = 6;
const PANE_MAX_COLS = 1000;
const PANE_MAX_ROWS = 1000;

const ENTRY_NEW_KEY = "new";
const ENTRY_QUIT_KEY = "quit";
const ENTRY_SAVED_KEY = "saved";
const ITEM_KEY_PREFIX = "item:";

const SPECIAL_BASE_KEYS = [
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
] as const;
const SYMBOL_BASE_KEYS = [
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
] as const;
const MODIFIER_NAMES = ["ctrl", "shift", "alt", "super"] as const;

// Key ids are validated case-insensitively (canonical lib ids like pageUp
// and configured variants like pageup must both pass).
const BASE_KEY_IDS: ReadonlySet<string> = new Set<string>([
  ...SPECIAL_BASE_KEYS.map((key) => key.toLowerCase()),
  ...SYMBOL_BASE_KEYS,
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
]);

const LIFECYCLE_VALUES: ReadonlySet<string> = new Set([
  "starting",
  "alive",
  "exited",
  "error",
]);

/**
 * Removes complete terminal control sequences and all remaining C0/C1/DEL
 * controls. Incomplete sequences fail closed by discarding their remainder.
 */
function sanitizeCellText(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    const next = raw[index + 1];
    // 7-bit ESC introducers: CSI and terminal string commands.
    if (code === 0x1b) {
      if (next === "[") {
        let end = index + 2;
        while (end < raw.length) {
          const final = raw.charCodeAt(end);
          end += 1;
          if (final >= 0x40 && final <= 0x7e) {
            break;
          }
        }
        index = end;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        let end = index + 2;
        let terminated = false;
        while (end < raw.length) {
          const current = raw.charCodeAt(end);
          if (current === 0x07 || current === 0x9c) {
            end += 1;
            terminated = true;
            break;
          }
          if (current === 0x1b && raw.charCodeAt(end + 1) === 0x5c) {
            end += 2;
            terminated = true;
            break;
          }
          end += 1;
        }
        index = end;
        if (!terminated) {
          break;
        }
        continue;
      }
      // Other ESC functions have intermediate bytes followed by one final.
      let end = index + 1;
      while (end < raw.length) {
        const current = raw.charCodeAt(end);
        end += 1;
        if (current >= 0x30 && current <= 0x7e) {
          break;
        }
      }
      index = end;
      continue;
    }
    // 8-bit C1 CSI and terminal string introducers.
    if (code === 0x9b) {
      let end = index + 1;
      while (end < raw.length) {
        const final = raw.charCodeAt(end);
        end += 1;
        if (final >= 0x40 && final <= 0x7e) {
          break;
        }
      }
      index = end;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      let end = index + 1;
      let terminated = false;
      while (end < raw.length) {
        const current = raw.charCodeAt(end);
        if (current === 0x07 || current === 0x9c) {
          end += 1;
          terminated = true;
          break;
        }
        if (current === 0x1b && raw.charCodeAt(end + 1) === 0x5c) {
          end += 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      index = end;
      if (!terminated) {
        break;
      }
      continue;
    }
    // Drop controls, including stray ESC string terminators.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1;
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(index) ?? code);
    out += char;
    index += char.length;
  }
  return out;
}

/** Sanitizes and bounds a string by code points. */
function sanitizeBounded(value: unknown, maxCodePoints: number): string {
  const sanitized = sanitizeCellText(value);
  const codePoints = [...sanitized];
  return codePoints.length <= maxCodePoints ? sanitized : codePoints.slice(0, maxCodePoints).join("");
}

function countCodePoints(value: string): number {
  return [...value].length;
}

type KeyEventType = "press" | "repeat" | "release";

/** Exact, modifier-aware fallback for parameterized function-key CSI packets. */
function functionKeyEventType(data: string, key: string): KeyEventType | undefined {
  const tildeMatch = FUNCTION_KEY_TILDE_EVENT.exec(data);
  if (tildeMatch !== null) {
    if (!hasOnlyFunctionKeyLockModifiers(tildeMatch[2]) || FUNCTION_KEY_BY_TILDE_CODE[tildeMatch[1] ?? ""] !== key) {
      return undefined;
    }
    return eventTypeFromDigit(tildeMatch[3]);
  }
  const letterMatch = FUNCTION_KEY_LETTER_EVENT.exec(data);
  if (letterMatch !== null) {
    // CSI 1;1R without an event suffix is indistinguishable from a DSR cursor
    // position report; F3 remains available through its tilde form instead.
    if (letterMatch[2] === undefined && letterMatch[3] === "R") {
      return undefined;
    }
    if (!hasOnlyFunctionKeyLockModifiers(letterMatch[1]) || FUNCTION_KEY_BY_CSI_FINAL[letterMatch[3] ?? ""] !== key) {
      return undefined;
    }
    return eventTypeFromDigit(letterMatch[2]);
  }
  return undefined;
}

function hasOnlyFunctionKeyLockModifiers(value: string | undefined): boolean {
  const modifierValue = Number(value);
  // Public key matching ignores Caps Lock/Num Lock while preserving every
  // independent Shift/Alt/Ctrl/Super bit.
  return [1, 65, 129, 193].includes(modifierValue);
}

function eventTypeFromDigit(value: string | undefined): KeyEventType | undefined {
  switch (value) {
    case undefined:
    case "1":
      return "press";
    case "2":
      return "repeat";
    case "3":
      return "release";
    default:
      return undefined;
  }
}

/**
 * Validates and normalizes the reserved toggle chord against the bounded set
 * supported by the pinned matcher and the exact F-key event fallback. Protected
 * native keys cannot be configured as toggles.
 */
function normalizeToggleKey(raw: string | undefined): string {
  const value = raw ?? DEFAULT_TOGGLE_KEY;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("toggleKey must be a nonempty canonical KeyId string");
  }
  const parts = value.toLowerCase().split("+");
  const base = parts[parts.length - 1];
  if (!base || !BASE_KEY_IDS.has(base)) {
    throw new Error(
      `toggleKey base must be a known native key id, got ${JSON.stringify(base)}`,
    );
  }
  const seen = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    if (!(MODIFIER_NAMES as readonly string[]).includes(part)) {
      throw new Error(`toggleKey has unknown modifier ${JSON.stringify(part)}`);
    }
    if (seen.has(part)) {
      throw new Error(`toggleKey repeats modifier ${JSON.stringify(part)}`);
    }
    seen.add(part);
  }
  if (base === "escape" || base === "esc") {
    throw new Error(
      seen.size === 0
        ? "toggleKey conflicts with native Escape"
        : "toggleKey cannot use modifiers with Escape",
    );
  }
  if (base === "[" && seen.size === 1 && seen.has("ctrl")) {
    throw new Error("toggleKey conflicts with native Escape");
  }
  if (
    base === "q" &&
    (seen.size === 0 || (seen.size === 1 && seen.has("shift")))
  ) {
    throw new Error("toggleKey conflicts with native q/Q");
  }
  if (base === "c" && seen.size === 1 && seen.has("ctrl")) {
    throw new Error("toggleKey conflicts with native Ctrl+C");
  }
  if (/^f(?:[1-9]|1[0-2])$/.test(base) && seen.size > 0) {
    throw new Error("toggleKey cannot use modifiers with function keys");
  }
  if (
    base === "clear" &&
    seen.size > 0 &&
    !(seen.size === 1 && (seen.has("ctrl") || seen.has("shift")))
  ) {
    throw new Error("toggleKey Clear supports only Ctrl or Shift alone");
  }
  // Rewrite the pinned lib's mixed-case ids canonically so validation is
  // case-insensitive but the stored id stays a canonical KeyId.
  const canonicalBase = base === "pageup" ? "pageUp" : base === "pagedown" ? "pageDown" : base;
  return [...seen, canonicalBase].join("+");
}

/** Fixed, generated display label for a normalized toggle key id. */
function toggleDisplayName(key: string): string {
  // Normalization already bounds every component; the complete validated
  // chord is preserved so the footer wrap (or truthful too-small fallback)
  // decides what fits instead of a partial, misleading label.
  const display = sanitizeCellText(key);
  return display
    .split("+")
    .map((part) => (/[a-z]/.test(part.charAt(0)) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("+");
}

/** Printable text of one chunk: Kitty CSI-u decoding or a single byte. */
function printableOf(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) {
    const sanitized = sanitizeBounded(kitty, 1);
    return sanitized.length === 1 ? sanitized : undefined;
  }
  if (data.length === 1) {
    const code = data.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      return data;
    }
  }
  return undefined;
}

/** Wraps one padded pane row with explicit SGR reset boundaries. */
function wrapRow(text: string, cols: number, sgr?: string): string {
  const padded = truncateToWidth(text, cols, "...", true);
  return sgr === undefined
    ? `\x1b[0m${padded}\x1b[0m`
    : `\x1b[0m${sgr}${padded}\x1b[0m`;
}

/**
 * Word-wraps generated hint segments into lines of at most `cols` visible
 * width, separated by " | ". Hints are never ellipsized: a segment that does
 * not fit moves whole to the next line, and only a segment wider than the
 * pane is word-wrapped. Returns undefined when even one word cannot fit, so
 * callers fall back to the truthful too-small pane instead of half-hints.
 */
function wrapHintLines(segments: readonly string[], cols: number): string[] | undefined {
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (visibleWidth(segment) > cols) {
      // Wider than the pane as a unit: it starts its own line and word-wraps,
      // so hint separators are never lost or merged.
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (const word of segment.split(" ")) {
        if (word.length === 0) continue;
        if (visibleWidth(word) > cols) return undefined;
        const candidate = current === "" ? word : `${current} ${word}`;
        if (visibleWidth(candidate) <= cols) {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      continue;
    }
    const candidate = current === "" ? segment : `${current} | ${segment}`;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
    } else {
      lines.push(current);
      current = segment;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function blankLines(count: number): string[] {
  return Array.from({ length: count }, () => "");
}

/**
 * Truthful card status text (the line below the title): lifecycle or
 * observed/unknown agent state, plus observed/unknown input state for live
 * rows. Unknown (null) is never rendered as if it were false.
 */
function cardStatusText(item: SidebarItem): string {
  const parts: string[] = [];
  switch (item.lifecycle) {
    case "starting":
      parts.push("starting");
      break;
    case "alive":
      parts.push(
        item.busy === true || (sanitizeCount(item.activeTasks) ?? 0) > 0
          || (sanitizeCount(item.activeShells) ?? 0) > 0
          ? "agent running"
          : item.pendingInput === true || item.inputSurface === true
            ? "agent waiting"
            : item.busy === false && item.pendingInput === false
              && sanitizeCount(item.activeTasks) === 0 && sanitizeCount(item.activeShells) === 0
              ? "agent idle"
              : "agent unknown",
      );
      break;
    case "exited":
      parts.push(
        typeof item.exitCode === "number"
          ? `exited (code ${Math.trunc(item.exitCode)})`
          : "exited",
      );
      break;
    case "error":
      parts.push(
        typeof item.exitCode === "number"
          ? `error (code ${Math.trunc(item.exitCode)})`
          : "error",
      );
      break;
  }
  if (item.lifecycle === "starting" || item.lifecycle === "alive") {
    parts.push(
      item.pendingInput === true || item.inputSurface === true
        ? "input pending"
        : item.pendingInput === false
          ? "input none"
          : "input unknown",
    );
  }
  return parts.join(" | ");
}

/** Honest ACTIVITY-INTENT counts: a missing/invalid count is "unknown", never 0. */
function cardBackgroundText(item: SidebarItem): string {
  const tasks = sanitizeCount(item.activeTasks);
  const shells = sanitizeCount(item.activeShells);
  if (tasks === null && shells === null) {
    return "background unknown";
  }
  return `bg tasks ${tasks ?? "unknown"} | shells ${shells ?? "unknown"}`;
}

/** Accepts only nonnegative safe integers; everything else is unknown. */
function sanitizeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.abs(value) // normalizes -0
    : null;
}

/** Canonical card title: validated native name, else the row label. */
function cardTitle(item: SidebarItem): string {
  return sanitizeBounded(item.nativeSession?.name ?? item.label, ITEM_LABEL_INPUT_MAX_CODEPOINTS);
}

function requiresQuitConfirmation(item: SidebarItem): boolean {
  return (
    item.lifecycle === "starting" ||
    item.lifecycle === "alive" ||
    item.hasLiveProcess === true
  );
}

/**
 * Complete idleness, positively observed: every activity category and modal
 * input known-false or known-zero. Unknown (null) states or counts are never
 * idle. The caller already established hasLiveProcess === true. This reads the
 * conservative OWNERSHIP channel, deliberately not the displayed
 * activity-intent counts: retained cleanup/recovery work still requires
 * confirmation before a stop or removal.
 */
function isCompleteIdle(item: SidebarItem): boolean {
  return (
    item.busy === false &&
    item.pendingInput === false &&
    item.inputSurface === false &&
    sanitizeCount(item.backgroundTasks) === 0 &&
    sanitizeCount(item.backgroundShells) === 0
  );
}

function copyItem(item: SidebarItem): SidebarItem {
  if (typeof item !== "object" || item === null) {
    throw new Error("SidebarItem must be an object");
  }
  if (typeof item.id !== "string" || item.id.length === 0) {
    throw new Error("SidebarItem.id must be a nonempty string");
  }
  if (typeof item.lifecycle !== "string" || !LIFECYCLE_VALUES.has(item.lifecycle)) {
    throw new Error(
      `SidebarItem.lifecycle must be a known lifecycle, got ${JSON.stringify(item.lifecycle)}`,
    );
  }
  if (item.busy !== null && typeof item.busy !== "boolean") {
    throw new Error("SidebarItem.busy must be a boolean or null");
  }
  if (item.pendingInput !== null && typeof item.pendingInput !== "boolean") {
    throw new Error("SidebarItem.pendingInput must be a boolean or null");
  }
  if (typeof item.inputSurface !== "boolean") {
    throw new Error("SidebarItem.inputSurface must be a boolean");
  }
  if (item.hasLiveProcess !== undefined && typeof item.hasLiveProcess !== "boolean") {
    throw new Error("SidebarItem.hasLiveProcess must be a boolean when provided");
  }
  return {
    id: item.id,
    label: typeof item.label === "string" ? item.label : "",
    workspace: typeof item.workspace === "string" ? item.workspace : "",
    agentDir: typeof item.agentDir === "string" ? item.agentDir : "",
    lifecycle: item.lifecycle,
    ...(typeof item.hasLiveProcess === "boolean" ? { hasLiveProcess: item.hasLiveProcess } : {}),
    ...(item.unavailable === true ? { unavailable: true } : {}),
    busy: item.busy,
    pendingInput: item.pendingInput,
    inputSurface: item.inputSurface,
    activity: Array.isArray(item.activity) ? [...item.activity] : [],
    ...(item.nativeSession === null ? { nativeSession: null }
      : item.nativeSession && isValidNativeSessionId(item.nativeSession.sessionId)
        && Number.isSafeInteger(item.nativeSession.epoch) && item.nativeSession.epoch > 0
        && isValidRenameName(item.nativeSession.name)
        ? { nativeSession: { ...item.nativeSession } }
        : {}),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    backgroundTasks: sanitizeCount(item.backgroundTasks),
    backgroundShells: sanitizeCount(item.backgroundShells),
    activeTasks: sanitizeCount(item.activeTasks),
    activeShells: sanitizeCount(item.activeShells),
  };
}

function assertPaneDimension(value: number, max: number, label: "cols" | "rows"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(
      `Sidebar render ${label} must be a safe integer between 1 and ${max}, got ${value}`,
    );
  }
}

function validHitGeometry(column: number, row: number, cols: number, rows: number): boolean {
  return Number.isSafeInteger(column) && column >= 0 && Number.isSafeInteger(row) && row >= 0
    && Number.isSafeInteger(cols) && cols > 0 && column < cols
    && Number.isSafeInteger(rows) && rows > 0 && row < rows;
}

function markerSuffixLength(value: string, marker: string): number {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

export class SidebarController {
  private readonly toggleKey: string;
  private readonly toggleLabel: string;
  private readonly onAction?: (action: SidebarAction) => void;
  private readonly onInvalidate?: () => void;
  private readonly workspaceBasePath: string;
  private readonly createTextField?: SidebarControllerOptions["createTextField"];
  private formField?: SessionHostTextField;
  private formMatchesCancel: (data: string) => boolean = (data) => matchesKey(data, "escape");
  /** Effective native submit-key matcher for the current form field. */
  private formMatchesSubmit: (data: string) => boolean = (data) => matchesKey(data, "enter");
  /**
   * The exact canonical key id of the field input currently being handled,
   * captured only while it synchronously submits the New form. This
   * distinguishes which configured submit binding actually fired when several
   * keys are bound to `tui.input.submit`.
   */
  private formInputSubmitKey: KeyId | undefined;
  private formPasteActive = false;
  private formPasteCarry = "";
  private formHints = DEFAULT_FORM_HINTS;
  private formNotice: string | undefined;
  private formGeneration = 0;
  private formKind: "new" | "edit" | "saved" | undefined;
  /** Outstanding saved-conversation listing request (issue 323). */
  private pendingSavedList: { readonly requestId: number } | undefined;
  /** Deliberate saved-open in flight; late results are fenced by requestId. */
  private pendingSavedOpen: { readonly requestId: number } | undefined;
  private pendingRowResume: { readonly requestId: number; readonly id: string } | undefined;
  private savedRows: SidebarSavedRow[] = [];
  private savedIssueCount = 0;
  private savedError: string | undefined;
  private savedSelectedIndex = 0;
  private savedListTop = 0;
  /**
   * The exact saved rows (id|file) fully drawn by the last valid picker render.
   * A saved-open is refused unless the highlighted tuple is in this set, so a
   * too-small fallback or an undrawn/hidden row can never be opened. Invalidated
   * on fallback, dismissal, and catalog replacement.
   */
  private displayedSavedRows:
    | { readonly cols: number; readonly rows: number; readonly entries: readonly DisplayedSavedRow[] }
    | undefined;
  private editTarget?: { readonly id: string; readonly nativeSession: SessionHostNativeSession; readonly currentName: string };
  private workspaceDraft: string;
  private editDraft = "";
  private rowStore: SidebarItem[] = [];
  private entries: SidebarEntry[] = [];
  private selectedEntryKey: string | undefined = ENTRY_NEW_KEY;
  private desiredSelectionId: string | undefined;
  private _visible: boolean;
  private _focus: SidebarFocus = "main";
  /**
   * View-only observer of the host's actual active Main owner (the explicitly
   * activated live child). Set by Main, never inferred from the selection; it
   * only drives the white title highlight and is cleared when the row leaves
   * the roster. It never changes activation or input ownership.
   */
  private activeMainOwnerID_: string | undefined;
  /**
   * Provenance fence for a host-claimed Alt+Right press: once the roster
   * claims an initial Alt+Right to return focus to Main, the held key's
   * repeat/release events are consumed instead of leaking into the child.
   * A fresh (initial) Alt+Right in Main focus is ordinary native input.
   */
  private altRightClaimed = false;
  /**
   * Provenance fence for a host-owned form Escape: a fresh Escape that cancels
   * only the New or Edit form — or that the native field consumes to dismiss
   * its completion list — must not let the held key's repeat/release bubble
   * into the roster's Escape-hide or leak into the child as native input. A
   * fresh roster Escape still hides (existing semantics).
   */
  private formEscapeClaimed = false;
  /**
   * Provenance fence for the fresh submit key that submitted the New form or
   * opened a saved conversation. Success transfers input ownership to the
   * newly created child, so the held key's repeat/release must not be replayed
   * into that child as native input; a later fresh press of that key in Main is
   * ordinary native input. The matcher is captured at submission time so it
   * survives the field teardown that follows a successful completion.
   */
  private formSubmitClaim: ((data: string) => boolean) | undefined;
  private pendingCreate: { readonly requestId: number } | undefined;
  private pendingRename: { readonly requestId: number } | undefined;
  /** Explicit confirmation purpose: quit the host or stop one owned session. */
  private confirmPurpose: "quit" | "stop-remove" = "quit";
  /** Frozen stop target id; later navigation never retargets the confirmation. */
  private stopRemoveTargetId: string | undefined;
  /** True only while the last render drew the complete stop warning dialog. */
  private stopConfirmDisplayed = false;
  private formError: string | undefined;
  private noticeError: string | undefined;
  private nextRequestId = 1;
  private listTop = 0;
  /**
   * Item ids whose cards the user collapsed with Space. Cards default to
   * expanded; each card's state persists independently of the highlight.
   */
  private readonly collapsedItemIds = new Set<string>();
  /**
   * Narrow resume-replacement fence: old exited placeholder ids the backend is
   * removing because their replacement child actually started. Consumed by the
   * roster update that observes the disappearance; never used for ordinary
   * vanished-row safety or explicit removals.
   */
  private readonly replacedRowIds = new Set<string>();
  /**
   * What the last roster render actually drew: the entry-order signature at
   * that time and the height of every COMPLETELY rendered entry. A too-small
   * render records no entries; hiding the pane or replacing it with a
   * form/picker/confirmation forgets the record. Selection-targeted keys
   * (Enter, edit, remove) act only on an entry present here at its current
   * height, so nothing invisible or since-changed can be activated.
   */
  private displayedRoster:
    | {
        readonly signature: string;
        readonly heights: ReadonlyMap<string, number>;
        readonly regions: ReadonlyMap<string, DisplayedRosterRegion>;
        readonly cols: number;
        readonly rows: number;
        readonly focus: SidebarFocus;
      }
    | undefined;

  constructor(options: SidebarControllerOptions = {}) {
    this.toggleKey = normalizeToggleKey(options.toggleKey);
    this.toggleLabel = toggleDisplayName(this.toggleKey);
    this.onAction = options.onAction;
    this.onInvalidate = options.onInvalidate;
    this._visible = options.initialVisible ?? true;
    this.workspaceBasePath = resolve(options.workspaceBasePath ?? "/");
    this.createTextField = options.createTextField;

    const suggestedWorkspace = sanitizeCellText(options.initialWorkspace ?? "");
    if (countCodePoints(suggestedWorkspace) > PATH_FIELD_MAX_CODEPOINTS) {
      throw new Error(
        `initialWorkspace exceeds the ${PATH_FIELD_MAX_CODEPOINTS}-character limit`,
      );
    }
    this.workspaceDraft = suggestedWorkspace;
    // A visible pane is an opened pane: the welcome picker (default) and a
    // supplied roster both take sidebar focus, while an explicitly hidden
    // start keeps main focus for native typing.
    this._focus = this._visible ? "sidebar" : "main";
    this.rebuildEntries();
  }

  /** Whether the sidebar pane is currently shown at all. */
  get visible(): boolean {
    return this._visible;
  }

  /** Where keyboard input currently goes. */
  get focus(): SidebarFocus {
    return this._focus;
  }

  /** Currently highlighted roster item id (undefined for non-item rows). */
  get selectedId(): string | undefined {
    const entry = this.currentEntry();
    return entry !== undefined && entry.kind === "item" && entry.item !== undefined
      ? entry.item.id
      : undefined;
  }

  /** View-only: the host's actual active Main owner id (undefined when none). */
  get activeMainOwnerID(): string | undefined {
    return this.activeMainOwnerID_;
  }

  /**
   * Main-owned, view-only observer of the actual active Main conversation.
   * It only drives the white title highlight; it never activates a row,
   * moves input focus, or changes ownership. Main clears it (undefined) when
   * the owner row leaves the roster so a sibling is never falsely highlighted.
   */
  setActiveMainOwner(id: string | undefined): void {
    this.activeMainOwnerID_ = typeof id === "string" && id.length > 0 ? id : undefined;
  }

  /** Read-only view of the last updateItems roster (defensive copies). */
  get items(): readonly SidebarItem[] {
    return [...this.rowStore];
  }

  /**
   * Replaces the roster from backend snapshots. Items are copied; keyboard
   * selection follows ids across metadata updates and reorders. When the
   * selected item disappears, focus returns to the roster picker and the
   * selection is cleared, so subsequent keystrokes are never silently
   * forwarded to a different instance until an explicit selection.
   */
  updateItems(items: readonly SidebarItem[]): void {
    if (!Array.isArray(items)) {
      throw new Error("SidebarController.updateItems expects an array of SidebarItem");
    }
    this.rowStore = items.map((item) => copyItem(item));
    this.rebuildEntries();
    if (this.pendingRowResume && !this.rowStore.some(item => item.id === this.pendingRowResume!.id
      && item.lifecycle === "exited" && item.hasLiveProcess !== true)) this.cancelRowResume();
    // Keep expansion memory bounded to the current roster.
    const liveIds = new Set(this.rowStore.map((item) => item.id));
    for (const id of [...this.collapsedItemIds]) {
      if (!liveIds.has(id)) this.collapsedItemIds.delete(id);
    }
    if (this.desiredSelectionId !== undefined) {
      const resolved = this.findItemEntry(this.desiredSelectionId);
      if (resolved !== undefined) {
        this.selectedEntryKey = resolved.key;
        this.desiredSelectionId = undefined;
      }
      // A still-pending desired selection stays pending until its row
      // actually appears; no index-based guess is ever made.
      this.pruneRowReplacementFences(liveIds);
      return;
    }
    const entry = this.currentEntry();
    if (this.selectedEntryKey !== undefined && entry === undefined
      && this.selectedEntryKey.startsWith(ITEM_KEY_PREFIX)) {
      const vanishedId = this.selectedEntryKey.slice(ITEM_KEY_PREFIX.length);
      this.selectedEntryKey = undefined;
      if (!this.replacedRowIds.delete(vanishedId)) {
        // The highlighted instance vanished on its own: show the picker and
        // pull focus back to the list.
        if (this._focus === "main") {
          this._focus = "sidebar";
          if (!this._visible) {
            // A vanished selection must not eat input in an invisible picker:
            // show the pane and emit the visibility action for the reflow.
            this._visible = true;
            this.emit({ type: "visibility", visible: true });
          }
        }
      }
    }
    this.pruneRowReplacementFences(liveIds);
  }

  /** Drops replacement fences whose row is no longer in the roster. */
  private pruneRowReplacementFences(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.replacedRowIds]) {
      if (!liveIds.has(id)) this.replacedRowIds.delete(id);
    }
  }

  /** Backend-driven selection (e.g. for a spawn the host initiated). */
  select(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("SidebarController.select expects a nonempty string id");
    }
    this.cancelRowResume();
    // A newer backend selection supersedes this request's UI ownership,
    // not the native launch. Preserve the draft and current focus. The native
    // Editor field is one-shot after submit, so reopen it for a real retry.
    if (this.pendingCreate !== undefined) {
      this.pendingCreate = undefined;
      if (this.formKind === "new") {
        this.workspaceDraft = this.formField?.getValue() ?? this.workspaceDraft;
        this.createFormField(this.workspaceDraft);
      }
    }
    const entry = this.findItemEntry(id);
    if (entry !== undefined) {
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
    } else {
      // Not in the roster yet (typical for an initial spawn): remember the
      // desired id, clear the selection, and let updateItems apply it once
      // the row arrives.
      this.desiredSelectionId = id;
      this.selectedEntryKey = undefined;
    }
  }

  /**
   * Resolves a pending create. A successful explicit New submission activates
   * the created child as the Main input owner without a second host-row Enter
   * (the pane stays visible exactly as it was); the new row is highlighted only
   * while the request still owns the form. Late completions never steal focus
   * from a newer selection or form draft.
   */
  completeCreate(requestId: number, id: string): void {
    if (this.pendingCreate?.requestId !== requestId) {
      return; // stale callback: ignore entirely, no contamination
    }
    this.pendingCreate = undefined;
    if (this.formKind === "new" && this.formField) this.workspaceDraft = this.formField.getValue();
    this.disposeFormField();
    this.formKind = undefined;
    this.formError = undefined;
    if (this._focus === "form") {
      this.acceptCompletedRow(id);
      this._focus = "main";
      this.emit({ type: "select", id });
    }
  }

  /**
   * Fails a pending create. Entered fields and the error are preserved when
   * the request still matches; stale callbacks are ignored without touching
   * the current form.
   */
  failCreate(requestId: number, message: string): void {
    if (this.pendingCreate?.requestId !== requestId) {
      return; // stale callback: ignore entirely, no contamination
    }
    this.pendingCreate = undefined;
    this.formError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    if (this.formKind === "new") {
      if (this.formField) this.workspaceDraft = this.formField.getValue();
      this.disposeFormField();
      this.createFormField(this.workspaceDraft);
    }
  }

  /** Open Edit for the exact observed native conversation, without selecting it. */
  openEdit(target: { readonly id: string; readonly nativeSession: SessionHostNativeSession; readonly currentName: string }): boolean {
    if (!this._visible || this._focus !== "sidebar" || !target.id || !target.nativeSession
      || !isValidNativeSessionId(target.nativeSession.sessionId)
      || !Number.isSafeInteger(target.nativeSession.epoch) || target.nativeSession.epoch < 1
      || !isValidRenameName(target.nativeSession.name)) return false;
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.formKind = "edit";
    this.editTarget = {
      id: target.id,
      nativeSession: { ...target.nativeSession },
      currentName: sanitizeBounded(target.currentName, 256),
    };
    this.editDraft = "";
    this.formError = undefined;
    this.noticeError = undefined;
    this._focus = "form";
    this.createFormField(this.editDraft);
    return this.formField !== undefined;
  }

  /** Complete one rename only while that request still owns the open form. */
  completeRename(requestId: number, status: string): void {
    if (this.pendingRename?.requestId !== requestId || this.formKind !== "edit") return;
    this.pendingRename = undefined;
    if (this.formField) this.editDraft = this.formField.getValue();
    this.disposeFormField();
    if (status === "renamed") {
      this.formKind = undefined;
      this.editTarget = undefined;
      this.formError = undefined;
      this._focus = "sidebar";
      this.noticeError = undefined;
      return;
    }
    this.formError = renameFailureNotice(status);
    this.createFormField(this.editDraft);
  }

  /** Shows a bounded error when Main rejects an edit before broker admission. */
  failRename(requestId: number, message: string): void {
    if (this.pendingRename?.requestId !== requestId || this.formKind !== "edit") return;
    this.pendingRename = undefined;
    if (this.formField) this.editDraft = this.formField.getValue();
    this.disposeFormField();
    this.formError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.createFormField(this.editDraft);
  }

  private acceptCompletedRow(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      return;
    }
    const entry = this.findItemEntry(id);
    if (entry !== undefined) {
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
    } else {
      // Rows arrive through updateItems; keep the pending desire visible as
      // a cleared picker instead of a stale highlight on an older row.
      this.desiredSelectionId = id;
      this.selectedEntryKey = undefined;
    }
  }

  /**
   * Complete only the still-current deliberate exited-row intent: the pending
   * request must still match, the old row must still be a confirmed exit with
   * no owned process, and the replacement must be an actual live child
   * (lifecycle alive with a confirmed owned process). Anything else refuses
   * without selecting or changing focus.
   */
  completeRowResume(requestId: number, oldId: string, newId: string): boolean {
    const pending = this.pendingRowResume;
    if (!pending || pending.requestId !== requestId || pending.id !== oldId) return false;
    this.pendingRowResume = undefined;
    if (!this._visible || this._focus !== "sidebar" || this.selectedId !== oldId
      || !this.rowStore.some(item => item.id === oldId && item.lifecycle === "exited" && item.hasLiveProcess !== true)
      || !this.rowStore.some(item => item.id === newId && item.lifecycle === "alive" && item.hasLiveProcess === true)) return false;
    this.noticeError = undefined;
    this.select(newId);
    this._focus = "main";
    this.emit({ type: "select", id: newId });
    return true;
  }

  /**
   * Narrow resume-replacement fence: the backend is about to remove one old
   * exited placeholder after its replacement child actually started. The
   * following roster update must not read exactly that row's disappearance as
   * the user's highlight vanishing (which would pull focus back from a hidden
   * main pane and show the picker). Ordinary vanished-row safety and explicit
   * removals are unchanged.
   */
  noteRowReplacement(id: string): void {
    if (typeof id === "string" && id.length > 0 && this.rowStore.some((item) => item.id === id)) {
      this.replacedRowIds.add(id);
    }
  }

  /** Releases a replacement fence when the backend removal did not actually occur. */
  clearRowReplacement(id: string): void {
    this.replacedRowIds.delete(id);
  }

  failRowResume(requestId: number, message: string): void {
    if (this.pendingRowResume?.requestId !== requestId) return;
    this.pendingRowResume = undefined;
    if (this._visible && this._focus === "sidebar") this.noticeError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
  }

  private cancelRowResume(): void {
    const pending = this.pendingRowResume;
    this.pendingRowResume = undefined;
    if (pending) this.emit({ type: "resume-row-cancel", requestId: pending.requestId });
  }

  /** Shows a bounded, sanitized error near the pane's footer. */
  showError(message: string): void {
    this.noticeError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
  }

  /**
   * Activates the exact roster entry whose complete row/card was drawn at this
   * pane-relative coordinate. Main consumes all other gestures in the visible
   * pane; this method never derives row positions independently of rendering.
   */
  activateRosterAt(column: number, row: number, cols: number, rows: number): boolean {
    if (!this._visible || (this._focus !== "main" && this._focus !== "sidebar")
      || !validHitGeometry(column, row, cols, rows)) return false;
    const shown = this.displayedRoster;
    if (shown === undefined || shown.signature !== this.rosterSignature()
      || shown.cols !== cols || shown.rows !== rows || shown.focus !== this._focus) return false;
    const region = [...shown.regions.values()].find((candidate) => row >= candidate.row
      && row < candidate.row + candidate.height);
    if (region === undefined || region.height !== this.entryHeight(region.entry)) return false;
    const current = this.entries.find((entry) => entry.key === region.entry.key);
    if (current !== region.entry) return false;
    this.selectedEntryKey = current.key;
    this.desiredSelectionId = undefined;
    this.noticeError = undefined;
    // A mouse activation can originate while Main owns input. Exited-row
    // recovery is a sidebar-owned intent: move focus there before invoking the
    // existing resume guard so completeRowResume can validate the same request.
    if (current.kind === "item" && current.item?.lifecycle === "exited"
      && current.item.unavailable !== true && this.pendingRowResume === undefined
      && this._focus === "main") {
      this._focus = "sidebar";
    }
    this.activateEntry();
    return true;
  }

  /** Activates a fully drawn saved row in the currently owned Saved pane. */
  activateSavedAt(column: number, row: number, cols: number, rows: number): boolean {
    if (!this._visible || this._focus !== "form" || this.formKind !== "saved"
      || !validHitGeometry(column, row, cols, rows)) return false;
    const shown = this.displayedSavedRows;
    if (shown === undefined || shown.cols !== cols || shown.rows !== rows) return false;
    const displayed = shown.entries.find((candidate) => candidate.paneRow === row);
    if (displayed === undefined || this.savedRows[displayed.index] !== displayed.entry) return false;
    this.savedSelectedIndex = displayed.index;
    this.activateSavedRow();
    return true;
  }

  /** Dispatches one input chunk by current focus area. */
  handleInput(data: string): void {
    if (typeof data !== "string" || data.length === 0) {
      return;
    }
    switch (this._focus) {
      case "main":
        this.handleMainInput(data);
        break;
      case "sidebar":
        this.handleSidebarInput(data);
        break;
      case "form":
        this.handleFormInput(data);
        break;
      case "confirm":
        this.handleConfirmInput(data);
        break;
    }
  }

  /**
   * Renders only this pane at the supplied geometry. Hidden panes render
   * nothing; too-small panes get a bounded graceful message instead of a
   * broken layout. No resize is ever propagated to any backend.
   */
  render(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    if (!this._visible) {
      return { lines: [] };
    }
    return this.renderForFocus(cols, rows);
  }

  /**
   * Renders the roster picker pane at the supplied geometry regardless of
   * focus. The wide layout shows it beside the New session form; hidden
   * visibility is decided by the compositor, not here.
   */
  renderRoster(cols: number, rows: number): { lines: string[] } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
      return this.renderRosterTooSmall(cols, rows);
    }
    return this.renderRosterPane(cols, rows);
  }

  /**
   * Renders the New session form pane at the supplied geometry regardless of
   * focus. On wide terminals the compositor places it in the native pane's
   * rect; on narrow terminals it becomes the full-content overlay.
   */
  renderForm(cols: number, rows: number): { lines: string[]; cursor?: { column: number; row: number } } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    this.displayedSavedRows = undefined;
    if (cols < FORM_MIN_COLS || rows < FORM_MIN_ROWS) {
      return this.renderTooSmall(cols, rows);
    }
    if (this.formKind === "saved") {
      return this.renderSavedPane(cols, rows);
    }
    return this.renderFormPane(cols, rows);
  }

  private renderForFocus(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    // In this focused-pane (narrow) path the form/picker/confirmation
    // replaces the roster on screen, even if a wide-layout renderRoster()
    // drew it earlier; standalone renderForm() keeps the wide roster record.
    if (this._focus === "form") {
      this.forgetDisplayedRoster();
      return this.renderForm(cols, rows);
    }
    if (this._focus === "confirm") {
      this.forgetDisplayedRoster();
      if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
        this.stopConfirmDisplayed = false;
        return this.renderTooSmall(cols, rows);
      }
      return this.renderConfirmPane(cols, rows);
    }
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
      return this.renderRosterTooSmall(cols, rows);
    }
    return this.renderRosterPane(cols, rows);
  }

  /** Consumes every matcher-recognized toggle event; only initial presses act. */
  private handleReservedToggle(data: string, beforePress?: () => void): boolean {
    const fallbackEventType = functionKeyEventType(data, this.toggleKey);
    if (!matchesKey(data, this.toggleKey as KeyId) && fallbackEventType === undefined) {
      return false;
    }
    const isRelease = isKeyRelease(data) || fallbackEventType === "release";
    const isRepeat = isKeyRepeat(data) || fallbackEventType === "repeat";
    if (!isRelease && !isRepeat) {
      beforePress?.();
      this.toggle();
    }
    return true;
  }

  private emitForward(data: string): void {
    this.emit({ type: "forward", data });
  }

  /**
   * Fences the held Escape key that canceled only a host-owned form (New or
   * Edit) — or that the field consumed to dismiss its completion list —
   * across every focus domain until its release or a fresh Escape press.
   * Unrelated input does NOT clear the claim, so a later repeat/release of the
   * still-held key is consumed (never a roster hide or child input) wherever
   * focus lands. Returns true when the event was consumed by the fence.
   */
  private consumeFormEscapeClaim(data: string): boolean {
    if (!this.formEscapeClaimed) return false;
    if (matchesKey(data, "escape")) {
      if (isKeyRelease(data)) { this.formEscapeClaimed = false; return true; }
      if (isKeyRepeat(data)) return true; // consume the held-key repeat
      // A fresh Escape press ends the fence; let it proceed to the normal handler.
      this.formEscapeClaimed = false;
      return false;
    }
    // Unrelated input does not clear the claim; only the Escape release or a
    // fresh Escape press ends the fence.
    return false;
  }

  /**
   * Fences the held submit key whose fresh press submitted the New form or
   * opened a saved conversation. Once that success transferred ownership to
   * the new child, the same key's repeat/release is consumed instead of being
   * replayed into the child; a later fresh press of that key in Main is
   * ordinary native input and is forwarded. The matcher follows the native
   * field's configured submit binding. Returns true when the event was
   * consumed.
   */
  private consumeFormSubmitClaim(data: string): boolean {
    const claimed = this.formSubmitClaim;
    if (claimed === undefined || !claimed(data)) return false;
    if (isKeyRelease(data)) { this.formSubmitClaim = undefined; return true; }
    if (isKeyRepeat(data)) return true; // consume the held-key repeat
    this.formSubmitClaim = undefined; // a fresh press is ordinary native input
    return false;
  }

  // --- Main focus: everything is forwarded unchanged except the toggle. ---

  private handleMainInput(data: string): void {
    if (this.handleReservedToggle(data)) {
      return;
    }
    // A held Escape that canceled only a host-owned form must not leak into
    // the child as input, even after a focus change; its repeat/release is
    // consumed here until the key is released or freshly pressed again.
    if (this.consumeFormEscapeClaim(data)) {
      return;
    }
    // The held Enter that submitted the New form or opened a saved
    // conversation must not replay its repeat/release into the newly focused
    // child after that success transferred ownership.
    if (this.consumeFormSubmitClaim(data)) {
      return;
    }
    // A held Alt+Right whose initial press a host-owned surface claimed must
    // not leak into the child as input; a fresh (initial) Alt+Right in Main
    // focus is ordinary native input and stays forwarded.
    if (matchesKey(data, "alt+right")) {
      if (this.altRightClaimed && (isKeyRepeat(data) || isKeyRelease(data))) {
        if (isKeyRelease(data)) this.altRightClaimed = false;
        return; // consume the held-key repeat/release
      }
      this.altRightClaimed = false; // fresh press: clear any stale claim
    }
    // Nonreserved releases and repeats are forwarded verbatim for the child
    // adapter to interpret under its own Kitty-protocol state.
    this.emitForward(data);
  }

  // --- Sidebar focus: roster navigation, New session, Quit host. ---

  private handleSidebarInput(data: string): void {
    // Bracketed paste is opaque in roster focus: a streamed body that merely
    // equals a host chord (e.g. Alt+Right) must not change focus or leak the
    // remaining pasted content into Main.
    if (this.routeBracketedPaste(data)) return;
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    // The reserved toggle takes precedence over Alt+Right (the user may
    // configure the toggle as alt+right), so it is handled first.
    if (this.handleReservedToggle(data)) {
      return;
    }
    if (isKeyRelease(data)) {
      // A held Alt+Right whose press was claimed: its release clears the claim
      // so a later fresh Alt+Right in Main focus is ordinary native input.
      if (matchesKey(data, "alt+right")) this.altRightClaimed = false;
      return;
    }
    // Alt+Right (roster-only) returns input focus to the existing Main owner
    // without activating the highlighted row, resizing, or hiding. Only an
    // initial deliberate press acts, and only when the selected card was fully
    // drawn by the last roster render (the complete-card action fence).
    if (matchesKey(data, "alt+right")) {
      if (isKeyRepeat(data)) return;
      this.altRightClaimed = true; // claim for the cross-surface repeat/release fence
      if (!this.selectionFitsLastRoster()) return; // refuse: selection not fully drawn
      this._focus = "main";
      this.onInvalidate?.();
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "enter")) {
      // A held Enter never activates a roster entry — including a row that a
      // just-completed saved-open highlighted; only a fresh press does.
      if (isKeyRepeat(data)) return;
      // Never activate a target the last roster render could not show whole.
      if (!this.selectionFitsLastRoster()) return;
      this.activateEntry();
      return;
    }
    if (matchesKey(data, "space") || printableOf(data) === " ") {
      // Space toggles only the highlighted card's own expansion; a held
      // Space does not flap it.
      if (!isKeyRepeat(data)) this.toggleSelectedExpansion();
      return;
    }
    if (
      matchesKey(data, "delete") ||
      (this.toggleKey === "delete" && ["x", "X"].includes(printableOf(data) ?? ""))
    ) {
      // A held Delete/x never stops; only a deliberate initial press does.
      if (isKeyRepeat(data)) return;
      if (!this.selectionFitsLastRoster()) return;
      this.stopRemoveSelectedEntry();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.hide();
      return;
    }
    const printable = printableOf(data);
    if (printable === "d" || printable === "D") {
      // A held d never stops; only a deliberate initial press does.
      if (isKeyRepeat(data)) return;
      if (!this.selectionFitsLastRoster()) return;
      this.stopRemoveSelectedEntry();
      return;
    }
    if (printable === "e" || printable === "E") {
      if (!this.selectionFitsLastRoster()) return;
      this.editSelectedEntry();
      return;
    }
    if (printable === "q" || printable === "Q") {
      // Menu `q` is the same explicit Quit action as the Quit host row.
      this.activateQuit();
    }
  }

  private moveSelection(delta: number): void {
    this.cancelRowResume();
    if (this.entries.length === 0) {
      return;
    }
    const current = this.entries.findIndex((entry) => entry.key === this.selectedEntryKey);
    const nextIndex =
      current === -1
        ? delta > 0
          ? 0
          : this.entries.length - 1
        : (current + delta + this.entries.length) % this.entries.length;
    this.selectedEntryKey = this.entries[nextIndex]?.key;
    this.desiredSelectionId = undefined;
    this.noticeError = undefined;
  }

  private currentEntry(): SidebarEntry | undefined {
    return this.entries.find((entry) => entry.key === this.selectedEntryKey);
  }

  /** Flips the highlighted card between 5-line expanded and 3-line collapsed. */
  private toggleSelectedExpansion(): void {
    const entry = this.currentEntry();
    if (entry?.kind !== "item" || entry.item === undefined) {
      return;
    }
    const id = entry.item.id;
    if (this.collapsedItemIds.has(id)) {
      this.collapsedItemIds.delete(id);
    } else {
      this.collapsedItemIds.add(id);
    }
  }

  /** Rendered height of one entry: cards are 3 or 5 rows, actions 1 row. */
  private entryHeight(entry: SidebarEntry | undefined): number {
    if (entry?.kind !== "item" || entry.item === undefined) {
      return 1;
    }
    return this.collapsedItemIds.has(entry.item.id) ? CARD_COLLAPSED_ROWS : CARD_EXPANDED_ROWS;
  }

  /**
   * True only when the highlighted entry was completely drawn by the last
   * roster render, at its current height (expansion state), with the same
   * entry order. With no highlighted entry there is nothing to activate (the
   * keys only produce a bounded notice), so that case is allowed.
   */
  private selectionFitsLastRoster(): boolean {
    const entry = this.currentEntry();
    if (entry === undefined) {
      return true;
    }
    const shown = this.displayedRoster;
    if (shown === undefined || shown.signature !== this.rosterSignature()) {
      return false;
    }
    return shown.heights.get(entry.key) === this.entryHeight(entry);
  }

  private rosterSignature(): string {
    return JSON.stringify(this.entries.map((entry) => entry.key));
  }

  /** The roster is no longer on screen (hidden or replaced by another pane). */
  private forgetDisplayedRoster(): void {
    this.cancelRowResume();
    this.displayedRoster = undefined;
  }

  private activateEntry(): void {
    const entry = this.currentEntry();
    if (entry === undefined) {
      return;
    }
    if (entry.kind === "item" && entry.item !== undefined) {
      if (entry.item.unavailable === true) {
        // A remembered conversation that owns no process never becomes the Main
        // input owner: refusing here leaves focus and input ownership exactly
        // where they were instead of handing the child input to a sibling.
        this.noticeError = "This remembered conversation is unavailable; remove it to forget it";
        return;
      }
      if (entry.item.lifecycle === "exited") {
        if (this.pendingRowResume) { this.noticeError = "This conversation is already starting"; return; }
        const requestId = this.nextRequestId++;
        this.pendingRowResume = { requestId, id: entry.item.id };
        this.noticeError = "Opening this conversation";
        this.emit({ type: "resume-row", requestId, id: entry.item.id });
        return;
      }
      this.cancelRowResume();
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
      // The sidebar stays visible; the typing room stays narrower until a
      // later hide. Only the select action is emitted.
      this._focus = "main";
      this.emit({ type: "select", id: entry.item.id });
      return;
    }
    if (entry.kind === "saved") {
      this.openSavedPane();
      return;
    }
    if (entry.kind === "new") {
      this.openNewForm();
      return;
    }
    this.activateQuit();
  }

  private editSelectedEntry(): void {
    const entry = this.currentEntry();
    if (entry?.kind !== "item" || !entry.item) {
      this.noticeError = "Select a session row to edit its native name";
      return;
    }
    const nativeSession = entry.item.nativeSession;
    if (!nativeSession) {
      this.noticeError = "Native conversation name is unavailable until status is observed";
      return;
    }
    this.noticeError = undefined;
    this.emit({ type: "edit", id: entry.item.id, nativeSession: { ...nativeSession } });
  }

  /**
   * d / Delete (x when Delete is the reserved toggle): an exited row removes
   * immediately; a settled error row without a live process requests the same
   * deliberate removal (the manager stays authoritative and may still refuse);
   * a live owned process requests a stop — directly only when complete
   * idleness is positively observed, otherwise after explicit confirmation.
   * A row with no owned process and no confirmed exit is refused with a
   * bounded notice; nothing is faked or cancelled.
   */
  private stopRemoveSelectedEntry(): void {
    this.cancelRowResume();
    const entry = this.currentEntry();
    if (entry === undefined || entry.kind !== "item" || entry.item === undefined) {
      this.noticeError = "Select a session row to stop or remove";
      return;
    }
    const item = entry.item;
    if (item.lifecycle === "exited") {
      // Confirmed exit: plain removal; the backend stays authoritative.
      this.noticeError = undefined;
      this.emit({ type: "remove", id: item.id });
      return;
    }
    if (item.lifecycle === "error" && item.hasLiveProcess === false) {
      // Settled error row with no live process: the same deliberate removal
      // flow as an exited row. The error badge is not exit or force authority;
      // the manager decides whether it may actually be closed.
      this.noticeError = undefined;
      this.emit({ type: "remove", id: item.id });
      return;
    }
    if (item.hasLiveProcess !== true) {
      // No owned process to stop and no confirmed exit (starting, unspawned
      // error, or a live row without an observed handle): refuse truthfully.
      this.noticeError = "No owned process to stop";
      return;
    }
    if (isCompleteIdle(item)) {
      // Positively observed complete idleness: request the stop directly;
      // the parent revalidates fresh idle before acting.
      this.noticeError = undefined;
      this.emit({ type: "stop-remove", id: item.id, confirmed: false });
      return;
    }
    // Active or unknown: explicit confirmation with a frozen target id.
    this.openStopRemoveConfirmation(item.id);
  }

  private openStopRemoveConfirmation(id: string): void {
    this.forgetDisplayedRoster(); // the confirmation replaces the roster
    this.confirmPurpose = "stop-remove";
    this.stopRemoveTargetId = id; // frozen: later navigation never retargets
    this.stopConfirmDisplayed = false; // the warning must be drawn before a stop
    this._focus = "confirm";
  }

  /**
   * Cancel the stop confirmation: preserve the highlighted row and sidebar
   * input ownership, reset the purpose, send no native input, keep visible.
   */
  private cancelStopRemove(): void {
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this._focus = "sidebar";
  }

  /**
   * Confirms the frozen stop target only while it still exists and is live
   * owned; a vanished or no-longer-live target is refused, never a sibling.
   */
  private confirmStopRemove(): void {
    const id = this.stopRemoveTargetId;
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this._focus = "sidebar";
    if (id === undefined) return;
    const entry = this.findItemEntry(id);
    if (entry === undefined || entry.item === undefined) {
      this.noticeError = "Session no longer exists";
      return;
    }
    if (entry.item.hasLiveProcess !== true) {
      this.noticeError = "Session is no longer live";
      return;
    }
    this.emit({ type: "stop-remove", id, confirmed: true });
  }

  /**
   * Quit requires confirmation for starting/alive rows or any row whose
   * snapshot says the host still owns a live process. With none, the explicit
   * quit action is emitted immediately; no other key path quits the host.
   */
  private activateQuit(): void {
    this.cancelRowResume();
    const hasLive = this.rowStore.some(requiresQuitConfirmation);
    if (hasLive) {
      this.forgetDisplayedRoster(); // the confirmation replaces the roster
      this._focus = "confirm";
      return;
    }
    this.emit({ type: "quit" });
  }

  // --- Forms use the real public Editor adapter for every editable value. ---

  private handleFormInput(data: string): void {
    if (this.formKind === "saved") {
      this.handleSavedPaneInput(data);
      return;
    }
    if (this.routeBracketedPaste(data)) {
      this.formField?.handleInput(data);
      return;
    }
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.handleReservedToggle(data, () => this.abandonForm())) return;
    // Host-owned form UI: Alt+Right never dismisses, submits, forwards to the
    // child, or steals ownership; it is consumed in every event form. An
    // initial press is claimed so its repeat/release stays fenced if a focus
    // change (e.g. the reserved toggle) happens while the key is still held;
    // the release clears the claim.
    if (matchesKey(data, "alt+right")) {
      if (isKeyRelease(data)) { this.altRightClaimed = false; return; }
      if (!isKeyRepeat(data)) this.altRightClaimed = true;
      return;
    }
    if (isKeyRelease(data)) return;
    // A held Escape's repeat never cancels a form: the press may have just
    // dismissed the native completion list, and its repeat must not then cancel
    // New or Edit, hide the roster, or reach the child. Only a fresh press
    // cancels; the field's own completion-list Escape precedence is intact.
    if (matchesKey(data, "escape") && isKeyRepeat(data)) return;
    if (this.pendingCreate || this.pendingRename) {
      // The configured cancel binding still abandons a pending New/Edit form;
      // a held repeat never cancels a pending Edit rename (existing rule).
      if (this.formMatchesCancel(data)
        && (this.formKind !== "edit" || !isKeyRepeat(data))) this.escapeFromForm();
      return;
    }
    // Claim every fresh, non-pasted form Escape BEFORE the field sees it: the
    // field may consume this press to dismiss its own native completion list
    // without cancelling, and the still-held key's repeat/release can arrive
    // after a reserved toggle, a focus change, or a completed create. Without
    // an early claim those later events would hide the roster or become child
    // input. The field still receives the press first, so its completion-list
    // precedence and the reserved-toggle priority are unchanged.
    if (matchesKey(data, "escape")) this.formEscapeClaimed = true;
    if (this.formField) {
      // Capture the exact canonical key id while the field synchronously
      // handles this packet, so a multi-binding submit fences the binding that
      // actually fired rather than the whole action matcher.
      this.formInputSubmitKey = this.formMatchesSubmit(data)
        ? parseKey(data) as KeyId | undefined
        : undefined;
      try {
        this.formField.handleInput(data);
      } finally {
        this.formInputSubmitKey = undefined;
      }
    } else if (matchesKey(data, "escape")) this.escapeFromForm();
  }

  /** Keep bracketed-paste chunks opaque to host actions; the native Editor still owns their contents. */
  private routeBracketedPaste(data: string): boolean {
    let owned = this.formPasteActive;
    let combined = this.formPasteCarry + data;
    this.formPasteCarry = "";

    for (;;) {
      const marker = this.formPasteActive ? BRACKETED_PASTE_END : BRACKETED_PASTE_START;
      const index = combined.indexOf(marker);
      if (index < 0) {
        const suffixLength = markerSuffixLength(combined, marker);
        this.formPasteCarry = suffixLength === 0 ? "" : combined.slice(-suffixLength);
        if (combined === "\x1b" && !owned) return false;
        return owned || suffixLength > 0;
      }
      owned = true;
      this.formPasteActive = !this.formPasteActive;
      combined = combined.slice(index + marker.length);
    }
  }




  // --- Saved-conversation picker (issue 323): deliberate, read-only. ---

  /**
   * Opens the saved-conversation picker in the form pane slot and requests a
   * fresh listing of the shared native catalog. Highlighting rows never
   * touches any running session; only an explicit Enter on a row emits a
   * saved-open action.
   */
  private openSavedPane(): void {
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeFormField();
    this.formKind = "saved";
    this.editTarget = undefined;
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingSavedOpen = undefined;
    this.formError = undefined;
    this.noticeError = undefined;
    this.savedRows = [];
    this.savedIssueCount = 0;
    this.savedError = undefined;
    this.savedSelectedIndex = 0;
    this.savedListTop = 0;
    this._focus = "form";
    this.displayedSavedRows = undefined;
    const requestId = this.nextRequestId++;
    this.pendingSavedList = { requestId };
    this.emit({ type: "saved-list", requestId });
  }

  /**
   * Dismisses the picker and restores the roster display. Cancelling an
   * outstanding listing only aborts that read; it never pauses, stops, or
   * rolls back any instance. A pending saved-open keeps running in the
   * backend; its late result is fenced by requestId.
   */
  private dismissSavedPane(): void {
    if (this.pendingSavedList !== undefined) {
      this.emit({ type: "saved-cancel", requestId: this.pendingSavedList.requestId });
      this.pendingSavedList = undefined;
    }
    this.pendingSavedOpen = undefined; // UI ownership only; the backend op continues
    this.abandonForm();
    this.savedError = undefined;
    this.displayedSavedRows = undefined; // dismissal invalidates the display record
    this._focus = "sidebar";
  }

  private handleSavedPaneInput(data: string): void {
    // Bracketed paste is opaque in the picker and never activates a row; a
    // streamed body chunk that merely equals the toggle must not dismiss.
    if (this.routeBracketedPaste(data)) return;
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.handleReservedToggle(data, () => this.dismissSavedPane())) return;
    // Host-owned picker UI: Alt+Right is consumed, never a row action. An
    // initial press is claimed so its repeat/release stays fenced across any
    // subsequent focus change while the key is still held; the release clears
    // the claim.
    if (matchesKey(data, "alt+right")) {
      if (isKeyRelease(data)) { this.altRightClaimed = false; return; }
      if (!isKeyRepeat(data)) this.altRightClaimed = true;
      return;
    }
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "up")) {
      this.moveSavedSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSavedSelection(1);
      return;
    }
    // Key repeats never activate or dismiss; only initial presses do.
    if (isKeyRepeat(data)) return;
    if (matchesKey(data, "enter")) {
      this.activateSavedRow();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.dismissSavedPane();
      return;
    }
  }

  private moveSavedSelection(delta: number): void {
    if (this.savedRows.length === 0) return;
    const current = this.savedSelectedIndex;
    this.savedSelectedIndex = (current + delta + this.savedRows.length) % this.savedRows.length;
  }

  /**
   * Deliberately opens the highlighted conversation. While a listing is still
   * in flight there is nothing to open; while an open is already pending the
   * row is not re-emitted.
   */
  private activateSavedRow(): void {
    if (this.pendingSavedList !== undefined) return;
    const row = this.savedRows[this.savedSelectedIndex];
    if (row === undefined) return;
    // Refuse to open a row the last valid picker render could not show whole:
    // a too-small fallback or an undrawn/hidden selection never opens.
    if (this.displayedSavedRows === undefined
      || !this.displayedSavedRows.entries.some((displayed) => displayed.index === this.savedSelectedIndex
        && displayed.entry === row)) return;
    if (this.pendingSavedOpen !== undefined) {
      this.savedError = "A saved conversation is already starting";
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingSavedOpen = { requestId };
    this.savedError = undefined;
    // Claim the fresh submit key that opened the saved conversation: its
    // repeat/release must not reach the newly focused native child after a
    // successful completion. The picker's open key is Enter.
    this.formSubmitClaim = (data) => matchesKey(data, "enter");
    this.emit({ type: "saved-open", requestId, file: row.file, sessionId: row.id });
  }

  /**
   * Accepts one saved-conversation listing only while that request still owns
   * the pane. Stale completions (dismissed or superseded panes) are ignored
   * entirely and never seize a later-opened or dismissed UI.
   */
  completeSavedList(requestId: number, rows: readonly SidebarSavedRow[], issueCount: number): boolean {
    if (this.pendingSavedList?.requestId !== requestId) return false; // stale: ignore
    this.pendingSavedList = undefined;
    const accepted: SidebarSavedRow[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.id !== "string" || row.id.length === 0
        || typeof row.file !== "string" || row.file.length === 0
        || typeof row.caption !== "string") continue;
      accepted.push({
        id: row.id,
        file: row.file,
        caption: sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS),
        ...(typeof row.cwd === "string" && row.cwd.length > 0
          ? { cwd: sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS) }
          : {}),
      });
    }
    this.savedRows = accepted;
    this.displayedSavedRows = undefined; // catalog replacement invalidates the display record
    this.savedIssueCount = Number.isSafeInteger(issueCount) && issueCount > 0 ? issueCount : 0;
    this.savedError = undefined;
    if (this.savedSelectedIndex >= this.savedRows.length) this.savedSelectedIndex = 0;
    return true;
  }

  /** Shows a bounded, truthful unavailable notice for a failed listing. */
  failSavedList(requestId: number, message: string): void {
    if (this.pendingSavedList?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedList = undefined;
    this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
  }

  /**
   * Completes a deliberate saved-open. A successful explicit Saved submission
   * activates the restored child as the Main input owner without a second
   * host-row Enter (the pane stays visible exactly as it was); the new row is
   * highlighted only while the request still owns the open pane. Late
   * completions never steal ownership or visibility.
   */
  completeSavedOpen(requestId: number, id: string): void {
    if (this.pendingSavedOpen?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedOpen = undefined;
    if (this._focus === "form" && this.formKind === "saved") {
      this.savedError = undefined;
      this.disposeFormField();
      this.formKind = undefined;
      this.acceptCompletedRow(id);
      this._focus = "main";
      this.emit({ type: "select", id });
    }
  }

  /** Shows a bounded refusal/failure notice while the picker still owns the pane. */
  failSavedOpen(requestId: number, message: string): void {
    if (this.pendingSavedOpen?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedOpen = undefined;
    if (this._focus === "form" && this.formKind === "saved") {
      this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    }
  }

  private openNewForm(): void {
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeFormField();
    this.formKind = "new";
    this.editTarget = undefined;
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.formError = undefined;
    this._focus = "form";
    this.createFormField(this.workspaceDraft);
  }

  private createFormField(initialText: string): void {
    this.disposeFormField();
    const kind = this.formKind === "edit" ? "name" : "path";
    const generation = this.formGeneration;
    const fieldOptions: SidebarFieldFactoryOptions = {
      kind,
      initialText,
      onInvalidate: () => {
        if (generation === this.formGeneration) this.onInvalidate?.();
      },
      onSubmit: (submission) => {
        if (generation !== this.formGeneration) return;
        if (this.formKind === "edit") this.submitRename(submission);
        else if (this.formKind === "new") this.submitCreate(submission);
      },
      onCancel: () => {
        if (generation === this.formGeneration) this.escapeFromForm();
      },
      onReject: (reason) => {
        if (generation === this.formGeneration) {
          this.formError = fieldRejectionNotice(reason);
          this.onInvalidate?.();
        }
      },
    };
    try {
      const created: SidebarFieldFactoryResult = this.createTextField
        ? this.createTextField(fieldOptions)
        : {
          field: kind === "path"
            ? createSessionHostTextField({
              kind: "path", initialText, workspaceBasePath: this.workspaceBasePath,
              onInvalidate: fieldOptions.onInvalidate, onSubmit: fieldOptions.onSubmit,
              onCancel: fieldOptions.onCancel, onReject: fieldOptions.onReject,
            })
            : createSessionHostTextField({
              kind: "name", initialText, onInvalidate: fieldOptions.onInvalidate,
              onSubmit: fieldOptions.onSubmit, onCancel: fieldOptions.onCancel,
              onReject: fieldOptions.onReject,
            }),
        };
      this.formField = created.field;
      this.formMatchesCancel = created.matchesCancel ?? ((data) => matchesKey(data, "escape"));
      this.formMatchesSubmit = created.matchesSubmit ?? ((data) => matchesKey(data, "enter"));
      this.formHints = created.hints ?? DEFAULT_FORM_HINTS;
      this.formNotice = created.notice
        ? sanitizeBounded(created.notice, ERROR_TEXT_MAX_CODEPOINTS)
        : undefined;
    } catch {
      this.formField = undefined;
      this.formError = "Session host field could not be opened";
    }
    this.onInvalidate?.();
  }

  private disposeFormField(): void {
    this.formGeneration += 1;
    try { this.formField?.dispose(); } catch { /* independent field cleanup */ }
    this.formField = undefined;
    this.formMatchesCancel = (data) => matchesKey(data, "escape");
    this.formMatchesSubmit = (data) => matchesKey(data, "enter");
    this.formPasteActive = false;
    this.formPasteCarry = "";
    this.formHints = DEFAULT_FORM_HINTS;
    this.formNotice = undefined;
  }

  private submitCreate(submission: SessionHostFieldSubmission): void {
    if (this.pendingCreate || this.formKind !== "new") return;
    const workspace = submission.value;
    if (workspace.length === 0) {
      this.formError = "Workspace is required";
      this.workspaceDraft = "";
      this.createFormField("");
      return;
    }
    if (sanitizeCellText(workspace) !== workspace || countCodePoints(workspace) > PATH_FIELD_MAX_CODEPOINTS) {
      this.formError = `Path exceeds ${PATH_FIELD_MAX_CODEPOINTS} characters or contains unsafe text`;
      this.workspaceDraft = this.formField?.getValue() ?? "";
      this.createFormField(this.workspaceDraft);
      return;
    }
    this.workspaceDraft = workspace;
    const requestId = this.nextRequestId++;
    this.pendingCreate = { requestId };
    this.formError = undefined;
    // Claim only the exact submit key that fired this submission: its
    // repeat/release must not reach the newly focused native child after a
    // successful completion, while any other configured submit binding stays
    // ordinary input. The captured key survives the field teardown.
    const submitKey = this.formInputSubmitKey;
    this.formSubmitClaim = submitKey === undefined
      ? undefined
      : (data: string) => matchesKey(data, submitKey);
    this.emit({ type: "create", requestId, workspace });
  }

  private submitRename(submission: SessionHostFieldSubmission): void {
    if (this.pendingRename || this.formKind !== "edit" || !this.editTarget) return;
    const name = submission.value;
    if (!isValidRenameName(name)) {
      this.formError = submission.value.length === 0 ? "New name is required" : "New name must be valid and at most 1024 UTF-8 bytes";
      this.editDraft = name;
      this.createFormField(name);
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingRename = { requestId };
    this.editDraft = name;
    this.formError = undefined;
    this.emit({
      type: "rename", requestId, id: this.editTarget.id,
      expectedSessionId: this.editTarget.nativeSession.sessionId,
      expectedSessionEpoch: this.editTarget.nativeSession.epoch, name,
    });
  }

  private escapeFromForm(): void {
    this.abandonForm();
    // New and Edit cancellations are both LOCAL: return to the VISIBLE roster
    // without hiding and without forwarding anything to the child. The active
    // Main owner, native process, native input draft, persisted name,
    // selection, and geometry are all preserved; abandonForm retains the
    // workspace/name draft. Claim the Escape so a held key's repeat/release
    // does not bubble into the roster's Escape-hide or leak into the child as
    // native input; a fresh roster Escape still hides (existing semantics).
    this.formEscapeClaimed = true;
    this._focus = "sidebar";
    this.onInvalidate?.();
  }

  private abandonForm(): void {
    if (this.formKind === "new" && this.formField) this.workspaceDraft = this.formField.getValue();
    if (this.formKind === "edit" && this.formField) this.editDraft = this.formField.getValue();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.disposeFormField();
    this.formKind = undefined;
    this.editTarget = undefined;
  }

  // --- Confirm focus: explicit quit or stop confirmation. ---

  private handleConfirmInput(data: string): void {
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    // The reserved toggle takes precedence over Alt+Right (the user may
    // configure the toggle as alt+right), so it is handled first.
    if (this.handleReservedToggle(data)) {
      return;
    }
    if (isKeyRelease(data)) {
      // A held Alt+Right whose press was claimed: its release clears the claim.
      if (matchesKey(data, "alt+right")) this.altRightClaimed = false;
      return;
    }
    // Host-owned confirmation UI: Alt+Right is consumed, never confirm/cancel.
    // An initial press is claimed so its repeat/release stays fenced across any
    // subsequent focus change while the key is still held.
    if (matchesKey(data, "alt+right")) {
      if (!isKeyRepeat(data)) this.altRightClaimed = true;
      return;
    }
    if (this.confirmPurpose === "stop-remove") {
      this.handleStopRemoveConfirmInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      // Cancel the confirmation and restore the main frame.
      this._focus = "sidebar";
      this.hide();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.confirmQuit();
      return;
    }
    const printable = printableOf(data);
    if (printable === "y" || printable === "Y") {
      this.confirmQuit();
      return;
    }
    if (printable === "n" || printable === "N") {
      this._focus = "sidebar";
    }
  }

  /**
   * Stop confirmation: deliberate initial presses only. Confirm acts on the
   * frozen target id; cancel keeps the highlighted row and sidebar input
   * ownership without sending any native input or hiding the pane.
   */
  private handleStopRemoveConfirmInput(data: string): void {
    // Held keys never confirm or cancel twice; releases are already consumed.
    if (isKeyRepeat(data)) return;
    if (matchesKey(data, "escape")) {
      this.cancelStopRemove();
      return;
    }
    const printable = printableOf(data);
    if (printable === "n" || printable === "N") {
      // Cancellation stays available even while the warning is not displayed.
      this.cancelStopRemove();
      return;
    }
    // A stop is only confirmable while the complete warning is on screen.
    if (!this.stopConfirmDisplayed) return;
    if (matchesKey(data, "enter")) {
      this.confirmStopRemove();
      return;
    }
    if (printable === "y" || printable === "Y") {
      this.confirmStopRemove();
    }
  }

  private confirmQuit(): void {
    this._focus = "sidebar";
    this.emit({ type: "quit" });
  }

  // --- Visibility. ---

  /**
   * Hides the pane. This is a pure visibility action: it never stops or
   * pauses any instance; the backend only reflows the main frame.
   */
  private hide(): void {
    if (!this._visible) {
      return;
    }
    this.forgetDisplayedRoster();
    // A hidden pane cannot hold an open stop confirmation.
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this._visible = false;
    this._focus = "main";
    this.emit({ type: "visibility", visible: false });
  }

  /**
   * Reserved shortcut, two-step:
   * - hidden: show the pane and focus the roster picker (visibility action);
   * - visible with MAIN focus: focus the roster picker only — no visibility
   *   action, so the layout is neither hidden nor resized;
   * - visible with sidebar-owned focus (roster, form, picker, confirm): hide
   *   and return focus to main. Form/picker callers run their own
   *   cancellation fence (abandonForm/dismissSavedPane) before this.
   */
  private toggle(): void {
    if (!this._visible) {
      this._visible = true;
      this._focus = "sidebar";
      this.emit({ type: "visibility", visible: true });
      return;
    }
    if (this._focus === "main") {
      this._focus = "sidebar";
      // Focus moved without a layout change; ask the host for a redraw.
      this.onInvalidate?.();
      return;
    }
    this.hide();
  }

  private emit(action: SidebarAction): void {
    this.onAction?.(action);
  }

  // --- Entry bookkeeping. ---

  private rebuildEntries(): void {
    this.entries = [
      ...this.rowStore.map(
        (item): SidebarEntry => ({ key: ITEM_KEY_PREFIX + item.id, kind: "item", item }),
      ),
      { key: ENTRY_SAVED_KEY, kind: "saved" },
      { key: ENTRY_NEW_KEY, kind: "new" },
      { key: ENTRY_QUIT_KEY, kind: "quit" },
    ];
  }

  private findItemEntry(id: string): SidebarEntry | undefined {
    return this.entries.find(
      (entry) => entry.kind === "item" && entry.item !== undefined && entry.item.id === id,
    );
  }

  // --- Rendering. ---

  private renderTooSmall(cols: number, rows: number): { lines: string[] } {
    const message = cols >= 26 ? ` pane ${cols}x${rows} too small ` : "too small";
    const lines = [wrapRow(message, cols, "\x1b[1;7m")];
    for (let row = 1; row < rows; row += 1) {
      lines.push("");
    }
    return { lines };
  }

  private renderRosterPane(cols: number, rows: number): { lines: string[] } {
    const header = ` Sessions (${this.rowStore.length}) `;
    const footerLines = wrapHintLines(
      [
        `${this.toggleLabel} toggle`,
        "enter open",
        ...(this._focus === "sidebar" ? ["e edit name"] : []),
        ...(this._focus === "sidebar"
          ? [this.toggleKey === "delete" ? "d/x stop/remove" : "d stop/remove"]
          : []),
        "esc hide",
        "q quit",
        ...(this._focus === "sidebar" && this.rowStore.length > 0 ? ["space expand"] : []),
        // Alt+Right returns input focus to the existing Main owner (roster-only);
        // it never activates the highlighted row. Shown only while the roster
        // owns focus, where the key actually acts.
        ...(this._focus === "sidebar" ? ["alt+right main"] : []),
      ],
      cols,
    );
    const noticeLines = this.noticeError === undefined
      ? []
      : wrapHintLines([`! ${this.noticeError}`], cols);
    if (footerLines === undefined || noticeLines === undefined || visibleWidth(header) > cols) {
      return this.renderRosterTooSmall(cols, rows);
    }
    const listRows = rows - 1 - noticeLines.length - footerLines.length;
    const selectedIndex = this.entries.findIndex((entry) => entry.key === this.selectedEntryKey);
    const selectedHeight = selectedIndex >= 0 ? this.entryHeight(this.entries[selectedIndex]) : 1;
    // At least one entry row is required, and the highlighted entry (a card
    // is 3 or 5 rows) must fit completely: a picker whose selected target is
    // invisible or clipped would let Enter act on something not shown.
    if (listRows < 1 || listRows < selectedHeight) {
      return this.renderRosterTooSmall(cols, rows);
    }
    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    const top = this.scrollWindow(selectedIndex, listRows);
    const displayed = new Map<string, number>();
    const regions = new Map<string, DisplayedRosterRegion>();
    let y = 0;
    for (let index = top; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      const entryLines = this.renderEntryLines(entry, index === selectedIndex, cols);
      // Only complete entries are drawn; a partially clipped card would
      // misrepresent its status.
      if (y + entryLines.length > listRows) {
        break;
      }
      lines.push(...entryLines);
      displayed.set(entry.key, entryLines.length);
      regions.set(entry.key, { row: lines.length - entryLines.length, height: entryLines.length, entry });
      y += entryLines.length;
    }
    this.displayedRoster = {
      signature: this.rosterSignature(),
      heights: displayed,
      regions,
      cols,
      rows,
      focus: this._focus,
    };
    for (const noticeLine of noticeLines) {
      lines.push(wrapRow(noticeLine, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) {
      lines.push(wrapRow(footerLine, cols));
    }
    return { lines };
  }

  /** Too-small roster fallback: records that no entry is displayed. */
  private renderRosterTooSmall(cols: number, rows: number): { lines: string[] } {
    this.displayedRoster = {
      signature: this.rosterSignature(),
      heights: new Map(),
      regions: new Map(),
      cols,
      rows,
      focus: this._focus,
    };
    return this.renderTooSmall(cols, rows);
  }

  /**
   * Variable-height scroll: keeps the complete highlighted entry inside the
   * list window, moves the top only when needed, and pulls the window back
   * up when the whole tail fits (e.g. after a card collapses).
   */
  private scrollWindow(selectedIndex: number, listRows: number): number {
    const heights = this.entries.map((entry) => this.entryHeight(entry));
    const maxTop = Math.max(0, this.entries.length - 1);
    let top = Math.min(Math.max(this.listTop, 0), maxTop);
    if (selectedIndex >= 0) {
      if (selectedIndex < top) {
        top = selectedIndex;
      }
      let used = 0;
      for (let index = top; index <= selectedIndex; index += 1) {
        used += heights[index] ?? 1;
      }
      while (used > listRows && top < selectedIndex) {
        used -= heights[top] ?? 1;
        top += 1;
      }
    }
    let tail = 0;
    for (let index = top; index < heights.length; index += 1) {
      tail += heights[index] ?? 1;
    }
    while (top > 0 && tail + (heights[top - 1] ?? 1) <= listRows) {
      top -= 1;
      tail += heights[top] ?? 1;
    }
    this.listTop = top;
    return top;
  }

  /**
   * One entry's rows. Native-session cards: a title line holding ONLY the
   * sanitized canonical title, a status line (selection marker plus
   * observed/unknown agent and input state), an honest background-count
   * line, and — when expanded — two generic sanitized activity rows.
   */
  private renderEntryLines(entry: SidebarEntry, selected: boolean, cols: number): string[] {
    const marker = selected ? "> " : "  ";
    if (entry.kind === "item" && entry.item !== undefined) {
      const item = entry.item;
      // One focus-domain title highlight: white identifies the ACTUAL active
      // Main conversation only while Main has focus; blue identifies the LEFT
      // selected navigation target while the sidebar-owned surfaces have
      // focus. Never both at once, and never a false sibling/owner mark.
      let titleSgr: string;
      if (this._focus === "main" && this.activeMainOwnerID_ === item.id) {
        titleSgr = SGR_ACTIVE_MAIN_WHITE;
      } else if (selected && this._focus !== "main") {
        titleSgr = SGR_SELECTION_BLUE;
      } else {
        titleSgr = "\x1b[1m";
      }
      const lines = [
        wrapRow(cardTitle(item), cols, titleSgr),
        wrapRow(`${marker}${cardStatusText(item)}`, cols),
        wrapRow(`  ${cardBackgroundText(item)}`, cols),
      ];
      if (!this.collapsedItemIds.has(item.id)) {
        const activity = renderActivityLines(item.activity, cols);
        while (activity.length < ACTIVITY_LINES_MAX) {
          activity.push(wrapRow("", cols));
        }
        lines.push(...activity);
      }
      return lines;
    }
    const text = entry.kind === "saved"
      ? `${marker}Saved conversations`
      : entry.kind === "new"
        ? `${marker}New session`
        : `${marker}Quit host`;
    // Host-owned action rows take the blue selection target while a
    // sidebar-owned surface has focus; they are never the native active owner.
    return [wrapRow(text, cols, selected && this._focus !== "main" ? SGR_SELECTION_BLUE : undefined)];
  }

  private renderFormPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const editing = this.formKind === "edit";
    const header = editing ? " Edit native session name " : " New session ";
    const hints = editing
      ? [`${this.formHints.submit} save`, `${this.formHints.cancel} cancel`, `${this.formHints.clear} clear`, `${this.formHints.externalEditor} external editor`]
      : [`${this.formHints.submit} create`, `${this.formHints.cancel} cancel`, `${this.formHints.complete} complete`, `${this.formHints.clear} clear`, `${this.formHints.externalEditor} external editor`];
    const footerLines = wrapHintLines(hints, cols);
    const noticeLines = this.formNotice === undefined
      ? []
      : wrapHintLines([`! ${this.formNotice}`], cols);
    if (footerLines === undefined || noticeLines === undefined || visibleWidth(header) > cols || !this.formField) {
      return this.renderTooSmall(cols, rows);
    }
    const fixedRows = 1 + (editing ? 2 : 0) + 1 + 1 + noticeLines.length + footerLines.length;
    const fieldRows = rows - fixedRows;
    if (fieldRows < 1) return this.renderTooSmall(cols, rows);

    const prefix = editing ? "> New name: " : "> Workspace: ";
    const prefixWidth = Math.min(visibleWidth(prefix), cols - 1);
    const fieldWidth = Math.max(1, cols - prefixWidth);
    const fieldFrame = this.formField.render(fieldWidth, fieldRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    if (editing) {
      lines.push(wrapRow(" Current name (display only; type a complete replacement): ", cols));
      const currentName = sanitizeBounded(this.editTarget?.currentName ?? "", 256);
      lines.push(wrapRow(truncateToWidth(currentName, cols, "...", true), cols));
    }
    const fieldTopRow = lines.length;
    const fieldRowsToShow = Math.min(fieldRows, fieldFrame.lines.length);
    for (let index = 0; index < fieldRowsToShow; index += 1) {
      const source = fieldFrame.lines[index] ?? "";
      const positionedSource = index === 0 ? `${prefix}${source}` : `${" ".repeat(prefixWidth)}${source}`;
      lines.push(wrapRow(positionedSource, cols));
    }
    lines.push(
      this.pendingCreate !== undefined
        ? wrapRow(` Starting (request ${this.pendingCreate.requestId}) `, cols)
        : this.pendingRename !== undefined
          ? wrapRow(" Saving native name... ", cols)
          : this.formError !== undefined
            ? wrapRow(` ! ${this.formError} `, cols)
            : "",
    );
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));

    return {
      lines,
      cursor: {
        column: Math.min(prefixWidth + fieldFrame.cursor.column, cols - 1),
        row: fieldTopRow + fieldFrame.cursor.row,
      },
    };
  }

  /**
   * The deliberate saved-conversation picker: canonical captions only, with
   * truthful loading/empty/unavailable/partial notices and wrapped keyboard
   * hints. It occupies the same form-pane slot (right pane on wide layouts,
   * full-content overlay on narrow ones) as New/Edit.
   */
  private renderSavedPane(cols: number, rows: number): { lines: string[] } {
    // A fresh render starts with no displayed rows; a too-small fallback never
    // establishes a displayable selection, so the saved-open guard stays closed.
    this.displayedSavedRows = undefined;
    const header = " Saved conversations ";
    const footerLines = wrapHintLines(
      [`${this.toggleLabel} toggle`, "up/down select", "enter open", "esc back"],
      cols,
    );
    const noticeLines = this.savedError === undefined
      ? []
      : wrapHintLines([`! ${this.savedError}`], cols);
    const issueLines = this.pendingSavedList === undefined && this.savedIssueCount > 0
      ? wrapHintLines([`${this.savedIssueCount} catalog issue(s) not shown`], cols)
      : [];
    if (footerLines === undefined || noticeLines === undefined || issueLines === undefined
      || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    // The fixed details area is reserved between the list and the footer so
    // notices can never displace it or make an impossible action look done.
    const fixedRows = 1 + SAVED_DETAILS_ROWS + noticeLines.length + issueLines.length + footerLines.length;
    const listRows = rows - fixedRows;
    if (listRows < 1) {
      return this.renderTooSmall(cols, rows);
    }

    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    let y = 0;
    if (this.pendingSavedList !== undefined) {
      lines.push(wrapRow(" Loading saved conversations... ", cols));
      y += 1;
    } else if (this.savedRows.length === 0) {
      // A failed listing never establishes an empty catalog; only a
      // successful issue-free empty one says "No saved conversations".
      if (this.savedError === undefined) {
        lines.push(wrapRow(
          this.savedIssueCount > 0 ? " No conversations could be listed " : " No saved conversations ",
          cols,
        ));
        y += 1;
      }
    } else {
      const top = this.savedScrollWindow(listRows);
      let index = top;
      const displayed: DisplayedSavedRow[] = [];
      while (index < this.savedRows.length && y < listRows) {
        const row = this.savedRows[index];
        displayed.push({ paneRow: lines.length, index, entry: row });
        lines.push(this.renderSavedRow(row, index === this.savedSelectedIndex, cols));
        y += 1;
        index += 1;
      }
      // Record exact draw-derived row locations and identity so a click/open
      // can target only a row the user actually saw; undrawn/hidden rows stay refused.
      this.displayedSavedRows = { cols, rows, entries: displayed };
    }
    // Pad the list window so the details area sits at a fixed position (just
    // above the footer), not floating up when there are few rows.
    lines.push(...blankLines(Math.max(0, listRows - y)));
    // Fixed details area for the highlighted row, updated in the same frame as
    // the list highlight. Empty (never a fabricated workspace) while loading,
    // empty, or failed; late listings are fenced by the pending request.
    const selectedRow = this.pendingSavedList === undefined && this.savedRows.length > 0
      ? this.savedRows[this.savedSelectedIndex]
      : undefined;
    for (const detailLine of this.renderSavedDetails(selectedRow, cols)) {
      lines.push(wrapRow(detailLine, cols));
    }
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    for (const issueLine of issueLines) lines.push(wrapRow(issueLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));
    return { lines };
  }

  /**
   * The fixed details area for one highlighted saved row: the conversation
   * caption and its EXACT recorded workspace, wrapped within the reserved
   * rows. A missing recorded workspace renders as unavailable, never a
   * current-workspace guess. Display only; it never feeds admission.
   */
  private renderSavedDetails(row: SidebarSavedRow | undefined, cols: number): string[] {
    if (row === undefined) {
      return blankLines(SAVED_DETAILS_ROWS);
    }
    const caption = sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    const workspace = row.cwd !== undefined
      ? sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS)
      : "workspace unavailable";
    // Reserve independent capacity for each field so a long multiword caption
    // cannot consume every row and hide the workspace (and vice versa). The
    // caption gets one row; the workspace gets the remaining rows with
    // column-safe wrapping that splits long path tokens across rows.
    const captionLines = wrapBoundedField(caption, cols, 1);
    const workspaceLines = wrapBoundedField(workspace, cols, SAVED_DETAILS_ROWS - 1);
    return [...captionLines, ...workspaceLines];
  }

  /** Keeps the keyboard-highlighted saved row visible inside the list window. */
  private savedScrollWindow(listRows: number): number {
    const maxTop = Math.max(0, this.savedRows.length - 1);
    let top = Math.min(Math.max(this.savedListTop, 0), maxTop);
    if (this.savedSelectedIndex < top) {
      top = this.savedSelectedIndex;
    } else if (this.savedSelectedIndex >= top + listRows) {
      top = this.savedSelectedIndex - listRows + 1;
    }
    this.savedListTop = top;
    return top;
  }

  private renderSavedRow(row: SidebarSavedRow, selected: boolean, cols: number): string {
    const marker = selected ? "> " : "  ";
    const markerWidth = visibleWidth(marker);
    const caption = sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    let text: string;
    if (row.cwd !== undefined) {
      // One single line per entry: caption and recorded workspace summaries,
      // each fairly bounded and visibly ellipsized. The caption stays the
      // row's leading identity so picker witnesses keep matching.
      const separator = " | ";
      const available = Math.max(0, cols - markerWidth - visibleWidth(separator));
      const captionWidth = Math.floor(available / 2);
      const cwdWidth = Math.max(0, available - captionWidth);
      const cwd = sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS);
      const visibleCaption = captionWidth > 0 ? truncateToWidth(caption, captionWidth, "...", true) : "";
      const visibleCwd = cwdWidth > 0 ? truncateToWidth(cwd, cwdWidth, "...", true) : "";
      text = `${marker}${visibleCaption}${separator}${visibleCwd}`;
    } else {
      // No recorded workspace: caption only, never a fabricated default.
      const labelWidth = Math.max(0, cols - markerWidth);
      const visibleLabel = labelWidth > 0 ? truncateToWidth(caption, labelWidth, "...", true) : "";
      text = `${marker}${visibleLabel}`;
    }
    return wrapRow(text, cols, selected ? SGR_SELECTION_BLUE : undefined);
  }

  private renderConfirmPane(cols: number, rows: number): { lines: string[] } {
    if (this.confirmPurpose === "stop-remove") {
      return this.renderStopRemoveConfirmPane(cols, rows);
    }
    const header = " Quit host? ";
    const liveCount = this.rowStore.filter(requiresQuitConfirmation).length;
    const countLines = wrapHintLines(
      [`${liveCount} session(s) starting, alive, or host-owned`],
      cols,
    );
    const hintLines = wrapHintLines(["enter/y = quit host", "esc/n = cancel"], cols);
    if (countLines === undefined || hintLines === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    if (rows < 1 + countLines.length + hintLines.length) {
      return this.renderTooSmall(cols, rows);
    }
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of countLines) {
      lines.push(wrapRow(line, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - hintLines.length)));
    for (const line of hintLines) {
      lines.push(wrapRow(line, cols));
    }
    return { lines };
  }

  /**
   * The explicit stop confirmation: the frozen target's title (or a truthful
   * gone notice), the warning that its active turn, questions, background
   * tasks, and shells will be stopped, and the confirm/cancel hints.
   */
  private renderStopRemoveConfirmPane(cols: number, rows: number): { lines: string[] } {
    const header = " Stop session? ";
    const target = this.stopRemoveTargetId !== undefined
      ? this.findItemEntry(this.stopRemoveTargetId)
      : undefined;
    // The title truncates to the pane so it can never push the warning or
    // hints out of the dialog.
    const targetLines = wrapHintLines(
      [target?.item !== undefined
        ? truncateToWidth(cardTitle(target.item), cols, "...", true)
        : "The session no longer exists"],
      cols,
    );
    const warningLines = wrapHintLines(
      ["Stopping will stop its active turn, questions, background tasks, and shells"],
      cols,
    );
    const hintLines = wrapHintLines(["enter/y = stop", "esc/n = cancel"], cols);
    if (targetLines === undefined || warningLines === undefined || hintLines === undefined
      || visibleWidth(header) > cols) {
      this.stopConfirmDisplayed = false;
      return this.renderTooSmall(cols, rows);
    }
    if (rows < 1 + targetLines.length + warningLines.length + hintLines.length) {
      this.stopConfirmDisplayed = false;
      return this.renderTooSmall(cols, rows);
    }
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of targetLines) {
      lines.push(wrapRow(line, cols));
    }
    for (const line of warningLines) {
      lines.push(wrapRow(line, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - hintLines.length)));
    for (const line of hintLines) {
      lines.push(wrapRow(line, cols));
    }
    this.stopConfirmDisplayed = true;
    return { lines };
  }
}

/**
 * Word-wraps text with hard line breaks into at most `maxLines` rows of
 * visible width `cols`. A single word wider than the pane is ellipsized.
 * When the content overflows the reserved rows, the last row carries an
 * explicit truncation marker instead of silently dropping text.
 */
/**
 * Column-safe wrapping of one bounded field into at most `maxLines` rows of
 * visible width `cols`. Grapheme clusters (including spaces and wide Unicode)
 * are preserved in order; a token longer than a row is split across rows
 * rather than immediately ellipsized. When the content overflows the reserved
 * rows, the last row carries an explicit truncation marker instead of silently
 * dropping text.
 */
const detailGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapBoundedField(text: string, cols: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const { segment: char } of detailGraphemes.segment(text)) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    const candidate = current + char;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
    } else {
      lines.push(current);
      current = char; // preserve the character (including spaces) on the new row
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  }
  if (current !== "") {
    if (lines.length < maxLines) lines.push(current);
    else truncated = true;
  }
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1];
    const base = truncateToWidth(last, Math.max(1, cols - 3), "", true);
    lines[lines.length - 1] = `${base}...`;
  }
  while (lines.length < maxLines) lines.push("");
  return lines.slice(0, maxLines);
}

function renderActivityLines(activity: readonly string[], cols: number): string[] {
  return activity
    .map((line) => sanitizeCellText(line))
    .filter((line) => line.length > 0)
    .slice(0, ACTIVITY_LINES_MAX)
    .map((line) =>
      wrapRow(`    ${sanitizeBounded(line, ACTIVITY_INPUT_MAX_CODEPOINTS)}`, cols),
    );
}

function fieldRejectionNotice(reason: SessionHostFieldRejection): string {
  switch (reason) {
    case "unsafe-text": return "Unsafe terminal text was rejected";
    case "text-limit": return "Field value exceeds its limit";
    case "paste-limit": return "Pasted text exceeds the field limit";
    case "input-chunk-limit": return "Input chunk exceeds the field limit";
    case "completion-limit": return "Native completion exceeds the field limit";
    case "external-editor-failed": return "External editor did not complete; the field was not changed";
  }
}

function renameFailureNotice(status: string): string {
  switch (status) {
    case "stale-session": return "Native conversation changed; reopen Edit before renaming";
    case "unavailable": return "Native session rename is unavailable";
    case "invalid-name": return "New name is invalid or exceeds 1024 UTF-8 bytes";
    case "setter-failed": return "Pi could not set the new session name";
    case "verification-failed": return "Pi could not verify the native session name";
    case "busy": return "Session name was not changed while Pi is busy";
    case "timeout": return "Session rename timed out; verify the session name before retrying";
    case "disconnected": return "Status connection closed; session name was not confirmed";
    case "invalid-request": return "Session rename request was rejected";
    default: return "Session name could not be changed";
  }
}