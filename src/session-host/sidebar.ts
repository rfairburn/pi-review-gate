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
 * - UI actions never stop an instance: hiding the sidebar, confirming an
 *   item, abandoning a form, or asking to remove an exited row only emits
 *   visibility/select/create/quit/remove action DTOs; the backend decides
 *   what they mean. Removal never signals a process or deletes persistent
 *   files.
 * - Escape in MAIN focus is never intercepted (it stays native input, e.g.
 *   native menu cancellation); while MAIN is focused every chunk — including
 *   `q`/Ctrl+C and terminal-native bytes like bracketed pastes and Kitty key
 *   releases — is forwarded unchanged except the reserved, configurable
 *   toggle chord (legacy and Kitty packets both honored via the real
 *   matchesKey).
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
  /** true/false when observed; null means unknown (never rendered as false). */
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  /** Generic top-level activity lines; at most 2 are rendered, sanitized. */
  readonly activity: readonly string[];
	/** Last validated canonical native conversation identity and display name. */
	readonly nativeSession?: SessionHostNativeSession | null;
  readonly exitCode?: number;
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
}

/** Actions the sidebar asks the backend to perform. */
export type SidebarAction =
  | { readonly type: "forward"; readonly data: string }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "remove"; readonly id: string }
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
]);

interface SidebarEntry {
  /** Internal key; real item ids are namespaced with "item:" to stay unique. */
  readonly key: string;
  readonly kind: "item" | "saved" | "new" | "quit";
  readonly item?: SidebarItem;
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
const ACTIVITY_LINES_MAX = 2;
const ACTIVITY_INPUT_MAX_CODEPOINTS = 400;
const SAVED_CAPTION_MAX_CODEPOINTS = 256;
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

/** Truthful textual state badges plus the input-observed marker. */
function rowBadges(item: SidebarItem): string {
  const badges: string[] = [];
  switch (item.lifecycle) {
    case "starting":
      badges.push("[starting]");
      break;
    case "alive":
      badges.push(
        item.busy === true
          ? "[AGENT: running]"
          : item.busy === false
            ? "[AGENT: idle]"
            : "[AGENT: unknown]",
      );
      break;
    case "exited":
      badges.push(
        typeof item.exitCode === "number"
          ? `[exited (code ${Math.trunc(item.exitCode)})]`
          : "[exited]",
      );
      break;
    case "error":
      badges.push(
        typeof item.exitCode === "number"
          ? `[error (code ${Math.trunc(item.exitCode)})]`
          : "[error]",
      );
      break;
  }
  // Input observation is only claimed when it was actually observed; unknown
  // (null) is never rendered as if input were not pending.
  if (
    (item.pendingInput === true || item.inputSurface === true) &&
    (item.lifecycle === "starting" || item.lifecycle === "alive")
  ) {
    badges.push("[input]");
  }
  const text = badges.join(" ");
  return text.length === 0 ? "" : ` ${text}`;
}

function requiresQuitConfirmation(item: SidebarItem): boolean {
  return (
    item.lifecycle === "starting" ||
    item.lifecycle === "alive" ||
    item.hasLiveProcess === true
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
  };
}

function assertPaneDimension(value: number, max: number, label: "cols" | "rows"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(
      `Sidebar render ${label} must be a safe integer between 1 and ${max}, got ${value}`,
    );
  }
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
  private savedRows: SidebarSavedRow[] = [];
  private savedIssueCount = 0;
  private savedError: string | undefined;
  private savedSelectedIndex = 0;
  private savedListTop = 0;
  private editTarget?: { readonly id: string; readonly nativeSession: SessionHostNativeSession; readonly currentName: string };
  private workspaceDraft: string;
  private editDraft = "";
  private rowStore: SidebarItem[] = [];
  private entries: SidebarEntry[] = [];
  private selectedEntryKey: string | undefined = ENTRY_NEW_KEY;
  private desiredSelectionId: string | undefined;
  private _visible: boolean;
  private _focus: SidebarFocus = "main";
  private pendingCreate: { readonly requestId: number } | undefined;
  private pendingRename: { readonly requestId: number } | undefined;
  private formError: string | undefined;
  private noticeError: string | undefined;
  private nextRequestId = 1;
  private listTop = 0;

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
    if (this.desiredSelectionId !== undefined) {
      const resolved = this.findItemEntry(this.desiredSelectionId);
      if (resolved !== undefined) {
        this.selectedEntryKey = resolved.key;
        this.desiredSelectionId = undefined;
      }
      // A still-pending desired selection stays pending until its row
      // actually appears; no index-based guess is ever made.
      return;
    }
    const entry = this.currentEntry();
    if (this.selectedEntryKey !== undefined && entry === undefined
      && this.selectedEntryKey.startsWith(ITEM_KEY_PREFIX)) {
      // The highlighted instance vanished: show the picker and pull focus
      // back to the list.
      this.selectedEntryKey = undefined;
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

  /** Backend-driven selection (e.g. for a spawn the host initiated). */
  select(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("SidebarController.select expects a nonempty string id");
    }
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
   * Resolves a pending create. The new row is highlighted only when the
   * request still owns the form; late completions never steal focus from a
   * newer selection or form draft.
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
      this._focus = "sidebar";
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

  /** Shows a bounded, sanitized error near the pane's footer. */
  showError(message: string): void {
    this.noticeError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
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
      return this.renderTooSmall(cols, rows);
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
    if (this._focus === "form") {
      return this.renderForm(cols, rows);
    }
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
      return this.renderTooSmall(cols, rows);
    }
    if (this._focus === "confirm") {
      return this.renderConfirmPane(cols, rows);
    }
    return this.renderRosterPane(cols, rows);
  }

