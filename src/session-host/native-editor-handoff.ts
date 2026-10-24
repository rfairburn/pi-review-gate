/**
 * Owned external-editor PTY handoff for the strict framed child (issue #499).
 *
 * With the closed input-framing bridge installed, EVERY byte the host writes to
 * this child's fd 0 is an authenticated `prg-ni-v2` frame, and the child's bridge
 * is its only decoder. Pi's generic external-editor action (`Ctrl+G` and any other
 * invocation of that same action) stops the native TUI and then spawns the user's
 * configured editor command with `stdio: "inherit"`, which hands fd 0 to a non-Node
 * reader. That reader cannot decode frames: it sees framing text as keystrokes, and
 * the user's keystrokes come back as echoed framing text.
 *
 * This module corrects the boundary entirely inside the owned child. It installs a
 * narrowly audited `node:child_process` spawn adapter that recognizes exactly ONE
 * thing — Pi's own external-editor launch of an inherited-stdio child — and gives
 * that launch its OWN terminal instead of fd 0:
 *
 * - Provenance is Pi's generic external-editor launcher inside the supported
 *   runtime's own `dist`, never an executable name, an argument pattern, or a
 *   running-process guess. The configured command and arguments, the result file,
 *   and the complete/failed/cancel semantics stay Pi's: this module reads no file,
 *   parses no editor configuration, and inspects no processes.
 * - Verified bytes keep flowing through the SAME decoder with the SAME per-dispatch
 *   authentication. The bridge only routes each already-decoded logical dispatch's
 *   ordinary payload to the owned editor instead of the native listeners, never to
 *   both, and never an unauthenticated byte.
 * - Any other spawn call — pipes, an fd array, a shell, another launcher, another
 *   caller — is left exactly as it is today. There is no global spawn change, no
 *   raw window, no framing toggle, no second decoder, and no new host-side policy.
 * - If the handoff cannot be established BEFORE an editor exists (unsupported
 *   platform, no PTY support, no TTY, a runtime version this module never audited, or
 *   a launcher whose provenance is not the audited one), the launch fails closed with
 *   a fixed notice. An editor is never
 *   allowed to inherit fd 0, because fd 0 carries framing bytes.
 * - Once an editor process exists, ONLY its own positive exit settles the handoff.
 *   Every later failure unwinds by signalling the owned PTY and waiting for that
 *   same exit, so the launcher never resumes while an editor it no longer owns is
 *   still running on the terminal. A launch whose exit cannot be witnessed at all is
 *   held rather than answered, because reporting "no launch" would let Pi resume over
 *   a possibly live editor.
 *
 * SETTLEMENT POINTS: this module's own awaited settlement is joined by the reporter in
 * two places — the authenticated native shutdown request (after that request's own
 * admission) and Pi's `session_shutdown` hook, which the installed supported runtime
 * awaits for every handler and awaits again during SIGTERM/SIGHUP disposal before it
 * exits. Where no positive witness exists, neither point reports completion: no timer,
 * deadline, or escalation is invented here, and the host's existing stop bounds stay
 * authoritative. Windows is unsupported: Pi launches the editor through a shell there,
 * so the adapter is not installed at all.
 *
 * The child's own tty is put into raw mode for the duration so its line discipline
 * neither buffers nor echoes the framed bytes the host is still writing. That is a
 * terminal-mode fact of THIS process, restored on settlement.
 */
import { EventEmitter } from "node:events";
import { constants as OS_CONSTANTS } from "node:os";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getCallSites } from "node:util";
import { fileURLToPath } from "node:url";
import type { NativeClipboardRuntime } from "./native-clipboard";

/**
 * The one launcher this adapter knows: Pi's generic external-editor entry point,
 * present under that exact name in the shipped 1.3.0/1.4.0 bundle chunks and in the
 * unbundled `dist/modes/interactive/external-editor.js`. It is a Pi function name,
 * never an editor name: whatever `VISUAL`/`EDITOR`/setting resolves to stays opaque.
 */
