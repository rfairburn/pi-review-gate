import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { posix } from "node:path";
import {
  normalizeConfig,
  reviewGateConfigCandidatePresent,
  reviewGateGlobalDisableEnv,
  type ReviewGateConfig,
} from "../config";
import { compatibilityFallbackConfigPath, PI_AGENT_DIR_ENV, piAgentConfigPath } from "../config-path";
import { MAX_NATIVE_CONFIG_BYTES } from "./launch";

/**
 * Strict, fresh read of the persisted review-gate settings for a native
 * (Claude/Codex) managed-tool request (issue #682).
 *
 * Native agents cannot change review-gate settings in-app, so the native owner
 * takes ONE snapshot at the start of each request from the very file the
 * sidebar editor saves and Pi loads: same path resolution as the session
 * host's local settings editor (`PI_REVIEW_GATE_DISABLED`, the host-normalized
 * explicit `PI_REVIEW_GATE_CONFIG`, then `<agentDir>/review-gate.json` and the
 * sole compatibility fallback under the host's home) and the same strict
 * `normalizeConfig` schema every settings Save validates against. Every
 * consulted path must be fully qualified: the agent-directory candidate needs
 * no home, and the compatibility fallback is consulted only with an absolute
 * host home — never the process home or working directory.
 *
 * Unlike Pi's startup `loadConfig`, nothing is recovered or defaulted: a
 * missing, unreadable, non-regular, oversized, non-UTF-8, malformed, or
 * invalid file (or any document a Save would reject) yields a closed
 * `unavailable` outcome, and
 * the kill switch yields `disabled`. There is no cache, memo, fallback to a
 * previous snapshot, write, or second settings store; every call re-reads the
 * disk. Inputs come only from the owner-supplied host environment snapshot and
 * resolution, never from `process.env` or a model-controlled environment. Diagnostics are
 * fixed strings plus the resolved path: file bytes and validator messages
 * (which may quote stored values) are never surfaced.
 */

export interface PersistedReviewGateSource {
  /**
   * The host startup environment snapshot after `resolveManagedConfigOverride`.
   * Read, never mutated. Only its kill switch, explicit override, and home
   * variable are consulted.
   */
  readonly env: NodeJS.ProcessEnv;
  /** The canonical absolute native Pi agent directory managed children receive. */
  readonly agentDir: string;
  /**
   * The effective home the owner resolved for config discovery (the sidebar's
   * `configResolutionForEnv(env).homeDir`). Preferred over the environment's
   * home variable; must be absolute, otherwise the compatibility location is
   * not consulted. Never derived here from the process.
   */
  readonly resolvedHomeDir?: string;
}

export type PersistedReviewGateUnavailableReason =
  | "invalid-source"
  | "relative-override"
  | "home-unresolved"
  | "no-config"
  | "missing"
  | "unreadable"
  | "not-regular-file"
  | "too-large"
  | "invalid-encoding"
  | "invalid-json"
  | "invalid-config";

export type PersistedReviewGateSnapshot =
  | {
    readonly status: "available";
    /** Resolved file the snapshot was read from. */
    readonly path: string;
    /** Strictly normalized settings; a detached, deeply frozen copy. */
    readonly config: Readonly<ReviewGateConfig>;
  }
  | {
    readonly status: "disabled";
    /** The kill-switch variable that is set. */
    readonly envName: string;
    readonly message: string;
  }
  | {
    readonly status: "unavailable";
    readonly reason: PersistedReviewGateUnavailableReason;
    readonly message: string;
    /** Present once a candidate path was resolved. */
    readonly path?: string;
  };

const MESSAGES: Record<PersistedReviewGateUnavailableReason, string> = {
  "invalid-source": "the host did not supply an absolute native Pi agent directory",
  "relative-override": "PI_REVIEW_GATE_CONFIG is not an absolute path in the host environment",
  "home-unresolved": "no review-gate config exists in the native Pi agent directory and the host environment does not name an absolute home directory for the compatibility location",
  "no-config": "no review-gate config file exists",
  missing: "the review-gate config file does not exist",
  unreadable: "the review-gate config file could not be read",
  "not-regular-file": "the review-gate config is not a regular file",
  "too-large": `the review-gate config exceeds the ${MAX_NATIVE_CONFIG_BYTES}-byte bound`,
  "invalid-encoding": "the review-gate config is not valid UTF-8",
  "invalid-json": "the review-gate config is not valid JSON",
  "invalid-config": "the review-gate config does not pass settings validation",
};

