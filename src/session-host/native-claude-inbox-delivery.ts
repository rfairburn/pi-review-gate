/**
 * #682: bounded send primitive for one already-owned native Claude inbox.
 *
 * Evidenced protocol facts this module encodes (prior real CLI proof on
 * Claude Code 2.1.330): a native Claude launch exposes one per-session Unix
 * domain inbox socket, announced in `SessionStart` hook scope together with a
 * hook token. A sender connects and writes exactly two NDJSON lines, then the
 * socket writes zero reply bytes:
 *
 *   {"type":"auth","token":<hook token>}
 *   {"type":"user","session_id":<exact session id>,"message":{"role":"user","content":<text>}}
 *
 * The auth frame carries no `session_id` (it did not in the real probe). This
 * is the only wire format: there are no other modes or caller-supplied frames,
 * and any CLI version other than the proven one is refused.
 *
 * What this module deliberately does NOT know or claim:
 *
 * - A completed socket write is never a delivery. The socket returns nothing,
 *   so the best success outcome is `sent_unconfirmed`: every byte was handed to
 *   the kernel for this endpoint. Placement in the conversation and explicit
 *   acknowledgment are out of scope and are never inferred from a write, a
 *   close, or silence.
 * - Nothing here starts, resumes, or locates a session, reads hook payloads,
 *   falls back to PTY input, retries, or replays. An `unknown` outcome means
 *   some bytes may have reached the peer; callers must not resend automatically.
 *
 * Endpoint stability: Node cannot read the connected peer's credentials
 * (no SO_PEERCRED), so the peer is never verified directly. Instead the socket
 * must sit in a protected namespace: a canonical path with no symlinked
 * component, where every ancestor directory is owned by root or the current
 * user and any group/world-writable ancestor is sticky with a child entry owned
 * by root or the current user. Only root or the same user can then replace the
 * socket between the identity check, connect, and the post-connect recheck.
 * A path whose stability cannot be established is refused before any byte.
 *
 * macOS (#682): Darwin ACLs can grant replacement independently of the mode
 * bits, so the Linux rule above never admits it. A Darwin capability is minted
 * only from a fresh, current proof of the ACL-aware Darwin rule
 * (./native-claude-darwin-inbox-endpoint), which also accepts exactly the
 * stock `/tmp` -> `/private/tmp` and `/var` -> `/private/var` aliases. The
 * capability keeps both the announced spelling and the proven canonical one;
 * every send re-runs that whole proof for the announced spelling, bound to the
 * exact captured dev/ino/uid, within the send's own remaining deadline, both
 * before connecting (to the canonical spelling only) and after connecting,
 * before the first byte. An earlier proof is never reused by a send. The wire
 * bytes are identical on both platforms.
 *
 * Windows (#682): no socket exists on this side. A Windows capability is
 * minted only by the trusted host from ONE exact live custody binding (the
 * owned supervisor's `SUP_BIND <seq> OK` for the root session it correlated)
 * and holds no token, endpoint, or key: only the host's synchronous commit
 * port into that supervisor's existing two-phase `SEND`. The send keeps this
 * module's own message, currency, and whole-attempt deadline checks, then
 * makes exactly one commit and maps its closed outcome onto the same result
 * shape (`sent_unconfirmed` only for the supervisor's full native write;
 * `unknown` for anything after the frame was handed over, including the
 * deadline expiring while the reply is outstanding — the host still observes
 * that reply for its own revocation). Nothing is retried, queued, or rerouted.
 *
 * Trust boundary: a capability is built only by trusted host code from values
 * it already owns for the current launch (never from model input), is branded
 * so a look-alike object is refused, and keeps the hook token in a private
 * field that never serializes. Results and refusal reasons are fixed codes that
 * never contain the token, the socket path, or message text. This module logs
 * nothing.
 */
import { addAbortListener } from "node:events";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { posix as posixPath } from "node:path";
import type { Duplex } from "node:stream";

import {
  CLAUDE_DARWIN_PROOF_MAX_DEADLINE_MS,
  CLAUDE_DARWIN_PROOF_MIN_DEADLINE_MS,
  claudeDarwinInboxCanonicalSpelling,
  proveClaudeDarwinInboxEndpoint,
  readClaudeDarwinInboxEndpointProof,
  type ClaudeDarwinInboxEndpointProof,
  type ClaudeDarwinInboxProofOptions,
  type ClaudeDarwinInboxProofRefusal,
  type ClaudeDarwinInboxProofResult,
} from "./native-claude-darwin-inbox-endpoint";
import { CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES } from "./native-claude-inbox-limits";
import { isStableCliVersionAtLeast } from "./native-cli-version-floor";
import { isNativeConversationId } from "./native-conversation";
import type {
  NativeWindowsClaudeCustodySendCommit,
  NativeWindowsClaudeCustodySendOutcome,
  NativeWindowsClaudeCustodySendPayloadSource,
  NativeWindowsClaudeCustodySendRefusal,
  NativeWindowsClaudeCustodySendWriteBudget,
} from "./native-windows-claude-custody-protocol";

export { CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES };

/**
 * Minimum Claude Code CLI version admitted for inbox delivery. 2.1.330 is the
 * release on which the inbox protocol was proven end to end; newer stable
 * releases are admitted on the assumption that they keep the same protocol,
 * without being separately tested, and every other capability and send check
 * still fails closed.
 */
export const CLAUDE_INBOX_MIN_CLI_VERSION = "2.1.330";

/**
 * Whether `version` is a well-formed stable Claude Code version at or above
 * {@linkcode CLAUDE_INBOX_MIN_CLI_VERSION}; prerelease, build-tagged,
 * malformed, and older versions are refused. The value itself is never
 * normalized.
 */
