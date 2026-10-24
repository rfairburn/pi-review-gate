import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";
import type {
  NativeInputDecoder,
  NativeInputExpectedPhase,
  NativeInputExpectedTuple,
  NativeInputOrigin,
} from "./native-input-origin";
import { isValidNativeSessionId, type SessionHostBootstrap } from "./protocol";

/** Private authenticated transport, NOT permission to forward raw child OSC 52. */
export const NATIVE_CLIPBOARD_OSC = 777;
const PREFIX = "prg-native-copy-v1;";
/** Independent v2 prefix: a v1 capsule can never be read as v2 or the reverse. */
const PREFIX_V2 = "prg-native-copy-v2;";
const DOMAIN_V1 = "pi-review-gate/native-copy/v1\0";
const DOMAIN_V2 = "pi-review-gate/native-copy/v2\0";
const MAX_ENCODED = 100_000; // Pi 1.3.0 and 1.4.0's native OSC 52 limit.
const MAX_CAPSULE = 140_000;
/** Opaque viewer-token bound, identical to the accepted native-input codec's. */
const MAX_INPUT_ORIGIN_TOKEN_CHARS = 128;
/**
 * Child-side input-framing readiness, carried in the SAME private OSC 777
 * channel with its own prefix and HMAC domain. It states one owned bootstrap
 * fact — the strict decoder is fully installed in this process, before native
 * main can write its startup queries — and nothing else: no payload, no viewer
 * token, no capability, and no clipboard/input permission.
 */
const READY_PREFIX = "prg-native-input-ready-v1;";
const READY_DOMAIN = "pi-review-gate/native-input-ready/v1\0";
const READY_KIND = "input-framing-ready";
const MAX_READY_CAPSULE = 1024;
const READY_BODY_KEYS = ["version", "kind", "instanceId", "generation"] as const;

export type NativeClipboardEvent = {
  kind: "copy";
  encoded: string;
  sessionId: string;
  sessionEpoch: number;
} | {
  kind: "unavailable";
  reason: "unverified-native-origin" | "unsupported-runtime";
  sessionId: string;
  sessionEpoch: number;
};
type SessionTuple = Pick<NativeClipboardEvent, "sessionId" | "sessionEpoch">;
interface Body {
  version: 1;
  instanceId: string;
  generation: string;
  sequence: number;
  event: NativeClipboardEvent;
}
/**
 * Copy-capable input origin. `none` (host query/reply and other non-user input)
 * is deliberately absent: such input can never authorize or label a copy.
 */
export type NativeClipboardCopyOrigin =
  | { readonly kind: "local" }
  | { readonly kind: "viewer"; readonly token: string };
/**
 * V2 receipt: the unchanged v1 event plus the explicit input origin and logical
 * dispatch id that caused it. A receiver never erases this into a v1/legacy
 * event, so a viewer-initiated copy can never be mistaken for a local one.
 */
export interface NativeClipboardOriginEvent {
  readonly event: NativeClipboardEvent;
  readonly origin: NativeClipboardCopyOrigin;
  readonly dispatchId: number;
}
interface OriginInput {
  readonly origin: NativeClipboardCopyOrigin;
  readonly dispatchId: number;
}
interface BodyV2 {
  version: 2;
  instanceId: string;
  generation: string;
  sequence: number;
  event: NativeClipboardEvent;
  input: OriginInput;
}


function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function canonicalBase64(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
}
function validTuple(value: Record<string, unknown>): boolean {
  return isValidNativeSessionId(value.sessionId) && Number.isSafeInteger(value.sessionEpoch)
    && (value.sessionEpoch as number) > 0;
}
function validEvent(value: unknown): value is NativeClipboardEvent {
  if (!record(value) || !validTuple(value)) return false;
  if (value.kind === "copy") {
    if (!exactKeys(value, ["kind", "encoded", "sessionId", "sessionEpoch"])
      || !canonicalBase64(value.encoded, MAX_ENCODED)) return false;
    // The native text producer emits UTF-8, never clipboard queries/binary data.
    try { new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value.encoded, "base64")); }
    catch { return false; }
    return true;
  }
  return value.kind === "unavailable"
    && exactKeys(value, ["kind", "reason", "sessionId", "sessionEpoch"])
    && (value.reason === "unverified-native-origin" || value.reason === "unsupported-runtime");
}
function validCopyOrigin(value: unknown): value is NativeClipboardCopyOrigin {
  if (!record(value)) return false;
  if (value.kind === "local") return exactKeys(value, ["kind"]);
  // Mirrors the accepted native-input codec's closed origin bound exactly; the
  // capsule schema stays independent of that module at runtime.
  return value.kind === "viewer" && exactKeys(value, ["kind", "token"])
    && typeof value.token === "string" && value.token.length > 0
    && value.token.length <= MAX_INPUT_ORIGIN_TOKEN_CHARS
    && /^[\x21-\x7e]+$/.test(value.token);
}
function signatureFor(bootstrap: SessionHostBootstrap, version: 1 | 2, body: string): Buffer {
  return createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
    .update(version === 1 ? DOMAIN_V1 : DOMAIN_V2).update(body).digest();
}
function readySignature(bootstrap: SessionHostBootstrap, body: string): Buffer {
  return createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
    .update(READY_DOMAIN).update(body).digest();
}
/**
 * One-shot readiness statement over the existing registration key and current
 * instance/generation. Bound well under MAX_READY_CAPSULE; it carries no
 * payload, token, or sequence and is independent of both copy version streams.
 */