/** Read one fresh strict snapshot. Never throws, caches, or writes. */
export function readPersistedReviewGateSnapshot(source: PersistedReviewGateSource): PersistedReviewGateSnapshot {
  const { env, agentDir } = source;
  const disabled = reviewGateGlobalDisableEnv(env);
  if (disabled) {
    return { status: "disabled", envName: disabled, message: `the review gate is globally disabled because ${disabled} is set` };
  }
  if (typeof agentDir !== "string" || !fullyQualified(agentDir)) return unavailable("invalid-source");

  const located = locateConfig(env, agentDir, source.resolvedHomeDir);
  if ("failure" in located) return unavailable(located.failure);
  const { path } = located;

  const read = readBounded(path);
  if ("failure" in read) return unavailable(read.failure, path);
  let text: string;
  try {
    // Fatal decoding: a replaced byte inside an exact-match name would change
    // the policy instead of failing. A BOM is kept so JSON.parse rejects it,
    // exactly as Pi's own read does.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    return unavailable("invalid-encoding", path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable("invalid-json", path);
  }
  let config: ReviewGateConfig;
  try {
    config = normalizeConfig(parsed);
  } catch {
    return unavailable("invalid-config", path);
  }
  // Detach from any shared defaults before freezing so neither this snapshot
  // nor module-level defaults can be changed through the other.
  return { status: "available", path, config: deepFreeze(structuredClone(config)) };
}

function unavailable(reason: PersistedReviewGateUnavailableReason, path?: string): PersistedReviewGateSnapshot {
  return path === undefined
    ? { status: "unavailable", reason, message: MESSAGES[reason] }
    : { status: "unavailable", reason, message: MESSAGES[reason], path };
}

/**
 * The file `loadConfig` would select for a managed child launched with
 * `PI_CODING_AGENT_DIR=<agentDir>` and the host's home, with the same
 * precedence (explicit override, primary, compatibility fallback; presence in
 * any form counts) but no relative or process-derived location.
 */
function locateConfig(
  env: NodeJS.ProcessEnv,
  agentDir: string,
  resolvedHomeDir: string | undefined,
): { path: string } | { failure: PersistedReviewGateUnavailableReason } {
  const explicit = env.PI_REVIEW_GATE_CONFIG;
  if (explicit) return fullyQualified(explicit) ? { path: explicit } : { failure: "relative-override" };
  const platform = process.platform;
  // Prefer the owner's explicit resolution; otherwise the same home variable
  // choice as `configResolutionForEnv`, without its process fallback. A
  // relative value is never resolved against the cwd.
  const homeValue = resolvedHomeDir ?? (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME);
  const home = homeValue && fullyQualified(homeValue) ? homeValue : undefined;
  // agentDir is fully qualified, so Pi-native tilde expansion never consults homeDir.
  const primary = piAgentConfigPath({ [PI_AGENT_DIR_ENV]: agentDir }, { homeDir: home ?? agentDir, platform });
  try {
    if (reviewGateConfigCandidatePresent(primary)) return { path: primary };
    if (home === undefined) return { failure: "home-unresolved" };
    const fallback = compatibilityFallbackConfigPath({ homeDir: home, platform });
    return reviewGateConfigCandidatePresent(fallback) ? { path: fallback } : { failure: "no-config" };
  } catch {
    return { failure: "unreadable" };
  }
}

/**
 * A path naming one location regardless of cwd or current drive (the same
 * rule the host applies to the explicit override): on Windows only
 * drive-qualified and UNC/device paths qualify.
 */
function fullyQualified(path: string): boolean {
  if (process.platform !== "win32") return posix.isAbsolute(path);
  return /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** Bounded nonblocking read of a regular file (symlinks followed, as Pi does). */
function readBounded(path: string): { bytes: Uint8Array } | { failure: PersistedReviewGateUnavailableReason } {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    return { failure: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { failure: "not-regular-file" };
    if (stats.size > MAX_NATIVE_CONFIG_BYTES) return { failure: "too-large" };
    const buffer = Buffer.alloc(MAX_NATIVE_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_NATIVE_CONFIG_BYTES) return { failure: "too-large" };
    return { bytes: buffer.subarray(0, offset) };
  } catch {
    return { failure: "unreadable" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure never changes the outcome.
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}
