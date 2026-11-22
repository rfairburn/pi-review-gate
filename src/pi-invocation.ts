import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "./record-guard";

/**
 * Shared alias-independent launch resolution for Pi child processes (issues #204 and #290).
 *
 * Shell aliases and functions never reach a Node child process: on Windows the
 * `pi` that an interactive PowerShell resolves may be an alias to the gate
 * wrapper, while the only PATH entry a spawned child can see is npm's `pi.cmd`
 * shim — which `spawn("pi", { shell: false })` cannot execute (ENOENT). This
 * module resolves an exact executable and spawn specification for every Pi
 * child launch (Pi reviewer, delegated Pi RPC executor, compaction recovery),
 * avoiding implicit shell mode:
 *
 * - A configured custom command keeps its exact spawn semantics on every
 *   platform; only the default `pi` name is alias-dependent.
 * - POSIX default `pi`: plain execvp of the PATH entry (aliases are a shell
 *   feature and cannot affect it).
 * - Windows default `pi`: the installed `pi.exe` directly, or the full-path
 *   `pi.cmd` through the launcher's authoritative spawn spec, using the
 *   parent's validated absolute SystemRoot\System32\cmd.exe
 *   (scripts/pi-review-gate-launcher.cjs). The shim stays opaque and uses
 *   normal batch parsing; no alias or gate-wrapper recursion can occur.
 *
 * When the default Pi CLI or trusted Windows command interpreter is
 * unavailable, resolution fails closed with an actionable error instead of
 * spawning a command that cannot exist.
 */

export type PiChildSpawn =
  | { ok: true; file: string; args: string[]; windowsVerbatimArguments?: true }
  | { ok: false; kind: "missing" | "cmd-unavailable" | "helper-unavailable" | "admitted-unavailable"; error: string };

type LauncherPiSpawnSpec = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: string,
) => PiChildSpawn;

/** The default Pi CLI name; only this exact command is alias-dependent. */
export const DEFAULT_PI_COMMAND = "pi";

/** Actionable diagnostic for a missing default Pi CLI. */
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

/**
 * #682: validate an optional host-admitted Pi executable before it replaces
 * the default `pi` command of a canonical Pi worker or Pi model reviewer.
 *
 * The value is a trusted, nonpersisted runtime launch input supplied by the
 * owning controller (never task text, settings, or a durable record). Absent
 * keeps every existing launch byte-for-byte; present must be a non-empty
 * absolute path without NUL bytes, otherwise the launch fails closed instead
 * of silently falling back to an ambient `pi`.
 */
export function admittedPiCommandOrUndefined(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  if (typeof command !== "string" || command.length === 0 || command.includes("\0") || !isAbsolute(command)) {
    throw new Error("review gate: the admitted Pi executable must be a non-empty absolute path; refusing the Pi launch.");
  }
  return command;
}

/** Path-free refusal for an admitted Pi executable that cannot be launched. */
export const ADMITTED_PI_UNAVAILABLE_DIAGNOSTIC =
  "review gate: the admitted Pi executable is unavailable (missing, not a regular file, or not executable); " +
  "refusing the Pi launch without falling back to an ambient pi.";

/** Stable label for diagnostics that must never carry the admitted path. */
export const ADMITTED_PI_LABEL = "the admitted Pi executable";

/** Placeholder that replaces the admitted path in retained child diagnostics. */
export const ADMITTED_PI_REDACTION = "[admitted Pi executable]";

/** A launch-scoped admitted-path redactor; identity for non-admitted launches. */
export interface AdmittedPiOutputRedactor {
  (text: string): string;
  (text: string | undefined): string | undefined;
}

/**
 * Build once per admitted launch a redactor that removes the launch-only
 * admitted Pi path from child-authored text (stdout JSONL lines, stderr, a
 * startup stack, RPC error text, termination diagnostics) before it is
 * retained or interpreted, keeping the rest of the text. Covers the admitted
 * path, its canonical realpath (Node reports the resolved main module), their
 * `file://` URL forms, the Windows forward-slash spelling, and the
 * JSON-escaped spelling of each (so complete JSONL lines with backslashes or
 * quotes redact before parsing and stay valid JSON). Without an admitted
 * command it is the identity, so default and custom launches keep their
 * output byte-for-byte.
 */
export function createAdmittedPiOutputRedactor(
  command: string | undefined,
  platform: NodeJS.Platform = process.platform,
): AdmittedPiOutputRedactor {
  const ordered: string[] = [];
  function redact(text: string): string;
  function redact(text: string | undefined): string | undefined;
  function redact(text: string | undefined): string | undefined {
    if (text === undefined || ordered.length === 0) return text;
    let redacted = text;
    for (const form of ordered) redacted = redacted.replaceAll(form, ADMITTED_PI_REDACTION);
    return redacted;
  }
  if (command === undefined || command.length === 0) return redact;
  const paths = new Set<string>([command]);
  try {
    paths.add(realpathSync(command));
  } catch {
    // A missing or unreadable entry still redacts its literal spelling.
  }
  const forms = new Set<string>();
  for (const path of paths) {
    try {
      forms.add(pathToFileURL(path).href);
    } catch {
      // Keep the literal forms when no URL spelling exists.
    }
    forms.add(path);
    if (platform === "win32") forms.add(path.replaceAll("\\", "/"));
  }
  // Once- and twice-escaped spellings: a reviewer verdict (JSON text) that
  // quotes the path is itself serialized again inside a Pi JSONL event.
  for (const form of [...forms]) {
    const escaped = JSON.stringify(form).slice(1, -1);
    forms.add(escaped);
    forms.add(JSON.stringify(escaped).slice(1, -1));
  }
  // Longest first: a URL or escaped form contains a shorter form as a substring.
  ordered.push(...[...forms].filter((form) => form.length > 0).sort((left, right) => right.length - left.length));
  return redact;
}

