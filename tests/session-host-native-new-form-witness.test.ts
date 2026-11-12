/**
 * Pure regression tests for the test-only positive New-form witnesses
 * (`tests/helpers/session-host-native-new-form-witness.ts`).
 *
 * These are the witnesses `MainPtyDriver.createNativeSession` and the native CLI
 * Main scenario use to decide whether one Workspace Enter already took the New
 * submission or only accepted the field's exact owned-folder completion. The
 * behaviour under test is the false positive they replace: a real Main frame is
 * repainted row by row with no atomic frame marker, so a partial redraw can
 * briefly draw no `> Workspace:` row at all while the form is still open and has
 * submitted nothing. Nothing here touches a real PTY, host, or child: every
 * frame is synthetic fixture text at the real 120-column outer geometry, and no
 * timing is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  captureStartIdentities,
  completeNewFormDrawn,
  newFormFooterDrawn,
  newFormPendingCreateDrawn,
  newFormWorkspaceValue,
  observeFreshStart,
  observeWorkspaceSubmitWitness,
  requiresSecondWorkspaceEnter,
  type StartEventCandidate,
  type WorkspaceSubmitWitness,
} from "./helpers/session-host-native-new-form-witness";

const WORKSPACE = "/owned/scratch/workspace-alpha";
const COMPLETED = `${WORKSPACE}/`;
/** The real wide Main layout: 32 roster columns, one divider column, an 87-column form pane. */
const ROSTER_COLUMNS = 32;
const FORM_PANE_COLUMNS = 87;
/** The New form's own footer, drawn only while the New form is on screen. */
const NEW_FORM_FOOTER = "enter create | esc cancel | tab complete | ctrl+c clear | ctrl+g external editor";
const LEFT_ROSTER = ["  Saved conversations", "> New session", "  Quit host"];

/** One host frame whose form-pane (right) rows are exactly the supplied rows. */
function hostFrame(right: readonly string[]): string {
  const rows = [" Session host "];
  for (let index = 0; index < Math.max(LEFT_ROSTER.length, right.length); index += 1) {
    const roster = (LEFT_ROSTER[index] ?? "").padEnd(ROSTER_COLUMNS);
    rows.push(`${roster}│${(right[index] ?? "").padEnd(FORM_PANE_COLUMNS)}`);
  }
  return rows.join("\n");
}

/** Rows written verbatim, for geometry a padded pane can never produce. */
function rawHostFrame(rows: readonly string[]): string {
  return rows.join("\n");
}

/**
 * A frame shaped like the real wide New form: the form's own header, the fixed
 * Local Host line, the labelled Workspace row, and the New form's footer.
 * `fieldValue === undefined` drops that labelled row entirely, the way a partial
 * repaint does.
 */
function newFormFrame(fieldValue: string | undefined, options: {
  readonly footer?: boolean;
  readonly pending?: boolean;
} = {}): string {
  const pane = [" New session ", "  Host: [ Local ]"];
  if (fieldValue !== undefined) pane.push(`> Workspace: ${fieldValue}`);
  if (options.pending === true) pane.push(" Starting (request 1) ");
  if (options.footer !== false) pane.push(NEW_FORM_FOOTER);
  return hostFrame(pane);
}

/** No witness at all, for the callers that have no fresh start to report yet. */
const noFreshStart: Parameters<typeof observeWorkspaceSubmitWitness>[1] = {
  completedPath: COMPLETED,
  freshStart: () => undefined,
};

/** One observer-style `session_start` for `WORKSPACE`. */
function startRecord(overrides: Partial<StartEventCandidate> = {}): StartEventCandidate {
  return { type: "session_start", cwd: WORKSPACE, pid: 4242, sessionId: "conv-4242", ...overrides };
}

const NO_FENCE: ReturnType<typeof captureStartIdentities> = { pids: new Set<number>(), sessionIds: new Set<string>() };

