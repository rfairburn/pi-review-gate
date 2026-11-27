import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer, Socket, type Server } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";

import { SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { createNativeInputEncoder, type NativeInputOrigin } from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { disposableFixtureBase } from "./helpers/scratch-fixture-base";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/**
 * Process evidence for the owned external-editor PTY handoff (issue #499).
 *
 * This drives the REAL production launcher module of an installed audited Pi
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
 *
 * Containment (issue #354): the real launcher creates its `pi-editor-*` prompt
 * directory under `os.tmpdir()`, and an abrupt child exit (a hang-up or the
 * native disposal's `process.exit`) skips its own best-effort removal. The PTY
 * child's environment is an explicit allowlist, so without TMPDIR/TEMP/TMP the
 * launcher would fall back to the host's shared temporary directory. Every
 * fixture therefore owns one private root that holds the staged runtime, the
 * test's own editor scripts and sinks, and a verified private directory that is
 * the child's only TMPDIR/TEMP/TMP. Its single cleanup is registered before any
 * fallible setup and settles, with bounded checks, the PTY child, every process
 * whose command line names that private root, the host socket server and its
 * connections, and finally the root itself. A settlement it cannot confirm fails
 * the test, retains the root, and (inside a test-scratch invocation root) records
 * a cleanup refusal. PI_TEST_SCRATCH_PRESERVE=1 keeps files only; processes and
 * handles are always torn down.
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

/**
 * The audited runtimes this process evidence may run against. The list is closed and
 * additive: an unlisted installed runtime is never used, and the launcher's own source
 * must still state the inherited-stdio launch this adapter recognizes. Pi 1.6.1 is
 * listed after checking its shipped launcher: `editInExternalEditor` still spawns the
 * configured editor with inherited stdio; 1.6.1 only adds a reported failure instead of
 * a throw when the editor's temporary prompt file cannot be written.
 */
const AUDITED_PI_VERSIONS: readonly string[] = ["1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.6.0", "1.6.1"];

function installedRuntimeRoot(): string | undefined {
  for (const dir of findInstalledAgentDirs()) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      const launcher = readFileSync(join(dir, "dist", "modes", "interactive", "external-editor.js"), "utf8");
      if (AUDITED_PI_VERSIONS.includes(manifest.version ?? "")
        && launcher.includes("export async function editInExternalEditor")
        && launcher.includes("stdio: \"inherit\"")) return dir;
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
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const edits = JSON.parse(process.env.PRG_DRIVER_EDITS ?? "[]");
// The temporary directory the copied launcher will use, as this process resolves it.
process.stdout.write("PRG_TMPDIR " + JSON.stringify(tmpdir()) + "\\n");

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
  /** The staged runtime root: the child's cwd and HOME. */
  readonly root: string;
  output(): string;
  /** Wait until `predicate(output())`; failure shows a redacted tail. */
  waitFor(label: string, predicate: (output: string) => boolean): Promise<string>;
  /** Wait for `needle`, then for the terminal to stop producing output. */
  settle(needle: string): Promise<string>;
  send(payload: Buffer): void;
  kill(signal?: string): void;
  exited(): boolean;
}

/** One test's owned resources; see the containment note at the top of this file. */
interface Fixture {
  /** The private fixture root; every owned file lives beneath it. */
  readonly root: string;
  /** The test's own editor scripts, sinks, and pid/path records. */
  readonly scratch: string;
  /** The verified private directory that is the child's only TMPDIR/TEMP/TMP. */
  readonly temp: string;
  /** Start the single PTY child this fixture owns. */
  start(edits: readonly StagedEdit[], extraEnv?: Record<string, string>): Promise<Child>;
  /** Entries in the child's private temporary directory. */
  tempEntries(): string[];
}

interface FixtureState {
  root?: string;
  rootReceipt?: BigIntStats;
  temp?: string;
  tempReceipt?: BigIntStats;
  /** `NAME=nonce` given only to this fixture's PTY launch, and inherited by what it starts. */
  ownerMarker?: string;
  server?: Server;
  socketPath?: string;
  /** Device/inode of the socket entry this fixture's own bind created, taken in the bind's tick. */
  socketReceipt?: BigIntStats;
  /** The empty private directory, reserved before any bind, in which the broker is closed. */
  closeDir?: string;
  closeReceipt?: BigIntStats;
  /** Descendants of the PTY child, captured before teardown stops it. */
  snapshot: readonly ProcessIdentity[];
  readonly sockets: Set<Socket>;
  /** A native launch may have forked even if node-pty never returned a handle. */
  ptyLaunchUnconfirmed?: boolean;
  pty?: PtySurface;
  exit?: { exitCode: number; signal?: number };
  readonly listeners: { dispose(): void }[];
}

/** Bounded settlement windows for the fixture's own teardown. */
const SETTLE_MS = 5_000;
/** Production settles a nested editor asynchronously; observe before intervening. */
const ORPHAN_GRACE_MS = 3_000;
/** Each cleanup diagnostic line is bounded, and so is the number of lines reported. */
const MAX_DIAGNOSTIC_CHARS = 1_000;
const MAX_DIAGNOSTIC_LINES = 12;
/** Filesystem-only evidence retention exported by scripts/test-scratch.cjs --preserve. */
const PRESERVE_FILES = process.env.PI_TEST_SCRATCH_PRESERVE === "1";

const { signalCleanupRefusal } = nodeRequire(join(__dirname, "..", "..", "scripts", "test-scratch-refusal.cjs")) as {
  signalCleanupRefusal(reason: string): () => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await delay(25);
  }
}

function bounded(line: string): string {
  return line.length <= MAX_DIAGNOSTIC_CHARS ? line : `${line.slice(0, MAX_DIAGNOSTIC_CHARS)}… (${line.length - MAX_DIAGNOSTIC_CHARS} more chars)`;
}

