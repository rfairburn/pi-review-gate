/**
 * Real POSIX (macOS/Linux) source-launcher acceptance.
 *
 * This lane exercises the REAL shipped POSIX source wrapper end to end:
 *
 *   /bin/bash <fresh-copied-fixture>/scripts/pi-review-sessions.sh \
 *     --pi-executable <pinned Pi 1.7.0 CLI> --state-root <owned> --sidebar-key f8 \
 *     -- --offline --no-context-files --no-themes --no-tools \
 *        --extension <observer> --extension <provider>
 *
 * The wrapper selects the supported Node already on the confined PATH and execs
 * the real shared CJS launcher, which performs its own bounded, lockfile-exact,
 * script-free source-stage install and build before loading the compiled host
 * and spawning one genuinely owned native Pi child. It is not a direct-Main,
 * help, precompiled-Main, fake-install, or dependency-injection substitute.
 *
 * Evidence chain: the exact public returned child PTY handle (shared preload
 * observer on the production lazy-load anchor), the public session_start
 * lifecycle, the original public kernel incarnation watcher for the exact PID,
 * a complete scoped UI roster witness, real native/Main/outer graceful exits,
 * and full stty/VT/NODE_OPTIONS/env restoration. Force or uncertainty never
 * counts as success.
 *
 * Opt-in: PI_REVIEW_GATE_REQUIRE_PI_HOST=1 (the same required-native flag as the
 * shared resolveRuntimePin). Once opted in, every missing prerequisite is a hard
 * failure, never a skip.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

import {
  LegDeadline,
  POSIX_LAUNCHER_BODY_DEADLINE_MS,
  POSIX_LAUNCHER_CLEANUP_BUDGET_MS,
  POSIX_LAUNCHER_EXPECT_PI_VERSION,
  POSIX_LAUNCHER_LEG_DEADLINE_MS,
  POSIX_LAUNCHER_OUTER_COLS,
  POSIX_LAUNCHER_REQUIRE_ENV,
  POSIX_LAUNCHER_STARTUP_TIMEOUT_MS,
  POSIX_LAUNCHER_TEST_TIMEOUT_MS,
  PosixLauncherPtyDriver,
  assertAdmissibleOriginalEnvironment,
  assertCreatedDirectoryIdentity,
  hasPosixStopConfirmation,
  assertLauncherRestoration,
  assertLauncherStageEvidence,
  assertLauncherSummary,
  assertLauncherTtyRestoration,
  assertNativeRestoration,
  assertNoUnownedNativeSessions,
  assertPosixLegArithmetic,
  assertSourceFixtureUnchanged,
  createLauncherLegLayout,
  frameWaitFailure,
  identityOfRealDirectory,
  randomDigits,
  resolveLauncherRuntime,
  sameFileIdentity,
  type PosixOwnedSession,
} from "./helpers/session-host-native-posix-launcher";
import { frameHeader, isSidebarFocusedFrame, parseRosterFrame, SIDEBAR_COLUMNS } from "./helpers/session-host-native-roster-witness";
import {
  captureSetupInventory,
  disposeFixtureRoot,
  fixtureRootReceipt,
  preserveRequested,
  type FixtureInventory,
  type FixtureRootReceipt,
} from "./helpers/scratch-fixture-base";

const restorationFixtures = require("../../tests/fixtures/session-host-posix-launcher-restoration.cjs") as {
  captureLauncherBaseline(input: { stdin: unknown; stdout: unknown; env: Record<string, string | undefined> }): unknown;
  launcherRestorationSnapshot(baseline: unknown, current: { stdin: unknown; stdout: unknown; env: Record<string, string | undefined> }): Record<string, unknown>;
  nativeRestorationSnapshot(env: Record<string, string | undefined>): Record<string, unknown>;
};

const isWindows = process.platform === "win32";
const optIn = process.env[POSIX_LAUNCHER_REQUIRE_ENV] === "1";
// Post-spawn write grants for the confined launcher/Pi producers only. A grant
// says a producer may write there; it is never proof that what is already
// inside belongs to this leg, so setup provenance still comes from the creation
// ledger. Two directories are deliberately absent:
// - `source-fixture`: the hardened copier's tree is immutable setup output, so
//   it stays inventoried and re-verified at teardown, and only its completed
//   output is exempt from the creation-ledger lookup.
// - `observer` and `fixture-state`: this leg creates the observer journal and
//   the provider journal inside them, and both public fixtures only ever append
//   to that one file, which leaves its dev/ino identity unchanged. Neither
//   directory needs a write grant: each journal is re-verified by identity at
//   teardown, and any other entry appearing there is refused instead of deleted.
const POSIX_LAUNCHER_MUTABLE_DIRECTORIES = ["home", "tmp", "cache", "state", "native-agent"] as const;

/** The credential-like names the caller already had; the lane must introduce none of its own. */
const CALLER_CREDENTIAL_NAMES = Object.keys(process.env)
  .filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name))
  .sort();

