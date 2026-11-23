/**
 * #682: stdio relay entry for the hosted native MCP tool lane.
 *
 * A native Claude or Codex CLI launches this compiled module as its own MCP
 * stdio server child:
 *
 *     node <dist>/session-host/native-mcp-relay.js --bootstrap-file <path>
 *
 * The relay serves MCP over its own stdin/stdout through the existing
 * {@link NativeMcpStdioSession} adapter. That adapter's tool endpoint is a
 * broker-backed lane: one authenticated connection to the host's existing
 * local status broker (./broker, family ./native-mcp-protocol), which
 * delivers each validated operation to the trusted endpoint the host
 * registered for this launch. The relay is pure transport: it holds no tool
 * schemas, decides no ownership, authorizes no tool, and passes no client
 * identity or metadata beyond, on a Claude lane only, the one bounded tool-use
 * matching key the stdio adapter accepted (#682), which is never authority.
 *
 * Credential handling. Only the bootstrap file PATH appears in argv; the
 * token never appears in argv, the environment, stdout, stderr, or an
 * outcome. Before anything else the relay refuses to run when a delegated
 * worker-role marker is present. It then reads the bootstrap exactly once,
 * and only when:
 *
 * - the path is absolute and canonical, its parent is a real directory
 *   private to this user, and no component from `/` down to that parent can
 *   be replaced by another local user (the same walk as the broker socket
 *   check, {@link isProtectedNativeMcpSocketPath}), so the pathname cannot be
 *   swapped between validation, open, and unlink;
 * - the file is a regular file (never a symlink, FIFO, or device), has a
 *   single link, is owned by this user with no group/other bits (POSIX), is
 *   non-empty and at most {@link MAX_NATIVE_MCP_BOOTSTRAP_BYTES}, is opened
 *   without following links, and keeps the same identity across lstat, open,
 *   and read;
 * - its bytes are strict UTF-8 and exactly the canonical bootstrap encoding.
 *
 * A valid file is then consumed (unlinked after an identity re-check); if it
 * cannot be consumed the relay fails closed. An invalid file is left in place
 * for its owner's cleanup. None of this protects against other processes
 * running as the same user.
 *
 * Windows. Owner-only access cannot be read from Node's mode bits, so the
 * Windows reader proves it with the repository's EXISTING platform permission
 * policy ({@link createPeerStatePermissionPolicy}, the trusted DACL helper in
 * ./network/peer-state-windows-permissions) and nothing else: no new helper,
 * executable, configuration, or fallback; the policy's read-only ancestor
 * proof below reads the same descriptor evidence. Before the first file lookup the path must be a
 * canonical local (drive-letter, never UNC or device-namespace) absolute path,
 * and EVERY directory from the drive root down to the artifact parent above
 * the bootstrap's directory must be a real directory (never a symlink,
 * junction, or other reparse point) with an unchanged identity
 * ({@link proveWindowsNativeMcpAncestry}): the artifact parent itself passes
 * the existing `assertOwnerControlledDirectory` proof, and every higher,
 * already-existing component passes the policy's read-only
 * `assertReplacementProtectedAncestor` proof. The policy itself leaves
 * ancestry to its caller; this walk is what keeps the separate path-based
 * helper and filesystem lookups naming the same objects, because no untrusted
 * principal can remove, rename, or replace an existing entry anywhere along
 * that chain, nor add one to the artifact parent. The
 * bootstrap's own directory must then pass `assertPrivateDirectory` (the
 * same chain launch preparation established with `protectCreatedDirectory`);
 * and, after the same type, single-link, size, and identity checks as POSIX,
 * the file itself must pass `assertPrivateFile` before it is opened. Every
 * component, the drive root included, is proven: a chain the walk cannot prove
 * is refused, never assumed. A policy that cannot prove anything on this host (no
 * trusted helper) is `platform_unverifiable`; any other refusal is
 * `parent_invalid` or `file_invalid`. Every refusal leaves the file in place
 * unread. Because Windows can defer removing a deleted name, the Windows
 * reader consumes through an exclusive hard-link claim
 * ({@link WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}) rather than trusting its unlink.
 *
 * Endpoint trust. The hello carries the token in the relay's first write, so
 * on POSIX the relay first verifies (see {@link isProtectedNativeMcpSocketPath})
 * that no other local user could have replaced any component of the socket
 * path, and otherwise refuses (`unprotected`) without connecting. On Windows
 * the relay dials only the existing broker's generated local named pipe,
 * checked with the protocol's one canonical shape check
 * ({@link isNativeMcpLocalPipeAddress}); anything else (a filesystem path, a
 * remote `\\server\pipe\` name, another namespace) is `unprotected`
 * without connecting. The pipe keeps the broker's existing default access
 * control and token authentication; the relay adds no access policy of its
 * own.
 *
 * Transport truthfulness. The relay connects once with a bounded connect and
 * ready deadline and never reconnects. Each MCP request is sent at most once
 * and never retried. The results distinguish:
 *
 * - not sent (lane closed, request unencodable, or broker `busy`): a fixed
 *   tool error saying nothing ran;
 * - delivered and answered: forwarded as the endpoint answered;
 * - delivered, result too large: a fixed tool error saying effects may have
 *   been applied;
 * - delivered, endpoint failed, or the lane closed while the request was in
 *   flight: a rejection, which the stdio adapter answers with its fixed
 *   "effects are unknown, not retried" error.
 *
 * MCP cancellation aborts locally and sends one `native_mcp_cancel`; the
 * request stays counted until the broker answers or the lane closes. After
 * the lane closes the relay keeps answering MCP with "not sent" errors until
 * its input ends. Startup failures and abnormal stdio closures (anything but
 * a clean input end or intentional disposal) write one closed code to stderr
 * and exit nonzero; nothing else is ever written to stderr.
 */