export function isClaudeInboxSupportedCliVersion(version: unknown): boolean {
  return isStableCliVersionAtLeast(version, CLAUDE_INBOX_MIN_CLI_VERSION);
}
/**
 * Platforms supported by the endpoint namespace check. macOS is refused: its
 * directory ACLs can grant child creation/deletion independently of the mode
 * bits this check inspects, so the endpoint cannot be shown stable there.
 */
export const CLAUDE_INBOX_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(["linux"] as NodeJS.Platform[]);

/**
 * #682: the one platform whose inbox endpoint is proved by the ACL-aware Darwin
 * rule instead of the Linux namespace rule above. A capability for it exists
 * only through {@linkcode createClaudeDarwinInboxSendCapability}.
 */
export const CLAUDE_INBOX_DARWIN_PLATFORM: NodeJS.Platform = "darwin";

/**
 * #682: platforms on which SOME endpoint proof may mint an inbox capability:
 * the Linux namespace rule or the Darwin ACL-aware proof. This only admits a
 * candidate announcement and an eligibility check; every capability and send
 * still requires its own platform's proof. Windows and every other platform
 * stay refused.
 */
export const CLAUDE_INBOX_PROVABLE_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(
  [...CLAUDE_INBOX_SUPPORTED_PLATFORMS, CLAUDE_INBOX_DARWIN_PLATFORM] as NodeJS.Platform[],
);

/** Which endpoint rule a capability is checked by. */
export type ClaudeInboxEndpointRule = "linux" | "darwin";

/** Largest accepted message text, in UTF-8 bytes. */
export const CLAUDE_INBOX_MAX_TEXT_BYTES = 64 * 1024;
/** Largest single encoded frame line, including the trailing newline. */
export const CLAUDE_INBOX_MAX_FRAME_BYTES = 128 * 1024;
/** Local UTF-8 size limit for the opaque hook token, not a provider format rule. */
export const CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES = 4096;
export const CLAUDE_INBOX_DEFAULT_DEADLINE_MS = 5000;
export const CLAUDE_INBOX_MIN_DEADLINE_MS = 50;
export const CLAUDE_INBOX_MAX_DEADLINE_MS = 30_000;

const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Endpoint identity the host captured (lstat, bigint) when it took ownership. */
export interface ClaudeInboxEndpointIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: number;
}

/** Trusted, host-owned inputs for one current launch's inbox. */
export interface ClaudeInboxCapabilityInput {
  /** Host launch correlation id; echoed in results, never used for routing. */
  readonly launchId: string;
  /** Exact Claude `session_id` of the SessionStart that announced the inbox. */
  readonly sessionId: string;
  /**
   * Canonical (realpath) absolute Unix socket path announced for that session.
   * Every component must be a real directory in a protected namespace; see the
   * module comment.
   */
  readonly socketPath: string;
  readonly endpoint: ClaudeInboxEndpointIdentity;
  /** Hook token announced for that session. Secret. */
  readonly hookToken: string;
  /** Claude Code CLI version of this launch; must be a proven version. */
  readonly claudeVersion: string;
  /**
   * Host predicate: is this capability still the current owned launch/session?
   * Must be synchronous and nonblocking (an in-memory check): it runs on the
   * event loop and cannot be interrupted by the deadline or cancellation.
   */
  readonly isCurrent: () => boolean;
}

export type ClaudeInboxCapabilityRefusal =
  | "invalid_launch_id"
  | "invalid_session_id"
  | "invalid_socket_path"
  | "invalid_endpoint_identity"
  | "invalid_hook_token"
  | "unsupported_cli_version"
  | "invalid_current_predicate"
  /** Darwin only: the endpoint proof is not genuine, fresh, current, or for this path. */
  | "invalid_endpoint_proof";

/** Nothing was written to any endpoint. */
export type ClaudeInboxRefusedReason =
  | "invalid_capability"
  | "unsupported_platform"
  | "invalid_options"
  | "invalid_message"
  | "message_too_large"
  | "not_current"
  | "endpoint_unavailable"
  | "endpoint_mismatch"
  | "endpoint_unprotected"
  | "connect_failed"
  | "unexpected_reply"
  | "deadline_exceeded"
  | "cancelled";

/** Some bytes may have reached the peer. Never resend automatically. */
export type ClaudeInboxUnknownReason =
  | "disconnected"
  | "unexpected_reply"
  | "deadline_exceeded"
  | "cancelled";

export type ClaudeInboxSendResult =
  | {
    readonly disposition: "sent_unconfirmed";
    /** Always unconfirmed: the inbox socket returns no acknowledgment. */
    readonly placement: "unconfirmed";
    readonly launchId: string;
    readonly bytesWritten: number;
  }
  | { readonly disposition: "refused"; readonly reason: ClaudeInboxRefusedReason }
  | { readonly disposition: "unknown"; readonly reason: ClaudeInboxUnknownReason; readonly launchId: string };

