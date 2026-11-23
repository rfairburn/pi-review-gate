/**
 * Shared application-command discovery (issue #277).
 *
 * One filesystem/PATH/PATHEXT/case contract serves BOTH the settings
 * availability probe (`applicationCommandAvailable` in
 * src/settings/validation.ts) and the native interactive CLI launch
 * descriptors (src/session-host/native-cli-launch.ts), so neither surface keeps
 * its own detector. One shared resolver is not an equivalence promise between
 * the two call sites: the probe is called with no base directory and with the
 * environment the settings layer assembles, while a launch passes the workspace
 * it spawns the child in and the composed child environment, so the same
 * command string can resolve to a different file — or to nothing — for the
 * child. There is deliberately no second detector.
 *
 * The semantics are an extraction of the settings probe this came from; the
 * only later change is the Windows bare-name rule below, which applies to both
 * call sites alike:
 *
 * - An explicit path (POSIX-absolute, Windows-absolute/drive/UNC, or anything
 *   containing a path separator) is tested exactly as given; PATH is never
 *   searched for it. Spaces, quotes, or parentheses in a real path are
 *   filename input, never shell command strings.
 * - A bare name is searched in PATH order. Empty PATH entries are skipped, so
 *   this resolver never searches the current directory implicitly. (POSIX
 *   guided reviewers do not use this resolver: their direct spawn keeps Node's
 *   own lookup — see src/cli-launch-preparation.ts.)
 * - On Windows only, a name with no extension tries each `PATHEXT` suffix
 *   (default `.COM;.EXE;.BAT;.CMD`; entries that are not a dot plus
 *   alphanumerics are dropped, survivors are lowercased). A BARE name searched
 *   on PATH tries only those native suffixes, never the extensionless spelling:
 *   npm installs an extensionless POSIX shell shim beside `codex.cmd`, and
 *   Windows can neither execute that file nor would cmd.exe ever select it, so
 *   it must not win over the native candidate (#682/#756). A bare name also
 *   skips PATHEXT entries no launch can start without an interpreter (only
 *   `.com`, `.exe`, `.bat`, and `.cmd` remain, in PATHEXT order), so npm's
 *   sibling `.ps1` never wins over its `.cmd`. An explicit path is still tried
 *   exactly as given first, then with each suffix.
 * - Windows environment names are case-insensitive: the first key whose
 *   uppercase spelling matches, after sorting key names, supplies the value —
 *   matching Node's own first-case-insensitive-key behavior for a plain object
 *   that is not `process.env` (shared/role overrides produce those).
 * - A candidate is selected only when it is a regular file with execute
 *   permission (`X_OK`). The FIRST match wins; nothing is spawned, versioned,
 *   or shim-parsed, and no home-directory or recursive walk ever happens.
 * - On Windows with a base directory, a root-relative location (one leading
 *   separator, no drive or share — an explicit `\tools\codex.cmd` or a PATH
 *   entry `\tools`) is qualified with the base's drive or UNC share before it
 *   is tested, so the located path is fully qualified and names the file the
 *   child in that directory would run. Without a base (the settings probe)
 *   and on POSIX nothing changes.
 * - With no base directory (the settings availability probe), a relative
 *   spelling resolves where the calling process is, exactly as before, and PATH
 *   candidates are built with `path.join`, exactly as before. When a caller
 *   supplies one (`cwd`, the directory it will spawn the child in), relative
 *   command spellings and relative PATH entries are anchored to it, which is how
 *   `spawn(command, args, { cwd })` resolves them; absolute locations are never
 *   rewritten. Anchoring and PATH construction then only concatenate: `..`
 *   components survive to the filesystem, because a `..` written after a
 *   symlinked directory belongs to that directory's parent, and a lexical
 *   collapse would select a different executable than the spawn does.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, sep, win32 } from "node:path";

/**
 * The Windows extensions a launch can start without an interpreter of its own:
 * a native executable directly, a batch file through the trusted cmd.exe.
 */
const WINDOWS_LAUNCHABLE_SUFFIXES: ReadonlySet<string> = new Set([".com", ".exe", ".bat", ".cmd"]);