function encodeNativeInputReadyCapsule(bootstrap: SessionHostBootstrap): string {
  const body = JSON.stringify({
    version: 1,
    kind: READY_KIND,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
  });
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return `${READY_PREFIX}${encoded};${readySignature(bootstrap, encoded).toString("hex")}`;
}
function encodeCapsule(
  bootstrap: SessionHostBootstrap, version: 1 | 2, sequence: number, event: NativeClipboardEvent, input?: OriginInput,
): string {
  if (!validEvent(event) || !Number.isSafeInteger(sequence) || sequence <= 0
    || (version === 2 && input === undefined)) throw new Error("Invalid native clipboard request");
  const body: Body | BodyV2 = version === 1
    ? { version: 1, instanceId: bootstrap.instanceId, generation: bootstrap.generation, sequence, event }
    : { version: 2, instanceId: bootstrap.instanceId, generation: bootstrap.generation, sequence, event, input: input! };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  return `${version === 1 ? PREFIX : PREFIX_V2}${encoded};${signatureFor(bootstrap, version, encoded).toString("hex")}`;
}

/** Shared wire encoder. Payloads must never enter logs, status, or screen text. */
export function encodeNativeClipboardCapsule(
  bootstrap: SessionHostBootstrap, sequence: number, event: NativeClipboardEvent,
): string {
  return encodeCapsule(bootstrap, 1, sequence, event);
}

/**
 * V2 encoder: the unchanged event plus the explicit input origin and logical
 * dispatch id. Only `local` or `viewer` input can label a copy; `none` input has
 * no user copy origin and is refused here, so it can never become a receipt.
 */
export function encodeNativeClipboardOriginCapsule(
  bootstrap: SessionHostBootstrap, sequence: number, event: NativeClipboardEvent,
  input: { readonly origin: NativeClipboardCopyOrigin; readonly dispatchId: number },
): string {
  const candidate: unknown = input;
  if (!record(candidate) || !exactKeys(candidate, ["origin", "dispatchId"])) {
    throw new Error("Invalid native clipboard origin");
  }
  const origin: unknown = candidate.origin;
  const dispatchId: unknown = candidate.dispatchId;
  if (!validCopyOrigin(origin) || !Number.isSafeInteger(dispatchId) || (dispatchId as number) <= 0) {
    throw new Error("Invalid native clipboard origin");
  }
  return encodeCapsule(bootstrap, 2, sequence, event, Object.freeze({
    origin: Object.freeze(origin.kind === "viewer"
      ? { kind: "viewer" as const, token: origin.token }
      : { kind: "local" as const }),
    dispatchId: dispatchId as number,
  }));
}

/**
 * Per-registration verification; a rejected owner can never replay a request.
 * V1 and V2 capsules share one monotonic sequence counter, so the same
 * authenticated request can never be accepted twice across versions. A valid
 * V2 capsule consumes its sequence even when the caller supplies no V2 consumer
 * (the current host is still v1-only); it is never downgraded into a v1 event.
 *
 * The optional `onInputFramingReady` consumer receives the one-shot readiness
 * signal emitted by the strict child bridge. Readiness is verified and consumed
 * at most once, is delivered before (and even if) that callback throws, never
 * reaches `onEvent`/`onOriginEvent`, and never advances the copy sequence, so the
 * first real copy is still sequence 1. It is a decoder-installed fact only; the
 * host still owes its own live-record/mode checks before framing any bytes.
 */
export function createNativeClipboardReceiver(
  bootstrap: SessionHostBootstrap, onEvent: (event: NativeClipboardEvent) => void,
  onOriginEvent?: (event: NativeClipboardOriginEvent) => void,
  onInputFramingReady?: () => void,
): (capsule: string) => void {
  let sequence = 0;
  let ready = false;
  return (capsule) => {
    if (typeof capsule !== "string" || capsule.length > MAX_CAPSULE) return;
    if (capsule.startsWith(READY_PREFIX)) {
      if (ready) return; // Consumed at most once per registration.
      const readyParts = capsule.slice(READY_PREFIX.length).split(";");
      const [readyBody, readyMac] = readyParts;
      if (readyParts.length !== 2 || capsule.length > MAX_READY_CAPSULE
        || !canonicalBase64(readyBody, MAX_READY_CAPSULE) || !readyMac
        || !/^[0-9a-f]{64}$/.test(readyMac)) return;
      if (!timingSafeEqual(readySignature(bootstrap, readyBody), Buffer.from(readyMac, "hex"))) return;
      let readyValue: unknown = undefined;
      try {
        readyValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(readyBody, "base64")));
      } catch { return; }
      if (!record(readyValue) || !exactKeys(readyValue, READY_BODY_KEYS)
        || readyValue.version !== 1 || readyValue.kind !== READY_KIND
        || readyValue.instanceId !== bootstrap.instanceId
        || readyValue.generation !== bootstrap.generation) return;
      ready = true; // Consumed before the callback, including when it throws.
      if (onInputFramingReady === undefined) return;
      try { onInputFramingReady(); } catch { /* A refusal cannot escape into xterm's parser. */ }
      return;
    }
    const version = capsule.startsWith(PREFIX) ? 1 : capsule.startsWith(PREFIX_V2) ? 2 : 0;
    if (version === 0) return;
    const parts = capsule.slice((version === 1 ? PREFIX : PREFIX_V2).length).split(";");
    const [encoded, mac] = parts;
    if (parts.length !== 2 || !canonicalBase64(encoded, MAX_CAPSULE) || !mac || !/^[0-9a-f]{64}$/.test(mac)) return;
    if (!timingSafeEqual(signatureFor(bootstrap, version, encoded), Buffer.from(mac, "hex"))) return;
    let body: unknown;
    try { body = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { return; }
    if (!record(body) || body.instanceId !== bootstrap.instanceId || body.generation !== bootstrap.generation
      || !Number.isSafeInteger(body.sequence) || (body.sequence as number) <= sequence) return;
    const nextSequence = body.sequence as number;
    if (version === 1) {
      if (!exactKeys(body, ["version", "instanceId", "generation", "sequence", "event"])
        || body.version !== 1 || !validEvent(body.event)) return;
      sequence = nextSequence;
      try { onEvent(body.event); } catch { /* A peer refusal cannot escape into xterm's parser. */ }
      return;
    }
    const inputValue: unknown = body.input;
    if (!exactKeys(body, ["version", "instanceId", "generation", "sequence", "event", "input"])
      || body.version !== 2 || !validEvent(body.event) || !record(inputValue)
      || !exactKeys(inputValue, ["origin", "dispatchId"])) return;
    const origin: unknown = inputValue.origin;
    const dispatchId: unknown = inputValue.dispatchId;
    if (!validCopyOrigin(origin) || !Number.isSafeInteger(dispatchId) || (dispatchId as number) <= 0) return;
    // Owned, deep-frozen receipt: later mutation of the parsed body or the
    // caller's input cannot retarget the origin or the dispatch id.
    const receipt: NativeClipboardOriginEvent = Object.freeze({
      event: Object.freeze({ ...body.event }),
      origin: Object.freeze(origin.kind === "viewer"
        ? { kind: "viewer" as const, token: origin.token }
        : { kind: "local" as const }),
      dispatchId: dispatchId as number,
    });
    sequence = nextSequence;
    if (onOriginEvent === undefined) return; // Authenticated and sequence-consuming, never downgraded.
    try { onOriginEvent(receipt); } catch { /* No raw error may escape into xterm's parser. */ }
  };
}

