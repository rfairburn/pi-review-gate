/**
 * #682: the production composition of the reviewed Windows Claude managed
 * callback lane — the host-side pieces only, built from already-landed parts.
 *
 * ## What this module composes
 *
 * - **Trusted PowerShell.** {@linkcode resolveWindowsClaudePowerShell} uses the
 *   existing fixed-system-path resolver (`resolveTrustedSystemPowerShell`:
 *   the inherited `SystemRoot`/`WINDIR`, never PATH or the cwd) and admits only
 *   the exact System32 Windows PowerShell 5.1 shape the custody renderer and the
 *   version runner validate (`pwsh.exe` or any other answer is refused). It is a
 *   bounded same-user trust assumption, not a signature or owner proof.
 * - **The exact version runner.** {@linkcode createWindowsClaudeVersionRunnerForHost}
 *   builds the reviewed exact-image `--version` runner
 *   (./native-windows-claude-version-runner) over that path, for the native CLI
 *   launcher's Windows probe. No trusted PowerShell means no runner, and the probe
 *   then refuses `runner-unavailable` and starts nothing.
 * - **Target trust.** {@linkcode proveWindowsClaudeTargetTrust} is the caller's
 *   prior verification the version probe relies on (it re-proves no ownership
 *   or ACL itself): with the existing trusted DACL helper policy only, every
 *   ancestor of the exact canonical `claude.exe` (drive root first) must be a
 *   real directory no untrusted principal can rewrite or replace entries in,
 *   and the file itself one no untrusted principal can modify, replace, or
 *   re-permission — the Windows counterpart of the macOS trusted-path rule.
 *   It proves a same-user trust boundary, not publisher provenance: no code
 *   signature is checked (as on Linux and macOS). Anything unprovable refuses,
 *   and the launch then proceeds without callback.
 * - **The callback-only custody composition.** {@linkcode createWindowsClaudeCallbackCustodyComposition}
 *   is the instance manager's Windows custody composition option in its
 *   `callbackOnly` form: the manager consults it only for a row whose protected
 *   hook callback channel is already eligible on its own facts (a `verified`
 *   supported version receipt from the launcher, the prepared authenticated
 *   Claude root hook, and the kept managed MCP lane), so every other Windows row
 *   keeps the unchanged direct spawn and ordinary non-callback tools. Before
 *   admitting, it preflights the exact wrapper render of the row's target and
 *   argv (worst-case PID, fixed-width placeholders), so an argv custody cannot
 *   carry is declined into the ordinary launch before any process starts. Its one
 *   supervisor spawn is a direct, shell-free spawn of exactly the trusted
 *   PowerShell file with the renderer's exact argv, private piped stdio, hidden,
 *   not detached, and an allowlisted environment (below). There is no fallback:
 *   a launch whose file, argv, or spawn options differ is refused before any
 *   spawn, and the manager treats that as a closed admitted failure.
 *
 * ## Supervisor environment (allowlist)
 *
 * The supervisor receives exactly the environment the reviewed runner gives its
 * own PowerShell helper: the version probe's system allowlist (`SystemRoot`,
 * `SystemDrive`, `windir`, `TEMP`, `TMP`; every other libuv-required name pinned
 * empty) with only `USERPROFILE` set to this same-user host process's own value
 * (stock PowerShell 5.1 does not start with it blank). No provider, credential,
 * hook, bootstrap, custody, or callback marker value reaches it; a host
 * environment carrying the native hook bootstrap marker, or a missing or
 * malformed value, declines the selection before any effect. The per-run hook key
 * never travels in this environment (the adapter writes it once on private stdin).
 *
 * ## Trust boundary (accepted, stated)
 *
 * The approved same-user boundary only: the runner's suspended-image check and
 * the supervisor's protected handles do not sandbox, or defend against, an
 * attacker running as the same user. Live acceptance of this exact composition
 * on a Windows host is separate work; the portable tests drive it through its
 * seams and run no PowerShell.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";

import type {
  NativeWindowsClaudeCustodyManagerComposition,
  NativeWindowsClaudeCustodyManagerRequest,
  NativeWindowsClaudeCustodyManagerSelection,
} from "./instances";
import type { PeerStatePermissionPolicy } from "./network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy } from "./network/peer-state-permissions";
import { resolveTrustedSystemPowerShell } from "./network/peer-state-windows-permissions";
import {
  WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS,
  buildWindowsClaudeCustodyWrapperLaunch,
  validatePowerShellPath,
  type WindowsClaudeCustodySupervisorLaunch,
} from "./native-windows-claude-custody-scripts";
import {
  buildWindowsClaudeVersionEnvironment,
  windowsClaudeTargetAncestors,
  type WindowsExactImageVersionRunner,
} from "./native-windows-claude-version-probe";
import {
  buildWindowsClaudeVersionRunnerHelperEnvironment,
  createWindowsClaudeVersionRunner,
  type WindowsClaudeVersionRunnerSpawn,
} from "./native-windows-claude-version-runner";

/** The one host platform this composition serves. */
export const WINDOWS_CLAUDE_CALLBACK_PLATFORM: NodeJS.Platform = "win32";