export interface ClaudeInboxSendOptions {
  /** Whole-attempt deadline (connect, write, flush). */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

interface CapabilityState {
  readonly launchId: string;
  readonly sessionId: string;
  /**
   * The spelling every endpoint check names: the canonical Linux path, or the
   * announced Darwin path whose fixed alias (if any) each Darwin proof re-proves.
   */
  readonly socketPath: string;
  /** The only spelling ever connected to: `socketPath` on Linux, the proven canonical spelling on Darwin. */
  readonly connectPath: string;
  readonly rule: ClaudeInboxEndpointRule;
  readonly endpoint: ClaudeInboxEndpointIdentity;
  readonly hookToken: string;
  readonly isCurrent: () => boolean;
}

declare const capabilityBrand: unique symbol;
/** Opaque branded capability. Holds no enumerable or serializable secrets. */
export type ClaudeInboxSendCapability = { readonly [capabilityBrand]: true };

const capabilityState = new WeakMap<object, CapabilityState>();

/** #682 Windows: the host's commit port into one exact live custody binding; no secret. */
interface WindowsCustodyCapabilityState {
  readonly launchId: string;
  readonly sessionId: string;
  readonly isCurrent: () => boolean;
  readonly commit: ClaudeWindowsCustodyInboxCommit;
}

const windowsCustodyCapabilityState = new WeakMap<object, WindowsCustodyCapabilityState>();
const capabilityPrototype = Object.freeze({
  toJSON: (): string => "[ClaudeInboxSendCapability]",
  [Symbol.for("nodejs.util.inspect.custom")]: (): string => "[ClaudeInboxSendCapability]",
});

function mintCapability(state: CapabilityState): ClaudeInboxSendCapability {
  const capability = Object.freeze(Object.create(capabilityPrototype) as object);
  capabilityState.set(capability, state);
  return capability as ClaudeInboxSendCapability;
}

/**
 * #682 Windows: the host's synchronous commit port for ONE exact live custody
 * binding. It must make at most one commit of `payload` (never invoking it
 * otherwise) under the host's own binding fence, hand `writeBudget` to the
 * transport as its pre-write budget only (never as cancellation of the reply's
 * observation, which the host keeps for its own revocation), and never throw.
 */
export type ClaudeWindowsCustodyInboxCommit = (
  payload: NativeWindowsClaudeCustodySendPayloadSource,
  writeBudget: NativeWindowsClaudeCustodySendWriteBudget,
) => NativeWindowsClaudeCustodySendCommit;

/** #682 Windows: trusted host inputs for one exact live custody binding. No secret. */
export interface ClaudeWindowsCustodyInboxCapabilityInput {
  /** Host correlation id; echoed in results, never used for routing. */
  readonly launchId: string;
  /** Exact Claude `session_id` the binding was correlated and bound for. */
  readonly sessionId: string;
  /** This launch's verified Claude Code CLI version; must be a proven version. */
  readonly claudeVersion: string;
  /** Synchronous, in-memory host predicate for the exact live binding. */
  readonly isCurrent: () => boolean;
  readonly commit: ClaudeWindowsCustodyInboxCommit;
}

/**
 * #682 Windows: mint an opaque capability over one exact live custody binding.
 * Pure; no I/O. The same branded shape as every other capability, so a
 * look-alike is refused and nothing serializes.
 */
export function createClaudeWindowsCustodyInboxSendCapability(
  input: ClaudeWindowsCustodyInboxCapabilityInput,
): ClaudeInboxCapabilityResult {
  const refuse = (reason: ClaudeInboxCapabilityRefusal): ClaudeInboxCapabilityResult => ({ ok: false, reason });
  if (typeof input !== "object" || input === null) return refuse("invalid_launch_id");
  const { launchId, sessionId, claudeVersion, isCurrent, commit } = input;
  if (typeof launchId !== "string" || !LAUNCH_ID_PATTERN.test(launchId)) return refuse("invalid_launch_id");
  if (!isNativeConversationId(sessionId)) return refuse("invalid_session_id");
  if (typeof claudeVersion !== "string" || !isClaudeInboxSupportedCliVersion(claudeVersion)) {
    return refuse("unsupported_cli_version");
  }
  if (typeof isCurrent !== "function" || typeof commit !== "function") return refuse("invalid_current_predicate");
  const capability = Object.freeze(Object.create(capabilityPrototype) as object);
  windowsCustodyCapabilityState.set(capability, Object.freeze({ launchId, sessionId, isCurrent, commit }));
  return { ok: true, capability: capability as ClaudeInboxSendCapability };
}

export type ClaudeInboxCapabilityResult =
  | { readonly ok: true; readonly capability: ClaudeInboxSendCapability }
  | { readonly ok: false; readonly reason: ClaudeInboxCapabilityRefusal };

/** Validate trusted host inputs into a branded send capability. Pure; no I/O. */
export function createClaudeInboxSendCapability(input: ClaudeInboxCapabilityInput): ClaudeInboxCapabilityResult {
  const refuse = (reason: ClaudeInboxCapabilityRefusal): ClaudeInboxCapabilityResult => ({ ok: false, reason });
  if (typeof input !== "object" || input === null) return refuse("invalid_launch_id");
  const { launchId, sessionId, socketPath, endpoint, hookToken, claudeVersion, isCurrent } = input;
  if (typeof launchId !== "string" || !LAUNCH_ID_PATTERN.test(launchId)) return refuse("invalid_launch_id");
  if (!isNativeConversationId(sessionId)) return refuse("invalid_session_id");
  if (!isValidClaudeInboxSocketPath(socketPath)) return refuse("invalid_socket_path");
  if (!isValidEndpointIdentity(endpoint)) return refuse("invalid_endpoint_identity");
  if (!isValidClaudeInboxHookToken(hookToken)) return refuse("invalid_hook_token");
  if (typeof claudeVersion !== "string" || !isClaudeInboxSupportedCliVersion(claudeVersion)) {
    return refuse("unsupported_cli_version");
  }
  if (typeof isCurrent !== "function") return refuse("invalid_current_predicate");
  return {
    ok: true,
    capability: mintCapability(Object.freeze({
      launchId,
      sessionId,
      socketPath,
      connectPath: socketPath,
      rule: "linux",
      endpoint: Object.freeze({ dev: endpoint.dev, ino: endpoint.ino, uid: endpoint.uid }),
      hookToken,
      isCurrent,
    })),
  };
}

/**
 * #682: trusted host inputs for one current Darwin launch's inbox. The endpoint
 * identity and canonical spelling are never caller-supplied: they come only from
 * the Darwin proof handed in beside these inputs.
 */
export interface ClaudeDarwinInboxCapabilityInput extends Omit<ClaudeInboxCapabilityInput, "endpoint" | "socketPath"> {
  /** The announced absolute socket path, exactly as the proof was run for it. */
  readonly socketPath: string;
}

/**
 * #682: mint a Darwin inbox capability from one genuine endpoint proof. The proof
 * must come from {@linkcode proveClaudeInboxDarwinEndpoint} for exactly this
 * announced `socketPath` spelling (so a `/tmp` alias was itself proved), still be
 * readable (genuine, younger than its short maximum age, and current by its own
 * predicate), its canonical spelling must be exactly what the fixed spelling rule
 * derives from that path, and the caller's own predicate must be current now. The capability keeps the announced and the
 * canonical spelling plus the proven dev/ino/uid; it grants nothing by itself,
 * because every send re-proves the endpoint. Synchronous; no I/O.
 */
export function createClaudeDarwinInboxSendCapability(
  input: ClaudeDarwinInboxCapabilityInput,
  proof: ClaudeDarwinInboxEndpointProof,
): ClaudeInboxCapabilityResult {
  const refuse = (reason: ClaudeInboxCapabilityRefusal): ClaudeInboxCapabilityResult => ({ ok: false, reason });
  if (typeof input !== "object" || input === null) return refuse("invalid_launch_id");
  const { launchId, sessionId, socketPath, hookToken, claudeVersion, isCurrent } = input;
  if (typeof launchId !== "string" || !LAUNCH_ID_PATTERN.test(launchId)) return refuse("invalid_launch_id");
  if (!isNativeConversationId(sessionId)) return refuse("invalid_session_id");
  if (!isValidClaudeInboxSocketPath(socketPath)) return refuse("invalid_socket_path");
  if (!isValidClaudeInboxHookToken(hookToken)) return refuse("invalid_hook_token");
  if (typeof claudeVersion !== "string" || !isClaudeInboxSupportedCliVersion(claudeVersion)) {
    return refuse("unsupported_cli_version");
  }
  if (typeof isCurrent !== "function") return refuse("invalid_current_predicate");
  const canonicalPath = claudeDarwinInboxCanonicalSpelling(socketPath);
  if (canonicalPath === undefined) return refuse("invalid_socket_path");
  if (typeof proof !== "object" || proof === null || darwinProofSpelling.get(proof) !== socketPath) {
    return refuse("invalid_endpoint_proof");
  }
  const values = readClaudeDarwinInboxEndpointProof(proof);
  if (values === undefined || values.canonicalPath !== canonicalPath || !isValidEndpointIdentity(values.endpoint)) {
    return refuse("invalid_endpoint_proof");
  }
  if (!callCurrent(isCurrent)) return refuse("invalid_endpoint_proof");
  const { dev, ino, uid } = values.endpoint;
  return {
    ok: true,
    capability: mintCapability(Object.freeze({
      launchId,
      sessionId,
      socketPath,
      connectPath: canonicalPath,
      rule: "darwin",
      endpoint: Object.freeze({ dev, ino, uid }),
      hookToken,
      isCurrent,
    })),
  };
}

/** Test seam: replaces the endpoint lstat. Production uses `fs.promises.lstat` (bigint). */
export type ClaudeInboxLstat = (path: string) => Promise<BigIntStats>;
let lstatForTests: ClaudeInboxLstat | undefined;
export function setClaudeInboxLstatForTests(fn: ClaudeInboxLstat | undefined): void {
  lstatForTests = fn;
}

/** Test seam: replaces the Unix connector. Production uses `net.createConnection`. */
export type ClaudeInboxConnector = (socketPath: string) => Duplex;
let connectorForTests: ClaudeInboxConnector | undefined;
export function setClaudeInboxConnectorForTests(connector: ClaudeInboxConnector | undefined): void {
  connectorForTests = connector;
}
let platformForTests: NodeJS.Platform | undefined;
export function setClaudeInboxPlatformForTests(platform: NodeJS.Platform | undefined): void {
  platformForTests = platform;
}

/**
 * Test seam: the Darwin proof's filesystem, uid, and ACL-listing seams. The
 * proof's platform is always this module's own platform (including the
 * {@linkcode setClaudeInboxPlatformForTests} override); production passes none.
 */
export type ClaudeInboxDarwinProofSeams = Pick<ClaudeDarwinInboxProofOptions, "fs" | "getuid" | "aclExecutor">;
let darwinProofSeamsForTests: ClaudeInboxDarwinProofSeams | undefined;
export function setClaudeInboxDarwinProofSeamsForTests(seams: ClaudeInboxDarwinProofSeams | undefined): void {
  darwinProofSeamsForTests = seams;
}

/** The exact announced spelling each proof from {@linkcode proveClaudeInboxDarwinEndpoint} was run for. */
const darwinProofSpelling = new WeakMap<object, string>();

function currentPlatform(): NodeJS.Platform {
  return platformForTests ?? process.platform;
}

/**
 * #682: the endpoint rule a new capability on this host would be checked by, or
 * `undefined` where no inbox endpoint can be proved. Trusted host code picks its
 * binding path from this; it grants nothing.
 */
export function claudeInboxEndpointRule(): ClaudeInboxEndpointRule | undefined {
  const platform = currentPlatform();
  if (CLAUDE_INBOX_SUPPORTED_PLATFORMS.includes(platform)) return "linux";
  return platform === CLAUDE_INBOX_DARWIN_PLATFORM ? "darwin" : undefined;
}

/**
 * #682: run the Darwin endpoint proof for one announced socket on this host
 * (see ./native-claude-darwin-inbox-endpoint). The trusted host calls it once
 * before {@linkcode createClaudeDarwinInboxSendCapability}; the sender calls it
 * again around every connect. Never throws; never retries; logs nothing.
 */
export function proveClaudeInboxDarwinEndpoint(
  request: {
    readonly socketPath: string;
    readonly expectedEndpoint?: ClaudeInboxEndpointIdentity;
    readonly isCurrent: () => boolean;
  },
  options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ClaudeDarwinInboxProofResult> {
  const socketPath = typeof request === "object" && request !== null ? request.socketPath : undefined;
  return proveClaudeDarwinInboxEndpoint(request, {
    ...darwinProofSeamsForTests,
    ...options,
    platform: currentPlatform(),
  }).then((result) => {
    if (result.ok && typeof socketPath === "string") darwinProofSpelling.set(result.proof, socketPath);
    return result;
  });
}

/**
 * Send one user message through an owned Claude inbox. Never throws, never
 * retries, never reports delivery. See {@link ClaudeInboxSendResult}.
 */
export function sendClaudeInboxMessage(
  capability: ClaudeInboxSendCapability,
  text: string,
  options: ClaudeInboxSendOptions = {},
): Promise<ClaudeInboxSendResult> {
  // One monotonic budget for the whole attempt, including host preflight.
  const startedAt = performance.now();
  const refused = (reason: ClaudeInboxRefusedReason): Promise<ClaudeInboxSendResult> =>
    Promise.resolve(Object.freeze({ disposition: "refused", reason }));

  const windows = windowsCustodyCapabilityState.get(capability);
  if (windows !== undefined) return sendWindowsCustody(windows, text, options);
  const state = capabilityState.get(capability);
  if (state === undefined) return refused("invalid_capability");
  // Each capability is usable only on the platform whose rule proved it.
  if (claudeInboxEndpointRule() !== state.rule || typeof process.getuid !== "function") {
    return refused("unsupported_platform");
  }
  if (typeof options !== "object" || options === null) return refused("invalid_options");
  const deadlineMs = options.deadlineMs ?? CLAUDE_INBOX_DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < CLAUDE_INBOX_MIN_DEADLINE_MS || deadlineMs > CLAUDE_INBOX_MAX_DEADLINE_MS) {
    return refused("invalid_options");
  }
  const expiresAt = startedAt + deadlineMs;
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return refused("invalid_options");
  if (signal?.aborted) return refused("cancelled");
  if (typeof text !== "string" || text.length === 0) return refused("invalid_message");
  // Bound work before scanning: UTF-16 length never exceeds the UTF-8 byte
  // length, so a longer string is oversize without inspecting its contents.
  if (text.length > CLAUDE_INBOX_MAX_TEXT_BYTES) return refused("message_too_large");
  if (!isWellFormedText(text)) return refused("invalid_message");
  if (Buffer.byteLength(text, "utf8") > CLAUDE_INBOX_MAX_TEXT_BYTES) return refused("message_too_large");
  if (!stillCurrent(state)) return refused("not_current");

  let payload: Buffer;
  try {
    const auth = encodeFrame({ type: "auth", token: state.hookToken });
    const user = encodeFrame({ type: "user", session_id: state.sessionId, message: { role: "user", content: text } });
    if (auth === undefined || user === undefined) return refused("message_too_large");
    payload = Buffer.concat([auth, user]);
  } catch {
    return refused("invalid_message");
  }

  return transmit(state, payload, expiresAt, signal);
}

/**
 * #682 Windows: the same message, option, currency, and whole-attempt deadline
 * checks as every send, then exactly one commit through the host's custody
 * port. The shared monotonic deadline starts at entry. Before the write, the
 * absolute expiry and the caller's signal travel as the transport's pre-write
 * budget, checked at its final write fence (an expired attempt writes
 * nothing). After the write, only the CALLER's wait stops at expiry or
 * cancellation (`unknown`): the transport keeps observing the exact reply, so
 * the host still sees it, and a reply processed at or after expiry is never
 * credited. Never throws.
 */
function sendWindowsCustody(
  state: WindowsCustodyCapabilityState,
  text: string,
  options: ClaudeInboxSendOptions,
): Promise<ClaudeInboxSendResult> {
  const startedAt = performance.now();
  const refused = (reason: ClaudeInboxRefusedReason): Promise<ClaudeInboxSendResult> =>
    Promise.resolve(Object.freeze({ disposition: "refused", reason }));
  const unknown = (reason: ClaudeInboxUnknownReason): ClaudeInboxSendResult =>
    Object.freeze({ disposition: "unknown", reason, launchId: state.launchId });
  if (currentPlatform() !== "win32") return refused("unsupported_platform");
  if (typeof options !== "object" || options === null) return refused("invalid_options");
  const deadlineMs = options.deadlineMs ?? CLAUDE_INBOX_DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < CLAUDE_INBOX_MIN_DEADLINE_MS || deadlineMs > CLAUDE_INBOX_MAX_DEADLINE_MS) {
    return refused("invalid_options");
  }
  const expiresAt = startedAt + deadlineMs;
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return refused("invalid_options");
  /** The caller's own cancellation wins; then the monotonic expiry. */
  const interruption = (): "cancelled" | "deadline_exceeded" | undefined =>
    signal?.aborted ? "cancelled" : performance.now() >= expiresAt ? "deadline_exceeded" : undefined;
  if (signal?.aborted) return refused("cancelled");
  if (typeof text !== "string" || text.length === 0) return refused("invalid_message");
  if (text.length > CLAUDE_INBOX_MAX_TEXT_BYTES) return refused("message_too_large");
  if (!isWellFormedText(text)) return refused("invalid_message");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CLAUDE_INBOX_MAX_TEXT_BYTES) return refused("message_too_large");
  if (!callCurrent(state.isCurrent)) return refused("not_current");
  const beforeCommit = interruption();
  if (beforeCommit !== undefined) return refused(beforeCommit);

  let commit: NativeWindowsClaudeCustodySendCommit;
  try {
    commit = state.commit(() => text, Object.freeze({ expiresAt, ...(signal === undefined ? {} : { signal }) }));
  } catch {
    // The port may have handed a frame over before faulting: never `refused`.
    return Promise.resolve(unknown(interruption() ?? "disconnected"));
  }
  if (typeof commit !== "object" || commit === null) return Promise.resolve(unknown("disconnected"));
  if (commit.status === "not-sent") return refused(interruption() ?? windowsCustodyRefusal(commit.code));
  if (commit.status !== "dispatched") return Promise.resolve(unknown("disconnected"));

  const reply = Promise.resolve(commit.outcome).then(
    (outcome): ClaudeInboxSendResult => {
      // A reply processed at or after expiry (or after cancellation) is never credited.
      const stopped = interruption();
      if (stopped !== undefined) return unknown(stopped);
      if (outcome?.status === "sent-unconfirmed") {
        return Object.freeze({ disposition: "sent_unconfirmed", placement: "unconfirmed", launchId: state.launchId, bytesWritten: bytes });
      }
      if (outcome?.status === "not-sent") return Object.freeze({ disposition: "refused", reason: windowsCustodyNotSent(outcome.code) });
      return unknown(outcome?.status === "unknown" ? windowsCustodyUnknown(outcome.code) : "disconnected");
    },
    () => unknown(interruption() ?? "disconnected"),
  );
  // The frame was handed over: from here only the caller's wait may stop early.
  const afterCommit = interruption();
  if (afterCommit !== undefined) return Promise.resolve(unknown(afterCommit));
  let timer: NodeJS.Timeout | undefined;
  let subscription: Disposable | undefined;
  const stopped = new Promise<ClaudeInboxSendResult>((resolve) => {
    timer = setTimeout(
      () => resolve(unknown(interruption() ?? "deadline_exceeded")),
      Math.max(1, Math.ceil(expiresAt - performance.now())),
    );
    if (signal !== undefined) subscription = addAbortListener(signal, () => resolve(unknown("cancelled")));
  });
  return Promise.race([reply, stopped]).finally(() => {
    clearTimeout(timer);
    subscription?.[Symbol.dispose]();
  });
}