export interface NativeClipboardRuntime {
  readonly root: string;
  readonly tuiRoot?: string;
  readonly supported: boolean;
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function readManifest(path: string): Record<string, unknown> | null | undefined {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size <= 0n || st.size > 262_144n) return null;
    const bytes = Buffer.alloc(Number(st.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) break;
      offset += n;
    }
    if (offset !== Number(st.size)) return null;
    const value: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    return record(value) ? value : null;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Unavailable metadata is never a clipboard grant. */ } } }
}

/** Bounded inspection of the actual CLI's package, never an ambient SDK instance. */
export function resolveNativeClipboardRuntime(cli: string): NativeClipboardRuntime | undefined {
  try {
    const entry = realpathSync(cli);
    let dir = dirname(entry);
    for (let i = 0; i < 32; i += 1) {
      const manifest = readManifest(join(dir, "package.json"));
      if (manifest === null) return undefined; // Never attribute through an unsafe package boundary.
      if (manifest) {
        if (manifest.name !== "@earendil-works/pi-coding-agent" || !contains(dir, entry)) return undefined;
        const bin = record(manifest.bin) ? manifest.bin.pi : manifest.bin;
        if (typeof bin !== "string" || (entry !== realpathSync(join(dir, bin)) && entry !== join(dir, "dist", "cli.js"))) return undefined;
        let tuiRoot: string | undefined;
        try {
          const peerRoot = dirname(dirname(realpathSync(createRequire(entry).resolve("@earendil-works/pi-tui"))));
          const peer = readManifest(join(peerRoot, "package.json"));
          if (peer?.name === "@earendil-works/pi-tui"
            && (peer.version === "1.3.0" || peer.version === "1.4.0")) tuiRoot = peerRoot;
        } catch { /* Bundled runtime needs no separate peer. */ }
        return {
          root: dir,
          ...(tuiRoot ? { tuiRoot } : {}),
          supported: manifest.version === "1.3.0" || manifest.version === "1.4.0",
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* Unsupported installations retain raw-control denial. */ }
  return undefined;
}
interface SourceFrame { functionName: string; scriptName: string }
function sourcePath(script: string): string | undefined {
  try { return script.startsWith("file:") ? fileURLToPath(script) : isAbsolute(script) ? script : undefined; } catch { return undefined; }
}
function nativeSource(runtime: NativeClipboardRuntime, script: string): boolean {
  const path = sourcePath(script);
  return path !== undefined && contains(join(runtime.root, "dist"), path);
}
function stackFrames(stack: string): SourceFrame[] {
  return stack.split("\n").flatMap((line) => {
    const m = /^\s*at (?:async )?(.+) \((.+):\d+:\d+\)$/.exec(line);
    return m ? [{ functionName: m[1]!, scriptName: m[2]! }] : [];
  });
}

/**
 * Observe, never replace, Pi's native producer. A gesture/timing window alone
 * is NOT sufficient: an unrelated render/agent write cannot satisfy this gate.
 * Pinning the supported runtime makes missing/changed stack provenance fail closed.
 * This is not a sandbox against executable extensions with this user's authority.
 */
export function isNativeClipboardOrigin(
  runtime: NativeClipboardRuntime, sites: readonly SourceFrame[], asyncStack: string,
): boolean {
  if (!runtime.supported) return false;
  const emit = sites.findIndex((site) => site.functionName === "emitOsc52" && nativeSource(runtime, site.scriptName));
  if (emit < 0 || sites[emit + 1]?.functionName !== "copyToClipboard"
    || !nativeSource(runtime, sites[emit + 1]!.scriptName)) return false;
  const frames = stackFrames(asyncStack);
  const selected = frames.some((frame) => frame.functionName === "TuiAltScreen.copySelection" && nativeSource(runtime, frame.scriptName))
    && frames.some((frame) => {
      if (frame.functionName !== "TuiAltScreen.copyTextToClipboard") return false;
      const path = sourcePath(frame.scriptName);
      return path !== undefined && (nativeSource(runtime, frame.scriptName)
        || (runtime.tuiRoot !== undefined && path === join(runtime.tuiRoot, "dist", "tui-alt-screen.js")));
    });
  // The shipped 1.3.0 and 1.4.0 bundles name their self-referencing class _InteractiveMode;
  // the unbundled public SDK uses InteractiveMode. Both were source-verified.
  const mainCopy = frames.some((frame) => (frame.functionName === "InteractiveMode.handleCopyCommand"
    || frame.functionName === "_InteractiveMode.handleCopyCommand") && nativeSource(runtime, frame.scriptName));
  return selected || mainCopy;
}

const BRIDGE_STATE = Symbol.for("pi-review-gate.native-clipboard-bridge.v1");
interface BridgeState {
  readonly version: 1;
  readonly setSession: (tuple: SessionTuple | undefined) => void;
  /**
   * One-shot startup arming. It is a no-op once any session update (of any value)
   * was published, and it never re-arms a closed startup phase.
   */
  readonly armStartup?: () => void;
}
function bridgeState(): BridgeState | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_STATE);
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return record(value) && value.version === 1 && typeof value.setSession === "function" ? value as unknown as BridgeState : undefined;
}
/** Reporter owns the canonical native session epoch; reloads share one process-owned bridge. */
export function updateNativeClipboardSession(tuple: SessionTuple | undefined): void { bridgeState()?.setSession(tuple); }
/**
 * Arm this process's explicit startup input phase. Called exactly once by the
 * authenticated reporter at the END of its own construction, after its mandatory
 * public hooks were registered. It opens startup only when the bridge is still
 * unarmed (no session update of any value was ever published); otherwise it does
 * nothing. It claims nothing about whether a native conversation exists, publishes
 * no status, and grants no copy authority.
 */
export function armNativeClipboardStartup(): void {
  const state = bridgeState();
  if (state === undefined || typeof state.armStartup !== "function") return;
  state.armStartup();
}

/** Captured once at logical dispatch start; later Reporter updates cannot retarget it. */
interface FramedInputScope {
  readonly tuple: SessionTuple | undefined;
  readonly origin: NativeInputOrigin;
  readonly dispatchId: number;
  /**
   * The native conversation this dispatch was admitted against, for `viewer`
   * dispatches only. It is carried with the dispatch so a deferred copy states the
   * conversation its input actually belonged to, never the newest one.
   */
  readonly expectedNativeTuple: NativeInputExpectedTuple | undefined;
  /**
   * `"startup"` only for a viewer dispatch admitted against the explicit startup
   * phase. Such a dispatch has no conversation tuple, so it can never produce a
   * conversation copy capsule, an owner-local copy, or a raw clipboard relay, even
   * from asynchronous work that runs after the phase closed.
   */
  readonly expectedNativePhase: NativeInputExpectedPhase | undefined;
}

/**
 * Closed, opt-in bridge options. The default (no options, or
 * `{ inputOriginFraming: false }`) keeps the existing legacy bridge exactly.
 */
export interface NativeClipboardBridgeOptions {
  /**
   * Strict child-side input framing. When true, every stdin `data` chunk must be
   * an authenticated native-input frame from ./native-input-origin: verified
   * payload bytes (never the framing text) are re-emitted through the ORIGINAL
   * stdin emitter inside the dispatch's AsyncLocalStorage context, which also
   * carries the captured native session tuple, explicit origin, and logical
   * dispatch id into native async copies. `local` and `none` dispatches keep that
   * per-fragment delivery, while one `viewer` dispatch is assembled whole and
   * delivered exactly once at its final fragment, so native Pi's bracketed-paste
   * parser never sees a prefix of a dispatch that a later conversation change
   * would have to abandon. When absent/false nothing changes.
   * No production caller sets this option; it is inert until a later host phase.
   */
  readonly inputOriginFraming?: boolean;
}

function inputOriginFraming(options: NativeClipboardBridgeOptions | undefined): boolean | undefined {
  if (options === undefined) return false;
  if (!record(options)) return undefined;
  const keys = Object.keys(options);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== "inputOriginFraming")) return undefined;
  const value = options.inputOriginFraming;
  return value === undefined || value === false ? false : value === true ? true : undefined;
}

