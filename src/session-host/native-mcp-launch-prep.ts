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
 * Windows relay environment. A provider starts its stdio MCP children with its
 * own minimal environment, and on Windows that environment lacks
 * `PSModulePath`. The relay's Windows bootstrap reader runs the existing
 * trusted DACL helper, which starts Windows PowerShell with the relay's own
 * environment; without `PSModulePath` that PowerShell was observed to hang
 * before running its script, so the relay timed out. A Windows server
 * definition therefore carries exactly ONE environment entry, `PSModulePath`,
 * whose value is the trusted HOST process's own inherited value — the same
 * value the host's own DACL helper runs with — read through the canonical
 * case-insensitive Windows snapshot ({@link snapshotNativeEnvironment}) of
 * that one name only. It is never read from the child environment, the
 * target's configured overlay, a project or provider layer, or a guessed
 * install path; nothing else (no credential, no PATH, no other variable) is
 * carried, there is no per-server environment option, and an absent, empty,
 * oversized, or non-printable value is simply not carried. Neither is a value
 * containing `$`: Claude's MCP configuration documents `${VAR}` and
 * `${VAR:-default}` expansion inside stdio `env` values and no literal escape,
 * so such a value could be rewritten from the provider's own environment
 * rather than the host's. The rule is deliberately broader than the
 * documented `${` forms and applies to both providers, so the two
 * definitions never diverge. POSIX definitions carry no environment at all.
 *
 * Not enforced here: the Windows command-line length of the owned Codex
 * backend. The `-c` override is only one token of a command the owned plan
 * composes later (`renderBackend`, with host-supplied control arguments, and
 * through cmd.exe's 8,191-character line for a `.cmd`/`.bat` shim), so this
 * module cannot see the rendered length.
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
 * Server name. Both providers receive ONE stable, host-wide MCP server name
 * that the trusted owning host supplies (`serverName`): the fixed prefix
 * {@link NATIVE_MCP_SERVER_NAME_PREFIX} followed by exactly
 * {@link NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH} lowercase hexadecimal digits,
 * generated randomly ONCE per host and persisted by the host — never derived
 * from a model, a row, or a launch, and never generated here. This module only
 * validates the grammar ({@link isValidNativeMcpServerName}); an absent or
 * invalid name is a refusal before any filesystem effect. The name is written
 * only into this launch's own provider instruction: never into workspace or
 * project settings, trust, approval lists, or any scoped authorization.
 *
 * Provider channels (narrow, no invented switches):
 *
 * - **Claude Code**: one `--mcp-config=<file>` whose JSON defines exactly one
 *   stdio server (the supplied name) and nothing else (on Windows, its `env`
 *   holds only the trusted `PSModulePath` described above).
 *   The attached `=` spelling is deliberate: the option is variadic, and the
 *   attached form can never consume a following token as another config. No
 *   `--strict-mcp-config`, no permission mode, no allowed-tools entry, no
 *   preapproval, no prompt, skill, or `alwaysLoad` setting is ever added, so
 *   every MCP tool call still goes through the operator's own native
 *   permission prompts.
 *
 *   Joining an operator `--mcp-config`. Claude's own parser (observed in the
 *   installed CLI) gives `--mcp-config` ONE option value: a separated
 *   occurrence takes its operand and every following token up to the next
 *   option-like one, an attached `--mcp-config=<value>` takes exactly that
 *   value, and repeated occurrences concatenate in argv order. Claude then
 *   loads each entry (a file path or inline JSON) and merges all of their
 *   servers. So when the operator already passes `--mcp-config` WITHOUT
 *   `--strict-mcp-config`, our attached flag is simply appended at the
 *   generated-flag position (after every operator token in real option
 *   position, before any `--` and any option still missing its operand): the
 *   one native option then holds the operator's inputs, unchanged and in their
 *   own order, followed by our private file. Operator tokens are never moved,
 *   rewritten, opened, or read as files; the operator's server set stays
 *   exactly theirs, plus the one host server. Preparation still declines,
 *   leaving argv exactly as configured, when the operator passes
 *   `--strict-mcp-config` (their chosen scope stays theirs), when a separated
 *   `--mcp-config` has no readable operand (missing, or the provider would read
 *   a `--` as its value, a config literally named `--`), or when an inline JSON
 *   input defines a server whose decoded key equals the selected host name by
 *   tool namespace (inline JSON is the only place such a name can be seen
 *   without reading files; an input that starts like JSON but does not parse
 *   is ambiguous and also declines). File-path inputs stay opaque.
 * - **Codex**: only an OWNED app-server backend receives the instruction,
 *   because that backend is the core that starts MCP servers; the interactive
 *   TUI attached to it over `--remote` never does, and a legacy non-owned
 *   Codex launch is declined. The instruction is exactly one
 *   `-c mcp_servers.<name>={command=…,args=[…]}` override (on Windows with
 *   a trusted value, `{command=…,args=[…],env={PSModulePath=…}}`), rendered into
 *   the owned backend's global options after the operator's own `-c`/`--config`
 *   tokens. Unrelated servers are untouched. When the operator already writes
 *   `mcp_servers` as a whole, the selected server's own path (compared by tool
 *   namespace), or a config option with no readable assignment, in real option
 *   position, preparation declines rather than replace theirs.
 *
 * Observed conflicts versus residual risk. The conflicts refused above are the
 * ones actually visible in this launch's supported inputs (the configured argv,
 * read through the launch adapter's one scanner). This module does NOT require,
 * and never builds, a complete inventory of the provider's EFFECTIVE MCP
 * configuration (Claude user/project/local/plugin/managed/connector scopes;
 * Codex user, project, profile, plugin, and managed layers, plus per-thread
 * client overrides): neither provider exposes one that is read-only and bound
 * to the configuration the launched child consumes. A server of the same name
 * configured only in such a layer could therefore replace or merge with this
 * instruction. That residual risk is accepted by design and made negligible by
 * the 128-bit random host suffix: a collision requires the operator to have
 * configured this host's own random name elsewhere.
 *
 * Either route stays subject to the operator's native policy — Claude managed
 * MCP configuration and allow/deny lists, Codex managed requirements, and
 * every approval gate. This module bypasses none of them: a relay the provider
 * declines to start simply never connects, and the row's tool lane stays
 * unavailable.
 *
 * Artifacts are freshly owned and private. The artifact parent (the system
 * temporary directory; on Windows, only when that default cannot be proven,
 * the trusted host's existing `LOCALAPPDATA` directory under the identical
 * proof) is canonicalized and proved acceptable BEFORE anything is created.
 * The root is then a new `mkdtemp` directory and each file is
 * created exclusively without following links. Every entry is recorded from its
 * own descriptor the moment it exists — before any protection change or write —
 * so any later failure rolls it back, and no capability byte is written until
 * that file's protection has been PROVEN:
 *
 * - **POSIX**: the parent must pass the relay's own protected-path walk; the
 *   root is `0700`, and each file is set to `0600` on its own descriptor and
 *   re-read from that descriptor (this user's, exactly `0600`) before writing.
 * - **Windows**: protection uses the repository's EXISTING platform permission
 *   policy ({@link createPeerStatePermissionPolicy}, the trusted DACL helper)
 *   and nothing else — no new helper, executable, configuration, or
 *   protection fallback (the ancestor rule below is that policy's own read-only proof
 *   over the same descriptor evidence), and no change
 *   to any directory this module did not just create. Every directory from
 *   the drive root down to the canonical local parent must be a real
 *   (non-reparse) directory: the parent itself passing
 *   `assertOwnerControlledDirectory`, and each higher existing component the
 *   policy's read-only `assertReplacementProtectedAncestor`, so the path
 *   cannot be redirected by another principal; the created root is
 *   given and proven a private DACL by `protectCreatedDirectory`, and each
 *   created empty file by `protectCreatedFile`; the path must still name the
 *   recorded empty entry after each proof. Those are exactly the proofs the
 *   relay's Windows reader repeats before it opens the bootstrap. There is
 *   still no environment or argv carriage of the token.
 *
 * Descriptors and cleanup. On POSIX the descriptors stay open for the lease
 * lifetime, so no owned inode can be freed and reused by a replacement. On
 * Windows each file descriptor is closed as soon as that file is complete,
 * because Windows defers deleting a file while any handle is open: a held
 * handle would turn the relay's one-shot consumption into a pending delete
 * that neither cleanup nor the non-recursive root removal could observe or
 * finish. Windows identity is then the volume's file ID (an NTFS file
 * reference carries a reuse sequence number) inside the root's private DACL;
 * the root's own descriptor stays open until cleanup and is closed just
 * before its identity is re-checked and the empty root is removed. Cleanup
 * removes exactly the recorded entries through the recorded root, preserves
 * anything else, never deletes recursively, and reports the relay's
 * consumption of the bootstrap as `absent`.
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
import type { PeerStatePermissionPolicy } from "./network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy } from "./network/peer-state-permissions";
import {
  encodeNativeMcpBootstrap,
  parseNativeMcpBootstrap,
  type NativeMcpBootstrap,
} from "./native-mcp-protocol";
import {
  NATIVE_MCP_BOOTSTRAP_FILE_NAME as BOOTSTRAP_FILE_NAME,
  NATIVE_MCP_RELAY_BOOTSTRAP_FLAG,
  isCanonicalLocalNativeMcpPath,
  isProtectedNativeMcpSocketPath,
  windowsNativeMcpClaimPath,
  type NativeMcpPathStats,
} from "./native-mcp-relay";
import {
  trustedWindowsHostValue,
  windowsArtifactParent,
  windowsDefaultArtifactParent,
  type WindowsPlannedArtifactPath,
} from "./native-windows-artifact-parent";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";
// Type-only: the launch adapter owns the one argv scanner, and this module only
// reads the facts it already computed. There is no runtime import back.
import type { NativeArgPositionScan } from "./native-cli-launch";

