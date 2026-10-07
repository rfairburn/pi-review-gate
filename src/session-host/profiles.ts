import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { PI_AGENT_DIR_ENV, REVIEW_GATE_CONFIG_FILENAME, piAgentDir } from "../config-path";

/**
 * Independent workspace/profile admission for session-host instances (issue 323
 * follow-up): each launched session-host process owns one explicitly selected
 * canonical workspace and one independent native Pi agent directory.
 *
 * Design boundaries:
 *
 * - The registry tracks only *active* admissions in memory. There are no
 *   persistent catalogs, process records, or locks; `release()` is idempotent
 *   and re-admission of a previously released profile is allowed.
 * - The user's startup working directory is never authoritative: workspaces are
 *   given explicitly (relative paths resolve against the process working
 *   directory), and configuration always lives inside the explicit profile
 *   directory, never discovered relative to the session cwd.
 * - State directories are never workspaces: a profile agent directory equal to
 *   the workspace is rejected.
 * - A supplied profile must contain a local parseable JSON-object
 *   `review-gate.json`. This deliberately prevents the profile from falling
 *   back to a shared external configuration (the standalone compatibility
 *   fallback), which would silently couple instances. The file is read with a
 *   bounded read (see {@linkcode MAX_PROFILE_CONFIG_BYTES}), parsed, and never
 *   rewritten, normalized, or logged: the user's config may contain arbitrary
 *   valid native fields and any diagnostics are path-level only.
 * - Mutable native config files (`review-gate.json`, `settings.json`,
 *   `keybindings.json`, `models.json`, `mcp.json`) that exist in two active
 *   profiles must not be filesystem aliases of each other: each is identified
 *   by the `stat` device/inode of its resolved target (symlinks resolve to
 *   their target), so symlinks and hardlinks cannot make two supposedly
 *   independent profiles share one file. Identity sets are refreshed from the
 *   active profiles on every admission (a file created or atomically replaced
 *   in an active profile is not missed), and identities are compared across
 *   file names (a candidate `settings.json` cannot alias an active profile's
 *   `review-gate.json`). Resolution is fail closed: a *present* config entry
 *   that is not a readable regular file — notably a dangling symlink, whose
 *   later first write would couple both profiles to the same missing target —
 *   is rejected before admission instead of being treated as absent; only a
 *   truly missing optional file (`lstat` ENOENT) is admitted as absent.
 *   Checks are scoped to profiles managed by this registry only; no arbitrary
 *   home-directory or process scanning happens.
 * - Profiles created without an explicit profile directory are brand-new,
 *   private directories under `<stateRoot>/profiles` (via `mkdtempSync`,
 *   mode 0700). Nothing is copied from the user's native config, credentials,
 *   or any other profile: only the profile-local `review-gate.json` is
 *   initialized (mode 0600) with the standalone launcher's documented
 *   zero-model defaults. Pi settings, keybindings, models, MCP config, and
 *   auth are left to Pi's own native defaults and environment.
 * - Generated profiles persist after `release()` so native settings and
 *   session files are not destroyed behind the caller's back. When a
 *   generated profile directory cannot be initialized, it (and its
 *   contents — known and concurrently supplied alike) is preserved in place
 *   with a truthful diagnostic: pathname identity cannot be checked and
 *   deleted atomically, so nothing under a failed profile is ever removed.
 *
 * The default state root derived from Pi's native agent directory lives in
 * {@linkcode defaultProfileStateRoot}; an explicit `stateRoot` overrides it.
 */

/** Upper bound for reading a profile-local config file (defense against untrusted giant configs). */
export const MAX_PROFILE_CONFIG_BYTES = 1024 * 1024;

/**
 * Mutable native config file names checked for cross-profile filesystem
 * aliases. The review-gate config is always present for an admitted profile;
 * the remaining names are optional and only checked when they exist.
 */
export const PROFILE_MUTABLE_CONFIG_FILENAMES = [
  REVIEW_GATE_CONFIG_FILENAME,
  "settings.json",
  "keybindings.json",
  "models.json",
  "mcp.json",
] as const;

/** Exact byte content written to a newly created profile's review-gate.json. */
export const DEFAULT_REVIEW_GATE_CONFIG_JSON = `{
  "enabled": true,
  "review": {
    "activeReviewers": []
  },
  "externalAgents": {},
  "execution": {
    "workerResources": {},
    "routes": {
      "execute": [],
      "research": []
    }
  }
}
`;

