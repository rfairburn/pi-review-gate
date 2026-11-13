/**
 * Focused contract controls for the exact-process observer's bounded STDERR stage
 * timing (Refs #663).
 *
 * A real Windows run positively reported the Main Node22 observer READY timeout
 * with `readyState=absent resultState=absent childState=alive rootIdentityOk=true`
 * at the unchanged 30s bound. That evidence says the leaf never appeared while the
 * child stayed alive; it cannot say whether the PowerShell script ever entered,
 * validated its root, bound its exact-PID handle, or completed a publication. The
 * owned fixture now writes fixed-vocabulary stage markers to STDERR, and
 * `WindowsObserverStageLedger` turns only exact allowlisted marker lines into
 * `stage -> elapsed ms since this observer's own spawn` records.
 *
 * Every control below is a test-side contract, not Windows host proof: no
 * PowerShell, native process, node-pty, or Main session runs here, and nothing is
 * claimed about a real observer run. What is proven is the contract the next real
 * run depends on — closed vocabulary, bounded records, no retained stderr, no new
 * wait, and no new way to satisfy readiness or exit.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ChangeSignal,
  OBSERVER_DIAGNOSTIC_MAX_CHARS,
  WINDOWS_EVENT_TIMEOUT_MS,
  WINDOWS_OBSERVER_STAGE_MARKER_PREFIX,
  WINDOWS_OBSERVER_STAGES,
  WINDOWS_OBSERVER_TIMEOUT_SECONDS,
  WindowsObserverStageLedger,
  WindowsOwnedExitObserver,
  couldBecomeStageMarkerLine,
  identityOfRealDirectory,
  parseWindowsObserverStageMarker,
  type FileIdentity,
  type WindowsExitWitness,
  type WindowsObserverStage,
} from "./helpers/session-host-native-windows-harness";

const NATIVE_PID = 7_312;
const OBSERVER_PID = 4_321;
const NONCE = "nonce_0123456789abcdef01234567";
const marker = (stage: WindowsObserverStage): string => `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${stage}\n`;

/** Private content no stage diagnostic may ever carry, seeded by the controls. */
const PRIVATE_TRANSCRIPT = "SECRET-OBSERVER-STDERR-TRANSCRIPT";
const PRIVATE_PATH = "C:\\Users\\private-owner\\secret-workspace";
const PRIVATE_CHILD_ERROR = "the public powershell.exe child failed with SECRET-CHILD-ERROR-TEXT";
const PRIVATE_WITNESS = `{"requestNonce":"${PRIVATE_TRANSCRIPT}","workspace":"${PRIVATE_PATH}","state":"READY"}`;

/** The same bounded fixed shape the existing observer diagnostic is held to. */
const DIAGNOSTIC_SHAPE = /^observerDiag\{(?:[a-zA-Z]+=[A-Za-z0-9?_.-]+ ?)+\}$/u;

/** One `stage.elapsed` pair inside the `stages=` token. */
const STAGE_PAIR = /^[a-z][a-z-]{2,31}\.[0-9]+(?:x[0-9]+)?$/u;

/** Virtual clock and timers: no control below waits on real time. */
function enableMockClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
}

/** Let timer callbacks' promise settlements run before asserting their state. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function ownedRoot(): string {
  const parent = join(process.cwd(), "node_modules", ".observer-stage-controls");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, "r-"));
}

/**
 * The real prototype's real methods over a real task-created root, exactly as the
 * existing observer diagnostic controls do it: a `WindowsOwnedExitObserver` built
 * without its constructor, because a real one needs a real `powershell.exe` spawn.
 * `withLedger: false` reproduces the pre-existing diagnostic-only fake shape,
 * which never had any stage field at all.
 */
