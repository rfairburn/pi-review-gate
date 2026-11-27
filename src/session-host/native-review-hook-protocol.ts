/**
 * #736 slice 2: closed broker wire family for the BLOCKING native review lane.
 *
 * A hosted native Claude Code or Codex row runs one command hook on its `Stop`
 * and `UserPromptSubmit` events. That hook is the relay in
 * ./native-review-hook-relay: it connects to the host's ONE existing local
 * status broker (POSIX Unix socket or Windows named pipe — never a second
 * listener or address), authenticates with a per-owned-launch bootstrap the
 * host issued before that child spawned, sends exactly ONE request line, and
 * waits for the host's review verdict. This module is the framing contract both
 * ends share.
 *
 * This is a deliberately SEPARATE family from the Pi reporter contract
 * (./protocol), from the observe-only one-shot hooks (./native-hook-protocol),
 * and from the native MCP tool lane (./native-mcp-protocol): different frame
 * types, its own record/token map in the broker, and an independent token. The
 * observer family's invariant — a hook observer never authorizes, denies, or
 * blocks — is untouched here. THIS is the one family whose answer changes what
 * the provider does with a turn, which is exactly why it owns its own token and
 * its own bootstrap environment marker: a row's observer token can never be
 * mistaken for verdict authority, and vice versa.
 *
 * Wire shape (newline-delimited JSON, every field closed and strictly typed):
 *
 * - relay -> broker, the ONE and only client line, authenticated by this
 *   family's own strict decoder (never inside Pi hello/status semantics):
 *   `native_review_request` {instanceId, generation, backend, token, event,
 *   sessionId, turnId?, stopHookActive?, backgroundTasks?,
 *   lastAssistantMessage?, prompt?, cwd?}. One line IS the whole request: the broker
 *   validates the complete decoded line before it clears the shared pre-auth
 *   deadline or reserves a review slot, so no partial request can hold either.
 *   A real `Stop` payload carries the assistant's answer text, so this family's
 *   line is larger than the legacy Pi/hook/MCP frame bounds; the broker
 *   therefore reads a request line under THIS family's own bound while every
 *   legacy frame limit and the pre-auth deadline stay exactly as they were, and
 *   this module's decoder still refuses anything over its own bound.
 * - broker -> relay, exactly one frame per authenticated request:
 *   `native_review_response` {action:"allow"|"block", reason?, userMessage?}
 *   or `native_review_error` {code:"busy"|"unavailable"|"failed"}.
 *
 * The connection is HELD open between those two frames — that is the family's
 * whole point — so the broker aborts the handler's signal when the socket
 * closes first, and the provider's own command-hook timeout (or the user
 * pressing Esc) is what ends a wait the host cannot finish. There is no
 * broker-side deadline on the held answer, and the relay imposes no deadline
 * that could cut a legitimately slow review short; its own backstop sits
 * INSIDE the provider's hook timeout (NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS below)
 * and exists only so an orphaned relay can never wait past the hook that
 * spawned it. There is still no queue, retry, replay, or second request on a
 * connection.
 *
 * Privacy contract (closed field set): only the provider field names named
 * below may cross the wire. The transcript path, tool names, arguments,
 * results, and every other provider field are never selected, stored, or
 * relayed: the relay selects the allowlist BEFORE it builds a
 * frame, and the broker's strict decoder rebuilds the request from the same
 * closed key set, so an extra field cannot reach the host callback. Prompt
 * text is the ONE exception and it is event-scoped: a `UserPromptSubmit`
 * request may carry the prompt the user is submitting, because the reviewer
 * cannot judge a turn it cannot see — the assistant answer is not written yet,
 * so the request IS the work under review. It is bounded message text with the
 * same rules as `lastAssistantMessage`, it travels only over this same
 * authenticated local broker connection (Unix socket or local named pipe,
 * per-launch token, never a network listener), and it is refused outright on a
 * `Stop` request, where the review already has the assistant's answer. Every
 * other event still has no path for prompt text. Identifiers
 * and paths are bounded strict text (no C0/DEL/C1 controls other than the
 * tab/CR/LF a real assistant message or review reason contains, and a fixed
 * UTF-8 byte cap). `backgroundTasks` is not a new shape: it is the SAME
 * validated membership projection the observer lane derives from a Claude
 * `background_tasks` snapshot (./native-hook-protocol
 * `deriveNativeHookBackgroundSnapshot`), with the same limits, so one provider
 * array is never described by two contracts.
 *
 * Delivery versus completion: `busy` means the host refused before reviewing
 * anything; `unavailable` means this host cannot answer right now; `failed`
 * means the review was attempted and produced no usable verdict. A connection
 * that closes mid-wait leaves both unknown. The relay maps every failure to one
 * user-visible "this turn was not reviewed" notice and NEVER blocks: a
 * transport failure must never loop a provider turn.
 *
 * The one exception to that notice rule is a relay that discovers its OWN
 * provider parent is gone: nobody is left to read a notice, so it destroys the
 * held connection (which aborts the host's review), writes nothing, and exits
 * zero. The same abandonment happens at the relay's own backstop deadline below.
 */

