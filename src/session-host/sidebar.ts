/**
 * Pure keyboard sidebar controller and bounded roster/form renderer for the
 * optional custom session host terminal sidebar (#323).
 *
 * Each sidebar row is an independent native process; the main UI is its
 * nativePTY frame, so this module renders ONLY the sidebar-owned panes: the
 * roster snapshot (top-level public agent/input/activity metadata) and the
 * New session form. It returns plain, bounded lines at the supplied pane
 * geometry — `render()` for the focused pane, `renderRoster()`/`renderForm()`
 * for the wide layout that shows both at once. The compositor owns offsets,
 * composition over the native frame, the real TTY, and resizing.
 *
 * Hard boundaries of this module (pure frontend):
 *
 * - No process, PTY, network, filesystem, config, Git, or model work. All
 *   lifecycle/roster truth arrives as `SidebarItem` DTOs from the backend;
 *   launch/path/profile validation stays in the backend. No host module is
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
 *   (legacy, modifyOtherKeys, and Kitty CSI-u packets) plus its Input class
 *   provide field editing, grapheme-safe caret movement, Ctrl+U line kill,
 *   and bounded single-line bracketed paste.
 * - No native widget ownership: the roster and form are plain text + SGR.
 *
 * Stable DTO/API surface for future root-host phases: `SidebarItem`,
 * `SidebarAction`, `SidebarControllerOptions`, and `SidebarController` with
 * the getters/setters documented below. Internal shapes may evolve.
 */

import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  Input,
  isKeyRelease,
  isKeyRepeat,
  type KeyId,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "pi-session-host-tui";

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
  readonly exitCode?: number;
}

/** Actions the sidebar asks the backend to perform. */
export type SidebarAction =
  | { readonly type: "forward"; readonly data: string }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "remove"; readonly id: string }
  | {
      readonly type: "create";
      readonly requestId: number;
      readonly label: string;
      readonly workspace: string;
      readonly profile?: string;
    }
  | { readonly type: "quit" }
  | { readonly type: "visibility"; readonly visible: boolean };

export interface SidebarControllerOptions {
  /** Canonical native KeyId or a bounded known alternative (e.g. "f8"). */
  readonly toggleKey?: string;
  /** Suggested editable workspace path pre-filled in the New session form. */
  readonly initialWorkspace?: string;
  /** Initial visibility (default true: the empty welcome picker shows). */
  readonly initialVisible?: boolean;
  readonly onAction?: (action: SidebarAction) => void;
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
  readonly kind: "item" | "new" | "quit";
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
const LABEL_FIELD_MAX_UTF16_CODE_UNITS = 80;
const PATH_FIELD_MAX_CODEPOINTS = 2048;
const LABEL_FIELD_PLACEHOLDER = "session name (required)";
const WORKSPACE_FIELD_PLACEHOLDER = "workspace path (required)";
const PROFILE_FIELD_PLACEHOLDER = "profile (blank = fresh)";
const ACTIVITY_LINES_MAX = 2;
const ACTIVITY_INPUT_MAX_CODEPOINTS = 400;
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

/** Longest suffix of text that could become the start of marker next packet. */
function markerPrefixSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
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

/** Prompt gutter width owned by the sidebar, not by the public Input widget. */
const PREFIELD_WIDTH = 13;

interface FieldSnapshot {
  readonly value: string;
}

/** Bracketed paste markers accumulated by the sidebar before public Input. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/** Total streamed bytes allowed per bracketed paste accumulation. */
const MAX_PASTE_BYTES = 8192;

export class SidebarController {
  private readonly toggleKey: string;
  private readonly toggleLabel: string;
  private readonly onAction?: (action: SidebarAction) => void;
  private readonly labelInput: Input;
  private readonly workspaceInput: Input;
  private readonly profileInput: Input;
  private rowStore: SidebarItem[] = [];
  private entries: SidebarEntry[] = [];
  private selectedEntryKey: string | undefined = ENTRY_NEW_KEY;
  private desiredSelectionId: string | undefined;
  private _visible: boolean;
  private _focus: SidebarFocus = "main";
  private formFieldIndex = 0;
  private pendingCreate: { readonly requestId: number } | undefined;
  private formError: string | undefined;
  private noticeError: string | undefined;
  private nextRequestId = 1;
  private listTop = 0;
  /** Bounded frontend-owned paste accumulator; raw data never reaches Input. */
  private formPasteBuffer: string[] | undefined;
  private formPasteBytes = 0;
  private formPasteOverflow = false;
  private formPasteEndCarry = "";
  private formPasteStartCarry = "";
  private formPasteSnapshot: FieldSnapshot | undefined;