type ObserverFake = {
  root: string;
  rootIdentity: FileIdentity;
  nativePid: number;
  nonce: string;
  child: { readonly pid: number | null };
  readonly signal: ChangeSignal;
  readyPath: string;
  resultPath: string;
  witnessFileIdentities: Map<string, FileIdentity>;
  stageLedger?: WindowsObserverStageLedger;
  closeEvent?: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  spawnError?: Error;
  readyWitness?: WindowsExitWitness;
  resultWitness?: WindowsExitWitness;
  observerDiagnostic(): string;
  retainUntilFailureTimeout(): Promise<void>;
  waitUntilReady(timeoutMs?: number): Promise<WindowsExitWitness>;
};

function fakeObserver(t: TestContext, options: { withLedger?: boolean } = {}): ObserverFake {
  const root = ownedRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observer = Object.create(WindowsOwnedExitObserver.prototype) as ObserverFake;
  Object.assign(observer, {
    root,
    rootIdentity: identityOfRealDirectory(root),
    nativePid: NATIVE_PID,
    nonce: NONCE,
    child: { pid: OBSERVER_PID },
    signal: new ChangeSignal(),
    readyPath: join(root, `${NONCE}.ready.json`),
    resultPath: join(root, `${NONCE}.result.json`),
    witnessFileIdentities: new Map<string, FileIdentity>(),
    ...(options.withLedger === false ? {} : { stageLedger: new WindowsObserverStageLedger() }),
  });
  return observer;
}

async function rejectionMessage(waiter: Promise<unknown>): Promise<string> {
  return await waiter.then(() => "", (error: unknown) => (error instanceof Error ? error.message : String(error)));
}

/** Capture this process's own stderr writes for the duration of one control. */
function captureStderr(t: TestContext): { readonly text: () => string; readonly calls: () => number } {
  const captured: string[] = [];
  t.mock.method(process.stderr, "write", ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write);
  return { text: () => captured.join(""), calls: () => captured.length };
}

