import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import { nativeFormFieldIsEmpty, nativeFormFieldShowsValue, OUTER_RESTORATION_BASELINE } from "./helpers/session-host-native-main-harness";
import {
  getWorkspaceFieldValue,
  isEmptyWorkspaceField,
  isCompleteLocalNewFormFrame,
  isLocalNewFormWorkspaceCompletionFrame,
  workspaceOnlyNewCompletionFrame,
  workspaceOnlyNewFrame,
  type NewFormWorkspaceCompletion,
} from "./helpers/session-host-native-saved-main-harness";

// Pure fixture-observation predicates only; no SDK, PTY or native runtime proof.
function frame(marker: "> Workspace:" | "> New name:", value: string): string {
  const roster = "  sibling                       │";
  const padding = " ".repeat(marker.length + 1);
  // The label sits beside the editable content row; the Editor's own rules stay
  // unlabeled above and below it.
  return [
    "Session host",
    `${roster}${padding}───────────────`,
    `${roster}${marker} ${value.padEnd(15)}`,
    `${roster}${padding}───────────────`,
    `${roster}enter submit | escape cancel`,
  ].join("\n");
}

test("native form witness observes empty Editor content beside its own label", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", ""), "> Workspace:"), true);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> New name:"), true);
});

test("native form witness rejects retained drafts and wrong field kinds", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "/retained/path"), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", "old caption"), "> New name:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> Workspace:"), false);
});