/**
 * Join two path pieces — a base directory with a relative command, or a PATH
 * entry with the command — keeping every component intact, and the same rule
 * prefixes the run directory. `path.join` and `path.resolve` are deliberately
 * not used here: both collapse `..` lexically, which would point the lookup
 * (and the caller's later canonicalization) at a different file than the
 * filesystem and the spawn resolve.
 */
function prefixBase(base: string, location: string): string {
  // The host separator is what candidate strings already use (the PATH join
  // above is host-native as well); the simulated platform only decides PATHEXT,
  // environment case, and what counts as absolute. Exactly one separator joins
  // base and location, and a bare root base keeps its separator instead of
  // turning into a drive- or root-relative spelling.
  const trimmed = sep === "\\" ? base.replace(/[\\/]+$/u, "") : base.replace(/\/+$/u, "");
  return trimmed.length === 0 ? `${sep}${location}` : `${trimmed}${sep}${location}`;
}

/**
 * Whether a Windows location is root-relative: exactly one leading separator
 * and therefore no drive letter and no UNC share (`\tools\codex.cmd`,
 * `/tools`). Such a path names a different file on every volume.
 */
export function isWindowsRootRelative(location: string): boolean {
  return /^[\\/](?![\\/])/u.test(location);
}

/** One Windows volume a path lives on: its exact prefix and whether it is namespaced. */
interface WindowsVolume {
  /** `C:`, `\\server\share`, `\\?\C:`, or `\\?\UNC\server\share` — no trailing separator. */
  prefix: string;
  /** A `\\?\` or `\\.\` path, where `/` is NOT a separator. */
  namespaced: boolean;
  /** A UNC share, plain (`\\server\share`) or namespaced (`\\?\UNC\server\share`). */
  unc: boolean;
}

/**
 * The drive or share a Windows path lives on, or `undefined` when it names
 * none (relative, root-relative, or malformed). Namespaced forms are matched
 * before the plain UNC form, because `\\?\UNC\server\share` would otherwise
 * read as a share named `UNC` on a server named `?` and drop the real server
 * and share.
 */
export function windowsVolumeOf(path: string): WindowsVolume | undefined {
  const namespacedUnc = /^\\\\[?.]\\UNC\\[^\\]+\\[^\\]+/iu.exec(path);
  if (namespacedUnc) return { prefix: namespacedUnc[0], namespaced: true, unc: true };
  const namespacedDrive = /^\\\\[?.]\\[A-Za-z]:/u.exec(path);
  if (namespacedDrive) return { prefix: namespacedDrive[0], namespaced: true, unc: false };
  // Any other `\\?\` or `\\.\` form (a device or volume GUID) is not a share.
  if (/^[\\/]{2}[?.](?:[\\/]|$)/u.test(path)) return undefined;
  // Windows normalization collapses a run of separators between the server and
  // the share (`//server//share` is `\\server\share`), so the run is accepted.
  const plainUnc = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/u.exec(path);
  if (plainUnc) return { prefix: plainUnc[0], namespaced: false, unc: true };
  const drive = /^[A-Za-z]:/u.exec(path);
  if (drive) return { prefix: drive[0], namespaced: false, unc: false };
  return undefined;
}

/** Whether a Windows run directory is on a UNC share, plain or namespaced. */
export function isWindowsUncPath(path: string): boolean {
  return windowsVolumeOf(path)?.unc === true;
}

/**
 * Qualify a Windows root-relative location with the drive (`C:`) or UNC share
 * (`\\server\share`, `\\?\UNC\server\share`) of the directory a child is
 * launched in, which is the volume that child resolves it against. Fully
 * qualified, UNC, drive-relative, and relative locations are returned
 * unchanged, as is any location whose run directory names no drive or share.
 * Only the volume is prefixed; the one adjustment is that a namespaced volume
 * (where Windows performs no `/` to `\` translation) receives the location
 * with its separators spelled `\`, which names the same file.
 */