test("the stage parser accepts only the closed marker vocabulary and rejects every other stderr line", () => {
  assert.equal(WINDOWS_OBSERVER_STAGE_MARKER_PREFIX, "PRG-OBS-STAGE:");
  for (const stage of WINDOWS_OBSERVER_STAGES) {
    assert.equal(parseWindowsObserverStageMarker(`${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${stage}`), stage);
    assert.equal(parseWindowsObserverStageMarker(`${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${stage}\r`), stage);
  }

  const rejected = [
    "",
    "\r",
    WINDOWS_OBSERVER_STAGE_MARKER_PREFIX,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}script-entered EXTRA`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}SCRIPT-ENTERED`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}script-entered.json`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}script-entered${PRIVATE_TRANSCRIPT}`,
    `x${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}script-entered`,
    "prg-obs-stage:script-entered",
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}script-entered-but-not`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${PRIVATE_PATH}`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${PRIVATE_TRANSCRIPT}`,
    `Cannot find path '${PRIVATE_PATH}' because it does not exist.`,
    `at System.Console.WriteLine(${PRIVATE_TRANSCRIPT})`,
    PRIVATE_WITNESS,
    `${PRIVATE_TRANSCRIPT} ${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}handle-bound`,
  ];
  for (const line of rejected) {
    assert.equal(parseWindowsObserverStageMarker(line), undefined, `not a stage: ${JSON.stringify(line.slice(0, 24))}`);
  }
  assert.equal(WINDOWS_OBSERVER_STAGES.length, 6, "the stage vocabulary stays a fixed six entries");
});

test("the ledger records each allowlisted stage once with bounded relative elapsed times and a bounded aggregate count", () => {
  const ledger = new WindowsObserverStageLedger();
  for (const stage of WINDOWS_OBSERVER_STAGES) ledger.observe(marker(stage));

  const records = ledger.records;
  assert.equal(records.length, WINDOWS_OBSERVER_STAGES.length, "one record per stage, never more");
  assert.deepEqual(records.map((record) => record.stage), [...WINDOWS_OBSERVER_STAGES], "canonical order");
  let previous = -1;
  for (const record of records) {
    assert.ok(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0, "elapsed ms is a bounded nonnegative integer");
    assert.ok(record.elapsedMs < 60_000, "a marker notice in this control is immediate");
    assert.ok(record.elapsedMs >= previous, "elapsed times are monotonic against the ledger's own start");
    previous = record.elapsedMs;
    assert.equal(record.count, 1, "one marker line is one observation");
  }

  // Repeats aggregate into the same fixed record instead of growing the ledger.
  const repeats = 200;
  for (let index = 0; index < repeats; index += 1) ledger.observe(marker("script-entered"));
  assert.equal(ledger.records.length, WINDOWS_OBSERVER_STAGES.length, "repeats never add a record");
  assert.equal(ledger.records[0]?.count, repeats + 1, "repeats of one stage aggregate into its one record");
  assert.ok(ledger.records.every((record) => record.count <= 999), "a stage's count never exceeds its fixed ceiling");
  assert.match(ledger.diagnosticFields()[0] ?? "", /script-entered\.[0-9]+x[0-9]+/u,
    "a repeated stage is disclosed as repeated, not as extra progress");

  // The scan's own byte bound is what makes a runaway marker stream finite: past
  // it nothing more is recorded at all.
  for (let index = 0; index < 400; index += 1) ledger.observe(marker("result-published"));
  assert.equal(ledger.scanState, "truncated", "the fixed stderr scan bound stops the stream");
  assert.equal(ledger.records.length, WINDOWS_OBSERVER_STAGES.length, "the bound never grew the ledger");

  const fields = ledger.diagnosticFields();
  assert.equal(fields.length, 3, "stage metadata is exactly three fixed tokens");
  const rendered = fields.join(" ");
  assert.match(rendered, /^[a-zA-Z]+=[A-Za-z0-9?_.-]+(?: [a-zA-Z]+=[A-Za-z0-9?_.-]+)*$/u, "bounded fixed charset");
  const pairs = /^stages=(.*) stageScan=(open|closed|truncated) stageNoise=([0-9]+)$/u.exec(rendered);
  assert.ok(pairs, "the stage tokens keep their fixed shape");
  const parts = pairs![1].split(".");
  assert.equal(parts.length, WINDOWS_OBSERVER_STAGES.length * 2, "every stage carries exactly one elapsed value");
  for (let index = 0; index < parts.length; index += 2) assert.match(`${parts[index]}.${parts[index + 1]}`, STAGE_PAIR);
  assert.equal(pairs![3], "0", "nothing was discarded, so nothing is counted as discarded");
});

test("seeded private payloads, paths, nonces, and raw stderr never enter stage records, retained state, or the diagnostic", () => {
  const noise = [
    `Cannot find path '${PRIVATE_PATH}' because it does not exist.`,
    PRIVATE_CHILD_ERROR,
    PRIVATE_WITNESS,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}${PRIVATE_TRANSCRIPT}`,
    `${PRIVATE_TRANSCRIPT} wrote to stderr`,
    `at ${PRIVATE_TRANSCRIPT}.Main(${PRIVATE_PATH}:line 42)`,
  ];
  const ledger = new WindowsObserverStageLedger();
  for (const line of noise) ledger.observe(`${line}\n`);

  assert.equal(ledger.records.length, 0, "no discarded line ever became a stage record");
  const rendered = ledger.diagnosticFields().join(" ");
  assert.equal(rendered, `stages=none stageScan=open stageNoise=${noise.length}`, "only a bounded discarded-line count");
  for (const privateText of [PRIVATE_TRANSCRIPT, "private-owner", "SECRET-CHILD-ERROR-TEXT", PRIVATE_PATH]) {
    assert.ok(!rendered.includes(privateText), `the diagnostic never carries ${privateText}`);
  }

  // Nothing is retained either: an unterminated non-marker fragment is dropped at
  // once instead of buffered, so the ledger's own state holds no stderr text.
  ledger.observe(`${PRIVATE_TRANSCRIPT}-unterminated-without-a-newline`);
  assert.equal(couldBecomeStageMarkerLine(PRIVATE_TRANSCRIPT), false, "that fragment can never become a marker");
  const retained = JSON.stringify(ledger);
  for (const privateText of [PRIVATE_TRANSCRIPT, "private-owner", PRIVATE_PATH]) {
    assert.ok(!retained.includes(privateText), "the ledger retains no stderr content");
  }

  // The skipped line is still counted once, when it ends.
  ledger.observe("\n");
  assert.equal(ledger.diagnosticFields()[2], `stageNoise=${noise.length + 1}`, "a dropped line is counted, not kept");
});

