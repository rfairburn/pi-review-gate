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