export function qualifyWindowsRootRelative(location: string, cwd: string): string {
  if (!isWindowsRootRelative(location)) return location;
  const volume = windowsVolumeOf(cwd);
  if (volume === undefined) return location;
  return `${volume.prefix}${volume.namespaced ? location.replace(/\//gu, "\\") : location}`;
}

/**
 * Whether a run directory is absolute in the launch platform's own path
 * convention (a simulated Windows launch on a POSIX host reads `C:\work` as
 * absolute). On a real host this is exactly `path.isAbsolute`.
 */
export function isAbsoluteForPlatform(location: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(location) : isAbsolute(location);
}

/**
 * Resolve the exact file one configured application command points at.
 *
 * Returns the selected candidate path (as located, not canonicalized —
 * callers that need a cwd-independent descriptor canonicalize it themselves),
 * or `undefined` when nothing admissible is found. Platform and environment
 * injection keep callers and tests hermetic.
 *
 * `cwd` anchors relative discovery (a `./wrapper` command or a relative PATH
 * entry) to the directory the caller will run the child in. It is optional and
 * never consulted for a fully qualified location (only a Windows root-relative
 * one borrows its drive or share), so the availability probe's existing
 * behavior — resolution against the calling process — is unchanged. With a
 * base, a relative hit is returned with the base prefixed, components
 * uncollapsed; callers that need a canonical path canonicalize it themselves.
 */
export async function resolveApplicationCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): Promise<string | undefined> {
  const windows = platform === "win32";
  // Match Node's first case-insensitive environment key on Windows when
  // shared/role overrides produce a plain object (rather than process.env).
  const environmentValue = (name: string): string | undefined => {
    if (!windows) return environment[name];
    const key = Object.keys(environment).sort().find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : environment[key];
  };
  const explicitPath = isAbsolute(command) || (windows && win32.isAbsolute(command)) || command.includes("/") || (windows && command.includes("\\"));
  const pathExtSuffixes = windows && !extname(command)
    ? (environmentValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => /^\.[a-z0-9]+$/i.test(suffix)).map((suffix) => suffix.toLowerCase())
    : [];
  // A Windows bare name never selects its extensionless spelling (an npm POSIX
  // shell shim beside the native `.cmd`), nor a PATHEXT entry no launch can run
  // without an interpreter (npm's sibling `.ps1`); PATHEXT order is otherwise
  // kept. An explicit path is honored as given.
  const suffixes = !windows || extname(command)
    ? [""]
    : explicitPath
      ? ["", ...pathExtSuffixes]
      : pathExtSuffixes.filter((suffix) => WINDOWS_LAUNCHABLE_SUFFIXES.has(suffix));
  const locations = explicitPath
    ? [command]
    : (environmentValue("PATH") ?? "").split(windows ? ";" : delimiter).filter(Boolean).map((directory) =>
      // A cwd-aware caller needs the same component-preserving construction as
      // the explicit-command route: joining a relative entry such as `link/..`
      // first would collapse that `..` against the PATH entry and select (or
      // miss) a different file than the run resolves. Without a base, the
      // historical joined spelling is kept.
      cwd === undefined ? join(directory, command) : prefixBase(directory, command));
  // A relative location means "relative to wherever the run happens". With a
  // base supplied, that base is the spawn directory, prefixed without any
  // lexical normalization. A Windows root-relative location (one leading
  // separator, no drive or share) is qualified with the run directory's drive
  // or UNC share — the volume the child resolves it on — before any stat,
  // access, or rendering. Every other already-absolute location (in either
  // path convention) stays exactly as given.
  const anchored = cwd === undefined
    ? locations
    : locations.map((location) => {
      if (windows && isWindowsRootRelative(location)) return qualifyWindowsRootRelative(location, cwd);
      return isAbsolute(location) || (windows && win32.isAbsolute(location)) ? location : prefixBase(cwd, location);
    });
  for (const location of anchored) {
    for (const suffix of suffixes) {
      const candidate = location + suffix;
      if (await stat(candidate).then((entry) => entry.isFile(), () => false)
        && await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}