test("chunk-split and interleaved marker input records each stage exactly once and cannot fabricate one", () => {
  const ledger = new WindowsObserverStageLedger();
  ledger.observe("PRG-OBS");
  ledger.observe("-STAGE:script");
  ledger.observe("-entered\r");
  assert.equal(ledger.records.length, 0, "an incomplete line is not yet a stage");
  ledger.observe("\n");
  assert.deepEqual(ledger.records.map((record) => record.stage), ["script-entered"], "the split marker became exactly one stage");

  // Two markers in one chunk, and a marker after discarded text in the same chunk.
  ledger.observe(`${marker("root-validated")}${marker("lookup-start")}`);
  ledger.observe(`${PRIVATE_TRANSCRIPT}\n${marker("handle-bound")}`);
  assert.deepEqual(ledger.records.map((record) => record.stage),
    ["script-entered", "root-validated", "lookup-start", "handle-bound"]);
  assert.deepEqual(ledger.records.map((record) => record.count), [1, 1, 1, 1], "no stage duplicated");

  // Near-misses and forged shapes stay non-stages.
  for (const forged of [
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}handle-boundX\n`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}handle-boun\n`,
    `${PRIVATE_TRANSCRIPT}${marker("ready-published")}`,
    `${WINDOWS_OBSERVER_STAGE_MARKER_PREFIX}result-published extra\n`,
  ]) ledger.observe(forged);
  assert.deepEqual(ledger.records.map((record) => record.stage),
    ["script-entered", "root-validated", "lookup-start", "handle-bound"], "no forged input added or duplicated a stage");

  // Buffer chunks work the same way, and the ledger never exceeds its fixed size.
  ledger.observe(Buffer.from(`${marker("ready-published")}${marker("result-published")}`, "utf8"));
  assert.equal(ledger.records.length, WINDOWS_OBSERVER_STAGES.length);
  assert.ok(ledger.records.length <= WINDOWS_OBSERVER_STAGES.length, "the record count is fixed by the vocabulary");
  ledger.observe(Buffer.from([0xc3, 0xe9, 0x0a])); // a UTF-8 line that is not a marker
  assert.equal(ledger.records.length, WINDOWS_OBSERVER_STAGES.length);
});

test("the scan stops at its own byte bound, discloses truncation, and retains nothing it stopped on", () => {
  const ledger = new WindowsObserverStageLedger();
  ledger.observe("x".repeat(9_000));
  assert.equal(ledger.scanState, "truncated", "the bound is disclosed instead of quietly exceeded");
  ledger.observe(marker("script-entered"));
  assert.equal(ledger.records.length, 0, "a scan past its bound records nothing further");
  assert.match(ledger.diagnosticFields().join(" "), /^stages=none stageScan=truncated stageNoise=0$/u);
  assert.ok(!JSON.stringify(ledger).includes("xxxx"), "no stderr tail was kept");
  ledger.close();
  assert.equal(ledger.scanState, "truncated", "truncation outranks the closed state");
});