/**
 * Fixed prefix of the stable host-wide MCP server name. The full name is this
 * prefix plus {@link NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH} lowercase hex digits,
 * a plain identifier valid in both providers' server-name rules and as one
 * Codex configuration path segment.
 *
 * Handoff: the host-side generator/persistence module defines the same
 * grammar; once both land, one of the two definitions should import the other
 * so the grammar has a single owner.
 */
export const NATIVE_MCP_SERVER_NAME_PREFIX = "pi_review_gate_";

/** Number of lowercase hexadecimal digits after the prefix (128 random bits). */
export const NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH = 32;

const NATIVE_MCP_SERVER_NAME_PATTERN = new RegExp(
  `^${NATIVE_MCP_SERVER_NAME_PREFIX}[0-9a-f]{${NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH}}$`,
  "u",
);

/**
 * The one validator of the stable host MCP server name grammar at the launch
 * boundary. Anything else — another prefix, uppercase, a shorter or longer
 * suffix, surrounding whitespace, a non-string — is rejected.
 */
export function isValidNativeMcpServerName(value: unknown): value is string {
  return typeof value === "string" && NATIVE_MCP_SERVER_NAME_PATTERN.test(value);
}

/** Claude's documented per-launch MCP configuration option. */
export const CLAUDE_MCP_CONFIG_OPTION = "--mcp-config";

