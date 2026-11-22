/**
 * #682: per-launch native MCP relay preparation (launch-preparation slice).
 *
 * A hosted native Claude or owned Codex row can reach the host's trusted tool
 * endpoint through the stdio relay in ./native-mcp-relay, which the provider
 * itself starts as one of its MCP server children. For that to happen at all,
 * the provider must be told — at startup, through its own documented per-launch
 * MCP channel — to start the relay. This module prepares exactly that
 * instruction for one launch: the provider flags to add, and the private
 * artifacts those flags point at. It never spawns anything, never registers a
 * broker source, never reads or writes provider configuration, trust,
 * approvals, permissions, or global state, and never claims that the relay
 * actually started or connected.
 *
 * Preparation is OPTIONAL and owner-supplied. With no MCP option the launch
 * adapter composes exactly the descriptor it composed before this module
 * existed. Nothing in production arms it yet: this slice prepares the contract
 * a future owning session host consumes.
 *
 * Credential handling. The bootstrap the broker issued for this launch
 * (`registerNativeMcpSource`) is written ONCE, in its canonical encoding, to a
 * private file in a freshly owned directory. Only that file's PATH reaches the
 * provider (in the relay's argv, inside the provider's MCP server definition);
 * the token never appears in the child environment, provider argv, a config
 * file, or an outcome. The relay reads the file once and unlinks it
 * (./native-mcp-relay `readNativeMcpBootstrapFile`). This is a separate record
 * type and token from the status-hook observer bootstrap, which this module
 * never reads, carries, or reuses.
 *
 * Provider channels (narrow, no invented switches):
 *
 * - **Claude Code**: one `--mcp-config=<file>` whose JSON defines exactly one
 *   reserved stdio server ({@link NATIVE_MCP_SERVER_NAME}) and nothing else.
 *   The attached `=` spelling is deliberate: the option is variadic, and the
 *   attached form can never consume a following token as another config. No
 *   `--strict-mcp-config`, no permission mode, no allowed-tools entry, no
 *   preapproval, no prompt, skill, or `alwaysLoad` setting is ever added, so
 *   every MCP tool call still goes through the operator's own native
 *   permission prompts. When the operator already passes `--mcp-config` or
 *   `--strict-mcp-config` in real option position, how a second config would
 *   combine with theirs (merge, name collision, strict scope) is not something
 *   this host can settle without reading their files, so preparation declines
 *   rather than risk overriding or widening the operator's own MCP set.
 * - **Codex**: only an OWNED app-server backend receives the instruction,
 *   because that backend is the core that starts MCP servers; the interactive
 *   TUI attached to it over `--remote` never does, and a legacy non-owned
 *   Codex launch is declined. The instruction is exactly one
 *   `-c mcp_servers.<reserved>={command=…,args=[…]}` override, rendered into
 *   the owned backend's global options after the operator's own `-c`/`--config`
 *   tokens. Unrelated servers are untouched. When the operator already writes
 *   `mcp_servers` as a whole, or the reserved server's own path, in real option
 *   position, preparation declines rather than replace theirs.
 *
 * Effective provider configuration. Argv is only one MCP layer: the operator
 * can already configure a server of the reserved name in provider settings,
 * where Claude's precedence between that and a dynamic `--mcp-config` entry,
 * and Codex's merge of a same-path `-c` override into it, would replace or mix
 * the operator's definition. This module never reads provider configuration,
 * so it requires the owning host's trusted, launch-specific compatibility
 * result ({@link NativeMcpProviderConfigCompatibility}, bound to the
 * registration's instance id and the canonical workspace). Without one, or
 * when it is `unresolved`, preparation declines (`provider-config-unresolved`);
 * when it lists a server whose tool namespace equals the reserved name, it
 * declines (`provider-config-conflict`). Unrelated servers never block.
 *
 * Either route stays subject to the operator's native policy — Claude managed
 * MCP configuration and allow/deny lists, Codex managed requirements, and
 * every approval gate. This module bypasses none of them: a relay the provider
 * declines to start simply never connects, and the row's tool lane stays
 * unavailable.
 *
 * Windows is declined up front: the relay refuses every Windows bootstrap file
 * (`platform_unverifiable`) because owner-only access cannot be established
 * through the public Node API, and there is no insecure fallback (no
 * environment or argv carriage of the token).
 *
 * Artifacts are freshly owned and private. The artifact parent (the system
 * temporary directory) is canonicalized and proved acceptable to the relay's
 * own protected-path walk BEFORE anything is created. The root is then a new
 * `mkdtemp` directory (`0700`), and each file is created exclusively without
 * following links (`0600`). Every entry is recorded from its own descriptor the
 * moment it exists — before any mode change or write — so any later failure
 * rolls it back. Those descriptors stay open for the lease lifetime, so no
 * owned inode can be freed and reused by a replacement: cleanup removes exactly
 * the pinned inodes through the pinned root, preserves anything else, never
 * deletes recursively, and reports the relay's consumption of the bootstrap
 * as `absent`.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
} from "./launch";
import {
  encodeNativeMcpBootstrap,
  parseNativeMcpBootstrap,
  type NativeMcpBootstrap,
} from "./native-mcp-protocol";
import {
  NATIVE_MCP_RELAY_BOOTSTRAP_FLAG,
  isProtectedNativeMcpSocketPath,
  type NativeMcpPathStats,
} from "./native-mcp-relay";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";
// Type-only: the launch adapter owns the one argv scanner, and this module only
// reads the facts it already computed. There is no runtime import back.
import type { NativeArgPositionScan } from "./native-cli-launch";

/**
 * The single reserved MCP server name both providers receive. It is a plain
 * identifier valid in both providers' server-name rules and as one Codex
 * configuration path segment.
 */
