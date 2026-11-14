import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  isNativeViewerNativeCliClipboardReceipt,
  isNativeViewerNativeCliInputSource,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type InstanceStatusUpdate,
  type NativeCliClipboardEvent,
  type NativeCliLaunch,
  type NativeViewerAnyInputSource,
  type NativeViewerClipboardReceipt,
  type NativeViewerClipboardSink,
  type NativeViewerInputRequest,
  type NativeViewerNativeCliClipboardReceipt,
  type NativeViewerNativeCliInputSource,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import {
  NATIVE_COPY_MAX_ENCODED_CHARS,
} from "../src/session-host/network/session-content-protocol";
import {
  isNativeCliCopyEncoded,
  parseNativeCliOsc52Text,
} from "../src/session-host/native-clipboard";
import { TerminalSurface, type TerminalSurfaceOptions } from "../src/session-host/terminal-surface";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

/**
 * Focused coverage for the hosted provider TEXT copy core (issue 277 native
 * text-copy slice): a standard OSC 52 text request emitted INSIDE an owned
 * Claude/Codex PTY reaches the clipboard route of the surface this manager last
 * accepted input for on that exact child incarnation — and nobody else.
 *
 * EVIDENCE SCOPE: every child here is a synthetic PTY writing synthetic terminal
 * bytes, and every launch descriptor comes from an injected test provider. Nothing
 * runs a real provider binary, reads or writes any real OS clipboard, provider
 * configuration, credentials, or conversation, or proves what a real provider TUI
 * emits. What is proven is the owner-side contract: the capture sink is closed and
 * opt-in (raw OSC 52 stays denied everywhere else, including on a Pi row), the
 * captured payload is normalized text or nothing, the recipient is the most recent
 * ACTUAL accepted input (never a selected form, a refused request, or a terminal
 * protocol reply), it is frozen when the copy is accepted, and a stale, closed,
 * moved, exited, malformed, or over-bound case delivers nothing with no fallback,
 * no broadcast, and no Pi-style conversation tuple invented anywhere.
 */

const ESC = "\x1b";
const BEL = "\x07";
const HOST_RUN = "run-native-copy-1";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const osc52 = (selection: string, payload: string): string => `${ESC}]52;${selection};${payload}${BEL}`;

/* ------------------------------------------------------------------------- *
 * The closed capture parser
 * ------------------------------------------------------------------------- */

test("the OSC 52 text parser accepts standard text requests and normalizes them", () => {
  assert.equal(parseNativeCliOsc52Text(`c;${b64("copied from the child")}`), b64("copied from the child"));
  assert.equal(parseNativeCliOsc52Text(`p;${b64("x")}`), b64("x"));
  // `q` is the standard SECONDARY clipboard, not an unknown code.
  assert.equal(parseNativeCliOsc52Text(`q;${b64("secondary clipboard")}`), b64("secondary clipboard"));
  assert.equal(parseNativeCliOsc52Text(`s;${b64("selection")}`), b64("selection"));
  assert.equal(parseNativeCliOsc52Text(`7;${b64("cut buffer seven")}`), b64("cut buffer seven"));
  // Several standard clipboard codes in one request stay valid.
  assert.equal(parseNativeCliOsc52Text(`cp0;${b64("multi")}`), b64("multi"));
  // An EMPTY selection field is the standard default-selection spelling: the copy
  // is still captured, because refusing it would silently drop a real request.
  assert.equal(parseNativeCliOsc52Text(`;${b64("default selection")}`), b64("default selection"));
  // Unicode and multiline text survive byte-exactly.
  const unicode = "line one\nline two \u{1f4cc} \u00e9\u00e8";
  assert.equal(Buffer.from(parseNativeCliOsc52Text(`c;${b64(unicode)}`) ?? "", "base64").toString("utf8"), unicode);
  // The result is always re-canonicalized, so a caller never forwards a variant spelling.
  const encoded = parseNativeCliOsc52Text(`c;${b64("canonical")}`);
  assert.ok(encoded !== undefined && isNativeCliCopyEncoded(encoded));
});

