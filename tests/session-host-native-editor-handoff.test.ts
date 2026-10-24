import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  createNativeInputDecoder,
  createNativeInputEncoder,
  type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import {
  installNativeEditorHandoff,
  setEditorPtyLoaderForTests,
  settleOwnedNativeEditor,
  type EditorHandoffSink,
  type EditorPtyDescriptor,
  type EditorPtySurface,
} from "../src/session-host/native-editor-handoff";
import { __test as clipboardTest } from "../src/session-host/native-clipboard";
import type { NativeClipboardRuntime } from "../src/session-host/native-clipboard";
import type { SessionHostBootstrap } from "../src/session-host/protocol";

/**
 * Focused source regressions for the owned external-editor PTY handoff (issue #499).
 *
 * Two layers live here. The strict framed stdin's editor ROUTING: exactly one sink
 * per logical dispatch, captured at dispatch start, invalidated across entry and
 * retirement, no raw fallback, and a routing change that never resets the decoder.
 * The spawn ADAPTER: audited launcher provenance only, the exact inherited-stdio
 * shape only, fail-closed refusals before any process exists, and a settlement that
 * only the owned editor's own positive exit may produce.
 *
 * No real PTY, no Pi, and no live `dist/` here; the process-level suite in
 * `session-host-native-editor-handoff-process.test.ts` drives the installed
 * production launcher and a real non-Node editor.
 */

const BOOTSTRAP = {
  version: 1,
  socketPath: "/nonexistent/editor-handoff.sock",
  token: "cd".repeat(32),
  instanceId: "0a1b2c3d-0000-4000-8000-00000000aaaa",
  generation: "0a1b2c3d-0000-4000-8000-00000000bbbb",
} as unknown as SessionHostBootstrap;

const LOCAL: NativeInputOrigin = Object.freeze({ kind: "local" });
const VIEWER: NativeInputOrigin = Object.freeze({ kind: "viewer", token: "nvst1.viewer-1.0123456789abcdef0123456789abcdef" });
/** The child's current native conversation, and the fence a viewer dispatch names. */
const NATIVE = Object.freeze({ sessionId: "0a1b2c3d-0000-4000-8000-00000000cccc", sessionEpoch: 1 });
const FENCE = Object.freeze({ sessionId: NATIVE.sessionId, epoch: NATIVE.sessionEpoch });

const dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, (...args: unknown[]) => unknown>>;

function newBridge() {
  return clipboardTest.framedStdin({
    decoder: createNativeInputDecoder(BOOTSTRAP),
    currentTuple: () => NATIVE,
    startupOpen: () => false,
    maxViewerPayloadBytes: NATIVE_INPUT_RAW_FRAGMENT_BYTES * 4,
  });
}

function sinkOf(): { sink: EditorHandoffSink; writes: Buffer[] } {
  const writes: Buffer[] = [];
  return { writes, sink: { write: (bytes: Buffer) => { writes.push(Buffer.from(bytes)); } } };
}

const written = (writes: readonly Buffer[]): string => Buffer.concat([...writes]).toString("utf8");

/** Split one encoder output into its individual authenticated frames. */
function framesOf(framed: string): string[] {
  const parts = framed.match(/prg-ni-v2;[0-9a-f]{16};[1-9][0-9]*;[A-Za-z0-9_-]+;[0-9a-f]{64};/g) ?? [];
  assert.equal(parts.join(""), framed, "the dispatch is nothing but complete printable frames");
  return parts;
}

/* ------------------------------------------------------------------------- *
 * Routing: exactly one sink per logical dispatch
 * ------------------------------------------------------------------------- */

test("routing: an admitted editor dispatch reaches the owned sink byte-exactly and never the native listeners", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  assert.equal(bridge.editorActive(), true);
  const payload = Buffer.from("i\x1b[200~héllo — 🚀\x1b[201~\x1b:wq\r", "utf8");
  assert.equal(bridge.feed(encoder.encode(payload, LOCAL)), true);
  assert.equal(written(writes), payload.toString("utf8"), "the verified ordinary bytes, not the framing text");
  assert.equal(bridge.delivered.length, 0, "no byte also reaches a native listener");
  assert.equal(written(writes).includes("prg-ni-v2"), false, "no framing text is ever relayed");
});

test("routing: a viewer dispatch is still assembled whole and written exactly once to the editor", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  const payload = Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES * 2 + 9, 0x61);
  const parts = framesOf(encoder.encode(payload, VIEWER, FENCE));
  assert.equal(parts.length, 3);
  for (const part of parts.slice(0, 2)) {
    bridge.feed(part);
    assert.equal(writes.length, 0, "no prefix reaches the editor either");
  }
  bridge.feed(parts[2]!);
  assert.equal(writes.length, 1, "exactly one write for the whole dispatch");
  assert.equal(Buffer.compare(writes[0]!, payload), 0, "byte-exact and untruncated");
  assert.equal(bridge.delivered.length, 0);
});