import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve as resolvePath, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { EXECUTOR_TOOL_CATALOG_ENV, RUNTIME_ROLE_ENV } from "./launch";
import type { PeerStatePermissionPolicy } from "./network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy } from "./network/peer-state-permissions";
import { peerStorageRefusalDetail } from "./network/peer-storage-diagnostics";
import {
  MAX_NATIVE_MCP_BOOTSTRAP_BYTES,
  MAX_NATIVE_MCP_CONTROL_FRAME_BYTES,
  MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION,
  MAX_NATIVE_MCP_REQUEST_FRAME_BYTES,
  MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES,
  NativeMcpFrameReader,
  decodeNativeMcpBootstrap,
  decodeNativeMcpServerFrame,
  encodeNativeMcpClientFrame,
  encodeNativeMcpHello,
  isNativeMcpLocalPipeAddress,
  type NativeMcpBootstrap,
  type NativeMcpRequestFrame,
  type NativeMcpResponseFrame,
} from "./native-mcp-protocol";
import {
  NativeMcpStdioSession,
  isValidNativeMcpToolUseId,
  type NativeMcpCallToolRequest,
  type NativeMcpCallToolResult,
  type NativeMcpListToolsRequest,
  type NativeMcpStdioCloseReason,
  type NativeMcpToolDescriptor,
  type NativeMcpToolEndpoint,
} from "./native-mcp-stdio";

/** The only accepted argv shape is exactly this flag followed by one absolute path. */
export const NATIVE_MCP_RELAY_BOOTSTRAP_FLAG = "--bootstrap-file";

/**
 * Suffix of the fixed Windows consumption claim in each launch directory (see
 * {@link windowsNativeMcpClaimPath}). Creating a hard link at that fixed name
 * fails when it already exists, so exactly one reader can own it; it names
 * the same protected file (no second DACL, no byte copy), and lease cleanup
 * knows the one name to check after an interrupted consumption.
 */
export const WINDOWS_NATIVE_MCP_CLAIM_SUFFIX = ".prg-consume-claim";

/** The fixed bootstrap file name launch preparation stages in each private launch directory. */
export const NATIVE_MCP_BOOTSTRAP_FILE_NAME = "native-mcp-bootstrap.json";

/**
 * The one Windows claim slot for a launch directory: a fixed sibling name,
 * never derived from the supplied file name. On a volume with 8.3 names a
 * long name and its short alias reach the same single-link file; a claim
 * keyed by the spelling would give each its own claim and both readers back
 * the deletion race. Keyed by the directory, every spelling contends for the
 * same claim, and lease cleanup checks that same path.
 */
export function windowsNativeMcpClaimPath(bootstrapPath: string): string {
  return join(dirname(bootstrapPath), `${NATIVE_MCP_BOOTSTRAP_FILE_NAME}${WINDOWS_NATIVE_MCP_CLAIM_SUFFIX}`);
}

/** Upper bound for establishing the broker connection. */
export const NATIVE_MCP_RELAY_CONNECT_TIMEOUT_MS = 2000;

/** Upper bound for the broker's `ready` after the hello (the broker's own auth deadline is 2 s). */
export const NATIVE_MCP_RELAY_READY_TIMEOUT_MS = 2500;

/**
 * Upper bound for flushing output already accepted by stdout before the
 * process exits. A client that never reads cannot hold the relay alive.
 */
export const NATIVE_MCP_RELAY_FLUSH_TIMEOUT_MS = 5000;

/** Fixed MCP serverInfo; it carries no host, row, or launch identity. */
export const NATIVE_MCP_RELAY_SERVER_INFO = Object.freeze({ name: "pi-review-gate", version: "1" });

/** Unflushed request bytes the relay may hold toward the broker before refusing new requests as not sent. */
const MAX_RELAY_PENDING_OUTBOUND_BYTES = 2 * MAX_NATIVE_MCP_REQUEST_FRAME_BYTES;

const MAX_BOOTSTRAP_PATH_BYTES = 4096;

const NOT_SENT_CLOSED = "The host tool connection is closed; the call was not sent and nothing ran.";
const NOT_SENT_UNENCODABLE = "The call could not be encoded for the host transport; it was not sent and nothing ran.";
const NOT_SENT_BUSY = "The host is busy; the call was not run.";
const RESULT_WITHHELD = "Tool result withheld: it exceeded the host transport limit. The call was not retried and its effects may have been applied.";

export type NativeMcpBootstrapFileFailure =
  | "platform_unverifiable"
  | "path_invalid"
  | "parent_invalid"
  | "file_invalid"
  | "read_failed"
  | "record_invalid"
  | "consume_failed";

export type NativeMcpBootstrapFileResult =
  | { readonly ok: true; readonly bootstrap: NativeMcpBootstrap }
  | { readonly ok: false; readonly reason: NativeMcpBootstrapFileFailure };

