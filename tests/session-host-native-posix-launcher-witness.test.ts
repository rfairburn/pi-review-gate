/**
 * Pure regression tests for the POSIX source-launcher helper's fresh-start
 * witness (`observePosixLauncherFreshStart` in
 * `tests/helpers/session-host-native-posix-launcher.ts`).
 *
 * `PosixLauncherPtyDriver.createNativeSession` decides from the shared positive
 * witnesses (`session-host-native-new-form-witness.ts`) whether one real
 * Workspace Enter already took the New submission or only accepted the field's
 * exact owned-folder completion. The launcher's own contribution is which
 * journals may prove a start and what fences them: the native observer's public
 * `session_start`, or the original public PTY's `pty_spawn` receipt, each fenced
 * against every PID and conversation id already recorded BEFORE the keystroke,
 * so an older child can never stand in and a frame that merely lost its
 * `> Workspace:` row is never read as a submission.
 *
 * Nothing here starts a PTY, host, wrapper, or child: every frame and record is
 * synthetic fixture text and no timing is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  observePosixLauncherFreshStart,
  type NativeJournalRecord,
  type PtyJournalRecord,
} from "./helpers/session-host-native-posix-launcher";
import {
  captureStartIdentities,
  observeWorkspaceSubmitWitness,
  requiresSecondWorkspaceEnter,
  type StartIdentityFence,
} from "./helpers/session-host-native-new-form-witness";

const WORKSPACE = "/owned/scratch/workspace-alpha";
const COMPLETED = `${WORKSPACE}/`;
/** The real wide Main layout: 32 roster columns, one divider column, an 87-column form pane. */
const ROSTER_COLUMNS = 32;
const FORM_PANE_COLUMNS = 87;
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

/** A complete New form whose Workspace row draws `fieldValue`; `undefined` drops that row. */
function newFormFrame(fieldValue: string | undefined, options: { readonly pending?: boolean } = {}): string {
  const pane = [" New session ", "  Host: [ Local ]"];
  if (fieldValue !== undefined) pane.push(`> Workspace: ${fieldValue}`);
  if (options.pending === true) pane.push(" Starting (request 1) ");
  pane.push(NEW_FORM_FOOTER);
  return hostFrame(pane);
}

/** The repaint that used to be read as "submitted": the form is open, nothing was submitted. */
const PARTIAL_REPAINT = hostFrame([" New session ", "  Host: [ Local ]", NEW_FORM_FOOTER]);

const NO_FENCE: StartIdentityFence = { pids: new Set<number>(), sessionIds: new Set<string>() };

function nativeStart(overrides: Partial<NativeJournalRecord> = {}): NativeJournalRecord {
  return { type: "session_start", cwd: WORKSPACE, pid: 4242, sessionId: "conv-4242", displayName: "alpha", ...overrides };
}

function ptySpawn(overrides: Partial<PtyJournalRecord> = {}): PtyJournalRecord {
  return { type: "pty_spawn", cwd: WORKSPACE, pid: 5252, ...overrides };
}

test("the launcher fresh-start witness needs a start for this exact workspace", () => {
  assert.equal(observePosixLauncherFreshStart([nativeStart()], [], { workspace: WORKSPACE, fence: NO_FENCE })?.pid,
    4242, "the native observer's own session_start proves the start");
  assert.equal(observePosixLauncherFreshStart([], [ptySpawn()], { workspace: WORKSPACE, fence: NO_FENCE })?.pid,
    5252, "the original public PTY spawn receipt proves the start before the lifecycle is observed");

  // Nothing else names this create: another workspace, another event, or a
  // record with no usable process id is never a start.
  assert.equal(observePosixLauncherFreshStart([nativeStart({ cwd: "/owned/scratch/other" })], [],
    { workspace: WORKSPACE, fence: NO_FENCE }), undefined);
  assert.equal(observePosixLauncherFreshStart([], [ptySpawn({ cwd: "/owned/scratch/other" })],
    { workspace: WORKSPACE, fence: NO_FENCE }), undefined);
  assert.equal(observePosixLauncherFreshStart([nativeStart({ type: "session_shutdown" })], [],
    { workspace: WORKSPACE, fence: NO_FENCE }), undefined);
  assert.equal(observePosixLauncherFreshStart([], [{ type: "pty_exit", cwd: WORKSPACE, pid: 5252 }],
    { workspace: WORKSPACE, fence: NO_FENCE }), undefined);
  for (const pid of [undefined, 0, -7, 4.5, Number.NaN]) {
    assert.equal(observePosixLauncherFreshStart([nativeStart({ pid })], [],
      { workspace: WORKSPACE, fence: NO_FENCE }), undefined, `pid ${String(pid)} is not a usable start`);
    assert.equal(observePosixLauncherFreshStart([], [ptySpawn({ pid })],
      { workspace: WORKSPACE, fence: NO_FENCE }), undefined, `spawn pid ${String(pid)} is not a usable start`);
  }
  // The shared witness's floor is a usable positive PID; the driver keeps its own
  // stricter `pid > 1` gate on the spawn receipt it asserts afterwards.
  assert.equal(observePosixLauncherFreshStart([nativeStart({ pid: 1 })], [],
    { workspace: WORKSPACE, fence: NO_FENCE })?.pid, 1);
});