/** A typed pre-write refusal of the custody commit: nothing was written. */
function windowsCustodyRefusal(code: NativeWindowsClaudeCustodySendRefusal): ClaudeInboxRefusedReason {
  switch (code) {
    case "deadline-exceeded":
      return "deadline_exceeded";
    case "payload-invalid":
      return "invalid_message";
    case "cancelled":
      return "cancelled";
    case "attempt-in-flight":
    case "control-busy":
    case "lane-unavailable":
      return "endpoint_unavailable";
    default:
      return "not_current";
  }
}

/** The supervisor's typed refusal before its writer wrote anything. */
function windowsCustodyNotSent(
  code: Extract<NativeWindowsClaudeCustodySendOutcome, { status: "not-sent" }>["code"],
): ClaudeInboxRefusedReason {
  switch (code) {
    case "peer":
      return "endpoint_mismatch";
    case "limit":
      // The supervisor's fixed writer reports LIMIT only for its own not-sent
      // timeout or cancellation, never for size (size is validated above).
      return "deadline_exceeded";
    case "other":
      return "endpoint_unavailable";
    default:
      return "not_current";
  }
}

/** Anything after the frame was handed over: some bytes may have reached the peer. */
function windowsCustodyUnknown(
  code: Extract<NativeWindowsClaudeCustodySendOutcome, { status: "unknown" }>["code"],
): ClaudeInboxUnknownReason {
  if (code === "cancelled") return "cancelled";
  if (code === "timeout") return "deadline_exceeded";
  return "disconnected";
}