  constructor(options: SidebarControllerOptions = {}) {
    this.toggleKey = normalizeToggleKey(options.toggleKey);
    this.toggleLabel = toggleDisplayName(this.toggleKey);
    this.onAction = options.onAction;
    this._visible = options.initialVisible ?? true;

    const suggestedWorkspace = sanitizeCellText(options.initialWorkspace ?? "");
    if (countCodePoints(suggestedWorkspace) > PATH_FIELD_MAX_CODEPOINTS) {
      throw new Error(
        `initialWorkspace exceeds the ${PATH_FIELD_MAX_CODEPOINTS}-character limit`,
      );
    }
    // Each field is the public pinned Input API. The sidebar renders its own
    // label gutter; Input owns grapheme-safe editing, caret scrolling and SGR.
    this.labelInput = new Input({ prompt: "", placeholder: LABEL_FIELD_PLACEHOLDER });
    this.workspaceInput = new Input({ prompt: "", placeholder: WORKSPACE_FIELD_PLACEHOLDER });
    this.profileInput = new Input({ prompt: "", placeholder: PROFILE_FIELD_PLACEHOLDER });
    this.workspaceInput.setValue(suggestedWorkspace);
    // A visible pane is an opened pane: the welcome picker (default) and a
    // supplied roster both take sidebar focus, while an explicitly hidden
    // start keeps main focus for native typing.
    this._focus = this._visible ? "sidebar" : "main";
    this.rebuildEntries();
    this.labelInput.onSubmit = () => this.advanceField();
    this.workspaceInput.onSubmit = () => this.advanceField();
    this.profileInput.onSubmit = () => this.submitForm();
    for (const field of [this.labelInput, this.workspaceInput, this.profileInput]) {
      field.onEscape = () => this.escapeFromForm();
    }
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
    // not the native launch. Preserve the draft and current focus.
    this.pendingCreate = undefined;
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
    this.formFieldIndex = 0;
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
    if (entry.kind === "new") {
      this.formFieldIndex = 0;
      this._focus = "form";
      return;
    }
    this.activateQuit();
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

  // --- Form focus: three fields via the real Input class. ---

  private handleFormInput(data: string): void {
    const parsingPaste = this.formPasteBuffer !== undefined;
    if (!parsingPaste) {
      if (
        this.handleReservedToggle(data, () => {
          // Abandon UI ownership only; a native launch already handed to the
          // backend is never stopped and callbacks become stale.
          this.pendingCreate = undefined;
          this.resetFormPaste();
        })
      ) {
        return;
      }
      if (isKeyRelease(data)) {
        return;
      }
    }
    this.feedFormField(data);
  }

  /**
   * Parses bracketed paste framing before data reaches the real Input. Raw
   * paste bytes are accumulated only up to MAX_PASTE_BYTES, sanitized as a
   * complete string (so split terminal sequences are removed), then delivered
   * to Input as one safe paste. Normal key packets still use Input directly.
   */
  private feedFormField(data: string): void {
    const field = this.activeField();
    if (this.formPasteBuffer !== undefined) {
      this.consumeFormPaste(data, field);
      return;
    }
    const before = { value: field.getValue() };
    this.feedOutsidePaste(data, field, before);
  }

  private feedOutsidePaste(data: string, field: Input, before: FieldSnapshot): void {
    // Escape is an immediate form cancel, not an incomplete paste prefix.
    if (this.formPasteStartCarry.length === 0 && matchesKey(data, "escape")) {
      field.handleInput(data);
      return;
    }
    const combined = this.formPasteStartCarry + data;
    this.formPasteStartCarry = "";
    const startIndex = combined.indexOf(BRACKETED_PASTE_START);
    if (startIndex >= 0) {
      const prefix = combined.slice(0, startIndex);
      if (prefix.length > 0) {
        field.handleInput(prefix);
        this.enforceFieldLimit(field, before);
      }
      this.formPasteBuffer = [];
      this.formPasteBytes = 0;
      this.formPasteOverflow = false;
      this.formPasteEndCarry = "";
      this.formPasteSnapshot = { value: field.getValue() };
      this.consumeFormPaste(combined.slice(startIndex + BRACKETED_PASTE_START.length), field);
      return;
    }
    const carryLength = markerPrefixSuffixLength(combined, BRACKETED_PASTE_START);
    const ordinary = combined.slice(0, combined.length - carryLength);
    this.formPasteStartCarry = combined.slice(combined.length - carryLength);
    if (ordinary.length > 0) {
      field.handleInput(ordinary);
    }
    this.enforceFieldLimit(field, before);
  }

  private consumeFormPaste(data: string, field: Input): void {
    const combined = this.formPasteEndCarry + data;
    const endIndex = combined.indexOf(BRACKETED_PASTE_END);
    const body = endIndex >= 0 ? combined.slice(0, endIndex) : combined;
    const carryLength = endIndex >= 0 ? 0 : markerPrefixSuffixLength(body, BRACKETED_PASTE_END);
    this.appendPasteBytes(body.slice(0, body.length - carryLength));
    this.formPasteEndCarry = endIndex >= 0 ? "" : body.slice(body.length - carryLength);
    if (endIndex < 0) {
      return;
    }

    const remainder = combined.slice(endIndex + BRACKETED_PASTE_END.length);
    const before = this.formPasteSnapshot ?? { value: field.getValue() };
    if (this.formPasteOverflow) {
      this.formError = `Paste exceeds ${MAX_PASTE_BYTES} bytes`;
    } else {
      const safePaste = sanitizeCellText((this.formPasteBuffer ?? []).join(""));
      field.handleInput(`${BRACKETED_PASTE_START}${safePaste}${BRACKETED_PASTE_END}`);
      this.enforceFieldLimit(field, before);
    }
    this.clearPasteState();
    if (remainder.length > 0) {
      const freshBefore = { value: field.getValue() };
      this.feedOutsidePaste(remainder, field, freshBefore);
    }
  }

  private appendPasteBytes(text: string): void {
    if (this.formPasteOverflow || text.length === 0) {
      return;
    }
    const buffer = this.formPasteBuffer;
    if (buffer === undefined) {
      return;
    }
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (this.formPasteBytes + bytes > MAX_PASTE_BYTES) {
        this.formPasteOverflow = true;
        return;
      }
      buffer.push(char);
      this.formPasteBytes += bytes;
    }
  }

