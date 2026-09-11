import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Canonical review-gate configuration location (issue 94).
 *
 * The default location on every platform is the native Pi agent directory plus
 * `review-gate.json` (normally `~/.pi/agent/review-gate.json`), honoring Pi's
 * `PI_CODING_AGENT_DIR` override with Pi's native semantics. The sole implicit
 * compatibility fallback is the historical XDG location
 * `~/.config/pi-review-gate/config.json`. The pre-#94 candidate
 * `~/.config/pi/review-gate.json` is no longer discovered or initialized, and
 * there is no automatic migration.
 *
 * This module intentionally mirrors Pi's own resolution instead of importing
 * it: `getAgentDir()` in the installed Pi `dist/config.js` honors
 * `PI_CODING_AGENT_DIR` (non-empty values only) with tilde expansion and, on
 * Windows, Git Bash/MSYS drive-path normalization, and otherwise resolves
 * `<homedir>/.pi/agent`. The launcher (`scripts/pi-review-gate.sh`) carries a
 * commented bash mirror of the same semantics; keep the two in sync.
 */

/** File name of the review-gate configuration inside the Pi agent directory. */
export const REVIEW_GATE_CONFIG_FILENAME = "review-gate.json";

/** Pi's native agent-directory override (never the npm install root). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface ConfigPathResolution {
  /** Home directory for Pi-native defaults and the compatibility fallback. */
  homeDir: string;
  /** Platform used for Pi-native override semantics (Windows path forms). */
  platform: NodeJS.Platform;
}

/** Explicit test seam; production resolution uses the real home and platform. */
export function resolveConfigPathResolution(
  resolution: Partial<ConfigPathResolution> = {},
): ConfigPathResolution {
  return {
    homeDir: resolution.homeDir ?? homedir(),
    platform: resolution.platform ?? process.platform,
  };
}

/** Native join for the resolved platform (win32 joins with backslashes). */
function joinForPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  return (platform === "win32" ? win32 : posix).join(...segments);
}

/**
 * Convert Git Bash, MSYS, Cygwin, and WSL drive paths to the form native
 * Windows APIs accept. Parity with Pi's `normalizeWindowsShellPath`
 * (installed `dist/utils/paths.js`): a lone leading drive path such as
 * `/c/Users`, `/mnt/c/Users`, or `/cygdrive/c/Users` becomes `C:\Users`;
 * everything else (UNC paths, backslash-bearing paths, non-drive POSIX paths)
 * is returned unchanged.
 */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * The native Pi agent directory: `PI_CODING_AGENT_DIR` with Pi's native
 * semantics when set to a non-empty value (tilde expansion against the
 * resolved home, plus Windows drive-path normalization on win32), otherwise
 * `<homeDir>/.pi/agent`. This is the Pi *agent data* directory, never the npm
 * install root.
 */
export function piAgentDir(env: NodeJS.ProcessEnv, resolution?: Partial<ConfigPathResolution>): string {
  const resolved = resolveConfigPathResolution(resolution);
  const override = env[PI_AGENT_DIR_ENV];
  if (!override) {
    return joinForPlatform(resolved.platform, resolved.homeDir, ".pi", "agent");
  }
  const expanded = resolved.platform === "win32" ? normalizeWindowsShellPath(override) : override;
  if (expanded === "~") return resolved.homeDir;
  if (expanded.startsWith("~/") || (resolved.platform === "win32" && expanded.startsWith("~\\"))) {
    return joinForPlatform(resolved.platform, resolved.homeDir, expanded.slice(2));
  }
  return expanded;
}

/** Default (primary) config path: native Pi agent directory + review-gate.json. */
export function piAgentConfigPath(env: NodeJS.ProcessEnv, resolution?: Partial<ConfigPathResolution>): string {
  const resolved = resolveConfigPathResolution(resolution);
  return joinForPlatform(resolved.platform, piAgentDir(env, resolved), REVIEW_GATE_CONFIG_FILENAME);
}

/**
 * Sole implicit compatibility fallback: the historical XDG location. Only
 * loaded when the Pi-agent default does not exist; never created by
 * initialization.
 */
export function compatibilityFallbackConfigPath(resolution?: Partial<ConfigPathResolution>): string {
  const resolved = resolveConfigPathResolution(resolution);
  return joinForPlatform(resolved.platform, resolved.homeDir, ".config", "pi-review-gate", "config.json");
}

/**
 * Implicit discovery order: the Pi-agent default first, then the sole
 * compatibility fallback. The explicit `PI_REVIEW_GATE_CONFIG` override is
 * handled by `loadConfig` and is deliberately not part of this list. The
 * removed `~/.config/pi/review-gate.json` location must never appear here.
 */
export function reviewGateConfigCandidates(
  env: NodeJS.ProcessEnv,
  resolution?: Partial<ConfigPathResolution>,
): string[] {
  return [piAgentConfigPath(env, resolution), compatibilityFallbackConfigPath(resolution)];
}