function assertCredentialNamesPreserved(records: readonly { credentialLikeEnvironmentNames?: unknown }[]): void {
  for (const record of records) {
    if (!Array.isArray(record.credentialLikeEnvironmentNames)) continue;
    assert.deepEqual([...record.credentialLikeEnvironmentNames].sort(), CALLER_CREDENTIAL_NAMES,
      "the native child received exactly the caller's preserved credential-like names and no new ones");
  }
}

// Pure source/runtime-independent contracts. They run everywhere and pin the
// bounded arithmetic the POSIX acceptance relies on.
test("POSIX source-launcher acceptance bounds are finite and fit the whole-file budget", () => {
  assertPosixLegArithmetic();
  assert.equal(POSIX_LAUNCHER_EXPECT_PI_VERSION, "1.7.0");
  assert.equal(POSIX_LAUNCHER_LEG_DEADLINE_MS, 9 * 60_000);
  assert.ok(POSIX_LAUNCHER_STARTUP_TIMEOUT_MS < POSIX_LAUNCHER_LEG_DEADLINE_MS);
});

test("launcher disposal reconciliation retains a spawn whose kernel watcher was never registered", () => {
  const summary = {
    type: "launcher_summary", pid: 1, journalFailed: false,
    unresolvedSpawns: 0, unexitedSpawns: 0, forceAttempted: false,
  };
  const records = () => [
    { type: "launcher_entry", pid: 1 },
    { type: "pty_spawn_pending", incarnation: 1, pid: 4301, cwd: "/owned/workspace" },
    { type: "pty_spawn", incarnation: 1, pid: 4301, cwd: "/owned/workspace" },
    summary,
  ];
  const driver = Object.create(PosixLauncherPtyDriver.prototype) as PosixLauncherPtyDriver;
  Object.assign(driver, { ptyRecords: records, kernelWatchers: [] });
  assert.throws(() => driver.assertSpawnReconciliation(), /has no registered kernel watcher/);

  const watcher = { pid: 4301, observedExit: false };
  Object.assign(driver, { kernelWatchers: [watcher] });
  assert.throws(() => driver.assertSpawnReconciliation(), /has no confirmed kernel exit/);
  watcher.observedExit = true;
  assert.doesNotThrow(() => driver.assertSpawnReconciliation());

  // An entered launcher without its durable exit summary cannot establish that
  // no later spawn went unobserved.
  Object.assign(driver, { ptyRecords: () => records().filter((record) => record.type !== "launcher_summary") });
  assert.throws(() => driver.assertSpawnReconciliation(), /no durable exit summary/);

  // A pending spawn with no matching actual spawn receipt is not settlement.
  Object.assign(driver, {
    ptyRecords: () => [
      { type: "launcher_entry", pid: 1 },
      { type: "pty_spawn_pending", incarnation: 2, cwd: "/owned/workspace" },
      { type: "launcher_summary", pid: 1, journalFailed: false, unresolvedSpawns: 1, unexitedSpawns: 0 },
    ],
    kernelWatchers: [],
  });
  assert.throws(() => driver.assertSpawnReconciliation(), /pending spawn\(s\) but 0 observed spawn\(s\)/);

  // An unactivated preload can leave a completely empty journal; that is missing
  // observation, not proof that no native child spawned after outer exit.
  Object.assign(driver, { ptyRecords: () => [], kernelWatchers: [] });
  assert.throws(() => driver.assertSpawnReconciliation(), /no durable exit summary and entry pair/);
});