function transmit(
  state: CapabilityState,
  payload: Buffer,
  expiresAt: number,
  signal: AbortSignal | undefined,
): Promise<ClaudeInboxSendResult> {
  return new Promise((resolve) => {
    let settled = false;
    let writeStarted = false;
    // Monotonic expiry (budget started at entry), checked synchronously before
    // each lookup, before connecting, and at the write and success points, so
    // synchronous host code cannot outrun the timer callback.
    const expired = (): boolean => performance.now() >= expiresAt;
    let socket: Duplex | undefined;
    let abortSubscription: Disposable | undefined;
    // Ends with the attempt, so an in-flight Darwin proof (and its listing
    // child) never outlives it.
    const lifetime = new AbortController();

    const finish = (result: ClaudeInboxSendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSubscription?.[Symbol.dispose]();
      lifetime.abort();
      if (socket !== undefined) {
        socket.removeAllListeners("data");
        socket.on("error", () => undefined);
        socket.destroy();
      }
      resolve(Object.freeze(result));
    };
    // Before the first write nothing can have reached the peer (refused);
    // afterwards any failure leaves the outcome unknown.
    const fail = (reason: ClaudeInboxUnknownReason): void => {
      finish(writeStarted
        ? { disposition: "unknown", reason, launchId: state.launchId }
        : { disposition: "refused", reason: reason === "disconnected" ? "connect_failed" : reason });
    };
    /** True when the attempt may continue; otherwise it has been settled. */
    const mayContinue = (): boolean => {
      if (settled) return false;
      if (signal?.aborted) {
        fail("cancelled");
        return false;
      }
      if (expired()) {
        fail("deadline_exceeded");
        return false;
      }
      return true;
    };
    const onAbort = (): void => fail("cancelled");
    const timer = setTimeout(() => fail("deadline_exceeded"), Math.max(1, Math.ceil(expiresAt - performance.now())));
    // addAbortListener runs even if an earlier listener on a shared signal
    // calls stopImmediatePropagation, so cancellation cannot be suppressed.
    if (signal !== undefined) abortSubscription = addAbortListener(signal, onAbort);

    const write = (active: Duplex): void => {
      writeStarted = true;
      active.once("finish", () => {
        if (settled) return;
        if (expired()) {
          fail("deadline_exceeded");
          return;
        }
        finish({
          disposition: "sent_unconfirmed",
          placement: "unconfirmed",
          launchId: state.launchId,
          bytesWritten: payload.length,
        });
      });
      try {
        active.end(payload);
      } catch {
        fail("disconnected");
      }
    };

    const connect = (): void => {
      let active: Duplex;
      try {
        active = (connectorForTests ?? defaultConnector)(state.connectPath);
      } catch {
        finish({ disposition: "refused", reason: "connect_failed" });
        return;
      }
      socket = active;
      active.on("error", () => fail("disconnected"));
      active.on("close", () => fail("disconnected"));
      // The evidenced inbox writes zero reply bytes; any byte means this is not
      // the proven endpoint behavior.
      active.on("data", () => fail("unexpected_reply"));
      active.once("connect", () => {
        if (!mayContinue()) return;
        // Re-check after connect: the path must still name the owned endpoint
        // and the capability must still be current before any byte is written.
        void verifyEndpoint(state, mayContinue, expiresAt, lifetime.signal).then((recheck) => {
          if (recheck === "stopped" || !mayContinue()) return;
          if (recheck !== undefined) {
            finish({ disposition: "refused", reason: recheck });
            return;
          }
          if (!stillCurrent(state)) {
            finish({ disposition: "refused", reason: "not_current" });
            return;
          }
          // isCurrent is synchronous host code that may abort the signal
          // (settling via onAbort) or run past the deadline before the timer
          // can fire. Recheck everything immediately before the first byte.
          if (!mayContinue()) return;
          write(active);
        });
      });
    };

    // An abort raised before subscribing (e.g. synchronously from isCurrent)
    // would never fire the listener, and preflight may have spent the budget:
    // recheck both before the first lookup.
    if (!mayContinue()) return;
    // Endpoint lookups are asynchronous so a stalled filesystem cannot block
    // the event loop past the deadline or cancellation; a lookup that settles
    // after the attempt has finished is ignored, and the walk stops after each
    // in-flight lookup instead of starting another one.
    void verifyEndpoint(state, mayContinue, expiresAt, lifetime.signal).then((refusal) => {
      if (refusal === "stopped" || !mayContinue()) return;
      if (refusal !== undefined) {
        finish({ disposition: "refused", reason: refusal });
        return;
      }
      connect();
    });
  });
}