import { isAbsolute } from "node:path";
import { isRecord } from "../record-guard";
import {
  MAX_NATIVE_HOOK_MEMBERS_ID_BYTES,
  MAX_NATIVE_HOOK_BACKGROUND_TASKS,
  NATIVE_HOOK_BACKGROUND_KINDS,
  deriveNativeHookBackgroundSnapshot,
  parseNativeHookBackgroundMembers,
  type NativeHookBackgroundMember,
} from "./native-hook-protocol";
import { isNativeMcpLocalPipeAddress, isValidNativeBrokerSocketPath } from "./native-mcp-protocol";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

/**
 * Narrow child-environment marker carrying one owned launch's native review
 * bootstrap JSON. It is a SEPARATE marker from the observer family's
 * `PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP`, so a row that has both kinds of hook
 * never shares a secret between an observer and a verdict authority. The
 * per-owned-launch value is injected only into the child that runs this hook;
 * keeping it in the environment (never in provider hook command text) is what
 * lets a Codex command string stay byte-stable across rows.
 */
export const NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV = "PI_REVIEW_GATE_NATIVE_REVIEW_BOOTSTRAP";

export const NATIVE_REVIEW_HOOK_PROTOCOL_VERSION = 1;

/**
 * How long the provider may wait for one review hook attempt. This is the
 * provider-side ceiling on the ONE held request, and it is what makes a
 * reviewed turn's pause finite: an automatic review may legitimately take
 * minutes, so the ceiling is a full hour, and the user's own Esc (or the
 * provider killing the hook) stays the interactive out.
 *
 * It lives in this shared module because BOTH ends of the lane are bounded by
 * it: the launch preparation stamps it on the provider's hook handler
 * (./native-review-hook-launch-prep re-exports it unchanged), the relay runs its
 * own backstop a little inside it (./native-review-hook-relay), and the host's
 * coordinator aborts its review inside that (./native-review-coordinator) — so a
 * review can never outlive the hook that is waiting for it and answer nobody.
 */
export const NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS = 3600;

/** Maximum bootstrap JSON accepted from the child-environment marker. */
export const MAX_NATIVE_REVIEW_BOOTSTRAP_ENV_BYTES = 4096;

/**
 * Maximum provider hook stdin document read by the relay. A Stop payload
 * carries the assistant's last message, so this mirrors the observer lane's
 * one-megabyte observation bound: an oversized document becomes a closed
 * unavailable reason instead of an unbounded read.
 */
export const MAX_NATIVE_REVIEW_STDIN_BYTES = 1_048_576;

/** Maximum UTF-8 bytes of the conversation id or one turn id. */
export const MAX_NATIVE_REVIEW_ID_BYTES = 256;

/** Maximum UTF-8 bytes of the provider's own working directory. */
export const MAX_NATIVE_REVIEW_CWD_BYTES = 4096;

/**
 * Maximum UTF-8 bytes of the assistant message the provider reports last — the
 * text the host is asked to review. It rides inside the single request line, so
 * this family's request bound is derived from it.
 */
export const MAX_NATIVE_REVIEW_MESSAGE_BYTES = 64 * 1024;

/**
 * Maximum UTF-8 bytes of the user prompt a `UserPromptSubmit` request may
 * carry. It is bounded like the reviewed assistant message (multi-line allowed,
 * same message-text rules) because it rides inside the same single request
 * line. A `Stop` request never carries it, so this bound only ever applies to
 * the one event that needs the prompt to review against.
 */
export const MAX_NATIVE_REVIEW_PROMPT_BYTES = 64 * 1024;

/** Maximum UTF-8 bytes of a block reason the host shows the provider's model. */
export const MAX_NATIVE_REVIEW_REASON_BYTES = 256 * 1024;

