/**
 * Strict, pure parser for the rendered session-host sidebar roster, shared by
 * the native Main, Saved-main, and Windows ConPTY acceptance harnesses and
 * their pure witness tests.
 *
 * The current production contract renders every native session as a fixed
 * variable-height card inside the sidebar pane:
 *
 *   row 1  ONLY the sanitized canonical title (no marker, no badge, no status)
 *   row 2  the selection marker plus the observed/unknown agent + input status
 *   row 3  honest nullable background counts, never inferred zero
 *   row 4  generic sanitized activity (expanded only)
 *   row 5  generic sanitized activity (expanded only)
 *
 * A card is therefore exactly 5 rows expanded (default) or 3 rows collapsed,
 * one card's extent never overlaps another's, and the three required fixed
 * actions ("Saved conversations", "New session", "Quit host") follow every
 * native card as ordered one-row entries, with an optional final "Host
 * shortcuts" action when settings are available. Only the leftmost sidebar columns (the wide
 * 32-column pane or the full narrow-overlay width) are inspected, extracted by
 * the pinned terminal-cell width model so wide/combining characters can never
 * pull the divider or native right pane into scope.
 *
 * The older inline `title [AGENT: …]` / `[exited (code 0)]` badge rows are not
 * cards under this grammar and yield no parse: a stale witness cannot silently
 * accept them. Public consumers are fail-closed: a frame is only usable when
 * the header-declared native count, every native card's full 3/5-row extent,
 * the ordered required action tail, and any optional final settings action
 * all agree, so a partially painted roster can never satisfy an entry, card,
 * selection, or "hidden" witness.
 */
import { sliceByColumn, truncateToWidth, visibleWidth } from "pi-session-host-tui";

/**
 * The serializer-generated SGR pattern (`\x1b[<params>m`) documented by
 * `stripGeneratedSgr`; stripped before width-aware pane extraction.
 */
const GENERATED_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function stripSgr(line: string): string {
  return line.replace(GENERATED_SGR_PATTERN, "");
}

/** Wide-layout sidebar pane width in columns (production compositor). */
export const SIDEBAR_COLUMNS = 32;
/** One divider column separates the wide sidebar from the native pane. */
export const DIVIDER_COLUMNS = 1;
/** First native-pane column in the wide layout (0-based). */
export const NATIVE_PANE_START = SIDEBAR_COLUMNS + DIVIDER_COLUMNS;
/** Below this outer width the sidebar is a full-width overlay, not a 32-col pane. */
export const SIDEBAR_OVERLAY_MIN_OUTER_COLUMNS = SIDEBAR_COLUMNS + DIVIDER_COLUMNS + 20;
/** Marker drawn below a card title for the highlighted entry. */
const MARKER_SELECTED = "> ";
const MARKER_PLAIN = "  ";
const ACTIVITY_PREFIX = "    ";
/** Two-cell marker + one-cell separator are always ASCII and never clipped. */
const MARKER_CELLS = 2;

/** The three required fixed host actions, in their rendered order. */
export const ROSTER_ACTIONS = ["Saved conversations", "New session", "Quit host"] as const;
const HOST_SHORTCUTS_ACTION = "Host shortcuts";
const HOST_SHORTCUTS_OVERRIDE_ACTION = "Host shortcuts (--sidebar-key override active)";
export type RosterActionLabel = (typeof ROSTER_ACTIONS)[number] | typeof HOST_SHORTCUTS_ACTION;

export interface RosterCardEntry {
  readonly kind: "native";
  /** Index of this entry in the rendered roster entry order. */
  readonly position: number;
  /** Complete first-line canonical title exactly as rendered (may be clipped). */
  readonly title: string;
  /** Alias for `title`, kept uniform with action entries. */
  readonly label: string;
  /** Status text from the second row after its selection marker. */
  readonly status: string;
  /** Honest background-count text from the third row. */
  readonly background: string;
  /** Non-empty generic activity lines drawn in the fourth/fifth rows. */
  readonly activity: readonly string[];
  readonly selected: boolean;
  /** Complete drawn card extent: exactly 5 expanded or 3 collapsed. */
  readonly rows: 3 | 5;
  /** The complete drawn card, joined for diagnostics; never a fabricated badge. */
  readonly raw: string;
}