function defaultConnector(socketPath: string): Duplex {
  return createConnection({ path: socketPath, allowHalfOpen: false });
}

function stillCurrent(state: CapabilityState): boolean {
  return callCurrent(state.isCurrent);
}

function callCurrent(isCurrent: () => boolean): boolean {
  try {
    return isCurrent() === true;
  } catch {
    return false;
  }
}

type EndpointRefusal = "endpoint_unavailable" | "endpoint_mismatch" | "endpoint_unprotected";
/** A Darwin proof can also end on currency, time, or cancellation before any byte. */
type DarwinEndpointRefusal = EndpointRefusal | "not_current" | "deadline_exceeded" | "cancelled";

function lstatBig(path: string): Promise<BigIntStats> {
  return lstatForTests !== undefined ? lstatForTests(path) : lstat(path, { bigint: true });
}

/**
 * `"stopped"`: the attempt settled or expired while a lookup was in flight; the
 * walk started no further lookup. Callers treat it as terminal, never as a pass.
 */
type EndpointCheck = EndpointRefusal | "stopped" | undefined;
type VerifiedEndpoint = DarwinEndpointRefusal | "stopped" | undefined;

/** The capability's own rule: the unchanged Linux check, or a full Darwin re-proof. */
function verifyEndpoint(
  state: CapabilityState,
  mayContinue: () => boolean,
  expiresAt: number,
  signal: AbortSignal,
): Promise<VerifiedEndpoint> {
  return state.rule === "darwin"
    ? checkDarwinEndpoint(state, mayContinue, expiresAt, signal)
    : checkEndpoint(state, mayContinue);
}