/** Maximum UTF-8 bytes of the one-line notice the host shows the user. */
export const MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES = 4 * 1024;

/**
 * Maximum request line, newline included — the whole request, in one line.
 * Nothing admitted escapes to more than twice its UTF-8 length (`"`, `\`, the
 * tab/CR/LF a real assistant message contains, and a lone surrogate), so twice
 * the provider-text, path, and identifier bounds plus the closed
 * background-membership remainder (aggregate id bytes doubled, plus per-member
 * framing) plus the fixed key/token/version remainder is a provable bound for
 * everything this decoder admits. The focused suite asserts that a request built
 * at every bound at once still encodes inside it.
 *
 * This is THIS family's own bound. It is larger than the legacy Pi/hook/MCP
 * frame bounds because a review request carries the assistant's answer text; the
 * broker reads a review request under this bound and never raises the legacy
 * families' limits or the pre-auth deadline, and this decoder still refuses an
 * over-bound line rather than truncating it.
 */
export const MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES
  = 2 * (MAX_NATIVE_REVIEW_MESSAGE_BYTES + MAX_NATIVE_REVIEW_PROMPT_BYTES
    + MAX_NATIVE_REVIEW_CWD_BYTES + 2 * MAX_NATIVE_REVIEW_ID_BYTES)
    + 2 * MAX_NATIVE_HOOK_MEMBERS_ID_BYTES
    + MAX_NATIVE_HOOK_BACKGROUND_TASKS * 32
    + 1_024;

/** Maximum verdict or error frame, newline included; same escape arithmetic. */
export const MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES
  = 2 * (MAX_NATIVE_REVIEW_REASON_BYTES + MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES)
    + 1024;

/**
 * The only provider events this lane answers. `Stop` continues the same turn
 * with the reason as model-visible feedback; `UserPromptSubmit` blocks the
 * prompt. Adding another event is a protocol change, not a relay option.
 */
export const NATIVE_REVIEW_HOOK_EVENTS = Object.freeze(["Stop", "UserPromptSubmit"] as const);

export type NativeReviewHookEventName = (typeof NATIVE_REVIEW_HOOK_EVENTS)[number];

/** Closed error codes the broker may answer; see the module comment. */
export const NATIVE_REVIEW_ERROR_CODES = Object.freeze(["busy", "unavailable", "failed"] as const);

export type NativeReviewErrorCode = (typeof NATIVE_REVIEW_ERROR_CODES)[number];

/**
 * Closed short reasons the RELAY may print in its "not reviewed" notice. They
 * describe the transport attempt only: never provider content, never a token,
 * never a path, and never a host-side diagnostic.
 */
export const NATIVE_REVIEW_UNAVAILABLE_REASONS = Object.freeze([
  "unconfigured",
  "event-mismatch",
  "input-malformed",
  "input-too-large",
  "input-not-utf8",
  "input-invalid",
  "input-timeout",
  "input-unavailable",
  "unreachable",
  "closed",
  "response-invalid",
  "busy",
  "unavailable",
  "failed",
  "error",
] as const);

export type NativeReviewUnavailableReason = (typeof NATIVE_REVIEW_UNAVAILABLE_REASONS)[number];

/**
 * One owned launch's native review bootstrap. It is returned before the native
 * child spawns and is invalidated by that registration's release or the
 * broker's disposal. Its key set is the same closed shape as the observer
 * family's bootstrap on purpose — the families are separated by the marker
 * name and by an independent token, and their wire frame types are disjoint —
 * so the address/identity/backend validation rules are identical.
 */
export interface NativeReviewBootstrap {
  version: 1;
  /** Existing broker endpoint (POSIX Unix socket or local Windows named pipe). */
  socketPath: string;
  generation: string;
  instanceId: string;
  backend: NativeCliBackend;
  token: string;
}

