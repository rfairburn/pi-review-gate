import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import { nativeFormFieldIsEmpty, OUTER_RESTORATION_BASELINE } from "./helpers/session-host-native-main-harness";
import {
  isEmptyWorkspaceField,
  isCompleteLocalNewFormFrame,
  workspaceOnlyNewFrame,
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

// --- The shared native New-open witness uses the actual approved New-form geometry.
//
// The approved New form draws, in the right-hand form pane: the "New session"
// header, the fixed `Host: [ Local ]` line, then the native Editor's own top
// rule, its labelled Workspace body row, and its bottom rule. These fixtures
// reproduce that geometry at the real 120-column outer width (32 roster columns
// + 1 divider column + an 87-column form pane, a 13-column label gutter, and a
// 74-column Editor rule). No PTY, runtime, timer, or production seam is involved.

const ROSTER_COLUMNS = 32;
const ROSTER_AND_DIVIDER_COLUMNS = 33;
const FORM_PANE_COLUMNS = 87;
const WORKSPACE_LABEL = "> Workspace: ";
const EDITOR_RULE = "─".repeat(FORM_PANE_COLUMNS - WORKSPACE_LABEL.length);
const LEFT_ROSTER = ["  Saved conversations", "> New session", "  Quit host"];
const BLANK_PANE_PREFIX = " ".repeat(ROSTER_AND_DIVIDER_COLUMNS);

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
    "",
    " enter create | esc cancel | tab complete | ctrl+u clear | ctrl+g external editor",
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
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 4), "", ...rows.slice(6)])), false,
    "a missing bottom rule is never a bordered Editor");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([rows[0]!, rows[1]!, gutter + " ".repeat(EDITOR_RULE.length), ...rows.slice(3)])), false,
    "blank space where the top rule belongs is not a rule");
  assert.equal(workspaceOnlyNewFrame(formHostFrame([...rows.slice(0, 4), gutter + "─".repeat(40), ...rows.slice(6)])), false,
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