test("native form witness rejects missing borders/content rather than assuming empty", () => {
  assert.equal(nativeFormFieldIsEmpty("> Workspace: ", "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "").replace(/─/g, " "), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty("Session host\n> Workspace: ─────\n", "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty("Session host\n> Workspace: \n", "> Workspace:"), false);
});

// The 52-column narrow New form: a 13-column label gutter, a 39-column Editor
// rule, and body rows the pinned Editor lays out at 38 columns.
const NARROW_RULE = `             ${"─".repeat(39)}`;
const NARROW_GUTTER = " ".repeat(13);
const ONE_ROW_PREFIX = "/private/tmp/shm-AbC123/workspace-new-";
const WRAPPED_PREFIX = "/private/tmp/prg-nci-AbCdEfGh/shm-AbC123/workspace-new-";

function narrowField(body: readonly string[], below: readonly string[] = []): string {
  return [
    " New session",
    "  Host: [ Local ]",
    NARROW_RULE,
    ...body.map((segment, index) => `${index === 0 ? "> Workspace: " : NARROW_GUTTER}${segment}`.padEnd(52)),
    NARROW_RULE,
    ...below,
  ].join("\n");
}

const shows = (text: string, expected: string): boolean => nativeFormFieldShowsValue(text, "> Workspace:", expected, 52);
// The pinned Editor wraps `<37 chars> <rest>` after the space, so its first row
// is 38 columns ending in a space that the padded text cannot show.
const BOUNDARY_SPACED = `${WRAPPED_PREFIX.slice(0, 37)} ${WRAPPED_PREFIX.slice(37)}`;
const BOUNDARY_SPACED_ROWS = [`${WRAPPED_PREFIX.slice(0, 37)} `, WRAPPED_PREFIX.slice(37)];

test("native field value witness matches the expected value's one-row and wrapped Editor layout", () => {
  assert.equal(shows(narrowField([ONE_ROW_PREFIX]), ONE_ROW_PREFIX), true);
  const wrapped = [WRAPPED_PREFIX.slice(0, 38), WRAPPED_PREFIX.slice(38)];
  assert.equal(shows(narrowField(wrapped), WRAPPED_PREFIX), true);
  const markerPathHead = `/tmp/${"a".repeat(33)}`;
  const markerPathTail = "> Workspace: fixture";
  assert.equal(shows(narrowField([markerPathHead, markerPathTail]), markerPathHead + markerPathTail), true,
    "label text inside a wrapped path is field content, not another label");
  assert.equal(shows(narrowField([ONE_ROW_PREFIX], [`${NARROW_GUTTER}> Workspace: suggestion/`]), ONE_ROW_PREFIX), true,
    "label-like completion text below the field is never another label");
  assert.equal(shows(narrowField(wrapped, [`${NARROW_GUTTER}→ workspace-new-alpha/`,
    `${NARROW_GUTTER}  workspace-new-beta/`]), WRAPPED_PREFIX), true,
  "the completion list below the bottom rule is never part of the value");
  assert.equal(shows(narrowField([""]), ""), true);
  const unicodePrefix = "/private/tmp/øabcdefghijklmnop/shm-AbC123/workspace-new-";
  assert.equal(shows(narrowField([unicodePrefix.slice(0, 38), unicodePrefix.slice(38)]), unicodePrefix), true,
    "a non-ASCII configured root is laid out by the Editor's display widths");
  assert.equal(shows(narrowField(BOUNDARY_SPACED_ROWS), BOUNDARY_SPACED), true,
    "a correct render that wraps after a boundary space matches the exact spaced value");
  assert.equal(shows(narrowField(BOUNDARY_SPACED_ROWS, [`${NARROW_GUTTER}→ workspace-new-alpha/`,
    `${NARROW_GUTTER}  workspace-new-beta/`]), BOUNDARY_SPACED), true,
  "the boundary-space render still matches with the native completion list below it");
  const midSpaced = "/private/tmp/My Temp/shm-AbC123/workspace-new-";
  assert.equal(shows(narrowField(["/private/tmp/My Temp/shm-AbC123/", "workspace-new-"]), midSpaced), false,
    "rows that do not follow the Editor's layout are refused");
  assert.equal(shows(narrowField(["/private/tmp/My ", "Temp/shm-AbC123/workspace-new-"]), midSpaced), true,
    "the Editor's word wrap at an earlier space in a configured root is matched exactly");
  assert.equal(shows(narrowField(["/private/tmp/My Temp/shm-AbC123/workspace-", "new-"]), midSpaced), false,
    "a non-final row wider than the layout width is refused");
});

test("native field value witness refuses partial, altered, borrowed, or unbounded fields", () => {
  const wrapped = [WRAPPED_PREFIX.slice(0, 38), WRAPPED_PREFIX.slice(38)];
  assert.equal(shows(narrowField([wrapped[0]!]), WRAPPED_PREFIX), false,
    "the first wrapped row alone is not the typed value");
  assert.equal(shows(narrowField([wrapped[0]!]), WRAPPED_PREFIX.slice(0, 38)), true,
    "the drawn first row is only evidence of its own text");
  assert.equal(shows(narrowField(wrapped), WRAPPED_PREFIX.slice(0, 38)), false,
    "a truncated expected value never matches the longer drawn value");
  assert.equal(shows(narrowField(wrapped, [`${NARROW_GUTTER}${WRAPPED_PREFIX.slice(38)}alpha/`]), `${WRAPPED_PREFIX}alpha/`),
    false, "a completion row below the bottom rule is never borrowed as a body row");
  assert.equal(shows(narrowField(wrapped).replace(`${NARROW_RULE}\n`, ""), WRAPPED_PREFIX), false,
    "a missing top rule is refused");
  const widePrefix = "/tmp/界";
  assert.equal(shows(narrowField([widePrefix]).replace(NARROW_RULE, `${NARROW_GUTTER}──`), widePrefix), false,
    "a partial top rule is refused without trying to wrap a wide character into one cell");
  assert.equal(shows(narrowField([widePrefix]).replace(NARROW_RULE, `${NARROW_GUTTER}─`), widePrefix), false,
    "a one-cell top rule is refused");
  assert.equal(shows(narrowField(["/tmp/exact"]).replaceAll(NARROW_RULE, `${NARROW_GUTTER}${"─".repeat(38)}`), "/tmp/exact"), false,
    "equally clipped rules cannot establish the 52-column field even when the path fits");
  assert.equal(shows(narrowField(["/tmp/exact"]), "/tmp/exact"), true, "the complete 52-column field matches");
  assert.equal(nativeFormFieldShowsValue(narrowField(["/tmp/exact"]), "> Workspace:", "/tmp/exact", 53), false,
    "rules narrower than the known pane width are refused");
  assert.equal(nativeFormFieldShowsValue(narrowField(["/tmp/exact"]), "> Workspace:", "/tmp/exact", 51), false,
    "rules wider than the known pane width are refused");
  assert.equal(shows(narrowField([widePrefix]), widePrefix), true, "the complete field draws the wide character");
  const threeCellPrefix = "/tmp/a\u093e\u093e";
  assert.equal(shows(narrowField([threeCellPrefix]).replace(NARROW_RULE, `${NARROW_GUTTER}───`), threeCellPrefix), false,
    "a partial rule cannot fit the three-cell grapheme and is refused without throwing");
  assert.equal(shows(narrowField([threeCellPrefix]), threeCellPrefix), true, "the complete field draws the same grapheme");
  assert.equal(shows(narrowField(wrapped).replace(NARROW_RULE, ` ${NARROW_RULE}`), WRAPPED_PREFIX), false,
    "a rule displaced from the field's value column is refused");
  assert.equal(shows(narrowField(wrapped).replace(/ {13}─{39}$/u, `!${NARROW_RULE.slice(1)}`), WRAPPED_PREFIX), false,
    "text in the bottom rule's label gutter is refused");
  assert.equal(shows(narrowField(wrapped).replace(NARROW_RULE, `!${NARROW_RULE.slice(1)}`), WRAPPED_PREFIX), false,
    "text in the top rule's label gutter is refused");
  assert.equal(shows(narrowField(wrapped).split("\n").slice(0, -1).join("\n"), WRAPPED_PREFIX), false,
    "an unpainted bottom rule is refused");
  assert.equal(shows(narrowField(wrapped).replace(`${NARROW_GUTTER}${wrapped[1]}`, `stray        ${wrapped[1]}`),
    WRAPPED_PREFIX), false, "text in the label gutter is refused");
  assert.equal(shows(narrowField([wrapped[0]!, "", wrapped[1]!]), WRAPPED_PREFIX), false,
    "a blank row inside the body is refused");
  assert.equal(shows(narrowField([...wrapped, "extra"]), WRAPPED_PREFIX), false,
    "an extra body row before the bottom rule is refused");
  assert.equal(shows(narrowField(wrapped).replace(/─{39}$/u, `${"─".repeat(17)} ↓ 1 more ${"─".repeat(12)}`),
    WRAPPED_PREFIX), false, "a scrolled, truncated viewport's indicator rule is refused");
  assert.equal(shows(narrowField(["/a b ", "c"]), "/a b c"), false,
    "rows the Editor would not have broken that way are refused");
  // The pre-fix reader joined the visible rows of a boundary-space render and
  // returned the prefix with its space dropped; neither reading is accepted.
  assert.equal(shows(narrowField(BOUNDARY_SPACED_ROWS), WRAPPED_PREFIX), false,
    "a boundary-space render never matches the value with that space dropped");
  assert.equal(shows(narrowField([WRAPPED_PREFIX.slice(0, 37), WRAPPED_PREFIX.slice(37)]), WRAPPED_PREFIX), false,
    "a short non-final row of an unspaced value is refused");
  assert.equal(shows(narrowField(wrapped), BOUNDARY_SPACED), false,
    "the unspaced render never matches the spaced value");
  assert.equal(shows(narrowField(BOUNDARY_SPACED_ROWS), `${WRAPPED_PREFIX.slice(0, 37)}  ${WRAPPED_PREFIX.slice(37)}`),
    false, "a different whitespace run at the boundary is laid out differently and refused");
  // The Editor breaks after a no-break space exactly as after U+0020, but the
  // frame still draws it: only ASCII-space padding is ever normalized away.
  const noBreakSpaced = `${WRAPPED_PREFIX.slice(0, 37)}\u00a0${WRAPPED_PREFIX.slice(37)}`;
  const noBreakRows = [`${WRAPPED_PREFIX.slice(0, 37)}\u00a0`, WRAPPED_PREFIX.slice(37)];
  assert.equal(shows(narrowField(noBreakRows), noBreakSpaced), true, "a drawn no-break space matches itself");
  assert.equal(shows(narrowField(noBreakRows), BOUNDARY_SPACED), false,
    "a drawn no-break space at the boundary never matches an expected ASCII space");
  assert.equal(shows(narrowField(BOUNDARY_SPACED_ROWS), noBreakSpaced), false,
    "an expected no-break space is never satisfied by invisible ASCII padding");
  assert.equal(shows(narrowField([`${ONE_ROW_PREFIX}\u00a0`]), ONE_ROW_PREFIX), false,
    "a drawn trailing no-break space is not padding");
  assert.equal(shows(narrowField(wrapped).replace(`${NARROW_GUTTER}${wrapped[1]}`, `${" ".repeat(12)}\u00a0${wrapped[1]}`),
    WRAPPED_PREFIX), false, "a no-break space in the label gutter is not blank");
  assert.equal(shows(narrowField([WRAPPED_PREFIX.slice(0, 39), WRAPPED_PREFIX.slice(39)]), WRAPPED_PREFIX), false,
    "a non-final row wider than the layout width is refused");
  assert.equal(shows(narrowField(wrapped).replace(/─{39}$/u, "─".repeat(38)), WRAPPED_PREFIX), false,
    "a bottom rule narrower than the top rule is refused");
  assert.equal(shows(`${narrowField([ONE_ROW_PREFIX])}\n${narrowField([ONE_ROW_PREFIX])}`, ONE_ROW_PREFIX), false,
    "two labelled rows are refused");
  assert.equal(nativeFormFieldShowsValue(narrowField([ONE_ROW_PREFIX]), "> New name:", ONE_ROW_PREFIX, 52), false);
  // Whitespace after the final character is invisible padding: never claimed.
  assert.equal(shows(narrowField([ONE_ROW_PREFIX]), `${ONE_ROW_PREFIX} `), false,
    "an expected value ending in unobservable whitespace is refused");
  assert.equal(shows(narrowField([ONE_ROW_PREFIX]), `${ONE_ROW_PREFIX}\n`), false,
    "a line break a single-line field cannot draw is refused");
});

// --- The shared native New-open witness uses the actual approved New-form geometry.
//
// The approved New form draws, in the right-hand form pane: the "New session"
// header, the fixed `Host: [ Local ]` line, then the native Editor's own top
// rule, its labelled Workspace body row, and its bottom rule, then (#493) the
// default-off `[ ] Create missing workspace directory` checkbox directly below
// the Editor in the row the form used to leave as its spacer. These fixtures
// reproduce that geometry at the real 120-column outer width (35 roster columns
// + 1 divider column + an 84-column form pane, a 13-column label gutter, and a
// 71-column Editor rule). No PTY, runtime, timer, or production seam is involved.

const ROSTER_COLUMNS = 35;
const ROSTER_AND_DIVIDER_COLUMNS = 36;
const FORM_PANE_COLUMNS = 84;
const WORKSPACE_LABEL = "> Workspace: ";
const EDITOR_RULE = "─".repeat(FORM_PANE_COLUMNS - WORKSPACE_LABEL.length);
const LEFT_ROSTER = ["  Saved conversations", "> New session", "  Quit host"];
const BLANK_PANE_PREFIX = " ".repeat(ROSTER_AND_DIVIDER_COLUMNS);
/** The default-off workspace-creation checkbox row exactly as the form draws it. */
const DEFAULT_CHECKBOX_ROW = "  [ ] Create missing workspace directory";
const NEW_FORM_FOOTER_ROW = " enter create | esc cancel | tab complete | ctrl+u clear | ctrl+g external editor";

function hostFrameRows(left: readonly string[], right: readonly string[], undrawnFrom: number): string[] {
  const rows = [" Session host "];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (index >= undrawnFrom) {
      // The paint stopped here: the row still holds the previous buffer's blank
      // content, not even the divider column.
      rows.push("");
      continue;
    }
    const roster = (left[index] ?? "").slice(0, ROSTER_COLUMNS).padEnd(ROSTER_COLUMNS);
    rows.push(`${roster}│${(right[index] ?? "").padEnd(FORM_PANE_COLUMNS).slice(0, FORM_PANE_COLUMNS)}`);
  }
  return rows;
}