test("a fully staged marker stream never satisfies readiness: the unchanged READY deadline still fails and no witness appears", async (t) => {
  enableMockClock(t);
  const observer = fakeObserver(t);
  for (const stage of WINDOWS_OBSERVER_STAGES) observer.stageLedger!.observe(marker(stage));

  const waiter = observer.waitUntilReady();
  let settledEarly = false;
  waiter.then(() => { settledEarly = true; }, () => { settledEarly = true; });
  t.mock.timers.tick(WINDOWS_EVENT_TIMEOUT_MS - 1);
  await flushMicrotasks();
  assert.equal(settledEarly, false, "stage progress shortened nothing: the unchanged 30s bound still stands");
  t.mock.timers.tick(1);
  const failure = await rejectionMessage(waiter);
  assert.match(failure, new RegExp(`PowerShell exact-process READY for native PID ${NATIVE_PID}: deadline exceeded`),
    "the unchanged deadline failure is preserved ahead of the diagnostic");

  assert.ok(observer.readyWitness === undefined, "stage markers fabricated no READY proof");
  assert.ok(observer.resultWitness === undefined, "stage markers fabricated no exit proof");
  assert.equal(observer.witnessFileIdentities.size, 0, "no witness identity was registered");
  assert.deepEqual(readdirSync(observer.root), [], "the marker stream published no witness leaf");
  assert.equal(observer.signal.pendingWaiterCount, 0, "the failed wait cleared its listener and interval");
});

test("the failed READY diagnostic discloses observed stage progress beside the absent leaf, in the existing bounded shape", (t) => {
  const observer = fakeObserver(t);
  observer.stageLedger!.observe(marker("script-entered"));
  observer.stageLedger!.observe(marker("root-validated"));
  observer.stageLedger!.observe(`${PRIVATE_TRANSCRIPT}\n`);

  const diagnostic = observer.observerDiagnostic();
  assert.match(diagnostic, DIAGNOSTIC_SHAPE, "the existing fixed diagnostic shape is preserved");
  assert.ok(diagnostic.length <= OBSERVER_DIAGNOSTIC_MAX_CHARS && diagnostic.length < 400, "the diagnostic stays bounded");
  assert.ok(diagnostic.includes("readyState=absent") && diagnostic.includes("resultState=absent")
    && diagnostic.includes("childState=alive") && diagnostic.includes("rootIdentityOk=true"),
    "the pre-existing leaf, child, and root tokens are unchanged");
  const stages = /stages=([^ ]*)/u.exec(diagnostic)?.[1];
  assert.ok(stages !== undefined && stages.startsWith("script-entered."), "the observed stages are disclosed");
  assert.ok(!stages.includes("ready-published") && !stages.includes("result-published"),
    "an unobserved stage is absent, never inferred");
  assert.ok(/stageScan=open/u.test(diagnostic) && /stageNoise=1/u.test(diagnostic),
    "the scan state and a bounded discarded-line count are disclosed");
  for (const privateText of [PRIVATE_TRANSCRIPT, "private-owner", PRIVATE_PATH, observer.nonce, observer.root]) {
    assert.ok(!diagnostic.includes(privateText), `the diagnostic never carries ${privateText}`);
  }
});

test("a prototype-only observer fake that never ran the constructor discloses unknown stage progress and stays safe", (t) => {
  const observer = fakeObserver(t, { withLedger: false });
  const diagnostic = observer.observerDiagnostic();
  assert.match(diagnostic, DIAGNOSTIC_SHAPE, "the pre-existing diagnostic-only fake keeps its exact shape");
  assert.ok(diagnostic.includes("stages=unavailable"), "absent stage data is an honest unknown, never a success");
  assert.ok(!diagnostic.includes("stageScan") && !diagnostic.includes("stageNoise"),
    "no stage metadata is invented for an observer that never attached a stderr stream");
  assert.ok(diagnostic.includes("readyState=absent") && diagnostic.includes("childState=alive"),
    "the pre-existing leaf and child tokens still work without any stage field");
  assert.ok(diagnostic.length < 400, "the diagnostic stays bounded");
});