export interface RosterActionEntry {
  readonly kind: "action";
  readonly position: number;
  readonly label: RosterActionLabel;
  readonly selected: boolean;
  readonly rows: 1;
  readonly raw: string;
}

export type RosterEntry = RosterCardEntry | RosterActionEntry;

export interface RosterNavigationTarget {
  readonly position: number;
  readonly label: string;
}

export interface OwnedRosterLabel {
  readonly rowProbe: string;
  readonly displayName: string;
}

export interface ParsedRoster {
  /** Sidebar header text, or the first line when no roster header is present. */
  readonly header: string | undefined;
  /** Header-declared native session count, or undefined without a valid header. */
  readonly count: number | undefined;
  /**
   * Parsed entries. Empty unless `complete` is true: an incomplete/partial
   * roster never exposes partial cards, actions, or selections to consumers.
   */
  readonly entries: readonly RosterEntry[];
  readonly cards: readonly RosterCardEntry[];
  readonly actions: readonly RosterActionEntry[];
  /**
   * Body-relative offset of the first row after the last parsed entry. Rows at
   * and beyond this offset are notice/padding/footer content, never entries.
   */
  readonly entryEnd: number;
  /**
   * True only for a complete roster: exactly `count` full native cards followed
   * by the ordered required three-action tail and optional final Host shortcuts action,
   * with no extra entry-shaped row.
   */
  readonly complete: boolean;
}

const HEADER_PATTERN = /^\s*Sessions \((\d+)\)\s*$/u;
const STATUS_PATTERN = /^(?:starting \| input (?:pending|none|unknown)|agent (?:running|waiting|idle|unknown) \| input (?:pending|none|unknown)|exited(?: \(code -?\d+\))?|error(?: \(code -?\d+\))?)$/u;
const BACKGROUND_CANONICAL = /^(?:background unknown|bg tasks (?:unknown|\d+) \| shells (?:unknown|\d+))$/u;
const ROOT_HEAD = "bg tasks ";
const SHELLS_MID = " | shells";

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isActivityRow(line: string): boolean {
  return line.startsWith(ACTIVITY_PREFIX);
}

/** A complete or partial prefix of a nullable count token ("unknown" | digits). */
function isCountTokenPrefix(text: string): boolean {
  if (text.length === 0) return false;
  if (/^\d+$/u.test(text)) return true;
  return "unknown".startsWith(text);
}

/** True when `tail` is a prefix of the canonical " | shells" suffix (optionally a count). */
function isShellsSuffixPrefix(tail: string): boolean {
  if (SHELLS_MID.startsWith(tail)) return true;
  if (!tail.startsWith(SHELLS_MID)) return false;
  const after = tail.slice(SHELLS_MID.length);
  if (after.length === 0) return true;
  if (!after.startsWith(" ")) return false;
  const token = after.slice(1);
  return token.length === 0 || isCountTokenPrefix(token);
}

/** True when `core` is a prefix of some canonical `bg tasks … | shells …` string. */
function isBackgroundPrefix(core: string): boolean {
  if (core.length < ROOT_HEAD.length) return ROOT_HEAD.startsWith(core);
  if (!core.startsWith(ROOT_HEAD)) return false;
  const rest = core.slice(ROOT_HEAD.length);
  for (let end = 1; end <= rest.length; end += 1) {
    const token = rest.slice(0, end);
    if (!isCountTokenPrefix(token)) continue;
    // A separator proves the preceding token was completely rendered; an
    // incomplete "unknown" prefix (e.g. "unk") before it cannot be clipping.
    if (end < rest.length && !/^(?:unknown|\d+)$/u.test(token)) continue;
    if (isShellsSuffixPrefix(rest.slice(end))) return true;
  }
  return false;
}

/**
 * Validates the complete background row (after its two-cell marker) against
 * the actual nullable-count grammar, modeling the renderer's width-bounded
 * ellipsis: an unclipped row must fit the pane, and a clipped row must expose
 * exactly `width - 2` cells ending in "..." whose visible core is a prefix of
 * a canonical background string. Malformed suffixes, missing counts, and
 * fabricated text are rejected.
 */
