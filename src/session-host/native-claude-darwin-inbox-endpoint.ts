/**
 * #682: macOS (Darwin) endpoint proof for one announced native Claude inbox
 * socket.
 *
 * Status: used only by the shared sender (./native-claude-inbox-delivery) for
 * a Darwin capability: once by the host before it mints that capability, and
 * again before connect and after connect (before the first byte) of every
 * send. The Linux namespace rule (`CLAUDE_INBOX_SUPPORTED_PLATFORMS`) is not
 * widened by it. Importing it spawns nothing, touches no file, and starts no
 * timer.
 *
 * Why macOS needs more than the Linux rule: Darwin directory and file ACLs
 * can grant child creation (`add_file`), entry deletion (`delete_child`), or
 * deletion of the object itself (`delete`) independently of the mode bits. A
 * socket whose namespace looks protected by mode and owner alone may still be
 * replaceable by another account. So the proof requires BOTH:
 *
 * 1. The Linux mode/owner/sticky rule on every actual canonical ancestor:
 *    each is a real directory (no symlink) owned by root or the current user,
 *    and a group/world-writable ancestor is sticky with a child entry owned by
 *    root or the current user. The socket itself is a socket owned by the
 *    current user (and, when the host captured one, the exact dev/ino/uid).
 * 2. Complete, conservative ACL evidence for every object whose entry could
 *    be replaced: `/`, every canonical ancestor, the fixed alias symlink when
 *    one was used, and the socket itself (an `allow delete` on the socket lets
 *    another account unlink it). Evidence comes from a bounded asynchronous
 *    child of the fixed absolute `/bin/ls -ilde -- <path>` with an exact argv,
 *    no shell, a pinned `C` locale, an environment holding nothing else, a
 *    byte cap, and any stderr output refused (never retained). Accepted
 *    evidence is only: no ACL, or an
 *    ACL whose every entry is a fully understood `deny`. Any `allow` entry,
 *    whoever it names, declines: this module never guesses account names, so
 *    it cannot prove an allow is owner-equivalent. Ambiguous, malformed,
 *    truncated, or inconsistent listings, unknown rights, and every child
 *    failure (spawn, signal, nonzero exit, timeout, cancellation) decline.
 *
 * Path spelling: the announced path must already be absolute, normalized, and
 * printable ASCII (so a listing line can never be split or forged by the
 * name). The only accepted symlink is a fixed first component: `/tmp` ->
 * `/private/tmp` or `/var` -> `/private/var`, and only after an exact proof
 * that the entry is a root-owned symlink whose `readlink` is Darwin's stock
 * relative target (`private/tmp` / `private/var`). Any other symlink anywhere
 * declines. The short AF_UNIX byte bound applies to both the announced and the
 * proven canonical spelling, since a later connect uses the canonical one.
 *
 * Each listing must be the complete single-object header for the exact operand
 * and observed inode (plus the proven target for the alias symlink), so a
 * prefix-only, truncated, or other-object listing never counts as evidence.
 *
 * Replacement and change: every observed object's dev/ino/uid/mode/ctime is
 * recorded before the ACL listings, re-observed right after its own listing,
 * and re-observed again once all listings are in. Any difference declines, so
 * a listing is accepted only for the inode the mode rule approved, and an ACL
 * rewritten on an already-listed object (which updates its ctime) is caught.
 * Unrelated activity that touches an ancestor's ctime (an entry created in a
 * shared temp directory) also declines; that is fail-closed and the caller may
 * prove again.
 *
 * Currency: one monotonic whole-proof deadline, an optional AbortSignal, and a
 * required synchronous `isCurrent` predicate are checked after every
 * asynchronous step; the deadline and abort settle the proof even while a
 * lookup or child is stalled, and an in-flight listing child is killed. A
 * minted proof is an opaque branded handle whose reader re-checks `isCurrent`
 * and a short maximum age.
 *
 * Results are fixed codes. They never contain the socket path, listing bytes,
 * account or group names, or child stderr. This module logs nothing.
 */
import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { lstat, readlink } from "node:fs/promises";
import { posix as posixPath } from "node:path";
import { performance } from "node:perf_hooks";

import { CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES } from "./native-claude-inbox-limits";

/** Fixed absolute ACL listing tool; never a PATH lookup. */
export const CLAUDE_DARWIN_ACL_TOOL = "/bin/ls";
/** Exact listing flags: inode, long, directory-as-entry, print ACL. */
export const CLAUDE_DARWIN_ACL_FLAGS: readonly string[] = Object.freeze(["-ilde", "--"]);
/** The only environment the listing child receives. */
export const CLAUDE_DARWIN_ACL_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: "C", LANG: "C" });
/** Largest accepted listing output for one object, in bytes. */
export const CLAUDE_DARWIN_ACL_MAX_OUTPUT_BYTES = 16 * 1024;
export const CLAUDE_DARWIN_PROOF_DEFAULT_DEADLINE_MS = 5000;
export const CLAUDE_DARWIN_PROOF_MIN_DEADLINE_MS = 50;
export const CLAUDE_DARWIN_PROOF_MAX_DEADLINE_MS = 30_000;
/** A minted proof is readable only this long after it completed. */
export const CLAUDE_DARWIN_PROOF_MAX_AGE_MS = 2000;