/** Per-dispatch string decoder for an existing UTF-8 (or other) string-mode stdin. */
function textDecoder(encoding: string): StringDecoder | undefined {
  try { return new StringDecoder(encoding as BufferEncoding); } catch { return undefined; }
}

/** True only while the child is still in the conversation this dispatch expected. */
function tupleStillExpected(expected: NativeInputExpectedTuple | undefined, actual: SessionTuple | undefined): boolean {
  if (expected === undefined) return true; // No viewer fence: unchanged legacy semantics.
  return actual !== undefined && actual.sessionId === expected.sessionId && actual.sessionEpoch === expected.epoch;
}

/** First allocation of one pending viewer dispatch, so a keystroke costs a small buffer. */
const PENDING_VIEWER_INITIAL_BYTES = 1024;

/** One bounded allocation, or undefined when the engine could not satisfy it. */
function pendingBytes(capacity: number): Buffer | undefined {
  try {
    return Buffer.allocUnsafe(capacity);
  } catch {
    return undefined; // Allocation failure refuses this dispatch; it never escapes.
  }
}

/**
 * The ONE pending `viewer` dispatch: a single owned, growable byte buffer bounded
 * by the technical assembly bound. Retained state is a function of payload BYTES
 * only — an empty or tiny fragment adds no bookkeeping — so a flood of small
 * frames cannot grow metadata, and a keystroke never allocates the maximum.
 * Growth is geometric from {@linkcode PENDING_VIEWER_INITIAL_BYTES} and an
 * allocation failure is reported as an ordinary refusal, never a throw.
 */