export const NATIVE_MCP_SERVER_NAME = "pi_review_gate";

/** Claude's documented per-launch MCP configuration option. */
export const CLAUDE_MCP_CONFIG_OPTION = "--mcp-config";

/** Claude's strict-scope option; never emitted, only honored when the operator set it. */
const CLAUDE_STRICT_MCP_CONFIG_OPTION = "--strict-mcp-config";

/** Codex's per-launch configuration override options. */
const CODEX_CONFIG_OPTIONS: readonly string[] = ["-c", "--config"];

/** The Codex configuration table of MCP servers. */
const CODEX_MCP_SERVERS_KEY = "mcp_servers";

/** Fixed artifact names inside one owned root. */
const BOOTSTRAP_FILE_NAME = "native-mcp-bootstrap.json";
const CLAUDE_CONFIG_FILE_NAME = "claude-mcp-config.json";

/** Prefix of every owned artifact root under the system temporary directory. */
export const NATIVE_MCP_ARTIFACT_ROOT_PREFIX = "prg-native-mcp-";

/** Which provider channel received the relay instruction. */
export type NativeMcpLaunchRoute =
  /** Claude TUI argv: one `--mcp-config=<file>`. */
  | "claude-mcp-config"
  /** Owned Codex app-server backend argv: one `-c mcp_servers.<reserved>=…`. */
  | "codex-owned-backend-config";

/**
 * Which child the generated `args` belong to. A caller must place them exactly
 * there and nowhere else.
 */
export type NativeMcpLaunchPlacement = "claude-tui" | "codex-owned-backend";

/**
 * Closed reasons why the relay instruction was NOT prepared. None of them is a
 * launch failure and none of them changed the operator's launch; the row's
 * tool lane is simply unavailable.
 */
export type NativeMcpLaunchUnavailableReason =
  /** Windows: the relay cannot verify a private bootstrap file, and there is no insecure fallback. */
  | "platform-unsupported"
  /** Codex without an owned app-server backend (legacy TUI launch): no owned core to configure. */
  | "codex-backend-not-owned"
  /** The operator's own MCP flags already cover what we would add, or how ours would combine is ambiguous. */
  | "operator-mcp-override"
  /**
   * No trusted compatibility result for the effective provider MCP
   * configuration of this launch, or its precedence is unresolved.
   */
  | "provider-config-unresolved"
  /** The effective provider MCP configuration already defines the reserved server name. */
  | "provider-config-conflict"
  /** The Node host or the compiled relay entry is not an absolute regular file. */
  | "relay-entry-unavailable"
  /** The artifact root is not canonical or its ancestry is not protected the way the relay requires. */
  | "artifact-path-unprotected"
  /** An artifact could not be staged; `rollback` lists any path that could not safely be removed. */
  | "artifact-staging-failed";

/** Largest accepted number of configured server names in one compatibility result. */
const MAX_PROVIDER_SERVER_NAMES = 1024;
/** Largest accepted configured server name, in UTF-16 units. */
const MAX_PROVIDER_SERVER_NAME_LENGTH = 256;
/** Largest accepted workspace path in a compatibility result. */
const MAX_PROVIDER_WORKSPACE_LENGTH = 4096;

/**
 * The trusted, launch-specific compatibility result for the EFFECTIVE provider
 * MCP configuration this launch would start with — every layer the provider
 * itself merges (Claude user/project/local/plugin/managed scopes; Codex user,
 * project, profile, and managed layers), not only argv. Only the owning host
 * produces it, for exactly one registration (`instanceId`) and one canonical
 * workspace; this module never reads provider configuration to build it.
 *
 * - `resolved`: the producer established the complete set of configured
 *   server names AND that a dynamically added reserved server neither replaces
 *   nor merges into any of them. Unrelated names never block preparation.
 * - `unresolved`: either was not established. Preparation is declined.
 *
 * A launch with no result is treated as `unresolved`: fail closed.
 */