/**
 * Darwin's fixed first-component aliases and their stock relative symlink
 * targets. Nothing else is ever followed.
 */
const FIXED_ALIASES: ReadonlyMap<string, string> = new Map([
  ["tmp", "private/tmp"],
  ["var", "private/var"],
]);

/** Fixed refusal vocabulary. */
export type ClaudeDarwinInboxProofRefusal =
  | "unsupported_platform"
  | "invalid_request"
  | "invalid_options"
  | "invalid_socket_path"
  | "socket_path_too_long"
  | "alias_refused"
  | "endpoint_unavailable"
  | "endpoint_mismatch"
  | "endpoint_unprotected"
  | "acl_tool_untrusted"
  | "acl_probe_failed"
  | "acl_untrusted"
  | "acl_unprovable"
  | "endpoint_replaced"
  | "not_current"
  | "deadline_exceeded"
  | "cancelled";

/** Endpoint identity (lstat, bigint), as the shared sender's capability expects. */
export interface ClaudeDarwinInboxEndpointIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: number;
}

/** `absent`: no object carried ACL entries; `deny_only`: at least one did, all deny. */
export type ClaudeDarwinAclEvidence = "absent" | "deny_only";

/** Values a proof reveals to its trusted owner. */
export interface ClaudeDarwinInboxEndpointProofValues {
  /** Canonical spelling (alias expanded) a later connect must use. */
  readonly canonicalPath: string;
  readonly endpoint: ClaudeDarwinInboxEndpointIdentity;
  readonly aclEvidence: ClaudeDarwinAclEvidence;
}

declare const proofBrand: unique symbol;
/** Opaque branded proof. Holds no own properties and serializes to a fixed marker. */
export type ClaudeDarwinInboxEndpointProof = { readonly [proofBrand]: true };

export type ClaudeDarwinInboxProofResult =
  | { readonly ok: true; readonly proof: ClaudeDarwinInboxEndpointProof }
  | { readonly ok: false; readonly reason: ClaudeDarwinInboxProofRefusal };

/** Trusted, host-owned request for one announced socket. */
export interface ClaudeDarwinInboxProofRequest {
  /** Announced absolute socket path. */
  readonly socketPath: string;
  /** Identity the host already captured; when present it must match exactly. */
  readonly expectedEndpoint?: ClaudeDarwinInboxEndpointIdentity;
  /** Synchronous, nonblocking host predicate: is this launch still current? */
  readonly isCurrent: () => boolean;
}

/**
 * Minimal lstat view (bigint). `mode` includes the file-type bits. `ctimeNs`
 * changes on every metadata change, including an ACL change, so an object
 * whose ACL was rewritten after it was listed no longer matches its snapshot.
 */
export interface ClaudeDarwinLstat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly ctimeNs: bigint;
}

/** Filesystem seam. Production: `fs.promises.lstat(path, { bigint: true })` and `readlink`. */
export interface ClaudeDarwinFsProbe {
  readonly lstat: (path: string) => Promise<ClaudeDarwinLstat>;
  readonly readlink: (path: string) => Promise<string>;
}

export interface ClaudeDarwinAclExecOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
  /** Aborted when the proof settles; the child must be killed. */
  readonly signal: AbortSignal;
}

/** Outcome of one listing child. Never carries stderr. */
export type ClaudeDarwinAclExecResult =
  | { readonly status: "exited"; readonly exitCode: number; readonly stdout: Buffer }
  | { readonly status: "spawn_failed" | "diagnostic" | "signaled" | "truncated" | "timeout" | "aborted" };

export type ClaudeDarwinAclExecutor = (
  tool: string,
  args: readonly string[],
  options: ClaudeDarwinAclExecOptions,
) => Promise<ClaudeDarwinAclExecResult>;

export interface ClaudeDarwinInboxProofOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  /** Test seams. Production values are fixed. */
  readonly platform?: NodeJS.Platform;
  readonly getuid?: () => number | undefined;
  readonly fs?: ClaudeDarwinFsProbe;
  readonly aclExecutor?: ClaudeDarwinAclExecutor;
}

interface ProofState extends ClaudeDarwinInboxEndpointProofValues {
  readonly isCurrent: () => boolean;
  readonly provenAt: number;
}