/** One authenticated review request on the wire. */
export interface NativeReviewRequestFrame {
  readonly version: 1;
  readonly type: "native_review_request";
  readonly instanceId: string;
  readonly generation: string;
  readonly backend: NativeCliBackend;
  readonly token: string;
  readonly event: NativeReviewHookEventName;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly stopHookActive?: boolean;
  /**
   * The provider's background snapshot in the observer lane's own membership
   * form (same entry shape, same per-array and aggregate id-byte limits): `[]`
   * is a positively observed empty in-flight set, and absence means the
   * provider omitted the array or an active entry carried no usable id — never
   * a shortened view. It is native provider observation only, never Pi
   * `backgroundTasks`/`backgroundShells`, ownership, or Stop authority. It is
   * projection data only, in exactly the observer lane's membership form, for
   * either review backend.
   */
  readonly backgroundTasks?: readonly NativeHookBackgroundMember[];
  /**
   * The assistant message this turn is reviewed on, inside the one request line.
   * An empty reported message is admitted as `""`, so "the assistant reported
   * nothing" is reviewable input rather than a malformed document.
   */
  readonly lastAssistantMessage?: string;
  /**
   * The prompt the user is submitting, admitted ONLY on `UserPromptSubmit`:
   * the reviewer must be able to see the request a turn is answering, and on
   * this event the assistant answer does not exist yet. Multi-line bounded
   * message text with exactly the `lastAssistantMessage` rules, and refused by
   * the decoder on a `Stop` request, where the reviewed text is the assistant's
   * answer instead.
   */
  readonly prompt?: string;
  readonly cwd?: string;
}

/**
 * Sanitized request delivered to the host callback: the authenticated request
 * line with every auth field (token, generation) and the broker-side routing id
 * removed, because the registration itself is the identity — same rule as the
 * observer family.
 */
export interface NativeReviewRequest {
  readonly backend: NativeCliBackend;
  readonly event: NativeReviewHookEventName;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly stopHookActive?: boolean;
  readonly backgroundTasks?: readonly NativeHookBackgroundMember[];
  readonly lastAssistantMessage?: string;
  /**
   * The submitted prompt, present only on a `UserPromptSubmit` request (the
   * decoder refuses it on `Stop`). The host review needs it: it is the only
   * statement of what the turn was asked to do.
   */
  readonly prompt?: string;
  readonly cwd?: string;
}

/** The same request before a backend is attached by the authenticated frame. */
export type NativeReviewProviderSelection = Omit<NativeReviewRequest, "backend">;

/**
 * The host's answer. `block` requires a non-empty reason (the provider shows
 * it to its model, and on `UserPromptSubmit` it also blocks the prompt);
 * `userMessage` is the optional one-line notice shown to the user on either
 * action. It is a verdict about one turn, never a permission decision about a
 * tool, file, or command.
 */
export interface NativeReviewVerdict {
  readonly action: "allow" | "block";
  readonly reason?: string;
  readonly userMessage?: string;
}

/** Broker answer frame carrying a verdict. */
export interface NativeReviewResponseFrame {
  readonly version: 1;
  readonly type: "native_review_response";
  readonly action: "allow" | "block";
  readonly reason?: string;
  readonly userMessage?: string;
}

/** Broker answer frame carrying one closed failure. */
export interface NativeReviewErrorFrame {
  readonly version: 1;
  readonly type: "native_review_error";
  readonly code: NativeReviewErrorCode;
}

export type NativeReviewServerFrame = NativeReviewResponseFrame | NativeReviewErrorFrame;

/** Decoded request: the rebuilt auth frame plus the sanitized callback value. */
export interface DecodedNativeReviewRequest {
  readonly frame: NativeReviewRequestFrame;
  readonly request: NativeReviewRequest;
}

/** Provider stdin selection outcome: the sanitized request or a closed reason. */
export type NativeReviewProviderInputResult =
  | { readonly ok: true; readonly selection: NativeReviewProviderSelection }
  | { readonly ok: false; readonly reason: NativeReviewUnavailableReason };

const MAX_INSTANCE_ID_LENGTH = 128;

/** UUID-like host/instance identity: hex digits and hyphens, at least one hex digit. */
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;
/** Cryptorandom hex token issued by the broker (32 random bytes). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

const REQUEST_FRAME_KEYS: ReadonlySet<string> = new Set([
  "version",
  "type",
  "instanceId",
  "generation",
  "backend",
  "token",
  "event",
  "sessionId",
  "turnId",
  "stopHookActive",
  "backgroundTasks",
  "lastAssistantMessage",
  "prompt",
  "cwd",
]);
const VERDICT_KEYS: ReadonlySet<string> = new Set(["action", "reason", "userMessage"]);
const RESPONSE_FRAME_KEYS: ReadonlySet<string> = new Set(["version", "type", "action", "reason", "userMessage"]);
const ERROR_FRAME_KEYS: ReadonlySet<string> = new Set(["version", "type", "code"]);
const BOOTSTRAP_KEYS: ReadonlySet<string> = new Set([
  "version",
  "socketPath",
  "generation",
  "instanceId",
  "backend",
  "token",
]);

/** True only for a value from the closed event set this lane answers. */
export function isNativeReviewHookEventName(value: unknown): value is NativeReviewHookEventName {
  return typeof value === "string" && (NATIVE_REVIEW_HOOK_EVENTS as readonly string[]).includes(value);
}