/** Resolver seam: an absolute candidate path, or `null`/`undefined` when none resolves. */
export type WindowsClaudePowerShellResolver = () => string | null | undefined;

/** The supervisor's direct spawn seam (production: Node's `child_process.spawn`). */
export type WindowsClaudeSupervisorSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * The trusted System32 Windows PowerShell 5.1 path, or `undefined`. Never
 * throws; any resolver failure or shape mismatch is `undefined`.
 */
export function resolveWindowsClaudePowerShell(
  resolve: WindowsClaudePowerShellResolver = resolveTrustedSystemPowerShell,
): string | undefined {
  try {
    const candidate = resolve();
    return typeof candidate === "string" ? validatePowerShellPath(candidate) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reviewed exact-image version runner over the trusted PowerShell path, or
 * `undefined` when no trusted PowerShell resolves. Nothing is spawned until the
 * probe invokes `run`. Never throws.
 */
export function createWindowsClaudeVersionRunnerForHost(options: {
  readonly resolvePowerShell?: WindowsClaudePowerShellResolver;
  /** Test seam only; production uses the runner's own direct spawn. */
  readonly spawn?: WindowsClaudeVersionRunnerSpawn;
  /** Test seam only; production reads `process.env.USERPROFILE` per run. */
  readonly userProfile?: () => string | undefined;
} = {}): WindowsExactImageVersionRunner | undefined {
  const powershellPath = resolveWindowsClaudePowerShell(options.resolvePowerShell);
  if (powershellPath === undefined) return undefined;
  try {
    return createWindowsClaudeVersionRunner({
      powershellPath,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.userProfile === undefined ? {} : { userProfile: options.userProfile }),
    });
  } catch {
    return undefined;
  }
}

/**
 * The supervisor's allowlisted spawn environment (see the module header), or
 * `undefined` when the host environment cannot supply it. Never throws.
 */
export function buildWindowsClaudeCustodySupervisorEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  userProfile: unknown,
): Readonly<Record<string, string>> | undefined {
  try {
    const allowlisted = buildWindowsClaudeVersionEnvironment(hostEnvironment);
    return allowlisted === null ? undefined : buildWindowsClaudeVersionRunnerHelperEnvironment(allowlisted, userProfile);
  } catch {
    return undefined;
  }
}

const productionSupervisorSpawn: WindowsClaudeSupervisorSpawn = (file, args, options) => nodeSpawn(file, [...args], options);

/** True only for the exact reviewed supervisor spawn options (private pipes, hidden, attached, no shell). */
function exactSupervisorSpawnOptions(options: unknown): boolean {
  const expected = WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS;
  if (options === null || typeof options !== "object") return false;
  const candidate = options as Partial<Record<keyof typeof expected, unknown>>;
  const stdio = candidate.stdio;
  return Array.isArray(stdio) && stdio.length === expected.stdio.length
    && stdio.every((value, index) => value === expected.stdio[index])
    && candidate.windowsHide === expected.windowsHide
    && candidate.detached === expected.detached
    && candidate.shell === expected.shell
    && Object.keys(options).length === Object.keys(expected).length;
}

/** The largest supervisor PID the wrapper renderer admits (its widest rendering). */
const WORST_CASE_SUPERVISOR_PID = 0x7fff_ffff;

/**
 * Pure preflight of the exact wrapper render the adapter performs only AFTER
 * the supervisor exists: the row's exact target and argv through the existing
 * renderer, with fixed-width placeholders for the per-launch pipe and nonce and
 * the widest admitted supervisor PID, so the real command line can never be
 * longer. A target or argv the renderer refuses (an unpaired surrogate, a
 * control character, an over-long command line, ...) declines the row here,
 * before any custody process, into the ordinary direct launch. The adapter's
 * own render and its post-spawn fail-closed handling are unchanged.
 */