/** One host frame whose form-pane (right) rows are exactly the supplied rows. */
function formHostFrame(right: readonly string[], undrawnFrom = Number.POSITIVE_INFINITY): string {
  return hostFrameRows(LEFT_ROSTER, right, undrawnFrom).join("\n");
}

/** Rows written verbatim, for geometry a padded pane can never produce. */
function rawHostFrame(rows: readonly string[]): string {
  return rows.join("\n");
}

/** The completed Local New form exactly as the native host draws it. */
function localNewFormRows(draft = ""): string[] {
  const gutter = " ".repeat(WORKSPACE_LABEL.length);
  return [
    " New session ",
    "  Host: [ Local ]",
    `${gutter}${EDITOR_RULE}`,
    `${WORKSPACE_LABEL}${draft.padEnd(FORM_PANE_COLUMNS - WORKSPACE_LABEL.length)}`,
    `${gutter}${EDITOR_RULE}`,
    DEFAULT_CHECKBOX_ROW,
    NEW_FORM_FOOTER_ROW,
  ];
}

/**
 * The completed Local New form with the optional Provider line the native host
 * draws between the Host line and the workspace field when it offers providers
 * and the pane has the row: Header, Host, Provider, then the Editor's own
 * top rule, labelled body row, and bottom rule.
 */
function localNewFormWithProviderRows(draft = ""): string[] {
  const rows = localNewFormRows(draft);
  return [rows[0]!, rows[1]!, "  Provider: [ Pi ]", ...rows.slice(2)];
}

test("shared New-open witness accepts the completed Local form with an empty or retained Workspace draft", () => {
  const empty = formHostFrame(localNewFormRows());
  assert.equal(isCompleteLocalNewFormFrame(empty), true, "the completed default-Local empty form is observed");
  assert.equal(workspaceOnlyNewFrame(empty), true, "the completed default-Local empty form is the genuine New form");
  assert.equal(isEmptyWorkspaceField(empty), true, "the completed empty body is still witnessed as empty");

  const retainedDraft = "/private/tmp/shm-abc123/saved-main-workspace-de4be0/";
  const retained = formHostFrame(localNewFormRows(retainedDraft));
  assert.equal(workspaceOnlyNewFrame(retained), true,
    "New opening with its retained Local workspace draft is the genuine New form");
  assert.equal(isEmptyWorkspaceField(retained), false,
    "the generic New-open witness never requires an empty body");

  const hostFocused = formHostFrame(localNewFormRows().map((line, index) => index === 1 ? "> Host: [ Local ]" : line));
  assert.equal(workspaceOnlyNewFrame(hostFocused), true,
    "the same completed Local form is witnessed while its Host line owns focus");
});

