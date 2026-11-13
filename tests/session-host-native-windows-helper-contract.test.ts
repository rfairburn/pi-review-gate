import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";

import {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  classifyFirstWorkspaceEnter,
  readBorderedEditorContent,
  requireFolderCompletedObservation,
  sameFileIdentity,
  windowsDirectoryCompletionCandidates,
  windowsQuitConfirmationCanonicalRows,
  windowsQuitConfirmationFrameMatches,
  validateWindowsExitWitness,
  type WindowsWitnessExpectation,
} from "./helpers/session-host-native-windows-contracts";
import {
  ChangeSignal,
  WINDOWS_EVENT_TIMEOUT_MS,
  closeExitedOwnedConptyReader,
  WindowsMainPtyDriver,
  type NativePtyHandle,
} from "./helpers/session-host-native-windows-harness";

const READY_EXPECTATION: WindowsWitnessExpectation = {
  requestNonce: "nonce_0123456789abcdef01234567",
  observerPid: 4210,
  nativePid: 7312,
  state: "READY",
};
const EXIT_EXPECTATION: WindowsWitnessExpectation = { ...READY_EXPECTATION, state: "exited" };
const TICKS = "638564000000000000";

function witness(state: "READY" | "exited", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestNonce: READY_EXPECTATION.requestNonce,
    observerPid: READY_EXPECTATION.observerPid,
    nativePid: READY_EXPECTATION.nativePid,
    nativeCreationTimeUtcTicks: TICKS,
    state,
    ...(state === "exited" ? { exitCode: 0 } : {}),
    ...overrides,
  };
}

test("Windows native helper contract validates exact READY and retained exited witnesses", () => {
  const ready = validateWindowsExitWitness(witness("READY"), READY_EXPECTATION);
  assert.equal(ready.state, "READY");
  assert.equal(ready.nativeCreationTimeUtcTicks, TICKS, "creation ticks remain an exact decimal string, never a Number");
  const exited = validateWindowsExitWitness(witness("exited"), EXIT_EXPECTATION);
  assert.equal(exited.state, "exited");
  assert.equal(exited.exitCode, 0, "only the kernel-handle exited/zero result is accepted");
});

test("Windows native helper contract rejects schema, nonce, PID, ticks, and non-exit acknowledgements", () => {
  assert.throws(() => validateWindowsExitWitness(null, READY_EXPECTATION), /JSON object/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { schemaVersion: 2 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { requestNonce: "other_nonce_0123456789" }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { observerPid: 4211 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativePid: 7313 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "" }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: 638564000000000000 }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "0638564000000000000" }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "9999999999999999999" }), READY_EXPECTATION), /DateTime range/);
  assert.throws(() => validateWindowsExitWitness(witness("exited"), READY_EXPECTATION), /schema shape/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { exitCode: 1 }), EXIT_EXPECTATION), /exit code zero/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { state: "requested" }), EXIT_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { result: "acknowledged" }), EXIT_EXPECTATION), /schema shape/);
});

test("Windows native helper contract compares filesystem identities without Number coercion", () => {
  const same = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_997n };
  assert.equal(sameFileIdentity(same, { ...same }), true);
  assert.equal(sameFileIdentity(same, { dev: same.dev + 1n, ino: same.ino }), false);
  assert.equal(sameFileIdentity(same, { dev: same.dev, ino: same.ino + 1n }), false);
});

/**
 * The real pinned Editor contract as the session host draws it: the field label
 * sits immediately left of the field column on the first editable body row, and
 * the Editor's own top and bottom rules stay unlabeled.
 */
function publicEditorFrame(
  fieldLabel: "> Workspace:" | "> New name:",
  bodyRows: readonly string[],
  width = 24,
): string {
  const indent = "     ";
  const prefix = `${fieldLabel} `;
  const gutter = `${indent}${" ".repeat(prefix.length)}`;
  const rule = "─".repeat(width);
  return [
    "Session host · Welcome",
    `${gutter}${rule}`,
    ...bodyRows.map((row, index) => `${index === 0 ? `${indent}${prefix}` : gutter}${row.padEnd(width)}`),
    `${gutter}${rule}`,
  ].join("\n");
}