test("routing: a dispatch already in flight when the editor starts belongs to neither sink", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const parts = framesOf(encoder.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 4, 0x62), LOCAL));
  bridge.feed(parts[0]!);
  assert.equal(bridge.delivered.length, 1, "the first fragment was delivered before the handoff");
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  bridge.feed(parts[1]!);
  assert.equal(writes.length, 0, "the rest of an earlier-sink dispatch never enters the editor");
  assert.equal(bridge.delivered.length, 1, "and never reaches the native listeners either");
  bridge.feed(encoder.encode(Buffer.from("after"), LOCAL));
  assert.equal(written(writes), "after", "a dispatch that STARTS after entry is the editor's");
});

test("routing: a first frame left incomplete at entry completes for neither sink", () => {
  // The decoder holds the incomplete frame; the dispatch it completes was begun for
  // the previous owner. Ownership follows those bytes, not the sink that happens to
  // exist when the terminator finally arrives.
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const frame = framesOf(encoder.encode(Buffer.from("started-before-entry"), LOCAL))[0]!;
  bridge.feed(frame.slice(0, -1));
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  bridge.feed(frame.slice(-1));
  assert.equal(writes.length, 0, "the dispatch begun before entry never enters the editor");
  assert.equal(bridge.delivered.length, 0, "and it never reached the native listeners either");
  bridge.feed(encoder.encode(Buffer.from("next"), LOCAL));
  assert.equal(written(writes), "next", "the next valid dispatch belongs to the editor");
});

test("routing: a first frame left incomplete at retirement completes for neither sink", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  const frame = framesOf(encoder.encode(Buffer.from("started-inside-editor"), LOCAL))[0]!;
  bridge.feed(frame.slice(0, -1));
  bridge.setEditorSink(undefined);
  bridge.feed(frame.slice(-1));
  assert.equal(writes.length, 0, "no remainder of an editor dispatch is written anywhere");
  assert.equal(bridge.delivered.length, 0, "and none of it reaches the resumed native listeners");
  bridge.feed(encoder.encode(Buffer.from("later"), LOCAL));
  assert.equal(bridge.delivered.length, 1, "the next dispatch is the native owner's again");
  assert.equal(bridge.delivered[0]!.chunk.toString(), "later");
});

const FRAME_TAG = "prg-ni-v2;";

test("routing: synchronous entry cannot acquire read-ahead dispatches or a trailing partial first frame", () => {
  // The installed launcher enters the handoff synchronously from the Ctrl+G input
  // callback, while decoder.feed() has already authenticated the whole chunk.
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const { sink, writes } = sinkOf();
  let enterEditor: (() => void) | undefined;
  const bridge = clipboardTest.framedStdin({
    decoder: createNativeInputDecoder(BOOTSTRAP),
    currentTuple: () => NATIVE,
    startupOpen: () => false,
    maxViewerPayloadBytes: NATIVE_INPUT_RAW_FRAGMENT_BYTES * 4,
    onDelivery: () => { enterEditor?.(); },
  });
  enterEditor = () => { bridge.setEditorSink(sink); };
  const trigger = encoder.encode(Buffer.from("\x07"), LOCAL);
  const queued = encoder.encode(Buffer.from("queued-before-entry"), LOCAL);
  const partial = encoder.encode(Buffer.from("started-before-entry"), LOCAL);
  bridge.feed(trigger + queued + partial.slice(0, -1));
  bridge.feed(partial.slice(-1));
  assert.deepEqual(bridge.delivered.map((entry) => entry.chunk.toString()), ["\x07"]);
  assert.equal(writes.length, 0, "read-ahead input belongs to neither sink");
  bridge.feed(encoder.encode(Buffer.from("after-entry"), LOCAL));
  assert.equal(written(writes), "after-entry", "and the first dispatch begun after entry is the editor's");
});

test("routing: entry during the final fragment of an open dispatch flushes nothing further", () => {
  // Same synchronous entry, one dispatch earlier: the dispatch that was already
  // delivering keeps its original owner, and its string-decoder tail (here a
  // truncated codepoint) must never be emitted after the route changed.
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const { sink, writes } = sinkOf();
  let seen = 0;
  let bridge: ReturnType<typeof clipboardTest.framedStdin> | undefined;
  bridge = clipboardTest.framedStdin({
    decoder: createNativeInputDecoder(BOOTSTRAP),
    currentTuple: () => NATIVE,
    startupOpen: () => false,
    maxViewerPayloadBytes: NATIVE_INPUT_RAW_FRAGMENT_BYTES * 4,
    readableEncoding: "utf8",
    onDelivery: () => {
      seen += 1;
      if (seen === 2) bridge!.setEditorSink(sink);
    },
  });
  const payload = Buffer.concat([
    Buffer.from("a".repeat(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 5), "utf8"),
    Buffer.from([0xf0, 0x9f]), // the head of a 4-byte codepoint, left incomplete
  ]);
  const parts = framesOf(encoder.encode(payload, LOCAL));
  assert.equal(parts.length, 2, "a two-fragment dispatch under a string decoder");
  bridge.feed(parts[0]!);
  bridge.feed(parts[1]!);
  assert.equal(bridge.delivered.length, 2, "the dispatch that began natively stays native");
  assert.equal(String(bridge.delivered[1]!.chunk).includes("\uFFFD"), false,
    "the suppressed dispatch flushes no decoder tail into the previous owner");
  assert.equal(writes.length, 0, "and none of it enters the editor that just appeared");
  bridge.feed(encoder.encode(Buffer.from("editor-only"), LOCAL));
  assert.equal(written(writes), "editor-only");
});