  // --- Main focus: everything is forwarded unchanged except the toggle. ---

  private handleMainInput(data: string): void {
    if (this.handleReservedToggle(data)) {
      return;
    }
    // Nonreserved releases and repeats are forwarded verbatim for the child
    // adapter to interpret under its own Kitty-protocol state.
    this.emitForward(data);
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

  // --- Sidebar focus: roster navigation, New session, Quit host. ---

  private handleSidebarInput(data: string): void {
    if (this.handleReservedToggle(data) || isKeyRelease(data)) {
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
      this.activateEntry();
      return;
    }
    if (
      matchesKey(data, "delete") ||
      (this.toggleKey === "delete" && ["x", "X"].includes(printableOf(data) ?? ""))
    ) {
      this.removeSelectedEntry();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.hide();
      return;
    }
    const printable = printableOf(data);
    if (printable === "e" || printable === "E") {
      this.editSelectedEntry();
      return;
    }
    if (printable === "q" || printable === "Q") {
      // Menu `q` is the same explicit Quit action as the Quit host row.
      this.activateQuit();
    }
  }

  private moveSelection(delta: number): void {
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

  private activateEntry(): void {
    const entry = this.currentEntry();
    if (entry === undefined) {
      return;
    }
    if (entry.kind === "item" && entry.item !== undefined) {
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

  /** Requests backend removal by the selected row's stable host-owned id. */
  private removeSelectedEntry(): void {
    const entry = this.currentEntry();
    if (entry === undefined || entry.kind !== "item" || entry.item === undefined) {
      this.noticeError = "Select a session row to remove";
      return;
    }
    // The backend is authoritative about confirmed exit. A Delete attempt on
    // a live, unconfirmed, or stale row is safe and produces a bounded notice
    // when closeExited refuses it.
    this.noticeError = undefined;
    this.emit({ type: "remove", id: entry.item.id });
  }

  /**
   * Quit requires confirmation for starting/alive rows or any row whose
   * snapshot says the host still owns a live process. With none, the explicit
   * quit action is emitted immediately; no other key path quits the host.
   */
  private activateQuit(): void {
    const hasLive = this.rowStore.some(requiresQuitConfirmation);
    if (hasLive) {
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
    if (this.handleReservedToggle(data, () => this.abandonForm())) return;
    if (isKeyRelease(data)) return;
    if (this.pendingCreate || this.pendingRename) {
      if (this.formMatchesCancel(data)) this.escapeFromForm();
      return;
    }
    if (this.formField) this.formField.handleInput(data);
    else if (matchesKey(data, "escape")) this.escapeFromForm();
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
    this._focus = "sidebar";
  }

  private handleSavedPaneInput(data: string): void {
    // Bracketed paste is opaque in the picker and never activates a row; a
    // streamed body chunk that merely equals the toggle must not dismiss.
    if (this.routeBracketedPaste(data)) return;
    if (this.handleReservedToggle(data, () => this.dismissSavedPane())) return;
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
    if (this.pendingSavedOpen !== undefined) {
      this.savedError = "A saved conversation is already starting";
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingSavedOpen = { requestId };
    this.savedError = undefined;
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
      });
    }
    this.savedRows = accepted;
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
   * Completes a deliberate saved-open. The new row is highlighted only while
   * the request still owns the open pane; highlighting is not ownership
   * transfer — only a later explicit host-row Enter activates it.
   */
  completeSavedOpen(requestId: number, id: string): void {
    if (this.pendingSavedOpen?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedOpen = undefined;
    if (this._focus === "form" && this.formKind === "saved") {
      this.savedError = undefined;
      this.acceptCompletedRow(id);
      this.disposeFormField();
      this.formKind = undefined;
      this._focus = "sidebar";
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
    this.hide();
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

  // --- Confirm focus: explicit quit confirmation. ---

  private handleConfirmInput(data: string): void {
    if (this.handleReservedToggle(data) || isKeyRelease(data)) {
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
    this._visible = false;
    this._focus = "main";
    this.emit({ type: "visibility", visible: false });
  }

  /**
   * Reserved toggle: shows the pane (focus returns to the roster picker) or
   * hides it (focus returns to main). Only the visibility action is emitted.
   */
  private toggle(): void {
    if (this._visible) {
      this.hide();
      return;
    }
    this._visible = true;
    this._focus = "sidebar";
    this.emit({ type: "visibility", visible: true });
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
          ? [this.toggleKey === "delete" ? "x remove exited" : "delete remove exited"]
          : []),
        "esc hide",
        "q quit",
      ],
      cols,
    );
    const noticeLines = this.noticeError === undefined
      ? []
      : wrapHintLines([`! ${this.noticeError}`], cols);
    if (footerLines === undefined || noticeLines === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    const listRows = rows - 1 - noticeLines.length - footerLines.length;
    // At least one entry row is required: a picker whose selected target is
    // invisible would let Enter activate something the user cannot see.
    if (listRows < 1) {
      return this.renderTooSmall(cols, rows);
    }
    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    const selectedIndex = this.entries.findIndex((entry) => entry.key === this.selectedEntryKey);
    const top = this.scrollWindow(selectedIndex, listRows);
    let y = 0;
    let index = top;
    while (index < this.entries.length && y < listRows) {
      const entry = this.entries[index];
      const selectedRow = index === selectedIndex;
      lines.push(this.renderEntry(entry, selectedRow, cols));
      y += 1;
      if (selectedRow && entry.kind === "item" && entry.item !== undefined) {
        for (const activityLine of renderActivityLines(entry.item.activity, cols)) {
          if (y >= listRows) {
            break;
          }
          lines.push(activityLine);
          y += 1;
        }
      }
      index += 1;
    }
    for (const noticeLine of noticeLines) {
      lines.push(wrapRow(noticeLine, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) {
      lines.push(wrapRow(footerLine, cols));
    }
    return { lines };
  }

  /** Keeps the keyboard-highlighted entry visible inside the list window. */
  private scrollWindow(selectedIndex: number, listRows: number): number {
    const maxTop = Math.max(0, this.entries.length - 1);
    let top = Math.min(Math.max(this.listTop, 0), maxTop);
    if (selectedIndex >= 0) {
      if (selectedIndex < top) {
        top = selectedIndex;
      } else if (selectedIndex >= top + listRows) {
        top = selectedIndex - listRows + 1;
      }
    }
    this.listTop = top;
    return top;
  }

  private renderEntry(entry: SidebarEntry, selected: boolean, cols: number): string {
    const marker = selected ? "> " : "  ";
    let text: string;
    if (entry.kind === "item" && entry.item !== undefined) {
      const item = entry.item;
      const label = sanitizeBounded(item.nativeSession?.name ?? item.label, ITEM_LABEL_INPUT_MAX_CODEPOINTS);
      const badges = rowBadges(item);
      const labelWidth = Math.max(0, cols - visibleWidth(marker) - visibleWidth(badges));
      const visibleLabel = labelWidth > 0 ? truncateToWidth(label, labelWidth, "...") : "";
      text = `${marker}${visibleLabel}${badges}`;
    } else if (entry.kind === "saved") {
      text = `${marker}Saved conversations`;
    } else if (entry.kind === "new") {
      text = `${marker}New session`;
    } else {
      text = `${marker}Quit host`;
    }
    return wrapRow(text, cols, selected ? "\x1b[1;7m" : undefined);
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
    const fixedRows = 1 + noticeLines.length + issueLines.length + footerLines.length;
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
      while (index < this.savedRows.length && y < listRows) {
        const row = this.savedRows[index];
        lines.push(this.renderSavedRow(row, index === this.savedSelectedIndex, cols));
        y += 1;
        index += 1;
      }
    }
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    for (const issueLine of issueLines) lines.push(wrapRow(issueLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));
    return { lines };
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
    const labelWidth = Math.max(0, cols - visibleWidth(marker));
    const label = sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    const visibleLabel = labelWidth > 0 ? truncateToWidth(label, labelWidth, "...") : "";
    return wrapRow(`${marker}${visibleLabel}`, cols, selected ? "\x1b[1;7m" : undefined);
  }

  private renderConfirmPane(cols: number, rows: number): { lines: string[] } {
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
}

function renderActivityLines(activity: readonly string[], cols: number): string[] {
  return activity
    .map((line) => sanitizeCellText(line))
    .filter((line) => line.length > 0)
    .slice(0, ACTIVITY_LINES_MAX)
    .map((line) =>
      wrapRow(`   ${sanitizeBounded(line, ACTIVITY_INPUT_MAX_CODEPOINTS)}`, cols),
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