test("positive witnesses ignore an empty, partial, or marker-missing redraw", () => {
  // The exact frame that used to be read as "submitted": the form is still open,
  // still owns focus, and submitted nothing, but this repaint lost its rows.
  assert.equal(observeWorkspaceSubmitWitness(newFormFrame(undefined), noFreshStart), undefined,
    "a repaint that merely lost the Workspace row is never a submission");
  assert.equal(observeWorkspaceSubmitWitness("", noFreshStart), undefined, "an empty frame is never a witness");
  assert.equal(observeWorkspaceSubmitWitness(" Session host ", noFreshStart), undefined,
    "Main's own header alone is never a witness");
  assert.equal(observeWorkspaceSubmitWitness(hostFrame([" New session ", "  Host: [ Local ]"]), noFreshStart), undefined,
    "a New-form header and Host line with no drawn field is not a complete New form");
  // A New form whose own footer is not drawn is not a complete New form.
  assert.equal(observeWorkspaceSubmitWitness(newFormFrame(COMPLETED, { footer: false }), noFreshStart), undefined,
    "a completed field in a footer-less partial repaint is not a complete-form witness");
  assert.equal(completeNewFormDrawn(newFormFrame(COMPLETED, { footer: false })), false);
  assert.equal(requiresSecondWorkspaceEnter(undefined), false,
    "no witness never authorises a further Enter");
});

test("positive witnesses recognize the exact completed owned folder in a complete New form", () => {
  const frame = newFormFrame(COMPLETED);
  assert.equal(completeNewFormDrawn(frame), true, "the fixture frame is a complete New form");
  assert.equal(newFormFooterDrawn(frame), true);
  assert.equal(newFormWorkspaceValue(frame), COMPLETED, "the labelled row's value is read beside its label");
  const witness = observeWorkspaceSubmitWitness(frame, noFreshStart);
  assert.equal(witness?.kind, "owned-folder-completion");
  assert.ok(witness !== undefined && witness.kind === "owned-folder-completion");
  assert.equal(witness.completedPath, COMPLETED);
  assert.equal(witness.frame, frame, "the matched frame is captured with the witness, not re-read later");
  assert.equal(requiresSecondWorkspaceEnter(witness), true,
    "only the observed owned-folder completion authorises the one intended second Enter");

  // Anything else in the field is not this workspace's completion.
  for (const value of [WORKSPACE, `${WORKSPACE}x/`, "/owned/scratch/workspace-beta/", " ! not a path "]) {
    assert.equal(observeWorkspaceSubmitWitness(newFormFrame(value), noFreshStart), undefined,
      `${JSON.stringify(value)} is not the exact completed owned folder`);
  }
  // A label truncated by the terminal edge has no drawn content region at all.
  assert.equal(newFormWorkspaceValue(rawHostFrame([" Session host ", `> Workspace:`])), undefined,
    "a clipped label with no drawn content region is never a value");
  // The same geometry drawn in the left roster pane is never form-pane evidence.
  const wrongPane = rawHostFrame([
    " Session host ",
    ...[" New session ", "  Host: [ Local ]", `> Workspace: ${COMPLETED}`, NEW_FORM_FOOTER]
      .map((row) => row.padEnd(ROSTER_COLUMNS) + "│" + " ".repeat(FORM_PANE_COLUMNS)),
  ]);
  assert.equal(wrongPane.includes("New session"), true);
  assert.equal(wrongPane.includes("> Workspace:"), true);
  assert.equal(completeNewFormDrawn(wrongPane), false, "the roster pane never draws the New form");
  assert.equal(observeWorkspaceSubmitWitness(wrongPane, noFreshStart), undefined);
});

test("positive witnesses recognize the host's real pending-create row as a submission", () => {
  const frame = newFormFrame(WORKSPACE, { pending: true });
  assert.equal(newFormPendingCreateDrawn(frame), true);
  const witness = observeWorkspaceSubmitWitness(frame, { completedPath: COMPLETED, freshStart: () => startRecord() });
  assert.equal(witness?.kind, "pending-create", "the drawn pending-create row is the positive submission witness");
  assert.equal(requiresSecondWorkspaceEnter(witness), false, "a pending create never receives a further Enter");

  // The same row with no Workspace row at all still witnesses the submission.
  assert.equal(observeWorkspaceSubmitWitness(newFormFrame(undefined, { pending: true }), noFreshStart)?.kind,
    "pending-create");
  // The words without the host's actual request id are not that row.
  assert.equal(newFormPendingCreateDrawn(" Starting (request) "), false);
  assert.equal(newFormPendingCreateDrawn("Starting requested 1"), false);
});