const REDACTED = "[ClaudeDarwinInboxEndpointProof]";
const proofState = new WeakMap<object, ProofState>();
const proofPrototype = Object.freeze({
  toJSON: (): string => REDACTED,
  toString: (): string => REDACTED,
  [Symbol.for("nodejs.util.inspect.custom")]: (): string => REDACTED,
});

/**
 * Owner-only accessor. Returns the proven values only for a genuine proof that
 * is still current and younger than {@link CLAUDE_DARWIN_PROOF_MAX_AGE_MS};
 * otherwise `undefined`. A later sender must still recheck the identity after
 * connecting; a proof is never a standing grant.
 */
export function readClaudeDarwinInboxEndpointProof(
  proof: ClaudeDarwinInboxEndpointProof,
  nowMs: number = performance.now(),
): ClaudeDarwinInboxEndpointProofValues | undefined {
  if (typeof proof !== "object" || proof === null) return undefined;
  const state = proofState.get(proof);
  if (state === undefined) return undefined;
  const age = nowMs - state.provenAt;
  if (!Number.isFinite(age) || age < 0 || age > CLAUDE_DARWIN_PROOF_MAX_AGE_MS) return undefined;
  if (!callCurrent(state.isCurrent)) return undefined;
  return Object.freeze({ canonicalPath: state.canonicalPath, endpoint: state.endpoint, aclEvidence: state.aclEvidence });
}

const S_IFMT = 0o170000n;
const S_IFDIR = 0o040000n;
const S_IFLNK = 0o120000n;
const S_IFSOCK = 0o140000n;
const S_IFREG = 0o100000n;
const S_IWGRP = 0o020n;
const S_IWOTH = 0o002n;
const S_ISVTX = 0o1000n;

/** Kind of object an ACL listing describes. */
export type ClaudeDarwinObjectKind = "directory" | "symlink" | "socket";

/** One object whose entry must be shown non-replaceable. */
interface Observed {
  readonly path: string;
  readonly kind: ClaudeDarwinObjectKind;
  readonly stats: ClaudeDarwinLstat;
  /** Proven symlink target (symlinks only). */
  readonly linkTarget?: string;
}

const refusal = (reason: ClaudeDarwinInboxProofRefusal): ClaudeDarwinInboxProofResult => Object.freeze({ ok: false, reason });

/**
 * Prove one announced socket endpoint on Darwin. Never throws, never retries,
 * resolves within the deadline. See the module comment for the exact rule.
 */
export function proveClaudeDarwinInboxEndpoint(
  request: ClaudeDarwinInboxProofRequest,
  options: ClaudeDarwinInboxProofOptions = {},
): Promise<ClaudeDarwinInboxProofResult> {
  const startedAt = performance.now();
  try {
    if (typeof options !== "object" || options === null) return Promise.resolve(refusal("invalid_options"));
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") return Promise.resolve(refusal("unsupported_platform"));
    const deadlineMs = options.deadlineMs ?? CLAUDE_DARWIN_PROOF_DEFAULT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < CLAUDE_DARWIN_PROOF_MIN_DEADLINE_MS || deadlineMs > CLAUDE_DARWIN_PROOF_MAX_DEADLINE_MS) {
      return Promise.resolve(refusal("invalid_options"));
    }
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.resolve(refusal("invalid_options"));
    if (signal?.aborted) return Promise.resolve(refusal("cancelled"));
    if (typeof request !== "object" || request === null) return Promise.resolve(refusal("invalid_request"));
    const { socketPath, expectedEndpoint, isCurrent } = request;
    if (typeof isCurrent !== "function") return Promise.resolve(refusal("invalid_request"));
    if (expectedEndpoint !== undefined && !isValidIdentity(expectedEndpoint)) return Promise.resolve(refusal("invalid_request"));
    const spelling = resolveSpelling(socketPath);
    if (typeof spelling === "string") return Promise.resolve(refusal(spelling));
    const getuid = options.getuid ?? (typeof process.getuid === "function" ? process.getuid.bind(process) : () => undefined);
    let uid: number | undefined;
    try {
      uid = getuid();
    } catch {
      uid = undefined;
    }
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) return Promise.resolve(refusal("unsupported_platform"));
    if (!callCurrent(isCurrent)) return Promise.resolve(refusal("not_current"));
    const fs = options.fs ?? productionFs;
    const aclExecutor = options.aclExecutor ?? claudeDarwinAclListingExecutor;
    if (typeof fs !== "object" || fs === null || typeof fs.lstat !== "function" || typeof fs.readlink !== "function" || typeof aclExecutor !== "function") {
      return Promise.resolve(refusal("invalid_options"));
    }
    const snapshot: ExpectedSnapshot | undefined = expectedEndpoint === undefined
      ? undefined
      : { dev: expectedEndpoint.dev, ino: expectedEndpoint.ino, uid: expectedEndpoint.uid };
    return runBounded({
      spelling, expected: snapshot, isCurrent, uid: BigInt(uid), fs, aclExecutor,
      expiresAt: startedAt + deadlineMs, signal,
    });
  } catch {
    return Promise.resolve(refusal("invalid_request"));
  }
}

