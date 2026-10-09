import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import {
  LAUNCHER_CLEANUP_BUDGET_MS,
  LAUNCHER_BODY_DEADLINE_MS,
  LAUNCHER_EVENT_TIMEOUT_MS,
  LAUNCHER_EXPECT_PI_VERSION,
  LAUNCHER_LEG_DEADLINE_MS,
  LAUNCHER_LEGS,
  LAUNCHER_REQUIRE_ENV,
  LAUNCHER_STARTUP_TIMEOUT_MS,
  LauncherPtyDriver,
  LegDeadline,
  WindowsOwnedExitObserver,
  assertCreatedDirectoryIdentity,
  assertCredentialFreeNativeRecords,
  assertLauncherRestoration,
  assertLauncherStageEvidence,
  assertLauncherSummary,
  assertLegArithmetic,
  assertNativeRestoration,
  assertNoUnownedNativeSessions,
  assertSourceFixtureUnchanged,
  createLauncherLegLayout,
  frameWaitFailure,
  identityOfRealDirectory,
  isSessionShutdownFor,
  probeWindowsPowerShell,
  randomDigits,
  resolveLauncherRuntime,
  sameFileIdentity,
  type NativeJournalRecord,
  type WindowsOwnedSession,
} from "./helpers/session-host-native-windows-launcher";
import { frameHeader } from "./helpers/session-host-native-roster-witness";

const restorationFixtures = require("../../tests/fixtures/session-host-windows-launcher-restoration.cjs") as {
  captureLauncherBaseline(input: { stdin: unknown; stdout: unknown; env: Record<string, string | undefined> }): unknown;
  launcherRestorationSnapshot(baseline: unknown, current: { stdin: unknown; stdout: unknown; env: Record<string, string | undefined> }): Record<string, unknown>;
  nativeRestorationSnapshot(env: Record<string, string | undefined>): Record<string, unknown>;
};

const optIn = process.env[LAUNCHER_REQUIRE_ENV] === "1";

// Pure source/runtime-independent contracts. They run everywhere and pin the
// bounded CI arithmetic the alpha workflow step relies on.
test("source-launcher acceptance bounds are finite and fit the whole-file budget", () => {
  assertLegArithmetic();
  assert.equal(LAUNCHER_EXPECT_PI_VERSION, "1.1.0");
  assert.equal(LAUNCHER_LEG_DEADLINE_MS, 9 * 60_000);
  assert.ok(LAUNCHER_LEGS.length === 2,
    "both real wrapper legs (cmd and direct PowerShell) are retained; runtime coverage deferred under #334");
});

