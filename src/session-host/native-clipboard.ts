import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getCallSites } from "node:util";
import { isValidNativeSessionId, type SessionHostBootstrap } from "./protocol";

/** Private authenticated transport, NOT permission to forward raw child OSC 52. */
export const NATIVE_CLIPBOARD_OSC = 777;
const PREFIX = "prg-native-copy-v1;";
const MAX_ENCODED = 100_000; // Pi 1.3.0's native OSC 52 limit.
const MAX_CAPSULE = 140_000;

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
function signature(bootstrap: SessionHostBootstrap, body: string): Buffer {
  return createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
    .update("pi-review-gate/native-copy/v1\0").update(body).digest();
}

/** Shared wire encoder. Payloads must never enter logs, status, or screen text. */
export function encodeNativeClipboardCapsule(
  bootstrap: SessionHostBootstrap, sequence: number, event: NativeClipboardEvent,
): string {
  if (!validEvent(event) || !Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Invalid native clipboard request");
  const body: Body = { version: 1, instanceId: bootstrap.instanceId, generation: bootstrap.generation, sequence, event };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  return `${PREFIX}${encoded};${signature(bootstrap, encoded).toString("hex")}`;
}

/** Per-registration verification; a rejected owner can never replay a request. */
export function createNativeClipboardReceiver(
  bootstrap: SessionHostBootstrap, onEvent: (event: NativeClipboardEvent) => void,
): (capsule: string) => void {
  let sequence = 0;
  return (capsule) => {
    if (typeof capsule !== "string" || capsule.length > MAX_CAPSULE || !capsule.startsWith(PREFIX)) return;
    const parts = capsule.slice(PREFIX.length).split(";");
    const [encoded, mac] = parts;
    if (parts.length !== 2 || !canonicalBase64(encoded, MAX_CAPSULE) || !mac || !/^[0-9a-f]{64}$/.test(mac)) return;
    if (!timingSafeEqual(signature(bootstrap, encoded), Buffer.from(mac, "hex"))) return;
    let body: unknown;
    try { body = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { return; }
    if (!record(body) || !exactKeys(body, ["version", "instanceId", "generation", "sequence", "event"])
      || body.version !== 1 || body.instanceId !== bootstrap.instanceId || body.generation !== bootstrap.generation
      || !Number.isSafeInteger(body.sequence) || (body.sequence as number) <= sequence || !validEvent(body.event)) return;
    sequence = body.sequence as number;
    try { onEvent(body.event); } catch { /* A peer refusal cannot escape into xterm's parser. */ }
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
          if (peer?.name === "@earendil-works/pi-tui" && peer.version === "1.3.0") tuiRoot = peerRoot;
        } catch { /* Bundled runtime needs no separate peer. */ }
        return { root: dir, ...(tuiRoot ? { tuiRoot } : {}), supported: manifest.version === "1.3.0" };
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
  // The shipped 1.3.0 bundle names its self-referencing class _InteractiveMode;
  // the unbundled public SDK uses InteractiveMode. Both were source-verified.
  const mainCopy = frames.some((frame) => (frame.functionName === "InteractiveMode.handleCopyCommand"
    || frame.functionName === "_InteractiveMode.handleCopyCommand") && nativeSource(runtime, frame.scriptName));
  return selected || mainCopy;
}

const BRIDGE_STATE = Symbol.for("pi-review-gate.native-clipboard-bridge.v1");
interface BridgeState { readonly version: 1; readonly setSession: (tuple: SessionTuple | undefined) => void }
function bridgeState(): BridgeState | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, BRIDGE_STATE);
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return record(value) && value.version === 1 && typeof value.setSession === "function" ? value as unknown as BridgeState : undefined;
}
/** Reporter owns the canonical native session epoch; reloads share one process-owned bridge. */
export function updateNativeClipboardSession(tuple: SessionTuple | undefined): void { bridgeState()?.setSession(tuple); }

/**
 * Installed only in the authenticated owned child, before native main. Native
 * input/selection/copy callbacks, helper calls, and encoded text remain unchanged.
 * The owned Node stream wrappers preserve bytes, callbacks, backpressure and this.
 */
export function installNativeClipboardBridge(bootstrap: SessionHostBootstrap): boolean {
  if (Object.getOwnPropertyDescriptor(globalThis, BRIDGE_STATE)) return false;
  const runtime = resolveNativeClipboardRuntime(process.argv[1] ?? "");
  if (!runtime) return false;
  const scope = new AsyncLocalStorage<SessionTuple>();
  let current: SessionTuple | undefined;
  let sequence = 0;
  const state: BridgeState = Object.freeze({ version: 1, setSession: (tuple: SessionTuple | undefined) => {
    current = tuple && validTuple(tuple) ? { sessionId: tuple.sessionId, sessionEpoch: tuple.sessionEpoch } : undefined;
  } });
  Object.defineProperty(globalThis, BRIDGE_STATE, { value: state });
  const stdin = process.stdin;
  const emit = stdin.emit as (this: typeof stdin, event: string | symbol, ...args: unknown[]) => boolean;
  stdin.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "data" || !current) return emit.call(this, event, ...args);
    const snapshot = { ...current };
    return scope.run(snapshot, () => emit.call(this, event, ...args));
  };
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
  stdout.write = nativeClipboardWrite as typeof stdout.write;
  return true;
}