test("shared New-open witness accepts the default Pi Provider line drawn above Workspace", () => {
  const empty = formHostFrame(localNewFormWithProviderRows());
  assert.equal(isCompleteLocalNewFormFrame(empty), true,
    "the completed default-Local empty form with its complete default Provider line is observed");
  assert.equal(workspaceOnlyNewFrame(empty), true,
    "the drawn Provider line is part of the genuine New form, never a synthetic field");
  assert.equal(isEmptyWorkspaceField(empty), true,
    "the bordered empty body is still witnessed as empty beside the Provider line");

  const retainedDraft = "/private/tmp/shm-abc123/saved-main-workspace-de4be0/";
  assert.equal(workspaceOnlyNewFrame(formHostFrame(localNewFormWithProviderRows(retainedDraft))), true,
    "the Provider layout with its retained Local workspace draft is the genuine New form");

  const hostFocused = formHostFrame(localNewFormWithProviderRows()
    .map((line, index) => index === 1 ? "> Host: [ Local ]" : line));
  assert.equal(workspaceOnlyNewFrame(hostFocused), true,
    "the Provider layout is witnessed while its Host line owns focus");

  // The legacy layout stays accepted: a host that offers no provider, and a
  // pane with no spare row, draw the form without the Provider line.
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame(localNewFormRows())), true,
    "the completed no-Provider Local form remains the genuine New form");
});

test("shared New-open witness rejects incomplete, altered, duplicated, and misordered Provider rows", () => {
  const rows = localNewFormWithProviderRows();
  const gutter = " ".repeat(WORKSPACE_LABEL.length);
  const rejects = (right: readonly string[], reason: string): void => {
    const frame = formHostFrame(right);
    assert.equal(isCompleteLocalNewFormFrame(frame), false, reason);
    assert.equal(workspaceOnlyNewFrame(frame), false, `${reason}: the shared New-open witness keeps waiting`);
  };

  rejects([rows[0]!, rows[1]!, "> Provider: [ Pi ]", ...rows.slice(3)],
    "a Provider line that owns the form's focus is not the drawn default");
  rejects([rows[0]!, rows[1]!, "  Provider: [ Claude Code ]", ...rows.slice(3)],
    "an explicitly chosen non-Pi provider is not the default New form");
  rejects([rows[0]!, rows[1]!, "  Provider: [ Pi", ...rows.slice(3)],
    "a Provider value painted only partway is not a complete drawn line");
  rejects([rows[0]!, rows[1]!, "  Provider: [...]", ...rows.slice(3)],
    "a truncated Provider value is not the complete default choice");
  rejects([rows[0]!, rows[1]!, "  Provider:", ...rows.slice(3)],
    "a bare Provider caption with no drawn value is never evidence");
  rejects([rows[0]!, rows[1]!, rows[2]!, rows[2]!, ...rows.slice(3)],
    "two Provider rows are not one drawn control");
  rejects([rows[0]!, rows[1]!, "", rows[2]!, ...rows.slice(3)],
    "a Provider line one row below the Host line is not its drawn slot");
  rejects([rows[0]!, rows[2]!, rows[1]!, ...rows.slice(3)],
    "the drawn order is Host then Provider, never Provider above Host");

  // A Provider control drawn anywhere else in the form pane is a second or
  // misplaced control, never the drawn default: the whole pane is surveyed, so
  // a matching Editor box above or below it cannot carry the frame.
  const legacy = localNewFormRows();
  rejects([...legacy.slice(0, 5), "  Provider: [ Pi ]", ...legacy.slice(5)],
    "a Provider control below the legacy form's bottom border is not its drawn slot");
  rejects([...legacy.slice(0, 6), "  Provider: [ Pi ]", ...legacy.slice(6)],
    "a Provider control below the drawn checkbox is not its drawn slot either");
  rejects([...legacy.slice(0, 5), "  Provider: [ Claude Code ]", ...legacy.slice(5)],
    "a trailing non-Pi Provider selection is never the default New form");
  rejects([...legacy.slice(0, 4), "  Provider: [ Pi ]", legacy[4]!],
    "a Provider control between the labelled row and the bottom border is not evidence");
  rejects([...rows.slice(0, 6), "  Provider: [ Pi ]", ...rows.slice(6)],
    "a second Provider control below the Provider layout's bottom border is not one drawn control");
  rejects([...rows.slice(0, 6), "  Provider: [ Claude Code ]", ...rows.slice(6)],
    "a trailing non-Pi Provider selection never accompanies the drawn default");
  rejects([...rows.slice(0, 4), "  Provider: [ Pi ]", ...rows.slice(4)],
    "a second Provider control inside the Editor box is never the drawn slot");

  rejects([rows[0]!, rows[1]!, rows[2]!, "", rows[3]!, rows[4]!, rows[5]!],
    "the workspace field must sit directly below the drawn Provider line, not one row later");
  rejects([rows[0]!, rows[1]!, rows[2]!, "", ...rows.slice(4)],
    "a missing top rule beside a drawn Provider line is never a bordered Editor");
  rejects([...rows.slice(0, 5), `${gutter}${"─".repeat(40)}`, ...rows.slice(6)],
    "a bottom rule of a different width than the top rule is stale geometry beside a Provider line");
  rejects([rows[0]!, "  Host: [ build-box ]", rows[2]!, ...rows.slice(3)],
    "a non-Local Host destination never becomes the default Local form by drawing a Provider line");

  // Only a Provider control row is surveyed: a workspace draft whose own text
  // mentions a provider is body content, and the completed form stays accepted.
  assert.equal(workspaceOnlyNewFrame(formHostFrame(localNewFormRows("Provider: [ Pi ]"))), true,
    "a workspace draft whose text mentions a provider is body content, not a second control row");

  // The reproduced partial paint of the Provider layout: the complete header,
  // Host line, Provider line, top rule and labelled body row, with the bottom
  // rule's row not yet repainted. Every caption the substring witnesses read is
  // present, so only the complete bordered Editor can admit the frame.
  const partial = formHostFrame(rows, 5);
  assert.equal(partial.includes("New session"), true);
  assert.equal(partial.includes("Provider: [ Pi ]"), true);
  assert.equal(partial.includes("> Workspace:"), true);
  assert.equal(isCompleteLocalNewFormFrame(partial), false,
    "a Provider layout whose bottom Editor rule is not yet drawn is not an open New form");
  assert.equal(workspaceOnlyNewFrame(partial), false,
    "the shared New-open witness keeps waiting for the completed bordered Editor");

  // The same Provider geometry drawn in the left roster pane instead of the
  // form pane is never right-pane evidence.
  const wrongPane = hostFrameRows(rows, ["", "", ""], Number.POSITIVE_INFINITY).join("\n");
  assert.equal(wrongPane.includes("Provider: [ Pi ]"), true);
  assert.equal(isCompleteLocalNewFormFrame(wrongPane), false,
    "the Provider layout drawn in the left roster pane is never right-pane evidence");
});

