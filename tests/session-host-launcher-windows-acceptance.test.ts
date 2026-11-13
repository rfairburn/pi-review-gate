import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import { SidebarController } from "../src/session-host/sidebar";
import { stripGeneratedSgr } from "../src/session-host/terminal-surface";

import {
  LAUNCHER_CLEANUP_BUDGET_MS,
  LAUNCHER_BODY_DEADLINE_MS,
  LAUNCHER_EVENT_TIMEOUT_MS,
  LAUNCHER_EXPECT_PI_VERSION,
  LAUNCHER_EXIT_OBSERVATION_BUDGET_MS,
  LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS,
  LAUNCHER_LEG_DEADLINE_MS,
  LAUNCHER_LEGS,
  LAUNCHER_OUTER_COLS,
  LAUNCHER_OUTER_ROWS,
  LAUNCHER_READER_SETTLEMENT_BUDGET_MS,
  LAUNCHER_REQUIRE_ENV,
  LAUNCHER_STARTUP_TIMEOUT_MS,
  LAUNCHER_TEST_TIMEOUT_MS,
  LauncherCleanupBudget,
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
  launcherOwnerDraftFrame,
  probeWindowsPowerShell,
  randomDigits,
  resolveLauncherRuntime,
  sameFileIdentity,
  settleOwnedConptyReader,
  type NativeJournalRecord,
  type WindowsOwnedSession,
} from "./helpers/session-host-native-windows-launcher";
import { frameHeader, frameHeaderMatches, SIDEBAR_COLUMNS } from "./helpers/session-host-native-roster-witness";
import { WINDOWS_NATIVE_COLS, isWindowsMainOwnerFrame } from "./helpers/session-host-native-windows-harness";

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
  assert.equal(LAUNCHER_EXPECT_PI_VERSION, "1.5.2");
  assert.equal(LAUNCHER_LEG_DEADLINE_MS, 9 * 60_000);
  assert.ok(LAUNCHER_LEGS.length === 2,
    "both real wrapper legs (cmd and direct PowerShell) stay registered as real Windows host proof");
});

