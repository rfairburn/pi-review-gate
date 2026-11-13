/**
 * Real Windows regression for the owned ConPTY reader settlement (#666).
 *
 * What this proves on an actual Windows host, with the pinned public
 * `@lydell/node-pty` and the compiled production session-host module:
 *
 *   - a real child spawned through the production default PTY factory (the
 *     bundled-ConPTY request) exits genuinely, witnessed twice and independently:
 *     by a retained exact-process handle prebound BEFORE the deliberate quit, and
 *     by that same public PTY handle's own `onExit`;
 *   - the owning helper process — the one that holds the public PTY and therefore
 *     its owned conout reader Worker — then exits on its own, with no kill, no
 *     forced `process.exit`, and no result-file substitution: the harness waits
 *     on the retained `ChildProcess` close event it observed itself.
 *
 * Without reader settlement the owning process stays alive (a live Worker keeps
 * the Node event loop running), so this lane fails instead of passing.
 *
 * Scope honesty: this is one owned synthetic ConPTY child, not public Main or
 * launcher acceptance, and it attests nothing about input-socket or native-token
 * hygiene beyond the reader that was demonstrated. Missing prerequisites fail
 * closed under the existing Windows opt-in; a macOS skip is never Windows proof.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_EVENT_TIMEOUT_MS,
  WINDOWS_REQUIRE_ENV,
  WindowsOwnedExitObserver,
  assertCreatedDirectoryIdentity,
  assertNoRoleOrCatalogMarkers,
  createOwnedDirectory,
  createWindowsHarnessRoot,
  identityOfRealDirectory,
  probeWindowsPowerShell,
  resolveWindowsRuntime,
  safeWindowsPath,
  sameFileIdentity,
} from "./helpers/session-host-native-windows-harness";

const optIn = process.env[WINDOWS_REQUIRE_ENV] === "1";

const READER_HELPER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-conpty-reader-helper.cjs");
/** The owning helper must settle promptly; the pinned addon's drain is one second. */
const HELPER_NATURAL_EXIT_DEADLINE_MS = 30_000;
const READER_TEST_TIMEOUT_MS = 3 * 60_000;
const MAX_JOURNAL_BYTES = 64 * 1024;

interface HelperRecord {
  readonly type?: string;
  readonly pid?: number;
  readonly platform?: string;
  readonly node?: string;
  readonly exitCode?: number | null;
  readonly signal?: number | null;
  readonly name?: string;
}

function readJournal(path: string): HelperRecord[] {
  let text: string;
  try {
    const stats = lstatSync(path);
    assert.ok(stats.isFile() && !stats.isSymbolicLink(), "the helper journal is not a regular file");
    assert.ok(stats.size <= MAX_JOURNAL_BYTES, "the helper journal exceeded its bounded size");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: HelperRecord[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as HelperRecord);
    } catch {
      // Only the final line may still be mid-write; anything earlier is corrupt.
      assert.equal(index, lines.length - 1, "the helper journal contains a corrupt non-final record");
    }
  }
  return records;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The part of the retained exact-process observer the teardown must be able to settle. */
interface SettleableObserver {
	retainUntilFailureTimeout(): Promise<void>;
	dispose(): void;
}

/**
 * Failure-path teardown for the retained observer. Its own bounded failure wait
 * always runs, and the watcher is closed afterwards even when that wait rejects,
 * so a failed Windows lane cannot leave a referenced FSWatcher holding the test
 * process open. Nothing here deletes the witness tree.
 */
async function settleObserverAfterFailure(observer: SettleableObserver | undefined): Promise<void> {
	if (observer === undefined) return;
	await observer.retainUntilFailureTimeout().catch(() => undefined);
	observer.dispose();
}

async function waitFor<T>(read: () => T | undefined, deadlineMs: number, label: string, abort?: () => Error | undefined): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    const failure = abort?.();
    if (failure !== undefined) throw failure;
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await sleep(50);
  }
}