/**
 * Re-run the whole Darwin proof for the announced spelling, bound to the exact
 * captured dev/ino/uid, inside the attempt's remaining budget. Too little budget
 * for a proof is a deadline refusal, never a skipped check. The fresh proof must
 * name the same canonical spelling the capability connects to.
 */
async function checkDarwinEndpoint(
  state: CapabilityState,
  mayContinue: () => boolean,
  expiresAt: number,
  signal: AbortSignal,
): Promise<VerifiedEndpoint> {
  const remaining = Math.floor(expiresAt - performance.now());
  if (remaining < CLAUDE_DARWIN_PROOF_MIN_DEADLINE_MS) return "deadline_exceeded";
  let result: ClaudeDarwinInboxProofResult;
  try {
    result = await proveClaudeInboxDarwinEndpoint(
      { socketPath: state.socketPath, expectedEndpoint: state.endpoint, isCurrent: state.isCurrent },
      { deadlineMs: Math.min(remaining, CLAUDE_DARWIN_PROOF_MAX_DEADLINE_MS), signal },
    );
  } catch {
    return "endpoint_unprotected";
  }
  if (!mayContinue()) return "stopped";
  if (!result.ok) return darwinRefusal(result.reason);
  const values = readClaudeDarwinInboxEndpointProof(result.proof);
  if (values === undefined) return stillCurrent(state) ? "endpoint_mismatch" : "not_current";
  const { endpoint } = values;
  if (values.canonicalPath !== state.connectPath || endpoint.dev !== state.endpoint.dev
    || endpoint.ino !== state.endpoint.ino || endpoint.uid !== state.endpoint.uid) {
    return "endpoint_mismatch";
  }
  return undefined;
}