test("the OSC 52 text parser refuses queries, malformed frames, binary, and over-bound payloads whole", () => {
  // A clipboard QUERY is never a copy and is never answered — including the
  // default-selection spelling of one.
  assert.equal(parseNativeCliOsc52Text("c;?"), undefined);
  assert.equal(parseNativeCliOsc52Text("c0;?"), undefined);
  assert.equal(parseNativeCliOsc52Text(";?"), undefined);
  // Missing or extra fields, and a payload that never arrived.
  assert.equal(parseNativeCliOsc52Text(b64("no selection field")), undefined);
  assert.equal(parseNativeCliOsc52Text(`c;`), undefined);
  assert.equal(parseNativeCliOsc52Text(`;`), undefined);
  assert.equal(parseNativeCliOsc52Text(`c;${b64("a")};${b64("b")}`), undefined);
  // Genuinely unknown selection fields: letters outside the closed set, an
  // uppercase spelling, a wildcard, a space-separated list, and a cut buffer
  // outside 0-7. Only the EMPTY field is the default; nothing else is.
  assert.equal(parseNativeCliOsc52Text(`x;${b64("unknown clipboard code")}`), undefined);
  assert.equal(parseNativeCliOsc52Text(`Q;${b64("uppercase is not a standard code")}`), undefined);
  assert.equal(parseNativeCliOsc52Text(`c*;${b64("wildcard")}`), undefined);
  assert.equal(parseNativeCliOsc52Text(`c p;${b64("space separated list")}`), undefined);
  assert.equal(parseNativeCliOsc52Text(`8;${b64("no such cut buffer")}`), undefined);
  // Empty, non-canonical, non-base64, and binary payloads.
  assert.equal(parseNativeCliOsc52Text("c;"), undefined);
  assert.equal(parseNativeCliOsc52Text("c;===="), undefined);
  assert.equal(parseNativeCliOsc52Text(`c;${b64("\u0000\u0001\u0002binary").slice(0, -2)}`), undefined);
  assert.equal(parseNativeCliOsc52Text(`c;${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`), undefined);
  // Over the unchanged native producer bound: refused whole, never truncated.
  const overBound = "A".repeat(NATIVE_COPY_MAX_ENCODED_CHARS + 4);
  assert.equal(parseNativeCliOsc52Text(`c;${overBound}`), undefined);
  assert.equal(isNativeCliCopyEncoded(overBound), false);
  // Exactly at the bound is still a whole, accepted copy.
  const atBound = "A".repeat(NATIVE_COPY_MAX_ENCODED_CHARS);
  assert.equal(parseNativeCliOsc52Text(`c;${atBound}`), atBound);
});

/* ------------------------------------------------------------------------- *
 * The surface's closed opt-in sink
 * ------------------------------------------------------------------------- */

function makeSurface(options: TerminalSurfaceOptions = {}): TerminalSurface {
  return new TerminalSurface(20, 4, options);
}

async function writeAll(surface: TerminalSurface, chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks) surface.write(chunk);
  await surface.flush();
}

test("an opted-in surface captures one valid OSC 52 text copy once and never renders it", async () => {
  const captured: string[] = [];
  const replies: string[] = [];
  const surface = makeSurface({
    onNativeCliOsc52Copy: (encoded) => captured.push(encoded),
    onReply: (data) => replies.push(data),
  });
  try {
    await writeAll(surface, ["visible text", osc52("c", b64("secret copied text"))]);
    assert.deepEqual(captured, [b64("secret copied text")], "the normalized text reaches the sink exactly once");
    assert.deepEqual(replies, [], "a copy request never generates a reply toward the child");
    const rendered = surface.frame().lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.ok(rendered.includes("visible text"), "ordinary output still renders");
    assert.ok(!rendered.includes("secret") && !rendered.includes(b64("secret copied text")),
      "neither the copy text nor its encoding ever reaches frame text");
    // The standard default-selection spelling and the SECONDARY clipboard are real
    // copy requests, so an opted-in surface captures them too.
    captured.length = 0;
    await writeAll(surface, [osc52("", b64("default selection")), osc52("q", b64("secondary clipboard"))]);
    assert.deepEqual(captured, [b64("default selection"), b64("secondary clipboard")],
      "a standard default or secondary selection request is captured, not dropped");
  } finally {
    surface.dispose();
  }
});