/** True only for a value from the closed broker error-code set. */
export function isNativeReviewErrorCode(value: unknown): value is NativeReviewErrorCode {
  return typeof value === "string" && (NATIVE_REVIEW_ERROR_CODES as readonly string[]).includes(value);
}

/** True only for a value from the closed relay-side unavailable-reason set. */
export function isNativeReviewUnavailableReason(value: unknown): value is NativeReviewUnavailableReason {
  return typeof value === "string" && (NATIVE_REVIEW_UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

/** Bounded host/instance identity shape shared with the broker registration API. */
export function isValidNativeReviewInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_INSTANCE_ID_LENGTH
    && ID_PATTERN.test(value);
}

function isValidGeneration(value: unknown): value is string {
  return isValidNativeReviewInstanceId(value);
}

function isValidToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/**
 * True only for this broker family's generated local Windows named-pipe
 * address (`\\.\pipe\prg-st-` plus 32 lowercase hex digits): the local `.`
 * namespace, never a remote `\\server\pipe\` name, a device path, or a
 * filesystem path. The same canonical shape the observer and MCP families
 * accept, so one broker endpoint serves all three families on every platform.
 */
export function isNativeReviewLocalPipeAddress(value: unknown): boolean {
  // Delegates to the one canonical matcher shared with the MCP family.
  return isNativeMcpLocalPipeAddress(value);
}

/** The same broker endpoint rule the MCP family enforces (shared helper). */
function isValidSocketPath(value: unknown): value is string {
  return isValidNativeBrokerSocketPath(value);
}

/**
 * Bounded single-line strict text: no C0/DEL/C1 controls, no line/paragraph
 * separators, and a fixed UTF-8 byte cap. Used for ids and paths, where a
 * control character is never legitimate.
 */
function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/**
 * Bounded provider/user-facing message text. Unlike an id, a real assistant
 * message or review reason spans lines, so tab/CR/LF are admitted; every other
 * C0 control, DEL, and C1 control is still refused. No admitted character
 * escapes to more than twice its UTF-8 length, which is what makes the frame
 * bounds above provable.
 */
/**
 * A verdict's optional reply text: bounded, control-character-free, and allowed
 * to be EMPTY. Only a block reason must be non-empty, and that rule is enforced
 * separately by {@link parseNativeReviewVerdict}; an empty optional notice or an
 * empty allow reason is a complete, meaningful answer. Refusing them here would
 * turn a valid block carrying an empty notice into `failed`, which lets the
 * provider proceed with a turn the host actually meant to block.
 */
function isBoundedMessage(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/**
 * The reviewed assistant text: the same control-character discipline as any
 * other message, but an EMPTY value is admitted. A provider that reports an
 * empty last assistant message still gets a review; the host sees an empty
 * string rather than a missing field, so "said nothing" and "said nothing
 * reportable" stay distinguishable.
 */
function isBoundedReviewedText(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_REVIEW_MESSAGE_BYTES
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/**
 * The submitted prompt text: the same message discipline as the reviewed
 * assistant text (multi-line admitted, an EMPTY prompt admitted — a user who
 * submits an empty prompt still gets a review of the turn it starts), under the
 * prompt's own byte cap.
 */
function isBoundedPrompt(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_NATIVE_REVIEW_PROMPT_BYTES
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/**
 * Bounded absolute path, admitted in either supported platform's spelling so
 * one decoder validates a macOS/Linux `/…` path and a Windows drive or UNC
 * path without a platform branch. It is never derived from anything: it is the
 * provider's own generic hook field, and an unusable value proves nothing.
 */
function isBoundedAbsolutePath(value: unknown, maxBytes: number): value is string {
  if (!isBoundedText(value, maxBytes)) return false;
  if (value.startsWith("\\\\")) {
    // UNC: \\server\share[\more…] — a real absolute Windows path, and never a
    // bare `\\server.` or a single-component name.
    return /^\\\\[^\\]+\\[^\\]+(?:\\[^\\]+)*$/.test(value);
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return !/[<>|]/.test(value);
  return value.startsWith("/") && isAbsolute(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseBackend(value: unknown): NativeCliBackend | undefined {
  return isNativeCliBackend(value) ? value : undefined;
}

/**
 * Validates one parsed bootstrap. Returns undefined (never throws) for a
 * missing, extra, or malformed field, so an inherited/foreign marker can never
 * half-authenticate a relay.
 */
export function parseNativeReviewBootstrap(value: unknown): NativeReviewBootstrap | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BOOTSTRAP_KEYS)) return undefined;
  if (value.version !== NATIVE_REVIEW_HOOK_PROTOCOL_VERSION) return undefined;
  const backend = parseBackend(value.backend);
  if (!backend) return undefined;
  if (!isValidSocketPath(value.socketPath)) return undefined;
  if (!isValidGeneration(value.generation)) return undefined;
  if (!isValidNativeReviewInstanceId(value.instanceId)) return undefined;
  if (!isValidToken(value.token)) return undefined;
  return {
    version: 1,
    socketPath: value.socketPath,
    generation: value.generation,
    instanceId: value.instanceId,
    backend,
    token: value.token,
  };
}

/** Parses the narrow child-environment marker value without retaining it elsewhere. */
export function parseNativeReviewBootstrapEnv(value: unknown): NativeReviewBootstrap | undefined {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_NATIVE_REVIEW_BOOTSTRAP_ENV_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parseNativeReviewBootstrap(parsed);
}

/** Serializes one already-typed bootstrap for the narrow child-environment marker. */
export function encodeNativeReviewBootstrapEnv(bootstrap: NativeReviewBootstrap): string {
  const encoded = JSON.stringify(bootstrap);
  if (Buffer.byteLength(encoded, "utf8") > MAX_NATIVE_REVIEW_BOOTSTRAP_ENV_BYTES) {
    throw new RangeError(`native review bootstrap exceeds ${MAX_NATIVE_REVIEW_BOOTSTRAP_ENV_BYTES} bytes`);
  }
  return encoded;
}

/**
 * Selects only the closed allowlist from one already-parsed provider stdin
 * value, using the provider's own field names as input, and attaches no
 * backend: the authenticated frame's backend is the only backend a host
 * callback ever sees. Unknown provider fields are ignored (never copied), so
 * `transcript_path` and every tool payload have no path into a frame.
 * Selection happens BEFORE any wire encoding.
 *
 * `hook_event_name` must be one of this lane's events; anything else is
 * `event-mismatch`, which is also what the relay reports when its own argv
 * event disagrees with stdin. `session_id` is required identity: without it the
 * host cannot bind the request to a row, so it is `input-invalid` rather than a
 * guessed empty. `cwd` is omitted when unusable — an unusable optional field
 * must not cost the whole review — while a present-but-malformed `turn_id` or
 * `stop_hook_active`, or an over-cap `last_assistant_message`, is an explicit
 * closed failure rather than a silent drop. `prompt` is selected ONLY for
 * `UserPromptSubmit`, where the reviewer has nothing else to review against;
 * on any other event a present `prompt` is ignored exactly like an unknown
 * field, so prompt text has no path onto the wire from a `Stop` request. A
 * present-but-malformed or over-cap `prompt` on `UserPromptSubmit` is an
 * explicit closed failure, like the other reviewed text. `background_tasks` is
 * validated as a whole array by the observer lane's own derivation, so both
 * families describe one provider array identically: membership when every
 * active entry was identifiable, absence otherwise (never a shortened set).
 */
export function sanitizeNativeReviewProviderInput(value: unknown): NativeReviewProviderInputResult {
  if (!isRecord(value)) return { ok: false, reason: "input-invalid" };
  const name = value.hook_event_name;
  if (!isNativeReviewHookEventName(name)) return { ok: false, reason: "event-mismatch" };
  const sessionId = value.session_id;
  if (!isBoundedText(sessionId, MAX_NATIVE_REVIEW_ID_BYTES)) return { ok: false, reason: "input-invalid" };
  const selection: { -readonly [Key in keyof NativeReviewProviderSelection]: NativeReviewProviderSelection[Key] } = {
    event: name,
    sessionId,
  };

  const turnId = value.turn_id;
  if (turnId !== undefined) {
    if (!isBoundedText(turnId, MAX_NATIVE_REVIEW_ID_BYTES)) return { ok: false, reason: "input-invalid" };
    selection.turnId = turnId;
  }

  const stopHookActive = value.stop_hook_active;
  if (stopHookActive !== undefined) {
    if (typeof stopHookActive !== "boolean") return { ok: false, reason: "input-invalid" };
    selection.stopHookActive = stopHookActive;
  }

  if (Object.prototype.hasOwnProperty.call(value, "background_tasks")) {
    const derived = deriveNativeHookBackgroundSnapshot(value.background_tasks);
    if (!derived.ok) {
      return { ok: false, reason: derived.reason === "input-too-large" ? "input-too-large" : "input-invalid" };
    }
    // A snapshot whose active membership could not be keyed stays absent: this
    // lane never shows a shortened set, and the counts form belongs to the
    // observer family, so a review consumer never has two views to reconcile.
    if (derived.members !== null) selection.backgroundTasks = derived.members;
  }

  const lastAssistantMessage = value.last_assistant_message;
  if (lastAssistantMessage !== undefined) {
    // Same rule as the body line that will carry it: an EMPTY reported message
    // is admitted, because "the assistant reported nothing" is reviewable input
    // and must not turn the whole turn into an unreviewed one.
    if (!isBoundedReviewedText(lastAssistantMessage)) {
      return { ok: false, reason: "input-invalid" };
    }
    selection.lastAssistantMessage = lastAssistantMessage;
  }

  const prompt = value.prompt;
  if (name === "UserPromptSubmit" && prompt !== undefined) {
    // Event-scoped: this is the only event whose review needs the prompt, and
    // an over-cap or malformed one is a closed failure rather than a silent
    // drop, so a truncated request is never reviewed as if it were complete.
    if (!isBoundedPrompt(prompt)) return { ok: false, reason: "input-invalid" };
    selection.prompt = prompt;
  }

  const cwd = value.cwd;
  if (cwd !== undefined && isBoundedAbsolutePath(cwd, MAX_NATIVE_REVIEW_CWD_BYTES)) selection.cwd = cwd;

  return { ok: true, selection };
}

/**
 * Strictly rebuilds one authenticated header line from wire bytes. Malformed,
 * oversized, extra-field, and unknown-type input returns undefined; the broker
 * then closes the connection without invoking any callback. A valid frame still
 * has to authenticate against the matching native review registration before a
 * host callback sees it. The complete request — reviewed answer text included —
 * arrives in this one line, so nothing is authenticated, counted, or held before
 * the whole line has decoded.
 */
export function decodeNativeReviewRequestFrame(line: string): DecodedNativeReviewRequest | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body + "\n", "utf8") > MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, REQUEST_FRAME_KEYS)) return undefined;
  if (parsed.version !== NATIVE_REVIEW_HOOK_PROTOCOL_VERSION || parsed.type !== "native_review_request") {
    return undefined;
  }
  const backend = parseBackend(parsed.backend);
  if (!backend) return undefined;
  if (!isValidNativeReviewInstanceId(parsed.instanceId)) return undefined;
  if (!isValidGeneration(parsed.generation)) return undefined;
  if (!isValidToken(parsed.token)) return undefined;
  if (!isNativeReviewHookEventName(parsed.event)) return undefined;
  if (!isBoundedText(parsed.sessionId, MAX_NATIVE_REVIEW_ID_BYTES)) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "turnId")
    && !isBoundedText(parsed.turnId, MAX_NATIVE_REVIEW_ID_BYTES)) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "stopHookActive")
    && typeof parsed.stopHookActive !== "boolean") return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "cwd")
    && !isBoundedAbsolutePath(parsed.cwd, MAX_NATIVE_REVIEW_CWD_BYTES)) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "lastAssistantMessage")
    && !isBoundedReviewedText(parsed.lastAssistantMessage)) return undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "prompt")) {
    // Refused on any event but the one that needs it: a `Stop` review already
    // carries the assistant's answer, so prompt text on that request is not
    // contract data. The whole frame is rejected rather than quietly dropped,
    // so a relay that projects prompt on the wrong event can never half-pass.
    if (parsed.event !== "UserPromptSubmit" || !isBoundedPrompt(parsed.prompt)) return undefined;
  }
  let backgroundTasks: readonly NativeHookBackgroundMember[] | undefined;
  if (Object.prototype.hasOwnProperty.call(parsed, "backgroundTasks")) {
    // Rebuilt by the observer lane's own strict membership parser with the
    // observer lane's own limits — one provider array shape, one contract, for
    // either review backend. The relay projects this field from the provider
    // snapshot independently of backend, so refusing it for one backend would
    // turn an otherwise valid request into an unavailable review.
    backgroundTasks = parseNativeHookBackgroundMembers(parsed.backgroundTasks);
    if (backgroundTasks === undefined) return undefined;
  }

  const optional = {
    ...(parsed.turnId === undefined ? {} : { turnId: parsed.turnId as string }),
    ...(parsed.stopHookActive === undefined ? {} : { stopHookActive: parsed.stopHookActive as boolean }),
    ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
    ...(parsed.lastAssistantMessage === undefined
      ? {}
      : { lastAssistantMessage: parsed.lastAssistantMessage as string }),
    ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt as string }),
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd as string }),
  };
  const frame: NativeReviewRequestFrame = {
    version: 1,
    type: "native_review_request",
    instanceId: parsed.instanceId,
    generation: parsed.generation,
    backend,
    token: parsed.token,
    event: parsed.event,
    sessionId: parsed.sessionId,
    ...optional,
  };
  // The callback value is the same rebuilt object minus every auth field and the
  // broker-side routing id: the registration itself is the identity.
  const request: NativeReviewRequest = {
    backend,
    event: parsed.event,
    sessionId: parsed.sessionId,
    ...optional,
  };
  return { frame, request };
}