function isBackgroundRow(text: string, width: number): boolean {
  if (BACKGROUND_CANONICAL.test(text)) return visibleWidth(text) + MARKER_CELLS <= width;
  if (!text.endsWith("...")) return false;
  if (visibleWidth(text) !== width - MARKER_CELLS) return false;
  return isBackgroundPrefix(text.slice(0, -3));
}

/**
 * A two-column selection marker. Activity rows (four leading spaces) are never
 * markers, so a marker line is always a card status/background row or a
 * one-row action entry.
 */
function statusMarker(line: string): "selected" | "unselected" | undefined {
  if (line.startsWith(MARKER_SELECTED)) return "selected";
  if (line.startsWith(MARKER_PLAIN) && !line.startsWith(ACTIVITY_PREFIX)) return "unselected";
  return undefined;
}

/** The exact plain-text row exposed by truncateToWidth after pane extraction. */
function renderedActionRow(text: string, width: number): string {
  return stripSgr(truncateToWidth(text, width, "...", true)).trimEnd();
}

/**
 * Returns the canonical label only for a complete action row the production
 * renderer can draw at this pane width. In particular, the legacy annotation
 * is matched against its exact width-clipped form, never an arbitrary suffix.
 */
function rosterActionLabel(line: string, width: number): RosterActionLabel | undefined {
  const marker = statusMarker(line);
  if (marker === undefined) return undefined;
  const prefix = marker === "selected" ? MARKER_SELECTED : MARKER_PLAIN;
  const rendered = line.trimEnd();
  for (const label of ROSTER_ACTIONS) {
    if (rendered === renderedActionRow(`${prefix}${label}`, width)) return label;
  }
  const shortcuts = renderedActionRow(`${prefix}${HOST_SHORTCUTS_ACTION}`, width);
  const legacyOverride = renderedActionRow(`${prefix}${HOST_SHORTCUTS_OVERRIDE_ACTION}`, width);
  return rendered === shortcuts || rendered === legacyOverride ? HOST_SHORTCUTS_ACTION : undefined;
}

/**
 * A partial repaint of the settings row is still a visible sidebar remnant,
 * but is never a parsed action. Match only proper prefixes of renderer-valid
 * Host shortcuts rows so unrelated native-pane text cannot block the witness.
 */
function isHostShortcutsActionRemnant(line: string, width: number): boolean {
  const marker = statusMarker(line);
  if (marker === undefined) return false;
  const prefix = marker === "selected" ? MARKER_SELECTED : MARKER_PLAIN;
  const rendered = line.trimEnd();
  const candidates = [
    renderedActionRow(`${prefix}${HOST_SHORTCUTS_ACTION}`, width),
    renderedActionRow(`${prefix}${HOST_SHORTCUTS_OVERRIDE_ACTION}`, width),
  ];
  return candidates.some((candidate) => rendered.length < candidate.length
    && candidate.slice(0, rendered.length) === rendered);
}

interface CardRead {
  readonly entry: RosterCardEntry;
  readonly next: number;
}

