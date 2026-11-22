/**
 * #682: bounded Codex CLI version evidence for one explicitly requested owned
 * Codex launch's callback compatibility.
 *
 * The owned Codex callback transport writes `turn/steer` with
 * `expectedTurnId` + `clientUserMessageId` and the experimental
 * `thread/queue/*` methods, a contract verified only on the Codex CLI versions
 * in {@linkcode CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS} (pinned to the idle-wake
 * contract's own `codexVersion`). The transport refuses to exist without the
 * host's `expectedTurnSteer` attestation; this module is where that
 * attestation's evidence comes from, and nothing else:
 *
 * - It runs the already-resolved, canonical executable the owned app-server
 *   backend of THIS launch is rendered from, once, as `<file> --version`,
 *   through the same shell-free, process-group-bounded, byte-capped runner as
 *   the Claude inbox probe (./native-claude-version-probe). No new runner,
 *   setting, or environment entry exists.
 * - Only stdout is parsed, and only the exact official form
 *   `codex-cli <major>.<minor>.<patch>`; stderr is counted and discarded.
 *   Neither stream is logged, echoed in a reason, or returned: an outcome is a
 *   fixed code or one validated version string from the supported set.
 * - Every failure (spawn error, timeout, oversized output, nonzero exit,
 *   signal, unrecognized form, unsupported version) is a `declined` outcome,
 *   never a thrown error, so the ordinary launch is never failed by it. An
 *   unproved or unsupported build never yields an attestation: fail closed.
 *
 * The caller owns eligibility (backend, platform, default target, owned plan,
 * prepared managed MCP relay) and hands in the backend's own environment.
 */
import { NATIVE_CODEX_IDLE_WAKE_CONTRACT } from "./native-codex-idle-wake";
import {
  runBoundedVersionCommand,
  type NativeVersionCommandResult,
  type NativeVersionCommandRunner,
} from "./native-claude-version-probe";

/** The Codex CLI builds whose callback wire contract was verified (#682). */
export const CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS: readonly string[] = Object.freeze([
  NATIVE_CODEX_IDLE_WAKE_CONTRACT.codexVersion,
]);

/** Platforms where the bounded direct-exec runner exists; anything else declines without running. */
export const CODEX_CALLBACK_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(["linux"]);

/** Wall-clock bound for the Codex `--version` probe; it sits on an ordinary launch path. */
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Combined stdout+stderr byte cap; a real answer is one short line. */
export const CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES = 4 * 1024;

const VERSION_ARGS: readonly string[] = Object.freeze(["--version"]);

/** Exact official Codex CLI `--version` stdout: the product tag and one stable triple. */
const CODEX_VERSION_STDOUT = /^codex-cli (\d{1,6}\.\d{1,6}\.\d{1,6})\r?\n?$/u;

/** Closed reasons a requested Codex callback compatibility was declined. */
export type NativeCodexCallbackCompatibilityDeclineReason =
  /** The launch is not a Codex launch. */
  | "not-codex-backend"
  /** The host platform has no bounded probe runner. */
  | "unsupported-platform"
  /** The launch is not the default Codex target (a configured command, args, env, or profile). */
  | "not-default-target"
  /** The launch carries no owned app-server plan, so there is no owned backend to write to. */
  | "not-owned-backend"
  /** This launch's managed MCP relay was not prepared on the owned backend. */
  | "native-mcp-not-prepared"
  /** The probe failed, timed out, overflowed its cap, or did not exit cleanly. */
  | "version-unavailable"
  /** The probe exited cleanly but its stdout is not the exact official form. */
  | "version-unrecognized"
  /** The exact executable reports a version whose callback contract is not verified. */
  | "version-unsupported";

/**
 * Outcome of an explicitly requested Codex callback compatibility check. Only
 * `verified` is evidence: its `version` is one exact entry of
 * {@linkcode CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS}, observed from the exact
 * canonical executable this launch's owned backend is rendered from.
 */
export type NativeCodexCallbackCompatibilityOutcome =
  | { readonly compatibility: "verified"; readonly version: string }
  | { readonly compatibility: "declined"; readonly reason: NativeCodexCallbackCompatibilityDeclineReason };

/** Frozen decline outcome; reasons are fixed codes only. */
export function declineCodexCallbackCompatibility(
  reason: NativeCodexCallbackCompatibilityDeclineReason,
): NativeCodexCallbackCompatibilityOutcome {
  return Object.freeze({ compatibility: "declined", reason });
}

/**
 * Probe the exact canonical Codex executable and classify the result. Never
 * rejects: an unexpected runner failure is `version-unavailable`.
 */
export async function probeCodexCallbackCompatibility(input: {
  readonly file: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runner?: NativeVersionCommandRunner;
}): Promise<NativeCodexCallbackCompatibilityOutcome> {
  const runner = input.runner ?? runBoundedVersionCommand;
  let result: NativeVersionCommandResult;
  try {
    result = await runner(input.file, VERSION_ARGS, {
      env: input.env,
      cwd: input.cwd,
      timeoutMs: CODEX_VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES,
    });
  } catch {
    return declineCodexCallbackCompatibility("version-unavailable");
  }
  if (result === null || typeof result !== "object" || result.kind !== "completed") {
    return declineCodexCallbackCompatibility("version-unavailable");
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const match = CODEX_VERSION_STDOUT.exec(stdout);
  if (match === null) return declineCodexCallbackCompatibility("version-unrecognized");
  const version = match[1];
  if (!CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS.includes(version)) {
    return declineCodexCallbackCompatibility("version-unsupported");
  }
  return Object.freeze({ compatibility: "verified", version });
}

/**
 * The verified, supported version a provider descriptor carries for this
 * request, or `undefined` for anything else (absent, declined, malformed, or a
 * version outside the supported set). Read by the owning manager only.
 */
export function readCodexCallbackCompatibilityVersion(descriptor: unknown): string | undefined {
  try {
    if (descriptor === null || typeof descriptor !== "object") return undefined;
    const outcome: unknown = (descriptor as { codexCallbackCompatibility?: unknown }).codexCallbackCompatibility;
    if (outcome === null || typeof outcome !== "object") return undefined;
    const { compatibility, version } = outcome as { compatibility?: unknown; version?: unknown };
    return compatibility === "verified" && typeof version === "string"
      && CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS.includes(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}