export type NativeMcpProviderConfigCompatibility =
  | {
    readonly status: "resolved";
    readonly backend: NativeCliBackend;
    readonly instanceId: string;
    readonly workspace: string;
    readonly configuredServerNames: readonly string[];
  }
  | {
    readonly status: "unresolved";
    readonly backend: NativeCliBackend;
    readonly instanceId: string;
    readonly workspace: string;
  };

/** What one lease cleanup actually did. Paths are this module's own artifacts. */
export interface NativeMcpArtifactCleanup {
  readonly removed: readonly string[];
  /** Owned paths already gone — normally the bootstrap the relay consumed. */
  readonly absent: readonly string[];
  /** Owned paths left in place because their identity, ancestry, or contents changed. */
  readonly preserved: readonly string[];
}

/**
 * The caller's handle on the artifacts this preparation staged. Release it only
 * AFTER the provider child (and with it the relay) has settled, and after
 * releasing the broker registration; nothing here observes a process or
 * guesses when that happened. Cleanup is idempotent.
 *
 * The lease holds one close-on-exec descriptor per owned entry (the root and
 * each file) until cleanup, so no owned inode can be freed and its number
 * reused by a replacement while the lease is live: identity comparison at
 * cleanup is therefore proof, not a heuristic. An unreleased lease keeps those
 * few descriptors open; owners must always call `cleanup`.
 */
export interface NativeMcpArtifactLease {
  /** Canonical root of the freshly owned artifact directory. */
  readonly root: string;
  /** Canonical path of the one-shot bootstrap file the relay consumes. */
  readonly bootstrapFile: string;
  cleanup(): Promise<NativeMcpArtifactCleanup>;
}

/**
 * The relay instruction is in THIS launch's configuration. It is never a claim
 * that the provider started the relay or that the relay authenticated: native
 * policy can withhold the server, and the relay itself fails closed.
 */
export interface NativeMcpLaunchPrepared {
  readonly mcp: "prepared";
  readonly backend: NativeCliBackend;
  readonly route: NativeMcpLaunchRoute;
  readonly placement: NativeMcpLaunchPlacement;
  readonly serverName: typeof NATIVE_MCP_SERVER_NAME;
  /** The generated provider flags, in order. They carry no secret. */
  readonly args: readonly string[];
  readonly lease: NativeMcpArtifactLease;
}

/** The relay instruction deliberately not prepared; the launch proceeds unchanged. */
export interface NativeMcpLaunchUnavailable {
  readonly mcp: "unavailable";
  readonly backend: NativeCliBackend;
  readonly reason: NativeMcpLaunchUnavailableReason;
  /**
   * Present only when a failed staging attempt's rollback left paths it could
   * not safely remove (an unreadable or unverifiable entry, possibly the
   * bootstrap). The owner must treat those paths as still on disk; the
   * registration that issued the bootstrap should be released. No credential
   * value is ever carried here.
   */
  readonly rollback?: NativeMcpArtifactCleanup;
}

export type NativeMcpLaunchOutcome = NativeMcpLaunchPrepared | NativeMcpLaunchUnavailable;

/** Absolute existing files the generated server definition invokes. */
export interface NativeMcpEntrypoints {
  readonly nodeExecutable: string;
  readonly relayEntry: string;
}

/** Input for one preparation. The caller owns every field; none is mutated. */
export interface NativeMcpLaunchPreparationInput {
  readonly backend: NativeCliBackend;
  /** Fresh bootstrap from the broker's `registerNativeMcpSource` for this launch. */
  readonly bootstrap: NativeMcpBootstrap;
  readonly platform: NodeJS.Platform;
  /**
   * Real-option-position facts from the launch adapter's ONE argv scanner over
   * the configured argv. Conflict detection reads only these facts.
   */
  readonly scan: NativeArgPositionScan;
  /**
   * The environment this launch will hand the child. Only read, never mutated:
   * a genuine worker-role authorization in it is rejected before any artifact
   * exists.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * True only when the launch adapter is building an owned Codex app-server
   * plan for this launch. A Codex launch without it is declined.
   */
  readonly ownedCodexBackend: boolean;
  /**
   * Canonical workspace the child runs in; the compatibility result must have
   * been produced for exactly this workspace.
   */
  readonly workspace: string;
  /**
   * Trusted compatibility result for this launch's effective provider MCP
   * configuration. Absent means unresolved: preparation is declined.
   */
  readonly providerConfig?: NativeMcpProviderConfigCompatibility;
  /**
   * Test seam for literal-path coverage only: production passes nothing and the
   * launch adapter never sets it. Both values still have to be absolute
   * regular files.
   */
  readonly entrypoints?: NativeMcpEntrypoints;
  /**
   * Test seam only: the directory the owned root is created under (defaults to
   * the system temporary directory). The launch adapter never sets it, and the
   * same protected-ancestry rule applies to it.
   */
  readonly artifactParent?: string;
  /**
   * Test seam only: called at fixed staging points so a test can inject a
   * failure (by throwing). Production passes nothing.
   */
  readonly stagingProbe?: (stage: NativeMcpStagingStage) => void;
}

