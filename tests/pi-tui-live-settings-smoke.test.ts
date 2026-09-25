/**
 * Live Pi TUI smoke (issue #26): drives the built review-gate extension inside
 * a REAL Pi TUI on a real PTY, through the same public seam a user uses
 * (`pi --no-extensions --extension <built candidate>`), and exercises the
 * /review-settings scheduled-task workspace field end to end.
 *
 * What is asserted as actually observed (screen-scraped from the real render):
 * the native editor bridge hint line, native relative docs/ and leading-`/`
 * filesystem completion lists, the real fd-backed recursive `@` picker (asserted on a workspace-root
 * fixture only that picker can surface, frame-scoped so stale buffer content
 * cannot satisfy it), Esc list-first semantics, Ctrl+G external editing,
 * Enter staging the value into the task catalog, the reopen prefill, no field
 * text leaking into the chat draft, no accidental chat/command submission,
 * and the documented Ctrl+C-twice host exit.
 *
 * Known gap (reported, not faked): the smoke asserts nothing about single-press
 * Ctrl+C clear because a cleared editor row is not reliably observable through
 * its frame heuristics (the probes saw the old text persist; the asserted double
 * Ctrl+C exit proves the same app.clear handler — whose first press clears — ran
 * in the PTY); see docs/development.md for the behavioural probe that closes it.
 *
 * Sandboxing: everything runs under a throwaway temp sandbox (synthetic HOME
 * with a minimal review-gate.json, a synthetic workspace with a docs/ folder
 * and a workspace-root fixture, a stub $EDITOR). The child environment is
 * allowlisted: no PI_REVIEW_GATE_* variables (so the extension registers its
 * full interactive surface and never touches a user's live config), no
 * session/model variables, and no provider API keys — the smoke can never
 * make a model/API call. Every wait is time-bounded; the driver kills the
 * forked PTY child's process group on exit, and on the overall timeout the
 * driver's group is killed (the PTY child then sees the closed master and
 * hangs up).
 *
 * Requirements (CI exports them; locally they resolve to an ambient install
 * and a built dist/): PI_REVIEW_GATE_INSTALLED_AGENT (or any discoverable
 * pi-coding-agent), PI_REVIEW_GATE_CANDIDATE_ENTRY (or <root>/dist/src/index.js),
 * python3, and fd/fdfind (PI_REVIEW_GATE_FD or PATH). Locally the smoke skips
 * when a prerequisite is missing; under PI_REVIEW_GATE_REQUIRE_PI_HOST=1 (CI
 * full suite) a missing prerequisite is a hard failure — the live coverage
 * cannot silently degrade to a skip.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { findFdBinary, skipOrFail } from "./bridge-fakes";
import { explicitInstalledAgentDir, findInstalledAgentDir } from "./menu-tui-fakes";

const projectRoot = join(dirname(__dirname), "..");

/** Raw key hex for the driver steps. */
const KEYS = {
  up: "1b5b41",
  down: "1b5b42",
  enter: "0d",
  escape: "1b",
  tab: "09",
  ctrlC: "03",
  ctrlG: "07",
};

const textKeys = (text: string): string => Buffer.from(text, "utf8").toString("hex");

interface DriverStep {
  type: "wait" | "wait_exit" | "send" | "send_slow" | "settle" | "assert_screen" | "assert_latest";
  marker?: string;
  hex?: string;
  delayMs?: number;
  seconds?: number;
  includes?: string[];
  excludes?: string[];
  timeoutMs?: number;
}

interface DriverResult {
  ok: boolean;
  alive: boolean;
  steps: Array<{ index: number; ok: boolean; screen?: string; error?: string }>;
  lastScreen: string;
}

/** Hard overall cap for the whole PTY session, independent of the driver's own deadlines. */
const DRIVER_OVERALL_TIMEOUT_MS = 8 * 60_000;