export interface NativeMcpBootstrapFileOptions {
  /**
   * Focused-test seam for the ancestry walk only (it can describe a tree the
   * test cannot build); every file-level check, open, and unlink always uses
   * the real filesystem. Production never passes it.
   */
  readonly ancestryLstat?: (path: string) => NativeMcpPathStats;
  /**
   * Platform selection; defaults to the running platform. Selecting `win32`
   * selects the Windows reader, whose protection proof is the platform
   * permission policy below.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Test seam for the Windows protection proof only. Production passes nothing
   * and the reader uses {@link createPeerStatePermissionPolicy} for the
   * selected platform (on Windows: the existing trusted DACL helper). Ignored
   * on POSIX, whose proof is the ancestry walk and the owner/mode checks.
   */
  readonly permissions?: PeerStatePermissionPolicy;
  /**
   * Test seam only: runs on the Windows reader after the record was read and
   * decoded and immediately before the exclusive claim, so a test can stand in
   * for a concurrent relay. Production passes nothing; ignored on POSIX.
   */
  readonly beforeWindowsClaim?: () => void;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid(): bigint | undefined {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
}

function privateOwned(stats: BigIntStats, uid: bigint | undefined): boolean {
  return uid !== undefined && stats.uid === uid && (stats.mode & 0o077n) === 0n;
}

/**
 * Reads, validates, and consumes one private per-launch bootstrap file. Never
 * throws; every failure is a closed reason that carries no file content.
 */
export function readNativeMcpBootstrapFile(
  path: string,
  options: NativeMcpBootstrapFileOptions = {},
): NativeMcpBootstrapFileResult {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return readWindowsBootstrapFile(path, options.permissions ?? createPeerStatePermissionPolicy({ platform }), options.beforeWindowsClaim);
  }
  if (!isBoundedAbsoluteBootstrapPath(path)) return { ok: false, reason: "path_invalid" };
  const uid = currentUid();
  // Before the first file lookup: every directory component must be a real,
  // root/self-owned directory that no other local user can replace, ending in
  // a private parent. Only then do the separate lstat/open/unlink lookups
  // below all name the same file.
  if (uid === undefined || !isProtectedNativeMcpPath(path, { uid, lstat: options.ancestryLstat })) {
    return { ok: false, reason: "parent_invalid" };
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    return { ok: false, reason: "file_invalid" };
  }
  if (!isSingleBoundedRegularFile(before) || !privateOwned(before, uid)) {
    return { ok: false, reason: "file_invalid" };
  }
  return readAndConsumeBootstrap(path, before);
}

function isBoundedAbsoluteBootstrapPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.includes("\0") && isAbsolute(path)
    && Buffer.byteLength(path, "utf8") <= MAX_BOOTSTRAP_PATH_BYTES;
}

/** Regular (never a symlink, FIFO, or device), single-link, non-empty, and bounded. */
function isSingleBoundedRegularFile(stats: BigIntStats): boolean {
  return stats.isFile() && stats.nlink === 1n && stats.size >= 1n && stats.size <= BigInt(MAX_NATIVE_MCP_BOOTSTRAP_BYTES);
}

/**
 * True for a canonical local absolute path in this host's own path flavor:
 * absolute, already resolved, bounded, free of control characters, and — so a
 * Windows path can only name a local drive object — never a UNC (`\\server`)
 * or device-namespace (`\\?\`, `\\.\`) path. Shared with launch
 * preparation, which stages exactly such a path.
 *
 * On Windows the spelling must also be unambiguous: Node's filesystem calls
 * address names literally, while the existing DACL helper hands the ordinary
 * path to .NET, which normalizes it. A component with a trailing dot or space,
 * a reserved device name (`NUL`, `COM1`, …), or a stream/wildcard character
 * could therefore make the helper prove a different object than the one Node
 * stages or consumes, and Node's own before/after identity checks would not
 * notice. Such paths are refused before any policy call. `platform` selects
 * the spelling rule (default: this host's).
 */
export function isCanonicalLocalNativeMcpPath(path: unknown, platform: NodeJS.Platform = process.platform): path is string {
  if (platform === "win32") {
    // Node filesystem calls and the DACL helper must interpret the same name.
    if (typeof path !== "string" || !/^[A-Za-z]:\\/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)
      || Buffer.byteLength(path, "utf8") > MAX_BOOTSTRAP_PATH_BYTES || win32.resolve(path) !== path) return false;
    return path.slice(3).split("\\").every((part) =>
      !/[<>:"\/|?*]|[. ]$/u.test(part)
      && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/iu.test(part.split(".", 1)[0]!.trimEnd()));
  }
  if (!isBoundedAbsoluteBootstrapPath(path) || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  if (path.startsWith("\\\\") || path.startsWith("//") || path.startsWith("\\/") || path.startsWith("/\\")) return false;
  return resolvePath(path) === path;
}

/** One existing platform-policy proof; the policy's own refusal class, or `undefined` on success. */
function policyRefusal(check: () => void): "unsupported" | "refused" | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return peerStorageRefusalDetail(error)?.reason === "protection-unsupported" ? "unsupported" : "refused";
  }
}

/**
 * Proves, with the EXISTING platform permission policy only, that no
 * untrusted principal can replace any component of `directory`'s path:
 * walking from the drive root down to `directory` itself, each component must
 * be a real directory (`lstat` never follows a symlink or junction), must pass
 * its policy proof, and must still be the same directory after that proof.
 * Top-down order means each component is proved only after its parent proved
 * that its existing entries cannot be replaced.
 *
 * Two rules, by role. `directory` itself — the immediate artifact parent, in
 * which a private root is created — must pass the unchanged
 * `assertOwnerControlledDirectory` (current-account authority; any reparse
 * point and any untrusted write, append, delete, delete-child, permission, or
 * ownership right, inherit-only included, refuses). Every higher component —
 * the drive root included — already exists, nothing is ever created in it,
 * and it only has to be protected against replacement, so it must pass the
 * policy's read-only `assertReplacementProtectedAncestor` (an OS-owned drive
 * root or profiles directory qualifies; a reparse point and any untrusted
 * replacement, delete, permission, ownership, or unknown right still refuse).
 * A policy without that proof gets the stricter owner-controlled rule there
 * too. Nothing is assumed for any component. `directory` must be a canonical
 * local absolute path. Never throws: `unsupported` when the policy cannot
 * prove anything on this host, `refused` for anything else.
 */
