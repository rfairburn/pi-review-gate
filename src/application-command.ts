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
 * The semantics are a byte-for-byte extraction of the settings probe this came
 * from, and stay unchanged:
 *
 * - An explicit path (POSIX-absolute, Windows-absolute/drive/UNC, or anything
 *   containing a path separator) is tested exactly as given; PATH is never
 *   searched for it. Spaces, quotes, or parentheses in a real path are
 *   filename input, never shell command strings.
 * - A bare name is searched in PATH order. Empty PATH entries are skipped, so
 *   the current directory is never searched implicitly.
 * - On Windows only, a bare name with no extension also tries each `PATHEXT`
 *   suffix (default `.COM;.EXE;.BAT;.CMD`; entries that are not a dot plus
 *   alphanumerics are dropped, survivors are lowercased).
 * - Windows environment names are case-insensitive: the first key whose
 *   uppercase spelling matches, after sorting key names, supplies the value —
 *   matching Node's own first-case-insensitive-key behavior for a plain object
 *   that is not `process.env` (shared/role overrides produce those).
 * - A candidate is selected only when it is a regular file with execute
 *   permission (`X_OK`). The FIRST match wins; nothing is spawned, versioned,
 *   or shim-parsed, and no home-directory or recursive walk ever happens.
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
 * Resolve the exact file one configured application command points at.
 *
 * Returns the selected candidate path (as located, not canonicalized —
 * callers that need a cwd-independent descriptor canonicalize it themselves),
 * or `undefined` when nothing admissible is found. Platform and environment
 * injection keep callers and tests hermetic.
 *
 * `cwd` anchors relative discovery (a `./wrapper` command or a relative PATH
 * entry) to the directory the caller will run the child in. It is optional and
 * never consulted for an absolute location, so the availability probe's
 * existing behavior — resolution against the calling process — is unchanged.
 * With a base, a relative hit is returned with the base prefixed, components
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
  const suffixes = windows && !extname(command)
    ? ["", ...(environmentValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => /^\.[a-z0-9]+$/i.test(suffix)).map((suffix) => suffix.toLowerCase())]
    : [""];
  const explicitPath = isAbsolute(command) || (windows && win32.isAbsolute(command)) || command.includes("/") || (windows && command.includes("\\"));
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
  // lexical normalization. An already-absolute location (in either path
  // convention) stays exactly as given.
  const anchored = cwd === undefined
    ? locations
    : locations.map((location) => (isAbsolute(location) || (windows && win32.isAbsolute(location)) ? location : prefixBase(cwd, location)));
  for (const location of anchored) {
    for (const suffix of suffixes) {
      const candidate = location + suffix;
      if (await stat(candidate).then((entry) => entry.isFile(), () => false)
        && await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
    }
  }
  return undefined;
}
