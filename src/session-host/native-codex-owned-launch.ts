/**
 * The production adapter from one owned Codex launch plan to one real, owned
 * app-server child (issue #277 owning-manager slice).
 *
 * This module is the only place in the product that turns
 * {@linkcode NativeCodexOwnedLaunchPlan.renderBackend} into a process. It adds no
 * policy of its own and owns nothing the manager does not already own:
 *
 * - **The plan renders, this module spawns.** The complete process spec — the
 *   same canonical executable, the same configured argv prefix and global
 *   configuration, this launch's hook channel, and the lease's closed control
 *   argv — comes from the plan. Nothing here splices a quoted string, re-quotes
 *   a rendered command line, stages a second copy, or composes a single argument
 *   of its own.
 * - **One exact captured child.** `spawnBackend` returns the real
 *   `ChildProcess` synchronously with both stdio readers attached, or throws only
 *   when no child was created. A created child is never hidden behind a throw.
 * - **Owned termination only.** Termination goes through the repository's one
 *   exact owned process/tree authority (`terminateProcessTree`), on the same
 *   captured handle, escalating SIGTERM to SIGKILL inside a bounded window. No
 *   pid scan, no process-name match, no group kill of anything else, and no
 *   adopted descendant.
 * - **Windows literal delivery.** A batch (`.cmd`/`.bat`) child's rendered
 *   `commandLine` is appended verbatim after the trusted `cmd.exe` program path
 *   with `windowsVerbatimArguments`, which is the same grammar the shipped
 *   launcher and the pinned PTY spawn already use. Spawning that plan with its
 *   empty `args` array — which would drop the whole app-server command — is
 *   refused rather than attempted.
 *
 * What this module never does: choose or scan an endpoint, adopt another
 * server, read or write provider configuration or credentials, generate a token,
 * or interpret anything about the provider beyond the spec it was handed.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute as posixIsAbsolute, win32 as windowsPath } from "node:path";

import { terminateProcessTree } from "../adapters/process";
import type { NativeLaunchDescriptor } from "./launch";
import { launchOwnedCodexBackend, type OwnedCodexBackendTerminationReport } from "./native-codex-backend";
import type { OwnedCodexBackendFactory } from "./instances";

/** Bounded SIGTERM window before the same owned handle is escalated. */
export const OWNED_CODEX_BACKEND_TERMINATION_GRACE_MS = 5_000;
/** Bounded SIGKILL window after escalation, on the same owned handle only. */
export const OWNED_CODEX_BACKEND_TERMINATION_KILL_MS = 2_000;

/** The spawn options this adapter passes to its (possibly injected) spawner. */
export interface OwnedCodexBackendSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly shell: false;
  readonly windowsHide: true;
  readonly detached: boolean;
  readonly windowsVerbatimArguments?: true;
}

export interface OwnedCodexBackendLauncherOptions {
  /** Platform injection keeps the Windows/POSIX branch hermetic in tests. */
  platform?: NodeJS.Platform;
  /** Overrides the owned backend's readiness deadline; absent keeps the lease default. */
  startupTimeoutMs?: number;
  /** Overrides the bounded owned-termination windows; absent keeps the shipped values. */
  terminationGraceMs?: number;
  terminationKillMs?: number;
  /**
   * Test seam for the one `node:child_process` call this module makes. Production
   * passes nothing and gets the real `spawn`; a test spawner must still return a
   * real captured `ChildProcess`-shaped handle, because the lease binds its whole
   * settlement proof to that exact object.
   */
  spawnChild?: (file: string, args: readonly string[], options: OwnedCodexBackendSpawnOptions) => ChildProcess;
  /**
   * Test seam over the repository's owned process/tree termination authority.
   * Production passes nothing and gets `terminateProcessTree` unchanged; a
   * replacement receives the same captured handle and the same signal.
   */
  terminateTree?: (child: ChildProcess, signal: NodeJS.Signals) => string | undefined;
}

/** The one spawn call this adapter makes, as a named seam. */
export type OwnedCodexBackendSpawner = (
  file: string,
  args: readonly string[],
  options: OwnedCodexBackendSpawnOptions,
) => ChildProcess;

/**
 * Build the host's owned Codex backend factory: the synchronous
 * `{identity, plan, signal} → lease` seam the instance manager consumes for a
 * launch whose provider attached an owned plan.
 */
export function createOwnedCodexBackendLauncher(
  options: OwnedCodexBackendLauncherOptions = {},
): OwnedCodexBackendFactory {
  const platform = options.platform ?? process.platform;
  const graceMs = options.terminationGraceMs ?? OWNED_CODEX_BACKEND_TERMINATION_GRACE_MS;
  const killMs = options.terminationKillMs ?? OWNED_CODEX_BACKEND_TERMINATION_KILL_MS;
  assertWindow(graceMs, "terminationGraceMs");
  assertWindow(killMs, "terminationKillMs");
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const terminateTree = options.terminateTree ?? terminateProcessTree;
  return (request) => launchOwnedCodexBackend({
    identity: request.identity,
    // The plan's backend base environment is the operator's own composition: this
    // adapter neither adds nor removes a single entry, and the lease adds only the
    // digest that arrives in its own generated control argv.
    baseEnv: request.plan.backendEnv,
    spawnBackend: (controlArgs, environment) => {
      const spec = request.plan.renderBackend(controlArgs, environment);
      return spawnRenderedBackend(spec, platform, spawnChild);
    },
    terminateOwnedBackend: (child, report) => terminateOwnedBackendChild(child, graceMs, killMs, terminateTree, report),
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    signal: request.signal,
  });
}