function boundedLines(lines: readonly string[]): string[] {
  const shown = lines.slice(0, MAX_DIAGNOSTIC_LINES).map(bounded);
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more`);
  return shown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A directory this process just created for its own exclusive use: a real
 * directory (never a symlink), at its canonical path, owned by this user, with
 * no group/other access. Anything else is refused rather than handed to a child.
 */
function verifiedPrivateDirectory(path: string): BigIntStats {
  const entry = lstatSync(path, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`not a real directory: ${path}`);
  if (realpathSync(path) !== path) throw new Error(`not at its canonical path: ${path}`);
  if (typeof process.getuid === "function" && entry.uid !== BigInt(process.getuid())) {
    throw new Error(`not owned by this user: ${path}`);
  }
  if ((entry.mode & 0o077n) !== 0n) throw new Error(`not private (mode ${(entry.mode & 0o777n).toString(8)}): ${path}`);
  return entry;
}

/** A private directory (see above) that is also empty, and, given a receipt, still that one. */
function verifiedEmptyCloseDirectory(path: string, receipt?: BigIntStats): BigIntStats {
  const entry = verifiedPrivateDirectory(path);
  if (receipt !== undefined && (entry.dev !== receipt.dev || entry.ino !== receipt.ino)) {
    throw new Error(`the close directory was replaced: ${path}`);
  }
  if (readdirSync(path).length !== 0) throw new Error(`the close directory is not empty: ${path}`);
  return entry;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One process at one point in time: its pid and the kernel's start time for it. */
interface ProcessIdentity {
  readonly pid: number;
  readonly start: string;
}

/** Process identity (start time, ancestry, environment) is verifiable only through procfs. */
const PROC_IDENTITY = process.platform === "linux" && existsSync("/proc/self/stat");

/** `/proc/<pid>/stat` after the command name: state (field 3), ppid (4), starttime (22). */
function procStat(pid: number): { state: string; ppid: number; start: string } | undefined {
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const start = fields[19];
  if (fields[0] === undefined || start === undefined) return undefined;
  return { state: fields[0], ppid: Number.parseInt(fields[1] ?? "", 10), start };
}

/**
 * Every live descendant of `ancestor`, captured while the ancestry still exists.
 * Each identity's start time comes from the same `/proc` row as its parent pid.
 */
function descendantsOf(ancestor: number): ProcessIdentity[] {
  if (!PROC_IDENTITY) return [];
  const children = new Map<number, ProcessIdentity[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = procStat(Number(name));
    if (stat !== undefined && stat.state !== "Z" && stat.state !== "X") {
      const siblings = children.get(stat.ppid) ?? [];
      siblings.push({ pid: Number(name), start: stat.start });
      children.set(stat.ppid, siblings);
    }
  }
  const found: ProcessIdentity[] = [];
  const seen = new Set([ancestor]);
  for (const queue = [ancestor]; queue.length > 0;) {
    for (const identity of children.get(queue.shift()!) ?? []) {
      if (seen.has(identity.pid)) continue;
      seen.add(identity.pid);
      found.push(identity);
      queue.push(identity.pid);
    }
  }
  return found;
}

function environHas(pid: number, entry: string): boolean | undefined {
  try {
    return readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").includes(entry);
  } catch {
    return undefined;
  }
}

type Ownership =
  | { readonly kind: "gone" }
  | { readonly kind: "owned"; readonly identity: ProcessIdentity; readonly via: string }
  | { readonly kind: "ambiguous"; readonly pid: number; readonly reason: string };

/**
 * The current identity of `pid`. A pid whose identity cannot be read while it is
 * still alive is ambiguous, never assumed gone.
 */
function observeIdentity(pid: number): ProcessIdentity | Extract<Ownership, { kind: "gone" | "ambiguous" }> {
  const stat = procStat(pid);
  if (stat === undefined) {
    return alive(pid)
      ? { kind: "ambiguous", pid, reason: "the live pid's process identity is unreadable" }
      : { kind: "gone" };
  }
  if (stat.state === "Z" || stat.state === "X") return { kind: "gone" };
  return { pid, start: stat.start };
}

/**
 * Whether a live process is positively this fixture's. A command line that merely
 * names the fixture root is only a candidate (an unrelated process inspecting the
 * fixture can name it, and even use its TMPDIR): ownership is a captured PTY-child
 * descendant with the same start time, or an environment carrying the per-launch
 * ownership nonce that only the PTY launch receives and what it starts inherits.
 * Anything else is ambiguous.
 */
function classifyProcess(pid: number, snapshot: readonly ProcessIdentity[], marker: string | undefined): Ownership {
  if (!PROC_IDENTITY) {
    return alive(pid) ? { kind: "ambiguous", pid, reason: "process identity is not verifiable on this platform" } : { kind: "gone" };
  }
  const identity = observeIdentity(pid);
  if ("kind" in identity) return identity;
  if (snapshot.some((entry) => entry.pid === pid && entry.start === identity.start)) {
    return { kind: "owned", identity, via: "a captured descendant of the fixture's PTY child" };
  }
  const inherited = marker === undefined ? false : environHas(pid, marker);
  // The environment read must belong to the same process, not a reused pid.
  const checked = observeIdentity(pid);
  if ("kind" in checked) return checked;
  if (checked.start !== identity.start) return { kind: "gone" };
  if (inherited === true) return { kind: "owned", identity, via: "it carries the PTY launch's ownership marker" };
  return {
    kind: "ambiguous",
    pid,
    reason: inherited === undefined
      ? "its environment is unreadable"
      : "it is neither a captured descendant nor carries the PTY launch's ownership marker",
  };
}

type Survey =
  | { readonly owned: readonly Ownership[]; readonly ambiguous: readonly Ownership[] }
  | { readonly error: string };

/**
 * Candidates are processes whose command line names the fixture root plus the
 * captured descendants; each is classified, never assumed. A captured descendant
 * whose pid now has another start time is gone; one whose live identity cannot be
 * read is ambiguous.
 */
function surveyProcesses(root: string, snapshot: readonly ProcessIdentity[], marker: string | undefined): Survey {
  const found = spawnSync("pgrep", ["-f", escapeRegExp(root)], { encoding: "utf8", timeout: SETTLE_MS });
  if (found.error !== undefined) return { error: `pgrep failed: ${found.error.message}` };
  if (found.status !== 0 && found.status !== 1) {
    return { error: `pgrep exited ${String(found.status)}/${String(found.signal)}: ${found.stderr.trim()}` };
  }
  const named = found.stdout.split("\n").map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  const owned: Ownership[] = [];
  const ambiguous: Ownership[] = [];
  for (const pid of named) {
    const ownership = classifyProcess(pid, snapshot, marker);
    if (ownership.kind === "owned") owned.push(ownership);
    else if (ownership.kind === "ambiguous") ambiguous.push(ownership);
  }
  for (const entry of snapshot) {
    if (named.includes(entry.pid)) continue;
    const current = observeIdentity(entry.pid);
    if ("kind" in current) {
      if (current.kind === "ambiguous") ambiguous.push(current);
    } else if (current.start === entry.start) {
      owned.push({ kind: "owned", identity: entry, via: "a captured descendant of the fixture's PTY child" });
    }
  }
  return { owned, ambiguous };
}

/** SIGKILL `expected` only if, right now, it is still the same positively owned process. */
function killIfStillOwned(expected: ProcessIdentity, snapshot: readonly ProcessIdentity[], marker: string | undefined): void {
  const now = classifyProcess(expected.pid, snapshot, marker);
  if (now.kind !== "owned" || now.identity.start !== expected.start) return;
  try { process.kill(expected.pid, "SIGKILL"); } catch { /* already gone; the next survey decides */ }
}

function ownedPids(list: readonly Ownership[]): number[] {
  return list.flatMap((entry) => entry.kind === "owned" ? [entry.identity.pid] : entry.kind === "ambiguous" ? [entry.pid] : []);
}

function describeProcesses(pids: readonly number[]): string {
  const listed = spawnSync("ps", ["-o", "pid=,args=", "-p", pids.join(",")], { encoding: "utf8", timeout: SETTLE_MS });
  const text = listed.error === undefined ? listed.stdout.trim() : "";
  return text.length > 0 ? text.replace(/\s*\n\s*/g, "; ") : pids.join(",");
}

/** Relative entries below `dir`, for evidence only; never followed through symlinks. */
function listTree(dir: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    entries.push(name);
    if (entry.isDirectory()) entries.push(...listTree(join(dir, entry.name), name + "/"));
  }
  return entries;
}

/** Whether `candidate` (a canonical path) lies strictly inside the canonical `parent`. */
function strictlyInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Run a synchronous path operation with `directory` as this process's cwd. */
function inDirectory<T>(directory: string, action: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try { return action(); } finally { process.chdir(previous); }
}

/** Teardown state behind each fixture, reachable only by this file's self-tests. */
const fixtureStates = new WeakMap<Fixture, FixtureState>();

/**
 * Allocate a fixture whose single cleanup is registered before anything that
 * can fail, so a setup error never strands its root, server, or child. The short
 * prefixes keep nested socket paths within the 103-byte Darwin Unix-socket limit.
 */
function createFixture(t: TestContext): Fixture {
  const state: FixtureState = { sockets: new Set(), listeners: [], snapshot: [] };
  t.after(() => disposeFixture(t, state));

  const root = mkdtempSync(join(disposableFixtureBase(), "ep-"));
  state.root = root;
  state.rootReceipt = verifiedPrivateDirectory(root);
  const stage = join(root, "pi");
  const scratch = join(root, "scratch");
  const temp = join(root, "tmp");
  state.temp = temp;
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  // Reserved now, before any listener can exist, so that closing one never needs a
  // new allocation; a reservation that cannot be verified keeps no receipt and so
  // fails closed both here (startBroker refuses) and in teardown.
  // The intended path is recorded before mkdir: if it is already occupied, teardown
  // must find (and refuse) that entry rather than delete it unverified.
  const closeDir = join(root, "ec");
  state.closeDir = closeDir;
  mkdirSync(closeDir, { mode: 0o700 });
  state.closeReceipt = verifiedEmptyCloseDirectory(closeDir);
  state.socketPath = join(root, "h.sock");
  mkdirSync(temp, { mode: 0o700 });
  const tempReceipt = verifiedPrivateDirectory(temp);
  state.tempReceipt = tempReceipt;

  const fixture: Fixture = {
    root,
    scratch,
    temp,
    tempEntries: () => readdirSync(temp).sort(),
    start: async (edits, extraEnv = {}) => {
      if (state.pty !== undefined || state.server !== undefined) throw new Error("a fixture owns exactly one child");
      return startChild(state, stage, temp, edits, extraEnv);
    },
  };
  fixtureStates.set(fixture, state);
  return fixture;
}

/**
 * The real host socket, so the child's reporter behaves normally. It never has to
 * answer: the editor handoff is independent of reporter readiness. Every
 * connection is tracked so teardown can settle it. It binds by a relative name so
 * that closing it later can be pointed away from the fixture's pathname, and the
 * entry it created is receipted so teardown removes only that entry.
 */
async function startBroker(state: FixtureState): Promise<string> {
  const socketPath = state.socketPath!;
  if (reservedCloseDirectory(state) === undefined) {
    throw new Error(`the broker's close directory is not reserved and verified: ${String(state.closeDir)}`);
  }
  if (lstatSync(socketPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`the host socket path is already occupied: ${socketPath}`);
  }
  const server: Server = createServer((socket) => {
    state.sockets.add(socket);
    socket.on("close", () => { state.sockets.delete(socket); });
    socket.on("error", () => { /* the child may close first */ });
  });
  state.server = server;
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      // A failed listen created no entry of ours: whatever occupies the path is not receipted.
      state.socketReceipt = undefined;
      reject(error);
    });
    server.once("listening", () => resolve());
  });
  listening.catch(() => { /* observed below, or superseded by a setup error */ });
  // A pipe server binds synchronously inside listen(); its `listening` (or `error`)
  // event is only delivered on a later tick. The entry is receipted in the bind's
  // own tick, so nothing that runs before `listening` can be receipted as ours.
  inDirectory(dirname(socketPath), () => { server.listen("h.sock"); });
  if (!server.listening) {
    // The bind failed: Node reports why on a later tick. Propagate that original
    // error (e.g. EACCES) and record no receipt for whatever occupies the path.
    await listening;
    throw new Error(`the broker neither bound nor reported a listen error: ${socketPath}`);
  }
  const bound = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
  if (bound === undefined || !bound.isSocket()) throw new Error(`the broker did not create its socket: ${socketPath}`);
  state.socketReceipt = bound;
  await listening;
  const current = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
  if (current === undefined || !current.isSocket() || current.dev !== bound.dev || current.ino !== bound.ino) {
    throw new Error(`the host socket entry was replaced before the broker was listening: ${socketPath}`);
  }
  return socketPath;
}

/**
 * Whether the close reservation is settled: never attempted, attempted but
 * confirmed absent (its allocation created nothing), or still exactly the verified
 * empty directory. An existing or unreadable entry without that receipt is not.
 */
function closeReservationSettled(state: FixtureState): boolean {
  if (state.closeDir === undefined) return true;
  if (state.closeReceipt === undefined) {
    try { return lstatSync(state.closeDir, { throwIfNoEntry: false }) === undefined; } catch { return false; }
  }
  return reservedCloseDirectory(state) !== undefined;
}