async function runDriver(
  driverPath: string,
  sandbox: string,
  cliEntry: string,
  candidateEntry: string,
  fdDir: string,
): Promise<DriverResult> {
  const resultPath = join(sandbox, "result.json");
  return await new Promise<DriverResult>((resolve) => {
    // The driver inherits only an allowlisted environment (it rebuilds the
    // child env itself); PI_REVIEW_GATE_* and provider keys must never reach
    // the launched pi. PATH stays so pi can find fd/fdfind and the editor, and
    // the resolved fd directory is prepended so the child's finder resolution
    // matches the test's own prerequisite check.
    // detached + group kill: on the timeout the driver's own process group is
    // SIGKILLed. The pi child is a pty.fork() session leader with its own
    // process group, so it is not in that group: the driver kills it directly
    // on the normal path (os.killpg) and the closed PTY master hangs it up on
    // the timeout.
    const child = spawn("python3", [driverPath, sandbox, resultPath], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: process.env.LANG ?? "C.UTF-8",
        TMPDIR: sandbox,
        NODE_BIN: process.execPath,
        PRG_PI_CLI: cliEntry,
        PRG_CANDIDATE: candidateEntry,
        PRG_FD_DIR: fdDir,
      },
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }, DRIVER_OVERALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, alive: false, steps: [], lastScreen: `driver spawn failed: ${String(error)}` });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(readFileSync(resultPath, "utf8")) as DriverResult);
      } catch {
        resolve({ ok: false, alive: false, steps: [], lastScreen: "driver produced no result.json (killed or crashed)" });
      }
    });
  });
}