/** The fixed staging points `stagingProbe` observes. */
export type NativeMcpStagingStage =
  | "root-before-open"
  | "root-created"
  | "bootstrap-opened"
  | "bootstrap-written"
  | "config-opened"
  | "config-written";

function refuse(reason: string): Error {
  return new Error(`pi-review-gate: refusing to prepare the native MCP relay; ${reason}`);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function unavailable(backend: NativeCliBackend, reason: NativeMcpLaunchUnavailableReason): NativeMcpLaunchUnavailable {
  return { mcp: "unavailable", backend, reason };
}

/** The compiled relay sits beside this module in every shipped and test layout. */
function defaultRelayEntry(): string {
  return join(__dirname, "native-mcp-relay.js");
}

function resolveRelayEntrypoints(entrypoints: NativeMcpEntrypoints | undefined): NativeMcpEntrypoints | null {
  const nodeExecutable = entrypoints?.nodeExecutable ?? process.execPath;
  const relayEntry = entrypoints?.relayEntry ?? defaultRelayEntry();
  for (const candidate of [nodeExecutable, relayEntry]) {
    if (typeof candidate !== "string" || candidate.length === 0
      || !isAbsolute(candidate) || containsControlCharacter(candidate)) return null;
    try {
      if (!statSync(candidate).isFile()) return null;
    } catch {
      return null;
    }
  }
  return { nodeExecutable, relayEntry };
}

/** One TOML basic string, exactly as Codex's `-c` value parser expects it. */
function tomlBasicString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") out += "\\\\";
    else if (character === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

/** The relay argv: exactly the one flag and the one absolute bootstrap path. */
function relayArgs(entrypoints: NativeMcpEntrypoints, bootstrapFile: string): string[] {
  return [entrypoints.relayEntry, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, bootstrapFile];
}

/** True when the operator already supplies Claude MCP scope flags in real option position. */
function claudeMcpOverrideConflict(scan: NativeArgPositionScan): boolean {
  return scan.options.some((option) => option.name === CLAUDE_MCP_CONFIG_OPTION
    || option.name === CLAUDE_STRICT_MCP_CONFIG_OPTION);
}

/** Codex key segment as the override parser sees it, with stray quoting stripped conservatively. */
function codexKeySegment(segment: string): string {
  return segment.trim().replace(/^["']|["']$/gu, "").trim();
}

/**
 * True when the operator already writes the Codex MCP configuration we would
 * add: the whole `mcp_servers` table (which our same-layer override would
 * merge into or be replaced by) or any path under the reserved server name.
 * Other servers are different paths and stay untouched.
 */
function codexMcpOverrideConflict(scan: NativeArgPositionScan): boolean {
  return scan.options.some((option) => {
    if (!CODEX_CONFIG_OPTIONS.includes(option.name)) return false;
    const assignment = option.attached ?? option.operand;
    // A config option with no readable assignment is ambiguous: decline.
    if (typeof assignment !== "string") return true;
    const segments = assignment.split("=")[0].split(".").map(codexKeySegment);
    if (segments[0] !== CODEX_MCP_SERVERS_KEY) return false;
    if (segments.length === 1) return true;
    return segments[1] === NATIVE_MCP_SERVER_NAME;
  });
}

/**
 * Validates one compatibility result's shape. Returns undefined for anything
 * malformed, so a foreign or half-built record can never stand in for one.
 */
export function parseNativeMcpProviderConfigCompatibility(value: unknown): NativeMcpProviderConfigCompatibility | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { status, backend, instanceId, workspace } = record;
  if (!isNativeCliBackend(backend)) return undefined;
  if (typeof instanceId !== "string" || !/^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/iu.test(instanceId) || instanceId.length > 128) return undefined;
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > MAX_PROVIDER_WORKSPACE_LENGTH
    || !isAbsolute(workspace) || containsControlCharacter(workspace)) return undefined;
  const keys = Object.keys(record);
  if (status === "unresolved") {
    if (!keys.every((key) => ["status", "backend", "instanceId", "workspace"].includes(key))) return undefined;
    return { status, backend, instanceId, workspace };
  }
  if (status !== "resolved") return undefined;
  if (!keys.every((key) => ["status", "backend", "instanceId", "workspace", "configuredServerNames"].includes(key))) return undefined;
  const names = record.configuredServerNames;
  if (!Array.isArray(names) || names.length > MAX_PROVIDER_SERVER_NAMES) return undefined;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_PROVIDER_SERVER_NAME_LENGTH) return undefined;
  }
  return { status, backend, instanceId, workspace, configuredServerNames: [...names] as string[] };
}