export function proveWindowsNativeMcpAncestry(
  directory: string,
  permissions: PeerStatePermissionPolicy,
): "proven" | "unsupported" | "refused" {
  if (!isCanonicalLocalNativeMcpPath(directory)) return "refused";
  const components: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    components.push(current);
    if (dirname(current) === current) break;
  }
  components.reverse();
  for (const component of components) {
    let before: BigIntStats;
    try {
      before = lstatSync(component, { bigint: true });
    } catch {
      return "refused";
    }
    if (before.isSymbolicLink() || !before.isDirectory()) return "refused";
    // Method selection stays inside the refusal wrapper: a policy whose lookup
    // throws is a closed refusal, never an escaped exception.
    const refusal = policyRefusal(() => {
      if (component === directory) return permissions.assertOwnerControlledDirectory(component);
      if (typeof permissions.assertReplacementProtectedAncestor === "function") {
        return permissions.assertReplacementProtectedAncestor(component);
      }
      return permissions.assertOwnerControlledDirectory(component);
    });
    if (refusal !== undefined) return refusal;
    try {
      const after = lstatSync(component, { bigint: true });
      if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) return "refused";
    } catch {
      return "refused";
    }
  }
  return "proven";
}

/**
 * The Windows reader: the same file-level rules as POSIX, with owner-only
 * access proven by the existing platform permission policy instead of mode
 * bits. The chain is the one launch preparation established — a
 * non-replaceable owner-controlled ancestry down to the artifact parent, a
 * private bootstrap directory, a private bootstrap file — and every proof
 * runs before the file is opened.
 */
function readWindowsBootstrapFile(
  path: string,
  permissions: PeerStatePermissionPolicy,
  beforeClaim?: () => void,
): NativeMcpBootstrapFileResult {
  // A claim name is never itself a bootstrap.
  if (!isCanonicalLocalNativeMcpPath(path) || path.toLowerCase().endsWith(WINDOWS_NATIVE_MCP_CLAIM_SUFFIX)) {
    return { ok: false, reason: "path_invalid" };
  }
  const parent = dirname(path);
  const artifactParent = dirname(parent);
  if (parent === path || artifactParent === parent) return { ok: false, reason: "parent_invalid" };
  const ancestry = proveWindowsNativeMcpAncestry(artifactParent, permissions);
  if (ancestry !== "proven") {
    return { ok: false, reason: ancestry === "unsupported" ? "platform_unverifiable" : "parent_invalid" };
  }
  let parentBefore: BigIntStats;
  try {
    parentBefore = lstatSync(parent, { bigint: true });
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return { ok: false, reason: "parent_invalid" };
  } catch {
    return { ok: false, reason: "parent_invalid" };
  }
  const parentRefusal = policyRefusal(() => permissions.assertPrivateDirectory(parent));
  if (parentRefusal !== undefined) {
    return { ok: false, reason: parentRefusal === "unsupported" ? "platform_unverifiable" : "parent_invalid" };
  }
  try {
    const parentAfter = lstatSync(parent, { bigint: true });
    if (parentAfter.isSymbolicLink() || !parentAfter.isDirectory() || !sameIdentity(parentBefore, parentAfter)) {
      return { ok: false, reason: "parent_invalid" };
    }
  } catch {
    return { ok: false, reason: "parent_invalid" };
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    return { ok: false, reason: "file_invalid" };
  }
  if (!isSingleBoundedRegularFile(before)) return { ok: false, reason: "file_invalid" };
  const fileRefusal = policyRefusal(() => permissions.assertPrivateFile(path));
  if (fileRefusal !== undefined) {
    return { ok: false, reason: fileRefusal === "unsupported" ? "platform_unverifiable" : "file_invalid" };
  }
  return readAndConsumeBootstrap(path, before, (): boolean => {
    beforeClaim?.();
    return consumeWindowsBootstrap(path, before);
  });
}

/**
 * The Windows consumption: an exclusive claim, then removal. Windows can defer
 * removing a deleted name until the deleting handle closes, so two readers
 * that both read the record could each see their own delete succeed; a
 * successful unlink therefore proves nothing about being the only consumer.
 * Instead the reader first creates a hard link at the launch directory's
 * fixed claim path ({@link windowsNativeMcpClaimPath}),
 * which fails when that name already exists (another reader holds the claim)
 * or when the bootstrap is gone or pending deletion (another reader already
 * consumed it). Only the one claim holder removes the bootstrap and then its
 * claim; it returns true only when both names were removed while still naming
 * the inode that was read. An interrupted claim is left for lease cleanup,
 * which removes it only when it is still a link to the recorded bootstrap.
 */
function consumeWindowsBootstrap(path: string, before: BigIntStats): boolean {
  const claim = windowsNativeMcpClaimPath(path);
  try {
    linkSync(path, claim);
  } catch {
    return false;
  }
  let removed = false;
  try {
    if (sameIdentity(before, lstatSync(claim, { bigint: true }))
      && sameIdentity(before, lstatSync(path, { bigint: true }))) {
      unlinkSync(path);
      removed = true;
    }
  } catch {
    // No token is returned on a failed source removal.
  }
  try {
    if (!sameIdentity(before, lstatSync(claim, { bigint: true }))) return false;
    unlinkSync(claim);
  } catch {
    // The lease removes a still-present claim with the recorded identity.
    return false;
  }
  return removed;
}