/** Reads one complete native card, or undefined for anything else. */
function readCard(body: readonly string[], start: number, position: number, width: number): CardRead | undefined {
  const titleLine = body[start];
  if (titleLine === undefined || isBlank(titleLine)) return undefined;
  // Canonical names may legitimately begin with marker-like printable text.
  // The following exact status/background rows, not the title's content,
  // establish the card grammar.
  const statusLine = body[start + 1];
  if (statusLine === undefined) return undefined;
  const marker = statusMarker(statusLine);
  if (marker === undefined) return undefined;
  const status = statusLine.slice(MARKER_CELLS).trimEnd();
  if (!STATUS_PATTERN.test(status)) return undefined;
  const backgroundLine = body[start + 2];
  if (backgroundLine === undefined || statusMarker(backgroundLine) !== "unselected") return undefined;
  const background = backgroundLine.slice(MARKER_CELLS).trimEnd();
  if (!isBackgroundRow(background, width)) return undefined;

  // Expanded cards claim two more rows; a blank padded activity row is a valid
  // placeholder, and anything else means this card is collapsed at three rows.
  const fourth = body[start + 3];
  const fourthIsActivity = fourth !== undefined && (isBlank(fourth) || isActivityRow(fourth));
  const fifth = body[start + 4];
  const expanded = fourthIsActivity && fifth !== undefined && (isBlank(fifth) || isActivityRow(fifth));
  if (fourthIsActivity && !expanded) return undefined;
  const title = titleLine.trimEnd();
  const activity = expanded
    ? [fourth!, fifth!].filter((line) => isActivityRow(line)).map((line) => line.slice(ACTIVITY_PREFIX.length).trimEnd())
    : [];
  const rows: 3 | 5 = expanded ? 5 : 3;
  const rawLines = expanded
    ? [titleLine, statusLine, backgroundLine, fourth!, fifth!]
    : [titleLine, statusLine, backgroundLine];
  return {
    entry: {
      kind: "native",
      position,
      title,
      label: title,
      status,
      background,
      activity,
      selected: marker === "selected",
      rows,
      raw: rawLines.join("\n"),
    },
    next: start + rows,
  };
}

function emptyParse(header: string | undefined): ParsedRoster {
  return { header, count: undefined, entries: [], cards: [], actions: [], entryEnd: 0, complete: false };
}

function incomplete(header: string | undefined, count: number | undefined, entryEnd: number): ParsedRoster {
  return { header, count, entries: [], cards: [], actions: [], entryEnd, complete: false };
}

/** Parses already pane-scoped roster lines (the sidebar header is line 0). */
export function parseRosterLines(lines: readonly string[], width: number = SIDEBAR_COLUMNS): ParsedRoster {
  const header = lines[0];
  const headerMatch = header === undefined ? null : HEADER_PATTERN.exec(header);
  if (headerMatch === null) return emptyParse(header === undefined ? undefined : header.trimEnd());
  const count = Number(headerMatch[1]);
  const body = lines.slice(1);
  const cards: RosterCardEntry[] = [];
  const entries: RosterEntry[] = [];
  let index = 0;

  for (let position = 0; position < count; position += 1) {
    const card = readCard(body, index, position, width);
    if (card === undefined) return incomplete(header, count, index);
    cards.push(card.entry);
    entries.push(card.entry);
    index = card.next;
  }

  const actions: RosterActionEntry[] = [];
  for (const expected of ROSTER_ACTIONS) {
    const line = body[index];
    const marker = line === undefined ? undefined : statusMarker(line);
    if (line === undefined || marker === undefined || rosterActionLabel(line, width) !== expected) {
      return incomplete(header, count, index);
    }
    const action: RosterActionEntry = {
      kind: "action",
      position: entries.length,
      label: expected,
      selected: marker === "selected",
      rows: 1,
      raw: line,
    };
    actions.push(action);
    entries.push(action);
    index += 1;
  }

  // Host shortcuts is the existing settings action and is appended only when
  // settings are available. Its legacy-override suffix is accepted only in
  // the exact complete or width-clipped form produced by the renderer.
  const optionalLine = body[index];
  if (optionalLine !== undefined && rosterActionLabel(optionalLine, width) === HOST_SHORTCUTS_ACTION) {
    const marker = statusMarker(optionalLine)!;
    const action: RosterActionEntry = {
      kind: "action",
      position: entries.length,
      label: HOST_SHORTCUTS_ACTION,
      selected: marker === "selected",
      rows: 1,
      raw: optionalLine,
    };
    actions.push(action);
    entries.push(action);
    index += 1;
  }

  // Anything extra that looks like an entry (a marker row or another full
  // card) means the roster is stale/duplicated, not complete. Footer hints,
  // notices, and blank padding are not entries.
  for (let cursor = index; cursor < body.length; cursor += 1) {
    const line = body[cursor]!;
    if (isBlank(line)) continue;
    if (statusMarker(line) !== undefined) return incomplete(header, count, index);
    if (readCard(body, cursor, entries.length, width) !== undefined) {
      return incomplete(header, count, index);
    }
  }

  return { header, count, entries, cards, actions, entryEnd: index, complete: true };
}