function wrapperRenderable(powershellPath: string, request: NativeWindowsClaudeCustodyManagerRequest): boolean {
  try {
    buildWindowsClaudeCustodyWrapperLaunch({
      powershellPath,
      target: request.target,
      args: request.args,
      ctlPipe: `prg682-ctl-${"0".repeat(32)}`,
      ctlNonce: "0".repeat(32),
      supervisorPid: WORST_CASE_SUPERVISOR_PID,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The production Windows Claude custody composition for the instance manager
 * (`callbackOnly: true`). Each selection resolves the trusted PowerShell path
 * and the allowlisted supervisor environment afresh and preflights the exact
 * wrapper render of the row's target and argv; any of them missing or refused
 * declines the row before any custody effect (it keeps the unchanged direct
 * spawn).
 * The returned supervisor spawn is single-purpose: exactly that PowerShell
 * file, the renderer's exact argv and spawn options, and that environment.
 */
export function createWindowsClaudeCallbackCustodyComposition(options: {
  readonly resolvePowerShell?: WindowsClaudePowerShellResolver;
  /** Test seam only; production uses Node's `child_process.spawn`. */
  readonly spawn?: WindowsClaudeSupervisorSpawn;
  /** Test seam only; production reads `process.env` at each selection. */
  readonly hostEnvironment?: () => NodeJS.ProcessEnv;
} = {}): NativeWindowsClaudeCustodyManagerComposition {
  const spawnSupervisor = options.spawn ?? productionSupervisorSpawn;
  const readHostEnvironment = options.hostEnvironment ?? ((): NodeJS.ProcessEnv => process.env);
  return Object.freeze({
    callbackOnly: true,
    select: (request: NativeWindowsClaudeCustodyManagerRequest): NativeWindowsClaudeCustodyManagerSelection | undefined => {
      const powershellPath = resolveWindowsClaudePowerShell(options.resolvePowerShell);
      if (powershellPath === undefined) return undefined;
      let hostEnvironment: NodeJS.ProcessEnv;
      try {
        hostEnvironment = readHostEnvironment();
      } catch {
        return undefined;
      }
      const env = buildWindowsClaudeCustodySupervisorEnvironment(hostEnvironment, hostEnvironment?.USERPROFILE);
      if (env === undefined) return undefined;
      if (!wrapperRenderable(powershellPath, request)) return undefined;
      return Object.freeze({
        powershellPath,
        spawnSupervisor: (launch: WindowsClaudeCustodySupervisorLaunch): ChildProcess => {
          const args: unknown = launch?.args;
          if (launch === null || typeof launch !== "object" || launch.file !== powershellPath
            || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")
            || !exactSupervisorSpawnOptions(launch.spawnOptions)) {
            // Refused before any spawn; the manager records a closed failure (no fallback).
            throw new Error("session-host: the Windows Claude custody supervisor launch is not the reviewed direct spawn");
          }
          return spawnSupervisor(powershellPath, Object.freeze([...args as string[]]), {
            stdio: [...WINDOWS_CLAUDE_CUSTODY_SUPERVISOR_SPAWN_OPTIONS.stdio],
            windowsHide: true,
            detached: false,
            shell: false,
            env: { ...env },
          });
        },
      });
    },
  });
}

/** No-follow `lstat` seam (tests only); production uses `node:fs` `lstatSync`. */
export type WindowsClaudeTrustLstat = (path: string) => BigIntStats;

function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * #682: prove, with the EXISTING Windows permission policy only, that no
 * untrusted principal can replace the exact canonical Claude executable `file`
 * or any component of its path (see the module header). Top-down from the
 * drive root: each ancestor must be a real directory (never a link or
 * junction) that passes `assertReplacementProtectedAncestor` and is still the
 * same object afterwards; then the file must be a real regular file that
 * passes `assertProtectedExecutable` and is still the same object. A policy
 * lacking either proof proves nothing. Only an admitted drive-absolute direct
 * `.exe` path is considered. Never throws.
 */
export function proveWindowsClaudeTargetTrust(
  file: string,
  options: {
    readonly permissions?: PeerStatePermissionPolicy;
    readonly lstat?: WindowsClaudeTrustLstat;
  } = {},
): boolean {
  try {
    const ancestors = windowsClaudeTargetAncestors(file);
    if (ancestors === null) return false;
    const permissions = options.permissions ?? createPeerStatePermissionPolicy({ platform: "win32" });
    const observe = options.lstat ?? ((path: string): BigIntStats => lstatSync(path, { bigint: true }));
    const ancestorProof = permissions.assertReplacementProtectedAncestor;
    const fileProof = permissions.assertProtectedExecutable;
    if (typeof ancestorProof !== "function" || typeof fileProof !== "function") return false;
    for (const component of [...ancestors, file]) {
      const isFile = component === file;
      const before = observe(component);
      if (before.isSymbolicLink() || (isFile ? !before.isFile() : !before.isDirectory())) return false;
      if (isFile) fileProof.call(permissions, component);
      else ancestorProof.call(permissions, component);
      const after = observe(component);
      if (after.isSymbolicLink() || (isFile ? !after.isFile() : !after.isDirectory()) || !sameObject(before, after)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
