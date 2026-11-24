/**
 * #682 native Windows Claude root hook relay — marker contract, per-run key
 * derivation, and the one bounded sibling branch the native hook relay runs.
 *
 * ## Dormant in this slice
 *
 * Nothing in active code issues {@link WINDOWS_CLAUDE_HOOK_MARKER_ENV}: no
 * launch preparation, profile, provider setting, or supervisor writes it, and
 * the launcher strips every inherited spelling of it as a stale host
 * capability. Until a later owner issues it, every hook process finds no marker
 * and this branch returns `ineligible` without touching the network. A future
 * owner must prove the protected supervisor hook pipe is prepared before it
 * issues a marker, and must never reuse a marker from an earlier run.
 *
 * ## Marker (no credential)
 *
 * The ephemeral marker carries routing and binding identifiers only, as one
 * canonical JSON object with exactly these fields in this order and nothing
 * else (no whitespace, no alternative escapes, no duplicates):
 *
 * `{"pipe":"\\\\.\\pipe\\prg682-hook-<32 lowercase hex>","runId":"<run id>","instanceId":"<id>","generation":"<id>"}`
 *
 * - `pipe`: the exact local hook pipe the supervisor listens on;
 * - `runId`: the ASCII custody run-id grammar `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`;
 * - `instanceId`/`generation`: must equal the already authenticated native
 *   hook bootstrap's own values exactly, or the marker is a mismatch.
 *
 * It never carries the per-run key, the bootstrap token, or any inbox value.
 *
 * ## Per-run proof key (internal)
 *
 * {@link deriveWindowsClaudeHookProofKey} is the one pure derivation shared
 * with the future supervisor-side owner: HMAC-SHA256 keyed by the native hook
 * bootstrap token used AS ASCII TEXT, over the ASCII message
 * `JSON.stringify(["prg682-windows-claude-hook-key-v1", instanceId, generation, runId, pipe])`,
 * rendered as 64 lowercase hex characters. Without the exact per-run bootstrap
 * token the key cannot be derived; it is never stored, logged, returned in a
 * result, or placed in any broker frame.
 *
 * ## Eligibility (all required, checked before any connection)
 *
 * explicit `win32` platform; a parsed bootstrap whose backend is `claude`; a
 * valid marker whose `instanceId`/`generation` equal that bootstrap; an
 * accepted, normalized root `SessionStart` (no `agent_id`) whose `session_id`
 * is a canonical lowercase UUID; the inbox endpoint from Claude's own hook
 * environment passing the existing `\\.\pipe\LOCAL\<segment>` peer grammar;
 * and the inbox token passing the PoC alphabet `[A-Za-z0-9+/=_.~-]{8,4096}`.
 *
 * ## Send (one attempt, proof before record)
 *
 * The existing proof-before-record client makes exactly one connection to the
 * marker's pipe, requires the peer's proof of the derived key, and only then
 * materializes and writes the one record:
 *
 * `{"v":1,"runId":"<runId>","event":"SessionStart","sessionId":"<uuid>","socket":"<escaped endpoint>","token":"<token>"}` + LF
 *
 * The record is built lazily inside the client's record callback, so an
 * unproved, mismatched, cancelled, or expired exchange never materializes it.
 * The whole branch is bounded by {@link WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS}
 * (an abort after that budget plus a currency fence that turns false at the
 * same deadline), so it ends inside the provider hook timeout. There is no
 * retry, queue, fallback pipe, or broker fallback.
 *
 * ## Results
 *
 * The branch result is separate from the ordinary broker relay outcome and is
 * never reflected into it: `ineligible` with a closed reason, or the client's
 * own closed `not-sent`/`handed-off`/`unknown` result. `handed-off` means only
 * that the record write completed locally (receipt by the pipe at most); it is
 * NOT acceptance, NOT ownership of the root conversation, and NOT a binding.
 * Results never carry the marker, key, token, endpoint, run id, or error text.
 */

import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CLAUDE_INBOX_SOCKET_ENV, CLAUDE_INBOX_TOKEN_ENV } from "./native-claude-inbox-announcement";
import {
  isValidNativeHookInstanceId,
  type NativeHookBootstrap,
  type NativeHookEventMetadata,
} from "./native-hook-protocol";
import {
  forwardWindowsClaudeHookRecordOnce,
  type WindowsClaudeHookForwardResult,
  type WindowsClaudeHookForwardSeams,
} from "./native-windows-claude-hook-forwarder";
import { parseWindowsClaudeInboxLocalEndpoint } from "./native-windows-claude-inbox-peer";