/**
 * The tool-namespace form of a server name. Providers sanitize server names
 * into tool prefixes, so two names that differ only in case or punctuation can
 * still collide; the comparison is deliberately that conservative.
 */
function serverNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "_");
}

/** Exact kernel identity of one owned entry, pinned by an open descriptor. */
interface OwnedEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly dev: bigint;
  readonly ino: bigint;
  fd: number | undefined;
}

function sameIdentity(entry: OwnedEntry, stats: BigIntStats): boolean {
  return stats.dev === entry.dev && stats.ino === entry.ino;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // The descriptor is released either way.
  }
}

/**
 * One freshly owned root holding flat files only.
 *
 * Every entry is recorded the moment it exists, from a descriptor opened on
 * it (exclusive no-follow creation for files, a no-follow directory open for
 * the root), and that descriptor stays open until cleanup. A failure at any
 * later step — mode change, write, a second file — therefore always finds the
 * entry in the record and rolls it back. Cleanup removes exactly the pinned
 * inodes through a root that is still the pinned directory; anything else is
 * preserved, never a recursive delete.
 */
/**
 * A staging failure whose rollback already ran, carrying what that rollback
 * did so the caller can report any path it could not safely remove.
 */
class StagingRollbackError extends Error {
  readonly rollback: NativeMcpArtifactCleanup;

  constructor(rollback: NativeMcpArtifactCleanup, cause: unknown) {
    super("native MCP artifact staging failed", { cause });
    this.rollback = rollback;
  }
}

class OwnedMcpArtifacts {
  readonly root: string;
  readonly #rootEntry: OwnedEntry;
  readonly #files: OwnedEntry[] = [];
  /** Created paths whose identity could never be read: never removed, always reported. */
  readonly #unverifiedFiles: string[] = [];
  #result: NativeMcpArtifactCleanup | undefined;

  private constructor(root: string, rootEntry: OwnedEntry) {
    this.root = root;
    this.#rootEntry = rootEntry;
  }

