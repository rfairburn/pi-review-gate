/** Real public Main -> framed native Pi -> Ctrl+G -> non-Node Vim acceptance.
 * macOS PTY evidence only: the shared Main harness requires kernel exit watchers.
 * Linux/SSH and remote-viewer evidence belongs to the separate bridge tiers.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  KEYS, MainPtyDriver, TEST_TIMEOUT_MS, compileAndStageCandidate,
  createEditorLog, createOwnedScratchRoot, makeNativeAgentRoot,
  makeRuntimeEnvironment, makeWorkspace, removeOwnedScratchTree, resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test("production Main Ctrl+G edits through real Vim and restores the native draft after save, cancel and failure", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;
  if (!existsSync("/usr/bin/vim")) {
    if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") throw new Error("real Vim is required for external-editor acceptance");
    t.skip("real Vim is unavailable");
    return;
  }
  const scratch = createOwnedScratchRoot();
  let driver: MainPtyDriver | undefined;
  let assertionsCompleted = false;
  t.after(async () => {
    let cleanup: Awaited<ReturnType<MainPtyDriver["boundedCleanup"]>> | undefined;
    if (driver) {
      try { cleanup = await driver.boundedCleanup(); }
      catch { cleanup = await driver.forceCleanupAndObserve(); }
      finally { driver.dispose(); }
    }
    if (assertionsCompleted && cleanup?.childrenExited && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit && !cleanup.forced) {
      if (!removeOwnedScratchTree(scratch)) process.stderr.write("preserved owned external-editor fixture: ownership receipts unavailable\n");
    } else {
      process.stderr.write(`preserved owned external-editor fixture ${scratch}: assertionsCompleted=${assertionsCompleted}; childrenExited=${cleanup?.childrenExited}; gracefulHostExit=${cleanup?.gracefulHostExit}; forced=${cleanup?.forced}\n`);
    }
    if (assertionsCompleted) {
      assert.ok(cleanup?.childrenExited && cleanup.shutdownEventsObserved
        && cleanup.gracefulHostExit && !cleanup.forced, "all owned native processes settled and Main restored the outer terminal");
    }
  });

  const workspace = makeWorkspace(scratch, "editor-workspace");
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  const editorLog = createEditorLog(scratch);
  const observerFile = join(scratch, "observer", "editor-native.jsonl");
  const modeFile = join(scratch, "editor-mode");
  const editor = join(scratch, "owned-vim");
  // Neither the wrapper nor Vim is Node: no inherited Node decoder can mask fd-0
  // leakage. Pi still chooses and launches its configured editor normally.
  writeFileSync(editor, `#!/bin/sh
mode=$(/bin/cat ${quote(modeFile)})
/bin/cp "$1" ${quote(join(scratch, "before-"))}"$mode"
if [ "$mode" = failure ]; then exit 17; fi
/usr/bin/vim -u NONE -i NONE -n -N -X -c 'set encoding=utf-8 nobackup nowritebackup noswapfile laststatus=2 statusline=PRG499-VIM' "$1"
status=$?
/bin/cp "$1" ${quote(join(scratch, "after-"))}"$mode"
printf '%s\\n' "$status" > ${quote(join(scratch, "exit-"))}"$mode"
exit "$status"
`, { mode: 0o700, flag: "wx" });
  writeFileSync(modeFile, "save", { mode: 0o600, flag: "wx" });
  const candidate = compileAndStageCandidate(scratch);
  const env = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  driver = await MainPtyDriver.start({
    ptyModule: runtime.pty, scratchRoot: scratch, candidate, runtime, observerFile,
    editor, editorLog, editorValue: "", env,
    // No injected framing switch: exercise production Main's default-on bridge.
  });
  const active = driver;
  await active.waitFrame((text) => text.includes("Welcome") && text.includes("New session"), "public Main starts empty");
  const session = await active.createNativeSession(workspace);
  assert.equal(session.record.tty, true);

  const original = "PRG499-original-draft";
  const edited = "PRG499-edited-café-雪";
  await active.writeAndWait(original, (text) => text.includes(original), "native Pi receives the original framed draft");
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "actual Ctrl+G opens configured real Vim");
  assert.equal(readFileSync(join(scratch, "before-save"), "utf8"), original, "Pi's own launcher prefills the exact draft");
  await active.writeAndWait("ggdGi", (text) => text.includes("INSERT"), "ordinary Vim commands reach Vim rather than Pi");
  await active.writeAndWait(`\x1b[200~${edited}\x1b[201~`, (text) => text.includes(edited), "Unicode bracketed paste reaches the editor");
  assert.equal(active.currentText().includes("prg-ni-v2;"), false, "no unintended input frames are rendered in Vim");
  // Separate Escape from the following command: ESC+Z in one terminal packet is
  // also the legacy Alt+Z encoding, not an unambiguous Escape followed by Z.
  await active.writeAndWait("\x1b", (text) => !text.includes("INSERT"), "Escape leaves editor insert mode");
  await active.writeAndWait("ZZ", (text) => text.includes(edited) && !text.includes("PRG499-VIM"), "save returns the edited draft to Pi");
  assert.equal(readFileSync(join(scratch, "after-save"), "utf8"), `${edited}\n`, "the non-Node editor saved the exact intended bytes");
  assert.equal(readFileSync(join(scratch, "exit-save"), "utf8"), "0\n", "owned editor wrapper observed Vim exit before native return");
  await active.writeAndWait("-after-save", (text) => text.includes(`${edited}-after-save`), "normal Pi typing resumes after save");

  writeFileSync(modeFile, "cancel");
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "a second Ctrl+G opens a new editor ownership episode");
  const preserved = `${edited}-after-save`;
  assert.equal(readFileSync(join(scratch, "before-cancel"), "utf8"), preserved);
  await active.writeAndWait("ggdGiDISCARD-499", (text) => text.includes("DISCARD-499"), "cancel control makes a distinct unsaved edit");
  await active.writeAndWait("\x1b", (text) => !text.includes("INSERT"), "Escape leaves insert mode before cancellation");
  await active.writeAndWait("ZQ", (text) => text.includes(preserved) && !text.includes("PRG499-VIM"), "Vim quit-without-save restores the original draft");
  assert.equal(readFileSync(join(scratch, "after-cancel"), "utf8"), preserved, "unsaved changes never overwrite the draft file");
  assert.equal(readFileSync(join(scratch, "exit-cancel"), "utf8"), "0\n");
  await active.writeAndWait("-after-cancel", (text) => text.includes(`${preserved}-after-cancel`), "normal Pi input resumes after cancellation");

  writeFileSync(modeFile, "failure");
  const beforeFailure = `${preserved}-after-cancel`;
  await active.writeKeys("\x07", "Ctrl+G invokes the configured failing editor");
  await active.waitFrame((text) => text.includes(beforeFailure) && existsSync(join(scratch, "before-failure")), "failed editor restores the unchanged draft");
  assert.equal(readFileSync(join(scratch, "before-failure"), "utf8"), beforeFailure);
  await active.writeAndWait("-after-failure", (text) => text.includes(`${beforeFailure}-after-failure`), "normal Pi input resumes after editor failure");
  // A fresh editor prefill observes Pi's actual expanded draft, not merely a
  // matching stale rendered fragment, and proves there was exactly one return.
  writeFileSync(modeFile, "verify");
  await active.writeAndWait("\x07", (text) => text.includes("PRG499-VIM"), "final native prefill observes the returned draft exactly");
  assert.equal(readFileSync(join(scratch, "before-verify"), "utf8"), `${beforeFailure}-after-failure`);
  await active.writeAndWait("ZQ", (text) => text.includes("-after-failure") && !text.includes("PRG499-VIM"), "final owned editor exits without saving");
  assert.equal(readFileSync(join(scratch, "exit-verify"), "utf8"), "0\n");
  await active.writeAndWait(KEYS.ctrlC, (text) => !text.includes("-after-failure"), "native clear works after all handoffs");
  assert.equal(active.records().filter((record) => record.type === "agent_start" || record.type === "tool_call").length, 0,
    "all editor acceptance runs without a model/provider call or native tool invocation");
  await active.closeNativeNormally(session);
  await active.finishHostNormally();
  assertionsCompleted = true;
});
