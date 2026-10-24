import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { createNativeInputEncoder, type NativeInputOrigin } from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/**
 * Process evidence for the owned external-editor PTY handoff (issue #499).
 *
 * This drives the REAL production launcher module of an installed Pi 1.3/1.4
 * runtime — `dist/modes/interactive/external-editor.js`, copied byte-for-byte out
 * of that installation into scratch and never modified — inside a real owned PTY,
 * with THIS working tree's compiled strict framed child preload installed before
 * main, and with real non-Node programs. It proves what a unit test cannot:
 *
 * - the handoff intercepts the launcher's ESM `spawn` import (the adapter is
 *   installed pre-main, before Pi's module graph instantiates);
 * - verified framed bytes become the editor's own input, and framing text never
 *   reaches the program's file;
 * - the program's own screen reaches this child's stdout, and its exit code and
 *   result-file content reach Pi's own `editInExternalEditor` semantics;
 * - a failing edit, a later edit, and an edit still open when the child dies all
 *   settle, with no program outliving the child that owned its terminal.
 *
 * The staged runtime root is the installed package's own manifest with its `bin`
 * entry pointed at a test driver, because the bridge attributes a child to a
 * runtime by its entry point. Only `package.json` and the launcher's own two
 * production modules are copied; nothing inside the installation is ever written.
 */

const LOCAL: NativeInputOrigin = Object.freeze({ kind: "local" });
const READY_MARKER = "prg-native-input-ready-v1;";
const MAX_STEP_MS = 30_000;

const nodeRequire = createRequire(__filename);

interface PtySurface {
  readonly pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

const nodePty = nodeRequire("@lydell/node-pty") as {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtySurface;
};

function installedRuntimeRoot(): string | undefined {
  for (const dir of findInstalledAgentDirs()) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      const launcher = readFileSync(join(dir, "dist", "modes", "interactive", "external-editor.js"), "utf8");
      if ((manifest.version === "1.3.0" || manifest.version === "1.4.0") && launcher.includes("stdio: \"inherit\"")) return dir;
    } catch {
      // Not a usable pinned runtime; try the next candidate.
    }
  }
  return undefined;
}

/** The compiled strict preload of THIS working tree, never an installed copy. */
const PRELOAD = join(__dirname, "..", "src", "session-host", "bootstrap-preload.js");
const HANDOFF = join(__dirname, "..", "src", "session-host", "native-editor-handoff.js");
const REPORTER = join(__dirname, "..", "src", "session-host", "reporter.js");