/**
 * Validates one host verdict before it may reach the wire. `block` requires a
 * non-empty reason; an extra key, an unknown action, or an oversize field is
 * refused, so the broker answers the closed `failed` code instead of shipping a
 * half-understood verdict.
 */
export function parseNativeReviewVerdict(value: unknown): NativeReviewVerdict | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, VERDICT_KEYS)) return undefined;
  const action = value.action;
  if (action !== "allow" && action !== "block") return undefined;
  const reason = value.reason;
  const userMessage = value.userMessage;
  if (reason !== undefined && !isBoundedMessage(reason, MAX_NATIVE_REVIEW_REASON_BYTES)) return undefined;
  if (action === "block" && (reason === undefined || (reason as string).length === 0)) return undefined;
  if (userMessage !== undefined && !isBoundedMessage(userMessage, MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES)) {
    return undefined;
  }
  return {
    action,
    ...(reason === undefined ? {} : { reason: reason as string }),
    ...(userMessage === undefined ? {} : { userMessage: userMessage as string }),
  };
}

function encodeBoundedNativeReviewFrame(frame: object, maxBytes: number): string {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new RangeError(`native review frame exceeds ${maxBytes} bytes`);
  }
  return encoded;
}

/** Encodes one already-validated request frame; throws RangeError past the bound. */
export function encodeNativeReviewRequestFrame(frame: NativeReviewRequestFrame): string {
  return encodeBoundedNativeReviewFrame(frame, MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES);
}