/** Extracts exactly `sidebarColumns` terminal cells from one composed line. */
function paneCell(line: string, sidebarColumns: number): string {
  let clipped = sliceByColumn(stripSgr(line), 0, sidebarColumns, true);
  if (visibleWidth(clipped) > sidebarColumns) clipped = sliceByColumn(clipped, 0, sidebarColumns, true);
  if (visibleWidth(clipped) > sidebarColumns) clipped = "";
  return clipped + " ".repeat(sidebarColumns - visibleWidth(clipped));
}

/**
 * Scopes a frame or pane to the actual sidebar columns using the pinned
 * terminal-cell width model, so a wide/combining character can never pull the
 * divider or native right-pane content into the inspected region.
 */
export function sidebarPaneLines(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): string[] {
  return text.split("\n").map((line) => paneCell(line, sidebarColumns));
}

/** Offset of the roster's first line within pane lines (0 pane-only, 1 composed). */
function rosterOffset(pane: readonly string[]): number {
  return HEADER_PATTERN.test(pane[0] ?? "") ? 0 : 1;
}

/**
 * Parses a composed host frame (line 0 is the outer header, the roster starts
 * on line 1) or a raw sidebar pane (line 0 is the roster header), scoped to
 * the actual sidebar columns. Only the sidebar pane is read.
 */
export function parseRosterFrame(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): ParsedRoster {
  const pane = sidebarPaneLines(text, sidebarColumns);
  return parseRosterLines(pane.slice(rosterOffset(pane)), sidebarColumns);
}

/**
 * The single highlighted roster entry, only for a complete roster with exactly
 * one highlight. Partial rosters and duplicate highlights are ambiguous and
 * return undefined so they can never authorize an action.
 */
export function selectedRosterEntry(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): RosterEntry | undefined {
  const parsed = parseRosterFrame(text, sidebarColumns);
  if (!parsed.complete) return undefined;
  const selected = parsed.entries.filter((entry) => entry.selected);
  return selected.length === 1 ? selected[0] : undefined;
}

/**
 * Complete native cards only; a partial/incomplete roster exposes no cards.
 */
export function rosterCards(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): readonly RosterCardEntry[] {
  const parsed = parseRosterFrame(text, sidebarColumns);
  return parsed.complete ? parsed.cards : [];
}

/** The selected native card, never an action, partial card, or duplicate highlight. */
export function selectedRosterCard(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): RosterCardEntry | undefined {
  const selected = selectedRosterEntry(text, sidebarColumns);
  return selected !== undefined && selected.kind === "native" ? selected : undefined;
}

/** True when a rendered (possibly clipped) title belongs to the canonical title. */
export function renderedTitleMatches(rendered: string | undefined, canonical: string): boolean {
  if (rendered === undefined) return false;
  if (rendered === canonical) return true;
  const clippedPrefix = rendered.endsWith("...") ? rendered.slice(0, -3) : "";
  return clippedPrefix.length > 0 && canonical.startsWith(clippedPrefix) && canonical.length > clippedPrefix.length;
}

/**
 * Maps a complete rendered roster to its real navigation order. Native cards
 * must correlate one-to-one with owned session labels; action entries come
 * only from the parsed frame, including an optional final settings row.
 */
export function rosterNavigationTargets(
  parsed: ParsedRoster,
  owned: readonly OwnedRosterLabel[],
): readonly RosterNavigationTarget[] | undefined {
  if (!parsed.complete || parsed.entries.length === 0) return undefined;
  const matched = new Set<OwnedRosterLabel>();
  const targets: RosterNavigationTarget[] = [];
  for (const entry of parsed.entries) {
    if (entry.kind === "action") {
      targets.push({ position: entry.position, label: entry.label });
      continue;
    }
    const owners = owned.filter((session) => renderedTitleMatches(entry.title, session.displayName));
    if (owners.length !== 1 || matched.has(owners[0]!)) return undefined;
    matched.add(owners[0]!);
    targets.push({ position: entry.position, label: owners[0]!.rowProbe });
  }
  if (matched.size !== owned.length
    || new Set(targets.map((target) => target.label)).size !== targets.length
    || new Set(targets.map((target) => target.position)).size !== targets.length) return undefined;
  return targets;
}