interface ExpectedSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: number;
}

interface Spelling {
  /** `/tmp` or `/var` when the fixed alias is used. */
  readonly aliasPath?: string;
  readonly aliasTarget?: string;
  readonly canonicalPath: string;
}

/**
 * The canonical spelling (fixed `/tmp` or `/var` alias expanded) a proof of
 * `socketPath` would report, or `undefined` when the spelling rule refuses it.
 * Pure: no filesystem access, so it proves nothing about the endpoint; it only
 * lets a capability owner bind a proof to the exact announced path.
 */
export function claudeDarwinInboxCanonicalSpelling(socketPath: unknown): string | undefined {
  try {
    const spelling = resolveSpelling(socketPath);
    return typeof spelling === "string" ? undefined : spelling.canonicalPath;
  } catch {
    return undefined;
  }
}

/** Pure spelling rule; returns the refusal code on failure. */
function resolveSpelling(value: unknown): Spelling | "invalid_socket_path" | "socket_path_too_long" {
  if (typeof value !== "string" || value.length === 0) return "invalid_socket_path";
  // Bound work before scanning; any accepted path is ASCII, so length == bytes.
  if (value.length > CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES) return "socket_path_too_long";
  // Printable ASCII only: no control byte (newline!) or non-ASCII byte can
  // reach the listing child's output and split or forge a listing line.
  if (!/^[\x20-\x7e]+$/u.test(value)) return "invalid_socket_path";
  if (!value.startsWith("/") || value === "/" || value.endsWith("/")) return "invalid_socket_path";
  if (posixPath.normalize(value) !== value) return "invalid_socket_path";
  if (Buffer.byteLength(value, "utf8") > CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES) return "socket_path_too_long";
  const parts = value.split("/").slice(1);
  const first = parts[0] ?? "";
  const aliasTarget = parts.length >= 2 ? FIXED_ALIASES.get(first) : undefined;
  if (aliasTarget === undefined) return { canonicalPath: value };
  const canonicalPath = `/${aliasTarget}/${parts.slice(1).join("/")}`;
  if (Buffer.byteLength(canonicalPath, "utf8") > CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES) return "socket_path_too_long";
  return { aliasPath: `/${first}`, aliasTarget, canonicalPath };
}

interface RunContext {
  readonly spelling: Spelling;
  readonly expected: ExpectedSnapshot | undefined;
  readonly isCurrent: () => boolean;
  readonly uid: bigint;
  readonly fs: ClaudeDarwinFsProbe;
  readonly aclExecutor: ClaudeDarwinAclExecutor;
  readonly expiresAt: number;
  readonly signal: AbortSignal | undefined;
}

/** Internal sentinel: the proof settled elsewhere; never surfaced. */
const STOPPED = Symbol("stopped");
type Step<T> = T | ClaudeDarwinInboxProofRefusal | typeof STOPPED;

function runBounded(ctx: RunContext): Promise<ClaudeDarwinInboxProofResult> {
  return new Promise((resolve) => {
    let settled = false;
    // Aborted when the proof settles for any reason, so an in-flight listing
    // child is killed and no later step starts.
    const lifetime = new AbortController();
    let abortSubscription: Disposable | undefined;
    const finish = (result: ClaudeDarwinInboxProofResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSubscription?.[Symbol.dispose]();
      lifetime.abort();
      resolve(result);
    };
    const timer = setTimeout(() => finish(refusal("deadline_exceeded")), Math.max(1, Math.ceil(ctx.expiresAt - performance.now())));
    if (ctx.signal !== undefined) abortSubscription = addAbortListener(ctx.signal, () => finish(refusal("cancelled")));

    /** Synchronous currency gate, run after every asynchronous step. */
    const gate = (): ClaudeDarwinInboxProofRefusal | typeof STOPPED | undefined => {
      if (settled) return STOPPED;
      if (ctx.signal?.aborted) return "cancelled";
      if (performance.now() >= ctx.expiresAt) return "deadline_exceeded";
      if (!callCurrent(ctx.isCurrent)) return "not_current";
      // isCurrent is host code and may itself abort or overrun the budget.
      if (ctx.signal?.aborted) return "cancelled";
      if (performance.now() >= ctx.expiresAt) return "deadline_exceeded";
      return undefined;
    };
    const first = gate();
    if (first !== undefined) {
      if (first !== STOPPED) finish(refusal(first));
      return;
    }
    void prove(ctx, gate, lifetime.signal).then(
      (outcome) => {
        if (outcome === STOPPED) return;
        if (typeof outcome === "string") {
          finish(refusal(outcome));
          return;
        }
        const final = gate();
        if (final !== undefined) {
          if (final !== STOPPED) finish(refusal(final));
          return;
        }
        const proof = Object.freeze(Object.create(proofPrototype) as object);
        proofState.set(proof, Object.freeze({ ...outcome, isCurrent: ctx.isCurrent, provenAt: performance.now() }));
        finish(Object.freeze({ ok: true, proof: proof as ClaudeDarwinInboxEndpointProof }));
      },
      () => finish(refusal("acl_probe_failed")),
    );
  });
}