test("the failure-retention path emits one final sanitized snapshot after the exact child close", async (t) => {
  const captured = captureStderr(t);
  const observer = fakeObserver(t);
  observer.stageLedger!.observe(marker("script-entered"));
  observer.stageLedger!.observe(`${PRIVATE_TRANSCRIPT}\n`);
  writeFileSync(observer.readyPath, `{"requestNonce":"${PRIVATE_TRANSCRIPT}","workspace":"${PRIVATE_PATH}"`,
    { flag: "wx", mode: 0o600 });
  Object.assign(observer, { closeEvent: { code: 2, signal: null } });

  await observer.retainUntilFailureTimeout();
  assert.equal(captured.calls(), 1, "exactly one final snapshot is emitted");
  const text = captured.text();
  assert.ok(text.startsWith("windows-observer-retained observerDiag{") && text.trimEnd().endsWith("}"),
    "one fixed-prefix line carrying the observer's own bounded diagnostic");
  const diagnostic = text.trim().slice("windows-observer-retained ".length);
  assert.match(diagnostic, DIAGNOSTIC_SHAPE, "the final snapshot keeps the bounded fixed diagnostic shape");
  assert.ok(diagnostic.includes("childState=closed") && diagnostic.includes("childCode=2"),
    "the exact owned child's close is disclosed as it is");
  assert.ok(diagnostic.includes("readyState=invalid-json"),
    "a leaf that appeared after the READY wait is visible in the final snapshot");
  assert.ok(/stages=script-entered\.[0-9]+/u.test(diagnostic) && /stageNoise=1/u.test(diagnostic),
    "stage progress and a bounded discarded-line count are disclosed");
  for (const privateText of [PRIVATE_TRANSCRIPT, "private-owner", PRIVATE_PATH, observer.nonce, observer.root]) {
    assert.ok(!text.includes(privateText), `the final snapshot never carries ${privateText}`);
  }
  assert.ok(text.length < 500, "the emitted line stays bounded");
  assert.ok(observer.readyWitness === undefined && observer.resultWitness === undefined,
    "emitting the snapshot retained no witness and proved nothing");
});

test("the failure-retention snapshot is still emitted once when the child never closes, with no extra wait", async (t) => {
  enableMockClock(t);
  const captured = captureStderr(t);
  const observer = fakeObserver(t);
  observer.stageLedger!.observe(marker("script-entered"));

  const retention = observer.retainUntilFailureTimeout();
  let settled = false;
  retention.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();
  assert.equal(settled, false, "the retention wait kept its unchanged bound");
  t.mock.timers.tick((WINDOWS_OBSERVER_TIMEOUT_SECONDS + 10) * 1000);
  await retention;

  assert.equal(captured.calls(), 1, "one final snapshot after the unchanged retention bound elapsed");
  const diagnostic = captured.text().trim().slice("windows-observer-retained ".length);
  assert.match(diagnostic, DIAGNOSTIC_SHAPE);
  assert.ok(diagnostic.includes("childState=alive"), "a child that never closed is still disclosed as alive");
  assert.ok(/stages=script-entered\.[0-9]+/u.test(diagnostic), "a marker that arrived after the READY deadline is still visible");
  assert.equal(observer.signal.pendingWaiterCount, 0, "the retention wait cleared its listener");
});