/** The reserved close directory, only while it is still exactly that verified empty directory. */
function reservedCloseDirectory(state: FixtureState): string | undefined {
  const { closeDir, closeReceipt } = state;
  if (closeDir === undefined || closeReceipt === undefined) return undefined;
  try {
    verifiedEmptyCloseDirectory(closeDir, closeReceipt);
    return closeDir;
  } catch {
    return undefined;
  }
}

async function startChild(
  state: FixtureState,
  root: string,
  temp: string,
  edits: readonly StagedEdit[],
  extraEnv: Record<string, string>,
): Promise<Child> {
  mkdirSync(join(root, "dist", "modes", "interactive"), { recursive: true });
  mkdirSync(join(root, "dist", "utils"), { recursive: true });
  // The real launcher module, unmodified, plus its only import.
  cpSync(join(runtime!, "dist", "modes", "interactive", "external-editor.js"),
    join(root, "dist", "modes", "interactive", "external-editor.js"));
  cpSync(join(runtime!, "dist", "utils", "text.js"), join(root, "dist", "utils", "text.js"));
  const manifest = JSON.parse(readFileSync(join(runtime!, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.bin = { pi: "dist/editor-handoff-driver.mjs" };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(root, "dist", "editor-handoff-driver.mjs"), DRIVER, "utf8");

  const socketPath = await startBroker(state);

  const bootstrap: SessionHostBootstrap = {
    version: 1,
    socketPath,
    token: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    generation: randomUUID(),
    inputOriginFraming: 1,
  };
  let output = "";
  const encoder = createNativeInputEncoder(bootstrap);
  const ownerNonce = randomUUID();
  // The last synchronous step before the child receives it: the same verified
  // private directory, after staging and the awaited broker startup.
  const currentTemp = verifiedPrivateDirectory(temp);
  const expectedTemp = state.tempReceipt;
  if (expectedTemp === undefined || currentTemp.dev !== expectedTemp.dev || currentTemp.ino !== expectedTemp.ino) {
    throw new Error(`the private temporary directory was replaced: ${temp}`);
  }
  state.ownerMarker = `PRG_TEST_PTY_OWNER=${ownerNonce}`;
  state.ptyLaunchUnconfirmed = true;
  const pty = nodePty.spawn(process.execPath, ["--require", PRELOAD, join(root, "dist", "editor-handoff-driver.mjs")], {
    name: "xterm-256color",
    // Leave room for the full private prompt path and Vim's status text so
    // it doesn't split prompt.md across cursor movements on a long TMPDIR.
    cols: Math.max(80, Buffer.byteLength(join(temp, "pi-editor-XXXXXX", "prompt.md"), "utf8") + 32),
    rows: 24,
    cwd: root,
    // An explicit allowlist, never the ambient environment: the child must not
    // inherit this worker's session-host role marker, live agent directory, or
    // NODE_OPTIONS, any of which would change what the preload does. Its only
    // temporary directory is this fixture's verified private one, listed last so
    // nothing can widen it.
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: root,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      [SESSION_HOST_BOOTSTRAP_ENV]: JSON.stringify(bootstrap),
      PRG_DRIVER_EDITS: JSON.stringify(edits),
      ...extraEnv,
      // Ownership evidence for teardown only; nothing in the child reads it.
      PRG_TEST_PTY_OWNER: ownerNonce,
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
    },
  });
  state.pty = pty;
  state.listeners.push(pty.onExit((event) => { state.exit = event; }));
  state.ptyLaunchUnconfirmed = false;
  state.listeners.push(pty.onData((chunk) => { output += chunk; }));

  const child: Child = {
    bootstrap,
    root,
    output: () => output,
    async waitFor(label, predicate) {
      const deadline = Date.now() + MAX_STEP_MS;
      for (;;) {
        if (predicate(output)) return output;
        const exit = state.exit;
        if (exit !== undefined) throw new Error(`${label}: the child exited (${exit.exitCode}/${exit.signal}) with:\n${tail(output)}`);
        if (Date.now() > deadline) throw new Error(`${label}: timed out with:\n${tail(output)}`);
        await delay(25);
      }
    },
    async settle(needle) {
      await child.waitFor(`the ${needle} marker`, (value) => value.includes(needle));
      // Let a just-started program finish painting before the next dispatch is
      // typed: 1.2s of silence, restarting whenever the terminal produces more.
      let previous = output.length;
      let idle = 0;
      for (; idle < 12;) {
        await delay(100);
        idle = output.length === previous ? idle + 1 : 0;
        previous = output.length;
      }
      return output;
    },
    send: (payload) => { pty.write(encoder.encode(payload, LOCAL)); },
    kill: (signal) => { pty.kill(signal); },
    exited: () => state.exit !== undefined,
  };
  return child;
}

/**
 * The fixture's only cleanup. It never throws before every step has run, so one
 * failure cannot skip a later teardown, and it reports through the test's own
 * diagnostics and stderr as well as its thrown error: node:test keeps a failed
 * body's original error and would otherwise hide a cleanup failure behind it.
 */
async function disposeFixture(t: TestContext, state: FixtureState): Promise<void> {
  /** Settlement could not be confirmed: retain files and refuse wrapper cleanup. */
  const unsettled: string[] = [];
  /** Visible failures whose resources were nevertheless settled. */
  const problems: string[] = [];
  const evidence: string[] = [];

  // 1. The PTY child: a hang-up first, as the host closing the row would. What it
  // launched is captured first, while that ancestry still proves ownership.
  const pty = state.pty;
  if (pty !== undefined) {
    if (state.exit === undefined) {
      try { state.snapshot = descendantsOf(pty.pid); } catch (error) { unsettled.push(`descendants could not be captured: ${message(error)}`); }
      try { pty.kill("SIGHUP"); } catch (error) { problems.push(`SIGHUP to the PTY child ${pty.pid} failed: ${message(error)}`); }
      await waitUntil(() => state.exit !== undefined, SETTLE_MS);
    }
    if (state.exit === undefined) {
      try { pty.kill("SIGKILL"); } catch { /* reported below if it stays */ }
      if (await waitUntil(() => state.exit !== undefined, SETTLE_MS)) {
        problems.push(`the PTY child ${pty.pid} ignored SIGHUP for ${SETTLE_MS}ms and needed SIGKILL`);
      } else {
        unsettled.push(`the PTY child ${pty.pid} reported no exit after SIGHUP and SIGKILL`);
        // Release this process's own master handle so the runner is not held open.
        try { (pty as PtySurface & { destroy?(): void }).destroy?.(); } catch { /* recorded as unsettled */ }
      }
    }
    for (const listener of state.listeners.splice(0)) {
      try { listener.dispose(); } catch (error) { problems.push(`a PTY listener did not dispose: ${message(error)}`); }
    }
  }

  if (state.ptyLaunchUnconfirmed && state.exit === undefined) {
    unsettled.push("the PTY launch did not establish an exit observer; a native child may have forked");
  }

  // 2. Processes this fixture positively owns (e.g. an editor the child launched)
  // are stopped; a candidate whose ownership is not established is left alone.
  const root = state.root;
  if (root !== undefined) {
    const marker = state.ownerMarker;
    const survey = (): Survey => surveyProcesses(root, state.snapshot, marker);
    let current = survey();
    const grace = Date.now() + ORPHAN_GRACE_MS;
    while (!("error" in current) && current.owned.length + current.ambiguous.length > 0 && Date.now() < grace) {
      await delay(50);
      current = survey();
    }
    if (!("error" in current) && current.owned.length > 0) {
      problems.push(`owned processes outlived the fixture's child and were killed: ${describeProcesses(ownedPids(current.owned))}`
        + ` (${[...new Set(current.owned.map((entry) => entry.kind === "owned" ? entry.via : ""))].join("; ")})`);
      await waitUntil(() => {
        if (!("error" in current)) {
          for (const entry of current.owned) if (entry.kind === "owned") killIfStillOwned(entry.identity, state.snapshot, marker);
        }
        current = survey();
        return !("error" in current) && current.owned.length === 0;
      }, SETTLE_MS);
      if (!("error" in current) && current.owned.length > 0) {
        unsettled.push(`owned processes survived SIGKILL: ${describeProcesses(ownedPids(current.owned))}`);
      }
    }
    if ("error" in current) {
      unsettled.push(`the owned-process inventory is unavailable: ${current.error}`);
    } else if (current.ambiguous.length > 0) {
      unsettled.push("processes naming the fixture root were not signaled because ownership is not positively established: "
        + current.ambiguous.map((entry) => entry.kind === "ambiguous"
          ? `${describeProcesses([entry.pid])} (${entry.reason})`
          : "").join("; "));
    }
  }

  // 3. The host socket server and every connection the child opened to it.
  const server = state.server;
  let serverSettled = server === undefined;
  if (server !== undefined) {
    for (const socket of state.sockets) socket.destroy();
    let timer: NodeJS.Timeout | undefined;
    let fallback: { path: string; receipt: BigIntStats } | undefined;
    try {
      // libuv unlinks the bound (relative) name as the handle closes; doing that
      // inside the reserved, still-empty private directory keeps the implicit unlink
      // away from whatever entry now occupies the fixture's socket path, with no new
      // allocation. Limits: if the reservation was tampered with, teardown refuses
      // and settles the known listener in one fresh empty directory instead; if even
      // that cannot be had, the listener is unreferenced and reported unsettled
      // rather than closed somewhere its unlink could reach an unknown entry.
      let closeDirectory = reservedCloseDirectory(state);
      if (closeDirectory === undefined) {
        unsettled.push(`the reserved close directory is missing, replaced, or not empty: ${String(state.closeDir)}`);
        let candidate: string | undefined;
        try {
          candidate = mkdtempSync(join(disposableFixtureBase(), "ec-"));
          // Private, empty, and receipted before the close's implicit unlink runs in it.
          fallback = { path: candidate, receipt: verifiedEmptyCloseDirectory(candidate) };
          closeDirectory = candidate;
        } catch (error) {
          unsettled.push(`no empty directory to close the broker in: ${message(error)}`);
          // rmdir checks emptiness, not identity: an unverified path is reported and kept.
          if (candidate !== undefined) unsettled.push(`retained the unverified fallback close directory: ${candidate}`);
        }
      }
      if (closeDirectory === undefined) throw new Error("the broker was left listening, unreferenced");
      const closeIn = closeDirectory;
      const closed = await Promise.race([
        new Promise<string | undefined>((resolve) => {
          inDirectory(closeIn, () => server.close((error) => {
            resolve(error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
              ? undefined
              : error.message);
          }));
        }),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("timed out"), SETTLE_MS); }),
      ]);
      if (closed === undefined) {
        serverSettled = true;
        // Listener settlement is separate from filesystem cleanup: the fallback is
        // removed only while it is still that private, empty, receipted directory.
        if (fallback !== undefined) {
          try {
            verifiedEmptyCloseDirectory(fallback.path, fallback.receipt);
            rmdirSync(fallback.path);
          } catch (error) {
            unsettled.push(`retained the fallback close directory ${fallback.path}: ${message(error)}`);
          }
        }
      } else {
        unsettled.push(`the host socket server did not close (${closed}; ${state.sockets.size} connection(s) open)`);
        server.unref();
      }
    } catch (error) {
      unsettled.push(`the host socket server teardown failed: ${message(error)}`);
      server.unref();
    } finally {
      clearTimeout(timer);
      if (!serverSettled && fallback !== undefined) unsettled.push(`retained the fallback close directory: ${fallback.path}`);
    }
  }

  // 4. The private root. Every entry teardown relies on is verified without
  // following links; the refusal decision is made only after removal is confirmed.
  if (root !== undefined) {
    let identityConfirmed = false;
    let identityFailure = `the fixture root changed identity or canonical path: ${root}`;
    try {
      const current = lstatSync(root, { bigint: true });
      identityConfirmed = state.rootReceipt !== undefined && !current.isSymbolicLink() && current.isDirectory()
        && current.dev === state.rootReceipt.dev && current.ino === state.rootReceipt.ino
        && realpathSync(root) === root;
    } catch (error) {
      identityFailure = `the fixture root could not be revalidated: ${message(error)}`;
    }
    if (!identityConfirmed) unsettled.push(identityFailure);

    // An attempted mkdir without a receipt proves nothing about an occupant.
    // If the attempt produced no entry, there is no TMPDIR to inspect.
    if (identityConfirmed && state.temp !== undefined) {
      try {
        const current = lstatSync(state.temp, { bigint: true, throwIfNoEntry: false });
        const expected = state.tempReceipt;
        if (expected === undefined) {
          if (current !== undefined) unsettled.push(`an unexplained entry occupies the private TMPDIR: ${state.temp}`);
        } else if (!current?.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
          unsettled.push(`the private TMPDIR is missing or was replaced: ${state.temp}`);
        } else {
          const stranded = listTree(state.temp);
          if (stranded.length > 0) evidence.push(`launcher temp left in the private TMPDIR: ${stranded.join(", ")}`);
        }
      } catch (error) {
        unsettled.push(`the private TMPDIR could not be verified or listed: ${message(error)}`);
      }
    }

    // Rechecked after the asynchronous broker close (and for a setup that never bound
    // one), before the root is removed: anything that appeared in the reservation
    // since is unverified and is kept. A pending refusal already retains the root.
    if (identityConfirmed && unsettled.length === 0 && !closeReservationSettled(state)) {
      unsettled.push(`the reserved close directory is missing, replaced, or not empty: ${String(state.closeDir)}`);
    }

    // The host socket entry: absent, or exactly the entry receipted from this
    // fixture's own listen, removed here. Anything else is refused and kept.
    if (identityConfirmed && serverSettled && state.socketPath !== undefined) {
      try {
        const entry = lstatSync(state.socketPath, { bigint: true, throwIfNoEntry: false });
        if (entry !== undefined && (!entry.isSocket() || state.socketReceipt === undefined
          || entry.dev !== state.socketReceipt.dev || entry.ino !== state.socketReceipt.ino)) {
          unsettled.push(`an unexplained entry occupies the host socket path: ${state.socketPath}`);
        } else if (entry !== undefined) {
          unlinkSync(state.socketPath);
          if (lstatSync(state.socketPath, { throwIfNoEntry: false }) !== undefined) {
            unsettled.push(`the owned host socket entry could not be removed: ${state.socketPath}`);
          } else {
            evidence.push(`removed the owned host socket entry: ${state.socketPath}`);
          }
        }
      } catch (error) {
        unsettled.push(`the host socket entry could not be verified: ${message(error)}`);
      }
    }

    if (unsettled.length === 0 && PRESERVE_FILES) {
      evidence.push(`preserved fixture root (PI_TEST_SCRATCH_PRESERVE=1): ${root}`);
    } else if (unsettled.length === 0) {
      try {
        rmSync(root, { recursive: true, force: false });
      } catch (error) {
        unsettled.push(`removing the fixture root failed: ${message(error)}`);
      }
      try {
        if (lstatSync(root, { throwIfNoEntry: false }) !== undefined && unsettled.length === 0) {
          unsettled.push(`the fixture root still exists after removal: ${root}`);
        }
      } catch (error) {
        unsettled.push(`the fixture root's removal could not be confirmed: ${message(error)}`);
      }
    }

    if (unsettled.length > 0) {
      problems.push(`retained fixture root without confirmed settlement: ${root}`);
      const invocation = process.env.PI_TEST_SCRATCH_ROOT;
      try {
        if (invocation !== undefined && invocation.length > 0 && strictlyInside(realpathSync(invocation), root)) {
          signalCleanupRefusal(`editor-handoff fixture settlement unconfirmed: ${root}: ${unsettled.join("; ")}`);
          problems.push("recorded a test-scratch cleanup refusal for the invocation root");
        }
      } catch (error) {
        problems.push(`could not record a cleanup refusal: ${message(error)}`);
      }
    }
  } else if (unsettled.length > 0) {
    problems.push("no fixture root was allocated; nothing to retain");
  }

  for (const line of boundedLines(evidence)) t.diagnostic(line);
  const failures = boundedLines([...unsettled, ...problems]);
  if (unsettled.length + problems.length > 0) {
    // Emitted before throwing: when the body already failed, node:test reports only
    // the body's error, so these lines are the cleanup failure's visible record.
    for (const line of failures) {
      t.diagnostic(`fixture cleanup: ${line}`);
      process.stderr.write(`editor-handoff fixture cleanup (${t.name}): ${line}\n`);
    }
    throw new Error(`editor-handoff fixture cleanup failed:\n${failures.join("\n")}`);
  }
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