type Gate = () => ClaudeDarwinInboxProofRefusal | typeof STOPPED | undefined;

async function prove(ctx: RunContext, gate: Gate, lifetime: AbortSignal): Promise<Step<ClaudeDarwinInboxEndpointProofValues>> {
  const { fs, spelling, uid } = ctx;
  const trusted = (owner: bigint): boolean => owner === 0n || owner === uid;

  const observe = async (path: string): Promise<Step<ClaudeDarwinLstat>> => {
    let stats: ClaudeDarwinLstat;
    try {
      stats = await fs.lstat(path);
    } catch {
      const stop = gate();
      return stop ?? "endpoint_unavailable";
    }
    const stop = gate();
    if (stop !== undefined) return stop;
    if (!isLstat(stats)) return "endpoint_unavailable";
    return stats;
  };

  // The listing tool itself must be a root-owned regular file nobody else can rewrite.
  const tool = await observe(CLAUDE_DARWIN_ACL_TOOL);
  if (typeof tool !== "object") return tool === "endpoint_unavailable" ? "acl_tool_untrusted" : tool;
  if ((tool.mode & S_IFMT) !== S_IFREG || tool.uid !== 0n || (tool.mode & (S_IWGRP | S_IWOTH)) !== 0n) return "acl_tool_untrusted";

  // Pass 1: mode/owner/sticky rule and identities.
  const observed: Observed[] = [];
  const directories = ancestorsOf(spelling.canonicalPath);
  let previous: ClaudeDarwinLstat | undefined;
  for (const directory of directories) {
    const stats = await observe(directory);
    if (typeof stats !== "object") return stats;
    if ((stats.mode & S_IFMT) !== S_IFDIR || !trusted(stats.uid)) return "endpoint_unprotected";
    if (previous !== undefined && !childProtected(previous, stats.uid, trusted)) return "endpoint_unprotected";
    observed.push({ path: directory, kind: "directory", stats });
    previous = stats;
    if (directory === "/" && spelling.aliasPath !== undefined) {
      const alias = await observeAlias(ctx, gate, observe, stats, trusted);
      if (typeof alias !== "object") return alias;
      observed.push(alias);
    }
  }
  const socket = await observe(spelling.canonicalPath);
  if (typeof socket !== "object") return socket;
  if ((socket.mode & S_IFMT) !== S_IFSOCK || socket.uid !== uid) return "endpoint_mismatch";
  if (ctx.expected !== undefined) {
    const e = ctx.expected;
    if (socket.dev !== e.dev || socket.ino !== e.ino || socket.uid !== BigInt(e.uid)) return "endpoint_mismatch";
  }
  if (previous === undefined || !childProtected(previous, socket.uid, trusted)) return "endpoint_unprotected";
  observed.push({ path: spelling.canonicalPath, kind: "socket", stats: socket });

  /** Same inode, owner, mode, and metadata-change time as the first observation. */
  const unchanged = async (item: Observed): Promise<ClaudeDarwinInboxProofRefusal | typeof STOPPED | undefined> => {
    const again = await observe(item.path);
    if (again === STOPPED) return STOPPED;
    if (again === "endpoint_unavailable") return "endpoint_replaced";
    if (typeof again !== "object") return again;
    return sameSnapshot(again, item.stats) ? undefined : "endpoint_replaced";
  };

  // ACL evidence for every object whose entry could be replaced, each listing
  // bracketed by the pass-1 snapshot and an immediate re-observation.
  let sawDeny = false;
  for (const item of observed) {
    const listed = await listAcl(ctx, gate, lifetime, item);
    if (listed === STOPPED) return STOPPED;
    if (listed === "deny_only") sawDeny = true;
    else if (listed !== "absent") return listed;
    const after = await unchanged(item);
    if (after !== undefined) return after;
  }

  // Pass 2: an object listed early may have been changed (ACL rewritten,
  // replaced, re-moded) while later objects were listed. Every snapshot,
  // including ctime, must still hold once all evidence is in.
  for (const item of observed) {
    const after = await unchanged(item);
    if (after !== undefined) return after;
  }
  if (spelling.aliasPath !== undefined) {
    const link = await readAlias(ctx, gate, spelling.aliasPath);
    if (typeof link !== "object") return link === "alias_refused" ? "endpoint_replaced" : link;
    if (link.target !== spelling.aliasTarget) return "endpoint_replaced";
  }

  return {
    canonicalPath: spelling.canonicalPath,
    endpoint: Object.freeze({ dev: socket.dev, ino: socket.ino, uid: Number(socket.uid) }),
    aclEvidence: sawDeny ? "deny_only" : "absent",
  };
}