/** The superseded mislabelled Editor: the label sits beside the top rule. */
function publicEditorFrameLabelOnTopRule(
  fieldLabel: "> Workspace:" | "> New name:",
  bodyRows: readonly string[],
  width = 24,
): string {
  const indent = "     ";
  const prefix = `${fieldLabel} `;
  const bodyIndent = `${indent}${" ".repeat(prefix.length)}`;
  const rule = "─".repeat(width);
  return [
    "Session host · Welcome",
    `${indent}${prefix}${rule}`,
    ...bodyRows.map((row) => `${bodyIndent}${row.padEnd(width)}`),
    `${bodyIndent}${rule}`,
  ].join("\n");
}

test("Windows native helper contract requires the field label inside the content body", () => {
  // The corrected alignment is read as the field's own complete body.
  const labelled = publicEditorFrame("> Workspace:", ["", "C:\\owned\\project"]);
  assert.equal(readBorderedEditorContent(labelled, "> Workspace:"), "C:\\owned\\project");
  assertNativeEditorFieldEmpty(publicEditorFrame("> New name:", ["", ""]), "> New name:");
  assert.throws(() => assertNativeEditorFieldEmpty(
    publicEditorFrame("> Workspace:", ["", "draft"]), "> Workspace:",
  ), /not empty/);

  // The superseded layout, where the label sat beside the top rule and the body
  // rows were unlabeled, is never accepted as a field.
  const mislabelled = publicEditorFrameLabelOnTopRule("> Workspace:", ["C:\\owned\\project"]);
  assert.throws(() => readBorderedEditorContent(mislabelled, "> Workspace:"), /horizontal top rule/);
  assert.throws(() => readBorderedEditorContent(publicEditorFrameLabelOnTopRule("> New name:", [""]), "> New name:"),
    /horizontal top rule/);
  // A label beside no field column at all is still not a field.
  assert.throws(() => assertNativeEditorFieldEmpty(" > Workspace: ", "> Workspace:"), /horizontal top rule/);
  // And a labelled block with no bottom rule is never a complete body.
  const truncated = publicEditorFrame("> Workspace:", ["", ""]).split("\n").slice(0, -1).join("\n");
  assert.throws(() => assertNativeEditorFieldEmpty(truncated, "> Workspace:"), /horizontal bottom rule/);
  // A body row whose left gutter carries other text is not aligned field content.
  const crowded = publicEditorFrame("> Workspace:", ["", "x"]).split("\n");
  const crowdedRow = crowded[3]!;
  crowded[3] = `${crowdedRow.slice(0, 10)}x${crowdedRow.slice(11)}`;
  assert.throws(() => readBorderedEditorContent(crowded.join("\n"), "> Workspace:"),
    /not aligned under its visible field column/);
  // Two labelled field boxes in one frame never resolve to "the first one".
  const doubled = `${publicEditorFrame("> Workspace:", ["", ""])}\n${publicEditorFrame("> Workspace:", ["", ""])}`;
  assert.throws(() => readBorderedEditorContent(doubled, "> Workspace:"), /ambiguous/);
});

test("Windows native helper contract parses the pinned Editor's horizontal rules and complete empty bodies", () => {
  const workspace = publicEditorFrame("> Workspace:", [""]);
  assert.equal(readBorderedEditorContent(workspace, "> Workspace:"), "");
  assertNativeEditorFieldEmpty(workspace, "> Workspace:");

  const edit = publicEditorFrame("> New name:", [""]);
  assertNativeEditorFieldEmpty(edit, "> New name:");
  assert.throws(() => assertNativeEditorFieldEmpty(publicEditorFrame("> Workspace:", ["draft"]), "> Workspace:"), /not empty/);
  assert.throws(() => assertNativeEditorFieldEmpty(" > Workspace: ", "> Workspace:"), /horizontal top rule/);
  assert.throws(() => assertNativeEditorFieldEmpty(`${workspace.split("\n").slice(0, -1).join("\n")}\n`, "> Workspace:"), /horizontal bottom rule/);
});