test("shared New-open witness accepts the default-off checkbox below Workspace and the layout with no row for it", () => {
  // The default layouts carry the unfocused, unchecked checkbox directly below
  // the Editor's bottom rule, with and without the Provider line.
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame(localNewFormRows())), true,
    "the completed Local form with its default-off checkbox is observed");
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame(localNewFormWithProviderRows())), true,
    "the Provider layout with its default-off checkbox is observed");
  // A draft whose own text mentions the caption is body content, not a control.
  assert.equal(workspaceOnlyNewFrame(formHostFrame(localNewFormRows("[ ] Create missing workspace directory"))), true,
    "a workspace draft whose text mentions the checkbox is body content, not a second control row");

  // A pane with no row to spare draws no checkbox: the next drawn row is then the
  // form's own footer, or a bounded notice row, never a blank.
  const rows = localNewFormRows();
  const noRoom = [...rows.slice(0, 5), ...rows.slice(6)];
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame(noRoom)), true,
    "the layout with no row for the checkbox keeps the footer directly below the Editor");
  const providerRows = localNewFormWithProviderRows();
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame([...providerRows.slice(0, 6), ...providerRows.slice(7)])), true,
    "the Provider layout with no row left for the checkbox is still the genuine New form");
  assert.equal(isCompleteLocalNewFormFrame(formHostFrame([...rows.slice(0, 5), " ! field notice ", ...rows.slice(6)])), true,
    "a notice row directly below the Editor is a drawn row of the form with no room for the checkbox");
});

test("shared New-open witness rejects unpainted, altered, duplicated, and misplaced checkbox rows", () => {
  const rows = localNewFormRows();
  const providerRows = localNewFormWithProviderRows();
  const rejects = (right: readonly string[], reason: string, undrawnFrom = Number.POSITIVE_INFINITY): void => {
    const frame = formHostFrame(right, undrawnFrom);
    assert.equal(isCompleteLocalNewFormFrame(frame), false, reason);
    assert.equal(workspaceOnlyNewFrame(frame), false, `${reason}: the shared New-open witness keeps waiting`);
  };

  // The partial paint with the Editor complete but the checkbox row not yet drawn.
  rejects(rows, "a form whose bottom rule is drawn but whose checkbox row is not yet painted is not open", 5);
  rejects(providerRows, "the Provider layout with its checkbox row not yet painted is not open", 6);
  rejects([...rows.slice(0, 5), "", ...rows.slice(6)],
    "a blank row where the always-shown Local checkbox belongs is a partial paint");

  rejects([...rows.slice(0, 5), "  [x] Create missing workspace directory", ...rows.slice(6)],
    "a checked box is never the freshly opened default-off form");
  rejects([...rows.slice(0, 5), "> [ ] Create missing workspace directory", ...rows.slice(6)],
    "a checkbox that owns the form's focus is not the drawn default");
  rejects([...rows.slice(0, 5), "  [x] Create missing workspace directory (unsupported here)", ...rows.slice(6)],
    "a checked unsupported box is never the default Local form");
  rejects([...rows.slice(0, 5), "  [ ] Create missing workspace dir...", ...rows.slice(6)],
    "a truncated checkbox caption is not the complete drawn default");
  rejects([...rows.slice(0, 5), "  [ ] Create mi", ...rows.slice(6)],
    "a checkbox painted only partway is not the complete drawn default");
  rejects([...rows.slice(0, 6), DEFAULT_CHECKBOX_ROW, ...rows.slice(6)],
    "two checkbox rows are not one drawn control");
  rejects([...rows.slice(0, 5), "", DEFAULT_CHECKBOX_ROW, ...rows.slice(6)],
    "a checkbox one row below its drawn slot is not the completed form");
  rejects([rows[0]!, rows[1]!, DEFAULT_CHECKBOX_ROW, ...rows.slice(2, 5), ...rows.slice(6)],
    "a checkbox above the Editor is not its drawn slot");
  rejects([...rows.slice(0, 4), DEFAULT_CHECKBOX_ROW, rows[4]!, ...rows.slice(6)],
    "a checkbox between the labelled row and the bottom border is not evidence");
  rejects([...providerRows.slice(0, 7), DEFAULT_CHECKBOX_ROW, ...providerRows.slice(7)],
    "a second checkbox below the Provider layout's checkbox is not one drawn control");

  // The same checkbox geometry drawn in the left roster pane is never evidence.
  const wrongPane = hostFrameRows(rows, ["", "", ""], Number.POSITIVE_INFINITY).join("\n");
  assert.equal(wrongPane.includes("[ ] Create missing"), true, "the roster pane really drew the checkbox caption");
  assert.equal(isCompleteLocalNewFormFrame(wrongPane), false,
    "the checkbox layout drawn in the left roster pane is never right-pane evidence");
});

test("shared New-open witness rejects the reproduced partial paint whose bottom Editor rule is not yet drawn", () => {
  // The actual observed incomplete frame: New session, Host: [ Local ], the top
  // Editor rule and the empty labelled body row, with the bottom-rule row not
  // yet repainted. Caption-only text admits it, so it must not be evidence.
  const partial = formHostFrame(localNewFormRows(), 4);
  assert.equal(partial.includes("New session"), true);
  assert.equal(partial.includes("> Workspace:"), true);
  assert.equal(partial.includes("Label:"), false);
  assert.equal(partial.includes("Profile:"), false);
  assert.equal(isCompleteLocalNewFormFrame(partial), false,
    "a header, Host line, top rule and labelled row without the drawn bottom rule is not an open New form");
  assert.equal(workspaceOnlyNewFrame(partial), false,
    "the shared New-open witness keeps waiting for the completed bordered Editor");
  assert.equal(nativeFormFieldIsEmpty(partial, "> Workspace:"), false,
    "the unchanged bordered-field witness still refuses the missing bottom rule");
});