async function observeAlias(
  ctx: RunContext,
  gate: Gate,
  observe: (path: string) => Promise<Step<ClaudeDarwinLstat>>,
  root: ClaudeDarwinLstat,
  trusted: (owner: bigint) => boolean,
): Promise<Step<Observed>> {
  const aliasPath = ctx.spelling.aliasPath as string;
  const stats = await observe(aliasPath);
  if (stats === "endpoint_unavailable") return "alias_refused";
  if (typeof stats !== "object") return stats;
  // Exact proof: a root-owned symlink directly under a protected `/`.
  if ((stats.mode & S_IFMT) !== S_IFLNK || stats.uid !== 0n) return "alias_refused";
  if (!childProtected(root, stats.uid, trusted)) return "endpoint_unprotected";
  const link = await readAlias(ctx, gate, aliasPath);
  if (typeof link !== "object") return link;
  // Darwin's exact stock relative target only; never an arbitrary destination.
  if (link.target !== ctx.spelling.aliasTarget) return "alias_refused";
  return { path: aliasPath, kind: "symlink", stats, linkTarget: link.target };
}

async function readAlias(ctx: RunContext, gate: Gate, aliasPath: string): Promise<Step<{ readonly target: string }>> {
  let target: unknown;
  try {
    target = await ctx.fs.readlink(aliasPath);
  } catch {
    return gate() ?? "alias_refused";
  }
  const stop = gate();
  if (stop !== undefined) return stop;
  return typeof target === "string" ? { target } : "alias_refused";
}

async function listAcl(
  ctx: RunContext,
  gate: Gate,
  lifetime: AbortSignal,
  item: Observed,
): Promise<ClaudeDarwinAclEvidence | ClaudeDarwinInboxProofRefusal | typeof STOPPED> {
  const remaining = Math.max(1, Math.ceil(ctx.expiresAt - performance.now()));
  let result: ClaudeDarwinAclExecResult;
  try {
    result = await ctx.aclExecutor(CLAUDE_DARWIN_ACL_TOOL, [...CLAUDE_DARWIN_ACL_FLAGS, item.path], {
      timeoutMs: remaining,
      maxOutputBytes: CLAUDE_DARWIN_ACL_MAX_OUTPUT_BYTES,
      env: CLAUDE_DARWIN_ACL_ENV,
      signal: lifetime,
    });
  } catch {
    return gate() ?? "acl_probe_failed";
  }
  const stop = gate();
  if (stop !== undefined) return stop;
  if (typeof result !== "object" || result === null || result.status !== "exited") return "acl_probe_failed";
  if (result.exitCode !== 0 || !Buffer.isBuffer(result.stdout)) return "acl_probe_failed";
  const verdict = classifyClaudeDarwinAclListing(result.stdout, {
    kind: item.kind, mode: item.stats.mode, ino: item.stats.ino, path: item.path, linkTarget: item.linkTarget,
  });
  if (verdict === "untrusted") return "acl_untrusted";
  if (verdict === "unprovable") return "acl_unprovable";
  return verdict;
}

/**
 * The documented macOS `chmod(1)` ACL rights (factual reference: the
 * peer-state ACL parser). Any other token makes the listing unprovable.
 */
const ACL_RIGHTS: ReadonlySet<string> = new Set([
  "add_file", "add_subdirectory", "append", "chown", "delete", "delete_child", "execute", "list", "read",
  "readattr", "readextattr", "readsecurity", "search", "write", "writeattr", "writeextattr", "writesecurity",
]);
const ACL_INHERIT_FLAGS: ReadonlySet<string> = new Set(["file_inherit", "directory_inherit", "limit_inherit", "only_inherit"]);
/**
 * Recognized Darwin ACL principal spellings, checked syntactically only (never
 * resolved or trusted): `user:<name>`, `group:<name>` with a non-empty
 * conservative name, or the bare UUID `ls` prints for an unresolved
 * principal. Anything else (`group:`, `owner@`, other dialects) is
 * unprovable even on a deny entry.
 */
const ACL_PRINCIPAL = /^(?:(?:user|group):[A-Za-z0-9_.@-]+|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})$/u;
const KIND_CHAR: Readonly<Record<ClaudeDarwinObjectKind, string>> = { directory: "d", symlink: "l", socket: "s" };

