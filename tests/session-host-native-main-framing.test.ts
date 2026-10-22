/**
 * Focused real-native regression for Main's internal input-origin framing
 * opt-in (`MainDependencies.nativeInputOriginFraming`, supplied by local launch
 * helpers through the internal dependency seam).
 *
 * The opted-in flag is a manager registration option, carried through Main's
 * production status adapter to the actual broker and recorded in the child's
 * one-shot bootstrap. An adapter that drops it makes the manager refuse the
 * row before any PTY exists: local New then displays a bounded startup error
 * and no native editor. This test therefore drives the REAL public Main
 * (production broker, manager, adapter, reporter, Pi child) with exactly one
 * test-only MainDependencies override, performs one ordinary local New through
 * the Workspace form, and requires the actual native editor to render local
 * typed text.
 *
 * What this deliberately does NOT do: submit a model turn, call a tool, copy
 * or read any clipboard, send remote input, open a pairing flow, or start an
 * external editor. The only child journal records are its own native
 * session_start lifecycle.
 *
 * The existing default-off native Main test remains the ordinary-behavior
 * control; the focused Main-adapter test in tests/session-host-main.test.ts
 * covers option forwarding, bootstrap mode, registration identity, and
 * callback preservation against the real broker.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  TEST_TIMEOUT_MS,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  editorRecords,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTree,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";

test("the internal Main framing opt-in lets local New reach a live native editor that renders typed text", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  let driver: MainPtyDriver | undefined;
  let scratchOwned = true;
  // True only after every scenario assertion, including the typed render.
  let assertionsCompleted = false;
  t.after(async () => {
    let cleanup: Awaited<ReturnType<MainPtyDriver["boundedCleanup"]>> | undefined;
    if (driver) {
      try {
        cleanup = await driver.boundedCleanup();
      } catch {
        try { cleanup = await driver.forceCleanupAndObserve(); } catch {
          cleanup = driver.cleanupStatus(true);
        }
      } finally {
        driver.dispose();
      }
    }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    if (scratchOwned && assertionsCompleted && cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTree(scratch)) {
          process.stderr.write(`preserved Main framing witness (per-entry ownership receipts unavailable): ${scratch}\n`);
        }
      } catch {
        process.stderr.write("preserved owned Main framing scratch: bounded cleanup could not positively remove every entry\n");
      }
    } else if (scratchOwned) {
      const status = cleanup
        ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
        : "cleanup status unavailable";
      process.stderr.write(`preserved owned Main framing scratch ${scratch}; assertionsCompleted=${assertionsCompleted}; ${status}\n`);
    }
  });

  const workspace = makeWorkspace(scratch, "workspace-framed");
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  const editorTarget = join(workspace, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const observerFile = join(scratch, "observer", "native-main-framing.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);
  const startEnv = makeRuntimeEnvironment(
    scratch,
    runtime,
    editor,
    observerFile,
    editorLog,
    "",
    nativeAgentDir,
  );
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = ["--offline", "--no-context-files", "--no-themes", "--no-tools", "--extension", OBSERVER_FIXTURE];

  driver = await MainPtyDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    editor,
    editorLog,
    editorValue: "",
    args,
    env: startEnv,
    // The ONLY injected dependency value. The runner uses the candidate's
    // internal runWithDependencies seam with exactly this override; the real
    // production broker, adapter, manager, reporter, and child remain in use.
    internalInputOriginFraming: true,
  });

  await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
    "fresh real Main with the internal framing opt-in displays its empty welcome/sidebar state");
  assert.deepEqual(driver.records(), [], "no native lifecycle observer ran before an explicit local New");

  // The ordinary Workspace-only New form; under the old option-dropping adapter
  // this never reaches a session_start because the manager refuses before PTY
  // spawn and Main only shows its bounded startup error.
  const session = await driver.createNativeSession(workspace);
  assert.equal(session.record.cwd, workspace, "the local New child runs in the explicitly selected workspace");
  assert.equal(session.record.agentDir, nativeAgentDir, "the local New child uses the ordinary shared native agent root");
  assert.equal(session.record.tty, true, "the local New child owns a real native PTY");
  assert.ok(typeof session.record.sessionId === "string" && session.record.sessionId.length > 0,
    "Pi's public native SessionManager created the conversation through the opted-in row");
  assert.equal(processIsAlive(session.record.pid), true, "the local New child is a live native process");
  assert.deepEqual(session.record.credentialLikeEnvironmentNames, [],
    "the opted-in child inherited no credential-like environment variables");
  assert.equal(driver.focus, "main", "the completed New activates the new native session as Main's input owner");

  const draft = `framed-local-new-${Math.random().toString(16).slice(2, 8)}`;
  await driver.writeAndWait(draft, (text) => text.includes(draft),
    "the live native editor renders local typed text under the opted-in framing mode");
  assert.ok(driver.currentText().includes(draft),
    "the actual native prompt visibly contains the typed draft on the settled frame");
  await driver.writeAndWait(KEYS.ctrlC, (text) => !text.includes(draft),
    "the same live native editor clears the draft through its ordinary Ctrl+C binding");
  assert.equal(processIsAlive(session.record.pid), true,
    "clearing the draft leaves the owned native child alive");

  const records = driver.records();
  assert.equal(records.filter((record) => record.type === "agent_start").length, 0,
    "typing into the native editor made no model/API request");
  assert.equal(records.filter((record) => record.type === "agent_settled").length, 0,
    "no agent turn settled because no turn was submitted");
  assert.equal(records.filter((record) => record.type === "tool_call").length, 0,
    "the opted-in local New path invoked no native tools");
  assert.deepEqual(editorRecords(editorLog), [],
    "no external editor or clipboard path ran during local New and typing");
  assert.equal(driver.sessions().length, 1,
    "exactly one owned native child was created; no remote/pairing row appeared");

  assertionsCompleted = true;
});