/**
 * Pi's own failed-edit result, on every audited runtime. The contract this evidence
 * proves is that the edit is failed and NO result content is accepted. Pi 1.5.0 added
 * its own user-facing `message` field to this result (upstream "the external editor
 * failed silently" fix); that wording is Pi's, not this package's, so it is present or
 * absent without changing what is asserted here.
 */
function assertFailedResult(value: { status: string; content?: string }, label: string): void {
  assert.equal(value.status, "failed", label);
  assert.equal(value.content, undefined, `${label}: a failed edit never accepts result content`);
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// The shell waits for foreground tee, then reports and propagates tee's exact status.
function createTeeEditor(sinkRoot: string, out: string): { command: string; statusFile: string } {
  const command = join(sinkRoot, "tee-editor.sh");
  const statusFile = join(sinkRoot, "tee.status");
  writeFileSync(command, [
    "#!/bin/sh",
    `tee ${shellQuote(out)} "$@"`,
    "tee_status=$?",
    `printf '%s' "$tee_status" > ${shellQuote(statusFile)}`,
    "exit \"$tee_status\"",
    "",
  ].join("\n"), { mode: 0o700 });
  return { command, statusFile };
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
/** Two distinct reasons, so a platform skip never reads as a missing pinned runtime. */
const skip = process.platform === "win32"
  ? "native Windows editor handoff stays experimental"
  : runtime === undefined
    ? `no installed Pi ${AUDITED_PI_VERSIONS.join("/")} runtime with the external-editor launcher`
    : false;

/** The temporary directory the child itself resolved, from the driver's own report. */
function assertChildTemp(output: string, fixture: Fixture): void {
  const match = /PRG_TMPDIR ("[^"\r\n]*")/.exec(output);
  assert.ok(match !== null, `the driver reported its temporary directory: ${tail(output)}`);
  assert.equal(JSON.parse(match[1]!), fixture.temp,
    "the copied launcher's os.tmpdir() is the fixture's private directory, never the shared host temp");
}

/** Pi's prompt path, exactly as the configured editor received it, is inside the private TMPDIR. */
function assertConfinedPrompt(promptPath: string, fixture: Fixture): void {
  assert.match(relative(fixture.temp, promptPath), /^pi-editor-[^/]+\/prompt\.md$/,
    `the launcher's prompt file is confined to the fixture's private TMPDIR: ${promptPath}`);
}

/** After a normal completion the launcher's own removal ran inside the private TMPDIR. */
function assertTempClean(fixture: Fixture): void {
  assert.deepEqual(fixture.tempEntries(), [],
    "a completed edit leaves nothing in the private TMPDIR: the launcher removed its own prompt directory");
}

/**
 * After an abrupt exit the launcher's best-effort removal may never run; whatever it
 * stranded is only its own prompt directory, inside the private TMPDIR that fixture
 * teardown removes. Returns whether the prompt was stranded, for evidence.
 */
function assertOnlyPromptDirectoryRemains(fixture: Fixture, promptPath: string): boolean {
  const own = relative(fixture.temp, dirname(promptPath));
  for (const entry of fixture.tempEntries()) {
    assert.equal(entry, own, `only the launcher's own prompt directory can remain after an abrupt exit: ${entry}`);
  }
  return existsSync(promptPath);
}

/**
 * A configured editor that records Pi's prompt path and then its own process id
 * (in that order: the pid file is what the settlement waits for), then stays open
 * ignoring input. Pi's prompt path stays on its command line, so fixture teardown
 * can positively identify it.
 */
function createStayOpenEditor(fixture: Fixture): { command: string; pidFile: string; promptFile: string } {
  const pidFile = join(fixture.scratch, "editor.pid");
  const promptFile = join(fixture.scratch, "editor.prompt");
  const command = join(fixture.scratch, "stay-open-editor.sh");
  writeFileSync(command, [
    "#!/bin/sh",
    `printf '%s\\n' "$1" > ${shellQuote(promptFile)}`,
    `echo $$ > ${shellQuote(pidFile)}`,
    "exec tail -f /dev/null \"$1\"",
    "",
  ].join("\n"), { mode: 0o755 });
  return { command, pidFile, promptFile };
}

test("handoff: a real editor launched by the production Pi launcher edits and returns through its own terminal", { skip }, async (t) => {
  const fixture = createFixture(t);
  const child = await fixture.start([{ command: "vim -u NONE -i NONE", content: "seed\n" }]);
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  await child.settle("Launching external editor");
  // A real terminal answers the terminal queries an editor writes at startup;
  // nothing answers them here, so this first dispatch absorbs any byte the editor
  // discards while it waits. Escape is a no-op in Vim's normal mode.
  child.send(Buffer.from("\x1b", "utf8"));
  child.send(Buffer.from("i", "utf8"));
  child.send(Buffer.from("héllo 🚀", "utf8"));
  child.send(Buffer.from("\x1b", "utf8"));
  child.send(Buffer.from(":wq\r", "utf8"));
  const done = await child.waitFor("the editor result", (value) => value.includes("PRG_RESULT 1 "));
  assert.deepEqual(result(done, 1), { status: "complete", content: "héllo 🚀seed" },
    "the typed text reached Pi's result file byte-for-byte");
  assert.match(child.output(), /prompt\.md/, "the editor's own screen reached this child's stdout");
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
  assertChildTemp(child.output(), fixture);
  assertTempClean(fixture);
});

test("handoff: a non-Node program receives the verified bytes, not the framing text", { skip }, async (t) => {
  const fixture = createFixture(t);
  const out = join(fixture.scratch, "bytes.bin");
  // A canonical-mode-safe payload: no CR, no INTR/SUSP/EOF byte, terminated by LF.
  const payload = Buffer.from("x\x1b[200~héllo — 🚀\x1b[201~ ok\n", "utf8");
  const editor = createTeeEditor(fixture.scratch, out);
  const child = await fixture.start([{ command: editor.command }]);
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
  assert.equal(readFileSync(editor.statusFile, "utf8"), "0", "the real tee process exited normally");
  assertChildTemp(done, fixture);
  assertTempClean(fixture);
});

test("handoff: a configured editor that changes the draft and dies by signal is a failed edit", { skip }, async (t) => {
  // A real configured wrapper, whatever it is: it accepts Pi's file argument, writes
  // a result, then terminates itself by signal. A PTY reports that as a zero exit
  // code WITH a live signal, which must never reach the launcher as success.
  const fixture = createFixture(t);
  const wrapper = join(fixture.scratch, "signal-editor.sh");
  writeFileSync(wrapper, "#!/bin/sh\nprintf 'changed by the editor\\n' > \"$1\"\nkill -TERM $$\n", { mode: 0o755 });
  const child = await fixture.start([{ command: wrapper, content: "draft\n" }]);
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const done = await child.waitFor("the signal-killed editor result", (value) => value.includes("PRG_RESULT 1 "));
  assertFailedResult(result(done, 1),
    `a signal death never accepts the result file: ${tail(done)}`);
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
  assertChildTemp(child.output(), fixture);
  assertTempClean(fixture);
});

test("handoff: a failing edit and a later edit both settle", { skip }, async (t) => {
  const fixture = createFixture(t);
  const out = join(fixture.scratch, "second.bin");
  const editor = createTeeEditor(fixture.scratch, out);
  const child = await fixture.start([
    { command: "this-editor-does-not-exist-499" },
    { command: editor.command },
  ]);
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const first = await child.waitFor("the failed edit", (value) => value.includes("PRG_RESULT 1 "));
  assertFailedResult(result(first, 1), "a launch that cannot start is Pi's own failed result");
  await child.settle("PRG_RESULT 1");
  child.send(Buffer.from("abc\n", "utf8"));
  child.send(Buffer.from("\x04", "utf8"));
  const second = await child.waitFor("the later edit", (value) => value.includes("PRG_RESULT 2 "));
  assert.deepEqual(result(second, 2), { status: "complete", content: "abc" },
    `a later edit still works after a failed one: ${tail(second)}`);
  assert.equal(readFileSync(out).toString(), "abc\n", "and it still owns its own terminal");
  assert.equal(readFileSync(editor.statusFile, "utf8"), "0", "the later edit's real tee process exited normally");
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
  assertChildTemp(child.output(), fixture);
  assertTempClean(fixture);
});

test("handoff: a program still open when the child dies does not outlive it", { skip }, async (t) => {
  // `tail -f` is not an editor at all: the handoff routes Pi's generic launch,
  // never a particular program. It ignores stdin and never exits on its own.
  const marker = "tail -f /dev/null";
  const fixture = createFixture(t);
  const child = await fixture.start([{ command: marker, content: "keep open\n" }]);
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  await child.settle("Launching external editor");
  // Count only the program given this fixture's unique private prompt path.
  // Parallel test invocations can launch the same command for their own prompts.
  const promptPrefix = join(fixture.temp, "pi-editor-");
  const editors = pidsMatching(`^${escapeRegExp(marker)} ${escapeRegExp(promptPrefix)}[^/]+/prompt\\.md$`);
  assert.equal(editors.length, 1, `the launch owns exactly one program: ${editors.join(",")}`);
  const editor = editors[0]!;
  assert.ok(alive(editor), "the owned program is running on its own terminal");
  assert.equal(child.exited(), false, "and the child is waiting for it");
  // Pi appended its prompt path to the configured command: confined, and written.
  const args = spawnSync("ps", ["-o", "args=", "-p", String(editor)], { encoding: "utf8" });
  assert.equal(args.error, undefined, "the owned program's command line is readable");
  const promptPath = args.stdout.trim().slice(marker.length + 1);
  assertConfinedPrompt(promptPath, fixture);
  assert.equal(readFileSync(promptPath, "utf8"), "keep open\n", "the real launcher wrote its prompt in the private TMPDIR");
  assertChildTemp(child.output(), fixture);

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
  // The hang-up is the hard disposal boundary: whatever the launcher could not remove
  // stays inside the fixture's private TMPDIR, which fixture teardown removes.
  t.diagnostic(`prompt stranded by the hang-up: ${String(assertOnlyPromptDirectoryRemains(fixture, promptPath))}`);
});

test("handoff: the awaited native shutdown settles a real open editor before the parent completes", { skip }, async (t) => {
  const fixture = createFixture(t);
  // Any configured editor: it records its own process id, then stays open and ignores
  // input, like a user still mid-edit when the host asks the session to stop.
  const editor = createStayOpenEditor(fixture);
  const pidFile = editor.pidFile;
  const child = await fixture.start([{ command: editor.command, content: "keep open\n" }], {
    PRG_SETTLE_MODULE: HANDOFF,
    PRG_SETTLE_WAIT_FILE: pidFile,
  });
  await child.waitFor("the strict readiness capsule", (value) => value.includes(READY_MARKER));
  const settledOutput = await child.waitFor("the awaited shutdown settlement", (value) => value.includes("PRG_SETTLE_RESULT "));
  assert.ok(settledOutput.includes("PRG_SETTLE_RESULT true"),
    `the settlement witnessed the editor's own exit: ${tail(settledOutput)}`);
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the editor reported its own process id");
  assert.ok(!alive(pid), "the owned editor was gone before the awaited shutdown returned");
  assert.equal(child.exited(), false, "settling the editor is not the child exiting");
  assertConfinedPrompt(readFileSync(editor.promptFile, "utf8").trim(), fixture);
  const done = await child.waitFor("the edit result", (value) => value.includes("PRG_RESULT 1 "));
  assertFailedResult(result(done, 1),
    `an editor stopped by shutdown is Pi's own failed result: ${tail(done)}`);
  await child.waitFor("the driver finishing", (value) => value.includes("PRG_DRIVER_DONE"));
  assertChildTemp(child.output(), fixture);
  assertTempClean(fixture);
});

test("handoff: native SIGTERM disposal settles a real open editor before the child exits", { skip }, async (t) => {
  const fixture = createFixture(t);
  const editor = createStayOpenEditor(fixture);
  const pidFile = editor.pidFile;
  const child = await fixture.start([{ command: editor.command, content: "keep open\n" }], {
    PRG_NATIVE_DISPOSAL: "1",
    PRG_REPORTER_MODULE: REPORTER,
    PRG_EDITOR_PID_FILE: pidFile,
  });
  await child.waitFor("the reporter extension activating in the child", (value) => value.includes("PRG_REPORTER_ACTIVATED"));
  await child.settle("Launching external editor");
  await child.waitFor("the editor's own process id", () => {
    try { return readFileSync(pidFile, "utf8").trim().length > 0; } catch { return false; }
  });
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the editor reported its own process id");
  assert.ok(alive(pid), "the configured editor is open on its own terminal");
  const promptPath = readFileSync(editor.promptFile, "utf8").trim();
  assertConfinedPrompt(promptPath, fixture);
  assert.equal(readFileSync(promptPath, "utf8"), "keep open\n", "the real launcher wrote its prompt in the private TMPDIR");
  assertChildTemp(child.output(), fixture);

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
  // Native disposal ends in process.exit, past the launcher's own best-effort removal:
  // anything it stranded is confined to the fixture's private TMPDIR.
  t.diagnostic(`prompt stranded by native disposal: ${String(assertOnlyPromptDirectoryRemains(fixture, promptPath))}`);
});

/*
 * Teardown self-tests. They drive this file's own fixture cleanup through a captured
 * context, inside a synthetic invocation root, so each deliberately unsettled
 * teardown's refusal is observed (and then removed with that synthetic root) without
 * ever reaching the real test-scratch invocation root. No Pi runtime is needed.
 */

interface CapturedTeardown {
  readonly context: TestContext;
  readonly diagnostics: string[];
  /** Run the captured cleanup; resolves to what it threw, if anything. */
  run(): Promise<unknown>;
}

type DeferCleanup = (step: () => void | Promise<void>) => void;

/**
 * A captured fixture context. Its hooks run on an explicit `run()`; a fallback is
 * deferred to the enclosing self-test cleanup before any fixture setup, so a body
 * that fails first can never leave the fixture (e.g. a live broker) unsettled.
 */
function captureTeardown(name: string, defer: DeferCleanup): CapturedTeardown {
  const hooks: (() => unknown)[] = [];
  const diagnostics: string[] = [];
  const context = {
    name,
    after: (hook: () => unknown) => { hooks.push(hook); },
    diagnostic: (line: string) => { diagnostics.push(line); },
  } as unknown as TestContext;
  const teardown: CapturedTeardown = {
    context,
    diagnostics,
    async run() {
      try {
        for (const hook of hooks.splice(0)) await hook();
        return undefined;
      } catch (error) {
        return error;
      }
    },
  };
  defer(async () => {
    const error = await teardown.run();
    if (error !== undefined) throw error;
  });
  return teardown;
}

/**
 * Run `body` with PI_TEST_SCRATCH_ROOT pointing at a fresh private stand-in root.
 * One cleanup, registered first, runs the body's deferred steps (last first) and
 * then removes the stand-in root it verifiably created. If any deferred step fails,
 * the stand-in root is retained and the real enclosing invocation root is told.
 */
async function withSyntheticInvocationRoot(
  t: TestContext,
  body: (invocation: string, defer: DeferCleanup) => Promise<void>,
): Promise<void> {
  const deferred: (() => void | Promise<void>)[] = [];
  let invocation: string | undefined;
  let receipt: BigIntStats | undefined;
  let bodyPassed = false;
  t.after(async () => {
    const failures: string[] = [];
    // Deferred fixture teardowns record any refusal in the synthetic root, never
    // the enclosing one; the enclosing root is restored before reporting below.
    const enclosing = process.env.PI_TEST_SCRATCH_ROOT;
    try {
      if (invocation !== undefined && receipt !== undefined) process.env.PI_TEST_SCRATCH_ROOT = invocation;
      for (const step of deferred.reverse()) {
        try { await step(); } catch (error) { failures.push(message(error)); }
      }
    } finally {
      if (enclosing === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
      else process.env.PI_TEST_SCRATCH_ROOT = enclosing;
    }
    if (invocation !== undefined && failures.length === 0) {
      try {
        const current = lstatSync(invocation, { bigint: true });
        if (receipt === undefined || current.isSymbolicLink() || current.dev !== receipt.dev || current.ino !== receipt.ino) {
          failures.push(`the synthetic invocation root changed identity; retained: ${invocation}`);
        } else if (!bodyPassed && lstatSync(join(invocation, ".pi-test-scratch-refusals"), { throwIfNoEntry: false }) !== undefined) {
          failures.push(`the failed self-test left a fixture refusal: ${invocation}`);
        } else {
          rmSync(invocation, { recursive: true, force: false });
        }
      } catch (error) {
        failures.push(`removing the synthetic invocation root failed: ${message(error)}`);
      }
    }
    if (failures.length > 0) {
      if (invocation !== undefined) {
        failures.push(`synthetic invocation root retained: ${invocation}`);
        try {
          if (enclosing !== undefined && enclosing.length > 0 && strictlyInside(realpathSync(enclosing), invocation)) {
            signalCleanupRefusal(`editor-handoff self-test cleanup unconfirmed: ${invocation}`);
            failures.push("recorded a test-scratch cleanup refusal for the enclosing invocation root");
          }
        } catch (error) {
          failures.push(`could not record a self-test cleanup refusal: ${message(error)}`);
        }
      }
      for (const line of boundedLines(failures)) {
        t.diagnostic(`self-test cleanup: ${line}`);
        process.stderr.write(`editor-handoff self-test cleanup (${t.name}): ${line}\n`);
      }
      throw new Error(`self-test cleanup failed:\n${boundedLines(failures).join("\n")}`);
    }
  });
  invocation = mkdtempSync(join(disposableFixtureBase(), "ei-"));
  receipt = verifiedPrivateDirectory(invocation);
  const previous = process.env.PI_TEST_SCRATCH_ROOT;
  process.env.PI_TEST_SCRATCH_ROOT = invocation;
  try {
    await body(invocation, (step) => { deferred.push(step); });
    bodyPassed = true;
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
    else process.env.PI_TEST_SCRATCH_ROOT = previous;
  }
}

function refusalEntries(invocation: string): string[] {
  const directory = join(invocation, ".pi-test-scratch-refusals");
  if (lstatSync(directory, { throwIfNoEntry: false }) === undefined) return [];
  return readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8"));
}

function assertRefusedAndRetained(
  error: unknown, pattern: RegExp, invocation: string, fixture: Fixture, teardown: CapturedTeardown,
): void {
  assert.ok(error instanceof Error, "an unconfirmed teardown fails visibly");
  assert.match(error.message, pattern);
  assert.ok(teardown.diagnostics.some((line) => line.startsWith("fixture cleanup: ") && pattern.test(line)),
    "the failure is also emitted as a diagnostic before the throw, so a failed body cannot hide it");
  const refusals = refusalEntries(invocation);
  assert.equal(refusals.length, 1, "exactly one cleanup refusal is recorded in the invocation root");
  assert.ok(refusals[0]!.includes(fixture.root), "the refusal names the retained fixture root");
  assert.ok(lstatSync(fixture.root, { throwIfNoEntry: false }) !== undefined, "the affected evidence is retained");
}

const selfTestSkip = process.platform === "win32" ? "native Windows editor handoff stays experimental" : false;

test("fixture teardown: an unrelated process naming the fixture root is never signaled", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: unrelated process", defer);
    const fixture = createFixture(teardown.context);
    // A bystander inspecting the fixture: its command line names the fixture root and
    // it even uses the fixture's private TMPDIR, but it is not the fixture's child and
    // never received the PTY launch's ownership nonce.
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", fixture.root], {
      stdio: "ignore",
      env: { ...process.env, TMPDIR: fixture.temp },
    });
    let closed = false;
    let childError: Error | undefined;
    bystander.on("error", (error) => { childError = error; });
    bystander.once("close", () => { closed = true; });
    defer(async () => {
      if (!closed && bystander.pid !== undefined && bystander.exitCode === null && bystander.signalCode === null) {
        bystander.kill("SIGKILL");
      }
      if (!await waitUntil(() => closed, SETTLE_MS)) {
        bystander.unref();
        throw new Error(`the bystander ${String(bystander.pid)} did not close: ${message(childError)}`);
      }
    });
    assert.ok(await waitUntil(() => childError !== undefined
      || pidsMatching(escapeRegExp(fixture.root)).includes(bystander.pid!), MAX_STEP_MS),
    "the bystander is a command-line candidate for the fixture root");
    if (childError !== undefined) throw childError;
    const error = await teardown.run();
    assert.equal(bystander.signalCode, null, "teardown never signaled the bystander");
    assert.ok(alive(bystander.pid!), "the bystander is still running");
    assertRefusedAndRetained(error, /ownership is not positively established/, invocation, fixture, teardown);
  });
});