test("without the closed opt-in, raw OSC 52 stays denied exactly as before", async () => {
  const captured: string[] = [];
  const surface = makeSurface({ onNativeCliOsc52Copy: (encoded) => captured.push(encoded) });
  const surfaceWithout = makeSurface();
  try {
    await writeAll(surfaceWithout, ["shown", osc52("c", b64("raw-child-secret"))]);
    assert.deepEqual(captured, [], "an opted-in sink on another surface is unaffected");
    const rendered = surfaceWithout.frame().lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.ok(rendered.includes("shown"));
    assert.ok(!rendered.includes("raw-child-secret"), "a denied OSC 52 never becomes frame text either");
  } finally {
    surface.dispose();
    surfaceWithout.dispose();
  }
});

test("a query, malformed, or over-bound OSC 52 captures nothing on an opted-in surface", async () => {
  const captured: string[] = [];
  const surface = makeSurface({ onNativeCliOsc52Copy: (encoded) => captured.push(encoded) });
  try {
    await writeAll(surface, [
      osc52("c", "?"),
      osc52("", "?"), // the default-selection spelling of a QUERY
      osc52("x", b64("unknown clipboard code")),
      osc52("c p", b64("space separated list")),
      osc52("c*", b64("wildcard")),
      `${ESC}]52;${b64("no selection field")}${BEL}`,
      osc52("c", Buffer.from([0xff, 0xfe]).toString("base64")),
      osc52("c", "A".repeat(NATIVE_COPY_MAX_ENCODED_CHARS + 4)),
    ]);
    assert.deepEqual(captured, [], "every refused request is refused whole");
    // A valid request afterwards still works: a refusal never latches the sink.
    await writeAll(surface, [osc52("c", b64("after the refusals"))]);
    assert.deepEqual(captured, [b64("after the refusals")]);
  } finally {
    surface.dispose();
  }
});

/* ------------------------------------------------------------------------- *
 * The manager: capture, recipient selection, and delivery
 * ------------------------------------------------------------------------- */

/** One synthetic owned child that records exactly what its owner did to it. */
class SpyPty implements InstancePty {
  static #nextPid = 980_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly writes: (string | Buffer)[] = [];
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose: () => { const i = this.#dataListeners.indexOf(listener); if (i >= 0) this.#dataListeners.splice(i, 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { const i = this.#exitListeners.indexOf(listener); if (i >= 0) this.#exitListeners.splice(i, 1); } };
  }

  on(eventName: "error", listener: (error: Error) => void): void { assert.equal(eventName, "error"); this.#errorListeners.push(listener); }
  removeListener(eventName: "error", listener: (error: Error) => void): void {
    assert.equal(eventName, "error");
    const i = this.#errorListeners.indexOf(listener);
    if (i >= 0) this.#errorListeners.splice(i, 1);
  }

  readonly #errorListeners: ((error: Error) => void)[] = [];

  write(data: string | Buffer): void { this.writes.push(data); }
  resize(columns: number, rows: number): void { this.cols = columns; this.rows = rows; }
  kill(): void { this.emitExit(0, 15); }
  pause(): void { /* observed elsewhere */ }
  resume(): void { /* observed elsewhere */ }

  emitData(data: string): void { for (const listener of [...this.#dataListeners]) listener(data); }
  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }

  exited = false;
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: "ab".repeat(32),
        instanceId,
        generation: "00000000-0000-4000-8000-000000000001",
      },
      release: () => undefined,
    };
  }
}