class PendingViewerDispatch {
  #bytes: Buffer | undefined;
  #length = 0;

  /** Append one verified fragment; false when this whole dispatch cannot fit. */
  append(payload: Buffer, maxBytes: number): boolean {
    if (payload.length === 0) return true;
    const needed = this.#length + payload.length;
    if (!Number.isSafeInteger(needed) || needed > maxBytes) return false;
    let bytes = this.#bytes;
    if (bytes === undefined || needed > bytes.length) {
      let capacity = bytes === undefined
        ? Math.min(maxBytes, Math.max(PENDING_VIEWER_INITIAL_BYTES, needed))
        : bytes.length;
      while (capacity < needed) capacity = Math.min(capacity * 2, maxBytes);
      const grown = pendingBytes(capacity);
      if (grown === undefined) return false;
      if (bytes !== undefined) bytes.copy(grown, 0, 0, this.#length);
      this.#bytes = grown;
      bytes = grown;
    }
    payload.copy(bytes, this.#length);
    this.#length = needed;
    return true;
  }

  /** Take the assembled bytes and release the owned buffer immediately. */
  take(): Buffer | undefined {
    const bytes = this.#bytes;
    const length = this.#length;
    this.clear();
    return bytes === undefined || length === 0 ? undefined : bytes.subarray(0, length);
  }

  /** Release every retained byte now. */
  clear(): void {
    this.#bytes = undefined;
    this.#length = 0;
  }
}

/** The private hook the bridge's session update uses to release pending viewer bytes. */
interface FramedStdinHandle {
  /** A published native-conversation change (including an undefined tuple) arrived. */
  onTupleChange(): void;
}

/**
 * Strict mode: framing bytes are consumed and verified payload bytes are delivered
 * through the original `data` emitter under the dispatch's ALS context. The
 * boolean returned to the caller is Node's listener-dispatch boolean (true when
 * the chunk was consumed, buffered, delivered, or poisoned); it is not a
 * native-write acknowledgement. A poisoned decoder never re-enables, never
 * falls back to raw keystrokes, and never retargets.
 *
 * `local` and `none` dispatches keep their unchanged per-fragment streaming: a
 * fragment authenticated before a later failure in the same chunk is still
 * delivered under its captured dispatch scope, so local input never depends on
 * transport chunking.
 *
 * A `viewer` dispatch is different, because native Pi's bracketed-paste parser
 * retains partial state across a session change: delivering its prefix would
 * poison the next conversation's paste. So one whole `viewer` dispatch is
 * assembled and delivered EXACTLY ONCE, immediately before its own final
 * fragment, and no fragment of it ever reaches a native listener early. The
 * expected native conversation is compared with the child's ACTUAL conversation
 * at dispatch start, at EVERY authenticated fragment, and again immediately
 * before that one emit. A `/new`, `/resume`, or reload seen at any point (or a
 * published tuple change, including one reported while no stdin arrives at all)
 * refuses the WHOLE dispatch through its final fragment: the owned bytes are
 * released at once, no native prefix is emitted, the remainder is consumed, and
 * nothing is re-tagged, replayed, truncated into a later dispatch, or fallen
 * back to raw. Neither a refusal nor the bound latches the decoder: the next
 * dispatch that matches the current conversation is delivered normally, and an
 * A -> B -> A tuple sequence never revives buffered bytes from A.
 *
 * A startup-fenced `viewer` dispatch follows exactly the same whole-dispatch
 * assembly. Its fence is this process's own explicit startup phase, checked at
 * dispatch start, at EVERY fragment, and immediately before the single emit. The
 * phase closes for good at the first session update of ANY value (including
 * `undefined` and reloads), and that update releases a pending startup assembly
 * at once, so a startup dispatch can never straddle the first published update
 * and can never poison the next native paste.
 */
function installFramedStdin(
  stdin: typeof process.stdin,
  emit: (this: typeof process.stdin, event: string | symbol, ...args: unknown[]) => boolean,
  decoder: NativeInputDecoder,
  framed: AsyncLocalStorage<FramedInputScope>,
  currentTuple: () => SessionTuple | undefined,
  startupOpen: () => boolean,
  maxViewerPayloadBytes: number,
): FramedStdinHandle {
  let poisoned = false;
  // The open dispatch survives chunk boundaries: its captured tuple/origin and
  // its string decoder are per LOGICAL DISPATCH, never per chunk or feed.
  let open: {
    readonly scope: FramedInputScope;
    readonly text: StringDecoder | undefined;
    readonly expected: NativeInputExpectedTuple | undefined;
    /** True for a viewer dispatch fenced on the explicit startup phase. */
    readonly startup: boolean;
    /** True for any viewer dispatch: it is assembled whole and emitted once. */
    readonly viewer: boolean;
    suppressed: boolean;
  } | undefined;
  /** The one fence a viewer dispatch carries, evaluated against the CURRENT facts. */
  const fenceHolds = (active: { readonly expected: NativeInputExpectedTuple | undefined; readonly startup: boolean }): boolean =>
    active.startup ? startupOpen() : tupleStillExpected(active.expected, currentTuple());
  const pending = new PendingViewerDispatch();
  stdin.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "data") {
      // End of input releases the owned bytes immediately and, with a partial frame
      // or dispatch, is a truncation rather than a raw fallback.
      if (event === "end") {
        open = undefined;
        pending.clear();
        if (!poisoned && !decoder.finish().ok) poisoned = true;
      }
      return emit.call(this, event, ...args);
    }
    if (poisoned) return true;
    const encoding = (stdin as unknown as { readonly readableEncoding?: string | null }).readableEncoding ?? null;
    if (encoding !== null && textDecoder(encoding) === undefined) {
      poisoned = true;
      open = undefined;
      pending.clear();
      return true;
    }
    const fed = decoder.feed(args[0] as Buffer | string);
    let consumed = fed.fragments.length === 0; // Framing bytes accepted, nothing to deliver yet.
    for (const fragment of fed.fragments) {
      if (fragment.start) {
        const tuple = currentTuple();
        const expected = fragment.expectedNativeTuple;
        const startup = fragment.expectedNativePhase === "startup";
        // A new logical dispatch never inherits an earlier dispatch's owned bytes.
        pending.clear();
        const fence = { expected, startup };
        open = {
          scope: Object.freeze({
            tuple: tuple ? Object.freeze({ ...tuple }) : undefined,
            expectedNativeTuple: expected ? Object.freeze({ ...expected }) : undefined,
            expectedNativePhase: startup ? "startup" as const : undefined,
            origin: fragment.origin,
            dispatchId: fragment.dispatchId,
          }),
          text: encoding === null ? undefined : textDecoder(encoding),
          expected,
          startup,
          viewer: fragment.origin.kind === "viewer",
          // A viewer dispatch admitted against another conversation, or against a
          // startup phase that is not open now, is refused whole, before a single
          // byte reaches a listener.
          suppressed: !fenceHolds(fence),
        };
      }
      const active = open;
      if (active === undefined) {
        // Unreachable: part 0 always opens.
        poisoned = true;
        pending.clear();
        return true;
      }
      if (active.viewer) {
        // VIEWER: assemble one whole logical dispatch and emit it once at its end.
        if (!active.suppressed && !fenceHolds(active)) {
          // A session change (or a closed startup phase) seen at any fragment: the
          // rest of this dispatch belongs to nothing. Consume it, deliver none of it,
          // never re-tag.
          active.suppressed = true;
        }
        if (active.suppressed) {
          pending.clear(); // Release the owned bytes now, not at the dispatch end.
          consumed = true; // Authenticated framing bytes are consumed, not passed on.
          if (fragment.end) open = undefined;
          continue;
        }
        if (!pending.append(fragment.payload, maxViewerPayloadBytes)) {
          // Over the technical bound (or out of memory): this whole dispatch is an
          // ordinary refusal. No truncation, no partial emit, no raw fallback, and
          // the next valid dispatch is unaffected.
          active.suppressed = true;
          pending.clear();
          consumed = true;
          if (fragment.end) open = undefined;
          continue;
        }
        if (!fragment.end) {
          consumed = true; // Held, never emitted: a native listener sees no prefix.
          continue;
        }
        // Final fragment: release the owned bytes BEFORE the one emit, then recheck
        // the exact captured fence immediately before delivery.
        const assembled = pending.take();
        const stillCurrent = fenceHolds(active);
        open = undefined;
        if (!stillCurrent) {
          consumed = true; // The conversation moved on: nothing of this dispatch is delivered.
          continue;
        }
        if (assembled === undefined) {
          consumed = true;
          continue;
        }
        const chunk: Buffer | string = active.text === undefined
          ? assembled
          : `${active.text.write(assembled)}${active.text.end()}`;
        if (chunk.length > 0) {
          consumed = framed.run(active.scope, () => emit.call(this, "data", chunk, ...args.slice(1))) || consumed;
        } else {
          consumed = true;
        }
        continue;
      }
      // LOCAL / NONE: the unchanged per-fragment streaming contract.
      if (!active.suppressed && !tupleStillExpected(active.expected, currentTuple())) {
        // A session change inside an earlier listener: the rest of this dispatch
        // belongs to no conversation. Consume it, deliver none of it, never re-tag.
        active.suppressed = true;
      }
      if (active.suppressed) {
        consumed = true; // Authenticated framing bytes are consumed, not passed on.
        if (fragment.end) open = undefined;
        continue;
      }
      const payload = fragment.payload;
      if (payload.length > 0) {
        const chunk: Buffer | string = active.text === undefined ? payload : active.text.write(payload);
        if (typeof chunk !== "string" || chunk.length > 0) {
          consumed = framed.run(active.scope, () => emit.call(this, "data", chunk, ...args.slice(1))) || consumed;
        }
      } else {
        consumed = true;
      }
      if (fragment.end && active.text !== undefined) {
        const tail = active.text.end();
        if (tail.length > 0) {
          consumed = framed.run(active.scope, () => emit.call(this, "data", tail, ...args.slice(1))) || consumed;
        }
      }
      if (fragment.end) open = undefined;
    }
    if (!fed.ok) {
      // Everything authenticated before the failing byte has already been delivered
      // above (local/none only: a viewer fragment is never delivered early); from
      // here on nothing is. Poison immediately and release the owned bytes.
      poisoned = true;
      open = undefined;
      pending.clear();
      return true;
    }
    return consumed;
  };
  return {
    onTupleChange: () => {
      const active = open;
      // Only a pending VIEWER dispatch carries a fence; `local` and `none` keep
      // their unchanged per-fragment streaming.
      if (active === undefined || !active.viewer) return;
      // A republished identical tuple is not a change for a conversation-fenced
      // dispatch. A startup-fenced dispatch never survives: every update closes the
      // startup phase before this hook runs.
      if (fenceHolds(active)) return;
      // Release the owned bytes now even when no further stdin ever arrives, and
      // latch the refusal for the rest of this dispatch, so returning to the earlier
      // tuple (A -> B -> A) can never revive buffered bytes from A.
      active.suppressed = true;
      pending.clear();
    },
  };
}