async function hasPython3(): Promise<boolean> {
  const result = spawnSync("python3", ["-c", "print(1)"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

test("live Pi TUI smoke: /review-settings workspace field drives the real native editor bridge", async (t) => {
  const agentDir = explicitInstalledAgentDir() ?? findInstalledAgentDir();
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY ?? join(projectRoot, "dist", "src", "index.js");
  const cliEntry = agentDir ? join(agentDir, "dist", "bundle", "cli.js") : undefined;
  const fdBinary = findFdBinary();
  const missing: string[] = [];
  if (!agentDir || !cliEntry || !existsSync(cliEntry)) {
    missing.push("installed pi-coding-agent (dist/bundle/cli.js; PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)");
  }
  if (!existsSync(candidateEntry)) {
    missing.push("built review-gate candidate entry (PI_REVIEW_GATE_CANDIDATE_ENTRY or dist/src/index.js)");
  }
  if (!fdBinary) missing.push("fd/fdfind file finder (PI_REVIEW_GATE_FD or PATH)");
  if (!(await hasPython3())) missing.push("python3");
  if (missing.length > 0) {
    skipOrFail(t, `live TUI smoke prerequisites unavailable: ${missing.join(", ")}`);
    return;
  }

  // --- Sandbox: synthetic home/config, synthetic workspace, stub $EDITOR ----
  const sandbox = await mkdtemp(join(tmpdir(), "prg-tui-smoke-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, "home");
  const binDir = join(home, ".pi", "agent", "bin");
  const workspace = join(sandbox, "workspace");
  const docs = join(workspace, "docs");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(docs, "assets"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "review-gate.json"), "{}\n");
  await writeFile(join(docs, "alpha-smoke.md"), "alpha\n");
  await writeFile(join(docs, "beta-smoke.md"), "beta\n");
  // Workspace-root fixture: only the fd-backed recursive `@` picker can ever
  // surface it (the docs/ prefix completion lists docs/ contents only), so it
  // makes the @ assertion discriminating.
  await writeFile(join(workspace, "root-smoke.md"), "root\n");
  const editorScript = join(binDir, "ext-editor.sh");
  await writeFile(editorScript, '#!/bin/sh\n{ cat "$1"; echo "ext-edit-mark"; } > "$1.new" && mv "$1.new" "$1"\n');
  await chmod(editorScript, 0o700);
  const driverPath = join(sandbox, "driver.py");
  await writeFile(driverPath, DRIVER_SOURCE);
  await chmod(driverPath, 0o700);

  // --- Scripted walk (markers verified against pi 0.87.1's real TUI) --------
  // Each observable is asserted in its own field session; fields are closed
  // with Esc and reopened rather than cleared in place (single Ctrl+C/Ctrl+U
  // clears are not observable as a step boundary through this driver's frame
  // heuristics — see the documented gap in docs/development.md), so in-place
  // clearing is not used as a step boundary.
  const rootMenuDowns = 14; // "Scheduled tasks" is row 15 of the root menu
  const taskMenuDowns = 4; // "Workspace" is row 5 of the task editor menu
  const slowDowns = (count: number): string => KEYS.down.repeat(count);
  const steps: DriverStep[] = [
    { type: "wait", marker: "Press ctrl+o", timeoutMs: 30_000 },
    // Frame slicing below depends on this exact host status marker. A Pi
    // upgrade must fail loudly rather than silently comparing stale history.
    { type: "assert_screen", includes: ["operating mode:"] },
    { type: "send", hex: textKeys("/review-settings\r") },
    { type: "wait", marker: "Review settings", timeoutMs: 30_000 },
    { type: "send_slow", hex: slowDowns(rootMenuDowns), delayMs: 120 },
    { type: "assert_screen", includes: ["→ Scheduled tasks"] },
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Add scheduled task", timeoutMs: 30_000 },
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Scheduled task name", timeoutMs: 30_000 },
    // The native editor bridge field is open: the bridge's own hint line
    // renders under the embedded host editor.
    { type: "assert_screen", includes: ["Ctrl+G external editor"] },
    { type: "send", hex: textKeys("smoke\r") },
    { type: "wait", marker: "Scheduled task task-", timeoutMs: 30_000 },
    { type: "send_slow", hex: slowDowns(taskMenuDowns), delayMs: 120 },
    { type: "assert_screen", includes: ["→ Workspace"] },
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Authorized target workspace directory", timeoutMs: 30_000 },
    // Workspace field #1: the real native docs/ first-Tab completion list.
    { type: "send", hex: textKeys("docs/") },
    { type: "send", hex: KEYS.tab },
    { type: "wait", marker: "alpha-smoke.md", timeoutMs: 30_000 },
    { type: "assert_screen", includes: ["alpha-smoke.md"] },
    // Esc dismisses the list first; the field text stays (a printable probe
    // key lands in the editor row, proving the list no longer swallows input).
    { type: "send", hex: KEYS.escape },
    { type: "send", hex: textKeys("Z") },
    { type: "assert_screen", includes: ["docs/Z"] },
    { type: "assert_latest", excludes: ["→ assets/"] },
    // Esc (no list visible) cancels the field: back at the task menu.
    { type: "send", hex: KEYS.escape },
    { type: "assert_latest", includes: ["Schedule (cron)"] },
    // Reopen Workspace and probe the absolute-token correction through the
    // real Pi terminal: both a directory and a file inside the synthetic
    // workspace must appear in Pi's file list, never slash-command items.
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Authorized target workspace directory", timeoutMs: 30_000 },
    { type: "send", hex: textKeys(`${workspace}/`) },
    // Typing the complete absolute prefix opens Pi's list immediately here;
    // assert that fresh render before Tab, since Tab then applies its first
    // directory selection rather than reopening the visible list.
    { type: "assert_latest", includes: ["→ docs/", "root-smoke.md"], excludes: ["→ /review-settings", "→ /subtasks"], timeoutMs: 30_000 },
    { type: "send", hex: KEYS.tab },
    { type: "assert_latest", includes: [`${workspace}/docs/`] },
    { type: "send", hex: KEYS.escape },
    { type: "assert_latest", includes: ["Schedule (cron)"] },
    // The task menu re-shows with the workspace row retained (issue #140);
    // move up to the Instructions field (same bridge seam) for the @ picker.
    { type: "send", hex: KEYS.up },
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Instructions for the scheduled subtask", timeoutMs: 30_000 },
    // The fd-backed @ picker lists real files from the synthetic workspace.
    { type: "send", hex: textKeys("@roo") },
    { type: "send", hex: KEYS.tab },
    // Frame-scoped and discriminating: "roo" fuzzy-matches only the
    // workspace-root fixture, which the docs/ prefix completion can never
    // surface, and the single fd-backed match auto-applies into the field
    // text — a persistent frame state assert_latest can check without racing
    // a transient list render.
    { type: "assert_latest", includes: ["@root-smoke.md"], timeoutMs: 30_000 },
    // Enter submits the applied value (the applied state submits; Esc would
    // first hit the completion handler): back at the task menu with the
    // instructions row highlighted.
    { type: "send", hex: KEYS.enter },
    { type: "assert_latest", includes: ["Schedule (cron)"] },
    // Back down to the workspace row; reopen the field for Ctrl+G.
    { type: "send", hex: KEYS.down },
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Authorized target workspace directory", timeoutMs: 30_000 },
    // Ctrl+G runs the external editor; its content lands in the field.
    { type: "send", hex: KEYS.ctrlG },
    { type: "wait", marker: "ext-edit-mark", timeoutMs: 30_000 },
    // Enter submits the field (never the chat): the task menu re-renders with
    // the staged workspace value.
    { type: "send", hex: KEYS.enter },
    { type: "assert_latest", includes: ["ext-edit-mark"] },
    // Reopen the workspace field: it prefills with the staged value.
    { type: "send", hex: KEYS.enter },
    { type: "wait", marker: "Authorized target workspace directory", timeoutMs: 30_000 },
    { type: "assert_latest", includes: ["ext-edit-mark"] },
    // Esc (no list visible) cancels the field itself.
    { type: "send", hex: KEYS.escape },
    { type: "assert_latest", excludes: ["Authorized target workspace directory"] },
    // Walk back out of every menu to the chat prompt.
    { type: "send", hex: KEYS.escape },
    { type: "assert_latest", includes: ["Add scheduled task"] },
    { type: "send", hex: KEYS.escape },
    { type: "assert_latest", includes: ["Review settings"] },
    { type: "send", hex: KEYS.escape },
    // Inspect only fresh output after the last Esc, not any prior menu/field
    // frame: no field text leaked into chat and no offline API-key error from
    // an accidental submission. This is a screen observation, not a proof
    // about unrendered internal state.
    { type: "settle", seconds: 2 },
    { type: "assert_latest", includes: ["operating mode:"], excludes: ["Review settings", "ext-edit-mark", "docs/Z", "No API key"] },
    // Ctrl+C twice is the documented host exit: proves real Ctrl+C delivery
    // end to end and tears the session down cleanly.
    { type: "send", hex: KEYS.ctrlC + KEYS.ctrlC },
    { type: "wait_exit", timeoutMs: 30_000 },
  ];
  await writeFile(join(sandbox, "steps.json"), JSON.stringify(steps));

  const result = await runDriver(driverPath, sandbox, cliEntry!, candidateEntry, dirname(fdBinary!));
  const failed = result.steps.filter((step) => !step.ok);
  const detail = failed.length > 0
    ? failed
        .map((step) => `step ${step.index} (${steps[step.index]?.type}): ${step.error ?? "unknown"}\nlast screen:\n${step.screen ?? ""}`)
        .join("\n---\n")
    : result.lastScreen;
  assert.ok(result.ok, `live TUI smoke failed:\n${detail}`);
  // The final documented Ctrl+C-twice exit must have terminated the process.
  assert.ok(!result.alive, "the pi process must have exited on the final Ctrl+C-twice exit");
});

/**
 * The PTY driver: forks a real pseudo-terminal, launches the candidate through
 * pi's public --no-extensions --extension seam with a scrubbed allowlisted
 * environment, and walks the scripted steps (steps.json in the sandbox) with
 * bounded waits. Writes a JSON verdict (per-step screens) to the result path
 * given as the second argument. Python stdlib only.
 */
const DRIVER_SOURCE = String.raw`
import os, pty, sys, time, select, signal, json, re, struct, fcntl, termios

sandbox, result_path = sys.argv[1:3]
steps = json.load(open(os.path.join(sandbox, "steps.json")))

home = os.path.join(sandbox, "home")
workspace = os.path.join(sandbox, "workspace")
os.makedirs(workspace, exist_ok=True)
os.makedirs(os.path.join(home, ".pi", "agent"), exist_ok=True)
with open(os.path.join(home, ".pi", "agent", "review-gate.json"), "w") as handle:
    handle.write("{}\n")
bin_dir = os.path.join(home, ".pi", "agent", "bin")
os.makedirs(bin_dir, exist_ok=True)
editor = os.path.join(bin_dir, "ext-editor.sh")
with open(editor, "w") as handle:
    handle.write('#!/bin/sh\n{ cat "$1"; echo "ext-edit-mark"; } > "$1.new" && mv "$1.new" "$1"\n')
os.chmod(editor, 0o700)

# Allowlisted environment: no PI_REVIEW_GATE_* (the extension must register its
# full interactive surface and must never touch a user's live config), no
# session/model state, no provider API keys -> no model/API call is possible.
allow = ("PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "LOGNAME", "USER", "NODE_BIN")
child_env = {key: os.environ[key] for key in allow if key in os.environ}
child_env["HOME"] = home
child_env["TERM"] = "xterm-256color"
child_env["EDITOR"] = editor
# Keep the child's finder resolution identical to the test's own prerequisite
# check: the directory holding the resolved fd/fdfind binary comes first.
fd_dir = os.environ.get("PRG_FD_DIR")
if fd_dir:
    child_env["PATH"] = fd_dir + os.pathsep + child_env.get("PATH", "")

argv = [os.environ.get("NODE_BIN", "node"), os.environ["PRG_PI_CLI"],
        "--no-extensions", "--extension", os.environ["PRG_CANDIDATE"],
        "--no-session", "--offline", "--no-context-files", "--no-skills",
        "--no-themes"]

pid, master = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.environ.clear()
    os.environ.update(child_env)
    try:
        os.execvp(argv[0], argv)
    except Exception:
        os._exit(127)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
os.set_blocking(master, False)

buffer = bytearray()
alive = [True]
last_send_offset = [0]

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end and alive[0]:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                alive[0] = False
                return
            if not data:
                alive[0] = False
                return
            buffer.extend(data)

def clean(text):
    text = text.decode("utf-8", "replace") if isinstance(text, bytes) else text
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
    return text.replace("\x1b>", "").replace("\x1b=", "")

def visible():
    return clean(bytes(buffer))

def screen():
    # A complete frame ends with the bottom status block containing
    # "operating mode:"; the newest complete frame is the text between the
    # previous and the last occurrence of that marker.
    text = visible()
    marker = "operating mode:"
    last = text.rfind(marker)
    if last == -1:
        raise RuntimeError("Pi status marker missing; cannot scope the current frame")
    prev = text.rfind(marker, 0, last)
    return text[prev + len(marker):] if prev != -1 else text[:last + len(marker)]

def latest():
    # Everything rendered after the newest status marker: the newest redraw
    # fragment, used for absence checks (pi-tui redraws incrementally).
    text = visible()
    marker = "operating mode:"
    last = text.rfind(marker)
    if last == -1:
        raise RuntimeError("Pi status marker missing; cannot scope the latest redraw")
    return text[last + len(marker):]

def fresh_since_send():
    return visible()[last_send_offset[0]:]

def wait_for(marker, timeout_ms):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline and alive[0]:
        if marker in fresh_since_send():
            return True
        pump(0.25)
    return marker in fresh_since_send()

def wait_exit(timeout_ms):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline and alive[0]:
        pump(0.25)
    return not alive[0]

def send(keys):
    last_send_offset[0] = len(visible())
    try:
        os.write(master, keys)
    except OSError:
        alive[0] = False

results = []
ok = True
for index, step in enumerate(steps):
    kind = step.get("type")
    entry = {"index": index, "ok": True}
    try:
        if not alive[0] and kind != "wait_exit":
            raise RuntimeError("pi exited before this step")
        if kind == "wait":
            if not wait_for(step["marker"], step.get("timeoutMs", 30000)):
                raise RuntimeError("timed out waiting for %r" % step["marker"])
        elif kind == "wait_exit":
            if not wait_exit(step.get("timeoutMs", 30000)):
                raise RuntimeError("pi did not exit within the deadline")
        elif kind == "send":
            send(bytes.fromhex(step["hex"]))
            pump(0.8)
        elif kind == "send_slow":
            keys = bytes.fromhex(step["hex"])
            for i in range(0, len(keys), 3):
                send(keys[i:i + 3])
                if not alive[0]:
                    break
                pump(step.get("delayMs", 120) / 1000.0)
            pump(0.5)
        elif kind == "settle":
            pump(step.get("seconds", 1.0))
        elif kind == "assert_latest":
            # Render output since the latest input, not a prior complete frame:
            # a repeated menu heading or reopened field title cannot satisfy
            # an assertion using stale screen history. screen()/latest() also
            # require the Pi status marker, failing loudly if that seam moves.
            deadline = time.time() + step.get("timeoutMs", 20000) / 1000.0
            includes = step.get("includes", [])
            current = ""
            while True:
                pump(0.4)
                screen()
                latest()
                current = fresh_since_send()
                if not includes or all(marker in current for marker in includes):
                    break
                if time.time() >= deadline:
                    break
            entry["screen"] = current[-2500:]
            for marker in includes:
                if marker not in current:
                    raise RuntimeError("fresh frame missing %r" % marker)
            for marker in step.get("excludes", []):
                if marker in current:
                    raise RuntimeError("fresh frame unexpectedly contains %r" % marker)
        elif kind == "assert_screen":
            current = visible()
            for marker in step.get("includes", []):
                if marker not in current:
                    pump(1.0)
                    current = visible()
                    if marker not in current:
                        raise RuntimeError("screen missing %r (buffer=%d)" % (marker, len(buffer)))
            for marker in step.get("excludes", []):
                if marker in current:
                    raise RuntimeError("screen unexpectedly contains %r" % marker)
        else:
            raise RuntimeError("unknown step type %r" % kind)
    except Exception as error:
        entry["ok"] = False
        entry["error"] = str(error)
        entry["screen"] = visible()[-3000:]
        ok = False
    results.append(entry)
    if not ok:
        break

try:
    os.killpg(os.getpgid(pid), signal.SIGKILL)
except Exception:
    pass

with open(result_path, "w") as handle:
    json.dump({"ok": ok, "alive": alive[0], "steps": results, "lastScreen": visible()[-3000:]}, handle)
sys.exit(0 if ok else 1)
`;