test("routing: a completed editor dispatch is closed, so only a later partial frame is orphaned at retirement", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  // A whole dispatch the editor already received is FINISHED, not open.
  bridge.feed(encoder.encode(Buffer.from("finished-in-editor"), LOCAL));
  assert.equal(written(writes), "finished-in-editor");
  const frame = framesOf(encoder.encode(Buffer.from("begun-at-the-edge"), LOCAL))[0]!;
  bridge.feed(frame.slice(0, -1));
  bridge.setEditorSink(undefined);
  bridge.feed(frame.slice(-1));
  assert.equal(writes.length, 1, "nothing more enters the retired editor");
  assert.equal(bridge.delivered.length, 0, "and the obsolete dispatch never reaches the resumed native listeners");
  bridge.feed(encoder.encode(Buffer.from("next"), LOCAL));
  assert.equal(bridge.delivered.length, 1, "the next valid dispatch belongs to the native owner again");
  assert.equal(bridge.delivered[0]!.chunk.toString(), "next");
});

test("routing: a frame split immediately after its tag is orphaned at entry", () => {
  // Zero bytes are retained in exactly this parser state, so ownership follows the
  // decoder's explicit partial-frame state rather than a retained-string length.
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const frame = framesOf(encoder.encode(Buffer.from("split-after-tag"), LOCAL))[0]!;
  assert.equal(frame.startsWith(FRAME_TAG), true);
  bridge.feed(FRAME_TAG);
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  bridge.feed(frame.slice(FRAME_TAG.length));
  assert.equal(writes.length, 0, "a dispatch begun before entry never enters the editor");
  assert.equal(bridge.delivered.length, 0, "and it never reached the native listeners either");
  bridge.feed(encoder.encode(Buffer.from("after"), LOCAL));
  assert.equal(written(writes), "after", "the next valid dispatch belongs to the editor");
});

test("routing: a frame split immediately after its tag is orphaned at retirement", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  bridge.feed(encoder.encode(Buffer.from("typed-in-editor"), LOCAL));
  assert.equal(written(writes), "typed-in-editor");
  const frame = framesOf(encoder.encode(Buffer.from("split-at-retirement"), LOCAL))[0]!;
  bridge.feed(FRAME_TAG);
  bridge.setEditorSink(undefined);
  bridge.feed(frame.slice(FRAME_TAG.length));
  assert.equal(writes.length, 1, "the retired editor receives nothing further");
  assert.equal(bridge.delivered.length, 0, "and the obsolete dispatch does not reach the native listeners");
  bridge.feed(encoder.encode(Buffer.from("back"), LOCAL));
  assert.equal(bridge.delivered.length, 1, "the next valid dispatch is the native owner's again");
  assert.equal(bridge.delivered[0]!.chunk.toString(), "back");
});

test("routing: a held viewer assembly is released at entry and never revived", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const parts = framesOf(encoder.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 3, 0x63), VIEWER, FENCE));
  bridge.feed(parts[0]!);
  assert.equal(bridge.delivered.length, 0, "a viewer prefix is never delivered early");
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  bridge.feed(parts[1]!);
  assert.equal(writes.length, 0, "the held assembly belongs to the previous sink");
  assert.equal(bridge.delivered.length, 0);
});

test("routing: retirement cuts off an open editor dispatch and hands later dispatches back to the native listeners", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  const parts = framesOf(encoder.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 5, 0x64), LOCAL));
  bridge.feed(parts[0]!);
  assert.equal(writes.length, 1);
  bridge.setEditorSink(undefined);
  assert.equal(bridge.editorActive(), false);
  bridge.feed(parts[1]!);
  assert.equal(writes.length, 1, "no late key enters the retired editor");
  assert.equal(bridge.delivered.length, 0, "no late key enters the next sink either");
  bridge.feed(encoder.encode(Buffer.from("back"), LOCAL));
  assert.equal(bridge.delivered.length, 1, "ordinary input is restored");
  assert.equal(bridge.delivered[0]!.chunk.toString(), "back");
  assert.deepEqual(bridge.delivered[0]!.origin, LOCAL, "with its unchanged dispatch scope");
});

test("routing: a routing change never poisons the decoder and never falls back to raw bytes", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  // A truncated frame is a permanent decoder failure, not a routing question.
  bridge.feed("prg-ni-v2;0000000000000000;1;");
  bridge.setEditorSink(undefined);
  bridge.feed(encoder.encode(Buffer.from("ordinary"), LOCAL));
  assert.equal(writes.length, 0, "a poisoned decoder delivers nothing to the editor");
  assert.equal(bridge.delivered.length, 0, "and never the raw or re-tagged bytes to a listener");
});

test("routing: end of input during a handoff releases the dispatch without a raw fallback", () => {
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const { sink, writes } = sinkOf();
  bridge.setEditorSink(sink);
  const parts = framesOf(encoder.encode(Buffer.alloc(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 2, 0x65), VIEWER, FENCE));
  bridge.feed(parts[0]!);
  bridge.end();
  bridge.feed(parts[1]!);
  assert.equal(writes.length, 0);
  assert.equal(bridge.delivered.length, 0);
});