/** Claude's strict-scope option; never emitted, only honored when the operator set it. */
const CLAUDE_STRICT_MCP_CONFIG_OPTION = "--strict-mcp-config";

/** Codex's per-launch configuration override options. */
const CODEX_CONFIG_OPTIONS: readonly string[] = ["-c", "--config"];

/** The Codex configuration table of MCP servers. */
const CODEX_MCP_SERVERS_KEY = "mcp_servers";

/** Fixed artifact names inside one owned root. */
const CLAUDE_CONFIG_FILE_NAME = "claude-mcp-config.json";

/** Prefix of every owned artifact root under the proven artifact parent. */
export const NATIVE_MCP_ARTIFACT_ROOT_PREFIX = "prg-native-mcp-";

/** Which provider channel received the relay instruction. */
export type NativeMcpLaunchRoute =
  /** Claude TUI argv: one `--mcp-config=<file>`. */
  | "claude-mcp-config"
  /** Owned Codex app-server backend argv: one `-c mcp_servers.<host name>=…`. */
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
  /** Codex without an owned app-server backend (legacy TUI launch): no owned core to configure. */
  | "codex-backend-not-owned"
  /**
   * The operator's own MCP flags in this launch's argv already cover what we
   * would add (including the selected server name), narrow the scope we would
   * join (Claude `--strict-mcp-config`), or how ours would combine is
   * ambiguous. A plain operator Claude `--mcp-config` is joined, not declined.
   */
  | "operator-mcp-override"
  /** The Node host or the compiled relay entry is not an absolute regular file. */
  | "relay-entry-unavailable"
  /**
   * The artifact root is not canonical or its ancestry is not protected the way
   * the relay requires (on Windows: the existing policy could not prove the
   * parent owner-controlled, including a host with no trusted helper).
   */
  | "artifact-path-unprotected"
  /** An artifact could not be staged; `rollback` lists any path that could not safely be removed. */
  | "artifact-staging-failed";

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
 * On POSIX the lease holds one close-on-exec descriptor per owned entry (the
 * root and each file) until cleanup, so no owned inode can be freed and its
 * number reused by a replacement while the lease is live: identity comparison
 * at cleanup is therefore proof, not a heuristic. On Windows only the root's
 * descriptor is held (see the module notes on deferred deletion). An
 * unreleased lease keeps those few descriptors open; owners must always call
 * `cleanup`.
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
  /** The supplied stable host server name both provider instructions use. */
  readonly serverName: string;
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
   * The trusted owning host's stable, host-wide MCP server name (see
   * {@link isValidNativeMcpServerName}). Generated once per host and persisted
   * by the host — never per launch, never from a model name. Absent or invalid
   * is a refusal before any filesystem effect.
   */
  readonly serverName: string;
  /**
   * Test seam for literal-path coverage only: production passes nothing and the
   * launch adapter never sets it. Both values still have to be absolute
   * regular files.
   */
  readonly entrypoints?: NativeMcpEntrypoints;
  /**
   * Test seam only: the directory the owned root is created under (defaults to
   * the system temporary directory; on Windows, when that cannot be proven, the
   * trusted host's proven `LOCALAPPDATA`). The launch adapter never sets it,
   * the same protected-ancestry rule applies to it, and an explicit value never
   * falls back.
   */
  readonly artifactParent?: string;
  /**
   * Test seam only: called at fixed staging points so a test can inject a
   * failure (by throwing). Production passes nothing.
   */
  readonly stagingProbe?: (stage: NativeMcpStagingStage) => void;
  /**
   * Test seam only: the trusted host process environment the Windows relay's
   * one carried `PSModulePath` is read from, and (only when the default
   * temporary parent cannot be proven) the default fallback's `LOCALAPPDATA`.
   * Production passes nothing and the host's own `process.env` is used — the
   * environment the host's existing DACL helper itself runs with. Only those
   * names are read from it, and only on Windows; it is never the child
   * environment above or a configured overlay. Never consulted on POSIX.
   */
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  /**
   * Test seam only: the Windows protection proof. Production passes nothing
   * and Windows uses {@link createPeerStatePermissionPolicy} (the existing
   * trusted DACL helper); a test substitutes a policy of the same contract.
   * Never consulted on POSIX.
   */
  readonly permissions?: PeerStatePermissionPolicy;
}