/**
 * Shared tail of both readers, entered only after every protection proof for
 * `path` passed against the entry observed as `before`: open without following
 * links, require the same identity and size, read at most the bound, decode
 * the canonical record, then consume exactly the inode that was read. The read
 * descriptor is closed before the unlink, so no handle of this reader is ever
 * open across the consumption (Windows defers deleting an open file). POSIX
 * consumes with an identity-checked unlink; the Windows reader passes
 * `consume`, its exclusive claim ({@link consumeWindowsBootstrap}).
 */
function readAndConsumeBootstrap(
  path: string,
  before: BigIntStats,
  consume?: () => boolean,
): NativeMcpBootstrapFileResult {
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    // No-follow and non-blocking, so a swapped-in symlink or FIFO can neither
    // redirect nor hang the read.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) return { ok: false, reason: "file_invalid" };
    const buffer = Buffer.alloc(MAX_NATIVE_MCP_BOOTSTRAP_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_NATIVE_MCP_BOOTSTRAP_BYTES) return { ok: false, reason: "file_invalid" };
    }
    if (BigInt(total) !== before.size) return { ok: false, reason: "file_invalid" };
    bytes = buffer.subarray(0, total);
  } catch {
    return { ok: false, reason: "read_failed" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read outcome is already decided.
      }
    }
  }
  let text: string;
  try {
    // Keep a leading BOM so the canonical comparison refuses it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "record_invalid" };
  }
  const bootstrap = decodeNativeMcpBootstrap(text);
  if (!bootstrap) return { ok: false, reason: "record_invalid" };
  if (consume !== undefined) return consume() ? { ok: true, bootstrap } : { ok: false, reason: "consume_failed" };
  // Read once: remove exactly the inode that was read, or fail closed.
  try {
    const after = lstatSync(path, { bigint: true });
    if (!sameIdentity(before, after)) return { ok: false, reason: "consume_failed" };
    unlinkSync(path);
  } catch {
    return { ok: false, reason: "consume_failed" };
  }
  return { ok: true, bootstrap };
}

/** True when any casing of a delegated worker-role marker is present, whatever its value. */
export function hasNativeMcpWorkerRoleMarker(env: NodeJS.ProcessEnv): boolean {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === RUNTIME_ROLE_ENV || upper === EXECUTOR_TOOL_CATALOG_ENV) return true;
  }
  return false;
}

type LaneResponse =
  | { readonly kind: "response"; readonly frame: NativeMcpResponseFrame }
  | { readonly kind: "not_sent"; readonly reason: "closed" | "unencodable" | "busy" }
  | { readonly kind: "lost" };

/** Thrown into the stdio adapter for a delivered-but-unknown outcome; its message never reaches the client. */
class NativeMcpLaneOutcomeUnknown extends Error {}

/**
 * The broker-backed endpoint behind the stdio adapter: one authenticated
 * connection, strictly increasing request seqs, at most one send per
 * request, and no reconnect.
 */
export class NativeMcpBrokerLane implements NativeMcpToolEndpoint {
  /** Settles once when the lane closes for any reason. */
  readonly closed: Promise<void>;
  readonly #socket: Socket;
  readonly #reader = new NativeMcpFrameReader(MAX_NATIVE_MCP_RESPONSE_FRAME_BYTES);
  readonly #pending = new Map<number, (response: LaneResponse) => void>();
  #nextSeq = 1;
  #closedFlag = false;
  #resolveClosed!: () => void;
  /** #682: forward the Claude tool-use matching key only on an authenticated Claude lane. */
  readonly #forwardClaudeToolUseId: boolean;

  /**
   * Takes ownership of a socket on which `ready` was already received and nothing
   * else. `forwardClaudeToolUseId` is true only when the authenticated bootstrap's
   * backend is Claude; every other lane sends exactly the frames it always did.
   */
  constructor(socket: Socket, forwardClaudeToolUseId = false) {
    this.#socket = socket;
    this.#forwardClaudeToolUseId = forwardClaudeToolUseId === true;
    this.closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    socket.on("end", () => this.close());
    if (socket.destroyed) queueMicrotask(() => this.close());
  }

  get isClosed(): boolean {
    return this.#closedFlag;
  }

  /** Requests whose broker answer has not arrived. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Closes the lane; every in-flight request becomes an unknown outcome. */
  close(): void {
    if (this.#closedFlag) return;
    this.#closedFlag = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    try {
      this.#socket.destroy();
    } catch {
      // Already closing.
    }
    for (const settle of pending) settle({ kind: "lost" });
    this.#resolveClosed();
  }

  async listTools(request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    const response = await this.#request((seq) => ({ version: 1, type: "native_mcp_request", seq, op: "list" }), request.signal);
    if (response.kind === "response" && response.frame.outcome === "result" && Array.isArray(response.frame.result.tools)) {
      // The stdio adapter applies the generic tool shape check.
      return response.frame.result.tools as NativeMcpToolDescriptor[];
    }
    throw new NativeMcpLaneOutcomeUnknown("tool list unavailable");
  }