/** One-shot form of {@link createAdmittedPiOutputRedactor}. */
export function redactAdmittedPiPath(text: string, command: string | undefined, platform?: NodeJS.Platform): string;
export function redactAdmittedPiPath(text: string | undefined, command: string | undefined, platform?: NodeJS.Platform): string | undefined;
export function redactAdmittedPiPath(
  text: string | undefined,
  command: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return createAdmittedPiOutputRedactor(command, platform)(text);
}

/**
 * One Pi child launch target. `admitted` marks a trusted host-admitted Pi CLI
 * (#682): it is resolved by {@link resolveAdmittedPiChildSpawn}, never by the
 * default-`pi` or configured-custom-command rules, and its path is kept out
 * of every diagnostic.
 */
export interface PiLaunchCommand {
  command: string;
  admitted: boolean;
}

/**
 * Resolve the spawn of a trusted host-admitted Pi CLI. The native host admits
 * the public JS CLI entry: on Windows it runs through the host Node executable
 * (`execPath` with the entry as its first argument, exactly as the native
 * host launch does); POSIX executes the entry directly. A preflight refuses a
 * path that is not an absolute regular file (executable on POSIX, readable on
 * Windows) with a path-free diagnostic and no ambient fallback.
 */
export function resolveAdmittedPiChildSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): PiChildSpawn {
  const argv = [...args];
  let usable = false;
  try {
    admittedPiCommandOrUndefined(command);
    usable = statSync(command).isFile();
    if (usable) accessSync(command, platform === "win32" ? fsConstants.R_OK : fsConstants.X_OK);
  } catch {
    usable = false;
  }
  if (!usable) return { ok: false, kind: "admitted-unavailable", error: ADMITTED_PI_UNAVAILABLE_DIAGNOSTIC };
  return platform === "win32"
    ? { ok: true, file: execPath, args: [command, ...argv] }
    : { ok: true, file: command, args: argv };
}

/** Resolve either an admitted Pi CLI or the existing default/custom command. */
export function resolvePiLaunchSpawn(
  launch: PiLaunchCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PiChildSpawn {
  return launch.admitted
    ? resolveAdmittedPiChildSpawn(launch.command, args)
    : resolvePiChildSpawn(launch.command, args, env);
}

/**
 * Replace a raw spawn error from an admitted Pi launch (whose message, `path`,
 * and `spawnargs` carry the absolute path) with a path-free error that keeps
 * only a safe error code. Non-admitted launches keep the existing translation.
 */
export function translatePiLaunchSpawnError(error: unknown, admitted: boolean, isDefaultPiPassThrough: boolean): Error {
  if (!admitted) return translateDefaultPiSpawnError(error, isDefaultPiPassThrough);
  const rawCode = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : "SPAWN_ERROR";
  const sanitized = new Error(
    `review gate: ${ADMITTED_PI_LABEL} failed to start (${code}); refusing the Pi launch without falling back to an ambient pi.`,
  ) as NodeJS.ErrnoException;
  sanitized.code = code;
  return sanitized;
}

let launcherResolver: LauncherPiSpawnSpec | undefined;

/**
 * Lazily load the launcher's resolvePiChildSpawnSpec. The path is computed at
 * runtime so TypeScript does not type-check the CommonJS launcher; requiring
 * it executes only top-level definitions (its CLI entry point is guarded by
 * `require.main === module`). Both shipped layouts keep scripts/ beside the
 * compiled extension: <package>/dist/src + <package>/scripts and a source
 * checkout's dist(-test)/src + scripts.
 */
function loadLauncherResolver(): LauncherPiSpawnSpec | undefined {
  if (launcherResolver) return launcherResolver;
  const launcherPath = resolve(__dirname, "../../scripts/pi-review-gate-launcher.cjs");
  let module: unknown;
  try {
    module = require(launcherPath);
  } catch {
    return undefined;
  }
  const candidate = isRecord(module) ? module.resolvePiChildSpawnSpec : undefined;
  if (typeof candidate !== "function") return undefined;
  launcherResolver = candidate.bind(module as object) as LauncherPiSpawnSpec;
  return launcherResolver;
}

/**
 * Resolve how to spawn a Pi child process with the given command and argv.
 * The returned `file`/`args` pair is spawned with `shell: false`; on Windows
 * the default `pi` resolves to the installed pi.exe or a full-path pi.cmd
 * command through the validated absolute SystemRoot\System32\cmd.exe,
 * while custom commands and every POSIX spawn stay exactly as configured.
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
  const resolveSpawnSpec = loadLauncherResolver();
  if (!resolveSpawnSpec) {
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
  const invocation = resolveSpawnSpec(command, argv, resolverEnv, platform);
  if (!invocation.ok && invocation.kind === "missing") {
    return { ...invocation, error: missingPiDiagnostic() };
  }
  return invocation;
}