test("routing: the same native tuple across entry and retirement still changes the sink", () => {
  // The route is a handoff fact, never a conversation fact: the tuple is identical
  // (undefined) the whole time and the sink still changes exactly at the boundary.
  const encoder = createNativeInputEncoder(BOOTSTRAP);
  const bridge = newBridge();
  const first = sinkOf();
  bridge.setEditorSink(first.sink);
  bridge.feed(encoder.encode(Buffer.from("one"), LOCAL));
  bridge.setEditorSink(undefined);
  bridge.feed(encoder.encode(Buffer.from("two"), LOCAL));
  const second = sinkOf();
  bridge.setEditorSink(second.sink);
  bridge.feed(encoder.encode(Buffer.from("three"), LOCAL));
  bridge.setEditorSink(undefined);
  bridge.feed(encoder.encode(Buffer.from("four"), LOCAL));
  assert.equal(written(first.writes), "one");
  assert.equal(written(second.writes), "three");
  assert.deepEqual(bridge.delivered.map((entry) => entry.chunk.toString()), ["two", "four"]);
});

/* ------------------------------------------------------------------------- *
 * The spawn adapter: recognition, provenance, and the launch lifecycle
 * ------------------------------------------------------------------------- */

interface FakePty {
  pty: EditorPtySurface;
  writes: Buffer[];
  resizes: Array<{ cols: number; rows: number }>;
  kills: Array<string | undefined>;
  emitData(chunk: string): void;
  emitExit(exitCode: number, signal?: number): void;
  emitError(): void;
  liveListeners(): number;
  errorListeners(): number;
  exitListeners(): number;
}