  async callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    const { name, signal } = request;
    const args = request.arguments;
    // The one bounded tool-use matching key (#682) crosses only on a Claude lane
    // and only when the stdio adapter accepted it; it is never authority.
    const toolUseId = this.#forwardClaudeToolUseId && isValidNativeMcpToolUseId(request.toolUseId)
      ? request.toolUseId
      : undefined;
    const response = await this.#request(
      (seq) => ({
        version: 1,
        type: "native_mcp_request",
        seq,
        op: "call",
        name,
        arguments: args,
        ...(toolUseId === undefined ? {} : { toolUseId }),
      }),
      signal,
    );
    if (response.kind === "not_sent") {
      const text = response.reason === "closed" ? NOT_SENT_CLOSED : response.reason === "busy" ? NOT_SENT_BUSY : NOT_SENT_UNENCODABLE;
      return { content: [{ type: "text", text }], isError: true };
    }
    if (response.kind === "lost") throw new NativeMcpLaneOutcomeUnknown("lane closed with the call in flight");
    const frame = response.frame;
    if (frame.outcome === "result") return frame.result as unknown as NativeMcpCallToolResult;
    switch (frame.code) {
      case "unknown_tool":
        return undefined;
      case "busy":
        return { content: [{ type: "text", text: NOT_SENT_BUSY }], isError: true };
      case "result_too_large":
        return { content: [{ type: "text", text: RESULT_WITHHELD }], isError: true };
      default:
        throw new NativeMcpLaneOutcomeUnknown("endpoint failed");
    }
  }

  #request(build: (seq: number) => NativeMcpRequestFrame, signal: AbortSignal): Promise<LaneResponse> {
    if (this.#closedFlag || this.#socket.destroyed) return Promise.resolve({ kind: "not_sent", reason: "closed" });
    if (signal.aborted) return Promise.resolve({ kind: "not_sent", reason: "closed" });
    // The per-lane bound holds at this endpoint boundary for every caller, not
    // only behind the stdio adapter: refused before a seq is used or a byte sent.
    if (this.#pending.size >= MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION) return Promise.resolve({ kind: "not_sent", reason: "busy" });
    const seq = this.#nextSeq;
    let line: string;
    try {
      line = encodeNativeMcpClientFrame(build(seq));
    } catch {
      return Promise.resolve({ kind: "not_sent", reason: "unencodable" });
    }
    if (this.#socket.writableLength + Buffer.byteLength(line, "utf8") > MAX_RELAY_PENDING_OUTBOUND_BYTES) {
      return Promise.resolve({ kind: "not_sent", reason: "busy" });
    }
    this.#nextSeq += 1;
    return new Promise<LaneResponse>((resolve) => {
      const onAbort = (): void => {
        // One cancel per request; the request stays pending until answered.
        if (!this.#closedFlag && this.#pending.has(seq)) this.#send(encodeNativeMcpClientFrame({ version: 1, type: "native_mcp_cancel", seq }));
      };
      this.#pending.set(seq, (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      // From here on the request may have been delivered: a failure is "lost", never "not sent".
      this.#send(line);
    });
  }

  #send(line: string): void {
    if (this.#closedFlag) return;
    try {
      // UTF-8 bytes, never a string, so `writableLength` (checked before each
      // request) is measured in the same unit as the request cap.
      this.#socket.write(Buffer.from(line, "utf8"));
    } catch {
      this.close();
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#closedFlag) return;
    const result = this.#reader.push(chunk, (line) => this.#onLine(line));
    if (result === "overflow" || result === "invalid_utf8") this.close();
  }

  #onLine(line: string): boolean {
    const frame = decodeNativeMcpServerFrame(line);
    if (!frame || frame.type !== "native_mcp_response") {
      this.close();
      return false;
    }
    const settle = this.#pending.get(frame.seq);
    if (!settle) {
      // An uncorrelated or duplicate answer means the stream is untrustworthy.
      this.close();
      return false;
    }
    this.#pending.delete(frame.seq);
    settle({ kind: "response", frame });
    return !this.#closedFlag;
  }
}

/**
 * `unprotected`: the POSIX socket path could be replaced by another local
 * user, so the hello (which carries the bearer token) was never sent.
 */
export type NativeMcpLaneOpenFailure = "unprotected" | "unreachable" | "refused" | "timeout" | "protocol";

/** The stat fields the socket-path walk reads; injectable for focused tests. */
export interface NativeMcpPathStats {
  readonly uid: bigint;
  readonly mode: bigint;
  isDirectory(): boolean;
  isSocket(): boolean;
}

export interface NativeMcpSocketPathCheckOptions {
  /** No-follow stat; defaults to `lstatSync(path, { bigint: true })`. */
  readonly lstat?: (path: string) => NativeMcpPathStats;
  /** Defaults to this process's uid. */
  readonly uid?: bigint;
}

/**
 * True only when no other local user can replace any component of a POSIX
 * broker socket path, so the token-bearing hello can only reach a socket this
 * user (or root) put there. Walking from `/` down to the socket's directory:
 *
 * - every component must be a real directory (never a symlink), owned by
 *   root or this user;
 * - a component must not sit in a parent that is group/other-writable unless
 *   that parent is sticky (others cannot rename entries they do not own) or an
 *   ancestor already shields it: once a component owned by this user grants
 *   no group/other permission at all, other users cannot search into it, so
 *   nothing beneath it can be renamed or replaced by them;
 * - the socket's own directory must be private to this user, and the socket
 *   must be a socket owned by this user.
 *
 * Root and this user are trusted by construction. Never throws.
 */
export function isProtectedNativeMcpSocketPath(socketPath: string, options: NativeMcpSocketPathCheckOptions = {}): boolean {
  return isProtectedNativeMcpPath(socketPath, options, (leaf, uid) => leaf.isSocket() && leaf.uid === uid);
}

/**
 * The shared root-to-parent walk behind both the socket check and the
 * bootstrap reader; `checkLeaf` adds the leaf rule (the reader applies its own
 * file-level checks afterwards). Never throws.
 */
function isProtectedNativeMcpPath(
  filePath: string,
  options: NativeMcpSocketPathCheckOptions,
  checkLeaf?: (leaf: NativeMcpPathStats, uid: bigint) => boolean,
): boolean {
  const uid = options.uid ?? currentUid();
  const lstat = options.lstat ?? ((path: string): NativeMcpPathStats => lstatSync(path, { bigint: true }));
  if (uid === undefined || typeof filePath !== "string" || !isAbsolute(filePath) || resolvePath(filePath) !== filePath) return false;
  const directories: string[] = [];
  for (let dir = dirname(filePath); ; dir = dirname(dir)) {
    directories.push(dir);
    if (dirname(dir) === dir) break;
  }
  directories.reverse();
  try {
    let parent: NativeMcpPathStats | undefined;
    let shielded = false;
    for (const dir of directories) {
      const stats = lstat(dir);
      if (!stats.isDirectory() || (stats.uid !== 0n && stats.uid !== uid)) return false;
      if (!shielded && parent && (parent.mode & 0o022n) !== 0n && (parent.mode & 0o1000n) === 0n) return false;
      if (stats.uid === uid && (stats.mode & 0o077n) === 0n) shielded = true;
      parent = stats;
    }
    if (!parent || parent.uid !== uid || (parent.mode & 0o077n) !== 0n) return false;
    return checkLeaf === undefined || checkLeaf(lstat(filePath), uid);
  } catch {
    return false;
  }
}

export interface NativeMcpLaneOpenOptions {
  readonly connect?: (socketPath: string) => Socket;
  readonly connectMs?: number;
  readonly readyMs?: number;
  /** Endpoint-trust rule selection; defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * True only when the token-bearing hello may be sent to `socketPath` on
 * `platform`: on Windows, exactly the existing broker's generated local named
 * pipe ({@link isNativeMcpLocalPipeAddress}); on POSIX, a socket path no other
 * local user can replace ({@link isProtectedNativeMcpSocketPath}). Never
 * throws.
 */
export function isExpectedNativeMcpBrokerEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? isNativeMcpLocalPipeAddress(socketPath) : isProtectedNativeMcpSocketPath(socketPath);
}

/**
 * Opens and authenticates one lane: connect (bounded), send the hello, and
 * wait (bounded) for exactly one `ready` with no trailing bytes. A broker
 * refusal is a silent close, reported only as `refused`.
 */
export function openNativeMcpBrokerLane(
  bootstrap: NativeMcpBootstrap,
  options: NativeMcpLaneOpenOptions = {},
): Promise<{ readonly ok: true; readonly lane: NativeMcpBrokerLane } | { readonly ok: false; readonly reason: NativeMcpLaneOpenFailure }> {
  // The hello carries the bearer token in its first write, before any broker
  // reply could prove anything: on POSIX, never connect to a path another
  // local user could have replaced; on Windows, never dial anything but the
  // existing broker's generated local named pipe.
  if (!isExpectedNativeMcpBrokerEndpoint(bootstrap.socketPath, options.platform ?? process.platform)) {
    return Promise.resolve({ ok: false, reason: "unprotected" });
  }
  let hello: string;
  try {
    hello = encodeNativeMcpHello(bootstrap);
  } catch {
    return Promise.resolve({ ok: false, reason: "protocol" });
  }
  let socket: Socket;
  try {
    socket = options.connect?.(bootstrap.socketPath) ?? createConnection({ path: bootstrap.socketPath });
  } catch {
    return Promise.resolve({ ok: false, reason: "unreachable" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let received = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("connect", onConnect);
    };
    const fail = (reason: NativeMcpLaneOpenFailure): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.on("error", ignore);
      try {
        socket.destroy();
      } catch {
        // The outcome is already decided.
      }
      resolve({ ok: false, reason });
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      if (received.length + chunk.length > MAX_NATIVE_MCP_CONTROL_FRAME_BYTES) {
        fail("protocol");
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== received.length - 1) {
        // Nothing may follow `ready` before the relay sends a request.
        fail("protocol");
        return;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(received.subarray(0, newline));
      } catch {
        fail("protocol");
        return;
      }
      const frame = decodeNativeMcpServerFrame(text);
      if (!frame || frame.type !== "native_mcp_ready") {
        fail("protocol");
        return;
      }
      settled = true;
      cleanup();
      resolve({ ok: true, lane: new NativeMcpBrokerLane(socket, bootstrap.backend === "claude") });
    };
    const onError = (): void => fail(connected ? "refused" : "unreachable");
    const onClose = (): void => fail(connected ? "refused" : "unreachable");
    const onConnect = (): void => {
      if (settled) return;
      connected = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail("timeout"), options.readyMs ?? NATIVE_MCP_RELAY_READY_TIMEOUT_MS);
      timer.unref?.();
      try {
        socket.write(hello);
      } catch {
        fail("refused");
      }
    };
    try {
      socket.setNoDelay?.(true);
    } catch {
      // Optional transport tuning only.
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", onConnect);
    timer = setTimeout(() => fail("unreachable"), options.connectMs ?? NATIVE_MCP_RELAY_CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
}

export type NativeMcpRelayStartupFailure =
  | "worker_role"
  | "usage"
  | "bootstrap_invalid"
  | NativeMcpLaneOpenFailure
  | "error";

/** Observed relay outcome; it never carries a token, path, request, or result. */
export type NativeMcpRelayOutcome =
  | { readonly status: "ended"; readonly reason: NativeMcpStdioCloseReason; readonly laneClosedFirst: boolean }
  | { readonly status: NativeMcpRelayStartupFailure };

/** Injectable seams for focused tests; production uses process argv/env/stdio and net.connect. */
export interface NativeMcpRelayOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly connect?: (socketPath: string) => Socket;
  readonly timeouts?: { readonly connectMs?: number; readonly readyMs?: number };
  /** Platform selection for both the bootstrap reader and the endpoint-trust rule. */
  readonly platform?: NodeJS.Platform;
  /** Test seam for the Windows bootstrap protection proof; production passes nothing. */
  readonly permissions?: PeerStatePermissionPolicy;
  /** Observes the started session and lane (the process entry uses it for signal handling). */
  readonly onStarted?: (session: NativeMcpStdioSession, lane: NativeMcpBrokerLane) => void;
}

/**
 * Runs one relay: refuse worker roles, read the bootstrap once, open the lane,
 * then serve MCP stdio until the input ends or the session closes. The lane
 * is closed when the session ends.
 */
export async function runNativeMcpRelay(options: NativeMcpRelayOptions = {}): Promise<NativeMcpRelayOutcome> {
  try {
    if (hasNativeMcpWorkerRoleMarker(options.env ?? process.env)) return { status: "worker_role" };
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== NATIVE_MCP_RELAY_BOOTSTRAP_FLAG || typeof argv[1] !== "string") return { status: "usage" };
    const read = readNativeMcpBootstrapFile(argv[1], { platform: options.platform, permissions: options.permissions });
    if (!read.ok) return { status: "bootstrap_invalid" };
    const opened = await openNativeMcpBrokerLane(read.bootstrap, {
      platform: options.platform,
      connect: options.connect,
      connectMs: options.timeouts?.connectMs,
      readyMs: options.timeouts?.readyMs,
    });
    if (!opened.ok) return { status: opened.reason };
    const lane = opened.lane;
    let laneClosedFirst = false;
    let sessionClosed = false;
    void lane.closed.then(() => { if (!sessionClosed) laneClosedFirst = true; });
    let session: NativeMcpStdioSession;
    try {
      session = new NativeMcpStdioSession({
        input: options.input ?? process.stdin,
        output: options.output ?? process.stdout,
        endpoint: lane,
        serverInfo: { ...NATIVE_MCP_RELAY_SERVER_INFO },
        limits: { maxInFlightRequests: MAX_NATIVE_MCP_IN_FLIGHT_PER_CONNECTION },
      });
    } catch {
      lane.close();
      return { status: "error" };
    }
    options.onStarted?.(session, lane);
    const reason = await session.closed;
    sessionClosed = true;
    lane.close();
    return { status: "ended", reason, laneClosedFirst };
  } catch {
    return { status: "error" };
  }
}

function ignore(): void {}

/**
 * Resolves true once every byte already accepted by `stream` has been handed
 * to the operating system. Writes are flushed in order, so an empty write's
 * callback is the barrier. Resolves false on a stream error, a stream that
 * can no longer write while bytes are still pending, or the deadline; nothing
 * is ever rewritten or retried.
 */
export function flushNativeMcpOutput(stream: Writable, timeoutMs: number = NATIVE_MCP_RELAY_FLUSH_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (flushed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.off("error", onError);
      stream.on("error", ignore);
      resolve(flushed);
    };
    const onError = (): void => finish(false);
    if (!stream.writable) {
      finish(stream.writableLength === 0 && !stream.errored);
      return;
    }
    stream.on("error", onError);
    // Deliberately referenced: a pending promise and a stuck stream do not keep
    // Node alive, so this deadline must, until finish() clears it on every path.
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      stream.write("", (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

/** Writes one closed code to stderr (when given), flushes stdout and stderr, then exits. */
async function exitAfterFlush(code: number, closedCode?: string): Promise<never> {
  let exitCode = code;
  if (closedCode !== undefined) {
    try {
      process.stderr.write(`pi-review-gate native MCP relay: ${closedCode}\n`);
    } catch {
      // Nothing else may be written; the exit code still reports the failure.
    }
  }
  // A reply already handed to stdout must not be cut short by exit; failing
  // to flush it is never reported as a clean exit.
  if (!(await flushNativeMcpOutput(process.stdout))) exitCode = exitCode === 0 ? 1 : exitCode;
  await flushNativeMcpOutput(process.stderr);
  process.exit(exitCode);
}

/**
 * The provider CLI runs this compiled module as its MCP stdio server. When the
 * session ends the broker lane is closed at once (aborting any in-flight
 * request), then output already accepted by stdout is flushed (bounded). The
 * process exits zero only after a clean closure (input end, or SIGTERM/SIGINT
 * disposal) AND a successful flush. An abnormal closure (output failure or
 * overflow, invalid encoding, oversized frame, unsendable reply) may have
 * dropped replies the flush cannot recover, so, like a startup failure, it
 * writes one fixed code to stderr and exits nonzero.
 */
if (require.main === module) {
  let started: NativeMcpStdioSession | undefined;
  const stop = (): void => {
    if (started) started.dispose();
    else void exitAfterFlush(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  void runNativeMcpRelay({ onStarted: (session) => { started = session; } }).then(
    (outcome) => {
      if (outcome.status !== "ended") return exitAfterFlush(1, outcome.status);
      if (outcome.reason === "input_ended" || outcome.reason === "disposed") return exitAfterFlush(0);
      return exitAfterFlush(1, outcome.reason);
    },
    () => exitAfterFlush(1, "error"),
  );
}