/** Fixed mapping of the Darwin proof's codes onto this module's refusals. */
function darwinRefusal(reason: ClaudeDarwinInboxProofRefusal): DarwinEndpointRefusal {
  switch (reason) {
    case "not_current":
    case "deadline_exceeded":
    case "cancelled":
    case "endpoint_unavailable":
    case "endpoint_mismatch":
      return reason;
    case "endpoint_replaced":
      return "endpoint_mismatch";
    default:
      // Unprotected namespace, refused alias, untrusted or unprovable ACL,
      // listing failure, or a malformed request: never shown stable.
      return "endpoint_unprotected";
  }
}

async function checkEndpoint(state: CapabilityState, mayContinue: () => boolean): Promise<EndpointCheck> {
  const uid = process.getuid?.();
  if (uid === undefined) return "endpoint_mismatch";
  let stats: BigIntStats;
  try {
    stats = await lstatBig(state.socketPath);
  } catch {
    return "endpoint_unavailable";
  }
  if (!mayContinue()) return "stopped";
  if (!stats.isSocket()) return "endpoint_mismatch";
  if (stats.uid !== BigInt(uid) || stats.uid !== BigInt(state.endpoint.uid)) return "endpoint_mismatch";
  if (stats.dev !== state.endpoint.dev || stats.ino !== state.endpoint.ino) return "endpoint_mismatch";
  return checkProtectedNamespace(state.socketPath, BigInt(uid), stats.uid, mayContinue);
}

const S_IWGRP = 0o020n;
const S_IWOTH = 0o002n;
const S_ISVTX = 0o1000n;

/**
 * Establish that only root or the current user can replace the socket entry:
 * walk every ancestor from `/` down. Each must be a real directory (no symlink)
 * owned by root or the current user; a group/world-writable ancestor must be
 * sticky and its child entry owned by root or the current user.
 */
async function checkProtectedNamespace(
  socketPath: string,
  uid: bigint,
  socketUid: bigint,
  mayContinue: () => boolean,
): Promise<EndpointCheck> {
  const trusted = (owner: bigint): boolean => owner === 0n || owner === uid;
  const parts = socketPath.split("/").filter((part) => part.length > 0);
  const ancestors: string[] = ["/"];
  for (let index = 0; index < parts.length - 1; index += 1) {
    ancestors.push(`/${parts.slice(0, index + 1).join("/")}`);
  }
  let previous: BigIntStats | undefined;
  for (const directory of ancestors) {
    let stats: BigIntStats;
    try {
      stats = await lstatBig(directory);
    } catch {
      return "endpoint_unavailable";
    }
    if (!mayContinue()) return "stopped";
    if (!stats.isDirectory() || !trusted(stats.uid)) return "endpoint_unprotected";
    if (previous !== undefined && !childProtected(previous, stats.uid, trusted)) return "endpoint_unprotected";
    previous = stats;
  }
  if (previous === undefined || !childProtected(previous, socketUid, trusted)) return "endpoint_unprotected";
  return undefined;
}

function childProtected(parent: BigIntStats, childUid: bigint, trusted: (owner: bigint) => boolean): boolean {
  if ((parent.mode & (S_IWGRP | S_IWOTH)) === 0n) return true;
  return (parent.mode & S_ISVTX) !== 0n && trusted(childUid);
}

/** One NDJSON line of the proven 2.1.330 inbox format; key order is fixed by the literal. */
function encodeFrame(frame: object): Buffer | undefined {
  const line = JSON.stringify(frame);
  // JSON.stringify escapes every line terminator inside strings; a raw newline
  // here would split the frame, so refuse rather than send.
  if (line.includes("\n") || line.includes("\r")) throw new Error("frame contains a line terminator");
  const bytes = Buffer.from(`${line}\n`, "utf8");
  return bytes.length > CLAUDE_INBOX_MAX_FRAME_BYTES ? undefined : bytes;
}

/** Pure syntactic socket-path rule shared with the hook-side announcement reader. */
export function isValidClaudeInboxSocketPath(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && value !== "/"
    && !value.endsWith("/")
    && !value.includes("\0")
    && posixPath.normalize(value) === value
    && Buffer.byteLength(value, "utf8") <= CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES;
}

function isValidEndpointIdentity(value: unknown): value is ClaudeInboxEndpointIdentity {
  if (typeof value !== "object" || value === null) return false;
  const { dev, ino, uid } = value as Record<string, unknown>;
  return typeof dev === "bigint" && dev >= 0n
    && typeof ino === "bigint" && ino > 0n
    && typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0;
}

/** The token is opaque: no provider alphabet or length is assumed. */
export function isValidClaudeInboxHookToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES
    && isWellFormedText(value)
    && Buffer.byteLength(value, "utf8") <= CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES;
}

/** Refuse lone UTF-16 surrogates, which cannot be encoded faithfully as UTF-8. */
function isWellFormedText(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}