/* ---------------------------------------------------------------- contract */

/*
 * Each shared constant is declared once as a module-local binding and
 * exported under its public name, so runtime checks read exactly the bound
 * callers see, never a reassignable property of CommonJS `exports`.
 */

/** Ephemeral hook-environment marker name. Issued by no active code in this slice. */
const MARKER_ENV = "PI_REVIEW_GATE_WINDOWS_CLAUDE_HOOK";

/** Domain-separation label of the per-run key derivation tuple. */
const KEY_CONTEXT = "prg682-windows-claude-hook-key-v1";

/**
 * Bound for the whole sibling branch, in milliseconds. With the relay's stdin
 * bound (1500 ms) ahead of it, and running concurrently with the unchanged
 * broker exchange (connect 1500 ms + ack 1500 ms), the hook process still
 * settles inside the provider's 5 s command-hook timeout.
 */
const BUDGET_MS = 3000;

/** Largest accepted marker value, in characters (all ASCII). */
const MARKER_MAX_CHARS = 640;

export {
  MARKER_ENV as WINDOWS_CLAUDE_HOOK_MARKER_ENV,
  KEY_CONTEXT as WINDOWS_CLAUDE_HOOK_KEY_CONTEXT,
  BUDGET_MS as WINDOWS_CLAUDE_HOOK_RELAY_BUDGET_MS,
  MARKER_MAX_CHARS as WINDOWS_CLAUDE_HOOK_MARKER_MAX_CHARS,
};


/** Marker fields, in their only accepted order. */
export const WINDOWS_CLAUDE_HOOK_MARKER_FIELDS = Object.freeze(["pipe", "runId", "instanceId", "generation"] as const);

/** Closed reasons the branch did not attempt a connection. */
export const WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS = Object.freeze([
  "not-windows",
  "not-claude",
  "no-marker",
  "marker-invalid",
  "marker-mismatch",
  "not-root-session-start",
  "session-invalid",
  "endpoint-invalid",
  "token-invalid",
  "key-unavailable",
] as const);

export type WindowsClaudeHookRelayIneligibleReason = (typeof WINDOWS_CLAUDE_HOOK_RELAY_INELIGIBLE_REASONS)[number];

/** The branch's separate, closed result; never merged into the broker relay outcome. */
export type WindowsClaudeHookRelayResult =
  | { readonly disposition: "ineligible"; readonly reason: WindowsClaudeHookRelayIneligibleReason }
  | WindowsClaudeHookForwardResult;

/** One parsed marker: identifiers only. */
export interface WindowsClaudeHookMarker {
  readonly pipe: string;
  readonly runId: string;
  readonly instanceId: string;
  readonly generation: string;
}

/** Inputs of the shared derivation; `token` is the per-run native hook bootstrap token. */
export interface WindowsClaudeHookKeyInput {
  readonly token: string;
  readonly instanceId: string;
  readonly generation: string;
  readonly runId: string;
  readonly pipe: string;
}

/** Test seams only; the product relay passes nothing but the platform default. */
export interface WindowsClaudeHookRelayOptions {
  readonly platform?: NodeJS.Platform;
  /** Shorter budget for tests, 1..3000 ms; anything else uses the default. */
  readonly budgetMs?: number;
  /** Passed to the client; `setTimer`/`clearTimer`/`now` also drive this branch's own budget. */
  readonly seams?: WindowsClaudeHookForwardSeams;
}

/* ----------------------------------------------------------------- grammar */

const PIPE_PREFIX = "\\\\.\\pipe\\prg682-hook-";
const PIPE_HEX_CHARS = 32;
const RUN_ID_MAX_CHARS = 128;
const BOOTSTRAP_TOKEN_CHARS = 64;
const INBOX_TOKEN_MIN_CHARS = 8;
const INBOX_TOKEN_MAX_CHARS = 4096;

function isLowerHexCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
}

function isHexCode(code: number): boolean {
  return isLowerHexCode(code) || (code >= 0x41 && code <= 0x46);
}

function isAlnumCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isHookPipe(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== PIPE_PREFIX.length + PIPE_HEX_CHARS) return false;
  for (let i = 0; i < PIPE_PREFIX.length; i += 1) if (value.charCodeAt(i) !== PIPE_PREFIX.charCodeAt(i)) return false;
  for (let i = PIPE_PREFIX.length; i < value.length; i += 1) if (!isLowerHexCode(value.charCodeAt(i))) return false;
  return true;
}

/** The existing custody run-id grammar: `[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 128 characters. */
function isRunId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > RUN_ID_MAX_CHARS) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isAlnumCode(code)) continue;
    if (i === 0) return false;
    if (code !== 0x2e && code !== 0x5f && code !== 0x3a && code !== 0x2d) return false;
  }
  return true;
}

/** The broker-issued bootstrap token shape: exactly 64 hex characters (ASCII). */
function isBootstrapToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== BOOTSTRAP_TOKEN_CHARS) return false;
  for (let i = 0; i < value.length; i += 1) if (!isHexCode(value.charCodeAt(i))) return false;
  return true;
}

/** Canonical lowercase 8-4-4-4-12 UUID, the receiver's `sessionId` grammar. */
function isLowerUuid(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (let i = 0; i < 36; i += 1) {
    const code = value.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (code !== 0x2d) return false;
    } else if (!isLowerHexCode(code)) return false;
  }
  return true;
}

/** The PoC inbox token alphabet `[A-Za-z0-9+/=_.~-]`, 8..4096 characters (none of which JSON escapes). */
function isInboxToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length < INBOX_TOKEN_MIN_CHARS || value.length > INBOX_TOKEN_MAX_CHARS) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isAlnumCode(code)) continue;
    if (code !== 0x2b && code !== 0x2f && code !== 0x3d && code !== 0x5f && code !== 0x2e && code !== 0x7e && code !== 0x2d) return false;
  }
  return true;
}

function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ marker */

/**
 * Parse one marker value exactly. Returns a frozen marker, or `undefined` for
 * anything that is not the one canonical shape; never throws and never echoes
 * the input.
 */