test("shared New-open witness rejects absent, relocated, and altered Host lines", () => {
  const rows = localNewFormRows();
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[2]!, rows[3]!, rows[4]!])), false,
    "the caption-only legacy geometry with no Host line is not the approved New form");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, "  Host: [ build-box ]", ...rows.slice(2)])), false,
    "a non-Local Host destination is not the default Local New form");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, "  Host: Local", ...rows.slice(2)])), false,
    "a Host caption without its drawn selector value is not evidence");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, "", rows[1]!, rows[2]!, rows[3]!, rows[4]!])), false,
    "the Host line must sit in its drawn row directly below the New session header");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, rows[2]!, "", rows[3]!, rows[4]!])), false,
    "the labelled Workspace row must be the Editor's own body row directly below its top rule");
});

test("shared New-open witness rejects missing rules, missing content, and unaligned rules", () => {
  const rows = localNewFormRows();
  const gutter = " ".repeat(WORKSPACE_LABEL.length);
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, "", ...rows.slice(3)])), false,
    "a missing top rule is never a bordered Editor");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 4), "", ...rows.slice(5)])), false,
    "a missing bottom rule is never a bordered Editor");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, gutter + " ".repeat(EDITOR_RULE.length), ...rows.slice(3)])), false,
    "blank space where the top rule belongs is not a rule");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 4), gutter + "─".repeat(40), ...rows.slice(5)])), false,
    "a bottom rule of a different width than the top rule is stale geometry, not a completed field");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, EDITOR_RULE, rows[3]!, EDITOR_RULE, ...rows.slice(5)])), false,
    "a rule starting at the pane's first column is a transcript divider, not the field's own border");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, rows[2]!, rows[4]!, rows[2]!])), false,
    "a bordered field with no labelled content row is not an open form");
  const clipped = rawHostFrame([
    " Session host ",
    `${BLANK_PANE_PREFIX}${rows[0]!}`,
    `${BLANK_PANE_PREFIX}${rows[1]!}`,
    `${BLANK_PANE_PREFIX}${rows[2]!}`,
    `${BLANK_PANE_PREFIX}> Workspace:`,
    `${BLANK_PANE_PREFIX}${rows[4]!}`,
  ]);
  assert.equal(workspaceOnlyNewFrame(clipped), false,
    "a clipped label with no drawn content region is not an open form");
  const editForm = [" Edit native session name ", " Current name (display only; type a complete replacement): ",
    " old caption", rows[2]!, "> New name: ".padEnd(FORM_PANE_COLUMNS), rows[4]!];
  assert.equal(workspaceOnlyNewFrame(formHostFrame(editForm)), false,
    "the Edit form's bordered name field is not the New form");
});

test("shared New-open witness rejects left-pane captions, transcript text, and synthetic Label/Profile fields", () => {
  assert.equal(workspaceOnlyNewFrame(formHostFrame(["", "", ""])), false,
    "a frame whose form pane holds no New-form content is not an open New form");
  // The approved geometry drawn in the left roster pane instead of the form pane.
  const wrongPane = hostFrameRows(localNewFormRows(), ["", "", ""], Number.POSITIVE_INFINITY).join("\n");
  assert.equal(wrongPane.includes("New session"), true);
  assert.equal(wrongPane.includes("> Workspace:"), true);
  assert.equal(isCompleteLocalNewFormFrame(wrongPane), false,
    "the same geometry drawn in the left roster pane is never right-pane evidence");

  const transcript = formHostFrame([
    "New session",
    "  Host: [ Local ]",
    "> Workspace: /private/tmp/retained/path",
    "",
    " the child transcript mentions the form",
  ]);
  assert.equal(workspaceOnlyNewFrame(transcript), false,
    "Main-transcript captions mentioning the form are never evidence");

  const rows = localNewFormRows();
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 6), "  Label: ", ...rows.slice(6)])), false,
    "a synthetic Label field disqualifies the frame even with the completed Local structure");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 6), "  Profile: default", ...rows.slice(6)])), false,
    "a synthetic Profile field disqualifies the frame even with the completed Local structure");
});

// --- The dedicated native workspace-completion witness.
//
// While the native filesystem provider shows its suggestion, the pinned SDK
// Editor renders its completion list below its own bottom rule, indented to the
// Editor's content column, and the form draws the checkbox after that ENTIRE
// Editor render. The New-open witness keeps rejecting this open-menu state; the
// completion wait uses a witness bound to one exact draft and suggestion.

const COMPLETION_DRAFT = "/tmp/shm-U7HSUD/row-lifecycle-a-";
const COMPLETION_SUGGESTION = "row-lifecycle-a-75d3cd/";
const EXPECTED_COMPLETION: NewFormWorkspaceCompletion = { draft: COMPLETION_DRAFT, suggestion: COMPLETION_SUGGESTION };
const EDITOR_GUTTER = " ".repeat(WORKSPACE_LABEL.length);

/** The exact frame the real native row-lifecycle run captured (120x50, trailing blanks elided). */
function capturedCompletionFrame(): string {
  const rule = "─".repeat(71);
  const rows = [
    "Session host",
    " Sessions (0)                      │ New session",
    "  Saved conversations              │  Host: [ Local ]",
    "> New session                      │             " + rule,
    "  Settings                         │> Workspace: /tmp/shm-U7HSUD/row-lifecycle-a-",
    "  Quit host                        │             " + rule,
    "                                   │             → row-lifecycle-a-75d3cd/",
    "                                   │  [ ] Create missing workspace directory",
  ];
  while (rows.length < 48) rows.push(`${" ".repeat(ROSTER_COLUMNS)}│`);
  rows.push("F8 toggle | enter open | esc hide  │");
  rows.push("q quit                             │enter create | escape cancel | tab complete | ctrl+c clear | ctrl+g external editor");
  return rows.map((row) => row.padEnd(120)).join("\n");
}