function fakePty(options: { throwOnExit?: boolean; throwOnData?: boolean; noWitness?: boolean } = {}): FakePty {
  const writes: Buffer[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const kills: Array<string | undefined> = [];
  const data: Array<(chunk: string) => void> = [];
  const exits: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  let disposed = 0;
  const disposable = (): { dispose(): void } => ({ dispose: () => { disposed += 1; } });
  const pty = {
    pid: 4242,
    write(data: Buffer) { writes.push(Buffer.from(data)); },
    resize(cols: number, rows: number) { resizes.push({ cols, rows }); },
    kill(signal?: string) { kills.push(signal); },
    onData(listener: (chunk: string) => void) {
      if (options.throwOnData) throw new Error("data failed");
      data.push(listener);
      return disposable();
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      if (options.throwOnExit === true || options.noWitness) throw new Error("exit failed");
      exits.push(listener);
      return disposable();
    },
    on(event: string, listener: (payload: never) => void) {
      if (options.noWitness) throw new Error("no emitter");
      if (event === "error") errors.push(listener as (error: Error) => void);
      if (event === "exit") exits.push(listener as unknown as (event: { exitCode: number; signal?: number }) => void);
    },
    removeListener(event: string, listener: (payload: never) => void) {
      const at = event === "error"
        ? errors.indexOf(listener as (error: Error) => void)
        : exits.indexOf(listener as unknown as (event: { exitCode: number; signal?: number }) => void);
      if (at >= 0) (event === "error" ? errors : exits).splice(at, 1);
    },
  } as unknown as EditorPtySurface;
  return {
    pty, writes, resizes, kills,
    emitData: (chunk) => { for (const listener of [...data]) listener(chunk); },
    emitExit: (exitCode, signal) => { for (const listener of [...exits]) listener({ exitCode, signal }); },
    emitError: () => { for (const listener of [...errors]) listener(new Error("pty read")); },
    liveListeners: () => data.length + exits.length - disposed,
    errorListeners: () => errors.length,
    exitListeners: () => exits.length,
  };
}

/** A faithful-enough terminal: raw mode, pause/resume, size, and the resize event. */
function fakeTerminal(cols = 100, rows = 30) {
  const handlers = new Set<() => void>();
  return {
    isTTY: true,
    isRaw: false,
    paused: true,
    columns: cols,
    rows,
    rawCalls: [] as boolean[],
    setRawMode(mode: boolean) { this.isRaw = mode; this.rawCalls.push(mode); },
    resume() { this.paused = false; },
    pause() { this.paused = true; },
    isPaused() { return this.paused; },
    on(_event: "resize", listener: () => void) { handlers.add(listener); },
    off(_event: "resize", listener: () => void) { handlers.delete(listener); },
    emitResize() { for (const listener of [...handlers]) listener(); },
    handlerCount: () => handlers.size,
  };
}

interface Harness {
  root: string;
  runtime: NativeClipboardRuntime;
  stdin: ReturnType<typeof fakeTerminal>;
  stdout: ReturnType<typeof fakeTerminal>;
  relays: string[];
  notices: string[];
  /** Spawn calls that reached the underlying implementation (pass-throughs only). */
  real: string[];
  sinks: Array<EditorHandoffSink | undefined>;
  ptys: FakePty[];
  descriptors: EditorPtyDescriptor[];
  active(): boolean;
  /** Import one launcher module placed inside (or outside) the audited runtime. */
  launch(relativePath: string, body: string): Promise<{ call(command: string, args: string[], file: string, options?: unknown): Promise<unknown> }>;
  cleanup(): void;
}

const childProcess = require("node:child_process") as { spawn: unknown };
const originalSpawn = childProcess.spawn;
const nodeModule = require("node:module") as { syncBuiltinESMExports?(): void };

function newHarness(options: { pty?: { throwOnExit?: boolean; throwOnData?: boolean; noWitness?: boolean }; ptyFactoryThrows?: boolean; sinkThrows?: boolean; supported?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "prg-editor-handoff-"));
  mkdirSync(join(root, "dist", "modes", "interactive"), { recursive: true });
  mkdirSync(join(root, "dist", "bundle", "chunks"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  const relays: string[] = [];
  const notices: string[] = [];
  const sinks: Array<EditorHandoffSink | undefined> = [];
  const ptys: FakePty[] = [];
  const descriptors: EditorPtyDescriptor[] = [];
  // Each harness owns one adapter: clear any previous one first, because the patch
  // is process-wide and idempotent by design. The "original" the adapter captures is
  // a counting wrapper, so a taken-over launch is observably never spawned.
  childProcess.spawn = originalSpawn;
  const real: string[] = [];
  childProcess.spawn = function counted(this: unknown, file: unknown, args?: unknown, opts?: unknown): unknown {
    real.push(String(file));
    return (originalSpawn as (this: unknown, ...a: unknown[]) => unknown).call(this, file, args, opts);
  };
  let counter = 0;
  const instance: Harness = {
    root,
    runtime: { root, supported: options.supported !== false },
    stdin: fakeTerminal(),
    stdout: fakeTerminal(),
    relays,
    notices,
    sinks,
    ptys,
    descriptors,
    real,
    active: () => sinks[sinks.length - 1] !== undefined,
    async launch(relativePath, body) {
      const path = join(root, relativePath.replace(/\.mjs$/, `${counter++}.mjs`));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `import { spawn } from "node:child_process";
export async function editInExternalEditor(command, args, filePath, options) {
  return await new Promise((resolve, reject) => {
    const child = ${body};
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code));
  });
}
`, "utf8");
      const module = await dynamicImport(`${pathToFileURL(path).href}`);
      return {
        call: async (command, args, file, launchOptions) =>
          await module.editInExternalEditor(command, args, file, launchOptions),
      };
    },
    cleanup: () => {
      childProcess.spawn = originalSpawn;
      nodeModule.syncBuiltinESMExports?.();
      setEditorPtyLoaderForTests(undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
  installNativeEditorHandoff({
    runtime: instance.runtime,
    editorActive: () => instance.active(),
    setEditorSink: (sink) => { if (options.sinkThrows) throw new Error("route failed"); sinks.push(sink); },
    writeStdout: (chunk) => { relays.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")); return true; },
    stdin: instance.stdin as never,
    stdout: instance.stdout as never,
    stderr: { write: (chunk: string) => { notices.push(chunk); return true; } },
    ptyFactory: (descriptor) => {
      descriptors.push(descriptor);
      if (options.ptyFactoryThrows) throw new Error("no pty available");
      const fake = fakePty(options.pty);
      ptys.push(fake);
      return fake.pty;
    },
  });
  return instance;
}

test.after(() => {
  childProcess.spawn = originalSpawn;
  nodeModule.syncBuiltinESMExports?.();
  setEditorPtyLoaderForTests(undefined);
});

/** The audited launch body, exactly as the shipped launcher writes it. */
const AUDIT_BODY = 'spawn(command, [...args, filePath], options ?? { stdio: "inherit", shell: false })';

test("adapter: the audited launcher inside the runtime dist gets its own PTY, never fd 0", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", `(() => {
    const child = spawn(command, [...args, filePath], options ?? { stdio: "inherit", shell: false });
    globalThis.__prgEditorChild = child;
    return child;
  })()`);
  const observed: Array<Record<string, unknown>> = [];
  const pending = editor.call("/usr/bin/vim", ["-u", "NONE"], "/tmp/prompt.md") as Promise<unknown>;
  await new Promise((resolve) => setImmediate(resolve));
  const child = (globalThis as Record<string, unknown>).__prgEditorChild as {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  child.on("close", () => observed.push({
    retired: harness.sinks.length === 2 && harness.sinks[1] === undefined,
    raw: harness.stdin.isRaw,
    paused: harness.stdin.paused,
    resizeListeners: harness.stdout.handlerCount(),
  }));
  assert.equal(harness.real.length, 0, "the real inherited-stdio spawn never ran");
  assert.equal(harness.descriptors.length, 1, "the launch was taken over");
  assert.equal(harness.descriptors[0]!.file, "/usr/bin/vim");
  assert.deepEqual(harness.descriptors[0]!.args, ["-u", "NONE", "/tmp/prompt.md"],
    "the configured command and full argument vector are preserved verbatim");
  assert.deepEqual(harness.descriptors[0]!.cols, 100);
  assert.deepEqual(harness.descriptors[0]!.rows, 30);
  assert.deepEqual(harness.sinks, [harness.sinks[0]], "the route entered exactly once");
  assert.equal(harness.sinks[0] !== undefined, true);
  assert.equal(harness.stdin.isRaw, true, "this process's own tty stops echoing and buffering frames");
  assert.equal(harness.stdin.paused, false, "and its bytes reach the bridge");
  assert.equal(harness.stdout.handlerCount(), 1);

  const fake = harness.ptys[0]!;
  harness.sinks[0]!.write(Buffer.from("i\rhéllo\x1b", "utf8"));
  assert.equal(Buffer.compare(fake.writes[0]!, Buffer.from("i\rhéllo\x1b", "utf8")), 0);
  fake.emitData("\x1b[1;1Hvim screen\r\n");
  assert.deepEqual(harness.relays, ["\x1b[1;1Hvim screen\r\n"], "editor output relays through the original stdout writer");
  fake.emitError();
  assert.equal(harness.sinks.length, 1, "a PTY read error alone settles nothing");

  harness.stdout.columns = 120;
  harness.stdout.rows = 40;
  harness.stdout.emitResize();
  assert.deepEqual(fake.resizes, [{ cols: 120, rows: 40 }], "the host's resize reaches the editor");

  fake.emitExit(0);
  assert.equal(await pending, 0, "the editor's exit code reaches the launcher");
  assert.deepEqual(observed, [{ retired: true, raw: false, paused: true, resizeListeners: 0 }],
    "the launcher resumes only after input ownership, raw mode, pause state, and listeners are restored");
  assert.equal(fake.liveListeners(), 0, "the owned PTY's listeners are released");
  assert.equal(fake.errorListeners(), 0, "and its error hook too");
  assert.equal(fake.kills.length, 0, "a normal exit needs no signal");
  delete (globalThis as Record<string, unknown>).__prgEditorChild;
});

test("adapter: child fields stay live and kill reaches only the owned PTY", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", `(() => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    globalThis.__prgEditorChild = child;
    return child;
  })()`);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  const child = (globalThis as Record<string, unknown>).__prgEditorChild as {
    pid: number; killed: boolean; exitCode: number | null; signalCode: number | null; kill(signal?: string): boolean;
  };
  assert.equal(child.pid, 4242, "the owned PTY's pid is visible");
  assert.equal(child.killed, false);
  assert.equal(child.kill("SIGTERM"), true);
  assert.deepEqual(harness.ptys[0]!.kills, ["SIGTERM"]);
  assert.equal(child.killed, true);
  assert.equal(harness.sinks.length, 1, "a signal is not a settlement");
  assert.equal(harness.active(), true);
  const exitListeners = process.listenerCount("exit");
  assert.ok(exitListeners > 0);
  harness.ptys[0]!.emitExit(143, 15);
  assert.equal(await pending, null, "a signal death has no exit code for the launcher");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM", "the PTY's numeric signal becomes the child's signal name");
  assert.equal(child.kill("SIGKILL"), false, "a settled child owns nothing to kill");
  assert.deepEqual(harness.sinks[1], undefined);
  assert.equal(process.listenerCount("exit"), exitListeners - 1, "the exit cleanup hook is unbound at settlement");
  delete (globalThis as Record<string, unknown>).__prgEditorChild;
});

test("adapter: process exit while the editor is active signals only the owned PTY", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  void pending;
  await new Promise((resolve) => setImmediate(resolve));
  (process as unknown as { emit(event: string): boolean }).emit("exit");
  assert.deepEqual(harness.ptys[0]!.kills, [undefined], "cleanup safety, never a routing decision");
  assert.equal(harness.sinks.length, 1, "and the settlement still waits for the owned exit");
  harness.ptys[0]!.emitExit(0);
});

test("adapter: once an editor exists only its own exit settles the launch", async (t) => {
  const harness = newHarness({ sinkThrows: true });
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", `(() => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    globalThis.__prgEditorChild = child;
    return child;
  })()`);
  const events: string[] = [];
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md")
    .then(() => { events.push("close"); }, () => { events.push("error"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0, "a setup failure never resumes the launcher while the editor is live");
  assert.deepEqual(harness.ptys[0]!.kills, [undefined], "the owned editor is asked to stop");
  assert.equal(harness.sinks.length, 0, "the route never entered, so nothing is routed yet");
  assert.equal(harness.stdin.isRaw, true, "raw mode was entered and stays entered until the editor is gone");
  assert.equal(harness.notices.length, 0);
  harness.ptys[0]!.emitExit(137, 9);
  await pending;
  assert.deepEqual(events, ["error"], "and the launcher learns only after that positive exit");
  assert.deepEqual(harness.sinks[1], undefined, "ownership is retired at settlement");
  assert.equal(harness.stdin.isRaw, false);
  assert.match(harness.notices.join(""), /could not be set up on its own terminal/);
  delete (globalThis as Record<string, unknown>).__prgEditorChild;
});

test("adapter: a signal-terminated editor is never a successful edit", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", `(() => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    globalThis.__prgEditorChild = child;
    return child;
  })()`);
  const seen: unknown[][] = [];
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  const child = (globalThis as Record<string, unknown>).__prgEditorChild as { on(e: string, l: (...a: unknown[]) => void): void };
  child.on("exit", (...args) => { seen.push(args); });
  // The shape a PTY reports for a signal death: exit code 0 with a live signal.
  harness.ptys[0]!.emitExit(0, 15);
  assert.equal(await pending, null, "the launcher sees a null code, never the zero it would read as success");
  assert.deepEqual(seen, [[null, "SIGTERM"]]);
  assert.equal(harness.sinks.length, 2, "and the handoff still settled before the launcher resumed");
  delete (globalThis as Record<string, unknown>).__prgEditorChild;
});

test("adapter: an exit observer that cannot be attached falls back to the surface's own exit event", async (t) => {
  const harness = newHarness({ pty: { throwOnExit: true } });
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.descriptors.length, 1);
  assert.equal(harness.ptys[0]!.exitListeners(), 1, "the equivalent witness on the owned surface is used");
  assert.equal(harness.sinks.length, 1, "the launch is live, with the route entered");
  harness.ptys[0]!.emitExit(0);
  assert.equal(await pending, 0);
  assert.equal(harness.ptys[0]!.exitListeners(), 0, "and the witness is released at settlement");
});

test("adapter: with no exit witness at all the launch is held, never answered", async (t) => {
  const harness = newHarness({ pty: { noWitness: true } });
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", `(() => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    globalThis.__prgEditorChild = child;
    return child;
  })()`);
  const events: string[] = [];
  const exitHooks = process.listenerCount("exit");
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md")
    .then(() => { events.push("close"); }, () => { events.push("error"); });
  void pending;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [], "the launcher is never told the launch failed or finished");
  assert.equal(harness.sinks.length, 0, "the route never entered, so no bytes are routed");
  assert.equal(harness.stdin.isRaw, false, "and this process's terminal was never taken over");
  assert.equal(harness.stdout.handlerCount(), 0, "no resize listener was left behind");
  assert.equal(harness.ptys[0]!.kills.length, 1, "the editor that exists is signalled");
  assert.ok(process.listenerCount("exit") > exitHooks, "and its cannot-outlive-owner cleanup stays bound");
  delete (globalThis as Record<string, unknown>).__prgEditorChild;
});

test("adapter: the shipped bundle's chunk callsite is audited; a foreign one is refused", async (t) => {
  const bundled = newHarness();
  t.after(bundled.cleanup);
  const editor = await bundled.launch("dist/bundle/chunks/chunk-MM3LKT73.mjs", AUDIT_BODY);
  const pending = editor.call("/usr/bin/vim", ["-u", "NONE"], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bundled.descriptors.length, 1, "a dist/bundle/chunks callsite is inside the audited dist");
  bundled.ptys[0]!.emitExit(0);
  assert.equal(await pending, 0);

  const foreign = newHarness();
  t.after(foreign.cleanup);
  const other = await foreign.launch("outside/extension-editor.mjs", AUDIT_BODY);
  await assert.rejects(other.call("/usr/bin/vim", [], "/tmp/prompt.md"), /could not be authenticated/);
  assert.equal(foreign.descriptors.length, 0, "no editor was started");
  assert.equal(foreign.sinks.length, 0, "and the input route never changed");
  assert.match(foreign.notices.join(""), /external editor launcher could not be authenticated/);
  assert.equal(foreign.stdin.isRaw, false);
});

test("adapter: an unsupported runtime version is refused even by its own audited launcher", async (t) => {
  // resolveNativeClipboardRuntime() recognizes a package version it has NOT audited and
  // reports supported:false. A matching launcher frame under that dist must not be
  // taken over: its launch and result semantics were never verified.
  const harness = newHarness({ supported: false });
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  await assert.rejects(editor.call("/usr/bin/vim", ["-u", "NONE"], "/tmp/prompt.md"), /could not be authenticated/);
  assert.equal(harness.descriptors.length, 0, "no PTY was created");
  assert.equal(harness.ptys.length, 0, "and no editor surface exists");
  assert.equal(harness.real.length, 0, "the inherited launch was never passed through to the real spawn either");
  assert.equal(harness.sinks.length, 0, "the input route never changed");
  assert.equal(harness.stdin.isRaw, false, "and this process's terminal mode is untouched");
  assert.match(harness.notices.join(""), /external editor launcher could not be authenticated/);

  // Refusing that launch changes nothing else: an unrelated spawn still reaches the
  // underlying implementation byte-for-byte.
  const path = join(harness.root, "outside", "unrelated.mjs");
  writeFileSync(path, `import { spawn } from "node:child_process";