/** One payload the strict framed stdin delivered to the original emitter, with its captured scope. */
export interface FramedStdinTestDelivery {
  readonly chunk: Buffer | string;
  readonly origin: NativeInputOrigin | undefined;
  readonly dispatchId: number | undefined;
  readonly expectedNativePhase: NativeInputExpectedPhase | undefined;
  readonly expectedNativeTuple: NativeInputExpectedTuple | undefined;
  readonly capturedTuple: { readonly sessionId: string; readonly sessionEpoch: number } | undefined;
}

/**
 * Test-only seam: drive the exact strict framed-stdin logic over an in-memory
 * stream, without touching `process.stdin`, `process.stdout`, or the process-wide
 * bridge state. Production code never calls it.
 */
export const __test = Object.freeze({
  framedStdin(options: {
    readonly decoder: NativeInputDecoder;
    readonly currentTuple: () => { readonly sessionId: string; readonly sessionEpoch: number } | undefined;
    readonly startupOpen: () => boolean;
    readonly maxViewerPayloadBytes: number;
  }): {
    feed(chunk: Buffer | string): boolean;
    end(): void;
    onTupleChange(): void;
    readonly delivered: FramedStdinTestDelivery[];
  } {
    const delivered: FramedStdinTestDelivery[] = [];
    const framed = new AsyncLocalStorage<FramedInputScope>();
    const original = function (this: typeof process.stdin, event: string | symbol, ...args: unknown[]): boolean {
      if (event === "data") {
        const scope = framed.getStore();
        delivered.push(Object.freeze({
          chunk: args[0] as Buffer | string,
          origin: scope?.origin,
          dispatchId: scope?.dispatchId,
          expectedNativePhase: scope?.expectedNativePhase,
          expectedNativeTuple: scope?.expectedNativeTuple,
          capturedTuple: scope?.tuple,
        }));
      }
      return true;
    };
    const fake = { readableEncoding: null, emit: original } as unknown as typeof process.stdin;
    const handle = installFramedStdin(
      fake, original, options.decoder, framed, options.currentTuple, options.startupOpen, options.maxViewerPayloadBytes,
    );
    return Object.freeze({
      feed: (chunk: Buffer | string): boolean => fake.emit("data", chunk),
      end: (): void => { fake.emit("end"); },
      onTupleChange: (): void => handle.onTupleChange(),
      delivered,
    });
  },
});