function assertWindow(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`owned Codex backend launcher ${name} must be a non-negative safe integer`);
  }
}

function defaultSpawnChild(file: string, args: readonly string[], options: OwnedCodexBackendSpawnOptions): ChildProcess {
  return nodeSpawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio] as ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: options.detached,
    ...(options.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
  });
}

function printable(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Validate one rendered backend spec and spawn it exactly as rendered.
 *
 * The validation is structural and fixed-message: a rejected spec never echoes
 * the provider's arguments, the rendered command line, or any environment value.
 * Its purpose is the one failure this adapter must never make — spawning a bare
 * program with an empty argv because a batch plan carries its whole command in the
 * pre-escaped `commandLine` — plus keeping the stdio shape the lease binds its
 * reader proof to. The exact returned handle is never hidden behind a throw: a
 * child that exists is handed back, and the lease is the authority on whether it
 * can prove anything about it.
 */
function spawnRenderedBackend(
  spec: NativeLaunchDescriptor,
  platform: NodeJS.Platform,
  spawnChild: OwnedCodexBackendSpawner,
): ChildProcess {
  const shaped = spec as { readonly file?: unknown; readonly args?: unknown; readonly commandLine?: unknown; readonly env?: unknown; readonly cwd?: unknown } | undefined;
  if (shaped === undefined || shaped === null || typeof shaped !== "object") {
    throw new Error("owned Codex backend: the rendered backend launch spec is missing");
  }
  if (!printable(shaped.file)) {
    throw new Error("owned Codex backend: the rendered backend launch spec names no executable file");
  }
  const args = shaped.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("owned Codex backend: the rendered backend launch spec has no argument list");
  }
  const commandLine = shaped.commandLine;
  if (commandLine !== undefined && !printable(commandLine)) {
    throw new Error("owned Codex backend: the rendered backend Windows command line is not a printable string");
  }
  const env = shaped.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)
    || Object.values(env).some((entry) => entry !== undefined && typeof entry !== "string")) {
    throw new Error("owned Codex backend: the rendered backend launch spec has no string environment");
  }
  const cwd = shaped.cwd;
  // The working directory is validated in the grammar of the platform the child is
  // spawned on: a Windows plan is rendered on a Windows host, and a POSIX check
  // would refuse its drive-qualified path outright.
  if (typeof cwd !== "string" || (platform === "win32" ? !windowsPath.isAbsolute(cwd) : !posixIsAbsolute(cwd))) {
    throw new Error("owned Codex backend: the rendered backend launch spec has no absolute working directory");
  }
  // A batch child is delivered as the one pre-escaped command line appended
  // verbatim after the program path, exactly as the plan rendered it; its argv is
  // intentionally empty, so the argv array is never what carries the command.
  const verbatim = commandLine !== undefined;
  const spawnArgs: readonly string[] = verbatim ? [commandLine] : args as readonly string[];
  const child = spawnChild(shaped.file, spawnArgs, {
    cwd,
    env: { ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    // A POSIX group leader is what lets the owned tree authority terminate this
    // backend and its own children, and nothing else, with one group signal.
    detached: platform !== "win32",
    ...(verbatim ? { windowsVerbatimArguments: true as const } : {}),
  });
  // The exact captured handle is returned as the spawner produced it: the lease
  // binds its whole settlement proof to this object, and it is the authority on
  // whether the two readers it needs exist. Refusing here with a throw would hide a
  // created child behind an error, which the spawn seam's contract forbids.
  return child;
}

function childHasExited(child: ChildProcess): boolean {
  return (child as { exitCode?: unknown }).exitCode != null
    || (child as { signalCode?: unknown }).signalCode != null;
}

/** Wait for this exact child's genuine `exit` event, bounded. Never destroys a pipe. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.on("exit", onExit);
    if (childHasExited(child)) finish(true);
  });
}

/**
 * Terminate one owned backend, on the exact captured handle, inside a bounded
 * window: SIGTERM on the owned tree, wait for its genuine exit, escalate to
 * SIGKILL on the same handle, wait again. It resolves only when that child's own
 * exit was observed (or the child had already exited), and rejects when the
 * window ends without one — which the lease records as a failed termination and
 * keeps unsettled, exactly as its settlement contract requires.
 *
 * It never waits on stdio closure, never destroys a pipe, and never signals
 * anything it was not handed. The lease's reporting handle is told immediately
 * before the SIGKILL attempt — whether or not that attempt then succeeds — and
 * never otherwise; it is reporting only and changes no signal or timing.
 */
async function terminateOwnedBackendChild(
  child: ChildProcess,
  graceMs: number,
  killMs: number,
  terminateTree: NonNullable<OwnedCodexBackendLauncherOptions["terminateTree"]>,
  report: OwnedCodexBackendTerminationReport | undefined,
): Promise<void> {
  if (childHasExited(child)) {
    return;
  }
  if ((child as { pid?: unknown }).pid === undefined) {
    // No fork ever happened, so there is nothing to signal. The lease still requires
    // this child's own exit or its proven pre-spawn failure for settlement; this
    // adapter never converts "nothing to signal" into a claim that it is gone.
    return;
  }
  // The returned diagnostic is deliberately unread: it can name an OS failure, and
  // the lease already records the outcome as a boolean. The wait below is the proof.
  terminateTree(child, "SIGTERM");
  if (await waitForChildExit(child, graceMs)) {
    return;
  }
  // Recorded before the forced call, so a throwing or failing send is still reported.
  report?.forceEscalationAttempted();
  terminateTree(child, "SIGKILL");
  if (await waitForChildExit(child, killMs)) {
    return;
  }
  throw new Error("owned Codex backend did not exit within the bounded owned termination window");
}