export type ClaudeDarwinAclVerdict = ClaudeDarwinAclEvidence | "untrusted" | "unprovable";

/** The approved object one listing must describe. */
export interface ClaudeDarwinListingSubject {
  readonly kind: ClaudeDarwinObjectKind;
  /** lstat mode, including type bits. */
  readonly mode: bigint;
  readonly ino: bigint;
  /** Exact operand passed to the listing tool. */
  readonly path: string;
  /** Proven symlink target, required for (and only for) a symlink. */
  readonly linkTarget?: string;
}

/**
 * One complete single-object `ls -ilde` header line in the `C` locale:
 * inode, mode column (+ optional `@`/`+`), link count, owner, group, size,
 * month, day, time-or-year, then the name. The name is matched exactly
 * against the operand (and ` -> target` for a symlink) by the caller, so a
 * prefix-only, truncated, or other-object header never passes.
 */
const LISTING_HEADER = /^ *(\d+) +(.)([-rwxsStT]{9})([@+]?) +\d+ +\S+ +\S+ +\d+ +[A-Z][a-z]{2} +\d{1,2} +(?:\d{1,2}:\d{2}|\d{4}) (.+)$/u;

/**
 * Classify one complete `ls -ilde` listing for an approved object. Pure. The
 * header must be the whole single-object line: its inode, type, and nine
 * permission characters must equal the observation and its name must be
 * exactly the listed operand (plus ` -> <proven target>` for the alias
 * symlink), so the listing provably enumerates that object's ACL. Entries
 * must be numbered contiguously from 0, every line must be understood, and
 * only `deny` entries are accepted. A `+` marker with no entries, or entries
 * with neither `+` nor `@` marker, is inconsistent.
 */
export function classifyClaudeDarwinAclListing(stdout: Buffer, subject: ClaudeDarwinListingSubject): ClaudeDarwinAclVerdict {
  if (typeof subject !== "object" || subject === null) return "unprovable";
  const { kind, mode, ino, path, linkTarget } = subject;
  if (typeof mode !== "bigint" || typeof ino !== "bigint" || typeof path !== "string" || path.length === 0) return "unprovable";
  if ((kind === "symlink") !== (typeof linkTarget === "string" && linkTarget.length > 0)) return "unprovable";
  if (!Buffer.isBuffer(stdout) || stdout.length === 0 || stdout.length > CLAUDE_DARWIN_ACL_MAX_OUTPUT_BYTES) return "unprovable";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return "unprovable";
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) return "unprovable";
  const lines = text.slice(0, -1).split("\n");
  const listing = lines[0] ?? "";
  const head = LISTING_HEADER.exec(listing);
  if (head === null) return "unprovable";
  if (head[1] !== ino.toString() || head[2] !== KIND_CHAR[kind] || head[3] !== permissionString(mode)) return "unprovable";
  const expectedName = kind === "symlink" ? `${path} -> ${linkTarget as string}` : path;
  if (head[5] !== expectedName) return "unprovable";
  const marker = head[4];
  let entries = 0;
  let sawOwnerMetadata = false;
  let sawUnknown = false;
  let sawAllow = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    // chmod(1)'s documented optional owner line; it carries no rights.
    if (index === 1 && /^\s*owner:\s*\S+\s*$/u.test(line)) {
      sawOwnerMetadata = true;
      continue;
    }
    const match = /^\s*(\d+):\s+(\S.*)$/u.exec(line);
    if (match === null || match[1] !== String(entries)) return "unprovable";
    entries += 1;
    // Exactly `principal [inherited] allow|deny rights`; whitespace runs are
    // tolerated (as in the peer-state reference) but no token is dropped.
    const tokens = (match[2] as string).trim().split(/\s+/u);
    if (!ACL_PRINCIPAL.test(tokens[0] ?? "")) return "unprovable";
    const grantIndex = tokens[1] === "inherited" ? 2 : 1;
    const grant = tokens[grantIndex];
    if ((grant !== "allow" && grant !== "deny") || tokens.length !== grantIndex + 2) return "unprovable";
    const rights = (tokens[grantIndex + 1] as string).split(",");
    for (const right of rights) {
      if (right.length === 0) return "unprovable";
      if (!ACL_RIGHTS.has(right) && !ACL_INHERIT_FLAGS.has(right)) sawUnknown = true;
    }
    if (grant === "allow") sawAllow = true;
  }
  if (sawUnknown) return "unprovable";
  // ACL metadata with no entries is an incomplete transcript, not a clean
  // no-ACL listing (and `@` can mask the `+` marker).
  if (entries === 0) return marker === "+" || sawOwnerMetadata ? "unprovable" : "absent";
  if (marker === "") return "unprovable";
  return sawAllow ? "untrusted" : "deny_only";
}