/** The next actual roster target after the uniquely highlighted position. */
export function nextRosterNavigationTarget(
  targets: readonly RosterNavigationTarget[],
  currentPosition: number,
): RosterNavigationTarget | undefined {
  if (targets.length === 0) return undefined;
  const currentIndex = targets.findIndex((target) => target.position === currentPosition);
  return currentIndex < 0 ? undefined : targets[(currentIndex + 1) % targets.length];
}

/** Outer header line (line 0), sans generated SGR and trailing padding. */
export function frameHeader(text: string): string {
  const first = text.split("\n")[0] ?? "";
  return stripSgr(first).replace(/\s+$/u, "");
}

/** True when the active outer header is exactly (or a clipped form of) `title`. */
export function frameHeaderMatches(text: string, title: string): boolean {
  return renderedTitleMatches(frameHeader(text), title);
}

/**
 * True only when a complete roster is drawn AND the footer rows that follow the
 * last entry expose every sidebar-only action of a focused pane: the toggle,
 * enter/open, edit, stop/remove, hide, quit, and (for a non-empty roster) the
 * Space expansion hint. A partially updated footer — for example the new
 * `e edit name` hint coexisting with a stale Main-focused `q quit` while the
 * delete/Space hints are still absent — is not completed sidebar focus. The
 * footer is read strictly after the parsed entry extent inside the sidebar
 * pane, so a card title or the native pane can never fake sidebar focus.
 */
export function isSidebarFocusedFrame(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): boolean {
  const pane = sidebarPaneLines(text, sidebarColumns);
  const offset = rosterOffset(pane);
  const parsed = parseRosterLines(pane.slice(offset), sidebarColumns);
  if (!parsed.complete) return false;
  const footer = pane.slice(offset + 1 + parsed.entryEnd)
    .filter((line) => !isBlank(line))
    .join(" ")
    .replace(/\s+/gu, " ");
  const requiredHints = [
    "F8 toggle", "enter open", "e edit name",
    "d stop/remove", "esc hide", "q quit",
    ...((parsed.count ?? 0) > 0 ? ["space expand"] : []),
  ];
  return requiredHints.every((hint) => footer.includes(hint));
}

/**
 * Fail-closed witness that the sidebar pane has actually been hidden. Header
 * absence alone is not evidence: the writer redraws rows sequentially, so the
 * header can vanish while cards, background/status rows, actions, footer, or
 * the wide divider remain. Hiding is only reported when none of those remain
 * inside the pre-transition sidebar columns and no wide-layout divider is still
 * drawn at the sidebar boundary. `sidebarColumns` must be the width observed
 * before the hide transition, not a width recomputed afterwards.
 */
export function sidebarRosterHidden(text: string, sidebarColumns: number = SIDEBAR_COLUMNS): boolean {
  const pane = sidebarPaneLines(text, sidebarColumns);
  const hasRosterRemnant = pane.some((line) => {
    if (/^\s*Sessions \(/u.test(line)) return true;
    if (statusMarker(line) !== undefined) {
      const contents = line.slice(MARKER_CELLS).trimEnd();
      if (STATUS_PATTERN.test(contents)
        || isBackgroundRow(contents, sidebarColumns)
        || rosterActionLabel(line, sidebarColumns) !== undefined
        || isHostShortcutsActionRemnant(line, sidebarColumns)) return true;
    }
    return /(?:F8 toggle|e edit name|d stop\/remove|esc hide|q quit|space expand)/u.test(line);
  });
  if (hasRosterRemnant) return false;
  // Any remaining wide-layout divider means the hide repaint is unfinished.
  return !text.split("\n").slice(1).some((line) => {
    const prefix = sliceByColumn(stripSgr(line), 0, sidebarColumns + 1, true);
    return visibleWidth(prefix) === sidebarColumns + 1 && prefix.endsWith("│");
  });
}