  private clearPasteState(): void {
    this.formPasteBuffer = undefined;
    this.formPasteBytes = 0;
    this.formPasteOverflow = false;
    this.formPasteEndCarry = "";
    this.formPasteStartCarry = "";
    this.formPasteSnapshot = undefined;
  }

  private resetFormPaste(): void {
    // The sidebar parser owns all streamed paste state; Input only receives a
    // complete sanitized bracketed paste through its public handleInput API.
    this.clearPasteState();
  }

  /**
   * Rolls back an over-limit edit through public Input APIs. Input.setValue
   * preserves/clamps its own post-edit caret; the SDK exposes no public way to
   * restore the exact pre-edit caret without reaching into private state.
   */
  private enforceFieldLimit(field: Input, before: FieldSnapshot): void {
    const fieldMax =
      field === this.labelInput ? LABEL_FIELD_MAX_UTF16_CODE_UNITS : PATH_FIELD_MAX_CODEPOINTS;
    const value = field.getValue();
    const length = field === this.labelInput ? value.length : countCodePoints(value);
    if (length > fieldMax) {
      field.setValue(before.value);
      this.formFieldError(fieldMax);
    }
  }

  private activeField(): Input {
    return this.formFieldIndex === 0
      ? this.labelInput
      : this.formFieldIndex === 1
        ? this.workspaceInput
        : this.profileInput;
  }

  private formFieldError(max: number): void {
    this.formError =
      max === LABEL_FIELD_MAX_UTF16_CODE_UNITS
        ? `Label exceeds ${LABEL_FIELD_MAX_UTF16_CODE_UNITS} UTF-16 code units`
        : `Path exceeds ${PATH_FIELD_MAX_CODEPOINTS} characters`;
  }

  private advanceField(): void {
    if (this.formFieldIndex < 2) {
      this.formFieldIndex += 1;
    }
  }