/** Name of the directory under the state root that holds generated profiles. */
const PROFILES_DIRNAME = "profiles";

/** Prefix for generated profile directories (completed by `mkdtempSync`). */
const PROFILE_DIR_PREFIX = "session-host-";

/** A profile admitted by {@linkcode ProfileRegistry.prepare}. */
export interface PreparedProfile {
  /** Canonical real path of the explicitly selected workspace directory. */
  workspace: string;
  /** Canonical real path of the profile's independent native agent directory. */
  agentDir: string;
  /** True when this call created a brand-new private profile directory. */
  created: boolean;
  /** Remove this admission from the registry's active set. Idempotent. */
  release: () => void;
}

export interface ProfileRegistryOptions {
  /**
   * State root for generated profiles. Defaults to
   * `<native Pi agent directory>/session-host` (honoring
   * {@linkcode PI_AGENT_DIR_ENV} through Pi's native semantics).
   */
  stateRoot?: string;
}

export interface PrepareProfileOptions {
  /** Workspace directory the launched instance will operate in. */
  workspace: string;
  /**
   * Existing user-chosen profile directory serving as the instance's native
   * agent directory. When omitted, a brand-new private profile is created
   * under `<stateRoot>/profiles` (an empty string is treated the same as
   * omitted).
   */
  profile?: string;
}

/**
 * Default state root: Pi's native agent directory plus `session-host`,
 * honoring `PI_CODING_AGENT_DIR` with Pi's native semantics.
 */
export function defaultProfileStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDir(env), "session-host");
}

/**
 * Expand a leading bare `~` or `~/...` (and `~\\...` on Windows) against
 * `homeDir` using native tilde semantics. Unrelated leading segments such as
 * `~otheruser/...` are returned unchanged.
 */
export function expandUserPath(input: string, homeDir: string = homedir()): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return join(homeDir, input.slice(2));
  if (process.platform === "win32" && input.startsWith("~\\")) {
    return join(homeDir, input.slice(2));
  }
  return input;
}

/**
 * An existing directory in canonical real form. Tilde prefixes are expanded,
 * relative paths resolve against the process working directory, the path must
 * exist and be a directory, and the result is the canonical real path.
 */
function resolveExistingDirectory(input: string, label: string): string {
  const expanded = expandUserPath(input);
  const absolute = resolve(expanded);
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`session-host: ${label} ${absolute} does not exist or is not accessible (${code})`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`session-host: ${label} ${absolute} is not a directory`);
  }
  return realpathSync(absolute);
}

interface BoundedConfigRead {
  text: string;
  /** Number of raw bytes read from the open descriptor. */
  bytesRead: number;
}

/**
 * Open flags for reads on config pathnames: non-blocking on POSIX so that
 * opening cannot park on a FIFO that was swapped onto the path between
 * `stat` and `open`; a regular file is unaffected. Windows exposes `O_NONBLOCK`
 * as a no-op constant.
 */
const boundedReadOpenFlags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Read at most `maxBytes` bytes from an already-opened descriptor (bounded,
 * no full-size allocation, deterministic absolute positions).
 */