interface Harness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  registrar: RecordingRegistrar;
  spawned: SpyPty[];
  piRoute: Array<{ instanceId: string; event: unknown }>;
  localRoute: Array<{ instanceId: string; event: NativeCliClipboardEvent }>;
  sinks: Array<Array<NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt>>;
}

function makeHarness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(process.cwd(), `.prg-native-cli-copy-${label}-`)));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture; not the production preload.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Node CLI fixture for descriptor-only manager tests.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const agentDir = join(root, "native-agent");
  mkdirSync(agentDir, { recursive: true });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const registrar = new RecordingRegistrar();
  const spawned: SpyPty[] = [];
  const piRoute: Harness["piRoute"] = [];
  const localRoute: Harness["localRoute"] = [];
  const sinks: Harness["sinks"] = [];
  const provider: NativeCliLaunch = (backend, request) => ({
    file: `/synthetic/bin/${backend}`,
    args: ["--interactive"],
    env: { PATH: "/synthetic/bin", HOME: root },
    cwd: request.workspace,
  });
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: provider,
    onNativeClipboard: (instanceId, event) => { piRoute.push({ instanceId, event }); },
    onNativeCliClipboard: (instanceId, event) => { localRoute.push({ instanceId, event }); },
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, workspace, manager, registrar, spawned, piRoute, localRoute, sinks };
}

/** Register one surface with its own copy sink and this host's run identity. */
function openSurface(harness: Harness, onDeliver?: () => void): string {
  const receipts: Array<NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt> = [];
  harness.sinks.push(receipts);
  const viewer = harness.manager.openViewer({
    hostRunId: HOST_RUN,
    nativeClipboardSink: (receipt) => {
      receipts.push(receipt);
      // A surface's own delivery may run arbitrary host work; the receipt handed to
      // it must already be the frozen one.
      onDeliver?.();
    },
  });
  assert.ok(viewer, "the manager must accept a surface registration");
  return viewer.viewerId;
}

async function createRow(harness: Harness, backend: NativeCliBackend = "claude"): Promise<string> {
  const options: CreateInstanceOptions = { workspace: harness.workspace, backend };
  return await harness.manager.create(options);
}

function ptyOf(harness: Harness, file: string): SpyPty {
  const pty = harness.spawned.find((candidate) => candidate.spawnDescriptor.file.endsWith(file));
  assert.ok(pty, `the ${file} child was spawned`);
  return pty;
}

function modesOf(harness: Harness, rowId: string): TerminalInputModes {
  const surface = harness.manager.surface(rowId);
  assert.ok(surface, "a launched row owns its terminal surface");
  return surface.inputModes();
}

function nativeScope(harness: Harness, viewerId: string): NativeViewerNativeCliInputSource {
  const scope = harness.manager.readViewerInputSource(viewerId);
  assert.ok(scope !== undefined, "a live hosted row has a current input scope");
  assert.equal(isNativeViewerNativeCliInputSource(scope), true);
  return scope as NativeViewerNativeCliInputSource;
}

function viewerInput(
  harness: Harness,
  viewerId: string,
  rowId: string,
  data: string,
): void {
  const source = nativeScope(harness, viewerId);
  const request: NativeViewerInputRequest = {
    expectedSource: source as NativeViewerAnyInputSource,
    expectedInputModes: modesOf(harness, rowId),
    data,
  };
  assert.deepEqual(harness.manager.writeViewerInput(viewerId, request), { status: "submitted" });
}

/** Emit one child OSC 52 and wait for the surface to have parsed it. */
async function childCopy(harness: Harness, rowId: string, text: string): Promise<void> {
  const pty = harness.spawned.at(-1);
  assert.ok(pty, "the row owns its PTY");
  pty.emitData(osc52("c", b64(text)));
  await harness.manager.surface(rowId)?.flush();
}

function receiptsOf(harness: Harness, index: number): Array<NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt> {
  return harness.sinks[index] ?? [];
}