for (const leg of LAUNCHER_LEGS) {
  // TODO(https://github.com/rfairburn/pi-review-gate/issues/334): Windows sidebar
  // runtime acceptance deferred to #334 for this release. Restore by re-registering
  // as `test(...)` with the retained opt-in skip condition once #334 lands.
  test.skip(`real Windows source launcher (${leg}) stages, builds, runs a native Pi child, and restores`, {
    timeout: LAUNCHER_LEG_DEADLINE_MS,
    skip: optIn ? false : `${LAUNCHER_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
  }, async (t) => {
    // Once opted in, all missing platform/runtime prerequisites are hard failures.
    assert.equal(process.env[LAUNCHER_REQUIRE_ENV], "1");
    const runtime = resolveLauncherRuntime();
    assert.equal(runtime.version, "1.1.0", "the launcher lane pins exact Pi 1.1.0");
    assertSourceFixtureUnchanged(runtime);

    const layout = createLauncherLegLayout(leg);
    const rootIdentity = identityOfRealDirectory(layout.root);
    const exitObserverIdentity = identityOfRealDirectory(layout.exitObserverRoot);
    probeWindowsPowerShell({ powershell: runtime.powershell }, layout.home, layout.temporary);

    const nonce = randomBytes(24).toString("hex");
    const testSignal = (t as unknown as { signal?: AbortSignal }).signal;
    const deadline = new LegDeadline(LAUNCHER_BODY_DEADLINE_MS, testSignal);
    // Register disposal before start() so a throwing spawn cannot leave the
    // referenced deadline timer holding the test file open.
    t.after(() => deadline.dispose());
    const driver = LauncherPtyDriver.start({ runtime, layout, nonce, deadline });
    const observers: WindowsOwnedExitObserver[] = [];
    let completed = false;

    t.after(async () => {
      try {
        if (!completed) {
          // Bounded cleanup only: a short-lived cleanup deadline plus exact-handle
          // force, never unbounded graceful waits or post-cancellation input.
          await driver.tryGracefulQuitAfterFailure(LAUNCHER_CLEANUP_BUDGET_MS);
          if (!driver.exitEvent) driver.forceKillOuterAfterFailure();
          for (const observer of observers) {
            observer.dispose();
            // Bound failure cleanup: release the exact owned test helper child
            // rather than waiting for its independent observer timeout.
            try { observer.child.kill(); } catch { /* already exited */ }
          }
          process.stderr.write(`preserved failed Windows source-launcher witness tree: ${layout.root}\n`);
        } else {
          for (const observer of observers) observer.dispose();
        }
      } finally {
        // Subscriptions always settle, even on a cancelled or failed leg.
        await driver.settleSubscriptions();
        deadline.dispose();
      }
    });

    // The real launcher first performs its own bounded source-stage install and
    // build, so the first real Main frame legitimately takes minutes.
    await driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("New session") && frame.includes("Quit host"),
      "actual source launcher renders its welcome frame inside the owned outer Windows ConPTY",
      -1, LAUNCHER_STARTUP_TIMEOUT_MS);
    assert.ok(typeof driver.pty.pid === "number" && Number.isSafeInteger(driver.pty.pid) && driver.pty.pid > 1,
      "the exact owned outer ConPTY exposes its positive public PID after real output, not synchronously at spawn");
    assert.equal(existsSync(join(layout.nativeAgentDir, ".pi-review-gate", "build")), true,
      "the real launcher created its owned source build stage under the per-leg agent root");
    assert.deepEqual(driver.records(), [], "no native lifecycle record exists before Workspace-only New");

    const entryRecords = await driver.waitForPty((entries) => entries.some((entry) => entry.type === "launcher_entry"),
      "the preload positively identified the actual source launcher entry");
    const entry = entryRecords.find((record) => record.type === "launcher_entry");
    assert.equal(entry?.entry, realpathSync(join(runtime.sourceRoot, "scripts", "pi-review-sessions.cjs")),
      "the preload was active only in the exact source launcher entry, never in npm/tsc/version-probe Node");

    const suffix = randomDigits(8);
    const labelA = `A-${suffix}`;
    const labelB = `B-${suffix}`;
    const draftA = `launcherDraftA${suffix}`;
    const draftB = `launcherDraftB${suffix}`;

    const sessionA = await driver.createNativeSession(layout.workspaceA, labelA);
    assert.notEqual(frameHeader(driver.currentText()), labelA,
      "New highlights A but does not activate it; the outer header stays the welcome title");
    await driver.activate(labelA);
    await driver.writeDraft(draftA);
    const headerA = driver.currentText().split("\n")[0];

    const sessionB = await driver.createNativeSession(layout.workspaceB, labelB, headerA);
    assert.equal(driver.currentText().split("\n")[0], headerA,
      "New highlights B while leaving A active until explicit selection");
    await driver.activate(labelB);
    await driver.writeDraft(draftB);
    assert.ok(driver.currentText().includes(draftB));
    assert.equal(driver.currentText().includes(draftA), false, "B does not inherit A's independent native input draft");
    await driver.activate(labelA);
    assert.ok(driver.currentText().includes(draftA), "A retains its own native input draft after switching back");
    assert.equal(driver.currentText().includes(draftB), false);
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
    assert.equal(sessionA.record.cwd && samePathForTest(sessionA.record.cwd, realpathSync(layout.workspaceA)), true);
    assert.equal(sessionB.record.cwd && samePathForTest(sessionB.record.cwd, realpathSync(layout.workspaceB)), true);
    assert.equal(sessionA.record.contextCwd && samePathForTest(sessionA.record.contextCwd, realpathSync(layout.workspaceA)), true);
    assert.equal(sessionB.record.contextCwd && samePathForTest(sessionB.record.contextCwd, realpathSync(layout.workspaceB)), true);
    assert.equal(sessionA.record.agentDir && samePathForTest(sessionA.record.agentDir, layout.nativeAgentDir), true);
    assert.equal(sessionB.record.agentDir && samePathForTest(sessionB.record.agentDir, layout.nativeAgentDir), true,
      "both public native children use the same ordinary per-leg shared native agent root");
    for (const session of sessions) {
      assert.equal(session.record.tty, true, `${session.label} is a real Pi TTY process`);
      assert.equal(session.record.columns, 87, `${session.label} receives the actual 87-column pane geometry`);
      assert.equal(session.record.rows, 49, `${session.label} receives the actual 49-row pane geometry`);
      assert.ok(session.record.sessionFile && isAbsoluteNativePath(session.record.sessionFile),
        `${session.label} reports its public absolute planned native session path`);
      const sessionRel = relative(layout.nativeAgentDir, session.record.sessionFile!);
      assert.ok(sessionRel !== ".." && !sessionRel.startsWith(`..${sep}`) && !isAbsoluteNativePath(sessionRel),
        `${session.label} planned conversation path remains inside the per-leg shared native root`);
    }
    const providerEvents = await driver.waitForProvider((records) => records.some((record) => record.event === "provider_registered"),
      "existing offline public faux-provider fixture registration");
    assert.ok(providerEvents.some((record) => record.event === "provider_registered"),
      "the existing public native provider fixture loaded without private SDK construction");
    assert.equal(providerEvents.some((record) => record.event === "model_request"), false,
      "the acceptance case made no external/model request");
    assertCredentialFreeNativeRecords(driver.records());

    // The preload's bounded native-child markers prove the production bootstrap
    // restore ran, consumed its sidecar, and kept the exact caller env/values.
    const nativePreloads = driver.ptyRecords().filter((record) => record.type === "native_preload");
    assert.equal(nativePreloads.length, 2, "exactly the two owned native children loaded the restored preload");
    for (const session of sessions) {
      assertNativeRestoration(driver.ptyRecords(), session.record.pid!);
      assert.ok(nativePreloads.some((record) => record.pid === session.record.pid),
        "each native-child preload marker is cross-bound to an actual native session PID");
    }
    await driver.assertBeforeQuitModes();

    // Prebind both exact child PIDs while their actual Main-owned public PTYs
    // are still live. Each retained PowerShell script Process handle is held
    // from READY through the exited result; no post-exit PID lookup is allowed.
    const childPtyRecords = driver.ptyRecords();
    const readyWitnesses = new Map<number, string>();
    for (const session of sessions) {
      const starts = childPtyRecords.filter((record) => record.type === "pty_spawn"
        && record.pid === session.record.pid && record.cwd && samePathForTest(record.cwd, session.workspace));
      assert.equal(starts.length, 1, `${session.label} session_start PID/cwd is cross-bound to its actual public node-pty spawn`);
      assert.equal(childPtyRecords.some((record) => record.type === "pty_exit" && record.pid === session.record.pid), false,
        `${session.label} has no exit before intentional confirmed Quit`);
      // No observer is created after the leg is cancelled.
      driver.deadline.assertOpen("exit observer creation");
      const observer = new WindowsOwnedExitObserver({
        runtime: { powershell: runtime.powershell },
        root: layout.exitObserverRoot,
        rootIdentity: exitObserverIdentity,
        home: layout.home,
        temporary: layout.temporary,
        nativePid: session.record.pid!,
      });
      observers.push(observer);
      const ready = await driver.deadline.guard("exit observer READY", observer.waitUntilReady());
      assert.equal(ready.state, "READY", `${session.label} retained exact process observer published READY before Quit`);
      assert.equal(ready.requestNonce, observer.nonce);
      assert.equal(ready.observerPid, observer.child.pid, "READY is bound to the same public powershell.exe process handle");
      assert.equal(ready.nativePid, session.record.pid, "READY is bound to the exact public native PTY PID");
      assert.ok(BigInt(ready.nativeCreationTimeUtcTicks) > 0n,
        "READY carries the exact nonempty .NET process creation ticks as a decimal string");
      readyWitnesses.set(session.record.pid!, ready.nativeCreationTimeUtcTicks);
      assertCreatedDirectoryIdentity(layout.exitObserverRoot);
      assert.ok(sameFileIdentity(identityOfRealDirectory(layout.exitObserverRoot), exitObserverIdentity),
        "caller-owned observer root BigInt identity remains unchanged at READY");
    }

    await driver.confirmQuit();
    const shutdownRecords = await driver.waitForNative((records) => sessions.every((session) =>
      records.some((record) => isSessionShutdownFor(record, session))),
    "both public Pi session_shutdown events report the actual quit reason");
    for (const session of sessions) {
      assert.ok(shutdownRecords.some((record) => isSessionShutdownFor(record, session)),
        `${session.label} public session_shutdown identifies its exact native session and quit reason`);
    }
    const exitWitnesses = await Promise.all(observers.map((observer) => driver.deadline.guard("exit observer result", observer.waitForExitedResult())));
    await Promise.all(observers.map((observer) => driver.deadline.guard("exit observer close", observer.waitForObserverProcessClose())));
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
    }
    const outerExit = await driver.waitForNormalExit();
    assert.equal(outerExit.exitCode, 0, "real source launcher outer PTY exited zero");
    assert.ok(!outerExit.signal, "real source launcher outer PTY exited without a signal");
    assert.equal(driver.forcedCleanup, false, "successful Quit required no force cleanup");
    assert.equal(driver.ptyRecords().some((record) => record.type === "pty_force_attempt"), false,
      "the launcher made no forced native public PTY kill attempt");
    assert.equal(lstatSync(driver.forceJournal).size, 0, "the parent made no forced outer PTY kill attempt");
    assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_exit").length, 2,
      "only the two positively owned native PTY handles exited during graceful shutdown");
    assert.equal(driver.records().filter((record) => record.type === "session_shutdown").length, 2,
      "only the two owned native sessions emitted shutdown during the acceptance case");
    assert.equal((await driver.providerRecords()).some((record) => record.event === "model_request"), false,
      "offline fixture remained idle; no model/external AI request was issued");

    // The actual launcher process (which is the compiled Main's own process)
    // returned zero with no force and no unresolved/unexited owned handle.
    const summary = await driver.waitForLauncherSummary();
    assertLauncherSummary(summary);
    assertLauncherRestoration(driver.ptyRecords());

    // The real launcher built and installed into its own retained stage only;
    // the fresh complete source fixture stays a source fixture.
    const stageEvidence = assertLauncherStageEvidence(runtime, layout);
    assertSourceFixtureUnchanged(runtime);
    const moduleRecord = driver.ptyRecords().find((record) => record.type === "pty_module");
    assert.equal(moduleRecord?.parent, realpathSync(join(stageEvidence.stage, "dist", "src", "session-host", "instances.js")),
      "the observed public spawn anchor is the staged production instances.js");
    const observedModule = typeof moduleRecord?.modulePath === "string" ? moduleRecord.modulePath : undefined;
    assert.ok(observedModule !== undefined
      && observedModule.toLocaleLowerCase("en-US").startsWith(stageEvidence.ptyModulePath.toLocaleLowerCase("en-US")),
    "the staged production module resolved the exact installed public @lydell/node-pty under the retained stage");
    assert.ok(sameFileIdentity(identityOfRealDirectory(layout.root), rootIdentity),
      "the successful leg retains the exact caller-owned witness tree identity");
    completed = true;
  });
}

function samePathForTest(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function isAbsoluteNativePath(path: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]|^\\\\/.test(path) : isAbsolute(path);
}

// Pure synthetic contracts that run everywhere: restoration witnesses, the
// enforced leg deadline, and transcript-free diagnostics.
test("launcher restoration witnesses reject corrupted options, unrestored raw mode, and provider drift", () => {
  const stdin = { isRaw: false };
  const stdout = {};
  const env: Record<string, string | undefined> = {
    NODE_OPTIONS: '--require="/preload.cjs"',
    PRG_SESSION_HOST_LAUNCHER_EXPECT_NODE_OPTIONS: '--require="/preload.cjs"',
    PI_PROVIDER_TEST_KEY: "synthetic-provider-value",
    PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_VALUE: "synthetic-provider-value",
  };
  const baseline = restorationFixtures.captureLauncherBaseline({ stdin, stdout, env });

  const exact = restorationFixtures.launcherRestorationSnapshot(baseline, { stdin, stdout, env });
  assert.equal(exact.sameStdin, true);
  assert.equal(exact.sameStdout, true);
  assert.equal(exact.rawRestored, true);
  assert.equal(exact.nodeOptionsExact, true);
  assert.equal(exact.providerExact, true);

  const corrupted = restorationFixtures.launcherRestorationSnapshot(baseline,
    { stdin, stdout, env: { ...env, NODE_OPTIONS: '--require="/corrupted.cjs"' } });
  assert.equal(corrupted.nodeOptionsExact, false, "corrupted NODE_OPTIONS must fail the restoration witness");

  const drifted = restorationFixtures.launcherRestorationSnapshot(baseline,
    { stdin, stdout, env: { ...env, PI_PROVIDER_TEST_KEY: "drifted" } });
  assert.equal(drifted.providerExact, false, "provider drift must fail the restoration witness");

  const rawLeft = restorationFixtures.launcherRestorationSnapshot(baseline,
    { stdin: { isRaw: true }, stdout, env });
  assert.equal(rawLeft.rawRestored, false, "unrestored raw mode must fail the restoration witness");
  assert.equal(rawLeft.sameStdin, false, "a replaced stdin must fail the restoration witness");

  const native = restorationFixtures.nativeRestorationSnapshot(env);
  assert.equal(native.bootstrapPresent, false);
  assert.equal(native.restoreSidecarPresent, false);
  assert.equal(native.nodeOptionsExact, true);
  assert.equal(native.providerExact, true);
  const nativeCorrupt = restorationFixtures.nativeRestorationSnapshot({
    ...env,
    NODE_OPTIONS: '--require="/preload.cjs" --inspect',
  });
  assert.equal(nativeCorrupt.nodeOptionsExact, false, "a native child with mutated NODE_OPTIONS must fail closed");
});

test("leg deadline blocks further input and observer creation after cancellation", async () => {
  const deadline = new LegDeadline(20);
  const inputs: string[] = [];
  const observers: string[] = [];
  const write = (value: string): void => { deadline.assertOpen("input"); inputs.push(value); };
  const createObserver = (id: string): void => { deadline.assertOpen("observer creation"); observers.push(id); };
  write("before");
  createObserver("before");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.throws(() => write("after"), /refusing further input/);
  assert.throws(() => createObserver("after"), /refusing further observer creation/);
  assert.deepEqual(inputs, ["before"], "no input is sent after the deadline");
  assert.deepEqual(observers, ["before"], "no observer is created after the deadline");
  deadline.dispose();

  const controller = new AbortController();
  const linked = new LegDeadline(10_000, controller.signal);
  controller.abort();
  assert.throws(() => linked.assertOpen("input"), /refusing further input/);
  linked.dispose();
});

test("leg deadline cancels a pending guarded wait", async () => {
  const deadline = new LegDeadline(20);
  const pending = new Promise<string>(() => { /* never settles */ });
  await assert.rejects(deadline.guard("wait", pending), /refusing further wait/);
  deadline.dispose();
});

test("launcher frame-wait diagnostics never include terminal content", () => {
  const sensitive = "PRIVATE-DRAFT-session-host-launcher-secret";
  const error = frameWaitFailure("welcome frame", {
    frameRevision: 3,
    after: -1,
    exitObserved: false,
    aborted: false,
  }, sensitive);
  assert.match(error.message, /welcome frame/);
  assert.match(error.message, /revision=3/);
  assert.doesNotMatch(error.message, new RegExp(sensitive), "terminal content must never reach the diagnostic");
  assert.doesNotMatch(error.message, /SESSION_HOST_LAUNCHER|--require|preload|draft/i);
});