test("fixture teardown: a replaced private TMPDIR is refused, never followed", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: replaced TMPDIR", defer);
    const fixture = createFixture(teardown.context);
    const outside = join(invocation, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, "outside-only-entry"), "");
    rmSync(fixture.temp, { recursive: true, force: false });
    symlinkSync(outside, fixture.temp);
    const error = await teardown.run();
    assertRefusedAndRetained(error, /private TMPDIR is missing or was replaced/, invocation, fixture, teardown);
    assert.ok(!teardown.diagnostics.some((line) => line.includes("outside-only-entry")),
      "teardown never listed through the replacement link");
    assert.ok(existsSync(join(outside, "outside-only-entry")), "nothing outside the fixture was touched");
  });
});

test("fixture teardown: an unexplained entry at the host socket path is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: socket entry", defer);
    const fixture = createFixture(teardown.context);
    writeFileSync(join(fixture.root, "h.sock"), "not a socket");
    const error = await teardown.run();
    assertRefusedAndRetained(error, /unexplained entry occupies the host socket path/, invocation, fixture, teardown);
    assert.equal(readFileSync(join(fixture.root, "h.sock"), "utf8"), "not a socket", "the unexplained entry is retained");
  });
});

/** Leave a real, unreceipted socket entry at `socketPath`: a listener killed before it closes. */
function leaveStaleSocket(socketPath: string): void {
  const stale = spawnSync(process.execPath, ["-e",
    `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`],
  { stdio: "ignore", timeout: MAX_STEP_MS });
  assert.equal(stale.signal, "SIGKILL", "the stale listener died without closing");
  assert.ok(lstatSync(socketPath).isSocket(), "a stale socket entry exists");
}