  /**
   * Creates the root inside an already canonical, already validated parent.
   * `mkdtemp` creates the directory with mode 0700 itself; it is then pinned by
   * a no-follow directory descriptor before anything else can fail. A created
   * path that cannot be pinned as this user's real directory is removed with a
   * plain (non-recursive) rmdir only when it is still a directory.
   */
  static create(canonicalParent: string, probe: (stage: NativeMcpStagingStage) => void): OwnedMcpArtifacts {
    const created = mkdtempSync(join(canonicalParent, NATIVE_MCP_ARTIFACT_ROOT_PREFIX));
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    // Creation and pinning are separate steps: the new directory's identity is
    // recorded first, so a failure before any descriptor exists (EMFILE, a
    // lookup error) still rolls back exactly this directory.
    let createdStats: BigIntStats | undefined;
    let fd: number | undefined;
    let pinned = false;
    let rootRollback: NativeMcpArtifactCleanup | undefined;
    try {
      createdStats = lstatSync(created, { bigint: true });
      if (!createdStats.isDirectory() || uid === undefined || createdStats.uid !== uid) throw new Error("not an owned directory");
      probe("root-before-open");
      fd = openSync(created, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
      const stats = fstatSync(fd, { bigint: true });
      if (!stats.isDirectory() || stats.uid !== uid || stats.dev !== createdStats.dev || stats.ino !== createdStats.ino) {
        throw new Error("artifact root changed before it could be pinned");
      }
      const artifacts = new OwnedMcpArtifacts(created, { path: created, kind: "directory", dev: stats.dev, ino: stats.ino, fd });
      pinned = true;
      fd = undefined;
      try {
        probe("root-created");
        // Explicit, not left to umask; through the pinned descriptor.
        fchmodSync(artifacts.#rootEntry.fd!, 0o700);
        // The parent was canonical, so the created path must already be.
        if (realpathSync(created) !== created) throw new Error("root is not canonical");
      } catch (error) {
        throw new StagingRollbackError(artifacts.cleanup(), error);
      }
      return artifacts;
    } catch (error) {
      if (!pinned) {
        try {
          // Non-recursive, and only the directory this call created: same
          // owner and, once recorded, the same identity.
          const current = lstatSync(created, { bigint: true });
          if (createdStats !== undefined && current.isDirectory() && uid !== undefined && current.uid === uid
            && current.dev === createdStats.dev && current.ino === createdStats.ino) {
            rmdirSync(created);
            rootRollback = { removed: [created], absent: [], preserved: [] };
          }
        } catch {
          // Left for its owner and reported below; nothing was written into it.
        } finally {
          closeQuietly(fd);
        }
        throw new StagingRollbackError(rootRollback ?? { removed: [], absent: [], preserved: [created] }, error);
      }
      throw error;
    }
  }

  /**
   * Creates one file exclusively, without following links, records it from its
   * own descriptor BEFORE writing or changing its mode, then writes it fully.
   */
  writeFile(
    name: string,
    contents: string,
    probe: (stage: NativeMcpStagingStage) => void,
    stages: readonly [NativeMcpStagingStage, NativeMcpStagingStage],
  ): string {
    const path = join(this.root, name);
    const fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let stats: BigIntStats;
    try {
      stats = fstatSync(fd, { bigint: true });
    } catch (error) {
      // No credential byte was written yet. Without the descriptor's identity
      // the path may already name a replacement, so it is never removed: it is
      // recorded as unverified and always reported as preserved.
      this.#unverifiedFiles.push(path);
      closeQuietly(fd);
      throw error;
    }
    this.#files.push({ path, kind: "file", dev: stats.dev, ino: stats.ino, fd });
    probe(stages[0]);
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    probe(stages[1]);
    return path;
  }

  cleanup(): NativeMcpArtifactCleanup {
    if (this.#result !== undefined) return this.#result;
    const removed: string[] = [];
    const absent: string[] = [];
    const preserved: string[] = [...this.#unverifiedFiles];
    try {
      const rootIntact = this.#rootIntact();
      for (const entry of [...this.#files].reverse()) {
        // Through a root that is no longer the pinned one nothing can be said.
        if (!rootIntact) {
          preserved.push(entry.path);
          continue;
        }
        let stats: BigIntStats | undefined;
        try {
          stats = lstatSync(entry.path, { bigint: true, throwIfNoEntry: false });
        } catch {
          // A lookup that failed for any other reason (EACCES, EIO, …) proves
          // nothing: the file may still be on disk, so it is preserved.
          preserved.push(entry.path);
          continue;
        }
        if (stats === undefined) {
          // Confirmed missing through the pinned root: consumed or removed.
          absent.push(entry.path);
          continue;
        }
        // The pinned descriptor keeps the original inode allocated, so a
        // replacement can never carry its identity.
        if (!stats.isFile() || !sameIdentity(entry, stats)) {
          preserved.push(entry.path);
          continue;
        }
        try {
          unlinkSync(entry.path);
          removed.push(entry.path);
        } catch {
          preserved.push(entry.path);
        }
      }
      if (rootIntact) {
        try {
          // Non-recursive: a root that now holds a foreign entry survives.
          rmdirSync(this.root);
          removed.push(this.root);
        } catch {
          preserved.push(this.root);
        }
      } else {
        try {
          const stats = lstatSync(this.root, { throwIfNoEntry: false });
          (stats === undefined ? absent : preserved).push(this.root);
        } catch {
          preserved.push(this.root);
        }
      }
    } finally {
      for (const entry of [...this.#files, this.#rootEntry]) {
        closeQuietly(entry.fd);
        entry.fd = undefined;
      }
    }
    this.#result = { removed, absent, preserved };
    return this.#result;
  }

  #rootIntact(): boolean {
    try {
      const stats = lstatSync(this.root, { bigint: true, throwIfNoEntry: false });
      if (stats === undefined) return false;
      return stats.isDirectory() && !stats.isSymbolicLink() && sameIdentity(this.#rootEntry, stats);
    } catch {
      return false;
    }
  }
}

/**
 * True when the relay's own protected-path walk would accept a bootstrap file
 * at `bootstrapFile`. The walk is reused rather than re-implemented: entries
 * that do not exist yet are described to it (the leaf as this user's entry and,
 * before the root is created, the root as this user's private directory),
 * while every other directory from `/` down is read from the real filesystem
 * without following links.
 */
function relayWouldAcceptBootstrapPath(bootstrapFile: string, plannedRoot?: string): boolean {
  if (typeof process.getuid !== "function") return false;
  const uid = BigInt(process.getuid());
  if (!isAbsolute(bootstrapFile) || resolvePath(bootstrapFile) !== bootstrapFile) return false;
  const leaf: NativeMcpPathStats = { uid, mode: 0o100600n, isDirectory: () => false, isSocket: () => true };
  const root: NativeMcpPathStats = { uid, mode: 0o040700n, isDirectory: () => true, isSocket: () => false };
  return isProtectedNativeMcpSocketPath(bootstrapFile, {
    uid,
    lstat: (path) => {
      if (path === bootstrapFile) return leaf;
      if (plannedRoot !== undefined && path === plannedRoot) return root;
      return lstatSync(path, { bigint: true });
    },
  });
}

/**
 * Canonicalizes the artifact parent and proves, BEFORE anything is created,
 * that a private root created directly inside it would satisfy the relay's
 * protected-path rule. Returns the canonical parent, or undefined.
 */
function protectedArtifactParent(parent: string): string | undefined {
  if (typeof parent !== "string" || !isAbsolute(parent) || containsControlCharacter(parent)) return undefined;
  let canonical: string;
  try {
    canonical = realpathSync(parent);
    if (!lstatSync(canonical).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const plannedRoot = join(canonical, `${NATIVE_MCP_ARTIFACT_ROOT_PREFIX}XXXXXX`);
  const plannedBootstrap = join(plannedRoot, BOOTSTRAP_FILE_NAME);
  if (dirname(plannedRoot) !== canonical || containsControlCharacter(plannedBootstrap)) return undefined;
  return relayWouldAcceptBootstrapPath(plannedBootstrap, plannedRoot) ? canonical : undefined;
}

/**
 * Decides provider-configuration compatibility from the trusted result alone.
 * A malformed or mismatched result is a contract refusal; a missing or
 * unresolved one, or a reserved-name collision, declines.
 */
function providerConfigDecision(
  input: NativeMcpLaunchPreparationInput,
  bootstrap: NativeMcpBootstrap,
): "compatible" | "provider-config-unresolved" | "provider-config-conflict" {
  if (input.providerConfig === undefined) return "provider-config-unresolved";
  const facts = parseNativeMcpProviderConfigCompatibility(input.providerConfig);
  if (facts === undefined) throw refuse("the provider MCP configuration compatibility result is malformed");
  if (facts.backend !== bootstrap.backend || facts.instanceId !== bootstrap.instanceId) {
    throw refuse("the provider MCP configuration compatibility result belongs to a different registration");
  }
  if (typeof input.workspace !== "string" || facts.workspace !== input.workspace) {
    throw refuse("the provider MCP configuration compatibility result was produced for a different workspace");
  }
  if (facts.status !== "resolved") return "provider-config-unresolved";
  const reserved = serverNamespace(NATIVE_MCP_SERVER_NAME);
  return facts.configuredServerNames.some((name) => serverNamespace(name) === reserved)
    ? "provider-config-conflict"
    : "compatible";
}

/**
 * Prepare one launch's native MCP relay instruction.
 *
 * Contract, in order:
 *
 * 1. Unsupported platforms and non-native backends are refusals; the bootstrap
 *    is re-validated strictly and must be registered for the requested backend
 *    (a hook observer bootstrap, a foreign record, or a cross-backend record is
 *    a refusal, never a partial arming), and a supplied compatibility result
 *    must be well formed and bound to the same registration and workspace.
 * 2. A genuine worker-role authorization in the launch environment is rejected
 *    BEFORE any filesystem effect.
 * 3. Windows, a non-owned Codex launch, an operator argv MCP conflict, and a
 *    missing, unresolved, or colliding provider-configuration result are
 *    declined with no filesystem effect.
 * 4. The entry points are checked and the canonical artifact parent is proved
 *    acceptable to the relay before anything is created; every created entry
 *    is recorded from its own descriptor immediately, and a failure at any
 *    later step rolls back exactly what this call created.
 */
export async function prepareNativeMcpLaunch(
  input: NativeMcpLaunchPreparationInput,
): Promise<NativeMcpLaunchOutcome> {
  const { backend, platform } = input;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw refuse(`native MCP launch preparation supports macOS/Linux and Windows descriptors only; ${platform} is unsupported`);
  }
  if (!isNativeCliBackend(backend)) {
    throw refuse(`"${String(backend)}" is not a native interactive CLI backend`);
  }
  const bootstrap = parseNativeMcpBootstrap(input.bootstrap);
  if (bootstrap === undefined) throw refuse("the native MCP bootstrap is missing, malformed, or carries an unexpected field");
  if (bootstrap.backend !== backend) {
    throw refuse(`the native MCP bootstrap is registered for ${bootstrap.backend} and cannot arm a ${backend} launch`);
  }
  if (typeof input.ownedCodexBackend !== "boolean") {
    throw refuse("the owned Codex backend fact must be a boolean");
  }
  const compatibility = providerConfigDecision(input, bootstrap);

  const roleProbe = snapshotNativeEnvironment(input.env ?? {}, platform);
  rejectAndStripInheritedHostCapabilities(roleProbe);

  // The relay refuses every Windows bootstrap file; declining here keeps the
  // launch unchanged and stages nothing, with no insecure fallback.
  if (platform === "win32") return unavailable(backend, "platform-unsupported");

  if (backend === "codex") {
    if (!input.ownedCodexBackend) return unavailable(backend, "codex-backend-not-owned");
    if (codexMcpOverrideConflict(input.scan)) return unavailable(backend, "operator-mcp-override");
  } else if (claudeMcpOverrideConflict(input.scan)) {
    return unavailable(backend, "operator-mcp-override");
  }
  if (compatibility !== "compatible") return unavailable(backend, compatibility);

  const entrypoints = resolveRelayEntrypoints(input.entrypoints);
  if (entrypoints === null) return unavailable(backend, "relay-entry-unavailable");

  const parent = protectedArtifactParent(input.artifactParent ?? tmpdir());
  if (parent === undefined) return unavailable(backend, "artifact-path-unprotected");

  let encodedBootstrap: string;
  try {
    encodedBootstrap = encodeNativeMcpBootstrap(bootstrap);
  } catch {
    throw refuse("the native MCP bootstrap cannot be encoded canonically");
  }

  const probe = input.stagingProbe ?? ((): void => undefined);
  let artifacts: OwnedMcpArtifacts | undefined;
  try {
    artifacts = OwnedMcpArtifacts.create(parent, probe);
    const bootstrapFile = join(artifacts.root, BOOTSTRAP_FILE_NAME);
    // Re-proved against the real root before the token is written.
    if (containsControlCharacter(bootstrapFile) || !relayWouldAcceptBootstrapPath(bootstrapFile)) {
      return withRollback(unavailable(backend, "artifact-path-unprotected"), artifacts.cleanup());
    }
    artifacts.writeFile(BOOTSTRAP_FILE_NAME, encodedBootstrap, probe, ["bootstrap-opened", "bootstrap-written"]);
    const serverArgs = relayArgs(entrypoints, bootstrapFile);
    let args: string[];
    let route: NativeMcpLaunchRoute;
    let placement: NativeMcpLaunchPlacement;
    if (backend === "claude") {
      // Exactly one reserved stdio server: no env, no tool settings, no
      // approval or loading hints, so the operator's permission prompts apply.
      const configFile = artifacts.writeFile(
        CLAUDE_CONFIG_FILE_NAME,
        `${JSON.stringify({
          mcpServers: {
            [NATIVE_MCP_SERVER_NAME]: { type: "stdio", command: entrypoints.nodeExecutable, args: serverArgs },
          },
        })}\n`,
        probe,
        ["config-opened", "config-written"],
      );
      args = [`${CLAUDE_MCP_CONFIG_OPTION}=${configFile}`];
      route = "claude-mcp-config";
      placement = "claude-tui";
    } else {
      // Only `command` and `args`: no enabled/required/approval/timeout keys, so
      // nothing about the operator's other servers or approval posture moves.
      const value = `{command=${tomlBasicString(entrypoints.nodeExecutable)},args=[${serverArgs.map(tomlBasicString).join(",")}]}`;
      args = ["-c", `${CODEX_MCP_SERVERS_KEY}.${NATIVE_MCP_SERVER_NAME}=${value}`];
      route = "codex-owned-backend-config";
      placement = "codex-owned-backend";
    }
    const staged = artifacts;
    return {
      mcp: "prepared",
      backend,
      route,
      placement,
      serverName: NATIVE_MCP_SERVER_NAME,
      args,
      lease: {
        root: staged.root,
        bootstrapFile,
        cleanup: async () => staged.cleanup(),
      },
    };
  } catch (error) {
    // A rollback that already ran (inside root creation) is reported as is;
    // otherwise the recorded artifacts are rolled back here.
    const rollback = error instanceof StagingRollbackError ? error.rollback : artifacts?.cleanup();
    return withRollback(unavailable(backend, "artifact-staging-failed"), rollback);
  }
}

/** Attach a rollback result only when it left something the caller must know about. */
function withRollback(
  outcome: NativeMcpLaunchUnavailable,
  rollback: NativeMcpArtifactCleanup | undefined,
): NativeMcpLaunchUnavailable {
  return rollback !== undefined && rollback.preserved.length > 0 ? { ...outcome, rollback } : outcome;
}