/** The fixed staging points `stagingProbe` observes. */
export type NativeMcpStagingStage =
  | "root-before-open"
  | "root-created"
  | "bootstrap-opened"
  /** The empty bootstrap's protection is proven; no byte has been written yet. */
  | "bootstrap-protected"
  | "bootstrap-written"
  | "config-opened"
  /** The empty Claude config's protection is proven; no byte has been written yet. */
  | "config-protected"
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

/** The one environment name a Windows relay definition may carry. */
const WINDOWS_RELAY_MODULE_PATH_NAME = "PSModulePath";

/** Windows' documented maximum length of one environment variable value. */
const WINDOWS_ENVIRONMENT_VALUE_MAX_LENGTH = 32_767;

/** The Windows relay definition's whole environment: the one trusted entry. */
interface WindowsRelayEnvironment {
  readonly PSModulePath: string;
}

/**
 * The trusted host's own `PSModulePath` ({@link trustedWindowsHostValue}).
 * Differing case variants refuse. An absent, empty, oversized,
 * control-character, ill-formed (lone surrogate), or `$`-bearing (provider
 * interpolation syntax) value is not carried: `undefined`, the existing
 * definition.
 */
function trustedWindowsRelayEnvironment(hostEnvironment: NodeJS.ProcessEnv): WindowsRelayEnvironment | undefined {
  const value = trustedWindowsHostValue(hostEnvironment, WINDOWS_RELAY_MODULE_PATH_NAME);
  if (typeof value !== "string" || value.length === 0 || value.length > WINDOWS_ENVIRONMENT_VALUE_MAX_LENGTH
    || containsControlCharacter(value) || /\p{Cs}/u.test(value) || value.includes("$")) return undefined;
  return { [WINDOWS_RELAY_MODULE_PATH_NAME]: value } as WindowsRelayEnvironment;
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

/**
 * True when the operator's Claude MCP flags in real option position rule out
 * joining our config to theirs:
 *
 * - `--strict-mcp-config` in any spelling: their deliberately narrowed scope is
 *   never widened.
 * - a separated `--mcp-config` with no operand, or whose operand is `--`
 *   (which the provider reads as a config named `--`): malformed.
 * - an inline JSON input whose `mcpServers` defines a key equal to the selected
 *   host name by tool namespace, compared after JSON decoding (so an escaped
 *   spelling of the name is still caught, and a prefix-sharing name such as
 *   `<host name>_backup` is not), or an input that starts like JSON (`{`) but
 *   does not parse.
 *
 * Every other operator `--mcp-config` is joined, never read: file contents are
 * not opened, so a same-name entry inside an operator FILE is the same accepted
 * residual risk as any other provider layer.
 */
function claudeMcpOverrideConflict(scan: NativeArgPositionScan, serverName: string): boolean {
  const selected = serverNamespace(serverName);
  return scan.options.some((option) => {
    if (option.name === CLAUDE_STRICT_MCP_CONFIG_OPTION) return true;
    if (option.name !== CLAUDE_MCP_CONFIG_OPTION) return false;
    const values = option.attached !== undefined
      ? [option.attached]
      : option.operand !== undefined && option.operand !== "--"
        ? [option.operand, ...(option.variadicValues ?? [])]
        : undefined;
    if (values === undefined) return true;
    return values.some((value) => {
      const names = inlineClaudeMcpServerNames(value);
      return names === undefined || names.some((name) => serverNamespace(name) === selected);
    });
  });
}

/**
 * The server keys an operator `--mcp-config` input defines when it is inline
 * JSON, decoded exactly as JSON. Every other input is a file path that is never
 * opened: `[]`. An input that starts like a JSON object but does not parse is
 * ambiguous (the provider might read it either way): `undefined`. The argv
 * token itself is never altered.
 */
function inlineClaudeMcpServerNames(value: string): readonly string[] | undefined {
  const trimmed = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.startsWith("{") ? undefined : [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const servers: unknown = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers);
}

/** Codex key segment as the override parser sees it, with stray quoting stripped conservatively. */
function codexKeySegment(segment: string): string {
  return segment.trim().replace(/^["']|["']$/gu, "").trim();
}

/**
 * True when the operator already writes the Codex MCP configuration we would
 * add: the whole `mcp_servers` table (which our same-layer override would
 * merge into or be replaced by) or any path under the selected server name,
 * compared by tool namespace. Other servers are different paths and stay
 * untouched.
 */
function codexMcpOverrideConflict(scan: NativeArgPositionScan, serverName: string): boolean {
  const selected = serverNamespace(serverName);
  return scan.options.some((option) => {
    if (!CODEX_CONFIG_OPTIONS.includes(option.name)) return false;
    const assignment = option.attached ?? option.operand;
    // A config option with no readable assignment is ambiguous: decline.
    if (typeof assignment !== "string") return true;
    const segments = assignment.split("=")[0].split(".").map(codexKeySegment);
    if (segments[0] !== CODEX_MCP_SERVERS_KEY) return false;
    if (segments.length === 1) return true;
    return serverNamespace(segments[1]) === selected;
  });
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
  /** The Windows protection proof; `undefined` on POSIX. */
  readonly #windows: PeerStatePermissionPolicy | undefined;
  #result: NativeMcpArtifactCleanup | undefined;

  private constructor(root: string, rootEntry: OwnedEntry, windows: PeerStatePermissionPolicy | undefined) {
    this.root = root;
    this.#rootEntry = rootEntry;
    this.#windows = windows;
  }

  /**
   * Creates the root inside an already canonical, already validated parent.
   * `mkdtemp` creates the directory (mode 0700 on POSIX itself); it is then
   * pinned by a no-follow directory descriptor before anything else can fail,
   * and only then made private: `fchmod 0700` on POSIX, the existing policy's
   * `protectCreatedDirectory` on Windows (after which the path must still name
   * the pinned directory). A created path that cannot be pinned as this user's
   * real directory is removed with a plain (non-recursive) rmdir only when it
   * is still the directory this call created.
   */
  static create(
    canonicalParent: string,
    probe: (stage: NativeMcpStagingStage) => void,
    windows: PeerStatePermissionPolicy | undefined,
  ): OwnedMcpArtifacts {
    const created = mkdtempSync(join(canonicalParent, NATIVE_MCP_ARTIFACT_ROOT_PREFIX));
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
    // Windows has no numeric owner: ownership is part of the policy's DACL
    // proof below, never inferred from `stats.uid`.
    const ownedByThisUser = (stats: BigIntStats): boolean =>
      windows !== undefined || (uid !== undefined && stats.uid === uid);
    // Creation and pinning are separate steps: the new directory's identity is
    // recorded first, so a failure before any descriptor exists (EMFILE, a
    // lookup error) still rolls back exactly this directory.
    let createdStats: BigIntStats | undefined;
    let fd: number | undefined;
    let pinned = false;
    let rootRollback: NativeMcpArtifactCleanup | undefined;
    try {
      createdStats = lstatSync(created, { bigint: true });
      if (!createdStats.isDirectory() || createdStats.isSymbolicLink() || !ownedByThisUser(createdStats)) {
        throw new Error("not an owned directory");
      }
      probe("root-before-open");
      fd = openSync(created, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
      const stats = fstatSync(fd, { bigint: true });
      if (!stats.isDirectory() || !ownedByThisUser(stats) || stats.dev !== createdStats.dev || stats.ino !== createdStats.ino) {
        throw new Error("artifact root changed before it could be pinned");
      }
      const artifacts = new OwnedMcpArtifacts(created, { path: created, kind: "directory", dev: stats.dev, ino: stats.ino, fd }, windows);
      pinned = true;
      fd = undefined;
      try {
        probe("root-created");
        if (windows === undefined) {
          // Explicit, not left to umask; through the pinned descriptor.
          fchmodSync(artifacts.#rootEntry.fd!, 0o700);
        } else {
          // The existing policy: parent owner-controlled, then a private DACL
          // installed on this empty created directory and re-read as proof.
          // The path must still name the pinned directory afterwards.
          windows.protectCreatedDirectory(created);
          if (!artifacts.#rootIntact()) throw new Error("artifact root changed during protection");
        }
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
          if (createdStats !== undefined && current.isDirectory() && !current.isSymbolicLink() && ownedByThisUser(current)
            && current.dev === createdStats.dev && current.ino === createdStats.ino) {
            closeQuietly(fd);
            fd = undefined;
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
   * own descriptor BEFORE changing its protection or writing, proves its
   * protection, and only then writes it fully. On Windows the descriptor is
   * closed once the file is complete (see the module notes).
   */
  writeFile(
    name: string,
    contents: string,
    probe: (stage: NativeMcpStagingStage) => void,
    stages: readonly [NativeMcpStagingStage, NativeMcpStagingStage, NativeMcpStagingStage],
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
    const entry: OwnedEntry = { path, kind: "file", dev: stats.dev, ino: stats.ino, fd };
    this.#files.push(entry);
    probe(stages[0]);
    this.#proveFileProtected(entry, fd);
    probe(stages[1]);
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    if (this.#windows !== undefined) {
      // A held handle would defer the relay's consumption into a pending
      // delete; the identity stays recorded for cleanup.
      entry.fd = undefined;
      closeSync(fd);
    }
    probe(stages[2]);
    return path;
  }

  /**
   * Establishes and PROVES protection on one empty, just-created file before
   * any byte is written; throws (and so rolls back) otherwise.
   */
  #proveFileProtected(entry: OwnedEntry, fd: number): void {
    if (this.#windows === undefined) {
      fchmodSync(fd, 0o600);
      // Read back from the same descriptor: this user's, exactly 0600, empty.
      const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
      const after = fstatSync(fd, { bigint: true });
      if (uid === undefined || after.uid !== uid || (after.mode & 0o7777n) !== 0o600n || after.size !== 0n || !sameIdentity(entry, after)) {
        throw new Error("artifact file protection could not be proven");
      }
      return;
    }
    // The existing policy: parent private, then a private DACL installed on
    // this empty created file and re-read as proof. A descriptor chmod proves
    // nothing on Windows (and a write-only handle cannot change attributes).
    this.#windows.protectCreatedFile(entry.path);
    const after = lstatSync(entry.path, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(entry, after) || after.size !== 0n) {
      throw new Error("artifact file changed during protection");
    }
  }

  cleanup(): NativeMcpArtifactCleanup {
    if (this.#result !== undefined) return this.#result;
    const removed: string[] = [];
    const absent: string[] = [];
    const preserved: string[] = [...this.#unverifiedFiles];
    const windows = this.#windows !== undefined;
    try {
      const rootIntact = this.#rootIntact();
      // Windows: a relay interrupted inside its exclusive consumption claim
      // leaves the launch directory's fixed claim (the same path for every
      // spelling of the bootstrap name). Remove it only while it is still a
      // link to the recorded bootstrap inode; anything else at that name is
      // preserved (and so, non-recursively, is the root).
      const bootstrap = windows && rootIntact
        ? this.#files.find((entry) => entry.path === join(this.root, BOOTSTRAP_FILE_NAME))
        : undefined;
      if (bootstrap !== undefined) {
        const claim = windowsNativeMcpClaimPath(bootstrap.path);
        try {
          const stats = lstatSync(claim, { bigint: true, throwIfNoEntry: false });
          if (stats !== undefined) {
            if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(bootstrap, stats)) {
              preserved.push(claim);
            } else {
              unlinkSync(claim);
              removed.push(claim);
            }
          }
        } catch {
          preserved.push(claim);
        }
      }
      for (const entry of [...this.#files].reverse()) {
        try {
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
          // A pinned descriptor keeps the original inode allocated, so a
          // replacement can never carry its identity.
          if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(entry, stats)) {
            preserved.push(entry.path);
            continue;
          }
          try {
            unlinkSync(entry.path);
            removed.push(entry.path);
          } catch {
            preserved.push(entry.path);
          }
        } finally {
          // Windows: a file still held open (a staging rollback) is only
          // marked for deletion until its last handle closes; close it now so
          // the non-recursive root removal below can succeed.
          if (windows) {
            closeQuietly(entry.fd);
            entry.fd = undefined;
          }
        }
      }
      if (rootIntact) {
        try {
          if (windows) {
            // Windows defers removing a directory with an open handle: release
            // the pin, then re-check that the path still names the recorded
            // root before the non-recursive removal.
            closeQuietly(this.#rootEntry.fd);
            this.#rootEntry.fd = undefined;
            if (!this.#rootIntact()) throw new Error("artifact root changed before removal");
          }
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
 * This lane's half of the shared Windows parent rule
 * (./native-windows-artifact-parent, the Windows counterpart of
 * {@link protectedArtifactParent}): the one artifact path this lane stages —
 * its own root prefix and bootstrap file — so the shared rule proves this
 * lane's path canonical exactly as the sibling native review lane proves its
 * own review plugin root.
 */
const plannedMcpArtifactPath: WindowsPlannedArtifactPath = (canonicalParent) =>
  join(canonicalParent, `${NATIVE_MCP_ARTIFACT_ROOT_PREFIX}XXXXXX`, BOOTSTRAP_FILE_NAME);

/**
 * Prepare one launch's native MCP relay instruction.
 *
 * Contract, in order:
 *
 * 1. Unsupported platforms and non-native backends are refusals; the bootstrap
 *    is re-validated strictly and must be registered for the requested backend
 *    (a hook observer bootstrap, a foreign record, or a cross-backend record is
 *    a refusal, never a partial arming), and the supplied stable host server
 *    name must match {@link isValidNativeMcpServerName}.
 * 2. A genuine worker-role authorization in the launch environment is rejected
 *    BEFORE any filesystem effect.
 * 3. A non-owned Codex launch and an operator argv MCP conflict (including
 *    one that names the selected server, and a Claude strict scope or
 *    malformed `--mcp-config`) are declined with no filesystem effect. A
 *    plain operator Claude `--mcp-config` is joined, not declined. No
 *    provider-wide inventory is required.
 * 4. The entry points are checked and the canonical artifact parent is proved
 *    acceptable to the relay before anything is created (on Windows through
 *    the existing permission policy); every created entry is recorded from its
 *    own descriptor immediately, each file's protection is proven before any
 *    byte is written, and a failure at any later step rolls back exactly what
 *    this call created.
 *
 * Windows staging is shared support, not a capability switch: whether a
 * Windows host ever arms a native MCP launch is decided by the owning host
 * lane, which keeps Windows unavailable until transport and real-client
 * evidence exist (./native-managed-host-lane).
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
  const serverName: unknown = input.serverName;
  if (!isValidNativeMcpServerName(serverName)) {
    throw refuse(`the stable host MCP server name must be "${NATIVE_MCP_SERVER_NAME_PREFIX}" followed by ${NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH} lowercase hexadecimal digits`);
  }

  const roleProbe = snapshotNativeEnvironment(input.env ?? {}, platform);
  rejectAndStripInheritedHostCapabilities(roleProbe);
  // Windows only, before any filesystem effect: the trusted host's one
  // `PSModulePath`, never the child environment or a configured overlay. The
  // host environment is resolved once, and never on POSIX.
  const hostEnvironment = platform === "win32" ? (input.hostEnvironment ?? process.env) : undefined;
  const relayEnvironment = hostEnvironment === undefined
    ? undefined
    : trustedWindowsRelayEnvironment(hostEnvironment);

  if (backend === "codex") {
    if (!input.ownedCodexBackend) return unavailable(backend, "codex-backend-not-owned");
    if (codexMcpOverrideConflict(input.scan, serverName)) return unavailable(backend, "operator-mcp-override");
  } else if (claudeMcpOverrideConflict(input.scan, serverName)) {
    return unavailable(backend, "operator-mcp-override");
  }

  const entrypoints = resolveRelayEntrypoints(input.entrypoints);
  if (entrypoints === null) return unavailable(backend, "relay-entry-unavailable");

  // Windows: the existing platform permission policy (trusted DACL helper) is
  // the only protection proof; POSIX never consults it. Only the Windows
  // default parent may fall back (to the host's proven LOCALAPPDATA); an
  // explicit parent is proved as given or declined.
  const windows = platform === "win32" ? (input.permissions ?? createPeerStatePermissionPolicy({ platform })) : undefined;
  const parent = windows === undefined
    ? protectedArtifactParent(input.artifactParent ?? tmpdir())
    : input.artifactParent !== undefined
      ? windowsArtifactParent(input.artifactParent, windows, plannedMcpArtifactPath)
      // Always resolved on Windows; an empty stand-in could only decline.
      : windowsDefaultArtifactParent(hostEnvironment ?? {}, windows, plannedMcpArtifactPath);
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
    artifacts = OwnedMcpArtifacts.create(parent, probe, windows);
    const bootstrapFile = join(artifacts.root, BOOTSTRAP_FILE_NAME);
    // Re-proved against the real root before the token is written. On Windows
    // the root's private DACL was just proven by the existing policy, and the
    // file's own protection is proven inside writeFile before any byte.
    if (containsControlCharacter(bootstrapFile)
      || (windows === undefined ? !relayWouldAcceptBootstrapPath(bootstrapFile) : !isCanonicalLocalNativeMcpPath(bootstrapFile))) {
      return withRollback(unavailable(backend, "artifact-path-unprotected"), artifacts.cleanup());
    }
    artifacts.writeFile(BOOTSTRAP_FILE_NAME, encodedBootstrap, probe, ["bootstrap-opened", "bootstrap-protected", "bootstrap-written"]);
    const serverArgs = relayArgs(entrypoints, bootstrapFile);
    let args: string[];
    let route: NativeMcpLaunchRoute;
    let placement: NativeMcpLaunchPlacement;
    if (backend === "claude") {
      // Exactly one stdio server under the host name: no tool settings, no
      // approval or loading hints, so the operator's permission prompts apply,
      // and no env except the one trusted Windows `PSModulePath`.
      const configFile = artifacts.writeFile(
        CLAUDE_CONFIG_FILE_NAME,
        `${JSON.stringify({
          mcpServers: {
            [serverName]: {
              type: "stdio",
              command: entrypoints.nodeExecutable,
              args: serverArgs,
              ...(relayEnvironment === undefined ? {} : { env: { ...relayEnvironment } }),
            },
          },
        })}\n`,
        probe,
        ["config-opened", "config-protected", "config-written"],
      );
      args = [`${CLAUDE_MCP_CONFIG_OPTION}=${configFile}`];
      route = "claude-mcp-config";
      placement = "claude-tui";
    } else {
      // Only `command` and `args` (plus, on Windows, the inline `env` table with
      // the one trusted `PSModulePath`): no enabled/required/approval/timeout
      // keys, so nothing about the operator's other servers or approval posture
      // moves. The bare key is a fixed identifier; the value is one TOML string.
      const env = relayEnvironment === undefined
        ? ""
        : `,env={${WINDOWS_RELAY_MODULE_PATH_NAME}=${tomlBasicString(relayEnvironment.PSModulePath)}}`;
      const value = `{command=${tomlBasicString(entrypoints.nodeExecutable)},args=[${serverArgs.map(tomlBasicString).join(",")}]${env}}`;
      args = ["-c", `${CODEX_MCP_SERVERS_KEY}.${serverName}=${value}`];
      route = "codex-owned-backend-config";
      placement = "codex-owned-backend";
    }
    const staged = artifacts;
    return {
      mcp: "prepared",
      backend,
      route,
      placement,
      serverName,
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