function readBoundedDescriptorSync(handle: number, maxBytes: number): BoundedConfigRead {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(handle, buffer, offset, buffer.length - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return {
    text: buffer.subarray(0, Math.min(offset, maxBytes)).toString("utf8"),
    bytesRead: offset,
  };
}

/**
 * Read and parse a profile-local config file as a bounded plain JSON object.
 *
 * The pathname is never stat-then-opened: such a sequence can race the path
 * into a FIFO (whose open would otherwise park indefinitely). Instead the
 * pathname is opened non-blocking and the opened descriptor itself is checked
 * (`fstatSync`: reject anything that is not a readable regular file, including
 * a FIFO swapped onto the pathname) and read with a bounded absolute-position
 * read (the 1 MiB limit is enforced again on the descriptor after any
 * pathname swap). Diagnostics are path-level only; the file's contents are
 * never included.
 */
function readProfileConfigObject(path: string): Record<string, unknown> {
  let handle: number;
  try {
    handle = openSync(path, boundedReadOpenFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(
      `session-host: ${path} does not exist, is not accessible, or is not a regular file (${code}); ` +
        `each supplied profile must contain a local ${REVIEW_GATE_CONFIG_FILENAME} so profiles do not fall back to a shared external configuration`,
    );
  }
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) {
      throw new Error(`session-host: ${path} is not a regular file`);
    }
    if (stats.size > MAX_PROFILE_CONFIG_BYTES) {
      throw new Error(
        `session-host: ${path} exceeds the ${MAX_PROFILE_CONFIG_BYTES}-byte config read limit; refusing to read an oversized profile config`,
      );
    }
    const { text, bytesRead } = readBoundedDescriptorSync(handle, MAX_PROFILE_CONFIG_BYTES);
    if (bytesRead > MAX_PROFILE_CONFIG_BYTES) {
      throw new Error(
        `session-host: ${path} exceeds the ${MAX_PROFILE_CONFIG_BYTES}-byte config read limit; refusing to read an oversized profile config`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `session-host: ${path} does not contain a valid JSON object; each supplied profile must contain parseable JSON so profiles do not fall back to a shared external configuration`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`session-host: ${path} does not contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A failed close on an already-validated read must not mask the outcome.
    }
  }
}

/**
 * One validated mutable config entry in a profile directory.
 *
 * The identity is the `stat` device/inode of the resolved target (symlinks
 * resolve to their target, so symlink and hardlink aliases share it), and
 * `canonicalTarget` carries the resolved canonical target path when
 * available, as originally specified.
 */
interface MutableConfigIdentity {
  identity: string;
  canonicalTarget: string;
}

/**
 * Validate one mutable config entry. A truly absent optional file is fine;
 * a *present* entry that is not a readable regular file — a dangling symlink
 * (later writes through two such links to the same missing target would
 * couple the supposedly independent profiles), an unreadable entry, or a
 * non-regular file such as a FIFO — is unusable and must fail closed.
 *
 * `stat` alone cannot detect unreadability (macOS/POSIX only require
 * directory permission to stat), so the presence check opens the pathname
 * non-blocking and validates the opened descriptor with `fstatSync`; no
 * contents are read for the check. Diagnostics are path-level only and no
 * fallback or guess is made.
 */
function validatedConfigEntry(agentDir: string, filename: string): MutableConfigIdentity | undefined {
  const path = join(agentDir, filename);
  let entryStats;
  try {
    entryStats = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined; // truly absent
    }
    throw new Error(
      `session-host: config file ${path} is present but cannot be inspected (${code}); ` +
        `refusing to admit a profile with an unusable config file`,
    );
  }
  let handle: number;
  try {
    handle = openSync(path, boundedReadOpenFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    const reason = entryStats.isSymbolicLink()
      ? "is a symlink to a missing or unreadable target"
      : "is present but not a readable regular file";
    throw new Error(
      `session-host: config file ${path} ${reason} (${code}); refusing to admit a profile with an unusable config file`,
    );
  }
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) {
      throw new Error(
        `session-host: config file ${path} is present but is not a regular file; ` +
          `refusing to admit a profile with an unusable config file`,
      );
    }
    let canonicalTarget;
    try {
      canonicalTarget = realpathSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(
        `session-host: config file ${path} is present but its canonical target cannot be resolved (${code}); ` +
          `refusing to admit a profile with an unusable config file`,
      );
    }
    return { identity: `${stats.dev}:${stats.ino}`, canonicalTarget };
  } finally {
    try {
      closeSync(handle);
    } catch {
      // A failed close must not mask the validation outcome.
    }
  }
}

/**
 * Validated identities of every mutable config file present in one profile
 * directory, rejecting present-but-unusable entries before any admission.
 */
function profileConfigIdentities(agentDir: string): Map<string, MutableConfigIdentity> {
  const identities = new Map<string, MutableConfigIdentity>();
  for (const filename of PROFILE_MUTABLE_CONFIG_FILENAMES) {
    const entry = validatedConfigEntry(agentDir, filename);
    if (entry !== undefined) {
      identities.set(filename, entry);
    }
  }
  return identities;
}

interface ActiveAdmission {
  /** Canonical profile directory (map key). */
  agentDir: string;
  workspace: string;
  identities: Map<string, MutableConfigIdentity>;
}

/**
 * Canonical real destination for `path`: the deepest existing ancestor is
 * real-pathed and the non-existent tail segments (which therefore contain no
 * symlinks) are re-joined lexically. Falls back to the lexical path only at
 * the filesystem root or across filesystems. Never uses lexical `relative`
 * between a real and a lexical prefix: on macOS, for example, a lexical
 * `/tmp/...` and the real `/private/tmp/...` would otherwise produce a wrong
 * tail.
 */
function canonicalDestinationPath(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      let destination = realpathSync(current);
      for (let index = 0; index < tail.length; index += 1) {
        destination = join(destination, tail[index]);
      }
      return destination;
    } catch {
      tail.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * True when `candidate` equals `parent` or lies anywhere inside it.
 * Traversal is recognized exactly: only `..` itself and segments after a
 * real path separator count as leaving the parent — a child literally named
 * `..state` is inside, not outside.
 */
function isSameOrInside(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  const rel = relative(parent, candidate);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * Registry of active session-host profile admissions. Synchronous by design:
 * state is a bounded in-memory map of active rows only, with no persistent
 * catalogs, background processes, or locks.
 */
export class ProfileRegistry {
  readonly #active = new Map<string, ActiveAdmission>();
  readonly #stateRoot: string;

  constructor(options?: ProfileRegistryOptions) {
    if (options?.stateRoot !== undefined) {
      this.#stateRoot = resolve(expandUserPath(options.stateRoot));
    } else {
      this.#stateRoot = defaultProfileStateRoot();
    }
  }

  /** Default state root for diagnostics (not the generated profiles directory). */
  get stateRoot(): string {
    return this.#stateRoot;
  }

  /**
   * Admit one session-host instance: validate and canonicalize the workspace,
   * then either adopt an explicit existing profile directory or create a
   * brand-new private profile directory with the documented zero-model
   * defaults. Returns the active admission handle; call `release()` on the
   * returned profile (idempotently) when the instance exits.
   */
  prepare(options: PrepareProfileOptions): PreparedProfile {
    const workspace = resolveExistingDirectory(options.workspace, "workspace");
    const profileInput = options.profile;
    if (profileInput === undefined || profileInput === "") {
      return this.#prepareCreatedProfile(workspace);
    }
    return this.#prepareSuppliedProfile(workspace, profileInput);
  }

  #prepareSuppliedProfile(workspace: string, profileInput: string): PreparedProfile {
    const agentDir = resolveExistingDirectory(profileInput, "profile");
    if (agentDir === workspace) {
      throw new Error(
        `session-host: profile directory ${agentDir} must not be the workspace; the profile state directory is never the workspace`,
      );
    }
    const existing = this.#active.get(agentDir);
    if (existing !== undefined) {
      throw new Error(
        `session-host: profile ${agentDir} already has an active admission (workspace ${existing.workspace}); an active profile can be admitted to only one instance`,
      );
    }
    // Parse the local review-gate config so this profile cannot silently fall
    // back to a shared external configuration. The file is validated and
    // parsed only; it is never rewritten, normalized, or logged.
    readProfileConfigObject(join(agentDir, REVIEW_GATE_CONFIG_FILENAME));
    const identities = profileConfigIdentities(agentDir);
    this.#checkNoAlias(agentDir, identities);
    return this.#admit(agentDir, workspace, identities, false);
  }

  #prepareCreatedProfile(workspace: string): PreparedProfile {
    const profilesRoot = join(this.#stateRoot, PROFILES_DIRNAME);
    // Resolve the destination canonically through symlinks before creating
    // anything (the deepest existing ancestor is real-pathed; all tail
    // segments below it do not exist and therefore contain no symlinks):
    // generated state must never land in the workspace, even when the
    // configured state root is a symlink pointing there.
    const canonicalProfilesRoot = canonicalDestinationPath(profilesRoot);
    if (isSameOrInside(workspace, canonicalProfilesRoot)) {
      throw new Error(
        `session-host: generated profiles directory ${canonicalProfilesRoot} is the workspace or lies inside it ` +
          `(${workspace}); the generated profile state directory must never be the workspace`,
      );
    }
    // Idempotent for an existing root: its mode and unrelated contents are
    // preserved, and private permissions are requested only for created dirs.
    try {
      mkdirSync(profilesRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(`session-host: could not use or create the generated profiles directory ${profilesRoot} (${code})`);
    }
    const stats = statSync(profilesRoot);
    if (!stats.isDirectory()) {
      throw new Error(`session-host: generated profiles directory ${profilesRoot} is not a directory`);
    }
    let dir: string;
    try {
      dir = mkdtempSync(join(profilesRoot, PROFILE_DIR_PREFIX));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new Error(`session-host: could not create a new profile directory under ${profilesRoot} (${code})`);
    }
    try {
      initializeProfileDirectory(dir);
    } catch (error) {
      throw error instanceof Error && error.message.startsWith("session-host:")
        ? error
        : new Error(`session-host: could not initialize the new profile directory ${dir}: ${String(error)}`);
    }
    // A freshly created unique directory cannot equal the pre-existing,
    // validated workspace, and the profiles-root containment rejection above
    // keeps generated state out of the workspace entirely.
    const canonicalDir = realpathSync(dir);
    const identities = profileConfigIdentities(canonicalDir);
    this.#checkNoAlias(canonicalDir, identities);
    return this.#admit(canonicalDir, workspace, identities, true);
  }

  /**
   * Reject a candidate whose existing mutable config files are filesystem
   * aliases of an active profile's files, across file names: matching is by
   * resolved-target stat device/inode and resolved canonical target path.
   * The active profiles' identity sets are refreshed on every admission, so
   * a file that was created or atomically replaced inside an active profile
   * after its admission is still compared. A present-but-unusable entry in
   * an active profile fails closed here as well. Scoped to profiles this
   * registry manages.
   */
  #checkNoAlias(agentDir: string, identities: Map<string, MutableConfigIdentity>): void {
    for (const active of this.#active.values()) {
      const fresh = profileConfigIdentities(active.agentDir);
      active.identities = fresh;
      const activeByMatch = new Map<string, string>();
      for (const [activeFilename, entry] of fresh) {
        activeByMatch.set(entry.identity, activeFilename);
        activeByMatch.set(`target ${entry.canonicalTarget}`, activeFilename);
      }
      for (const [filename, entry] of identities) {
        const activeFilename =
          activeByMatch.get(entry.identity) ?? activeByMatch.get(`target ${entry.canonicalTarget}`);
        if (activeFilename !== undefined) {
          throw new Error(
            `session-host: profile ${agentDir} config file ${filename} shares the same file ` +
              `(${activeFilename} of the active profile ${active.agentDir}, matching device/inode ` +
              `or canonical target); active session-host profiles must use independent config files`,
          );
        }
      }
    }
  }

  #admit(agentDir: string, workspace: string, identities: Map<string, MutableConfigIdentity>, created: boolean): PreparedProfile {
    const admission: ActiveAdmission = { agentDir, workspace, identities };
    this.#active.set(agentDir, admission);
    return {
      workspace,
      agentDir,
      created,
      release: () => {
        // Idempotent; never releases a different admission re-registered
        // under the same profile after this one was released.
        if (this.#active.get(agentDir) === admission) {
          this.#active.delete(agentDir);
        }
      },
    };
  }
}

/**
 * Initialize one positively-owned new profile directory: create only the
 * profile-local `review-gate.json` (mode 0600) with the standalone launcher's
 * documented zero-model defaults. The config is created with `wx` (no
 * overwrite). On failure, nothing under the profile directory is removed:
 * pathname identity cannot be checked and deleted atomically, so any cleanup
 * could delete a concurrently supplied entry (including a symlink swapped in
 * after the creation). A zero-byte write return is treated like an I/O error
 * rather than retried forever. The failed profile directory is preserved
 * intact and the diagnostic reports that truthfully.
 *
 * Exported for focused tests; production flows call this right after
 * `mkdtempSync` on a directory this module created.
 */
export function initializeProfileDirectory(profileDir: string): void {
  const configPath = join(profileDir, REVIEW_GATE_CONFIG_FILENAME);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(configPath, "wx", 0o600);
    try {
      const payload = Buffer.from(DEFAULT_REVIEW_GATE_CONFIG_JSON, "utf8");
      let written = 0;
      while (written < payload.length) {
        const count = writeSync(descriptor, payload, written);
        if (count <= 0) {
          // A zero-byte (or negative) return would leave the loop spinning
          // forever: fail closed with a truthful EIO-like diagnostic instead.
          throw Object.assign(new Error(`controlled zero-byte config write`), {
            code: "EIO",
            detail: `the open config descriptor returned ${count} bytes at byte offset ${written}`,
          });
        }
        written += count;
      }
    } finally {
      try {
        closeSync(descriptor);
      } catch {
        // Closing a failed handle is best-effort: the write outcome is what
        // matters, and a close error after a failed write must not mask it.
      }
    }
  } catch (error) {
    // Pathname identity cannot be checked and deleted atomically, so cleanup
    // must not risk deleting concurrently supplied entries: preserve the
    // failed profile directory and its remaining contents in place.
    const detail = (error as { detail?: string }).detail;
    const note =
      `; no cleanup was attempted at ${profileDir}; inspect its remaining contents manually before retrying` +
      (detail !== undefined ? ` (${detail})` : "");
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(`session-host: could not initialize the new profile at ${profileDir} (${code})${note}`);
  }
}