test("a pre-existing observer or spawn identity never stands in for this create's child", () => {
  // Everything the launcher already reported before the witnessed keystroke.
  const preexisting = [nativeStart(), ptySpawn()];
  const fence = captureStartIdentities(preexisting);
  assert.deepEqual([...fence.pids].sort((left, right) => left - right), [4242, 5252]);

  // The same identities, redrawn or re-reported, are older children, not this one.
  assert.equal(observePosixLauncherFreshStart(preexisting, [], { workspace: WORKSPACE, fence }), undefined);
  assert.equal(observePosixLauncherFreshStart([], preexisting, { workspace: WORKSPACE, fence }), undefined);
  assert.equal(observePosixLauncherFreshStart([nativeStart({ sessionId: "conv-new" })], [],
    { workspace: WORKSPACE, fence }), undefined, "a reused PID is never a fresh child");
  assert.equal(observePosixLauncherFreshStart([nativeStart({ pid: 9999, sessionId: "conv-4242" })], [],
    { workspace: WORKSPACE, fence }), undefined, "a reused conversation id is never a fresh child");
  assert.equal(observePosixLauncherFreshStart([], [ptySpawn({ pid: 4242 })],
    { workspace: WORKSPACE, fence }), undefined, "a reused spawn PID is never a fresh child");

  // A genuinely new identity for this exact workspace is.
  assert.equal(observePosixLauncherFreshStart([nativeStart({ pid: 6060, sessionId: "conv-6060" })], [],
    { workspace: WORKSPACE, fence })?.pid, 6060);
  assert.equal(observePosixLauncherFreshStart([], [ptySpawn({ pid: 6161 })],
    { workspace: WORKSPACE, fence })?.pid, 6161);
});

test("the launcher witness keeps the shared New-form branch positive in both directions", () => {
  const freshStartFor = (records: readonly NativeJournalRecord[], spawns: readonly PtyJournalRecord[]) =>
    () => observePosixLauncherFreshStart(records, spawns, { workspace: WORKSPACE, fence: NO_FENCE });

  // No positive evidence at all: no witness, so the caller keeps waiting instead
  // of treating a missing `> Workspace:` row as a submission.
  assert.equal(observeWorkspaceSubmitWitness(PARTIAL_REPAINT, {
    completedPath: COMPLETED,
    freshStart: freshStartFor([], []),
  }), undefined, "a repaint that lost the Workspace row with no reported start proves nothing");

  // The real host took the submission: the same frame now carries the launcher's
  // fresh spawn receipt, so the branch is a start and never gets a second Enter.
  const started = observeWorkspaceSubmitWitness(PARTIAL_REPAINT, {
    completedPath: COMPLETED,
    freshStart: freshStartFor([], [ptySpawn()]),
  });
  assert.equal(started?.kind, "fresh-start");
  assert.equal(requiresSecondWorkspaceEnter(started), false,
    "a start the launcher already reported never receives a further Enter");

  // The host's own pending-create row outranks a still-drawn completed form.
  const pending = observeWorkspaceSubmitWitness(newFormFrame(COMPLETED, { pending: true }), {
    completedPath: COMPLETED,
    freshStart: freshStartFor([], []),
  });
  assert.equal(pending?.kind, "pending-create");
  assert.equal(requiresSecondWorkspaceEnter(pending), false);

  // Only the exact completed owned folder in a completely drawn form authorises
  // the one further Enter, and the matched frame is the branch's own evidence.
  const completion = observeWorkspaceSubmitWitness(newFormFrame(COMPLETED), {
    completedPath: COMPLETED,
    freshStart: freshStartFor([], []),
  });
  assert.equal(requiresSecondWorkspaceEnter(completion), true);
  assert.ok(completion !== undefined && completion.kind === "owned-folder-completion");
  assert.equal(completion.frame.includes("> Workspace:"), true,
    "the witness carries the frame that proved the completion, never a later transient one");
});