test("real POSIX source launcher stages, builds, runs a native Pi child, and restores", {
  timeout: POSIX_LAUNCHER_TEST_TIMEOUT_MS,
  skip: isWindows
    ? "the POSIX source-launcher acceptance is a POSIX-only proof"
    : optIn ? false : `${POSIX_LAUNCHER_REQUIRE_ENV}=1 is required; this is not POSIX host proof`,
}, async (t) => {
  // Once opted in, all missing platform/runtime prerequisites are hard failures.
  assert.equal(process.env[POSIX_LAUNCHER_REQUIRE_ENV], "1");

  // Disposal covers the first owned allocation, before runtime resolution,
  // source copying, or child spawn can throw. The receipt and inventory are the
  // only ownership state; the driver's own exit/watcher accounting remains the
  // settlement gate.
  let rootPath: string | undefined;
  let rootReceipt: FixtureRootReceipt | undefined;
  let startedDriver: PosixLauncherPtyDriver | undefined;
  let inventory: FixtureInventory | undefined;
  let inventoryCaptureStarted = false;
  let sourceCopied = false;
  let deadline: LegDeadline | undefined;
  let spawnAttempted = false;
  const setupSettlementFaults: string[] = [];
  let bodyState: "running" | "completed" | "failed" = "running";
  t.after(settleAndDispose);

  try {
    const layout = createLauncherLegLayout((root) => {
      rootPath = root;
      rootReceipt = fixtureRootReceipt(root);
    });
    if (rootPath === undefined || rootReceipt === undefined) {
      throw new Error("the POSIX source-launcher layout did not report its own root receipt");
    }
    // Pre-mutation original role/catalog refusal and pinned-runtime resolution
    // happen before any fixture copy or child spawn.
    const runtime = resolveLauncherRuntime(layout, () => { sourceCopied = true; });
    assert.equal(runtime.version, "1.7.0", "the POSIX launcher lane pins exact Pi 1.7.0");
    assertSourceFixtureUnchanged(runtime);

    const rootIdentity = identityOfRealDirectory(layout.root);
    const nonce = randomBytes(24).toString("hex");
    const testSignal = (t as unknown as { signal?: AbortSignal }).signal;
    const legDeadline = new LegDeadline(POSIX_LAUNCHER_BODY_DEADLINE_MS, testSignal);
    deadline = legDeadline;

    const driver = PosixLauncherPtyDriver.start({
      runtime, layout, nonce, deadline: legDeadline,
      onPrepared: () => {
        inventoryCaptureStarted = true;
        // Ownership comes from this leg's creation ledger, not from whatever a
        // scan finds, so an entry the setup did not create can never be adopted.
        inventory = captureSetupInventory(layout.root, rootReceipt!, {
          mutableDirectories: POSIX_LAUNCHER_MUTABLE_DIRECTORIES,
          // Only the completed copier's output skips the ledger lookup, and it
          // is still inventoried here and re-verified before removal.
          setupProducers: sourceCopied ? ["source-fixture"] : [],
        });
      },
      onSpawnAttempt: () => { spawnAttempted = true; },
      onSetupSettlementFault: (detail) => { setupSettlementFaults.push(detail); },
    });
    startedDriver = driver;

  // The real launcher first performs its own bounded source-stage install and
  // build, so the first real Main frame legitimately takes minutes.
  await driver.waitFrame(
    (frame) => frameHeader(frame) === "Session host" && frame.includes("Welcome")
      && isSidebarFocusedFrame(frame, SIDEBAR_COLUMNS) && parseRosterFrame(frame, SIDEBAR_COLUMNS).count === 0,
    "actual POSIX source launcher completely paints its empty welcome roster and sidebar-only focus footer before input",
    -1,
    POSIX_LAUNCHER_STARTUP_TIMEOUT_MS,
  );
  assert.ok(typeof driver.pty.pid === "number" && Number.isSafeInteger(driver.pty.pid) && driver.pty.pid > 1,
    "the exact owned outer PTY exposes its positive public PID");
  assert.equal(existsSync(join(layout.nativeAgentDir, ".pi-review-gate", "build")), true,
    "the real launcher created its owned source build stage under the per-leg agent root");
  assert.deepEqual(driver.records(), [], "no native lifecycle record exists before Workspace-only New");

  // The preload positively identified the actual source launcher entry and
  // wrapped the public node-pty module at the production anchor.
  const entryRecords = await driver.waitForPty((entries) => entries.some((entry) => entry.type === "launcher_entry"),
    "the preload positively identified the actual source launcher entry");
  const entry = entryRecords.find((record) => record.type === "launcher_entry");
  assert.equal(entry?.entry, realpathSync(join(runtime.sourceRoot, "scripts", "pi-review-sessions.cjs")),
    "the preload was active only in the exact POSIX source launcher entry, never in npm/tsc/version-probe Node");
  // One genuine native session through the real Workspace-only New form. The
  // production node-pty lazy-load anchor is only reached during this first
  // actual spawn, so the pty_module receipt is awaited after creation.
  const session: PosixOwnedSession = await driver.createNativeSession(layout.workspace);
  const moduleEvidence = await driver.waitForPty((entries) => entries.some((record) => record.type === "pty_module"),
    "the preload observed the production node-pty lazy-load anchor during the first real spawn");
  assert.equal(session.displayName, "(no messages)", "the fresh native child starts with the actual empty-conversation caption");
  assert.equal(frameHeader(driver.currentText()), session.displayName,
    "a successful New submission activates the child; the outer header becomes its caption");
  const draft = `posixLauncherDraft${randomDigits(8)}`;
  await driver.writeDraft(draft);
  assert.ok(driver.currentText().includes(draft), "the active native child displays its own input draft");

  const nativeRecords = driver.records();
  assertNoUnownedNativeSessions(nativeRecords, [session]);
  assertCredentialNamesPreserved(nativeRecords);
  assert.ok(Number.isSafeInteger(session.record.pid) && session.record.pid! > 1,
    "the native public session_start carries its exact positive PID");
  assert.ok(session.record.sessionId && session.record.sessionId.length > 0,
    "the public SessionManager reported its conversation id");
  assert.ok(session.record.sessionFile && isAbsolute(session.record.sessionFile),
    "the public SessionManager reported its absolute planned conversation path");
  assert.equal(session.record.cwd, session.workspace, "the native child owns its explicitly selected workspace");
  assert.equal(session.record.contextCwd, session.workspace, "the native context independently confirms the workspace");
  assert.equal(session.record.agentDir, layout.nativeAgentDir, "the native child uses the ordinary per-leg shared native agent root");
  assert.equal(session.record.tty, true, "the native child is a real Pi TTY process");
  assert.equal(session.record.columns, POSIX_LAUNCHER_OUTER_COLS - SIDEBAR_COLUMNS - 1,
    "the native child receives the exact pane width beside the roster and divider");
  assert.equal(session.record.rows, 49, "the native child receives the actual 49-row pane geometry");
  const sessionRel = relative(layout.nativeAgentDir, session.record.sessionFile!);
  assert.ok(sessionRel !== ".." && !sessionRel.startsWith(`..${sep}`) && !isAbsolute(sessionRel),
    "the planned conversation path remains inside the per-leg shared native root");

  // The public session_start PID/cwd cross-binds to exactly one real public
  // node-pty spawn of the exact manager-owned handle.
  const spawnRecords = await driver.waitForPty((entries) => entries.some((entry) => entry.type === "pty_spawn"
    && entry.pid === session.record.pid && entry.cwd === session.workspace),
  "session_start PID/cwd cross-binds to its actual public node-pty spawn");
  assert.equal(spawnRecords.filter((entry) => entry.type === "pty_spawn"
    && entry.pid === session.record.pid && entry.cwd === session.workspace).length, 1,
  "the exact child PID/cwd resolves to exactly one actual public PTY spawn");
  assert.equal(driver.ptyRecords().some((entry) => entry.type === "pty_exit" && entry.pid === session.record.pid), false,
    "the native child has no exit before intentional confirmed Quit");

  // The existing public offline faux-provider fixture registered; no external
  // AI/model request was issued.
  const providerEvents = await driver.waitForProvider((records) => records.some((record) => record.event === "provider_registered"),
    "existing offline public faux-provider fixture registration");
  assert.ok(providerEvents.some((record) => record.event === "provider_registered"),
    "the existing public native provider fixture loaded without private SDK construction");
  assert.equal(providerEvents.some((record) => record.event === "model_request"), false,
    "the acceptance case made no external/model request");
  assertCredentialNamesPreserved(driver.records());

  // The preload's bounded native-child marker proves the production bootstrap
  // restore ran, consumed its sidecar, and kept the exact caller env/values.
  const nativePreloads = driver.ptyRecords().filter((record) => record.type === "native_preload");
  assert.equal(nativePreloads.length, 1, "exactly the one owned native child loaded the restored preload");
  assertNativeRestoration(driver.ptyRecords(), session.record.pid!);

  await driver.assertBeforeQuitModes();

  // Close the exact native child through its real public Ctrl+C exit, then quit
  // the already-childless host. Both are graceful; no force escalation exists.
  await driver.closeNativeNormally(session);
  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.exitCode, 0, "real POSIX source launcher outer PTY exited zero");
  assert.ok(!hostExit.signal, "real POSIX source launcher outer PTY exited without a signal");
  assert.equal(driver.forcedCleanup, false, "successful Quit required no force cleanup");
  assert.equal(driver.ptyRecords().some((record) => record.type === "pty_force_attempt"), false,
    "the launcher made no forced native public PTY kill attempt");
  assert.equal(lstatSync(driver.forceJournal).size, 0, "the parent made no forced outer PTY kill attempt");
  assert.equal(driver.ptyRecords().filter((record) => record.type === "pty_exit").length, 1,
    "only the one positively owned native PTY handle exited during graceful shutdown");
  assert.equal(driver.records().filter((record) => record.type === "session_shutdown").length, 1,
    "only the one owned native session emitted shutdown during the acceptance case");
  assert.equal(driver.providerRecords().some((record) => record.event === "model_request"), false,
    "offline fixture remained idle; no model/external AI request was issued");

  // The actual launcher process returned zero with no force and no
  // unresolved/unexited owned handle; it restored its original streams/env.
  const summary = await driver.waitForLauncherSummary();
  assertLauncherSummary(summary);
  assertLauncherRestoration(driver.ptyRecords());
  assertLauncherTtyRestoration(driver.ptyRecords());

  // The real launcher built and installed into its own retained stage only;
  // the fresh complete source fixture stays a source fixture.
  const stageEvidence = assertLauncherStageEvidence(runtime, layout);
  assertSourceFixtureUnchanged(runtime);
  const moduleRecord = moduleEvidence.find((record) => record.type === "pty_module");
  assert.equal(moduleRecord?.parent, realpathSync(join(stageEvidence.stage, "dist", "src", "session-host", "instances.js")),
    "the observed public spawn anchor is the staged production instances.js");
  const observedModule = typeof moduleRecord?.modulePath === "string" ? moduleRecord.modulePath : undefined;
  assert.ok(observedModule !== undefined
    && observedModule.startsWith(stageEvidence.ptyModulePath),
  "the staged production module resolved the exact installed public @lydell/node-pty under the retained stage");
  assert.ok(sameFileIdentity(identityOfRealDirectory(layout.root), rootIdentity),
    "the successful leg keeps the exact caller-owned witness tree identity before its registered disposal");
  assertCreatedDirectoryIdentity(layout.root);
  bodyState = "completed";
  } catch (error) {
    bodyState = "failed";
    throw error;
  }

  async function settleAndDispose(): Promise<void> {
    const bodyWasRunning = bodyState === "running";
    try {
      let settlementDetail = setupSettlementFaults.join("; ");
      let settled = false;
      if (startedDriver !== undefined) {
        let settlementFault = "";
        if (!startedDriver.exitEvent) {
          try {
            // Bounded cleanup only: a short-lived cleanup deadline plus exact-handle
            // force, never unbounded graceful waits or post-cancellation input.
            await startedDriver.tryGracefulQuitAfterFailure(POSIX_LAUNCHER_CLEANUP_BUDGET_MS);
            if (!startedDriver.exitEvent) await startedDriver.forceKillOuterAfterFailure();
          } catch (error) {
            settlementFault = `bounded launcher cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        // Release the owned outer subscription and kernel watchers even after a
        // cleanup fault; settlement below still decides whether evidence stays.
        try {
          await startedDriver.settleSubscriptions();
        } catch (error) {
          settlementFault = `${settlementFault === "" ? "" : `${settlementFault}; `}bounded launcher settlement failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        // Required even after outer exit: every journal spawn/pending receipt
        // must reconcile with one registered watcher and a confirmed kernel exit.
        try {
          startedDriver.assertSpawnReconciliation();
        } catch (error) {
          settlementFault = `${settlementFault === "" ? "" : `${settlementFault}; `}spawn reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        const unresolved = startedDriver.unresolvedOwnedResources;
        settled = startedDriver.exitEvent !== undefined && unresolved.unobservedWatchers === 0
          && settlementFault === "" && setupSettlementFaults.length === 0;
        if (!settled) {
          settlementDetail = [setupSettlementFaults.join("; "), settlementFault,
            `outerExited=${unresolved.outerExited}`,
            `unobservedWatchers=${unresolved.unobservedWatchers}`,
            `forced=${startedDriver.forcedCleanup}`].filter((part) => part.length > 0).join("; ");
        }
      } else if (!spawnAttempted && setupSettlementFaults.length === 0) {
        // A failure before the first spawn leaves only this leg's own synchronous
        // setup, so its present entries are the whole owned inventory.
        settled = true;
      } else if (spawnAttempted) {
        settlementDetail = [settlementDetail, "the launcher spawn was attempted but returned no confirmed owned handle"]
          .filter((part) => part.length > 0).join("; ");
      }
      if (bodyWasRunning) {
        settled = false;
        settlementDetail = [settlementDetail, "test ended before its body finished"]
          .filter((part) => part.length > 0).join("; ");
      }
      if (rootPath !== undefined && rootReceipt !== undefined) {
        if (inventory === undefined && settled && !spawnAttempted && !inventoryCaptureStarted) {
          // A failed setup owns only the entries its own creation ledger accounts
          // for; the hardened copier's destination stays a declared producer
          // directory, so a collision entry is retained and reported instead.
          inventory = captureSetupInventory(rootPath, rootReceipt, {
            mutableDirectories: POSIX_LAUNCHER_MUTABLE_DIRECTORIES,
            setupProducers: sourceCopied ? ["source-fixture"] : [],
          });
        }
        disposeFixtureRoot({
          label: "POSIX source-launcher",
          root: rootPath,
          receipt: rootReceipt,
          inventory,
          settled,
          unsettledDetail: settlementDetail,
          preserve: preserveRequested(),
          report: (line) => {
            t.diagnostic(line);
            process.stderr.write(`${line}\n`);
          },
        });
      } else if (rootPath !== undefined || rootReceipt !== undefined) {
        throw new Error(`POSIX source-launcher fixture ownership is unconfirmed; leaving the path untouched: ${rootPath ?? "unknown"}`);
      }
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const message = `POSIX source-launcher cleanup unconfirmed; registered fixture path: ${rootPath ?? "not allocated"}; ${detail}`;
      t.diagnostic(message);
      process.stderr.write(`${message}\n`);
      if (bodyState === "completed" && !bodyWasRunning) throw cleanupError;
    } finally {
      deadline?.dispose();
    }
  }
});

// Pure synthetic contracts that run everywhere: the pre-mutation original
// environment guard, restoration witnesses, the enforced leg deadline, and
// transcript-free diagnostics.
test("original environment guard refuses exact and mixed-case role/catalog markers", () => {
  const clean: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/tmp/example" };
  assert.doesNotThrow(() => assertAdmissibleOriginalEnvironment(clean));
  assert.throws(() => assertAdmissibleOriginalEnvironment({ ...clean, PI_REVIEW_GATE_RUNTIME_ROLE: "executor" }), /role\/catalog marker/);
  assert.throws(() => assertAdmissibleOriginalEnvironment({ ...clean, PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: "x" }), /role\/catalog marker/);
  assert.throws(() => assertAdmissibleOriginalEnvironment({ ...clean, pi_review_gate_runtime_role: "executor" }), /role\/catalog marker/);
  assert.throws(() => assertAdmissibleOriginalEnvironment({ ...clean, Pi_Review_Gate_Executor_Tool_Catalog: "x" }), /role\/catalog marker/);
});

test("the POSIX stop confirmation is complete only when header, frozen title, warning, and combined hint row are drawn", () => {
  const compose = (body: string[]): string => {
    assert.ok(body.every((line) => line.length <= 32));
    return ["outer header", ...body].join("\n");
  };
  // Production-shaped 32-column wrapped warning.
  const warning = [
    "Stopping will stop its active",
    "turn, questions, background",
    "tasks, and shells",
  ];
  const complete = compose([
    " Stop session? ",
    " (no messages)",
    ...warning,
    "",
    "enter/y = stop | esc/n = cancel",
  ]);
  assert.equal(hasPosixStopConfirmation(complete, "(no messages)"), true);
  // Wrong frozen title.
  assert.equal(hasPosixStopConfirmation(complete, "another session"), false);
  // Missing the complete warning.
  const missingWarning = compose([
    " Stop session? ",
    " (no messages)",
    "",
    "enter/y = stop | esc/n = cancel",
  ]);
  assert.equal(hasPosixStopConfirmation(missingWarning, "(no messages)"), false);
  // Missing the cancel half of the combined footer row.
  const missingCancelHint = compose([
    " Stop session? ",
    " (no messages)",
    ...warning,
    "",
    "enter/y = stop",
  ]);
  assert.equal(hasPosixStopConfirmation(missingCancelHint, "(no messages)"), false);
  // Missing the confirm half of the combined footer row.
  const missingConfirmHint = compose([
    " Stop session? ",
    " (no messages)",
    ...warning,
    "",
    "esc/n = cancel",
  ]);
  assert.equal(hasPosixStopConfirmation(missingConfirmHint, "(no messages)"), false);
});

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
  const sensitive = "PRIVATE-DRAFT-session-host-posix-launcher-secret";
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

export {};