test("Windows native helper contract observes an exact typed workspace across a suffix-splitting wrap", () => {
  const workspace = "C:\\owned\\" + "x".repeat(64) + "\\a";
  const frame = publicEditorFrame("> Workspace:", [workspace.slice(0, 73), workspace.slice(73)], 74);
  assert.equal(frame.includes(workspace.slice(-18)), false);
  assert.equal(borderedEditorContentMatches(frame, "> Workspace:", workspace), true);
  const partial = publicEditorFrame("> Workspace:", [workspace.slice(0, 73), workspace.slice(73, -1)], 74);
  assert.equal(borderedEditorContentMatches(partial, "> Workspace:", workspace), false);
});

test("Windows native helper contract reconstructs wrapped Editor rows and forward-slash completion display", () => {
  const expected = windowsDirectoryCompletionCandidates("C:\\owned\\project");
  assert.equal(expected[0], "C:/owned/project/");
  const wrappedRows = ["C:/owned", "/project", "/"];
  const frame = publicEditorFrame("> Workspace:", wrappedRows, 9);
  assert.equal(readBorderedEditorContent(frame, "> Workspace:"), expected[0]);
  assert.equal(borderedEditorContentMatches(frame, "> Workspace:", expected), true);
  assert.deepEqual(classifyFirstWorkspaceEnter(frame, expected), {
    state: "folder-completed",
    acceptedPath: expected[0],
  });

  const quotedExpected = windowsDirectoryCompletionCandidates("C:\\Owned Space\\project");
  const quotedFrame = publicEditorFrame("> Workspace:", ['"C:/Owned ', 'Space/project/"'], 20);
  assert.equal(borderedEditorContentMatches(quotedFrame, "> Workspace:", quotedExpected), true,
    "wrapped native quoting and a word-boundary space are accepted only around the exact owned completion");
  assert.deepEqual(classifyFirstWorkspaceEnter("Session host · Starting (request 1)", expected), { state: "submitted" });
  assert.deepEqual(classifyFirstWorkspaceEnter("Session host · Welcome", expected), { state: "submitted" });
  assert.throws(() => classifyFirstWorkspaceEnter(frame, windowsDirectoryCompletionCandidates("C:\\owned\\other")),
    /exact owned forward-slash directory completion/);
});

test("Windows native helper contract rejects direct submission as completion evidence", () => {
  const expected = windowsDirectoryCompletionCandidates("C:\\owned\\project");
  // A direct submission (form closed) is not completion evidence.
  const submitted = classifyFirstWorkspaceEnter("Session host · Starting (request 1)", expected);
  assert.throws(() => requireFolderCompletedObservation(submitted), /direct submission is not completion evidence/);
  // A verified folder completion is accepted.
  const wrappedRows = ["C:/owned", "/project", "/"];
  const frame = publicEditorFrame("> Workspace:", wrappedRows, 9);
  const completed = classifyFirstWorkspaceEnter(frame, expected);
  assert.equal(requireFolderCompletedObservation(completed).acceptedPath, expected[0]);
});