test("fixture teardown: a socket without the broker's receipt is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: unreceipted socket", defer);
    const fixture = createFixture(teardown.context);
    const socketPath = join(fixture.root, "h.sock");
    leaveStaleSocket(socketPath);
    const error = await teardown.run();
    assertRefusedAndRetained(error, /unexplained entry occupies the host socket path/, invocation, fixture, teardown);
    assert.ok(lstatSync(socketPath).isSocket(), "the unreceipted entry remains");
  });
});

test("fixture teardown: a socket replaced under a live broker survives and is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: replaced socket", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const socketPath = await startBroker(state);
    // A live connection, so closing the broker also has a connection to settle.
    // Its cleanup is deferred before it connects.
    const client = new Socket();
    let connected = false;
    let clientClosed = false;
    let clientError: Error | undefined;
    client.once("close", () => { clientClosed = true; });
    client.on("error", (error) => { clientError = error; });
    defer(async () => {
      client.destroy();
      if (!await waitUntil(() => clientClosed, SETTLE_MS)) {
        client.unref();
        throw new Error("the self-test client did not close");
      }
    });
    client.connect(socketPath, () => { connected = true; });
    assert.ok(await waitUntil(() => connected || clientError !== undefined, SETTLE_MS), "the self-test client connected");
    if (clientError !== undefined) throw clientError;
    // Replace the pathname while the broker still listens on the original entry.
    renameSync(socketPath, join(fixture.root, "h.orig"));
    leaveStaleSocket(socketPath);
    const replacement = lstatSync(socketPath, { bigint: true });
    const error = await teardown.run();
    assertRefusedAndRetained(error, /unexplained entry occupies the host socket path/, invocation, fixture, teardown);
    const after = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
    assert.ok(after !== undefined && after.isSocket() && after.dev === replacement.dev && after.ino === replacement.ino,
      "closing the broker never unlinked the replacement entry");
    assert.equal(state.server?.listening, false, "the broker itself closed");
    assert.ok(await waitUntil(() => clientClosed, SETTLE_MS), "and its connection settled");
  });
});