const copiedText = (receipt: NativeViewerClipboardReceipt | NativeViewerNativeCliClipboardReceipt): string => {
  if (!isNativeViewerNativeCliClipboardReceipt(receipt)) {
    return Buffer.from(receipt.event.kind === "copy" ? receipt.event.encoded : "", "base64").toString("utf8");
  }
  return Buffer.from(receipt.event.encoded, "base64").toString("utf8");
};

test("a hosted child's OSC 52 copy reaches only the viewer whose input this manager last accepted", async () => {
  const harness = makeHarness("viewer-route");
  try {
    const rowId = await createRow(harness);
    const viewerA = openSurface(harness);
    const viewerB = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerA, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.updateViewer(viewerB, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const sourceA = nativeScope(harness, viewerA);

    // No accepted input yet: no known origin, so nothing is forwarded anywhere.
    await childCopy(harness, rowId, "nobody typed yet");
    assert.deepEqual(receiptsOf(harness, 0), []);
    assert.deepEqual(receiptsOf(harness, 1), []);
    assert.equal(harness.localRoute.length, 0, "an unknown origin never falls back to the owner");

    viewerInput(harness, viewerA, rowId, "a");
    await childCopy(harness, rowId, "copied after A typed");
    assert.deepEqual(receiptsOf(harness, 0).map((receipt) => copiedText(receipt)), ["copied after A typed"]);
    assert.deepEqual(receiptsOf(harness, 1), [], "a sibling viewer on the same row gets nothing");
    assert.equal(harness.localRoute.length, 0, "a viewer-routed copy never takes the owner-local route");
    assert.equal(harness.piRoute.length, 0, "a provider copy never reaches the Pi owner route");

    const receipt = receiptsOf(harness, 0)[0] as NativeViewerNativeCliClipboardReceipt;
    assert.equal(isNativeViewerNativeCliClipboardReceipt(receipt), true);
    assert.deepEqual(Object.keys(receipt).sort(), ["dispatchId", "event", "source"]);
    assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.event) && Object.isFrozen(receipt.source));
    // The event family is honest: a backend, no conversation tuple, no fabricated ids.
    assert.deepEqual(Object.keys(receipt.event).sort(), ["backend", "encoded", "kind"]);
    assert.equal(receipt.event.kind, "copy");
    assert.equal(receipt.event.backend, "claude");
    assert.equal(receipt.event.encoded, b64("copied after A typed"));
    // The source restates the exact native CLI scope, and nothing else.
    assert.equal(isNativeViewerNativeCliInputSource(receipt.source), true);
    assert.deepEqual(receipt.source, sourceA, "the receipt names the surface whose input set the route");
    assert.deepEqual(Object.keys(receipt.source).sort(), [
      "backend", "geometry", "hostRunId", "phase", "rowId", "sourceToken", "viewerId", "viewerRevision",
    ]);
    assert.equal(receipt.dispatchId, 1, "the owner ordinal of the accepted input this copy is routed to");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the most recent accepted input selects the recipient; the recipient is frozen at acceptance", async () => {
  const harness = makeHarness("freeze");
  try {
    const rowId = await createRow(harness);
    const viewerA = openSurface(harness);
    const viewerB = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewerA, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.updateViewer(viewerB, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    const sourceB = nativeScope(harness, viewerB);

    // B's input is the most recent accepted one, so B is the recipient.
    viewerInput(harness, viewerA, rowId, "a");
    viewerInput(harness, viewerB, rowId, "b");
    await childCopy(harness, rowId, "after both typed");
    assert.deepEqual(receiptsOf(harness, 0), [], "A is not the recipient once B's input was accepted");
    assert.deepEqual((receiptsOf(harness, 1) as NativeViewerNativeCliClipboardReceipt[])
      .map((receipt) => [copiedText(receipt), receipt.source.sourceToken]),
    [["after both typed", sourceB.sourceToken]]);

    // A copy accepted for A is not retargeted by input that lands mid-delivery.
    const harness2 = makeHarness("freeze-in-flight");
    try {
      const row2 = await createRow(harness2);
      let retarget: (() => void) | undefined;
      const viewerC = openSurface(harness2, () => { retarget?.(); });
      const viewerD = openSurface(harness2);
      assert.equal(harness2.manager.updateViewer(viewerC, { sessionId: row2, cols: 80, rows: 24 }).applied, true);
      assert.equal(harness2.manager.updateViewer(viewerD, { sessionId: row2, cols: 80, rows: 24 }).applied, true);
      viewerInput(harness2, viewerC, row2, "c");
      const sourceC = nativeScope(harness2, viewerC);
      // While C's copy is being delivered, D's input is accepted.
      retarget = () => { viewerInput(harness2, viewerD, row2, "d"); };
      const pty2 = harness2.spawned.at(-1)!;
      pty2.emitData(osc52("c", b64("accepted for C")));
      await harness2.manager.surface(row2)?.flush();
      const frozen = receiptsOf(harness2, 0) as NativeViewerNativeCliClipboardReceipt[];
      assert.deepEqual(frozen.map((receipt) => [copiedText(receipt), receipt.source.sourceToken]),
        [["accepted for C", sourceC.sourceToken]], "the in-flight copy stays addressed to the frozen recipient");
      assert.deepEqual(receiptsOf(harness2, 1), [], "the newer controller does not receive the older copy");
      // And the newer input does own the NEXT copy.
      const sourceD = nativeScope(harness2, viewerD);
      pty2.emitData(osc52("c", b64("accepted for D")));
      await harness2.manager.surface(row2)?.flush();
      assert.deepEqual((receiptsOf(harness2, 1) as NativeViewerNativeCliClipboardReceipt[])
        .map((receipt) => [copiedText(receipt), receipt.source.sourceToken]),
      [["accepted for D", sourceD.sourceToken]]);
    } finally {
      await harness2.manager.dispose();
      rmSync(harness2.root, { recursive: true, force: true });
    }
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("owner-local input replaces a remote controller; a protocol reply never steals it", async () => {
  const harness = makeHarness("local-route");
  try {
    const rowId = await createRow(harness);
    const viewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewer, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);

    viewerInput(harness, viewer, rowId, "a");
    // The child asks a terminal query; the host's protocol reply goes to the child,
    // but it is not user input and must not become the copy recipient.
    const pty = harness.spawned.at(-1)!;
    pty.emitData(`${ESC}[6n`);
    await harness.manager.surface(rowId)?.flush();
    assert.match(pty.writes.map((entry) => String(entry)).join(""), /\x1b\[\d+;\d+R/,
      "the host actually replied to the child's terminal query");

    await childCopy(harness, rowId, "still the viewer's copy");
    assert.deepEqual(receiptsOf(harness, 0).map((receipt) => copiedText(receipt)), ["still the viewer's copy"],
      "a terminal protocol reply never steals the controller");
    assert.equal(harness.localRoute.length, 0);

    // Owner-local accepted input replaces the remote controller.
    harness.manager.write(rowId, "local keystroke");
    await childCopy(harness, rowId, "now the owner's copy");
    const localText = (event: NativeCliClipboardEvent): string => Buffer.from(event.encoded, "base64").toString("utf8");
    assert.deepEqual(harness.localRoute.map((entry) => [entry.instanceId, localText(entry.event)]),
      [[rowId, "now the owner's copy"]]);
    assert.equal(receiptsOf(harness, 0).length, 1, "the viewer gets nothing once the owner is the controller");
    assert.equal(harness.piRoute.length, 0, "the Pi owner clipboard route is never used by a provider copy");
    const event = harness.localRoute[0]!.event;
    assert.deepEqual(Object.keys(event).sort(), ["backend", "encoded", "kind"]);
    assert.equal(event.backend, "claude");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("stale sources, refused payloads, and a dead child deliver nothing and never fall back", async () => {
  const harness = makeHarness("negatives");
  try {
    const rowId = await createRow(harness);
    const otherRow = await createRow(harness, "codex");
    const viewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewer, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    viewerInput(harness, viewer, rowId, "a");

    // Malformed, query, and over-bound payloads capture nothing at the surface.
    const pty = harness.spawned.find((entry) => entry.spawnDescriptor.file.endsWith("claude"))!;
    pty.emitData(osc52("c", "?"));
    pty.emitData(osc52("z", b64("unknown clipboard code")));
    pty.emitData(osc52("c", "A".repeat(NATIVE_COPY_MAX_ENCODED_CHARS + 8)));
    await harness.manager.surface(rowId)?.flush();
    assert.deepEqual(receiptsOf(harness, 0), [], "no refused payload produced a delivery");

    // The viewer moved to another row: its old scope no longer describes this child.
    assert.equal(harness.manager.updateViewer(viewer, { sessionId: otherRow }).applied, true);
    await childCopy(harness, rowId, "after the viewer moved away");
    assert.deepEqual(receiptsOf(harness, 0), [], "a moved surface is not a current source of this row");
    assert.equal(harness.localRoute.length, 0, "and nothing falls back to the owner");

    // The viewer is closed: still nothing.
    assert.equal(harness.manager.closeViewer(viewer), true);
    await childCopy(harness, rowId, "after the viewer closed");
    assert.deepEqual(receiptsOf(harness, 0), []);
    assert.equal(harness.localRoute.length, 0);

    // The child exits: the capture seam and the route both go with the incarnation.
    const seam = harness.manager.nativeCliCopyCapture(rowId);
    assert.ok(seam !== undefined, "a live hosted run offers its own capture seam");
    pty.emitExit(0, 15);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.manager.nativeCliCopyCapture(rowId), undefined, "an exited row offers no seam");
    assert.equal(seam.submit(b64("after the exit")), false, "a seam of a dead incarnation submits nothing");
    await childCopy(harness, rowId, "after the exit");
    assert.equal(harness.localRoute.length, 0);
    assert.deepEqual(receiptsOf(harness, 0), []);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("the capture seam is bound to one run, and a Pi row keeps raw OSC 52 denied with no seam", async () => {
  const harness = makeHarness("seam-and-pi");
  try {
    const rowId = await createRow(harness);
    const viewer = openSurface(harness);
    assert.equal(harness.manager.updateViewer(viewer, { sessionId: rowId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.nativeCliCopyCapture("no-such-row"), undefined);

    // The seam is bound to the exact run: it cannot address another row, and it
    // re-proves its own payload shape rather than trusting the caller.
    const seam = harness.manager.nativeCliCopyCapture(rowId);
    assert.ok(seam !== undefined);
    assert.deepEqual({ rowId: seam.rowId, backend: seam.backend }, { rowId, backend: "claude" });
    assert.equal(seam.submit("not base64!"), false, "a malformed payload never enters the route");
    assert.equal(seam.submit(b64("no input accepted yet")), false, "no known origin is never a fallback");

    viewerInput(harness, viewer, rowId, "a");
    assert.equal(seam.submit(b64("fed by the provider adapter")), true);
    assert.deepEqual(receiptsOf(harness, 0).map((receipt) => copiedText(receipt)), ["fed by the provider adapter"]);

    // A Pi row beside it keeps its exact behavior: no provider seam, and its raw
    // OSC 52 stays swallowed by the surface.
    const piId = await harness.manager.create({ workspace: harness.workspace });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.manager.nativeCliCopyCapture(piId), undefined, "a Pi row has no provider capture seam");
    const piPty = harness.spawned.at(-1)!;
    piPty.emitData(osc52("c", b64("pi raw copy attempt")));
    await harness.manager.surface(piId)?.flush();
    assert.equal(harness.piRoute.length, 0, "raw OSC 52 on a Pi row never reaches the Pi clipboard route");
    assert.equal(harness.localRoute.length, 0, "and never reaches the provider owner route either");
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});