test("Windows exact Quit confirmation witness requires the complete ordered canonical pane for the exact count", () => {
  const sidebarColumns = 32;
  const sidebarRows = 49;
  const totalRows = 50;
  const compose = (rows: readonly string[]): string =>
    ["Session host", ...rows.map((line) => `${line.padEnd(sidebarColumns)}\u2502${" ".repeat(87)}`)].join("\n");
  const accept = (rows: readonly string[]): boolean => windowsQuitConfirmationFrameMatches(
    compose(rows), 2, sidebarColumns, sidebarRows, totalRows);

  const expected = windowsQuitConfirmationCanonicalRows(2, sidebarColumns, sidebarRows);
  assert.ok(expected !== undefined && expected.length === sidebarRows,
    "the real public controller renders the complete canonical 32-column confirmation at the actual pane geometry");
  assert.equal(accept(expected!), true,
    "the genuine complete canonical 32-column confirmation is accepted");
  const nativePaneOnly = ["Session host", ...expected!.map((line) => `${" ".repeat(sidebarColumns)}│${line}`)].join("\n");
  assert.equal(windowsQuitConfirmationFrameMatches(nativePaneOnly, 2, sidebarColumns, sidebarRows, totalRows), false,
    "the same confirmation text in the native pane is never sidebar authority");
  const hiddenSidebar = ["Session host", ...expected!.map((line) => line.padEnd(120))].join("\n");
  assert.equal(windowsQuitConfirmationFrameMatches(hiddenSidebar, 2, sidebarColumns, sidebarRows, totalRows), false,
    "native-only output with no sidebar divider cannot establish the expected pane geometry");

  // Exact count, never a substring: a genuine 12-live pane must fail when 2 are expected.
  const twelve = windowsQuitConfirmationCanonicalRows(12, sidebarColumns, sidebarRows);
  assert.ok(twelve !== undefined);
  assert.equal(accept(twelve!), false,
    "a drifted live count (12 rendered, 2 expected) is rejected exactly, not by substring");

  const countTailIndex = expected!.findIndex((line) => line.trim() === "host-owned");
  assert.ok(countTailIndex >= 0, "the wrapped count tail is present in the canonical rows");
  const corruptedCountTail = [...expected!];
  corruptedCountTail[countTailIndex] = "host-owned CORRUPTED".padEnd(sidebarColumns);
  assert.equal(accept(corruptedCountTail), false, "a body ending in a corrupted count row is rejected");

  const corruptedHeader = [...expected!];
  corruptedHeader[0] = "Quit hosts".padEnd(sidebarColumns);
  assert.equal(accept(corruptedHeader), false, "a corrupted header row is rejected");

  const duplicatedHeader = [...expected!];
  duplicatedHeader[1] = expected![0];
  assert.equal(accept(duplicatedHeader), false, "a duplicated header row is rejected");

  const hintA = expected!.findIndex((line) => line.trim() === "enter/y = quit host");
  const hintB = expected!.findIndex((line) => line.trim() === "esc/n = cancel");
  assert.ok(hintA >= 0 && hintB >= 0);
  const reorderedHints = [...expected!];
  reorderedHints[hintA] = expected![hintB];
  reorderedHints[hintB] = expected![hintA];
  assert.equal(accept(reorderedHints), false, "reordered confirmation hints are rejected");

  const missingHint = expected!.filter((line) => line.trim() !== "esc/n = cancel");
  assert.equal(accept(missingHint), false, "a partial pane missing a hint row is rejected");

  assert.equal(windowsQuitConfirmationFrameMatches(compose(expected!), 2, sidebarColumns, sidebarRows, totalRows - 1), false,
    "a frame with the wrong total row count is rejected");
});

test("Windows Quit witness rejects insufficient and invalid confirmation geometry", () => {
  for (const [columns, rows] of [[32, 4], [10, 49], [0, 49], [32, 0], [NaN, 49], [32, Infinity]]) {
    assert.equal(windowsQuitConfirmationCanonicalRows(2, columns, rows), undefined,
      `${columns}x${rows} cannot establish the complete confirmation header, count, and both hints`);
  }
  const tooSmallFrame = ["Session host", " pane 32x4 too small ", "", "", ""].join("\n");
  assert.equal(windowsQuitConfirmationFrameMatches(tooSmallFrame, 2, 32, 4, 5), false,
    "an actual too-small render is not authority even when every canonical fallback row matches");
});

test("an exited outer ConPTY-DLL PTY is closed publicly, then only its owned reader Worker is terminated", async () => {
  const reader = new Worker("setInterval(() => {}, 1000);", { eval: true });
  const readerExit = new Promise<number>((resolve) => reader.once("exit", resolve));
  const calls: unknown[][] = [];
  const pty = { kill: (...args: unknown[]) => { calls.push(args); }, _agent: { _useConptyDll: true, _conoutSocketWorker: { _worker: reader } } };
  await closeExitedOwnedConptyReader(pty as unknown as NativePtyHandle);
  assert.deepEqual(calls, [[]], "public kill() with no signal argument, exactly once");
  assert.equal(typeof await readerExit, "number", "the owned reader Worker actually exited");

  for (const agent of [
    undefined,
    { _useConptyDll: false, _conoutSocketWorker: { _worker: reader } },
    { _useConptyDll: true, _conoutSocketWorker: {} },
    { _useConptyDll: true, _conoutSocketWorker: { _worker: { terminate: async () => 0 } } },
  ]) {
    const killed: unknown[] = [];
    await assert.rejects(closeExitedOwnedConptyReader({ kill: () => killed.push(1), _agent: agent } as unknown as NativePtyHandle),
      /not the pinned ConPTY-DLL shape/);
    assert.deepEqual(killed, [], "an unexpected backend or reader shape fails closed before kill()");
  }
});

