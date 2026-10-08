import assert from "node:assert/strict";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import {
  WINDOWS_EVENT_TIMEOUT_MS,
  WINDOWS_OBSERVER_TIMEOUT_SECONDS,
  WINDOWS_REQUIRE_ENV,
  WINDOWS_TEST_TIMEOUT_MS,
  WINDOWS_OUTER_COLS,
  WINDOWS_OUTER_ROWS,
  WindowsMainPtyDriver,
  WindowsOwnedExitObserver,
  assertCredentialFreeNativeRecords,
  assertCreatedDirectoryIdentity,
  assertNoSavedSessionOverrides,
  assertNoUnownedNativeSessions,
  assertWindowsRuntimeFiles,
  createNativeAgentRoot,
  createOwnedDirectory,
  createWindowsHarnessRoot,
  identityOfRealDirectory,
  isSessionShutdownFor,
  probeWindowsPowerShell,
  randomDigits,
  resolveWindowsRuntime,
  sameFileIdentity,
  type WindowsOwnedSession,
} from "./helpers/session-host-native-windows-harness";
import { frameHeader } from "./helpers/session-host-native-roster-witness";

const optIn = process.env[WINDOWS_REQUIRE_ENV] === "1";

test("real public Main exits two live Windows ConPTY native Pi sessions through confirmed Quit", {
  timeout: WINDOWS_TEST_TIMEOUT_MS,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  // Once opted in, all missing platform/runtime prerequisites are hard failures.
  assert.equal(process.env[WINDOWS_REQUIRE_ENV], "1");
  const runtime = resolveWindowsRuntime();
  assertWindowsRuntimeFiles(runtime);

  const root = createWindowsHarnessRoot();
  const rootIdentity = identityOfRealDirectory(root);
  const home = createOwnedDirectory(root, "home");
  const temporary = createOwnedDirectory(root, "tmp");
  const observerDirectory = createOwnedDirectory(root, "observer");
  const stateRoot = createOwnedDirectory(root, "native-state");
  const fixtureState = createOwnedDirectory(root, "fixture-state");
  const workspaceA = createOwnedDirectory(root, "a");
  const workspaceB = createOwnedDirectory(root, "b");
  const exitObserverRoot = createOwnedDirectory(root, "exit-observers");
  const exitObserverIdentity = identityOfRealDirectory(exitObserverRoot);
  for (const ownedDirectory of [root, home, temporary, observerDirectory, stateRoot, fixtureState,
    workspaceA, workspaceB, exitObserverRoot]) assertCreatedDirectoryIdentity(ownedDirectory);
  assert.ok(sameFileIdentity(identityOfRealDirectory(root), rootIdentity), "fresh test root has its caller-captured BigInt identity");
  probeWindowsPowerShell(runtime, home, temporary);

  const nativeAgentDir = createNativeAgentRoot(root);
  assertCreatedDirectoryIdentity(nativeAgentDir);
  const observerFile = join(observerDirectory, "native-main.jsonl");
  const providerJournal = join(fixtureState, "provider-journal.jsonl");
  const driver = WindowsMainPtyDriver.start({
    root,
    runtime,
    nativeAgentDir,
    home,
    temporary,
    stateRoot,
    fixtureState,
    workspaceA,
    workspaceB,
  });
  const observers: WindowsOwnedExitObserver[] = [];
  let completed = false;

  t.after(async () => {
    if (!completed) {
      await driver.tryGracefulQuitAfterFailure();
      if (!driver.exitEvent) driver.forceKillOuterAfterFailure();
      await Promise.all(observers.map((observer) => observer.retainUntilFailureTimeout()));
      process.stderr.write(`preserved failed Windows Main witness tree: ${root}\n`);
    } else {
      for (const observer of observers) observer.dispose();
    }
    await driver.settleSubscriptions();
  });

  await driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("New session") && frame.includes("Quit host"),
    "actual public runSessionHost renders its welcome frame inside the owned outer Windows ConPTY");
  assert.ok(typeof driver.pty.pid === "number" && Number.isSafeInteger(driver.pty.pid) && driver.pty.pid > 1,
    "the exact owned outer ConPTY exposes its positive public PID after real output, not synchronously at spawn");
  assert.ok(existsSync(nativeAgentDir), "one fresh ordinary native agent root is shared by both children");
  assert.deepEqual(driver.records(), [], "no native lifecycle record exists before Workspace-only New");

  const suffix = randomDigits(8);
  const labelA = `A-${suffix}`;
  const labelB = `B-${suffix}`;
  const draftA = `windowsDraftA${suffix}`;
  const draftB = `windowsDraftB${suffix}`;
  const args = [
    "--offline", "--no-context-files", "--no-themes", "--no-tools",
    "--extension", join(process.cwd(), "tests", "fixtures", "session-host-main-observer.cjs"),
    "--extension", join(process.cwd(), "tests", "fixtures", "session-host-native-provider.cjs"),
  ];
  assertNoSavedSessionOverrides(args);

  const sessionA = await driver.createNativeSession(workspaceA, labelA);
  assert.notEqual(frameHeader(driver.currentText()), labelA,
    "New highlights A but does not activate it; the outer header stays the welcome title");
  await driver.activate(labelA);
  await driver.writeDraft(draftA);
  const headerA = driver.currentText().split("\n")[0];

  const sessionB = await driver.createNativeSession(workspaceB, labelB, headerA);
  assert.equal(driver.currentText().split("\n")[0], headerA,
    "New highlights B while leaving A active until explicit selection");
  await driver.activate(labelB);
  await driver.writeDraft(draftB);
  assert.ok(driver.currentText().includes(draftB));
  assert.equal(driver.currentText().includes(draftA), false, "B does not inherit A's independent native input draft");
  await driver.activate(labelA);
  assert.ok(driver.currentText().includes(draftA), "A retains its own native input draft after switching back");
  assert.equal(driver.currentText().includes(draftB), false, "A does not inherit B's independent native input draft");
  await driver.activate(labelB);
  assert.ok(driver.currentText().includes(draftB), "B's independent draft survives returning from A");
  assert.equal(driver.currentText().includes(draftA), false);

  const nativeRecords = driver.records();
  const sessions: readonly WindowsOwnedSession[] = [sessionA, sessionB];
  assertNoUnownedNativeSessions(nativeRecords, sessions);
  assertCredentialFreeNativeRecords(nativeRecords);
  assert.notEqual(sessionA.record.pid, sessionB.record.pid, "A/B are different actual native process ids");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId, "A/B are distinct public Pi conversation identities");
  assert.notEqual(sessionA.record.sessionFile, sessionB.record.sessionFile, "A/B have distinct public native planned conversation paths");
  assert.equal(sessionA.record.cwd && samePathForTest(sessionA.record.cwd, realpathSync(workspaceA)), true);
  assert.equal(sessionB.record.cwd && samePathForTest(sessionB.record.cwd, realpathSync(workspaceB)), true);
  assert.equal(sessionA.record.contextCwd && samePathForTest(sessionA.record.contextCwd, realpathSync(workspaceA)), true);
  assert.equal(sessionB.record.contextCwd && samePathForTest(sessionB.record.contextCwd, realpathSync(workspaceB)), true);
  assert.equal(sessionA.record.agentDir && samePathForTest(sessionA.record.agentDir, nativeAgentDir), true);
  assert.equal(sessionB.record.agentDir && samePathForTest(sessionB.record.agentDir, nativeAgentDir), true,
    "both public native children use the same ordinary shared native agent root");
  for (const session of sessions) {
    assert.equal(session.record.tty, true, `${session.label} is a real Pi TTY process`);
    assert.equal(session.record.columns, 87, `${session.label} receives the actual 87-column pane geometry`);
    assert.equal(session.record.rows, 49, `${session.label} receives the actual 49-row pane geometry`);
    assert.ok(session.record.sessionFile && isAbsoluteNativePath(session.record.sessionFile),
      `${session.label} reports its public absolute planned native session path without requiring that it exists on disk`);
    const sessionRel = relative(nativeAgentDir, session.record.sessionFile!);
    assert.ok(sessionRel !== ".." && !sessionRel.startsWith(`..${sep}`) && !isAbsoluteNativePath(sessionRel),
      `${session.label} planned conversation path remains inside the same shared native root`);
  }
  const providerEvents = await driver.waitForProvider((records) => records.some((record) => record.event === "provider_registered"),
    "existing offline public faux-provider fixture registration");
  assert.ok(providerEvents.some((record) => record.event === "provider_registered"),
    "the existing public native provider fixture loaded without private SDK construction");
  assert.equal(providerEvents.some((record) => record.event === "model_request"), false,
    "the acceptance case made no external/model request");
  assertCredentialFreeNativeRecords(driver.records());
  await driver.assertBeforeQuitModes();

  // Prebind both exact child PIDs while their actual Main-owned public PTYs are
  // still live. Each retained PowerShell script Process handle is held from
  // READY through the exited result; no post-exit PID lookup is permitted.
  const childPtyRecords = driver.ptyRecords();
  const readyWitnesses = new Map<number, string>();
  for (const session of sessions) {
    const starts = childPtyRecords.filter((record) => record.type === "pty_spawn"
      && record.pid === session.record.pid && record.cwd && samePathForTest(record.cwd, session.workspace));
    assert.equal(starts.length, 1, `${session.label} session_start PID/cwd is cross-bound to its actual public node-pty spawn`);
    assert.equal(childPtyRecords.some((record) => record.type === "pty_exit" && record.pid === session.record.pid), false,
      `${session.label} has no exit before intentional confirmed Quit`);
    const observer = new WindowsOwnedExitObserver({
      runtime,
      root: exitObserverRoot,
      rootIdentity: exitObserverIdentity,
      home,
      temporary,
      nativePid: session.record.pid!,
    });
    observers.push(observer);
    const ready = await observer.waitUntilReady();
    assert.equal(ready.state, "READY", `${session.label} retained exact process observer published READY before Quit`);
    assert.equal(ready.requestNonce, observer.nonce);
    assert.equal(ready.observerPid, observer.child.pid, "READY is bound to the same public powershell.exe process handle");
    assert.equal(ready.nativePid, session.record.pid, "READY is bound to the exact public native PTY PID");
    assert.ok(BigInt(ready.nativeCreationTimeUtcTicks) > 0n,
      "READY carries the exact nonempty .NET process creation ticks as a decimal string");
    readyWitnesses.set(session.record.pid!, ready.nativeCreationTimeUtcTicks);
    assertCreatedDirectoryIdentity(exitObserverRoot);
    assert.ok(sameFileIdentity(identityOfRealDirectory(exitObserverRoot), exitObserverIdentity),
      "caller-owned observer root BigInt identity remains unchanged at READY");
  }

  // Genuine UI confirmation with both children still owned/live. The following
  // exit assertions deliberately reject an acknowledgement, disappearance, or
  // timeout result as a pass.
  await driver.confirmQuit();
  const shutdownRecords = await driver.waitForNative((records) => sessions.every((session) =>
    records.some((record) => isSessionShutdownFor(record, session))),
  "both public Pi session_shutdown events report the actual quit reason");
  for (const session of sessions) {
    assert.ok(shutdownRecords.some((record) => isSessionShutdownFor(record, session)),
      `${session.label} public session_shutdown identifies its exact native session and quit reason`);
  }
  const exitWitnesses = await Promise.all(observers.map((observer) => observer.waitForExitedResult()));
  await Promise.all(observers.map((observer) => observer.waitForObserverProcessClose()));
  for (const observer of observers) observer.assertExitedSuccessfully();
  for (const witness of exitWitnesses) {
    assert.equal(witness.nativeCreationTimeUtcTicks, readyWitnesses.get(witness.nativePid),
      "same retained Process handle reports identical exact creation ticks in READY and exited result");
    assert.equal(witness.state, "exited");
    assert.equal(witness.exitCode, 0);
  }
  const exits = await driver.waitForPty((records) => sessions.every((session) => records.some((record) =>
    record.type === "pty_exit" && record.pid === session.record.pid)),
  "both actual manager-owned native IPty handles report public onExit");
  for (const session of sessions) {
    const exit = exits.find((record) => record.type === "pty_exit" && record.pid === session.record.pid);
    assert.ok(exit, `${session.label} has its actual public node-pty onExit record`);
    assert.equal(exit!.exitCode, 0, `${session.label} actual public PTY exited with code zero`);
    assert.ok(!exit!.signal, `${session.label} actual public PTY exit has no signal`);
    const observer = observers.find((candidate) => candidate.nativePid === session.record.pid);
    assert.ok(observer, `${session.label} retains its exact prebound PowerShell observer`);
    assert.equal(observer!.root, exitObserverRoot);
    assertCreatedDirectoryIdentity(exitObserverRoot);
    assert.ok(sameFileIdentity(identityOfRealDirectory(exitObserverRoot), exitObserverIdentity));
  }
  const outerExit = await driver.waitForNormalExit();
  assert.equal(outerExit.exitCode, 0, "real public Main runner outer PTY exited zero");
  assert.ok(!outerExit.signal, "real public Main runner outer PTY exited without a signal");
  assert.equal(driver.forcedCleanup, false, "successful Quit required no force cleanup");
  assert.equal(driver.ptyRecords().some((record) => record.type === "pty_force_attempt"), false,
    "runner made no forced native public PTY kill attempt");
  assert.equal(lstatSync(driver.forceJournal).size, 0, "parent made no forced outer PTY kill attempt");
  assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_exit").length, 2,
    "only the two positively owned native PTY handles exited during graceful shutdown");
  assert.equal(driver.records().filter((record) => record.type === "session_shutdown").length, 2,
    "only the two owned native sessions emitted shutdown during the acceptance case");
  assert.equal((await driver.providerRecords()).some((record) => record.event === "model_request"), false,
    "offline fixture remained idle; no model/external AI request was issued");
  for (const ownedDirectory of [root, home, temporary, observerDirectory, stateRoot, fixtureState,
    workspaceA, workspaceB, exitObserverRoot, nativeAgentDir]) assertCreatedDirectoryIdentity(ownedDirectory);
  assert.ok(sameFileIdentity(identityOfRealDirectory(root), rootIdentity),
    "the successful test retains the exact caller-owned witness tree identity");
  assert.ok(WINDOWS_EVENT_TIMEOUT_MS < WINDOWS_OBSERVER_TIMEOUT_SECONDS * 1000,
    "event waits are bounded below the exact-process observer timeout");
  assert.equal(WINDOWS_OUTER_COLS, 120);
  assert.equal(WINDOWS_OUTER_ROWS, 50);
  completed = true;
});

function samePathForTest(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function isAbsoluteNativePath(path: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]|^\\\\/.test(path) : isAbsolute(path);
}