/** `strmode`-style nine permission characters for the low mode bits. */
function permissionString(mode: bigint): string {
  const bit = (mask: bigint): boolean => (mode & mask) !== 0n;
  const exec = (x: boolean, special: boolean, set: string, unset: string): string =>
    special ? (x ? set : unset) : (x ? "x" : "-");
  return [
    bit(0o400n) ? "r" : "-", bit(0o200n) ? "w" : "-", exec(bit(0o100n), bit(0o4000n), "s", "S"),
    bit(0o040n) ? "r" : "-", bit(0o020n) ? "w" : "-", exec(bit(0o010n), bit(0o2000n), "s", "S"),
    bit(0o004n) ? "r" : "-", bit(0o002n) ? "w" : "-", exec(bit(0o001n), bit(0o1000n), "t", "T"),
  ].join("");
}

/** `/` then every canonical ancestor directory of `path`, excluding `path` itself. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const result = ["/"];
  for (let index = 1; index < parts.length; index += 1) result.push(`/${parts.slice(0, index).join("/")}`);
  return result;
}

function childProtected(parent: ClaudeDarwinLstat, childUid: bigint, trusted: (owner: bigint) => boolean): boolean {
  if ((parent.mode & (S_IWGRP | S_IWOTH)) === 0n) return true;
  return (parent.mode & S_ISVTX) !== 0n && trusted(childUid);
}

function isLstat(value: unknown): value is ClaudeDarwinLstat {
  if (typeof value !== "object" || value === null) return false;
  const { dev, ino, uid, mode, ctimeNs } = value as Record<string, unknown>;
  return typeof dev === "bigint" && typeof ino === "bigint" && typeof uid === "bigint" && typeof mode === "bigint"
    && typeof ctimeNs === "bigint";
}

function sameSnapshot(a: ClaudeDarwinLstat, b: ClaudeDarwinLstat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.ctimeNs === b.ctimeNs;
}

function isValidIdentity(value: unknown): value is ClaudeDarwinInboxEndpointIdentity {
  if (typeof value !== "object" || value === null) return false;
  const { dev, ino, uid } = value as Record<string, unknown>;
  return typeof dev === "bigint" && dev >= 0n
    && typeof ino === "bigint" && ino > 0n
    && typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0;
}

function callCurrent(isCurrent: () => boolean): boolean {
  try {
    return isCurrent() === true;
  } catch {
    return false;
  }
}

const productionFs: ClaudeDarwinFsProbe = Object.freeze({
  lstat: (path: string): Promise<ClaudeDarwinLstat> => lstat(path, { bigint: true }),
  readlink: (path: string): Promise<string> => readlink(path, { encoding: "utf8" }),
});

/**
 * Bounded listing child: exact argv, no shell, only `options.env`, cwd `/`,
 * stdin closed, stdout capped. Any stderr byte is a diagnostic: stderr is
 * drained but never retained, and the outcome is the fixed `diagnostic`
 * status even on exit 0, since a listing that came with a diagnostic does not
 * establish ACL absence. Kills the child (SIGKILL) on
 * truncation, timeout, or abort. Never throws; never reflects child output in
 * a failure. Exported so its bounds can be exercised; production always
 * passes the fixed tool and flags.
 */
export const claudeDarwinAclListingExecutor: ClaudeDarwinAclExecutor = (tool, args, options) =>
  new Promise((resolve) => {
    if (options.signal.aborted) {
      resolve({ status: "aborted" });
      return;
    }
    let done = false;
    let sawDiagnostic = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    let abortSubscription: Disposable | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const settle = (result: ClaudeDarwinAclExecResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      abortSubscription?.[Symbol.dispose]();
      resolve(result);
    };
    const kill = (): void => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    try {
      child = spawn(tool, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...options.env },
        cwd: "/",
        windowsHide: true,
      });
    } catch {
      settle({ status: "spawn_failed" });
      return;
    }
    child.on("error", () => {
      kill();
      settle({ status: "spawn_failed" });
    });
    // Drained so the child never blocks on a full pipe; contents are dropped.
    child.stderr?.on("data", () => {
      sawDiagnostic = true;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) {
        kill();
        settle({ status: "truncated" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null || code === null) {
        settle({ status: "signaled" });
        return;
      }
      settle(sawDiagnostic ? { status: "diagnostic" } : { status: "exited", exitCode: code, stdout: Buffer.concat(chunks) });
    });
    timer = setTimeout(() => {
      kill();
      settle({ status: "timeout" });
    }, Math.max(1, options.timeoutMs));
    abortSubscription = addAbortListener(options.signal, () => {
      kill();
      settle({ status: "aborted" });
    });
  });