/** The Local New form with the given Editor completion rows between its bottom rule and checkbox. */
function localNewFormCompletionRows(
  completion: readonly string[] = [`${EDITOR_GUTTER}→ ${COMPLETION_SUGGESTION}`],
  draft = COMPLETION_DRAFT,
): string[] {
  const rows = localNewFormRows(draft);
  return [...rows.slice(0, 5), ...completion, ...rows.slice(5)];
}

function completionAccepted(right: readonly string[], expected = EXPECTED_COMPLETION): boolean {
  return workspaceOnlyNewCompletionFrame(formHostFrame(right), expected);
}

test("completion witness accepts the captured native frame the New-open witness rightly rejects", () => {
  const captured = capturedCompletionFrame();
  assert.equal(isLocalNewFormWorkspaceCompletionFrame(captured, EXPECTED_COMPLETION), true,
    "the actual native completion geometry with its checkbox after the whole Editor render is observed");
  assert.equal(workspaceOnlyNewCompletionFrame(captured, EXPECTED_COMPLETION), true);
  assert.equal(getWorkspaceFieldValue(captured), COMPLETION_DRAFT, "the Editor body still holds the literal typed draft");
  assert.equal(isCompleteLocalNewFormFrame(captured), false,
    "the New-open witness keeps rejecting an open completion menu");
  assert.equal(workspaceOnlyNewFrame(captured), false);
});

test("completion witness recognizes the macOS saved and resume workspace suggestion shapes", () => {
  for (const stem of ["saved-main-workspace", "resume-workspace"]) {
    const draft = `/private/tmp/owned-native-fixture/${stem}-`;
    const suggestion = `${stem}-abcdef/`;
    const frame = formHostFrame(localNewFormCompletionRows([`${EDITOR_GUTTER}→ ${suggestion}`], draft));
    assert.equal(workspaceOnlyNewCompletionFrame(frame, { draft, suggestion }), true,
      `${stem}: the exact draft and selected owned folder are a completion frame`);
    assert.equal(workspaceOnlyNewFrame(frame), false,
      `${stem}: the open-form witness is not used while the menu is displayed`);
    assert.equal(workspaceOnlyNewCompletionFrame(frame, { draft: `${draft}x`, suggestion }), false);
    assert.equal(workspaceOnlyNewCompletionFrame(frame, { draft, suggestion: `${stem}-other/` }), false);
  }
});

test("completion witness accepts the synthetic geometry with focused Host and default Provider line", () => {
  assert.equal(completionAccepted(localNewFormCompletionRows()), true);
  const hostFocused = localNewFormCompletionRows().map((line, index) => index === 1 ? "> Host: [ Local ]" : line);
  assert.equal(completionAccepted(hostFocused), true);
  const rows = localNewFormCompletionRows();
  const withProvider = [rows[0]!, rows[1]!, "  Provider: [ Pi ]", ...rows.slice(2)];
  assert.equal(completionAccepted(withProvider), true, "the default Provider line shifts the whole block by one row");
  const focusedProvider = [rows[0]!, rows[1]!, "> Provider: [ Pi ]", ...rows.slice(2)];
  assert.equal(completionAccepted(focusedProvider), false, "a focused Provider control is never the drawn default");
});

test("completion witness is bound to the exact draft and the exact owned suggestion", () => {
  const rows = localNewFormCompletionRows();
  for (const draft of [COMPLETION_DRAFT.slice(0, -1), `${COMPLETION_DRAFT}7`, "/tmp/shm-OTHER/row-lifecycle-a-"]) {
    assert.equal(completionAccepted(rows, { draft, suggestion: COMPLETION_SUGGESTION }), false,
      `a different draft (${draft}) never qualifies`);
  }
  for (const suggestion of ["row-lifecycle-a-75d3c/", "row-lifecycle-a-75d3cdx/", "row-lifecycle-b-75d3cd/"]) {
    assert.equal(completionAccepted(rows, { draft: COMPLETION_DRAFT, suggestion }), false,
      `a different expected suggestion (${suggestion}) never matches the drawn one`);
  }
  for (const drawn of ["row-lifecycle-a-75d3cd", "row-lifecycle-a-75d3c/", `${COMPLETION_SUGGESTION}x`,
    `${COMPLETION_SUGGESTION} extra`, `/tmp/shm-U7HSUD/${COMPLETION_SUGGESTION}`]) {
    assert.equal(completionAccepted(localNewFormCompletionRows([`${EDITOR_GUTTER}→ ${drawn}`])), false,
      `a partial, extended, or path-shaped drawn suggestion (${drawn}) never qualifies`);
  }
  assert.equal(completionAccepted(localNewFormCompletionRows(undefined, "")), false, "an empty body never qualifies");
});

test("completion witness rejects absent, unselected, misplaced, duplicated, and extra suggestion rows", () => {
  const selected = `${EDITOR_GUTTER}→ ${COMPLETION_SUGGESTION}`;
  assert.equal(completionAccepted(localNewFormCompletionRows([])), false,
    "the menu not yet painted (checkbox directly below the rule) is not the completion state");
  assert.equal(completionAccepted(localNewFormCompletionRows([`${EDITOR_GUTTER}  ${COMPLETION_SUGGESTION}`])), false,
    "an unselected suggestion row is not the selected owned folder");
  for (const column of [0, 2, WORKSPACE_LABEL.length - 1, WORKSPACE_LABEL.length + 1]) {
    assert.equal(completionAccepted(localNewFormCompletionRows([`${" ".repeat(column)}→ ${COMPLETION_SUGGESTION}`])), false,
      `a suggestion drawn at column ${column} is not at the Editor's content column`);
  }
  assert.equal(completionAccepted(localNewFormCompletionRows([`${"> stale".padEnd(WORKSPACE_LABEL.length)}→ ${COMPLETION_SUGGESTION}`])),
    false, "a suggestion row whose Editor gutter holds other drawn text is not the Editor's own list row");
  assert.equal(completionAccepted(localNewFormCompletionRows([selected, selected])), false, "a duplicated suggestion row");
  assert.equal(completionAccepted(localNewFormCompletionRows([selected, `${EDITOR_GUTTER}  row-lifecycle-a-other/`])), false,
    "a second, unrelated suggestion row between the list and the checkbox");
  assert.equal(completionAccepted(localNewFormCompletionRows([`${EDITOR_GUTTER}  row-lifecycle-a-other/`, selected])), false,
    "an unrelated suggestion row above the selected one");
  assert.equal(completionAccepted(localNewFormCompletionRows([selected, `${EDITOR_GUTTER}  (1/2)`])), false,
    "a scroll indicator means more than the single expected suggestion");
  assert.equal(completionAccepted(localNewFormCompletionRows([`${EDITOR_GUTTER}  No matching commands`])), false,
    "a no-match row is never the completion");
  assert.equal(completionAccepted(localNewFormCompletionRows([selected, ""])), false,
    "an arbitrary row between the list and the checkbox is never ignored");

  const rows = localNewFormCompletionRows();
  const staleBelow = [...rows.slice(0, 7), `${EDITOR_GUTTER}→ row-lifecycle-a-old/`, ...rows.slice(7)];
  assert.equal(completionAccepted(staleBelow), false, "a stale second completion list elsewhere in the pane");
  const repeatedBelow = [...rows.slice(0, 7), ` ${COMPLETION_SUGGESTION}`, ...rows.slice(7)];
  assert.equal(completionAccepted(repeatedBelow), false, "the suggestion repeated elsewhere in the pane");
  const swapped = [...rows.slice(0, 5), rows[6]!, rows[5]!, ...rows.slice(7)];
  assert.equal(completionAccepted(swapped), false, "the checkbox drawn above the completion list");
});