export function parseWindowsClaudeHookMarker(value: unknown): WindowsClaudeHookMarker | undefined {
  try {
    if (typeof value !== "string" || value.length < 2 || value.length > MARKER_MAX_CHARS || !isPrintableAscii(value)) return undefined;
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (Object.getPrototypeOf(parsed) !== Object.prototype) return undefined;
    const keys = Object.keys(parsed);
    if (keys.length !== 4 || keys[0] !== "pipe" || keys[1] !== "runId" || keys[2] !== "instanceId" || keys[3] !== "generation") {
      return undefined;
    }
    const { pipe, runId, instanceId, generation } = parsed as Record<string, unknown>;
    if (!isHookPipe(pipe) || !isRunId(runId)) return undefined;
    if (!isValidNativeHookInstanceId(instanceId) || !isValidNativeHookInstanceId(generation)) return undefined;
    // Canonical form only: re-serializing the validated fields must reproduce the input exactly,
    // which refuses whitespace, alternative escapes, and duplicate keys.
    if (JSON.stringify({ pipe, runId, instanceId, generation }) !== value) return undefined;
    return Object.freeze({ pipe, runId, instanceId, generation });
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------- key */

/**
 * The shared per-run proof key: 64 lowercase hex characters, or `undefined`
 * when any input is outside its exact grammar. Pure; stores and logs nothing.
 */
export function deriveWindowsClaudeHookProofKey(input: WindowsClaudeHookKeyInput): string | undefined {
  try {
    if (typeof input !== "object" || input === null) return undefined;
    const { token, instanceId, generation, runId, pipe } = input;
    if (!isBootstrapToken(token) || !isHookPipe(pipe) || !isRunId(runId)) return undefined;
    if (!isValidNativeHookInstanceId(instanceId) || !isValidNativeHookInstanceId(generation)) return undefined;
    const message = JSON.stringify([KEY_CONTEXT, instanceId, generation, runId, pipe]);
    const key = createHmac("sha256", Buffer.from(token, "ascii")).update(message, "ascii").digest("hex");
    return key.length === 64 ? key : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ branch */

interface Eligible {
  readonly marker: WindowsClaudeHookMarker;
  readonly key: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly token: string;
}

function notSentInputInvalid(): WindowsClaudeHookRelayResult {
  return Object.freeze({ disposition: "not-sent" as const, reason: "input-invalid" as const });
}

function ineligible(reason: WindowsClaudeHookRelayIneligibleReason): WindowsClaudeHookRelayResult {
  return Object.freeze({ disposition: "ineligible" as const, reason });
}

function select(
  bootstrap: NativeHookBootstrap,
  metadata: NativeHookEventMetadata,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Eligible | WindowsClaudeHookRelayResult {
  if (platform !== "win32") return ineligible("not-windows");
  if (bootstrap.backend !== "claude") return ineligible("not-claude");
  const raw = env[MARKER_ENV];
  if (raw === undefined) return ineligible("no-marker");
  const marker = parseWindowsClaudeHookMarker(raw);
  if (marker === undefined) return ineligible("marker-invalid");
  if (marker.instanceId !== bootstrap.instanceId || marker.generation !== bootstrap.generation) return ineligible("marker-mismatch");
  if (metadata.hook_event_name !== "SessionStart" || metadata.agent_id !== undefined) return ineligible("not-root-session-start");
  const sessionId = metadata.session_id;
  if (!isLowerUuid(sessionId)) return ineligible("session-invalid");
  const endpoint = parseWindowsClaudeInboxLocalEndpoint(env[CLAUDE_INBOX_SOCKET_ENV]);
  if (!endpoint.ok) return ineligible("endpoint-invalid");
  const token = env[CLAUDE_INBOX_TOKEN_ENV];
  if (!isInboxToken(token)) return ineligible("token-invalid");
  const key = deriveWindowsClaudeHookProofKey({
    token: bootstrap.token,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    runId: marker.runId,
    pipe: marker.pipe,
  });
  if (key === undefined) return ineligible("key-unavailable");
  return { marker, key, sessionId, endpoint: endpoint.endpoint, token };
}

/** The receiver's exact v1 candidate line; every value was already validated. */
function encodeRecord(runId: string, sessionId: string, endpoint: string, token: string): Uint8Array {
  return Buffer.from(
    `{"v":1,"runId":${JSON.stringify(runId)},"event":"SessionStart","sessionId":${JSON.stringify(sessionId)},`
      + `"socket":${JSON.stringify(endpoint)},"token":${JSON.stringify(token)}}\n`,
    "ascii",
  );
}

/**
 * Run the sibling branch once for one already selected relay event. Never
 * rejects and never throws; settles within the budget with a closed result.
 */
export async function relayWindowsClaudeRootSessionStart(
  bootstrap: NativeHookBootstrap,
  metadata: NativeHookEventMetadata,
  env: NodeJS.ProcessEnv,
  options: WindowsClaudeHookRelayOptions = {},
): Promise<WindowsClaudeHookRelayResult> {
  let selected: Eligible | WindowsClaudeHookRelayResult;
  try {
    selected = select(bootstrap, metadata, env, options.platform ?? process.platform);
  } catch {
    return ineligible("marker-invalid");
  }
  if ("disposition" in selected) return selected;
  const { marker, key, sessionId, endpoint, token } = selected;

  const seams = options.seams;
  const budget = typeof options.budgetMs === "number" && Number.isInteger(options.budgetMs)
    && options.budgetMs >= 1 && options.budgetMs <= BUDGET_MS ? options.budgetMs : BUDGET_MS;
  const startTimer = seams?.setTimer ?? ((callback: () => void, ms: number): unknown => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  });
  const stopTimer = seams?.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const clock = seams?.now ?? ((): number => performance.now());

  const controller = new AbortController();
  let timer: unknown;
  let armed = false;
  try {
    const started = clock();
    if (typeof started !== "number" || !Number.isFinite(started)) return notSentInputInvalid();
    const deadline = started + budget;
    timer = startTimer(() => {
      armed = false;
      controller.abort();
    }, budget);
    armed = true;
    const isCurrent = (): boolean => {
      if (controller.signal.aborted) return false;
      const now = clock();
      return typeof now === "number" && now < deadline;
    };
    return await forwardWindowsClaudeHookRecordOnce(
      {
        pipe: marker.pipe,
        runId: marker.runId,
        key,
        isCurrent,
        record: () => encodeRecord(marker.runId, sessionId, endpoint, token),
        signal: controller.signal,
      },
      seams,
    );
  } catch {
    return notSentInputInvalid();
  } finally {
    if (armed) {
      armed = false;
      try {
        stopTimer(timer);
      } catch {
        // The result is already decided; a failing timer seam changes nothing.
      }
    }
  }
}