const LAUNCHER_FUNCTION = "editInExternalEditor";

/** Fixed, payload-free notices: never a path, command, argument, token, or error. */
const REFUSAL_UNVERIFIED = "the external editor launcher could not be authenticated for framed input; the edit was not started";
const REFUSAL_UNAVAILABLE = "the external editor could not be given its own terminal; the edit was not started";
const REFUSAL_BUSY = "another external editor already holds this terminal; the edit was not started";
const REFUSAL_ABORTED = "the external editor could not be set up on its own terminal; the edit did not complete";

/** Bound the stack walk, matching the clipboard bridge's own bound. */
const MAX_PROVENANCE_FRAMES = 16;
/** Geometry fallback, used only when this process's own tty reports no usable size. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The owned editor sink: verified ordinary bytes, exactly as authenticated. */
export interface EditorHandoffSink {
  write(data: Buffer): void;
}

/** The small owned PTY surface the handoff needs; injectable so unit tests load no addon. */
export interface EditorPtySurface {
  readonly pid: number;
  write(data: Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  /** Runtime node-pty EventEmitter hooks; the pinned declaration omits these. */
  on?(event: "error" | "exit", listener: (payload: never) => void): unknown;
  removeListener?(event: "error" | "exit", listener: (payload: never) => void): unknown;
}

export interface EditorPtyDescriptor {
  readonly file: string;
  readonly args: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
}

export type EditorPtyFactory = (descriptor: EditorPtyDescriptor) => EditorPtySurface;

/** This process's own terminal surfaces, injectable for focused tests. */
export interface EditorHandoffTerminal {
  readonly isRaw?: boolean;
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): unknown;
  pause(): unknown;
  isPaused?(): boolean;
  readonly columns?: number;
  readonly rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface NativeEditorHandoffOptions {
  /** The supported runtime the bridge already resolved. */
  readonly runtime: NativeClipboardRuntime;
  /** True while an owned editor sink already owns this child's verified bytes. */
  editorActive(): boolean;
  /** Enter (a sink) or retire (undefined) the editor route; invalidates in-flight input. */
  setEditorSink(sink: EditorHandoffSink | undefined): void;
  /**
   * The ORIGINAL stdout writer, captured before the clipboard wrapper. The editor's
   * output is a plain terminal relay: it gains no clipboard provenance, emits no
   * capsule, and runs under no input dispatch scope.
   */
  writeStdout(chunk: string | Buffer): boolean;
  readonly stdin?: EditorHandoffTerminal;
  readonly stdout?: EditorHandoffTerminal;
  readonly stderr?: { write(chunk: string): unknown };
  readonly platform?: NodeJS.Platform;
  readonly ptyFactory?: EditorPtyFactory;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function sourcePath(script: string | undefined): string | undefined {
  if (typeof script !== "string" || script.length === 0) return undefined;
  try {
    return script.startsWith("file:") ? fileURLToPath(script) : isAbsolute(script) ? script : undefined;
  } catch {
    return undefined;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Both sides of this comparison can arrive through a symlink: macOS reports `/tmp`
 * and `/var` paths that V8 resolves to `/private/...`, and an installed runtime can
 * itself be reached through a link. Every candidate form of the frame and of the
 * runtime's own `dist` root is compared, so identity — not spelling — decides.
 */
const DIST_ROOTS = new WeakMap<NativeClipboardRuntime, readonly string[]>();

function distRoots(runtime: NativeClipboardRuntime): readonly string[] {
  const cached = DIST_ROOTS.get(runtime);
  if (cached !== undefined) return cached;
  const dist = join(runtime.root, "dist");
  const roots = [...new Set([dist, realpath(dist)])];
  DIST_ROOTS.set(runtime, roots);
  return roots;
}

/** True only for a script inside the supported runtime's own `dist` tree. */
function withinRuntimeDist(runtime: NativeClipboardRuntime, script: string | undefined): boolean {
  const path = sourcePath(script);
  if (path === undefined) return false;
  const candidates = [...new Set([path, realpath(path)])];
  return distRoots(runtime).some((root) => candidates.some((candidate) => contains(root, candidate)));
}

interface StackFrame {
  readonly functionName: string;
  readonly scriptName: string | undefined;
}

/** Raw V8 frames (never source-mapped), taken from inside the spawn adapter itself. */
function callFrames(frameCount: number): StackFrame[] {
  try {
    return getCallSites(frameCount).map((site) => ({
      functionName: typeof site.functionName === "string" ? site.functionName : "",
      scriptName: typeof site.scriptName === "string" ? site.scriptName : undefined,
    }));
  } catch {
    return [];
  }
}

type Provenance = "absent" | "unverified" | "owned";

/**
 * `"owned"` only when the audited launcher frame lives in the supported runtime's
 * `dist` AND every frame between that launcher and this module's own adapter does
 * too — that is, the launcher's spawn call reaches this adapter only through the
 * runtime's own code. The launcher's own frame IS its spawn call site, so the walk
 * stops at the first frame belonging to this module. `"absent"` means this is not an
 * external-editor launch at all, so nothing here changes. `"unverified"` means a
 * launcher claiming that name is driving an inherited-stdio launch from outside the
 * audited runtime, which fails closed instead of receiving fd 0.
 */
function launchProvenance(runtime: NativeClipboardRuntime, frames: readonly StackFrame[], ownScript: string): Provenance {
  const launcher = frames.findIndex((frame) => frame.functionName === LAUNCHER_FUNCTION);
  if (launcher < 0) return "absent";
  if (!withinRuntimeDist(runtime, frames[launcher]!.scriptName)) return "unverified";
  for (let index = launcher - 1; index >= 0; index -= 1) {
    const script = sourcePath(frames[index]!.scriptName);
    if (script !== undefined && (script === ownScript || realpath(script) === ownScript)) break;
    if (!withinRuntimeDist(runtime, frames[index]!.scriptName)) return "unverified";
  }
  return "owned";
}

interface LaunchShape {
  readonly file: string;
  readonly args: string[];
}

/**
 * The exact launch shape Pi uses: `spawn(command, [...args, file], { stdio:
 * "inherit" })` with no shell wrapper. The configured command and its full argument
 * vector are preserved verbatim; anything else — pipes, an fd array, a shell, a
 * non-string command — is not an editor handoff and is left completely alone.
 */
function launchShape(file: unknown, args: unknown, options: unknown): LaunchShape | undefined {
  // Mirror Node's own normalization: a non-array second argument IS the options.
  let rawArgs: unknown = args;
  let rawOptions: unknown = options;
  if (!Array.isArray(rawArgs) && rawOptions === undefined && record(rawArgs)) {
    rawOptions = rawArgs;
    rawArgs = [];
  }
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return undefined;
  if (!Array.isArray(rawArgs)) return undefined;
  for (const arg of rawArgs) if (typeof arg !== "string" || arg.includes("\0")) return undefined;
  if (!record(rawOptions)) return undefined;
  if (rawOptions.stdio !== "inherit") return undefined;
  if (rawOptions.shell !== undefined && rawOptions.shell !== false) return undefined;
  if (rawOptions.windowsVerbatimArguments !== undefined && rawOptions.windowsVerbatimArguments !== false) {
    return undefined;
  }
  return { file, args: [...(rawArgs as string[])] };
}

/** This process's own reported size, or the fallback when it reports none. */
function dimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Signal number to the signal NAME Node's own child processes report. A POSIX program
 * killed by a signal is reported by a PTY as a numeric signal with a ZERO exit code,
 * and the audited launcher treats code 0 as success — so a signal-terminated editor
 * must never be forwarded as `close(0, …)`, or Pi would accept a result file its
 * editor never finished writing.
 */
const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(OS_CONSTANTS.signals).flatMap(([name, value]) =>
    typeof value === "number" ? [[value, name] as const] : []),
);

/** Mutable state behind the child surface handed back to the launcher. */
interface ChildState {
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  settled: boolean;
  kill(signal?: string): boolean;
}

/**
 * The minimal child surface the audited launcher uses — `on("error")`, `on("exit")`
 * and `on("close")` plus `kill()` and `pid`. It exists only inside the audited
 * launch; no other caller ever receives it. Live fields are real accessors, so the
 * launcher observes the current pid, kill state, and exit status.
 */
type HandoffChild = EventEmitter & {
  readonly pid: number | undefined;
  readonly connected: boolean;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly spawnfile: string;
  readonly spawnargs: string[];
  readonly stdin: undefined;
  readonly stdout: undefined;
  readonly stderr: undefined;
  kill(signal?: string): boolean;
};

function handoffChild(spawnfile: string, spawnargs: readonly string[], state: ChildState): HandoffChild {
  const child = new EventEmitter() as unknown as Record<string, unknown>;
  const descriptor = (get: () => unknown): PropertyDescriptor => ({ enumerable: true, configurable: true, get });
  Object.defineProperties(child, {
    pid: descriptor(() => state.pid),
    connected: { enumerable: true, configurable: true, value: false },
    killed: descriptor(() => state.killed),
    exitCode: descriptor(() => state.exitCode),
    signalCode: descriptor(() => state.signalCode),
    spawnfile: { enumerable: true, configurable: true, value: spawnfile },
    spawnargs: { enumerable: true, configurable: true, value: [...spawnargs] },
    stdin: { enumerable: true, configurable: true, value: undefined },
    stdout: { enumerable: true, configurable: true, value: undefined },
    stderr: { enumerable: true, configurable: true, value: undefined },
    kill: { enumerable: true, configurable: true, value: (signal?: string) => state.kill(signal) },
  });
  return child as unknown as HandoffChild;
}

type Refusal = typeof REFUSAL_UNVERIFIED | typeof REFUSAL_UNAVAILABLE | typeof REFUSAL_BUSY;

/**
 * A launch that never created a process: one fixed notice line and an asynchronous
 * `error`, which is the launcher's existing failure path (`{ status: "failed" }`,
 * draft preserved, TUI restored). Nothing was owned, so nothing needs settling.
 */
function refusedChild(
  notice: Refusal, shape: LaunchShape, stderr: { write(chunk: string): unknown } | undefined,
): HandoffChild {
  const state: ChildState = {
    pid: undefined, killed: false, exitCode: null, signalCode: null, settled: true, kill: () => false,
  };
  const child = handoffChild(shape.file, shape.args, state);
  queueMicrotask(() => {
    try {
      stderr?.write(`pi-review-gate: ${notice}\n`);
    } catch {
      // A closed stderr cannot hide the error below.
    }
    child.emit("error", new Error(`pi-review-gate: ${notice}`));
  });
  return child;
}

let cachedNodePty: EditorPtyFactory | undefined;

/** Load the pinned PTY implementation from THIS package, never from Pi's tree. */
function defaultEditorPtyFactory(): EditorPtyFactory {
  if (cachedNodePty !== undefined) return cachedNodePty;
  const nodePty = createRequire(__filename)("@lydell/node-pty") as {
    spawn(file: string, args: string[], options: Record<string, unknown>): EditorPtySurface;
  };
  cachedNodePty = (descriptor) => nodePty.spawn(descriptor.file, [...descriptor.args], {
    name: typeof descriptor.env.TERM === "string" && descriptor.env.TERM.length > 0 ? descriptor.env.TERM : "xterm-256color",
    cols: descriptor.cols,
    rows: descriptor.rows,
    env: { ...descriptor.env },
  });
  return cachedNodePty;
}

/** Test-only loader seam, mirroring the host manager's own PTY loader seam. */
let ptyLoaderForTests: (() => EditorPtyFactory) | undefined;
export function setEditorPtyLoaderForTests(loader: (() => EditorPtyFactory) | undefined): void {
  ptyLoaderForTests = loader;
  cachedNodePty = undefined;
}

/**
 * Process-global slot holding the settlement for the nested external editor THIS
 * process owns, if any. The same global-slot idiom the clipboard bridge and the
 * reporter's sticky state already use, so the reporter reaches the one owned editor
 * without importing this module's PTY machinery, and a child that never launches an
 * editor never binds anything.
 */
const SHUTDOWN_SLOT = Symbol.for("pi-review-gate.native-editor-handoff.shutdown.v1");

interface EditorShutdownSlot {
  /** Resolve true only when the owned editor reached its own positive exit. */
  settle(): Promise<boolean>;
}

/** An editor that exists but whose exit cannot be witnessed can never claim settlement. */
const UNWITNESSED_SETTLEMENT: EditorShutdownSlot = { settle: () => Promise.resolve(false) };

function bindShutdownSlot(slot: EditorShutdownSlot): void {
  try {
    (globalThis as Record<PropertyKey, unknown>)[SHUTDOWN_SLOT] = slot;
  } catch { /* A global that cannot be written leaves settlement absent, never false. */ }
}

function unbindShutdownSlot(slot: EditorShutdownSlot): void {
  try {
    const storage = globalThis as Record<PropertyKey, unknown>;
    if (storage[SHUTDOWN_SLOT] === slot) delete storage[SHUTDOWN_SLOT];
  } catch { /* Best effort. */ }
}

/**
 * Editor-specific shutdown plumbing for the reporter's awaited native shutdown: stop
 * the nested external editor this process owns and AWAIT its own positive exit, so an
 * editor never survives the native session that launched it. Returns undefined when
 * nothing is owned — the caller then continues its shutdown exactly as it did before
 * this hook existed — and otherwise a promise resolving true once the owned editor
 * reached its own exit, or false when no witness exists. No timer, no escalation, and
 * no new authority: the host's existing grace window and POSIX fallback stay the only
 * bounds on the stop.
 */
export function settleOwnedNativeEditor(): Promise<boolean> | undefined {
  let slot: EditorShutdownSlot | undefined;
  try {
    const value = (globalThis as Record<PropertyKey, unknown>)[SHUTDOWN_SLOT];
    slot = record(value) && typeof value.settle === "function"
      ? { settle: value.settle as () => Promise<boolean> }
      : undefined;
  } catch {
    slot = undefined;
  }
  if (slot === undefined) return undefined;
  try {
    return Promise.resolve(slot.settle()).then((settled) => settled === true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

const SPAWN_ADAPTER = Symbol.for("pi-review-gate.native-editor-handoff.spawn-adapter.v1");

/** This module's own resolved path, used to find the boundary of the audited stack. */
const OWN_SCRIPT = (() => {
  try {
    return realpathSync(__filename);
  } catch {
    return __filename;
  }
})();

type SpawnImplementation = (this: Record<string, unknown>, file: unknown, args?: unknown, options?: unknown) => unknown;

/**
 * Patch the CJS `child_process.spawn` and re-sync the built-in ESM view: the
 * audited launchers import `spawn` from `node:child_process` as ESM, and this
 * adapter is installed pre-main, before that import is instantiated. The explicit
 * sync also covers a namespace object that was already created.
 */
function installSpawnAdapter(
  replace: (file: unknown, args: unknown, options: unknown) => HandoffChild | undefined,
): boolean {
  const childProcess = createRequire(__filename)("node:child_process") as Record<string, unknown>;
  const original = childProcess.spawn as SpawnImplementation | undefined;
  if (typeof original !== "function") return false;
  if ((original as { [SPAWN_ADAPTER]?: true })[SPAWN_ADAPTER] === true) return true;
  const adapter = function patchedSpawn(this: Record<string, unknown>, file: unknown, args?: unknown, options?: unknown): unknown {
    const replaced = replace(file, args, options);
    if (replaced !== undefined) return replaced;
    return original.call(this, file, args, options);
  } as unknown as SpawnImplementation;
  Object.defineProperty(adapter, SPAWN_ADAPTER, { value: true, enumerable: false });
  Object.setPrototypeOf(adapter, original);
  childProcess.spawn = adapter;
  try {
    // The adapter must be visible to ESM importers too. A sync problem is not a
    // half-install: the CJS patch alone is strictly narrower than today's behavior,
    // and the focused process test pins the ESM path on the supported runtime.
    (createRequire(__filename)("node:module") as { syncBuiltinESMExports?(): void }).syncBuiltinESMExports?.();
  } catch {
    // Never let a sync problem break the child: the adapter stays installed.
  }
  return childProcess.spawn === adapter;
}

/**
 * Install the editor handoff in the strict framed child. Returns true when the
 * adapter is in place; false means nothing changed at all.
 */
export function installNativeEditorHandoff(options: NativeEditorHandoffOptions): boolean {
  const platform = options.platform ?? process.platform;
  // Windows Pi launches the editor through a shell, which is not the audited
  // inherited-stdio shape, so the adapter is not installed there at all.
  if (platform !== "darwin" && platform !== "linux") return false;
  const stdin = options.stdin ?? (process.stdin as unknown as EditorHandoffTerminal);
  const stdout = options.stdout ?? (process.stdout as unknown as EditorHandoffTerminal);
  const stderr = options.stderr ?? process.stderr;

  const start = (shape: LaunchShape): HandoffChild => {
    if (options.editorActive()) return refusedChild(REFUSAL_BUSY, shape, stderr);
    if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
      return refusedChild(REFUSAL_UNAVAILABLE, shape, stderr);
    }
    const wasRaw = stdin.isRaw === true;
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() === true : false;
    const restoreTerminal = (): void => {
      try {
        if (stdin.isRaw !== wasRaw) stdin.setRawMode?.(wasRaw);
      } catch { /* Best-effort; the launcher restores its own mode when it resumes. */ }
      try {
        if (wasPaused) stdin.pause();
        else stdin.resume();
      } catch { /* Same. */ }
    };

    let pty: EditorPtySurface;
    try {
      const factory = ptyLoaderForTests?.() ?? options.ptyFactory ?? defaultEditorPtyFactory();
      pty = factory({
        file: shape.file,
        args: shape.args,
        cols: dimension(stdout.columns, DEFAULT_COLS),
        rows: dimension(stdout.rows, DEFAULT_ROWS),
        env: process.env,
      });
    } catch {
      // Nothing was created, so nothing is owned and nothing can be left behind.
      return refusedChild(REFUSAL_UNAVAILABLE, shape, stderr);
    }
    if (!record(pty) || typeof pty.write !== "function" || typeof pty.onData !== "function"
      || typeof pty.onExit !== "function" || typeof pty.kill !== "function") {
      // A surface that cannot report an exit cannot be settled honestly. The pinned
      // implementation always satisfies this contract; if one ever did not, the editor
      // is signalled and this launch is HELD instead of reported as never happening,
      // because a process may already exist and would outlive that report.
      const held = handoffChild(shape.file, shape.args, {
        pid: undefined, killed: false, exitCode: null, signalCode: null, settled: false, kill: () => false,
      });
      const owned = pty as Partial<EditorPtySurface>;
      bindShutdownSlot(UNWITNESSED_SETTLEMENT);
      try {
        owned.kill?.();
      } catch { /* Nothing further is owned. */ }
      try {
        process.on("exit", () => {
          try {
            owned.kill?.();
          } catch { /* The PTY master closes with this process. */ }
        });
      } catch { /* Best effort. */ }
      return held;
    }

    // From here on an editor process EXISTS, and only its own exit may settle it.
    const state: ChildState = {
      pid: pty.pid, killed: false, exitCode: null, signalCode: null, settled: false, kill: () => false,
    };
    const child = handoffChild(shape.file, shape.args, state);
    // Awaitable settlement for the reporter's explicit native shutdown, bound the
    // moment an editor exists: shutdown stops the editor and waits for this same owned
    // exit rather than trusting hang-up or a parent that cannot await.
    let resolveSettlement: (settled: boolean) => void = () => { /* replaced by the promise below */ };
    const settlement = new Promise<boolean>((resolve) => { resolveSettlement = resolve; });
    const slot: EditorShutdownSlot = {
      settle: () => {
        if (state.settled) return Promise.resolve(true);
        try {
          pty.kill();
        } catch { /* The exit observer still owns settlement. */ }
        return settlement;
      },
    };
    bindShutdownSlot(slot);
    let data: { dispose(): void } | undefined;
    let exit: { dispose(): void } | undefined;
    let resize: (() => void) | undefined;
    let abandoned = false;
    let exitWitness: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    let cleanupBound = false;
    /** A PTY read error is followed by the owned exit; only a real exit settles. */
    const onPtyError = (): void => { /* No escalation, no invented exit. */ };
    /** Cleanup safety only: never a routing or editor-identity decision. */
    const onProcessExit = (): void => {
      try {
        pty.kill();
      } catch { /* This process is going away; the PTY master closes with it. */ }
    };

    const unwind = (): void => {
      unbindShutdownSlot(slot);
      try {
        options.setEditorSink(undefined);
      } catch { /* The route was never entered, or already retired. */ }
      try {
        data?.dispose();
        exit?.dispose();
      } catch { /* The owned stream is closing. */ }
      data = undefined;
      exit = undefined;
      if (resize !== undefined) {
        try {
          stdout.off?.("resize", resize);
        } catch { /* Nothing further to unbind. */ }
        resize = undefined;
      }
      try {
        if (typeof pty.removeListener === "function") pty.removeListener("error", onPtyError as (payload: never) => void);
      } catch { /* Best effort. */ }
      try {
        if (exitWitness !== undefined && typeof pty.removeListener === "function") {
          pty.removeListener("exit", exitWitness as (payload: never) => void);
        }
      } catch { /* Best effort. */ }
      exitWitness = undefined;
      try {
        if (cleanupBound) process.off("exit", onProcessExit);
      } catch { /* Nothing further to unbind. */ }
      try {
        if (typeof pty.removeListener === "function") pty.removeListener("error", onPtyError);
      } catch { /* Best effort. */ }
      restoreTerminal();
    };

    const settle = (exitCode: number, signal?: number): void => {
      if (state.settled) return;
      state.settled = true;
      // Retire input ownership FIRST: a partial logical dispatch belongs to no sink,
      // and no late key can reach the native TUI that is about to resume.
      unwind();
      // The owned editor is gone: release any awaited native shutdown that was waiting
      // on this exact exit before the launcher is told anything.
      resolveSettlement(true);
      if (abandoned) {
        try {
          stderr?.write(`pi-review-gate: ${REFUSAL_ABORTED}\n`);
        } catch { /* A closed stderr cannot hide the error below. */ }
        child.emit("error", new Error(`pi-review-gate: ${REFUSAL_ABORTED}`));
        return;
      }
      // Child-process semantics, not raw PTY fields: a signal death has NO exit code,
      // so a zero code can never be read as a successful edit.
      const terminated = typeof signal === "number" && signal !== 0;
      const code = terminated ? null : exitCode;
      const name = terminated ? SIGNAL_NAMES.get(signal!) ?? null : null;
      state.exitCode = code;
      state.signalCode = name;
      // Only now does the launcher's promise resolve, so the launcher reads its
      // result file and restores its TUI after this child's input ownership is gone.
      child.emit("exit", code, name);
      child.emit("close", code, name);
    };

    state.kill = (signal?: string): boolean => {
      if (state.settled) return false;
      try {
        pty.kill(signal);
        state.killed = true;
        return true;
      } catch {
        return false;
      }
    };

    // Cleanup safety is bound BEFORE any witness exists: on every path from here, an
    // owned editor cannot be left behind when this process goes away. It is cleanup,
    // never a settlement witness (see the module note on native shutdown).
    try {
      process.on("exit", onProcessExit);
      cleanupBound = true;
    } catch { /* A process that cannot bind cleanup still cannot report a false launch. */ }

    // An authoritative exit witness is required BEFORE anything is reported to the
    // launcher. The pinned implementation reports the owned exit through `onExit`;
    // the same event on the surface's own emitter is the one equivalent witness.
    const witness = (event: { exitCode: number; signal?: number }): void => { settle(event.exitCode, event.signal); };
    let witnessed = false;
    try {
      exit = pty.onExit(witness);
      witnessed = true;
    } catch {
      try {
        if (typeof pty.on === "function") {
          pty.on("exit", witness as (payload: never) => void);
          exitWitness = witness;
          witnessed = true;
        }
      } catch {
        witnessed = false;
      }
    }
    if (!witnessed) {
      // An editor process EXISTS and its exit cannot be observed. Signalling it is all
      // that remains, and this launch is then HELD rather than answered: emitting an
      // error or restoring the terminal would let Pi resume its TUI over an editor
      // that may still be running on the same terminal. The owned exit cleanup stays
      // bound so the editor still cannot outlive this process.
      try {
        pty.kill();
      } catch { /* Nothing further is owned. */ }
      // A shutdown must never wait on an exit nobody can witness: report honestly that
      // settlement is unavailable so the host's existing stop path continues.
      unbindShutdownSlot(slot);
      bindShutdownSlot(UNWITNESSED_SETTLEMENT);
      return child;
    }

    try {
      data = pty.onData((chunk) => {
        // A plain terminal relay through the ORIGINAL stdout writer: no clipboard
        // provenance, no capsule, and no input dispatch scope for editor output.
        if (chunk.length > 0) options.writeStdout(chunk);
      });
      if (typeof pty.on === "function") pty.on("error", onPtyError);
      resize = () => {
        try {
          pty.resize(dimension(stdout.columns, DEFAULT_COLS), dimension(stdout.rows, DEFAULT_ROWS));
        } catch { /* A dying PTY needs no resize. */ }
      };
      stdout.on?.("resize", resize);
      // Raw mode here concerns only THIS process's own tty line discipline: without
      // it the host's framed bytes would be echoed to the screen and buffered until
      // a newline. The editor never touches this tty; it owns its own PTY.
      stdin.setRawMode!(true);
      // Enter the editor route (which drops any partial dispatch that started for
      // the native TUI), then start delivering bytes.
      options.setEditorSink({
        write: (bytes) => {
          try {
            pty.write(bytes);
          } catch { /* The owned editor is going away; its exit settles the handoff. */ }
        },
      });
      stdin.resume();
    } catch {
      // The editor exists, so it is signalled and awaited through its own exit
      // rather than abandoned: the launcher must never resume while a live editor
      // still holds the terminal.
      abandoned = true;
      try {
        pty.kill();
      } catch { /* The kill could not be delivered; the exit observer still owns settlement. */ }
      return child;
    }

    return child;
  };

  return installSpawnAdapter((file, args, options2) => {
    const shape = launchShape(file, args, options2);
    // Not an inherited-stdio editor launch: byte-for-byte unchanged behavior.
    if (shape === undefined) return undefined;
    const provenance = launchProvenance(options.runtime, callFrames(MAX_PROVENANCE_FRAMES), OWN_SCRIPT);
    if (provenance === "absent") return undefined; // Some other caller's inherited launch.
    // A recognized-but-unsupported runtime version is never handed a terminal: its
    // launcher and result semantics were never audited, so only a supported runtime's
    // audited launch may be taken over. Refusing this one launch changes nothing else.
    if (!options.runtime.supported || provenance === "unverified") {
      return refusedChild(REFUSAL_UNVERIFIED, shape, stderr);
    }
    return start(shape);
  });
}