test("positive witnesses recognize a freshly reported start for this exact workspace", () => {
  const start = startRecord();
  // The form is gone from this repaint, and the child itself reported starting.
  const witness = observeWorkspaceSubmitWitness(" Session host · Welcome", {
    completedPath: COMPLETED,
    freshStart: () => start,
  });
  assert.equal(witness?.kind, "fresh-start");
  assert.ok(witness !== undefined && witness.kind === "fresh-start");
  assert.equal(witness.start, start, "the matched record is captured with the witness");
  assert.equal(requiresSecondWorkspaceEnter(witness), false,
    "a start the real host already took never receives a further Enter");

  // A fresh start outranks a still-drawn completed field, so the second Enter is
  // never sent into a child that has taken input ownership.
  const both = observeWorkspaceSubmitWitness(newFormFrame(COMPLETED), {
    completedPath: COMPLETED,
    freshStart: () => start,
  });
  assert.equal(both?.kind, "fresh-start", "an already-taken submission outranks the completion witness");
  assert.equal(requiresSecondWorkspaceEnter(both), false);
  // The pending-create row outranks both, and short-circuits the journal read.
  let journalReads = 0;
  const counted = observeWorkspaceSubmitWitness(newFormFrame(COMPLETED, { pending: true }), {
    completedPath: COMPLETED,
    freshStart: () => {
      journalReads += 1;
      return start;
    },
  });
  assert.equal(counted?.kind, "pending-create");
  assert.equal(journalReads, 0, "a frame that already witnesses the submission never consults the journal");
});

test("a pre-existing record can never stand in for this create's fresh child", () => {
  const before = [startRecord()];
  const fence = captureStartIdentities(before);
  assert.deepEqual([...fence.pids], [4242], "the fence snapshots the PIDs already observed");
  assert.deepEqual([...fence.sessionIds], ["conv-4242"], "the fence snapshots the conversation ids already observed");

  const records = (record: StartEventCandidate): StartEventCandidate[] => [...before, record];
  const witness = (record: StartEventCandidate): WorkspaceSubmitWitness<StartEventCandidate> | undefined =>
    observeWorkspaceSubmitWitness("", {
      completedPath: COMPLETED,
      freshStart: () => observeFreshStart(records(record), { workspace: WORKSPACE, startType: "session_start", fence }),
    });
  // The same old child, unchanged, is not a fresh start.
  assert.equal(witness(startRecord()), undefined, "the pre-existing PID cannot stand in for the new child");
  // A new PID under the old conversation id is not fresh either.
  assert.equal(witness(startRecord({ pid: 5150, sessionId: "conv-4242" })), undefined,
    "the pre-existing conversation id cannot stand in for the new child");
  // Another workspace's fresh child is not this one.
  assert.equal(witness(startRecord({ pid: 5150, sessionId: "conv-5150", cwd: "/owned/other" })), undefined,
    "a start for another workspace is never this create's witness");
  // Another event type, or a start with no usable identity, is not a start.
  assert.equal(witness(startRecord({ type: "resize", pid: 5150, sessionId: "conv-5150" })), undefined,
    "a non-start event is never a fresh start");
  assert.equal(witness(startRecord({ pid: undefined })), undefined, "a start with no reported PID is never a start");
  assert.equal(witness(startRecord({ pid: 0 })), undefined, "a start with a non-positive PID is never a start");
  assert.equal(observeFreshStart(before, { workspace: WORKSPACE, startType: "session_start", fence: NO_FENCE })?.pid,
    4242, "with nothing observed before the keystroke, that start is itself fresh");

  // The genuinely fresh child of this workspace is recognized, and with it the
  // submission: the key choreography ends here, with no further Enter.
  const fresh = witness(startRecord({ pid: 5150, sessionId: "conv-5150" }));
  assert.equal(fresh?.kind, "fresh-start");
  assert.equal(requiresSecondWorkspaceEnter(fresh), false, "the fresh start ends the key choreography");

  // A fixture that reports no conversation id is fenced by its own fresh PID.
  const fixtureFence = captureStartIdentities([{ type: "hello", cwd: WORKSPACE, pid: 4242 }]);
  assert.equal(observeFreshStart([{ type: "hello", cwd: WORKSPACE, pid: 4242 }],
    { workspace: WORKSPACE, startType: "hello", fence: fixtureFence }), undefined,
  "the fixture's own earlier report cannot stand in for its new child");
  assert.equal(observeFreshStart([{ type: "hello", cwd: WORKSPACE, pid: 5150 }],
    { workspace: WORKSPACE, startType: "hello", fence: fixtureFence })?.pid, 5150,
  "the fixture's own fresh report is recognized");
});