const DRIVER = `import { editInExternalEditor } from "./modes/interactive/external-editor.js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const edits = JSON.parse(process.env.PRG_DRIVER_EDITS ?? "[]");

if (process.env.PRG_NATIVE_DISPOSAL === "1") {
  // Stand in for the native host: activate this worktree's compiled reporter
  // extension, and on a real SIGTERM/SIGHUP perform the same disposal the installed
  // runtime performs — await every session_shutdown handler, then exit.
  const reporter = await import(pathToFileURL(process.env.PRG_REPORTER_MODULE).href);
  const hooks = new Map();
  const pi = { on: (name, handler) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); } };
  await (reporter.default ?? reporter.activate)(pi);
  // Liveness is observed by THIS process at the disposal boundary itself: an exit-time
  // best-effort cleanup could otherwise kill the editor after the marker is written and
  // make a missing settlement look correct to an outside poller.
  const pidFile = process.env.PRG_EDITOR_PID_FILE;
  const editorAlive = () => {
    let text = "";
    try { text = readFileSync(pidFile, "utf8"); } catch { return false; }
    try { process.kill(Number.parseInt(text.trim(), 10), 0); return true; } catch { return false; }
  };
  const dispose = async () => {
    process.stdout.write("PRG_NATIVE_DISPOSAL_START " + editorAlive() + "\\n");
    for (const handler of hooks.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown" }, pi);
    }
    process.stdout.write("PRG_NATIVE_DISPOSAL_DONE " + editorAlive() + "\\n");
    process.exit(0);
  };
  process.on("SIGTERM", () => { void dispose(); });
  process.on("SIGHUP", () => { void dispose(); });
  process.stdout.write("PRG_REPORTER_ACTIVATED\\n");
}
const settleModule = process.env.PRG_SETTLE_MODULE;
const settleWaitFile = process.env.PRG_SETTLE_WAIT_FILE;

/**
 * The awaited native shutdown, exactly as the reporter's graceful-shutdown request
 * performs it: stop the external editor this process owns and wait for its own exit
 * before the parent is allowed to complete.
 */
async function awaitNativeShutdownSettlement() {
  if (settleWaitFile !== undefined) {
    const deadline = Date.now() + 20000;
    while (!existsSync(settleWaitFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Give the program a moment on screen, like a user mid-edit.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const handoff = await import(pathToFileURL(settleModule).href);
  process.stdout.write("PRG_SETTLE_START\\n");
  const settled = await handoff.settleOwnedNativeEditor();
  process.stdout.write("PRG_SETTLE_RESULT " + String(settled) + "\\n");
}

let index = 0;
for (const edit of edits) {
  index += 1;
  process.stdout.write("PRG_EDIT_START " + index + "\\n");
  const editing = editInExternalEditor({ content: edit.content ?? "", command: edit.command });
  if (settleModule !== undefined && index === Number(process.env.PRG_SETTLE_EDIT ?? "1")) {
    await awaitNativeShutdownSettlement();
  }
  const result = await editing;
  process.stdout.write("PRG_RESULT " + index + " " + JSON.stringify(result) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
}
process.stdout.write("PRG_DRIVER_DONE\\n");
`;

interface StagedEdit {
  readonly command: string;
  readonly content?: string;
}

interface Child {
  readonly bootstrap: SessionHostBootstrap;
  readonly root: string;
  output(): string;
  /** Wait until `predicate(output())`; failure shows a redacted tail. */
  waitFor(label: string, predicate: (output: string) => boolean): Promise<string>;
  /** Wait for `needle`, then for the terminal to stop producing output. */
  settle(needle: string): Promise<string>;
  send(payload: Buffer): void;
  kill(signal?: string): void;
  exited(): boolean;
  dispose(): Promise<void>;
}