  private submitForm(): void {
    if (this.pendingCreate !== undefined) {
      // Starting state: duplicate Enter is disabled until the backend
      // completes or fails the request.
      return;
    }
    const label = sanitizeCellText(this.labelInput.getValue());
    const workspace = sanitizeCellText(this.workspaceInput.getValue());
    const profile = sanitizeCellText(this.profileInput.getValue());
    if (label.length === 0) {
      this.formFieldIndex = 0;
      this.formError = "Label is required";
      return;
    }
    if (workspace.length === 0) {
      this.formFieldIndex = 1;
      this.formError = "Workspace is required";
      return;
    }
    if (label.length > LABEL_FIELD_MAX_UTF16_CODE_UNITS) {
      this.formFieldError(LABEL_FIELD_MAX_UTF16_CODE_UNITS);
      return;
    }
    if (countCodePoints(workspace) > PATH_FIELD_MAX_CODEPOINTS) {
      this.formFieldError(PATH_FIELD_MAX_CODEPOINTS);
      return;
    }
    if (countCodePoints(profile) > PATH_FIELD_MAX_CODEPOINTS) {
      this.formFieldError(PATH_FIELD_MAX_CODEPOINTS);
      return;
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.pendingCreate = { requestId };
    this.formError = undefined;
    const action: SidebarAction & { profile?: string } = {
      type: "create",
      requestId,
      label,
      workspace,
    };
    if (profile.length > 0) {
      // Blank profile means fresh; only a non-blank profile is emitted.
      action.profile = profile;
    }
    this.emit(action);
  }

  /**
   * Escape inside the form (including Ctrl+C via the real Input cancel
   * binding) abandons only the UI request — a launch already handed to the
   * backend is never killed from here — and hides the pane. Entered field
   * drafts are preserved.
   */
  private escapeFromForm(): void {
    this.pendingCreate = undefined;
    this.hide();
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
      const label = sanitizeBounded(item.label, ITEM_LABEL_INPUT_MAX_CODEPOINTS);
      const badges = rowBadges(item);
      const labelWidth = Math.max(0, cols - visibleWidth(marker) - visibleWidth(badges));
      const visibleLabel = labelWidth > 0 ? truncateToWidth(label, labelWidth, "...") : "";
      text = `${marker}${visibleLabel}${badges}`;
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
    const header = " New session ";
    const footerLines = wrapHintLines(["enter next/submit", "esc toggle-cancel"], cols);
    if (footerLines === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    // header + 3 fields + reserved status row + wrapped footer
    if (rows < 1 + 3 + 1 + footerLines.length) {
      return this.renderTooSmall(cols, rows);
    }
    const fieldContentWidth = Math.max(cols - PREFIELD_WIDTH, 1);
    const prompts = [" Label:     ", " Workspace: ", " Profile:   "];
    const inputs = [this.labelInput, this.workspaceInput, this.profileInput];
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    let caretColumn = PREFIELD_WIDTH;
    for (let index = 0; index < inputs.length; index += 1) {
      const marker = index === this.formFieldIndex ? ">" : " ";
      const rendered = renderFieldValue(
        inputs[index],
        fieldContentWidth,
        index === this.formFieldIndex,
      );
      lines.push(
        `\x1b[0m${truncateToWidth(`${marker}${prompts[index]}${rendered.line}`, cols, "", true)}\x1b[0m`,
      );
      if (index === this.formFieldIndex) {
        caretColumn = PREFIELD_WIDTH + rendered.caretColumn;
      }
    }
    // The status row is always reserved so an error can never shrink the pane
    // into a too-small fallback after it appeared.
    lines.push(
      this.pendingCreate !== undefined
        ? wrapRow(` Starting (request ${this.pendingCreate.requestId}) `, cols)
        : this.formError !== undefined
          ? wrapRow(` ! ${this.formError} `, cols)
          : "",
    );
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) {
      lines.push(wrapRow(footerLine, cols));
    }

    return {
      lines,
      cursor: {
        column: Math.min(Math.max(caretColumn, PREFIELD_WIDTH), cols - 1),
        row: 1 + this.formFieldIndex,
      },
    };
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

interface RenderedFieldValue {
  /** Public Input-rendered field line without its hardware cursor marker. */
  readonly line: string;
  /** Caret's visible column relative to the content window start. */
  readonly caretColumn: number;
}

/**
 * Uses the public pinned Input renderer for grapheme-safe scrolling and its
 * cursor placement. Values are sanitized before render, then the public
 * CURSOR_MARKER is consumed into the sidebar cursor DTO and never returned in
 * pane text. Input's own inverse SGR is generated by the SDK, not user text.
 */
function renderFieldValue(
  input: Input,
  contentWidth: number,
  focused: boolean,
): RenderedFieldValue {
  const currentValue = input.getValue();
  const safeValue = sanitizeCellText(currentValue);
  if (safeValue !== currentValue) {
    input.setValue(safeValue);
  }
  input.focused = focused;
  const rendered = input.render(contentWidth)[0] ?? "";
  const markerIndex = rendered.indexOf(CURSOR_MARKER);
  const caretColumn =
    markerIndex < 0 ? 0 : visibleWidth(rendered.slice(0, markerIndex));
  return {
    line: rendered.split(CURSOR_MARKER).join(""),
    caretColumn,
  };
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