/** Encodes one verdict or error frame; throws RangeError past the bound. */
export function encodeNativeReviewServerFrame(frame: NativeReviewServerFrame): string {
  return encodeBoundedNativeReviewFrame(
    frame,
    frame.type === "native_review_response" ? MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES : 128,
  );
}

/**
 * Strictly decodes one broker answer frame (relay side). Anything that is not
 * exactly this family's closed response or error shape is undefined, so a
 * malformed or hostile answer can never be read as a verdict.
 */
export function decodeNativeReviewServerFrame(line: string): NativeReviewServerFrame | undefined {
  if (typeof line !== "string") return undefined;
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body + "\n", "utf8") > MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== NATIVE_REVIEW_HOOK_PROTOCOL_VERSION) return undefined;
  if (parsed.type === "native_review_error") {
    if (!hasOnlyKeys(parsed, ERROR_FRAME_KEYS) || !isNativeReviewErrorCode(parsed.code)) return undefined;
    return { version: 1, type: "native_review_error", code: parsed.code };
  }
  if (parsed.type !== "native_review_response" || !hasOnlyKeys(parsed, RESPONSE_FRAME_KEYS)) return undefined;
  const verdict = parseNativeReviewVerdict({
    action: parsed.action,
    ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    ...(parsed.userMessage === undefined ? {} : { userMessage: parsed.userMessage }),
  });
  if (verdict === undefined) return undefined;
  return {
    version: 1,
    type: "native_review_response",
    action: verdict.action,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    ...(verdict.userMessage === undefined ? {} : { userMessage: verdict.userMessage }),
  };
}

/**
 * The closed background member-kind set this lane may carry, identical to the
 * observer lane's, re-exported so a review consumer never imports the observer
 * module for one type.
 */
export const NATIVE_REVIEW_BACKGROUND_KINDS = NATIVE_HOOK_BACKGROUND_KINDS;