async function startChild(
  runtime: string,
  edits: readonly StagedEdit[],
  extraEnv: Record<string, string> = {},
): Promise<Child> {
  const root = mkdtempSync(join(tmpdir(), "prg-editor-pty-"));
  mkdirSync(join(root, "dist", "modes", "interactive"), { recursive: true });
  mkdirSync(join(root, "dist", "utils"), { recursive: true });
  // The real launcher module, unmodified, plus its only import.
  cpSync(join(runtime, "dist", "modes", "interactive", "external-editor.js"),
    join(root, "dist", "modes", "interactive", "external-editor.js"));
  cpSync(join(runtime, "dist", "utils", "text.js"), join(root, "dist", "utils", "text.js"));
  const manifest = JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.bin = { pi: "dist/editor-handoff-driver.mjs" };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(root, "dist", "editor-handoff-driver.mjs"), DRIVER, "utf8");

  // A real host socket, so the child's reporter behaves normally. It never has to
  // answer: the editor handoff is independent of reporter readiness.
  const socketPath = join(root, "h.sock");
  const server: Server = createServer((socket) => { socket.on("error", () => { /* the child may close first */ }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const bootstrap: SessionHostBootstrap = {
    version: 1,
    socketPath,
    token: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    generation: randomUUID(),
    inputOriginFraming: 1,
  };
  let output = "";
  let exit: { exitCode: number; signal?: number } | undefined;
  const encoder = createNativeInputEncoder(bootstrap);
  const pty = nodePty.spawn(process.execPath, ["--require", PRELOAD, join(root, "dist", "editor-handoff-driver.mjs")], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: root,
    // An explicit allowlist, never the ambient environment: the child must not
    // inherit this worker's session-host role marker, live agent directory, or
    // NODE_OPTIONS, any of which would change what the preload does.
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: root,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      [SESSION_HOST_BOOTSTRAP_ENV]: JSON.stringify(bootstrap),
      PRG_DRIVER_EDITS: JSON.stringify(edits),
      ...extraEnv,
    },
  });
  pty.onData((chunk) => { output += chunk; });
  const exited = new Promise<void>((resolve) => { pty.onExit((event) => { exit = event; resolve(); }); });

  const child: Child = {
    bootstrap,
    root,
    output: () => output,
    async waitFor(label, predicate) {
      const deadline = Date.now() + MAX_STEP_MS;
      for (;;) {
        if (predicate(output)) return output;
        if (exit !== undefined) throw new Error(`${label}: the child exited (${exit.exitCode}/${exit.signal}) with:\n${tail(output)}`);
        if (Date.now() > deadline) throw new Error(`${label}: timed out with:\n${tail(output)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async settle(needle) {
      await child.waitFor(`the ${needle} marker`, (value) => value.includes(needle));
      // Let a just-started program finish painting before the next dispatch is
      // typed: 1.2s of silence, restarting whenever the terminal produces more.
      let previous = output.length;
      let idle = 0;
      for (; idle < 12;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        idle = output.length === previous ? idle + 1 : 0;
        previous = output.length;
      }
      return output;
    },
    send: (payload) => { pty.write(encoder.encode(payload, LOCAL)); },
    kill: (signal) => { pty.kill(signal); },
    exited: () => exit !== undefined,
    async dispose() {
      if (exit === undefined) { try { pty.kill("SIGHUP"); } catch { /* already gone */ } }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
  return child;
}

/** Failure evidence only: the terminal tail, with framing and secrets withheld. */
function tail(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "<osc>")
    .replace(/prg-ni-v2;[0-9a-f]{16};\d+;[A-Za-z0-9_-]+;[0-9a-f]{64};/g, "<frame>")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "<encoded>")
    .slice(-2_000);
}

function result(output: string, index: number): { status: string; content?: string } {
  const match = new RegExp(`PRG_RESULT ${index} (\\{[^\\n]*\\})`).exec(output);
  assert.ok(match !== null, `the launcher returned result ${index}: ${tail(output)}`);
  return JSON.parse(match[1]!) as { status: string; content?: string };
}

/** PIDs of processes whose command line contains `marker`, excluding this test. */
function pidsMatching(marker: string): number[] {
  const found = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  if (found.error !== undefined) throw found.error;
  return found.stdout.split("\n").map((line) => Number.parseInt(line, 10)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const runtime = installedRuntimeRoot();
const skip = available() ? false : "no installed Pi 1.3/1.4 runtime with the external-editor launcher";
function available(): boolean { return runtime !== undefined && process.platform !== "win32"; }

test("handoff: a real editor launched by the production Pi launcher edits and returns through its own terminal", { skip }, async (t) => {
  const child = await startChild(runtime!, [{ command: "vim -u NONE -i NONE", content: "seed\n" }]);
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  await child.settle("Launching external editor");
  // A real terminal answers the terminal queries an editor writes at startup;
  // nothing answers them here, so this first dispatch absorbs any byte the editor
  // discards while it waits. Escape is a no-op in Vim's normal mode.
  child.send(Buffer.from("\x1b", "utf8"));
  child.send(Buffer.from("i", "utf8"));
  child.send(Buffer.from("h\u00e9llo \ud83d\ude80", "utf8"));
  child.send(Buffer.from("\x1b", "utf8"));
  child.send(Buffer.from(":wq\r", "utf8"));
  const done = await child.waitFor("the editor result", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(result(done, 1), { status: "complete", content: "héllo 🚀seed" },
    "the typed text reached Pi's result file byte-for-byte");
  assert.match(child.output(), /prompt\.md/, "the editor's own screen reached this child's stdout");
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
});

test("handoff: a non-Node program receives the verified bytes, not the framing text", { skip }, async (t) => {
  const sinkRoot = mkdtempSync(join(tmpdir(), "prg-editor-sink-"));
  t.after(() => rmSync(sinkRoot, { recursive: true, force: true }));
  const out = join(sinkRoot, "bytes.bin");
  // A canonical-mode-safe payload: no CR, no INTR/SUSP/EOF byte, terminated by LF.
  const payload = Buffer.from("x\x1b[200~héllo — 🚀\x1b[201~ ok\n", "utf8");
  const child = await startChild(runtime!, [{ command: `tee ${out}` }]);
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  await child.settle("Launching external editor");
  child.send(payload);
  // The program ends its own input with EOF, exactly as a user leaves an editor.
  child.send(Buffer.from("\x04", "utf8"));
  const done = await child.waitFor("the byte sink result", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(readFileSync(out), payload, "exactly the authenticated payload bytes reached the program");
  assert.equal(readFileSync(out).includes("prg-ni-v2"), false, "no framing text ever entered the program");
  assert.deepEqual(result(done, 1), { status: "complete", content: payload.toString("utf8").replace(/\n$/, "") },
    "the same bytes reached Pi's own result file, and Pi's content semantics are untouched");
});

test("handoff: a configured editor that changes the draft and dies by signal is a failed edit", { skip }, async (t) => {
  // A real configured wrapper, whatever it is: it accepts Pi's file argument, writes
  // a result, then terminates itself by signal. A PTY reports that as a zero exit
  // code WITH a live signal, which must never reach the launcher as success.
  const scratch = mkdtempSync(join(tmpdir(), "prg-editor-signal-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const wrapper = join(scratch, "signal-editor.sh");
  writeFileSync(wrapper, "#!/bin/sh\nprintf 'changed by the editor\\n' > \"$1\"\nkill -TERM $$\n", { mode: 0o755 });
  const child = await startChild(runtime!, [{ command: wrapper, content: "draft\n" }]);
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const done = await child.waitFor("the signal-killed editor result", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(result(done, 1), { status: "failed" },
    `a signal death never accepts the result file: ${tail(done)}`);
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
});

test("handoff: a failing edit and a later edit both settle", { skip }, async (t) => {
  const sinkRoot = mkdtempSync(join(tmpdir(), "prg-editor-sink-"));
  t.after(() => rmSync(sinkRoot, { recursive: true, force: true }));
  const child = await startChild(runtime!, [
    { command: "this-editor-does-not-exist-499" },
    { command: `tee ${join(sinkRoot, "second.bin")}` },
  ]);
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const first = await child.waitFor("the failed edit", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(result(first, 1), { status: "failed" }, "a launch that cannot start is Pi's own failed result");
  await child.settle("PRG_RESULT 1");
  child.send(Buffer.from("abc\n", "utf8"));
  child.send(Buffer.from("\x04", "utf8"));
  const second = await child.waitFor("the later edit", (value) => value.includes("PRG_RESULT 2 "));
  assert.deepEqual(result(second, 2), { status: "complete", content: "abc" },
    `a later edit still works after a failed one: ${tail(second)}`);
  assert.equal(readFileSync(join(sinkRoot, "second.bin")).toString(), "abc\n", "and it still owns its own terminal");
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
});

test("handoff: a program still open when the child dies does not outlive it", { skip }, async (t) => {
  // `tail -f` is not an editor at all: the handoff routes Pi's generic launch,
  // never a particular program. It ignores stdin and never exits on its own.
  const marker = "tail -f /dev/null";
  const before = new Set(pidsMatching(marker));
  const child = await startChild(runtime!, [{ command: marker, content: "keep open\n" }]);
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  await child.settle("Launching external editor");
  const editors = pidsMatching(marker).filter((pid) => !before.has(pid));
  assert.equal(editors.length, 1, `the launch owns exactly one program: ${editors.join(",")}`);
  const editor = editors[0]!;
  assert.ok(alive(editor), "the owned program is running on its own terminal");
  assert.equal(child.exited(), false, "and the child is waiting for it");

  // The host closes the row: the child's PTY dies with the editor still open. The
  // editor is a separate PTY session, so the only honest witness is its own
  // disappearance after its owner's master closes.
  child.kill("SIGHUP");
  const deadline = Date.now() + MAX_STEP_MS;
  for (; alive(editor);) {
    if (Date.now() > deadline) {
      assert.fail("the nested program survived the child that owned its terminal; the child must settle it before exiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(!alive(editor), "the owned program is gone");
});

test("handoff: the awaited native shutdown settles a real open editor before the parent completes", { skip }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "prg-editor-shutdown-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pidFile = join(scratch, "editor.pid");
  // Any configured editor: it records its own process id, then stays open and ignores
  // input, like a user still mid-edit when the host asks the session to stop.
  const wrapper = join(scratch, "stay-open-editor.sh");
  writeFileSync(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec tail -f /dev/null\n`, { mode: 0o755 });
  const child = await startChild(runtime!, [{ command: wrapper, content: "keep open\n" }], {
    PRG_SETTLE_MODULE: HANDOFF,
    PRG_SETTLE_WAIT_FILE: pidFile,
  });
  t.after(() => child.dispose());
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const settledOutput = await child.waitFor("the awaited shutdown settlement", (value) => value.includes("PRG_SETTLE_RESULT "));
  assert.ok(settledOutput.includes("PRG_SETTLE_RESULT true"),
    `the settlement witnessed the editor's own exit: ${tail(settledOutput)}`);
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the editor reported its own process id");
  assert.ok(!alive(pid), "the owned editor was gone before the awaited shutdown returned");
  assert.equal(child.exited(), false, "settling the editor is not the child exiting");
  const done = await child.waitFor("the edit result", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(result(done, 1), { status: "failed" },
    `an editor stopped by shutdown is Pi's own failed result: ${tail(done)}`);
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
});

test("handoff: native SIGTERM disposal settles a real open editor before the child exits", { skip }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "prg-editor-native-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pidFile = join(scratch, "editor.pid");
  const wrapper = join(scratch, "stay-open-editor.sh");
  writeFileSync(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec tail -f /dev/null\n`, { mode: 0o755 });
  const child = await startChild(runtime!, [{ command: wrapper, content: "keep open\n" }], {
    PRG_NATIVE_DISPOSAL: "1",
    PRG_REPORTER_MODULE: REPORTER,
    PRG_EDITOR_PID_FILE: pidFile,
  });
  t.after(() => child.dispose());
  await child.waitFor("the reporter extension activating in the child", (value) => value.includes("PRG_REPORTER_ACTIVATED"));
  await child.settle("Launching external editor");
  await child.waitFor("the editor's own process id", () => {
    try { return readFileSync(pidFile, "utf8").trim().length > 0; } catch { return false; }
  });
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the editor reported its own process id");
  assert.ok(alive(pid), "the configured editor is open on its own terminal");

  // The host's POSIX stop: a real signal to the child, whose awaited extension
  // disposal must settle the editor before native disposal is reported complete.
  child.kill("SIGTERM");
  const disposed = await child.waitFor("native disposal to finish", (value) => value.includes("PRG_NATIVE_DISPOSAL_DONE "));
  assert.ok(disposed.includes("PRG_NATIVE_DISPOSAL_START true"),
    `the editor was open when native disposal began: ${tail(disposed)}`);
  assert.ok(disposed.includes("PRG_NATIVE_DISPOSAL_DONE false"),
    `the child itself reports the editor gone when native disposal completes: ${tail(disposed)}`);
  assert.ok(!alive(pid), "and the owned editor is really gone");
  await child.waitFor("the child exiting after disposal", () => child.exited());
});