test("fixture teardown: the broker's own receipted socket is removed", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: owned socket", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const socketPath = await startBroker(state);
    const error = await teardown.run();
    assert.equal(error, undefined, `a receipted socket entry settles: ${message(error)}`);
    assert.equal(state.server?.listening, false, "the broker closed");
    assert.ok(teardown.diagnostics.some((line) => line.startsWith("removed the owned host socket entry")),
      "teardown removed exactly the entry the broker created");
    assert.deepEqual(refusalEntries(invocation), [], "no refusal for a confirmed teardown");
    assert.equal(lstatSync(fixture.root, { throwIfNoEntry: false }) !== undefined, PRESERVE_FILES,
      "the verified root is removed, or kept only under explicit preserve");
    if (PRESERVE_FILES) assert.equal(lstatSync(socketPath, { throwIfNoEntry: false }), undefined, "the socket entry is gone");
  });
});

test("fixture teardown: a socket replaced between bind and listening is never receipted", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: replaced before listening", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const socketPath = state.socketPath!;
    // The bind (and its receipt) happen synchronously; `listening` is still pending.
    const starting = startBroker(state);
    const bound = state.socketReceipt;
    assert.ok(bound !== undefined && bound.isSocket(), "the bind's own entry was receipted in its tick");
    renameSync(socketPath, join(fixture.root, "h.orig"));
    leaveStaleSocket(socketPath);
    const replacement = lstatSync(socketPath, { bigint: true });
    await assert.rejects(starting, /replaced before the broker was listening/,
      "a replacement before `listening` fails broker startup");
    assert.ok(state.socketReceipt?.dev === bound.dev && state.socketReceipt?.ino === bound.ino,
      "the receipt still names only the bind's own entry");
    const error = await teardown.run();
    assertRefusedAndRetained(error, /unexplained entry occupies the host socket path/, invocation, fixture, teardown);
    const after = lstatSync(socketPath, { bigint: true, throwIfNoEntry: false });
    assert.ok(after !== undefined && after.dev === replacement.dev && after.ino === replacement.ino,
      "the replacement survives teardown");
    assert.equal(state.server?.listening, false, "the known listener was settled");
  });
});

test("fixture teardown: an already-bound broker settles without any new allocation", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: no allocation", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    await startBroker(state);
    // Count every directory allocation teardown attempts, through the same module
    // object the compiled fixture calls into.
    const fsModule = nodeRequire("node:fs") as { mkdtempSync: typeof mkdtempSync; mkdirSync: typeof mkdirSync };
    const original = { mkdtempSync: fsModule.mkdtempSync, mkdirSync: fsModule.mkdirSync };
    const allocations: string[] = [];
    fsModule.mkdtempSync = ((...args: Parameters<typeof mkdtempSync>) => {
      allocations.push(`mkdtemp ${String(args[0])}`);
      return original.mkdtempSync(...args);
    }) as typeof mkdtempSync;
    fsModule.mkdirSync = ((...args: Parameters<typeof mkdirSync>) => {
      allocations.push(`mkdir ${String(args[0])}`);
      return original.mkdirSync(...args);
    }) as typeof mkdirSync;
    let error: unknown;
    try {
      error = await teardown.run();
    } finally {
      fsModule.mkdtempSync = original.mkdtempSync;
      fsModule.mkdirSync = original.mkdirSync;
    }
    assert.equal(error, undefined, `the bound broker settles: ${message(error)}`);
    assert.deepEqual(allocations, [], "closing the broker allocated nothing");
    assert.equal(state.server?.listening, false, "the broker closed");
    assert.ok(teardown.diagnostics.some((line) => line.startsWith("removed the owned host socket entry")),
      "only the receipted entry was removed");
    assert.deepEqual(refusalEntries(invocation), [], "no refusal for a confirmed teardown");
  });
});

test("fixture teardown: an unverified close reservation refuses broker startup and teardown", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: close reservation", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const outside = join(invocation, "outside");
    mkdirSync(outside, { mode: 0o700 });
    rmdirSync(state.closeDir!);
    symlinkSync(outside, state.closeDir!);
    await assert.rejects(startBroker(state), /close directory is not reserved and verified/,
      "no listener is created without a verified close reservation");
    assert.equal(state.server, undefined, "no broker exists");
    assert.equal(lstatSync(state.socketPath!, { throwIfNoEntry: false }), undefined, "nothing was bound");
    const error = await teardown.run();
    assertRefusedAndRetained(error, /reserved close directory is missing, replaced, or not empty/, invocation, fixture, teardown);
    assert.deepEqual(readdirSync(outside), [], "nothing was written through the replacement link");
  });
});

test("fixture teardown: an entry appearing in the close reservation during broker close is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: late reservation entry", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    await startBroker(state);
    const late = join(state.closeDir!, "late-entry");
    // Appears only once the broker has closed: after teardown's pre-close check.
    state.server!.once("close", () => { writeFileSync(late, "unverified"); });
    const error = await teardown.run();
    assert.equal(state.server?.listening, false, "the broker stopped");
    assertRefusedAndRetained(error, /reserved close directory is missing, replaced, or not empty/, invocation, fixture, teardown);
    assert.equal(readFileSync(late, "utf8"), "unverified", "the late entry survives teardown");
  });
});

/**
 * Observe (and optionally tamper with) teardown's fallback close-directory
 * allocation, through the same `node:fs` module object the compiled fixture calls.
 */
async function withFallbackAllocation<T>(onAllocate: (path: string) => void, action: () => Promise<T>): Promise<T> {
  const fsModule = nodeRequire("node:fs") as { mkdtempSync: typeof mkdtempSync };
  const original = fsModule.mkdtempSync;
  fsModule.mkdtempSync = ((...args: Parameters<typeof mkdtempSync>) => {
    const allocated = original(...args);
    if (String(args[0]).endsWith(`${"/"}ec-`)) onAllocate(String(allocated));
    return allocated;
  }) as typeof mkdtempSync;
  try {
    return await action();
  } finally {
    fsModule.mkdtempSync = original;
  }
}

test("fixture teardown: an entry injected into the fallback close directory survives and is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: injected fallback entry", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    await startBroker(state);
    const server = state.server!;
    // A verified way to settle the test-owned listener, registered before the fault:
    // a pre-allocated private empty directory to close it in.
    const testClose = mkdtempSync(join(invocation, "tc-"));
    const testCloseReceipt = verifiedEmptyCloseDirectory(testClose);
    defer(async () => {
      if (server.listening) {
        verifiedEmptyCloseDirectory(testClose, testCloseReceipt);
        let closed = false;
        inDirectory(testClose, () => server.close(() => { closed = true; }));
        if (!await waitUntil(() => closed, SETTLE_MS)) throw new Error("the self-test listener did not close");
      }
    });
    // Force the fallback (the reservation is no longer empty), then plant an entry
    // named like the broker's socket in the fallback before teardown receives it.
    writeFileSync(join(state.closeDir!, "tamper"), "");
    let fallback: string | undefined;
    const error = await withFallbackAllocation((path) => {
      fallback = path;
      writeFileSync(join(path, "h.sock"), "unverified");
    }, () => teardown.run());
    assert.ok(fallback !== undefined, "teardown allocated a fallback close directory");
    assertRefusedAndRetained(error, /no empty directory to close the broker in/, invocation, fixture, teardown);
    assert.match((error as Error).message, /retained the unverified fallback close directory/);
    assert.equal(readFileSync(join(fallback, "h.sock"), "utf8"), "unverified", "the planted entry was never unlinked");
    assert.equal(server.listening, true, "an unverified fallback is never closed in: the listener is left for its owner");
  });
});