/**
 * Installed only in the authenticated owned child, before native main. Native
 * input/selection/copy callbacks, helper calls, and encoded text remain unchanged.
 * The owned Node stream wrappers preserve bytes, callbacks, backpressure and this.
 * The optional strict framing mode is inert and has no production caller.
 */
export function installNativeClipboardBridge(
  bootstrap: SessionHostBootstrap, options?: NativeClipboardBridgeOptions,
): boolean {
  if (Object.getOwnPropertyDescriptor(globalThis, BRIDGE_STATE)) return false;
  const framing = inputOriginFraming(options);
  if (framing === undefined) return false; // Unknown option shapes never install a half-understood bridge.
  const runtime = resolveNativeClipboardRuntime(process.argv[1] ?? "");
  if (!runtime) return false;
  let inputDecoder: NativeInputDecoder | undefined;
  let viewerPayloadBound = 0;
  if (framing) {
    try {
      // The inert input codec is loaded only when the opt-in mode is requested,
      // so the default bridge keeps its exact module graph and behavior.
      const codec = require("./native-input-origin") as typeof import("./native-input-origin");
      inputDecoder = codec.createNativeInputDecoder(bootstrap);
      // Same exported technical assembly bound the host admits a viewer dispatch
      // against; read from the lazily loaded codec so the default graph is unchanged.
      viewerPayloadBound = codec.NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES;
    } catch { return false; }
  }
  const scope = new AsyncLocalStorage<SessionTuple>();
  const framed = new AsyncLocalStorage<FramedInputScope>();
  let current: SessionTuple | undefined;
  let framedInput: FramedStdinHandle | undefined;
  let sequence = 0;
  /**
   * Explicit startup phase of THIS process: `unarmed` until the reporter arms it
   * after registering its mandatory hooks, `open` only between that arming and the
   * first session update, and `closed` for good after any update of any value.
   * There is no transition out of `closed`, so a reload, a deactivation, or an
   * A -> B -> A sequence can never re-open it.
   */
  let startup: "unarmed" | "open" | "closed" = "unarmed";
  const state: BridgeState = Object.freeze({
    version: 1,
    setSession: (tuple: SessionTuple | undefined) => {
      // EVERY call (including `undefined`, deactivation, and reload) ends the
      // startup phase BEFORE the pending-dispatch hook runs, so a pending startup
      // assembly is released immediately and can never be delivered.
      startup = "closed";
      current = tuple && validTuple(tuple) ? { sessionId: tuple.sessionId, sessionEpoch: tuple.sessionEpoch } : undefined;
      // A published conversation change reaches the strict bridge immediately, so a
      // pending viewer dispatch releases its owned bytes and stays refused even if no
      // further stdin ever arrives. The legacy bridge installs no such handle.
      framedInput?.onTupleChange();
    },
    armStartup: () => {
      if (startup === "unarmed") startup = "open";
    },
  });
  Object.defineProperty(globalThis, BRIDGE_STATE, { value: state });
  const stdin = process.stdin;
  const emit = stdin.emit as (this: typeof stdin, event: string | symbol, ...args: unknown[]) => boolean;
  if (!framing) {
    stdin.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      if (event !== "data" || !current) return emit.call(this, event, ...args);
      const snapshot = { ...current };
      return scope.run(snapshot, () => emit.call(this, event, ...args));
    };
  } else {
    framedInput = installFramedStdin(
      stdin, emit, inputDecoder!, framed, () => current, () => startup === "open", viewerPayloadBound,
    );
  }
  const stdout = process.stdout;
  const write = stdout.write as (...args: unknown[]) => boolean;
  function nativeClipboardWrite(this: typeof stdout, ...args: unknown[]): boolean {
    const chunk = args[0];
    const tuple = scope.getStore();
    if (tuple && typeof chunk === "string" && chunk.length <= MAX_ENCODED + 8) {
      const match = /^\x1b\]52;c;([A-Za-z0-9+/]*={0,2})\x07$/.exec(chunk);
      if (match && canonicalBase64(match[1], MAX_ENCODED)) {
        let proven = false;
        try {
          const error = new Error();
          Error.captureStackTrace(error, nativeClipboardWrite);
          proven = isNativeClipboardOrigin(runtime!, getCallSites(16), error.stack ?? "");
        } catch { /* Missing/changed stack support withholds forwarding, never native local copying. */ }
        const event: NativeClipboardEvent = proven
          ? { kind: "copy", encoded: match[1], ...tuple }
          : { kind: "unavailable", reason: runtime!.supported ? "unverified-native-origin" : "unsupported-runtime", ...tuple };
        if (sequence < Number.MAX_SAFE_INTEGER) {
          const capsule = encodeNativeClipboardCapsule(bootstrap, ++sequence, event);
          return write.call(this, `\x1b]${NATIVE_CLIPBOARD_OSC};${capsule}\x07`, ...args.slice(1));
        }
      }
    }
    return write.apply(this, args); // No unscoped output gains clipboard authority.
  }
  if (!framing) {
    stdout.write = nativeClipboardWrite as typeof stdout.write;
  } else {
    // Strict mode emits v2 capsules only, carrying the dispatch's origin and
    // logical dispatch id. Default/legacy callers keep v1 exactly.
    stdout.write = function framedClipboardWrite(this: typeof stdout, ...args: unknown[]): boolean {
      const dispatch = framed.getStore();
      if (dispatch === undefined) return write.apply(this, args);
      if (dispatch.expectedNativePhase === "startup") {
        // A startup-phase viewer dispatch has no conversation, so a native copy
        // attempt it caused (now or from async work after the phase closed) yields
        // no capsule, no owner-local route, and no raw OSC 52 relay. The write still
        // completes through the original writer so callback-driven code never waits.
        const startupChunk = args[0];
        if (typeof startupChunk === "string" && startupChunk.length <= MAX_ENCODED + 8) {
          const startupMatch = /^\x1b\]52;c;([A-Za-z0-9+/]*={0,2})\x07$/.exec(startupChunk);
          if (startupMatch && canonicalBase64(startupMatch[1], MAX_ENCODED)) {
            return write.call(this, "", ...args.slice(1));
          }
        }
        return write.apply(this, args);
      }
      const tuple = dispatch.tuple;
      const chunk = args[0];
      if (tuple === undefined || typeof chunk !== "string" || chunk.length > MAX_ENCODED + 8) {
        return write.apply(this, args);
      }
      const match = /^\x1b\]52;c;([A-Za-z0-9+/]*={0,2})\x07$/.exec(chunk);
      if (!match || !canonicalBase64(match[1], MAX_ENCODED)) return write.apply(this, args);
      // `none` is host query/reply input: no user copy origin, so no capsule and
      // no clipboard authority. The suppressed write still completes through the
      // original writer (empty chunk, receiver, callback, return value preserved)
      // so callback-driven native code is never left waiting.
      if (dispatch.origin.kind === "none") return write.call(this, "", ...args.slice(1));
      let proven = false;
      try {
        const error = new Error();
        Error.captureStackTrace(error, framedClipboardWrite);
        proven = isNativeClipboardOrigin(runtime!, getCallSites(16), error.stack ?? "");
      } catch { /* Missing/changed stack support withholds forwarding, never native local copying. */ }
      const event: NativeClipboardEvent = proven
        ? { kind: "copy", encoded: match[1], ...tuple }
        : { kind: "unavailable", reason: runtime!.supported ? "unverified-native-origin" : "unsupported-runtime", ...tuple };
      if (sequence >= Number.MAX_SAFE_INTEGER) return write.call(this, "", ...args.slice(1));
      const capsule = encodeNativeClipboardOriginCapsule(bootstrap, ++sequence, event, {
        origin: dispatch.origin, dispatchId: dispatch.dispatchId,
      });
      return write.call(this, `\x1b]${NATIVE_CLIPBOARD_OSC};${capsule}\x07`, ...args.slice(1));
    } as typeof stdout.write;
  }
  if (framing) {
    // Owned bootstrap control fact, NOT a clipboard copy and NOT input permission:
    // exactly one private OSC 777 carrying the strict readiness statement, written
    // with the caller's ORIGINAL stdout writer after the decoder and both stream
    // wrappers are installed and before this function returns — i.e. before native
    // main can emit its kitty/program-status/DA startup queries. The host must
    // still check its live record and current mode; readiness only says "decoder
    // installed", never "frame everything". A failed write is not a grant.
    try {
      write.call(stdout, `\x1b]${NATIVE_CLIPBOARD_OSC};${encodeNativeInputReadyCapsule(bootstrap)}\x07`);
    } catch { /* Withheld readiness leaves the host unframed, never raw. */ }
  }
  return true;
}