test("a real Windows ConPTY child exit settles the owned reader so the owning helper process exits naturally", {
  timeout: READER_TEST_TIMEOUT_MS,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  assert.equal(process.platform, "win32", "the opted-in lane runs only on a real Windows host");
  const runtime = resolveWindowsRuntime();
  const root = createWindowsHarnessRoot();
  const home = createOwnedDirectory(root, "home");
  const temporary = createOwnedDirectory(root, "tmp");
  const observerRoot = createOwnedDirectory(root, "observer");
  const observerIdentity = identityOfRealDirectory(observerRoot);
  for (const owned of [root, home, temporary, observerRoot]) assertCreatedDirectoryIdentity(owned);
  probeWindowsPowerShell(runtime, home, temporary);

  // The helper loads the COMPILED PRODUCTION module and calls the production
  // default factory; nothing here injects a factory or a shim around the spawn.
  const instancesModule = realpathSync(join(__dirname, "..", "src", "session-host", "instances.js"));
  assert.ok(lstatSync(instancesModule).isFile() && !lstatSync(instancesModule).isSymbolicLink(),
    "the owning helper must load the compiled production session-host module");

  const journalFile = join(root, "reader-journal.jsonl");
  const releaseFile = join(root, "release");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "Windows SystemRoot is required to build the helper environment");
  const helperEnv: NodeJS.ProcessEnv = {
    PATH: safeWindowsPath(systemRoot!),
    SystemRoot: systemRoot!,
    WINDIR: process.env.WINDIR ?? systemRoot!,
    HOME: home,
    USERPROFILE: home,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
  assertNoRoleOrCatalogMarkers(helperEnv);

  let completed = false;
  let harnessKilledHelper = false;
  let observerRef: WindowsOwnedExitObserver | undefined;
  let helperClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let helperSpawnError: Error | undefined;
  let stdoutTail = "";
  let stderrTail = "";
  const helper: ChildProcess = spawn(process.execPath, [
    READER_HELPER_FIXTURE,
    "--module", instancesModule,
    "--journal", journalFile,
    "--release", releaseFile,
    "--cwd", temporary,
  ], {
    cwd: process.cwd(),
    env: helperEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  helper.on("close", (code, signal) => { helperClose = { code, signal }; });
  helper.on("error", (error) => { helperSpawnError = error; });
  helper.stdout?.on("data", (chunk: Buffer | string) => { stdoutTail = (stdoutTail + chunk.toString()).slice(-512); });
  helper.stderr?.on("data", (chunk: Buffer | string) => { stderrTail = (stderrTail + chunk.toString()).slice(-512); });
  const abortForHelper = (): Error | undefined => helperSpawnError
    ?? (helperClose !== undefined
      ? new Error(`the owning helper exited early (${helperClose.code}/${helperClose.signal ?? "none"}); journal: ${JSON.stringify(readJournal(journalFile))}`)
      : undefined);

  t.after(async () => {
    if (completed) {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    // Failure path only: settle the retained exact-process observer first so its
    // watcher cannot keep this process alive, keep ownership of a possibly live
    // helper, preserve the witness tree, and disclose bounded tails.
    await settleObserverAfterFailure(observerRef);
    if (helperClose === undefined) {
      harnessKilledHelper = true;
      try { helper.kill(); } catch { /* failure-path cleanup of the owned helper */ }
    }
    process.stderr.write(`preserved failed Windows reader-settlement witness tree: ${root}\n`);
    process.stderr.write(`helper journal: ${JSON.stringify(readJournal(journalFile))}\n`);
    process.stderr.write(`helper stdout tail: ${stdoutTail}\nhelper stderr tail: ${stderrTail}\n`);
  });

  const started = await waitFor(() => readJournal(journalFile).find((record) => record.type === "helper_started"),
    WINDOWS_EVENT_TIMEOUT_MS, "the owning helper process to start", abortForHelper);
  assert.equal(started.platform, "win32", "the owning helper runs on the real Windows host");
  assert.equal(started.node, process.versions.node, "the owning helper runs the same Node as this harness");
  assert.ok(typeof started.pid === "number" && started.pid > 1 && started.pid !== process.pid,
    "the owning helper is a distinct real process, retained by this harness");

  const spawned = await waitFor(() => readJournal(journalFile).find((record) => record.type === "pty_spawn"),
    WINDOWS_EVENT_TIMEOUT_MS, "the public PTY handle to publish its real native pid", abortForHelper);
  const nativePid = spawned.pid;
  assert.ok(typeof nativePid === "number" && Number.isSafeInteger(nativePid) && nativePid > 1,
    "the production default factory's public PTY published a positive native pid");

  // Prebind the exact-process kernel observer while the native child is live. No
  // post-exit PID lookup, reacquisition, or `kill(pid, 0)` probe is used anywhere.
  const observer = new WindowsOwnedExitObserver({
    runtime,
    root: observerRoot,
    rootIdentity: observerIdentity,
    home,
    temporary,
    nativePid,
  });
  // Teardown-visible from the moment it exists: any later failure still settles it.
  observerRef = observer;
  const ready = await observer.waitUntilReady();
  assert.equal(ready.state, "READY", "the retained exact-process observer published READY before the deliberate quit");
  assert.equal(ready.requestNonce, observer.nonce);
  assert.equal(ready.observerPid, observer.child.pid, "READY is bound to the same public powershell.exe process handle");
  assert.equal(ready.nativePid, nativePid, "READY is bound to the exact public PTY child pid");
  assert.ok(BigInt(ready.nativeCreationTimeUtcTicks) > 0n, "READY carries the exact .NET creation ticks");
  assert.equal(readJournal(journalFile).some((record) => record.type === "pty_exit"), false,
    "no PTY exit was recorded before the deliberate quit");

  // The deliberate quit: one file the live child polls. Nothing is signaled.
  writeFileSync(releaseFile, "quit\n", "utf8");

  const witness = await observer.waitForExitedResult(60_000);
  assert.equal(witness.state, "exited", "the same retained handle reported the exit");
  assert.equal(witness.exitCode, 0, "the real native child exited zero");
  assert.equal(witness.nativePid, nativePid);
  assert.equal(witness.nativeCreationTimeUtcTicks, ready.nativeCreationTimeUtcTicks,
    "the same retained handle reports identical creation ticks in READY and the exited result");
  await observer.waitForObserverProcessClose(WINDOWS_EVENT_TIMEOUT_MS);
  observer.assertExitedSuccessfully();
  observer.dispose();

  const exitRecord = await waitFor(() => readJournal(journalFile).find((record) => record.type === "pty_exit"),
    WINDOWS_EVENT_TIMEOUT_MS, "the public PTY handle's own onExit record", abortForHelper);
  assert.equal(exitRecord.pid, nativePid, "the exit came from the same public PTY handle that published the pid");
  assert.equal(exitRecord.exitCode, 0, "the real public PTY exited with code zero");
  assert.ok(!exitRecord.signal, "the real public PTY exit carries no signal");

  // The decisive observation: this harness's own retained ChildProcess close.
  const settledAt = Date.now();
  const close = await waitFor(() => helperClose, HELPER_NATURAL_EXIT_DEADLINE_MS,
    "the owning helper process to exit naturally after the real PTY exit",
    () => helperSpawnError);
  assert.equal(harnessKilledHelper, false, "the harness never killed the owning helper");
  assert.equal(close.signal, null, "the owning helper exited without being signaled");
  assert.equal(close.code, 0, "the owning helper exited zero, on its own, once its reader settled");
  const naturalExitMs = Date.now() - settledAt;
  assert.ok(naturalExitMs < HELPER_NATURAL_EXIT_DEADLINE_MS,
    `the owning helper exited within its fixed bound (${naturalExitMs}ms) instead of hanging on a live reader`);

  // The helper wrote nothing after the exit: it has no keepalive, no post-exit
  // probe, and no self-reported survival timer.
  assert.deepEqual(readJournal(journalFile).map((record) => record.type),
    ["helper_started", "pty_spawn", "pty_exit"],
    "the owning helper recorded only its start, the public spawn, and the public exit");
  assert.equal(readJournal(journalFile).some((record) => record.type === "helper_error"), false,
    "the production spawn path reported no error");

  assertCreatedDirectoryIdentity(observerRoot);
  assert.ok(sameFileIdentity(identityOfRealDirectory(observerRoot), observerIdentity),
    "the owned observer root keeps its caller-captured identity throughout");
  completed = true;
});

test("the reader-settlement helper fixture is finite, owned, and never kills anything", () => {
  const source = readFileSync(READER_HELPER_FIXTURE, "utf8");
  assert.ok(existsSync(READER_HELPER_FIXTURE), "the owning helper fixture exists in the repository");
  assert.doesNotMatch(source, /process\.exit\(/, "the helper never forces its own exit");
  assert.doesNotMatch(source, /\.kill\(|terminate\(/, "the helper kills nothing and terminates no Worker itself");
  assert.match(source, /createDefaultPtyFactory\(\)/,
    "the helper spawns through the production default PTY factory, not an injected shim");
  assert.match(source, /CHILD_CAP_MS/, "the ConPTY child carries a fixed self-cap so the fixture stays finite");
});

test("the Windows lane's failure teardown always settles and closes the retained observer", async () => {
  // The opted-in lane hands its observer to this same helper in t.after, so the
  // ordering it depends on is exercised here on any host.
  const events: string[] = [];
  await settleObserverAfterFailure({
    retainUntilFailureTimeout: async () => {
      events.push("retain-rejected");
      throw new Error("bounded failure wait failed");
    },
    dispose: () => { events.push("dispose"); },
  });
  assert.deepEqual(events, ["retain-rejected", "dispose"],
    "a rejecting bounded failure wait still closes the observer's watcher");

  events.length = 0;
  await settleObserverAfterFailure({
    retainUntilFailureTimeout: async () => { events.push("retain"); },
    dispose: () => { events.push("dispose"); },
  });
  assert.deepEqual(events, ["retain", "dispose"], "the bounded failure wait runs before the watcher closes");

  await settleObserverAfterFailure(undefined);
  assert.deepEqual(events, ["retain", "dispose"], "no observer means nothing to settle and nothing throws");
});