test("fixture teardown: a fallback close directory swapped during close survives and is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: swapped fallback", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    await startBroker(state);
    writeFileSync(join(state.closeDir!, "tamper"), "");
    let fallback: string | undefined;
    let replacement: BigIntStats | undefined;
    // While the broker closes (after its unlink, before teardown's cleanup), the
    // fallback's pathname is swapped for a different empty private directory.
    state.server!.once("close", () => {
      renameSync(fallback!, `${fallback!}.orig`);
      mkdirSync(fallback!, { mode: 0o700 });
      replacement = lstatSync(fallback!, { bigint: true });
    });
    const error = await withFallbackAllocation((path) => { fallback = path; }, () => teardown.run());
    assert.equal(state.server?.listening, false, "the listener closed");
    assert.ok(fallback !== undefined && replacement !== undefined, "the fallback was swapped during close");
    assertRefusedAndRetained(error, /retained the fallback close directory .*replaced/, invocation, fixture, teardown);
    const after = lstatSync(fallback, { bigint: true, throwIfNoEntry: false });
    assert.ok(after !== undefined && after.dev === replacement.dev && after.ino === replacement.ino,
      "the replacement directory survives teardown");
  });
});

test("fixture teardown: a failed bind keeps Node's original error and records no receipt", {
  skip: selfTestSkip || (process.getuid?.() === 0 ? "permission bits do not bind the superuser" : false),
}, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: failed bind", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    // The socket's directory refuses new entries, so the bind itself fails.
    // Restored for a teardown that did not run or finish; a settled one removed the root.
    defer(() => { if (lstatSync(fixture.root, { throwIfNoEntry: false }) !== undefined) chmodSync(fixture.root, 0o700); });
    chmodSync(fixture.root, 0o500);
    await assert.rejects(startBroker(state), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EACCES", `the setup error is Node's own bind failure: ${message(error)}`);
      return true;
    });
    assert.equal(state.socketReceipt, undefined, "a failed bind records no receipt");
    assert.equal(lstatSync(state.socketPath!, { throwIfNoEntry: false }), undefined, "and created no entry");
    chmodSync(fixture.root, 0o700);
    const error = await teardown.run();
    assert.equal(error, undefined, `the unbound broker and its fixture settle: ${message(error)}`);
    assert.equal(state.server?.listening, false, "no listener remains");
    assert.deepEqual(refusalEntries(invocation), [], "no refusal for a confirmed teardown");
  });
});

test("fixture teardown: an occupied close-reservation path keeps its setup error and is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: occupied reservation", defer);
    // An unexplained entry appears at the reservation path just as it is allocated.
    const fsModule = nodeRequire("node:fs") as { mkdirSync: typeof mkdirSync };
    const original = fsModule.mkdirSync;
    let occupied: string | undefined;
    fsModule.mkdirSync = ((...args: Parameters<typeof mkdirSync>) => {
      const target = String(args[0]);
      if (occupied === undefined && target.endsWith(`${"/"}ec`)) {
        occupied = target;
        writeFileSync(target, "unexplained");
      }
      return original(...args);
    }) as typeof mkdirSync;
    try {
      assert.throws(() => createFixture(teardown.context), (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "EEXIST", `the original setup error survives: ${message(error)}`);
        return true;
      });
    } finally {
      fsModule.mkdirSync = original;
    }
    assert.ok(occupied !== undefined, "the reservation path was occupied during its allocation");
    const error = await teardown.run();
    assert.ok(error instanceof Error, "an unverified reservation path fails teardown visibly");
    assert.match(error.message, /reserved close directory is missing, replaced, or not empty/);
    assert.ok(teardown.diagnostics.some((line) => line.startsWith("fixture cleanup: ")), "and is emitted as a diagnostic");
    assert.equal(readFileSync(occupied, "utf8"), "unexplained", "the unexplained entry survives");
    const refusals = refusalEntries(invocation);
    assert.equal(refusals.length, 1, "exactly one cleanup refusal is recorded");
    assert.ok(refusals[0]!.includes(dirname(occupied)), "the refusal names the retained fixture root");
  });
});

test("fixture teardown: a TMPDIR replaced during broker startup never reaches a PTY", { skip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: TMPDIR replaced at launch", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const outside = join(invocation, "outside");
    mkdirSync(outside, { mode: 0o700 });
    // start() stages synchronously up to the awaited broker listen; replace the
    // private TMPDIR while that startup is still pending.
    const starting = fixture.start([{ command: "true", content: "never launched\n" }]);
    assert.notEqual(state.server, undefined, "broker startup is pending");
    assert.equal(state.pty, undefined, "no PTY has launched yet");
    rmSync(fixture.temp, { recursive: true, force: false });
    symlinkSync(outside, fixture.temp);
    // Either refusal of the final check: a link is not a real directory, and a
    // replacement directory would not carry the recorded identity.
    await assert.rejects(starting, /not a real directory|private temporary directory was replaced/,
      "startup rejects at the last step before the PTY would receive the path");
    assert.equal(state.pty, undefined, "no PTY ever launched");
    assert.deepEqual(readdirSync(outside), [], "nothing was written through the replacement link");
    const error = await teardown.run();
    assertRefusedAndRetained(error, /private TMPDIR is missing or was replaced/, invocation, fixture, teardown);
    assert.equal(state.server?.listening, false, "teardown closed the broker");
  });
});

test("fixture teardown: an occupied TMPDIR keeps its setup error and is refused", { skip: selfTestSkip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: occupied TMPDIR", defer);
    const fsModule = nodeRequire("node:fs") as { mkdirSync: typeof mkdirSync };
    const original = fsModule.mkdirSync;
    let sentinel: string | undefined;
    fsModule.mkdirSync = ((...args: Parameters<typeof mkdirSync>) => {
      const target = String(args[0]);
      if (sentinel === undefined && dirname(dirname(target)) === invocation && target.endsWith("/tmp")) {
        original(target, { mode: 0o700 });
        sentinel = join(target, "sentinel.txt");
        writeFileSync(sentinel, "unexplained", { flag: "wx" });
      }
      return original(...args);
    }) as typeof mkdirSync;
    try {
      assert.throws(() => createFixture(teardown.context), { code: "EEXIST" });
    } finally {
      fsModule.mkdirSync = original;
    }
    assert.ok(sentinel !== undefined, "the TMPDIR was occupied during allocation");
    const error = await teardown.run();
    assert.ok(error instanceof Error);
    assert.match(error.message, /an unexplained entry occupies the private TMPDIR/);
    assert.ok(teardown.diagnostics.some((line) => line.startsWith("fixture cleanup: ")));
    assert.equal(readFileSync(sentinel, "utf8"), "unexplained");
    const refusals = refusalEntries(invocation);
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.includes(dirname(dirname(sentinel))));
  });
});

test("fixture teardown: a PTY launch with no returned handle is not exit evidence", { skip }, async (t) => {
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: uncertain PTY launch", defer);
    const fixture = createFixture(teardown.context);
    const state = fixtureStates.get(fixture)!;
    const sentinel = join(fixture.scratch, "launch-evidence.txt");
    writeFileSync(sentinel, "keep while settlement is unknown", { flag: "wx" });
    const spawnError = new Error("controlled node-pty failure before returning a handle");
    const original = nodePty.spawn;
    // Model the same throw exposed by node-pty after a native fork, without
    // deliberately creating an unsupervised child for the test itself.
    nodePty.spawn = () => { throw spawnError; };
    try {
      await assert.rejects(fixture.start([{ command: "true" }]), (error: unknown) => error === spawnError);
    } finally {
      nodePty.spawn = original;
    }
    assert.equal(state.pty, undefined);
    assert.equal(state.server?.listening, true, "the fixture already established its own broker");
    const error = await teardown.run();
    assertRefusedAndRetained(error, /the PTY launch did not establish an exit observer/, invocation, fixture, teardown);
    assert.equal(state.server?.listening, false, "uncertain PTY launch still closes the known broker");
    assert.equal(readFileSync(sentinel, "utf8"), "keep while settlement is unknown");
  });
});

test("fixture teardown: an unconfirmed root removal is refused", {
  skip: selfTestSkip || (process.getuid?.() === 0 ? "permission bits do not bind the superuser" : false),
}, async (t) => {
  if (PRESERVE_FILES) {
    t.skip("explicit preserve never attempts removal");
    return;
  }
  await withSyntheticInvocationRoot(t, async (invocation, defer) => {
    const teardown = captureTeardown("self-test: removal", defer);
    const fixture = createFixture(teardown.context);
    const locked = join(fixture.scratch, "locked");
    mkdirSync(locked, { mode: 0o700 });
    writeFileSync(join(locked, "entry"), "");
    defer(() => { chmodSync(locked, 0o700); });
    chmodSync(locked, 0o500);
    const error = await teardown.run();
    assertRefusedAndRetained(error, /removing the fixture root failed/, invocation, fixture, teardown);
    assert.ok(existsSync(join(locked, "entry")), "the entry whose removal failed is retained");
  });
});