export function piped() { return spawn(process.execPath, ["-e", "0"], { stdio: ["pipe", "pipe", "pipe"] }); }
`, "utf8");
  const module = await dynamicImport(pathToFileURL(path).href);
  const child = module.piped() as { on(event: string, listener: () => void): void };
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  assert.equal(harness.real.length, 1, "an unrelated spawn is left exactly as it is");
  assert.equal(harness.descriptors.length, 0);
});

test("adapter: every other spawn is left exactly as it is", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  const path = join(harness.root, "outside", "other.mjs");
  writeFileSync(path, `import { spawn } from "node:child_process";
export function piped() { return spawn(process.execPath, ["-e", "0"], { stdio: ["pipe", "pipe", "pipe"] }); }
export function inheritedOther() { return spawn(process.execPath, ["-e", "0"], { stdio: "inherit" }); }
export function shelled() { return spawn(process.execPath, ["-e", "0"], { stdio: "inherit", shell: true }); }
`, "utf8");
  const module = await dynamicImport(pathToFileURL(path).href);
  for (const name of ["piped", "inheritedOther", "shelled"]) {
    const child = module[name]() as { on(event: string, listener: () => void): void };
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  }
  assert.equal(harness.descriptors.length, 0, "no piped, foreign, or shell launch is taken over");
  assert.equal(harness.real.length, 3, "all three reached the underlying spawn unchanged");
  assert.equal(harness.sinks.length, 0);
});

test("adapter: a launch that cannot be established fails closed instead of inheriting fd 0", async (t) => {
  const notTty = newHarness();
  t.after(notTty.cleanup);
  notTty.stdin.isTTY = false;
  const editorA = await notTty.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  await assert.rejects(editorA.call("/usr/bin/vim", [], "/tmp/prompt.md"), /could not be given its own terminal/);
  assert.equal(notTty.descriptors.length, 0);
  assert.equal(notTty.stdin.rawCalls.length, 0, "no terminal mode change without a launch");

  const noPty = newHarness({ ptyFactoryThrows: true });
  t.after(noPty.cleanup);
  const editorB = await noPty.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  await assert.rejects(editorB.call("/usr/bin/vim", [], "/tmp/prompt.md"), /could not be given its own terminal/);
  assert.equal(noPty.sinks.length, 0, "the route never entered when the PTY could not start");
  assert.equal(noPty.stdin.isRaw, false);

  const busy = newHarness();
  t.after(busy.cleanup);
  const editorC = await busy.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  const first = editorC.call("/usr/bin/vim", [], "/tmp/one.md");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(busy.descriptors.length, 1);
  await assert.rejects(editorC.call("/usr/bin/vim", [], "/tmp/two.md"), /already holds this terminal/);
  assert.equal(busy.descriptors.length, 1, "a second editor cannot share one input route, and the first keeps its terminal");
  busy.ptys[0]!.emitExit(0);
  assert.equal(await first, 0);
});

test("adapter: terminal state is restored to what the launch actually found", async (t) => {
  const harness = newHarness();
  t.after(harness.cleanup);
  harness.stdin.isRaw = true;
  harness.stdin.paused = false;
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", AUDIT_BODY);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.stdin.rawCalls, [true], "no redundant mode change");
  harness.ptys[0]!.emitExit(0);
  assert.equal(await pending, 0);
  assert.equal(harness.stdin.isRaw, true, "raw mode was already on and stays on");
  assert.equal(harness.stdin.paused, false, "and the stream was already flowing");
});

test("adapter: not installed on a platform whose launcher shape differs", () => {
  childProcess.spawn = originalSpawn;
  assert.equal(installNativeEditorHandoff({
    runtime: { root: "/nonexistent", supported: true },
    editorActive: () => false,
    setEditorSink: () => undefined,
    writeStdout: () => true,
    platform: "win32",
    ptyFactory: () => fakePty().pty,
  }), false);
  assert.equal(childProcess.spawn, originalSpawn, "child_process.spawn untouched");
});

/** The slot key the handoff binds while it owns an editor, cleared for determinism. */
const SHUTDOWN_SLOT = Symbol.for("pi-review-gate.native-editor-handoff.shutdown.v1");
function clearShutdownSlot(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[SHUTDOWN_SLOT];
}

const INHERIT_BODY = `(() => {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    globalThis.__prgEditorChild = child;
    return child;
  })()`;

test("shutdown: an owned editor settles before the awaited native shutdown resolves", async (t) => {
  clearShutdownSlot();
  const harness = newHarness();
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", INHERIT_BODY);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));

  const settling = settleOwnedNativeEditor();
  assert.ok(settling, "an owned editor gives the shutdown something to wait for");
  let resolved = false;
  void settling.then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "the stop waits for the editor's own exit, not for a signal merely sent");
  assert.deepEqual(harness.ptys[0]!.kills, [undefined], "the owned editor is asked to leave");

  harness.ptys[0]!.emitExit(0, 0);
  assert.equal(await settling, true, "positive settlement is the editor's own exit");
  assert.equal(settleOwnedNativeEditor(), undefined, "the settled editor releases the slot: a later stop waits for nothing");
  assert.deepEqual(harness.ptys[0]!.kills, [undefined], "an idle stop signals nothing");
  assert.equal(await pending, 0, "the launcher still sees its own exit code");
});

test("shutdown: no owned editor defers nothing and changes nothing", async (t) => {
  clearShutdownSlot();
  const harness = newHarness();
  t.after(harness.cleanup);
  assert.equal(settleOwnedNativeEditor(), undefined, "with no editor owned the shutdown continues synchronously");
  assert.equal(harness.ptys.length, 0);
  assert.equal(harness.sinks.length, 0, "an idle stop never takes the input route");
});

test("shutdown: an editor with no exit witness reports settlement unavailable, never a hang", async (t) => {
  clearShutdownSlot();
  const harness = newHarness({ pty: { noWitness: true } });
  t.after(harness.cleanup);
  const editor = await harness.launch("dist/modes/interactive/external-editor.mjs", INHERIT_BODY);
  const pending = editor.call("/usr/bin/vim", [], "/tmp/prompt.md");
  await new Promise((resolve) => setImmediate(resolve));
  const outcome = await Promise.race([
    settleOwnedNativeEditor(),
    new Promise<"hung">((resolve) => { setTimeout(() => resolve("hung"), 500).unref(); }),
  ]);
  assert.equal(outcome, false, "an unwitnessable editor must not stall the host's existing stop path");
  assert.equal(harness.ptys[0]!.kills.length, 1, "it is still asked to leave");
  clearShutdownSlot();
  void pending;
});