/**
 * The structural surface the outer-exit wait and its startup diagnostic touch.
 * A prototype-only fake (no constructor, no PTY, no Windows host) exercises the
 * real notification-driven wait and the real bounded startup diagnostic over
 * real task-created runner leaves. A passing run here is not Windows host proof.
 */
interface FakeOuterExitDriver {
  exitSignal: InstanceType<typeof ChangeSignal>;
  exitEvent?: { readonly exitCode: number; readonly signal?: number };
  resultFile: string;
  stageJournal: string;
  ptyJournal: string;
  observerFile: string;
  replyLog: string[];
  spawnedAt: number;
  dataChunks: number;
  dataChars: number;
  firstDataMs: number;
  lastDataMs: number;
  sawAlternateEnter: boolean;
  sawAlternateLeave: boolean;
  waitForExit(timeoutMs?: number): Promise<{ readonly exitCode: number; readonly signal?: number }>;
}

/** Private content the runner's result leaf could carry; never a diagnostic token. */
const PRIVATE_MAIN_RESULT_TEXT = "SECRET-MAIN-RESULT-TEXT";
const PRIVATE_MAIN_PATH = "C:\\Users\\private-owner\\secret-workspace";
/** The real runner trace fixture, so the staged last stage is genuine vocabulary. */
const startupTraceFixture = createRequire(join(process.cwd(), "package.json"))(
  join(process.cwd(), "tests", "fixtures", "session-host-windows-startup-trace.cjs"),
) as { createStartupTrace(options: Record<string, unknown>): { stage(name: string, fields?: Record<string, unknown>): void } };

function fakeOuterExitDriver(files: { resultFile: string; stageJournal: string; ptyJournal: string; observerFile: string }): FakeOuterExitDriver {
  const fake = Object.create(WindowsMainPtyDriver.prototype) as unknown as FakeOuterExitDriver;
  Object.assign(fake, {
    exitSignal: new ChangeSignal(),
    exitEvent: undefined,
    replyLog: [],
    spawnedAt: performance.now(),
    dataChunks: 41,
    dataChars: 18_432,
    firstDataMs: 12,
    lastDataMs: 26_493,
    sawAlternateEnter: true,
    sawAlternateLeave: false,
  }, files);
  return fake;
}