test("completion witness requires the complete default checkbox in the slot after the list", () => {
  const rows = localNewFormCompletionRows();
  const withCheckbox = (row: string | undefined): string[] =>
    row === undefined ? [...rows.slice(0, 6), ...rows.slice(7)] : [...rows.slice(0, 6), row, ...rows.slice(7)];
  assert.equal(completionAccepted(withCheckbox(undefined)), false, "no checkbox row at all");
  for (const row of ["", "  [x] Create missing workspace directory", "> [ ] Create missing workspace directory",
    "  [ ] Create missing workspace dir...", "  [ ] Create missing workspace directory (unsupported)",
    " enter create | esc cancel"]) {
    assert.equal(completionAccepted(withCheckbox(row)), false, `the checkbox slot drawn as ${JSON.stringify(row)}`);
  }
  const duplicated = [...rows.slice(0, 7), DEFAULT_CHECKBOX_ROW, ...rows.slice(7)];
  assert.equal(completionAccepted(duplicated), false, "a duplicated checkbox row");
});

test("completion witness rejects partial borders, wrong Host, wrong pane, and synthetic fields", () => {
  const rows = localNewFormCompletionRows();
  const replace = (index: number, row: string): string[] => rows.map((line, at) => at === index ? row : line);
  assert.equal(completionAccepted(replace(2, "")), false, "missing top rule");
  assert.equal(completionAccepted(replace(4, "")), false, "bottom rule not yet painted");
  assert.equal(completionAccepted(replace(4, `${EDITOR_GUTTER}${"─".repeat(30)}`)), false, "partial bottom rule");
  assert.equal(completionAccepted(replace(1, "  Host: [ remote-a ]")), false, "a non-Local Host");
  assert.equal(completionAccepted(replace(0, " Edit native session name ")), false, "not the New form header");

  const wrongPane = hostFrameRows(rows, ["", "", ""], Number.POSITIVE_INFINITY).join("\n");
  assert.equal(isLocalNewFormWorkspaceCompletionFrame(wrongPane, EXPECTED_COMPLETION), false,
    "the geometry drawn in the left roster pane is never right-pane evidence");
  const rosterOnly = hostFrameRows([`  ${COMPLETION_SUGGESTION}`, "> New session"], localNewFormCompletionRows([]),
    Number.POSITIVE_INFINITY).join("\n");
  assert.equal(isLocalNewFormWorkspaceCompletionFrame(rosterOnly, EXPECTED_COMPLETION), false,
    "the folder name in the left roster is not a drawn suggestion");

  for (const field of ["  Label: ", "  Profile: default"]) {
    const synthetic = [...rows.slice(0, 7), field, ...rows.slice(7)];
    assert.equal(completionAccepted(synthetic), false, `${field.trim()} disqualifies the Workspace-only form`);
  }
});

test("completion witness refuses malformed expectations instead of loosening the match", () => {
  const frame = formHostFrame(localNewFormCompletionRows());
  for (const expected of [
    { draft: "", suggestion: COMPLETION_SUGGESTION },
    { draft: ` ${COMPLETION_DRAFT}`, suggestion: COMPLETION_SUGGESTION },
    { draft: `${COMPLETION_DRAFT}\n`, suggestion: COMPLETION_SUGGESTION },
    { draft: COMPLETION_DRAFT, suggestion: "" },
    { draft: COMPLETION_DRAFT, suggestion: "/" },
    { draft: COMPLETION_DRAFT, suggestion: "row-lifecycle-a-75d3cd" },
    { draft: COMPLETION_DRAFT, suggestion: "shm-U7HSUD/row-lifecycle-a-75d3cd/" },
    { draft: COMPLETION_DRAFT, suggestion: " row-lifecycle-a-75d3cd/" },
  ]) {
    assert.throws(() => isLocalNewFormWorkspaceCompletionFrame(frame, expected), TypeError, JSON.stringify(expected));
  }
});

test("native outer restoration witness survives the actual tiny-pane resize sequence in the primary buffer", async () => {
  assert.ok(Array.from(OUTER_RESTORATION_BASELINE).length <= 24,
    "the complete primary-buffer witness fits the narrowest tested geometry");
  const surface = new TerminalSurface(120, 50);
  try {
    surface.write(`\x1b[2J\x1b[H${OUTER_RESTORATION_BASELINE}`);
    await surface.flush();
    surface.write("\x1b[?1049h");
    await surface.flush();
    for (const [cols, rows] of [[52, 30], [24, 5], [52, 30], [120, 50], [100, 30], [52, 20], [120, 50]]) {
      surface.resize(cols!, rows!);
      await surface.flush();
    }
    surface.write("\x1b[?1049l");
    await surface.flush();
    assert.ok(surface.frame().lines.map(stripGeneratedSgr).join("\n").includes(OUTER_RESTORATION_BASELINE),
      "leaving the alternate buffer preserves the complete real pre-entry primary-buffer witness");
  } finally {
    surface.dispose();
  }
});