for (const leg of LAUNCHER_LEGS) {
  // Real Windows host proof, registered normally with the retained opt-in skip
  // condition: without the opt-in env the leg reports the skip as not being
  // Windows host proof, and once opted in every missing platform, pinned-runtime,
  // source-fixture, or Python prerequisite is a hard failure, never a skip.
  test(`real Windows source launcher (${leg}) stages, builds, runs a native Pi child, and restores`, {
    timeout: LAUNCHER_LEG_DEADLINE_MS,
    skip: optIn ? false : `${LAUNCHER_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
  }, async (t) => {
    // Once opted in, all missing platform/runtime prerequisites are hard failures.
    assert.equal(process.env[LAUNCHER_REQUIRE_ENV], "1");
    const runtime = resolveLauncherRuntime();
    assert.equal(runtime.version, "1.5.2", "the launcher lane pins exact Pi 1.5.2");
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
      // One elapsed cleanup window covers every failure step below: the graceful
      // attempt, the exact force-to-onExit observation, and the owned ConPTY
      // reader settlement. Each is capped by its reserved slice AND by what this
      // window still allows, so the whole sequence stays inside the ORIGINAL
      // cleanup budget, and no step — including the reader settlement — can wait
      // indefinitely.
      driver.beginFailureCleanup();
      try {
        if (!completed) {
          // Bounded cleanup only: one short-lived graceful attempt, then the
          // exact-handle force, then one finite input-free observation of the exact
          // owned outer PTY's real public onExit. Never an unbounded graceful wait,
          // never input after the budget, and never a reader close over an
          // unconfirmed transport.
          await driver.tryGracefulQuitAfterFailure();
          if (!driver.exitEvent) driver.forceKillOuterAfterFailure();
          const outerExitObserved = await driver.observeOuterExitAfterForce();
          for (const observer of observers) {
            observer.dispose();
            // Bound failure cleanup: release the exact owned test helper child
            // rather than waiting for its independent observer timeout.
            try { observer.child.kill(); } catch { /* already exited */ }
          }
          if (!outerExitObserved) {
            // The actual outer exit is never assumed: the owned ConPTY reader is
            // left untouched and the retained witness tree reports the uncertainty.
            process.stderr.write("unconfirmed Windows source-launcher outer exit: reader left open, evidence retained\n");
          }
          process.stderr.write(`preserved failed Windows source-launcher witness tree: ${layout.root}\n`);
        } else {
          for (const observer of observers) observer.dispose();
        }
      } finally {
        // Subscriptions always settle, even on a cancelled or failed leg. The owned
        // ConPTY reader closes only behind a positively observed outer exit, and
        // only within what the same cleanup window still allows.
        const readerSettlement = await driver.settleSubscriptions();
        deadline.dispose();
        if (readerSettlement !== "closed") {
          // Cleanup uncertainty is reported; it never rewrites the leg's own result.
          process.stderr.write(`uncertain Windows source-launcher ConPTY reader settlement (${readerSettlement}): evidence retained, result unchanged\n`);
        }
      }
    });

    // The real launcher first performs its own bounded source-stage install and
    // build, so the first real Main frame legitimately takes minutes.
    await driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("New session") && frame.includes("Quit host"),
      "actual source launcher renders its welcome frame inside the owned outer Windows ConPTY",
      -1, LAUNCHER_STARTUP_TIMEOUT_MS);
    assert.ok(typeof driver.pty.pid === "number" && Number.isSafeInteger(driver.pty.pid) && driver.pty.pid > 1,
      "the exact owned outer ConPTY exposes its positive public PID after real output, not synchronously at spawn");
    assert.equal(driver.outerUseConptyDll, true,
      "the outer launcher transport requests bundled ConPTY through the public spawn option, without independently attesting backend activation");
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
    assert.equal(frameHeaderMatches(driver.currentText(), labelA), true,
      "the completed New activated A as the Main input owner, and the active-owner rename moved the header to A's new caption");
    // The first activation has no draft yet, so the shared witness requires the
    // complete fresh owner frame with the width-correct bordered EMPTY editor.
    await driver.activate(labelA, "");
    await driver.writeDraft(labelA, draftA);

    const sessionB = await driver.createNativeSession(layout.workspaceB, labelB);
    assert.notEqual(frameHeader(driver.currentText()), labelA,
      "the second completed New transfers Main input ownership from A to B instead of leaving A's stale active header");
    assert.equal(frameHeaderMatches(driver.currentText(), labelB), true,
      "B's own freshly observed canonical caption is the active outer header after the ownership transition");
    await driver.activate(labelB, "");
    await driver.writeDraft(labelB, draftB);
    assert.ok(driver.currentText().includes(draftB));
    assert.equal(driver.currentText().includes(draftA), false, "B does not inherit A's independent native input draft");
    // Each switch back is admitted only by that child's own complete fresh owner
    // frame carrying exactly its bordered draft, so a header that moved before the
    // native pane repainted can never satisfy it.
    await driver.activate(labelA, draftA);
    assert.ok(driver.currentText().includes(draftA), "A retains its own native input draft after switching back");
    assert.equal(driver.currentText().includes(draftB), false);
    await driver.activate(labelB, draftB);
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
      assert.equal(starts[0]!.conptyDll, true,
        `${session.label} original inner public spawn journal records the bundled-ConPTY option request before any behavior comparison`);
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

// Focused negative control for the corrected launcher observation. A completed
// New transfers Main input ownership to the created child, so the lane admits
// only that child's own complete owner frame: the empty welcome surface the
// stale lane accepted, a sidebar-focused footer, a partial native border, and a
// header that never followed the active-owner rename are all refused.
test("launcher New ownership witness rejects the welcome header, a stale footer, and a partial native border", () => {
  const controller = new SidebarController({ toggleKey: "f8" });
  const owner = "(no messages)";
  assert.equal(LAUNCHER_OUTER_COLS - SIDEBAR_COLUMNS - 1, WINDOWS_NATIVE_COLS,
    "the composed launcher frame keeps the same wide native pane width the shared owner witness reads");
  controller.updateItems([{
    id: "launcher-new-owner", label: owner, workspace: "/owned/windows-launcher-new", agentDir: "/owned/agent",
    lifecycle: "alive", hasLiveProcess: true, busy: false, pendingInput: false, inputSurface: false,
    backgroundTasks: 0, backgroundShells: 0, activity: [],
  }]);
  controller.select("launcher-new-owner");
  const sidebarFocused = controller.renderRoster(SIDEBAR_COLUMNS, LAUNCHER_OUTER_ROWS - 1).lines.map(stripGeneratedSgr);
  // The completed New activates the created child without a second host-row Enter.
  controller.handleInput("\r");
  const mainFocused = controller.renderRoster(SIDEBAR_COLUMNS, LAUNCHER_OUTER_ROWS - 1).lines.map(stripGeneratedSgr);
  const rule = "\u2500".repeat(WINDOWS_NATIVE_COLS);
  const nativeRows = (top: string, content: string, closing: string): string[] => {
    const rows = Array.from({ length: LAUNCHER_OUTER_ROWS - 1 }, () => "");
    rows[20] = top;
    rows[21] = content;
    rows[22] = closing;
    return rows;
  };
  const compose = (header: string, sidebar: readonly string[], main: readonly string[]): string =>
    [header, ...sidebar.map((line, index) => `${line.padEnd(SIDEBAR_COLUMNS)}\u2502${main[index] ?? ""}`)].join("\n");
  const emptyEditor = nativeRows(rule, "> ", rule);
  assert.equal(isWindowsMainOwnerFrame(compose(owner, mainFocused, emptyEditor), owner), true,
    "the observed owner header, single highlight, complete Main-focused roster, and width-correct bordered empty native editor are a genuine automatic-New ownership witness");
  assert.equal(isWindowsMainOwnerFrame(compose("Welcome \u2014 select a session", mainFocused, emptyEditor), owner), false,
    "the pre-New empty welcome surface never proves the created child owns Main");
  assert.equal(isWindowsMainOwnerFrame(compose(owner, sidebarFocused, emptyEditor), owner), false,
    "a stale sidebar-focused footer never proves Main input ownership");
  assert.equal(isWindowsMainOwnerFrame(compose(owner, mainFocused, nativeRows(rule, "> ", "")), owner), false,
    "a partial native border that never drew its closing rule never proves ownership");
  assert.equal(isWindowsMainOwnerFrame(compose("A-stale-owner", mainFocused, emptyEditor), owner), false,
    "a header that never followed the active-owner rename never proves the renamed child owns Main");
});

// Focused negative controls for the corrected launcher activation and draft
// waits. The outer header repaints before the native pane, so the lane admits
// only the complete fresh owner frame with exactly that child's bordered editor:
// a freshly moved header over the previous owner's draft, over an empty or
// mid-repaint pane, or beside an appended, altered, partial, or wrong-width
// editor is refused, and so is a stale sidebar-focused footer.
test("launcher owner draft witness rejects a fresh header over a stale native pane and altered drafts", () => {
  const controller = new SidebarController({ toggleKey: "f8" });
  const owner = "(no messages)";
  const draft = "launcherDraftA";
  const otherDraft = "launcherDraftB";
  controller.updateItems([{
    id: "launcher-owner-draft", label: owner, workspace: "/owned/windows-launcher-draft", agentDir: "/owned/agent",
    lifecycle: "alive", hasLiveProcess: true, busy: false, pendingInput: false, inputSurface: false,
    backgroundTasks: 0, backgroundShells: 0, activity: [],
  }]);
  controller.select("launcher-owner-draft");
  const sidebarFocused = controller.renderRoster(SIDEBAR_COLUMNS, LAUNCHER_OUTER_ROWS - 1).lines.map(stripGeneratedSgr);
  controller.handleInput("\r");
  const mainFocused = controller.renderRoster(SIDEBAR_COLUMNS, LAUNCHER_OUTER_ROWS - 1).lines.map(stripGeneratedSgr);
  const rule = "\u2500".repeat(WINDOWS_NATIVE_COLS);
  const nativeRows = (top: string, content: string, closing: string): string[] => {
    const rows = Array.from({ length: LAUNCHER_OUTER_ROWS - 1 }, () => "");
    rows[20] = top;
    rows[21] = content;
    rows[22] = closing;
    return rows;
  };
  const compose = (header: string, sidebar: readonly string[], main: readonly string[]): string =>
    [header, ...sidebar.map((line, index) => `${line.padEnd(SIDEBAR_COLUMNS)}\u2502${main[index] ?? ""}`)].join("\n");
  const exactDraftPane = nativeRows(rule, `> ${draft}`, rule);
  const ownerFrame = compose(owner, mainFocused, exactDraftPane);
  assert.equal(launcherOwnerDraftFrame(ownerFrame, owner, draft), true,
    "the observed owner header, single highlight, complete Main-focused roster, and width-correct bordered editor holding exactly this draft are a genuine activation witness");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, `> ${otherDraft}`, rule)), owner, draft), false,
    "a freshly moved header over the native pane's previous draft never proves the switched-to child owns Main with its own draft");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, "> ", rule)), owner, draft), false,
    "a freshly moved header over a still-empty native editor never proves the draft repainted");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, "> ", "")), owner, draft), false,
    "a freshly moved header over a mid-repaint partial native border never proves the draft repainted");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, `> ${draft}qQ`, rule)), owner, draft), false,
    "an appended draft is rejected");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, `> x-${draft}`, rule)), owner, draft), false,
    "an altered draft is rejected");
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows("\u2500".repeat(52), `> ${draft}`, "\u2500".repeat(52))), owner, draft), false,
    "a wrong-width native border never proves the draft repainted");
  assert.equal(launcherOwnerDraftFrame(compose(owner, sidebarFocused, exactDraftPane), owner, draft), false,
    "a stale sidebar-focused footer never proves Main input ownership for the draft witness");
  assert.equal(launcherOwnerDraftFrame(`${owner}\n${exactDraftPane.join("\n")}`, owner, draft), false,
    "a draft without the complete owner roster is rejected");
  assert.equal(launcherOwnerDraftFrame(compose("A-stale-owner", mainFocused, exactDraftPane), owner, draft), false,
    "a header that never followed the switched-to child never proves that child owns Main");

  // The first activation of a freshly created child has no draft yet, so the
  // same shared witness requires the width-correct bordered EMPTY editor under
  // the complete owner surface, and refuses a pane that already carries text.
  assert.equal(launcherOwnerDraftFrame(compose(owner, mainFocused, nativeRows(rule, "> ", rule)), owner, ""), true,
    "the complete owner frame with a width-correct bordered empty native editor proves a first activation");
  assert.equal(launcherOwnerDraftFrame(ownerFrame, owner, ""), false,
    "an expected first activation is never satisfied by a pane that already holds a draft");
  assert.equal(launcherOwnerDraftFrame(compose(owner, sidebarFocused, nativeRows(rule, "> ", rule)), owner, ""), false,
    "a stale sidebar-focused footer never proves a first activation");
});

// Bounded, transcript-free launcher frame-wait diagnostics: the outer exit the
// exact owned handle reported, plus presence-only witnesses and the fixed fields
// of a summary the preload already journaled. Terminal content, drafts, paths,
// arguments, and environment values never reach the message.
test("launcher frame-wait diagnostics carry bounded exit and journal evidence, never terminal content", () => {
  const sensitive = "PRIVATE-LAUNCHER-session-host-secret";
  const error = frameWaitFailure("welcome frame", {
    frameRevision: 8,
    after: -1,
    exitObserved: true,
    aborted: false,
    outerExitCode: 1,
    outerExitSignal: 0,
    launcherEntry: false,
    ptyModule: false,
    launcherSummary: true,
    summaryExitCode: 1,
    summaryForceAttempted: false,
    summaryJournalFailed: false,
    summaryUnresolvedSpawns: 0,
    summaryUnexitedSpawns: 1,
  }, sensitive);
  assert.match(error.message, /welcome frame/);
  assert.match(error.message, /revision=8/);
  assert.match(error.message, /exit=true/);
  assert.match(error.message, /outerExitCode=1/);
  assert.match(error.message, /outerExitSignal=0/);
  assert.match(error.message, /entry=no/, "a missing launcher-entry record is explicit evidence, not a guess");
  assert.match(error.message, /module=no/);
  assert.match(error.message, /summary=yes/);
  assert.match(error.message, /summaryForce=no/);
  assert.match(error.message, /summaryUnexited=1/);
  assert.doesNotMatch(error.message, new RegExp(sensitive), "terminal content must never reach the diagnostic");
  assert.doesNotMatch(error.message, /SESSION_HOST_LAUNCHER|--require|preload|draft|C:\\|\//i);

  // An unreadable journal leaves those witnesses out entirely instead of
  // reporting them as absent, and no exit fields appear before an actual exit.
  const minimal = frameWaitFailure("welcome frame", {
    frameRevision: 3,
    after: -1,
    exitObserved: false,
    aborted: true,
  }, sensitive);
  assert.match(minimal.message, /revision=3/);
  assert.match(minimal.message, /exit=false/);
  assert.doesNotMatch(minimal.message, /outerExitCode=|entry=|module=|summary=/);
  assert.doesNotMatch(minimal.message, new RegExp(sensitive));
});

test("launcher failure cleanup reserves every step inside the original budget", () => {
  assert.equal(LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS + LAUNCHER_EXIT_OBSERVATION_BUDGET_MS + LAUNCHER_READER_SETTLEMENT_BUDGET_MS, LAUNCHER_CLEANUP_BUDGET_MS,
    "the exit observation and the reader settlement are reserved from the SAME cleanup budget: no new grace beyond the leg and file caps");
  assert.ok(LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS > 0 && LAUNCHER_EXIT_OBSERVATION_BUDGET_MS > 0 && LAUNCHER_READER_SETTLEMENT_BUDGET_MS > 0,
    "every failure-cleanup slice stays finite");
  assert.ok(LAUNCHER_LEG_DEADLINE_MS + LAUNCHER_CLEANUP_BUDGET_MS <= LAUNCHER_TEST_TIMEOUT_MS,
    "the original per-leg plus cleanup budget still fits the unchanged whole-file budget");
});

test("launcher failure cleanup charges every step against one elapsed deadline", async () => {
  // The real window is larger than every reserved slice, so a fresh window grants
  // each step its whole slice and never more than the whole budget.
  const full = new LauncherCleanupBudget(LAUNCHER_CLEANUP_BUDGET_MS);
  assert.equal(full.remaining(LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS), LAUNCHER_GRACEFUL_CLEANUP_BUDGET_MS);
  assert.equal(full.remaining(LAUNCHER_EXIT_OBSERVATION_BUDGET_MS), LAUNCHER_EXIT_OBSERVATION_BUDGET_MS);
  assert.equal(full.remaining(LAUNCHER_READER_SETTLEMENT_BUDGET_MS), LAUNCHER_READER_SETTLEMENT_BUDGET_MS);
  assert.ok(full.remaining(LAUNCHER_CLEANUP_BUDGET_MS * 10) <= LAUNCHER_CLEANUP_BUDGET_MS,
    "no step is ever granted more than the whole cleanup budget");

  // A short window proves that the SAME deadline charges elapsed time to every
  // later step and then grants nothing further to any of them.
  const short = new LauncherCleanupBudget(60);
  assert.ok(short.remaining(10_000) <= 60 && short.remaining(10_000) > 0,
    "a step is capped by the window as well as by its own slice");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const mid = short.remaining(10_000);
  assert.ok(mid < 60 && mid > 0, `elapsed time is charged to the same window (${Math.round(mid)}ms left)`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(short.expired, "the window expires on its absolute deadline");
  assert.equal(short.remaining(10_000), 0,
    "an expired window grants no further time to any step, including the reader settlement");
  assert.equal(short.remaining(LAUNCHER_READER_SETTLEMENT_BUDGET_MS), 0);
});

test("launcher ConPTY reader settlement is bounded and keeps the observed-outer-exit guard", async () => {
  let closeInvocations = 0;
  const recordClose = async (): Promise<void> => {
    closeInvocations += 1;
  };
  assert.equal(await settleOwnedConptyReader(false, 1_000, recordClose), "skipped",
    "an unconfirmed outer exit never touches the owned reader");
  assert.equal(closeInvocations, 0, "the observed-outer-exit guard is never relaxed");

  assert.equal(await settleOwnedConptyReader(true, 1_000, recordClose), "closed");
  assert.equal(closeInvocations, 1, "a prompt settlement is reported as closed");

  // The shared cleanup window reports fractional milliseconds, so a leftover below
  // a step's cap is still real time and must be observed, never abandoned.
  assert.equal(await settleOwnedConptyReader(true, 1_000.5, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }), "closed", "fractional remaining milliseconds still allow reader settlement");

  // A fractional budget is actually waited on instead of returning uncertain at
  // once because the duration is not an integer.
  let startedAt = performance.now();
  assert.equal(await settleOwnedConptyReader(true, 20.5, () => new Promise<void>(() => { /* never settles */ })), "uncertain",
    "a fractional budget with a never-settling cleanup is reported uncertain only after waiting");
  let waited = performance.now() - startedAt;
  assert.ok(waited >= 15 && waited < 2_000, `a fractional budget is waited on (${Math.round(waited)}ms)`);

  // A non-finite duration is no time available at all.
  startedAt = performance.now();
  assert.equal(await settleOwnedConptyReader(true, Number.POSITIVE_INFINITY, () => new Promise<void>(() => { /* never settles */ })), "uncertain");
  assert.ok(performance.now() - startedAt < 200, "a non-finite remaining budget never waits");

  // Integration shape: the exact kind of value the shared window hands to a step
  // is a finite (usually fractional) leftover duration, and that value must still
  // be observed rather than abandoned.
  const leftover = new LauncherCleanupBudget(1_000).remaining(LAUNCHER_READER_SETTLEMENT_BUDGET_MS);
  assert.ok(Number.isFinite(leftover) && leftover > 0 && leftover <= LAUNCHER_READER_SETTLEMENT_BUDGET_MS,
    "the shared window hands a step a finite positive leftover duration");
  assert.equal(await settleOwnedConptyReader(true, leftover, recordClose), "closed",
    "a settlement given the shared window's leftover duration is still observed");

  // A never-settling cleanup returns at its own budget instead of holding the
  // failure hook open indefinitely.
  startedAt = performance.now();
  assert.equal(await settleOwnedConptyReader(true, 20, () => new Promise<void>(() => { /* never settles */ })), "uncertain",
    "a never-settling reader cleanup is reported uncertain at its budget");
  waited = performance.now() - startedAt;
  assert.ok(waited >= 15 && waited < 2_000, `the bounded settlement returned at its own budget (${Math.round(waited)}ms)`);

  // A delayed-but-eventual settlement is bounded the same way, and its later
  // resolution never rewrites the reported outcome or escapes as an error.
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  startedAt = performance.now();
  assert.equal(await settleOwnedConptyReader(true, 20, () => pending), "uncertain",
    "a delayed reader cleanup is reported uncertain at its budget");
  waited = performance.now() - startedAt;
  assert.ok(waited < 2_000, `a delayed settlement is not waited on past its budget (${Math.round(waited)}ms)`);
  release();

  // A throwing settlement is reported, never rethrown as a new failure.
  assert.equal(await settleOwnedConptyReader(true, 1_000, () => Promise.reject(new Error("not the pinned ConPTY-DLL shape"))), "uncertain",
    "a failing settlement is reported as uncertain instead of escaping as a new error");

  // An exhausted cleanup window grants no wait at all.
  startedAt = performance.now();
  assert.equal(await settleOwnedConptyReader(true, 0, () => new Promise<void>(() => { /* never settles */ })), "uncertain");
  assert.ok(performance.now() - startedAt < 200, "an exhausted cleanup window never waits");
});

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