/** Runs one real outer-exit wait to its unchanged deadline and returns the message. */
async function outerExitFailure(t: TestContext, driver: FakeOuterExitDriver): Promise<string> {
  const waiter = driver.waitForExit();
  let settledEarly = false;
  waiter.then(() => { settledEarly = true; }, () => { settledEarly = true; });
  await Promise.resolve();
  assert.equal(settledEarly, false, "an outer PTY with no exit event stays unsettled before its deadline");
  t.mock.timers.tick(WINDOWS_EVENT_TIMEOUT_MS);
  return await waiter.then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

test("the outer Main PTY exit wait keeps its unchanged deadline and appends the bounded runner result state without any private result content", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = mkdtempSync(join(tmpdir(), "prg-windows-outer-exit-diag-"));
  try {
    const files = {
      resultFile: join(root, "main-result.json"),
      stageJournal: join(root, "runner-stages.jsonl"),
      ptyJournal: join(root, "pty-events.jsonl"),
      observerFile: join(root, "native-main.jsonl"),
    };
    for (const path of [files.stageJournal, files.ptyJournal, files.observerFile]) writeFileSync(path, "");

    // 1. The runner recorded nothing: its absence is disclosed, not assumed.
    const absent = fakeOuterExitDriver(files);
    const absentMessage = await outerExitFailure(t, absent);
    assert.match(absentMessage, /outer public Main PTY exit: deadline exceeded/,
      "the unchanged deadline failure is preserved verbatim ahead of the diagnostic");
    assert.ok(absentMessage.includes("result=absent"), "an absent runner result is disclosed as absent");
    assert.ok(absentMessage.includes("outer=alive"), "a still-running outer PTY is disclosed as alive");
    assert.equal(absent.exitEvent, undefined, "the diagnostic fabricated no outer exit");

    // 2. The runner returned zero but its outer PTY exit never arrived: the
    //    existing MainResult flags become observable without any new proof.
    writeFileSync(files.resultFile, JSON.stringify({
      status: 0,
      threw: false,
      forceAttempted: false,
      journalFailed: false,
      unresolvedSpawns: 0,
      unexitedSpawns: 0,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      sameInputStream: false,
      sameOutputStream: false,
      rawBefore: false,
      rawAfter: false,
      errorText: `${PRIVATE_MAIN_PATH} ${PRIVATE_MAIN_RESULT_TEXT}`,
    }));
    // The runner's own fixed-vocabulary trace records its last completed stage.
    startupTraceFixture.createStartupTrace({ journal: files.stageJournal, fs: require("node:fs") })
      .stage("main-returned", { status: 0 });
    const returned = fakeOuterExitDriver(files);
    const returnedMessage = await outerExitFailure(t, returned);
    assert.match(returnedMessage, /outer public Main PTY exit: deadline exceeded/);
    assert.ok(returnedMessage.includes("outer=alive"),
      "the missing outer exit event is disclosed as still alive beside a returned Main");
    assert.ok(returnedMessage.includes("result={status=0") && returnedMessage.includes("unexitedSpawns=0")
      && returnedMessage.includes("threw=false") && returnedMessage.includes("forceAttempted=false"),
    "the runner's actual return/kill/spawn flags are disclosed");
    assert.ok(returnedMessage.includes("rawBefore=false") && returnedMessage.includes("rawAfter=false"),
      "the runner's TTY restoration flags are disclosed");
    assert.ok(returnedMessage.includes("main-returned(status=0)"),
      "the runner's own last recorded stage is disclosed beside the still-alive outer PTY, which is the distinction between a returned Main and a missing exit event");
    for (const privateText of [PRIVATE_MAIN_RESULT_TEXT, "private-owner"]) {
      assert.ok(!returnedMessage.includes(privateText), "the result leaf's private content is never formatted");
    }
    assert.ok(!returnedMessage.includes(root) && !returnedMessage.includes(files.resultFile),
      "the diagnostic never carries a path");
    assert.equal(returned.exitEvent, undefined, "a disclosed zero-returning result is never outer exit proof");

    // 3. A present but unparseable result leaf stays disclosed as unreadable.
    writeFileSync(files.resultFile, `{"status":0,"errorText":"${PRIVATE_MAIN_RESULT_TEXT}`);
    const unreadable = fakeOuterExitDriver(files);
    const unreadableMessage = await outerExitFailure(t, unreadable);
    assert.match(unreadableMessage, /outer public Main PTY exit: deadline exceeded/);
    assert.ok(unreadableMessage.includes("result=unreadable"), "a truncated runner result is disclosed as unreadable");
    assert.ok(!unreadableMessage.includes(PRIVATE_MAIN_RESULT_TEXT), "an unreadable leaf's content is never formatted");

    // Every appended diagnostic stays within the existing startup bound.
    for (const message of [absentMessage, returnedMessage, unreadableMessage]) {
      assert.match(/startup\{[^\n]*\}/u.exec(message)?.[0] ?? "", /startup\{.*\}/u, "the existing startup diagnostic is appended");
      assert.ok(message.length < 4_000, "the appended diagnostic stays bounded");
    }

    // The unchanged fast path is untouched: a real exit event never waits.
    const exited = fakeOuterExitDriver(files);
    Object.assign(exited, { exitEvent: { exitCode: 0 } });
    assert.deepEqual(await exited.waitForExit(WINDOWS_EVENT_TIMEOUT_MS), { exitCode: 0 },
      "an already-observed outer exit still resolves without a wait or a diagnostic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
