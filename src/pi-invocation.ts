import { resolve } from "node:path";

/**
 * Shared alias-independent launch resolution for Pi child processes (issue #204).
 *
 * Shell aliases and functions never reach a Node child process: on Windows the
 * `pi` that an interactive PowerShell resolves may be an alias to the gate
 * wrapper, while the only PATH entry a spawned child can see is npm's `pi.cmd`
 * shim — which `spawn("pi", { shell: false })` cannot execute (ENOENT). This
 * module resolves the exact executable and argument prefix for every Pi child
 * launch (Pi reviewer, delegated Pi RPC executor, compaction recovery) without
 * a shell:
 *
 * - A configured custom command keeps its exact spawn semantics on every
 *   platform; only the default `pi` name is alias-dependent.
 * - POSIX default `pi`: plain execvp of the PATH entry (aliases are a shell
 *   feature and cannot affect it).
 * - Windows default `pi`: the installed `pi.exe` directly, or npm's `pi.cmd`
 *   shim resolved to its JavaScript entry point and launched through this Node
 *   binary — reusing the launcher's fail-closed `resolvePiInvocation`
 *   (scripts/pi-review-gate-launcher.cjs), so no shell ever reparses user
 *   arguments and no alias or gate-wrapper recursion can occur.
 *
 * When the default Pi CLI is missing or its shim cannot be resolved, the
 * result fails closed with an actionable error instead of spawning a command
 * that cannot exist.
 */

export type PiChildSpawn =
  | { ok: true; file: string; args: string[] }
  | { ok: false; kind: "missing" | "unresolved" | "helper-unavailable"; shim?: string; error: string };

/** The exact result shape of the launcher's resolvePiInvocation. */
type LauncherPiInvocation =
  | { kind: "path" }
  | { kind: "direct"; file: string }
  | { kind: "node"; file: string }
  | { kind: "unresolved"; shim: string }
  | { kind: "missing" };

type LauncherResolver = (env: NodeJS.ProcessEnv, platform: string) => LauncherPiInvocation;

/** The default Pi CLI name; only this exact command is alias-dependent. */
export const DEFAULT_PI_COMMAND = "pi";

/** Actionable diagnostic for a missing or unresolvable default Pi CLI. */
export function missingPiDiagnostic(): string {
  return "The default pi command was not found on PATH while launching a Pi child process; " +
    "install Pi (npm install -g @earendil-works/pi) or configure an explicit reviewer/executor command.";
}

/**
 * Translate a raw spawn ENOENT from the POSIX default-pi pass-through (where
 * the resolved file is still the bare `pi` PATH name) into the actionable
 * missing-CLI diagnostic. Every other error — custom commands, resolved
 * Windows targets, non-ENOENT failures — passes through unchanged.
 */
export function translateDefaultPiSpawnError(error: unknown, isDefaultPiPassThrough: boolean): Error {
  if (
    isDefaultPiPassThrough
    && typeof error === "object"
    && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return new Error(missingPiDiagnostic());
  }
  return error instanceof Error ? error : new Error(String(error));
}

let launcherResolver: LauncherResolver | undefined;

/**
 * Lazily load the launcher's resolvePiInvocation. The path is computed at
 * runtime so TypeScript does not type-check the CommonJS launcher; requiring
 * it executes only top-level definitions (its CLI entry point is guarded by
 * `require.main === module`). Both shipped layouts keep scripts/ beside the
 * compiled extension: <package>/dist/src + <package>/scripts and a source
 * checkout's dist(-test)/src + scripts.
 */
function loadLauncherResolver(): LauncherResolver | undefined {
  if (launcherResolver) return launcherResolver;
  const launcherPath = resolve(__dirname, "../../scripts/pi-review-gate-launcher.cjs");
  let module: unknown;
  try {
    module = require(launcherPath);
  } catch {
    return undefined;
  }
  const candidate = isRecord(module) ? module.resolvePiInvocation : undefined;
  if (typeof candidate !== "function") return undefined;
  launcherResolver = candidate.bind(module as object) as LauncherResolver;
  return launcherResolver;
}

/**
 * Resolve how to spawn a Pi child process with the given command and argv.
 * The returned `file`/`args` pair is spawned with `shell: false`; on Windows
 * the default `pi` resolves to the installed pi.exe or the npm shim's JS
 * entry through this Node binary, while custom commands and every POSIX spawn
 * stay exactly as configured.
 */
export function resolvePiChildSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PiChildSpawn {
  // Copy so callers' argv is never aliased into the resolved spawn.
  const argv = [...args];
  if (command !== DEFAULT_PI_COMMAND || platform !== "win32") {
    return { ok: true, file: command, args: argv };
  }
  const resolveInvocation = loadLauncherResolver();
  if (!resolveInvocation) {
    return {
      ok: false,
      kind: "helper-unavailable",
      error:
        "Could not load the packaged pi-review-gate launcher helper to resolve the default pi command; " +
        "reinstall or rebuild pi-review-gate, or configure an explicit reviewer/executor command.",
    };
  }
  // Windows environment variable names are case-insensitive, but a copied
  // env object is not: Node preserves the original key casing (commonly
  // `Path`), while the launcher helper reads only `env.PATH`. Normalize a
  // PATH-spelling that differs in case so an installed Pi is not reported
  // missing on Windows.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const resolverEnv = env.PATH === undefined && pathKey ? { ...env, PATH: env[pathKey] } : env;
  const invocation = resolveInvocation(resolverEnv, platform);
  switch (invocation.kind) {
    case "direct":
      return { ok: true, file: invocation.file, args: argv };
    case "node":
      // The shim's JavaScript entry runs through this Node binary; the
      // original arguments follow byte-exact and are never reparsed.
      return { ok: true, file: process.execPath, args: [invocation.file, ...argv] };
    case "unresolved":
      return {
        ok: false,
        kind: "unresolved",
        shim: invocation.shim,
        error:
          `Could not resolve the pi entry point from the npm shim at ${invocation.shim} while launching a Pi child process; ` +
          "reinstall Pi (npm install -g @earendil-works/pi) or configure an explicit reviewer/executor command.",
      };
    case "missing":
      return { ok: false, kind: "missing", error: missingPiDiagnostic() };
    default:
      // "path" cannot occur for win32 from the launcher resolver; keep the
      // plain PATH spawn rather than inventing a failure.
      return { ok: true, file: command, args: argv };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