test("the observer spawns with STDOUT ignored, observes only STDERR, and adds no timer, retry, or deadline change", () => {
  const harness = readFileSync(join(process.cwd(), "tests", "helpers", "session-host-native-windows-harness.ts"), "utf8");
  const classStart = harness.indexOf("export class WindowsOwnedExitObserver");
  const classEnd = harness.indexOf("export function randomNonce", classStart);
  assert.ok(classStart > 0 && classEnd > classStart, "the observer class is locatable in its own helper");
  const observerSource = harness.slice(classStart, classEnd);

  assert.match(observerSource, /stdio: \["ignore", "ignore", "pipe"\]/, "only STDERR is piped");
  assert.doesNotMatch(observerSource, /stdio: \["ignore", "ignore", "ignore"\]/, "STDERR is no longer ignored");
  assert.doesNotMatch(observerSource, /\.stdout\b/, "STDOUT is never touched at all");
  assert.equal((observerSource.match(/\.stderr\?\.on\("data"/g) ?? []).length, 1, "one STDERR drain, no more");
  assert.match(observerSource, /this\.stageLedger\.observe\(chunk\)/, "the STDERR drain only feeds the bounded ledger");
  assert.equal((observerSource.match(/\.stderr\?\.on\("error"/g) ?? []).length, 1,
    "the STDERR stream has its own error sink, so a stream error is never an unhandled error");
  const errorSinkStart = observerSource.indexOf('.stderr?.on("error"');
  assert.ok(errorSinkStart > 0, "the STDERR error sink exists on the owned child");
  const errorSink = observerSource.slice(errorSinkStart, observerSource.indexOf("});", errorSinkStart) + 3);
  assert.match(errorSink, /this\.stageLedger\.close\(\)/, "the sink only stops the stage observation");
  assert.doesNotMatch(errorSink, /spawnError|signal\.notify/u,
    "a STDERR stream error never becomes spawnError or wakes a wait, so it cannot change what a wait does");
  assert.doesNotMatch(observerSource, /setTimeout|setInterval|sleep\(/, "no new wait or retry was introduced");
  assert.equal((observerSource.match(/process\.stderr\.write\(/g) ?? []).length, 1,
    "one fixed diagnostic emission point, and no free-form logging");
  assert.match(observerSource, /windows-observer-retained /, "the emitted line carries a fixed prefix");

  const ledgerStart = harness.indexOf("export class WindowsObserverStageLedger");
  const ledgerSource = harness.slice(ledgerStart, classStart);
  assert.ok(ledgerStart > 0 && ledgerStart < classStart, "the ledger lives in the same owned helper, beside the observer class");
  assert.doesNotMatch(ledgerSource, /setTimeout|setInterval|sleep\(|new Date\(/, "the ledger adds no wait of its own");
  assert.doesNotMatch(ledgerSource, /process\.stderr|console\./, "the ledger emits nothing by itself");

  // Every existing bound is untouched.
  assert.equal(WINDOWS_EVENT_TIMEOUT_MS, 30_000, "the READY wait keeps its original 30s bound");
  assert.equal(WINDOWS_OBSERVER_TIMEOUT_SECONDS, 180, "the observer script's own bound is unchanged");
});

test("the owned fixture and the harness agree on one closed stage vocabulary, in canonical order, with one emission point", () => {
  const fixture = readFileSync(join(process.cwd(), "tests", "fixtures", "session-host-windows-exit-watcher.ps1"), "utf8");
  const code = fixture.replace(/<#[\s\S]*?#>/g, "").replace(/^[ \t]*#.*$/gm, "");

  const guard = /if \(\$Stage -notmatch '\\A\(\?:([a-z|-]+)\)\\z'\)/u.exec(code);
  assert.ok(guard, "the marker function guards its own vocabulary");
  assert.deepEqual(guard![1].split("|"), [...WINDOWS_OBSERVER_STAGES],
    "the fixture's closed vocabulary is exactly the harness enum, in canonical order");

  const callSites = [...code.matchAll(/Write-ObserverStageMarker -Stage '([a-z-]+)'/gu)].map((match) => match[1]);
  assert.deepEqual(callSites, [...WINDOWS_OBSERVER_STAGES], "one call site per stage, in canonical script order");
  assert.equal((code.match(/PRG-OBS-STAGE:/gu) ?? []).length, 1, "one fixed emission point for every marker");
  assert.match(code, /\[System\.Console\]::Error\.WriteLine\('PRG-OBS-STAGE:' \+ \$Stage\)/u,
    "markers go to STDERR only, carrying the stage name and nothing else");
  assert.doesNotMatch(code, /\[System\.Console\]::Out\b/u, "the fixture never writes STDOUT");
});
