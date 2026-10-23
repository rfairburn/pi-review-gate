/**
 * Focused tests for the stdin-origin framing mode of the child-side native
 * clipboard bridge, including its one-shot signed readiness statement. The mode
 * is requested explicitly at install; normal production Main requests it by
 * default for the children it creates.
 *
 * Evidence scope (MOCK, source-only): every bridge case runs in an isolated Node
 * child process whose "native CLI" is a throwaway fake package
 * (tests/fixtures/session-host-native-clipboard-origin-bridge.cjs) that only
 * reproduces the named call frames the bridge's unchanged provenance gate
 * observes. These cases prove the owned bridge's strict input framing, its
 * per-dispatch AsyncLocalStorage tuple/origin capture, the readiness statement,
 * the v2 capsule wire shape, and that the default one-argument install stays the
 * legacy bridge. The one `nativeParser` case additionally feeds the bridge's own
 * emitted chunks into the ACTUAL pinned public `StdinBuffer` from
 * `pi-session-host-tui` (`@earendil-works/pi-tui@1.3.0`), so it does observe real
 * native parser state — but it is not the full native Pi UI, a real native
 * PTY/Windows/SSH child, the broker or viewer plumbing, or any physical clipboard.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  NATIVE_CLIPBOARD_OSC,
  createNativeClipboardReceiver,
  type NativeClipboardEvent,
  type NativeClipboardOriginEvent,
} from "../src/session-host/native-clipboard";
import { createNativeInputDecoder, createNativeInputEncoder, frameNativeInputBody, NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES, type NativeInputOrigin } from "../src/session-host/native-input-origin";
import type { SessionHostBootstrap } from "../src/session-host/protocol";

const bootstrap: SessionHostBootstrap = {
  version: 1, instanceId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222", token: "ab".repeat(32), socketPath: "/synthetic/broker.sock",
};
const fixtureEntry = join(process.cwd(), "tests", "fixtures", "session-host-native-clipboard-origin-bridge.cjs");
const bridgeModule = join(__dirname, "..", "src", "session-host", "native-clipboard.js");
const OSC_PREFIX = `\x1b]${NATIVE_CLIPBOARD_OSC};`;
const READY_TEXT_PREFIX = `${OSC_PREFIX}prg-native-input-ready-v1;`;
const COPY_TEXT_PREFIXES = [`${OSC_PREFIX}prg-native-copy-v1;`, `${OSC_PREFIX}prg-native-copy-v2;`];

interface PayloadRecord {
  readonly kind: "buffer" | "string";
  readonly hex?: string;
  readonly text?: string;
  readonly marker: boolean;
  readonly argCount: number;
  readonly thisIsStdin: boolean;
}
interface WriteRecord {
  readonly text: string;
  readonly callbackProvided: boolean;
  readonly receiverIsStdout: boolean;
}
interface Report {
  readonly installed: boolean | null;
  readonly reinstall: boolean | null;
  readonly payloads: readonly PayloadRecord[];
  readonly writes: readonly WriteRecord[];
  readonly copies: readonly {
    readonly text: string;
    readonly deferred: boolean;
    readonly callback: boolean;
    readonly value: boolean;
  }[];
  readonly feeds: readonly boolean[];
  readonly callbackCompletions: readonly string[];
  readonly plainReturns: readonly boolean[];
  /** `data` sequences emitted by the ACTUAL pinned public StdinBuffer consumer. */
  readonly parserData: readonly string[];
  /** `paste` bodies emitted by that same real parser. */
  readonly parserPaste: readonly string[];
  readonly errors: readonly string[];
}

/** Run one scenario in a fresh child process; the fake native package is disposable. */
function runScenario(scenario: Record<string, unknown>): Report {
  const root = mkdtempSync(join(process.cwd(), ".prg-native-origin-bridge-"));
  const scenarioPath = join(root, "scenario.json");
  const reportPath = join(root, "report.json");
  writeFileSync(scenarioPath, JSON.stringify({ bootstrap, ...scenario }), { mode: 0o600 });
  try {
    const child = spawnSync(process.execPath, [fixtureEntry, scenarioPath, reportPath], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PRG_TEST_BRIDGE_MODULE: bridgeModule },
    });
    assert.equal(child.status, 0, `isolated bridge child failed: ${child.stderr}\n${child.stdout}`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    assert.deepEqual(report.errors, []);
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bytesOf(record: PayloadRecord): Buffer {
  assert.equal(record.kind, "buffer", "a buffer-mode stdin must deliver bytes, never text");
  return Buffer.from(record.hex ?? "", "hex");
}

function textOfWrite(write: WriteRecord): string {
  return Buffer.from(write.text, "latin1").toString("utf8");
}

/** Extract one private capsule from a single OSC 777 write. */
function capsuleFromText(text: string): string {
  assert.ok(text.startsWith(OSC_PREFIX), "only the private OSC 777 channel carries capsules");
  assert.ok(text.endsWith("\x07"), "the capsule is framed as one OSC payload");
  return text.slice(OSC_PREFIX.length, -1);
}

/** Readiness writes, in emission order (the default legacy bridge emits none). */
function readyWrites(report: Report): string[] {
  return report.writes.map(textOfWrite).filter((text) => text.startsWith(READY_TEXT_PREFIX));
}
function isCopyText(text: string): boolean {
  return COPY_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}
/** Copy capsules in emission order, without their OSC framing. */
function copyCapsules(report: Report): string[] {
  return report.writes.map(textOfWrite).filter((text) => isCopyText(text)).map((text) => capsuleFromText(text));
}
/** Ordinary output (and untouched native writes) that is neither readiness nor a capsule. */
function otherTexts(report: Report): string[] {
  return report.writes.map(textOfWrite)
    .filter((text) => !isCopyText(text) && !text.startsWith(READY_TEXT_PREFIX));
}

/** Split one encoded dispatch into its exact per-part frames (hex, one chunk per frame). */
function frameChunks(framed: string): string[] {
  return framed.split("\n").filter((frame) => frame.length > 0)
    .map((frame) => Buffer.from(`${frame}\n`, "ascii").toString("hex"));
}

const local: NativeInputOrigin = { kind: "local" };
const viewer = (token: string): NativeInputOrigin => ({ kind: "viewer", token });
const none: NativeInputOrigin = { kind: "none" };
/** The child's current conversation, exactly as the Reporter states it. */
const conversation = (sessionId: string, epoch: number): Record<string, unknown> => ({ sessionId, sessionEpoch: epoch });
/** The native conversation one viewer dispatch is admitted against. */
const fence = (sessionId: string, epoch: number) => ({ sessionId, epoch });
const copyText = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const copiedText = (event: NativeClipboardEvent): string => Buffer.from(
  event.kind === "copy" ? event.encoded : "", "base64",
).toString("utf8");

/** Verify every copy capsule in emission order; the v1-only callback must stay silent. */
function receiveOrigin(report: Report): NativeClipboardOriginEvent[] {
  const receipts: NativeClipboardOriginEvent[] = [];
  let v1Calls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { v1Calls += 1; },
    (receipt) => receipts.push(receipt));
  for (const capsule of copyCapsules(report)) receive(capsule);
  assert.equal(v1Calls, 0, "the v1-only callback must never receive a v2 origin capsule");
  return receipts;
}

/** Feed only the readiness statement; exactly one must verify and none may become a copy. */
function receiveReadiness(report: Report): number {
  let readyCalls = 0;
  let copyCalls = 0;
  let originCalls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { copyCalls += 1; },
    () => { originCalls += 1; }, () => { readyCalls += 1; });
  for (const text of readyWrites(report)) receive(capsuleFromText(text));
  assert.deepEqual([copyCalls, originCalls], [0, 0], "readiness is never delivered as a copy event");
  return readyCalls;
}

test("installed startup phase is unarmed initially and session updates close it permanently", () => {
  for (const closingTuple of [undefined, conversation("native-startup-next", 1)]) {
    const encoder = createNativeInputEncoder(bootstrap);
    const origin = viewer("startup-viewer");
    const startup = { phase: "startup" as const };
    const unarmed = frameChunks(encoder.encode(Buffer.from("unarmed"), origin, startup));
    const payload = Buffer.alloc(70_000, 0x61);
    const whole = frameChunks(encoder.encode(payload, origin, startup));
    const partial = frameChunks(encoder.encode(payload, origin, startup));
    const closed = frameChunks(encoder.encode(Buffer.from("closed"), origin, startup));
    const next = frameChunks(encoder.encode(Buffer.from("next"), origin, fence("native-startup-next", 1)));
    const localInput = frameChunks(encoder.encode(Buffer.from("local"), local));
    const protocolInput = frameChunks(encoder.encode(Buffer.from("none"), none));
    assert.ok(partial.length > 1, "the partial startup dispatch spans more than one frame");
    const report = runScenario({
      options: { inputOriginFraming: true },
      steps: [
        // Before the reporter arms it, a startup-fenced dispatch is refused whole.
        { op: "feed", hex: unarmed[0]! },
        { op: "armStartup" },
        ...whole.map((hex) => ({ op: "feed", hex })),
        // A session update of ANY value (undefined or a tuple) mid-assembly closes
        // the phase for good: the pending bytes are dropped and re-arming is refused.
        { op: "feed", hex: partial[0]! },
        { op: "session", tuple: closingTuple },
        { op: "armStartup" },
        ...partial.slice(1).map((hex) => ({ op: "feed", hex })),
        { op: "feed", hex: closed[0]! },
        { op: "session", tuple: conversation("native-startup-next", 1) },
        { op: "feed", hex: next[0]! },
        { op: "feed", hex: localInput[0]! },
        { op: "feed", hex: protocolInput[0]! },
      ],
    });
    assert.equal(report.installed, true);
    assert.deepEqual(report.payloads.map(bytesOf), [payload, Buffer.from("next"), Buffer.from("local"), Buffer.from("none")],
      "only the complete armed dispatch and subsequent valid inputs reach native listeners");
    assert.deepEqual(copyCapsules(report), []);
    assert.deepEqual(otherTexts(report), []);
  }
});

test("startup copies remain suppressed after asynchronous work crosses into a conversation", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const startup = { phase: "startup" as const };
  const sync = frameChunks(encoder.encode(Buffer.from("sync"), viewer("startup-viewer"), startup));
  const deferred = frameChunks(encoder.encode(Buffer.from("deferred"), viewer("startup-viewer"), startup));
  const next = frameChunks(encoder.encode(Buffer.from("next"), viewer("conversation-viewer"), fence("native-startup-next", 1)));
  const report = runScenario({
    options: { inputOriginFraming: true },
    writerReturns: false,
    steps: [
      { op: "armStartup" },
      { op: "armCopy", text: "startup-sync", callback: true },
      { op: "feed", hex: sync[0]! },
      { op: "armCopy", text: "startup-deferred", callback: true, defer: true },
      { op: "feed", hex: deferred[0]! },
      { op: "session", tuple: conversation("native-startup-next", 1) },
      { op: "armCopy", text: "conversation-copy" },
      { op: "feed", hex: next[0]! },
      { op: "wait", ms: 30 },
    ],
  });
  assert.equal(report.payloads.length, 3);
  assert.deepEqual(report.callbackCompletions, ["startup-sync", "startup-deferred"]);
  assert.ok(report.copies.every((copy) => copy.value === false), "writer return values are preserved");
  assert.deepEqual(otherTexts(report), ["", ""], "startup copies produce neither capsules nor raw OSC 52");
  const receipts = receiveOrigin(report);
  assert.equal(receipts.length, 1, "only conversation input produces a copy receipt");
  assert.equal(copiedText(receipts[0]!.event), "conversation-copy");
  assert.deepEqual(receipts[0]!.origin, viewer("conversation-viewer"));
  assert.equal(receipts[0]!.event.sessionId, "native-startup-next");
  assert.equal(receipts[0]!.event.sessionEpoch, 1);
});

test("default bridge stays legacy: raw keystrokes/strings pass through, no readiness, v1 copies", () => {
  const raw = Buffer.from("abc\x00\x1b[1;2A", "latin1");
  const report = runScenario({
    options: "omitted",
    steps: [
      { op: "session", tuple: { sessionId: "native-session-legacy", sessionEpoch: 2 } },
      { op: "feed", hex: raw.toString("hex"), marker: true },
      { op: "feedText", text: "unframed string chunk" },
      { op: "armCopy", text: "legacy copy", defer: false },
      { op: "feed", hex: Buffer.from("x").toString("hex") },
      { op: "write", text: "ordinary output" },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(report.reinstall, false, "a reload shares the one process-owned bridge");
  assert.deepEqual(report.feeds, [true, true, true]);
  assert.deepEqual(readyWrites(report), [], "the default legacy install emits no readiness marker");

  assert.equal(report.payloads.length, 3, "legacy mode delivers every chunk unchanged");
  assert.deepEqual(bytesOf(report.payloads[0]!), raw);
  assert.equal(report.payloads[0]!.marker, true, "the exact caller buffer is re-emitted, not a copy");
  assert.equal(report.payloads[0]!.thisIsStdin, true);
  assert.equal(report.payloads[0]!.argCount, 0);
  assert.equal(report.payloads[1]!.kind, "string");
  assert.equal(report.payloads[1]!.text, "unframed string chunk");
  assert.deepEqual(bytesOf(report.payloads[2]!), Buffer.from("x"));

  assert.deepEqual(otherTexts(report), ["ordinary output"]);
  assert.equal(copyCapsules(report).length, 1);
  const capsule = copyCapsules(report)[0]!;
  assert.ok(capsule.startsWith("prg-native-copy-v1;"), "the default bridge remains v1-only");
  const seen: NativeClipboardEvent[] = [];
  createNativeClipboardReceiver(bootstrap, (event) => seen.push(event))(capsule);
  assert.deepEqual(seen, [{
    kind: "copy", encoded: copyText("legacy copy"), sessionId: "native-session-legacy", sessionEpoch: 2,
  }]);
  assert.deepEqual(Object.keys(seen[0]!).sort(), ["encoded", "kind", "sessionEpoch", "sessionId"],
    "the v1 callback event shape is unchanged: no origin or dispatch fields");
  assert.equal(report.writes.some((write) => write.text.includes("prg-native-copy-v2")), false);
});

test("strict install states signed readiness exactly once, before any query or copy", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: { sessionId: "native-session-ready", sessionEpoch: 6 } },
      // The very next step after install must already decode: the decoder was
      // installed before the readiness statement was written.
      { op: "armCopy", text: "ready copy", defer: false },
      { op: "feed", hex: frameChunks(encoder.encode(Buffer.from("ready keys"), local))[0]! },
      { op: "write", text: "after readiness" },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(report.reinstall, false);

  const readiness = readyWrites(report);
  assert.equal(readiness.length, 1, "exactly one readiness statement per process");
  assert.ok(textOfWrite(report.writes[0]!).startsWith(READY_TEXT_PREFIX),
    "readiness is the first write, before native startup queries and copies");
  assert.ok(readiness[0]!.length <= 1024, "readiness stays inside its own bound");
  assert.equal(readiness[0]!.includes(bootstrap.token), false, "readiness never carries the token");
  const [, readyBody] = capsuleFromText(readiness[0]!).split(";");
  const readyParsed = JSON.parse(Buffer.from(readyBody, "base64").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(readyParsed, {
    version: 1, kind: "input-framing-ready",
    instanceId: bootstrap.instanceId, generation: bootstrap.generation,
  }, "readiness carries only the fixed kind, mode version and current registration");
  assert.equal(Object.hasOwn(readyParsed, "token"), false);
  assert.equal(receiveReadiness(report), 1);

  assert.deepEqual(report.payloads.map(bytesOf), [Buffer.from("ready keys")]);
  assert.deepEqual(otherTexts(report), ["after readiness"]);
  const copies = receiveOrigin(report);
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0]!.origin, { kind: "local" });
  const copyBody = copyCapsules(report)[0]!.split(";")[1];
  const copyParsed = JSON.parse(Buffer.from(copyBody, "base64").toString("utf8")) as { sequence: number; version: number };
  assert.equal(copyParsed.version, 2);
  assert.equal(copyParsed.sequence, 1, "readiness is separate: the first real copy is still sequence 1");
});

test("strict framing captures the dispatch tuple/origin once across an epoch update and A/B interleaving", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const alphaPayload = Buffer.from("A".repeat(70_000), "utf8");
  const betaPayload = Buffer.from("beta payload", "utf8");
  const deltaPayload = Buffer.from("delta payload", "utf8");
  const epsilonPayload = Buffer.from("epsilon payload", "utf8");
  const alpha = frameChunks(encoder.encode(alphaPayload, viewer("opaque-viewer-1"), fence("native-session-a", 3)));
  const beta = frameChunks(encoder.encode(betaPayload, local));
  const delta = frameChunks(encoder.encode(deltaPayload, viewer("opaque-viewer-2"), fence("native-session-a", 5)));
  const epsilon = frameChunks(encoder.encode(epsilonPayload, local));
  assert.equal(alpha.length, 3, "the alpha dispatch spans three technical fragments");

  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-a", 3) },
      // A is a viewer dispatch: its prefix is assembled, never emitted, so a
      // session change before its tail refuses the WHOLE dispatch.
      { op: "feed", hex: alpha[0]! },
      { op: "feed", hex: alpha[1]! },
      // The Reporter publishes a newer epoch in the middle of A's dispatch — what
      // an in-child /new or /resume performed by an earlier listener looks like.
      { op: "session", tuple: conversation("native-session-a", 4) },
      { op: "feed", hex: alpha[2]! },
      // B is a local dispatch on the newer tuple, delivered before D's deferred copy.
      { op: "armCopy", text: "copy-beta", defer: false },
      { op: "feed", hex: beta[0]! },
      // D and E share one tuple: origins must not leak between dispatches.
      { op: "session", tuple: conversation("native-session-a", 5) },
      { op: "armCopy", text: "copy-delta", defer: true, delay: 0 },
      { op: "feed", hex: delta[0]! },
      { op: "armCopy", text: "copy-epsilon", defer: false },
      { op: "feed", hex: epsilon[0]! },
      { op: "wait", ms: 30 },
      { op: "session", tuple: null },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(report.reinstall, false);
  assert.equal(readyWrites(report).length, 1);
  assert.deepEqual(otherTexts(report), []);
  assert.deepEqual(report.feeds, [true, true, true, true, true, true],
    "every authenticated chunk is consumed, including a stale viewer dispatch");

  // Alpha's own fence named epoch 3, so once the child moved to epoch 4 none of
  // alpha belonged to a conversation: not one native listener saw a byte of it.
  // The local beta dispatch and the current-tuple delta dispatch keep their exact
  // delivery, and a stale viewer dispatch poisons nothing.
  assert.equal(report.payloads.length, 3, "only the local and current-tuple dispatches are delivered");
  assert.equal(Buffer.concat(report.payloads.map(bytesOf)).equals(Buffer.concat([
    betaPayload, deltaPayload, epsilonPayload,
  ])), true,
  "no framing byte reaches native listeners, no admitted payload byte is lost, and no stale byte is added");
  assert.equal(Buffer.concat(report.payloads.map(bytesOf)).includes(Buffer.from("A")), false,
    "no fragment of the refused viewer dispatch ever became a native prefix");
  assert.deepEqual(bytesOf(report.payloads[0]!), betaPayload,
    "the next dispatch is delivered normally: a stale viewer dispatch poisons nothing");
  assert.ok(report.payloads.every((payload) => payload.kind === "buffer"));
  assert.ok(report.payloads.every((payload) => payload.thisIsStdin && payload.argCount === 0));
  assert.ok(copyCapsules(report).every((capsule) => capsule.startsWith("prg-native-copy-v2;")),
    "strict mode emits only v2 origin capsules");
  assert.equal(copyCapsules(report).some((capsule) => capsule.includes("prg-ni-v1")), false,
    "framing headers never reach stdout");

  const byText = new Map(receiveOrigin(report).map((receipt): [string, NativeClipboardOriginEvent] =>
    [copiedText(receipt.event), receipt]));
  assert.deepEqual([...byText.keys()].sort(), ["copy-beta", "copy-delta", "copy-epsilon"],
    "every proven copy arrives once, and a refused dispatch produces none");

  assert.deepEqual(byText.get("copy-beta")!.origin, { kind: "local" });
  assert.equal(byText.get("copy-beta")!.dispatchId, 2);
  assert.equal(byText.get("copy-beta")!.event.sessionEpoch, 4);

  // D's copy was deferred inside D's own listener, so it must still state D's
  // captured epoch and origin after E has already run on the same tuple.
  const deltaReceipt = byText.get("copy-delta")!;
  assert.deepEqual(deltaReceipt.event, {
    kind: "copy", encoded: copyText("copy-delta"), sessionId: "native-session-a", sessionEpoch: 5,
  });
  assert.deepEqual(deltaReceipt.origin, { kind: "viewer", token: "opaque-viewer-2" });
  assert.deepEqual(byText.get("copy-epsilon")!.origin, { kind: "local" });
  assert.equal(deltaReceipt.dispatchId, 3);
  assert.equal(byText.get("copy-epsilon")!.dispatchId, 4);
  assert.equal(byText.get("copy-epsilon")!.event.sessionEpoch, 5);

  for (const receipt of byText.values()) {
    assert.deepEqual(Object.keys(receipt).sort(), ["dispatchId", "event", "origin"]);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.event), true);
    assert.equal(Object.isFrozen(receipt.origin), true);
  }
});

test("strict framing preserves exact bytes across splits, coalescing, decoys, large payloads and UTF-8 string mode", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const decoy = Buffer.from(
    "paste\x1b[200~prg-ni-v1;prg-native-copy-v1;\x1b]52;c;QQ==\x07\x00\x03\x7f\r\n", "latin1",
  );
  const first = Buffer.from(encoder.encode(decoy, local), "ascii");
  const large = Buffer.from("L".repeat(70_000), "latin1");
  const largeFrames = frameChunks(encoder.encode(large, viewer("opaque-viewer-3"), fence("native-session-bytes", 1)));
  const coalesced = Buffer.from([...frameChunks(encoder.encode(Buffer.from("third"), local)),
    ...frameChunks(encoder.encode(Buffer.from("fourth"), local))].join(""), "hex");
  const unicodeText = `${"a".repeat(32_767)}\u00e9tail`;
  const unicode = frameChunks(encoder.encode(Buffer.from(unicodeText, "utf8"), local));
  assert.equal(unicode.length, 2, "the UTF-8 sequence is split across the technical fragment bound");

  const steps: Record<string, unknown>[] = [
    { op: "session", tuple: { sessionId: "native-session-bytes", sessionEpoch: 1 } },
  ];
  // The first frame arrives one byte at a time, then the rest of it coalesced.
  for (let offset = 0; offset < 17; offset += 1) {
    steps.push({ op: "feed", hex: first.subarray(offset, offset + 1).toString("hex") });
  }
  steps.push({ op: "feed", hex: first.subarray(17).toString("hex") });
  // A large payload arrives as coalesced 10 KiB chunks spanning frame boundaries.
  const largeBytes = Buffer.from(largeFrames.join(""), "hex");
  for (let offset = 0; offset < largeBytes.length; offset += 10_000) {
    steps.push({ op: "feed", hex: largeBytes.subarray(offset, offset + 10_000).toString("hex") });
  }
  // Two complete dispatches inside one chunk, then UTF-8 string-mode input.
  steps.push({ op: "feed", hex: coalesced.toString("hex") });
  steps.push({ op: "stringMode" });
  steps.push({ op: "feedText", text: Buffer.from(unicode[0]!, "hex").toString("ascii") });
  steps.push({ op: "feed", hex: unicode[1]! });

  const report = runScenario({ options: { inputOriginFraming: true }, steps });
  assert.equal(report.installed, true);
  assert.ok(report.feeds.every((value) => value === true));
  assert.equal(readyWrites(report).length, 1, "one readiness statement, no re-emission");
  assert.deepEqual(copyCapsules(report), []);
  assert.deepEqual(otherTexts(report), [], "no copy was armed and no framing byte reached stdout");

  const buffers = report.payloads.filter((payload) => payload.kind === "buffer").map(bytesOf);
  assert.equal(buffers.length, 4,
    "the viewer dispatch is one assembled emit, the local ones keep their per-fragment delivery");
  assert.deepEqual(buffers[0], decoy, "NUL, controls, paste markers and framing decoys survive exactly");
  assert.deepEqual(buffers[1], large,
    "a viewer dispatch spanning many fragments is emitted exactly once, whole");
  assert.equal(Buffer.concat(buffers.slice(2)).toString("utf8"), "thirdfourth",
    "coalesced frames stay ordered and unframed");
  assert.ok(buffers.slice(1).every((buffer) => !buffer.toString("latin1").includes("prg-ni-v1;")));
  assert.equal(buffers[0]!.toString("latin1").includes("prg-ni-v1;"), true,
    "payload text is never re-parsed as framing");

  // String mode: the per-dispatch decoder carries a split UTF-8 sequence.
  const strings = report.payloads.filter((payload) => payload.kind === "string").map((payload) => payload.text!);
  assert.equal(strings.length, 2);
  assert.equal(strings[0], "a".repeat(32_767));
  assert.equal(strings[1], "\u00e9tail");
  assert.equal(strings.join(""), unicodeText);
  assert.equal(strings.join("").includes("\ufffd"), false);
});

test("strict framing never turns non-user input or an unavailable tuple into a copy", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const hostQuery = frameChunks(encoder.encode(Buffer.from("\x1b]11;?\x07", "latin1"), none));
  const noTupleInput = frameChunks(encoder.encode(Buffer.from("no tuple keys"), local));
  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: { sessionId: "native-session-none", sessionEpoch: 9 } },
      // A host query reply induces a native copy: `none` has no user copy origin.
      { op: "armCopy", text: "none copy", defer: false },
      { op: "feed", hex: hostQuery[0]! },
      { op: "write", text: "ordinary output" },
      { op: "wait", ms: 20 },
      // Without a captured tuple no copy event can be created either.
      { op: "session", tuple: null },
      { op: "armCopy", text: "no-tuple copy", defer: false },
      { op: "feed", hex: noTupleInput[0]! },
      { op: "wait", ms: 20 },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(readyWrites(report).length, 1);
  assert.equal(report.payloads.length, 2, "both dispatches are delivered to native listeners");
  assert.deepEqual(bytesOf(report.payloads[0]!), Buffer.from("\x1b]11;?\x07", "latin1"));
  assert.deepEqual(bytesOf(report.payloads[1]!), Buffer.from("no tuple keys"));
  assert.equal(report.copies.length, 2);
  assert.deepEqual(copyCapsules(report), [],
    "neither `none` input nor an unavailable tuple may produce an origin capsule");

  const texts = otherTexts(report);
  assert.deepEqual(texts.length, 3);
  assert.equal(texts[0], "", "the `none` copy is suppressed as an empty completion write");
  assert.equal(texts[1], "ordinary output");
  assert.ok(texts[2]!.startsWith("\x1b]52;c;"),
    "without a captured tuple the native write is left exactly as it was before the bridge");
});

test("strict framing poisons on tampering and never falls back to raw or legacy input", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const tampered = encoder.encode(Buffer.from("tampered"), local);
  const macStart = tampered.lastIndexOf(";") + 1;
  const flipped = `${tampered.slice(0, macStart)}${tampered[macStart] === "0" ? "1" : "0"}${tampered.slice(macStart + 1)}`;
  const valid = frameChunks(encoder.encode(Buffer.from("valid"), local));
  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: { sessionId: "native-session-poison", sessionEpoch: 1 } },
      { op: "feed", hex: Buffer.from(flipped, "ascii").toString("hex") },
      { op: "feed", hex: valid[0]! },
      { op: "feed", hex: Buffer.from("\x1b[Araw", "latin1").toString("hex") },
      { op: "feedText", text: "raw string" },
      { op: "write", text: "after poison" },
      { op: "armCopy", text: "poisoned copy", defer: false },
      { op: "feed", hex: valid[0]! },
      { op: "wait", ms: 20 },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(readyWrites(report).length, 1, "readiness was written once at install, before the poisoning");
  assert.deepEqual(report.payloads, [], "a poisoned decoder re-enables nothing and delivers nothing");
  assert.equal(report.copies.length, 0, "no copy can run without a live dispatch");
  assert.deepEqual(report.feeds, [true, true, true, true, true], "every chunk is consumed, not thrown");
  assert.deepEqual(copyCapsules(report), []);
  assert.deepEqual(otherTexts(report), ["after poison"], "no raw input or header reaches stdout");
});

test("strict framing refuses malformed or unknown option shapes without installing a partial bridge", () => {
  const raw = Buffer.from("plain", "latin1");
  for (const options of [{ inputOriginFraming: true, extra: true }, { inputOriginFraming: "yes" }, { framing: true }]) {
    const report = runScenario({
      options,
      steps: [
        { op: "feed", hex: raw.toString("hex"), marker: true },
        { op: "write", text: "passthrough" },
      ],
    });
    assert.equal(report.installed, false, `${JSON.stringify(options)} must not install`);
    assert.equal(report.reinstall, false);
    assert.deepEqual(readyWrites(report), [], "a refused install never claims readiness");
    assert.deepEqual(copyCapsules(report), []);
    assert.equal(report.payloads.length, 1, "an uninstalled bridge leaves native stdin untouched");
    assert.deepEqual(bytesOf(report.payloads[0]!), raw);
    assert.deepEqual(otherTexts(report), ["passthrough"]);
  }
});

test("a failing chunk still delivers fragments authenticated before the failure, independent of chunking", () => {
  const tamper = (frameHex: string): string => {
    const bytes = Buffer.from(frameHex, "hex");
    const index = bytes.length - 2; // last MAC hex character, before the newline
    bytes[index] = bytes[index] === 0x30 ? 0x31 : 0x30;
    return bytes.toString("hex");
  };
  const before = Buffer.from("valid before failure", "utf8");
  const multiPayload = Buffer.from("C".repeat(70_000), "utf8");

  // One encoder per scenario, so each frame stream stays sequence-identical to a live child.
  const encoderA = createNativeInputEncoder(bootstrap);
  const beforeFrame = frameChunks(encoderA.encode(before, local))[0]!;
  const multi = frameChunks(encoderA.encode(multiPayload, local));
  const after = frameChunks(encoderA.encode(Buffer.from("after poison"), local))[0]!;
  assert.equal(multi.length, 3);

  const scenarios = {
    coalesced: [
      { op: "session", tuple: { sessionId: "native-session-partial", sessionEpoch: 2 } },
      { op: "feed", hex: `${beforeFrame}${tamper(multi[0]!)}` },
      { op: "feed", hex: after },
    ],
    separate: [
      { op: "session", tuple: { sessionId: "native-session-partial", sessionEpoch: 2 } },
      { op: "feed", hex: beforeFrame },
      { op: "feed", hex: tamper(multi[0]!) },
      { op: "feed", hex: after },
    ],
  };
  for (const [label, steps] of Object.entries(scenarios)) {
    const report = runScenario({ options: { inputOriginFraming: true }, steps });
    assert.equal(report.installed, true);
    assert.deepEqual(report.payloads.map(bytesOf), [before],
      `${label}: authenticated bytes before the failing frame are delivered exactly once`);
    assert.ok(report.feeds.every((value) => value === true));
  }

  // The same guarantee applies to a continuation of an already-open dispatch.
  const encoderB = createNativeInputEncoder(bootstrap);
  const open = frameChunks(encoderB.encode(multiPayload, local));
  const tail = frameChunks(encoderB.encode(Buffer.from("tail"), local))[0]!;
  const continuation = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: { sessionId: "native-session-partial", sessionEpoch: 3 } },
      { op: "feed", hex: open[0]! },
      { op: "feed", hex: `${open[1]!}${tamper(open[2]!)}` },
      { op: "feed", hex: tail },
    ],
  });
  const expected = multiPayload.subarray(0, 65_536);
  assert.equal(continuation.payloads.length, 2);
  assert.equal(Buffer.concat(continuation.payloads.map(bytesOf)).equals(expected), true,
    "the verified continuation fragment is delivered before the failing final fragment");
  assert.ok(continuation.feeds.every((value) => value === true));
});

test("suppressed copies and forwarded or encapsulated writes keep stdout callback, receiver and return semantics", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const hostQuery = frameChunks(encoder.encode(Buffer.from("\x1b]11;?\x07", "latin1"), none));
  const localInput = frameChunks(encoder.encode(Buffer.from("local keys"), local));
  const strict = runScenario({
    options: { inputOriginFraming: true },
    writerReturns: false,
    steps: [
      { op: "session", tuple: { sessionId: "native-session-callback", sessionEpoch: 4 } },
      { op: "armCopy", text: "none callback copy", callback: true },
      { op: "feed", hex: hostQuery[0]! },
      { op: "armCopy", text: "local callback copy", callback: true },
      { op: "feed", hex: localInput[0]! },
      { op: "writeCallback", text: "forwarded plain" },
    ],
  });
  assert.equal(strict.installed, true);
  assert.deepEqual(strict.callbackCompletions,
    ["none callback copy", "local callback copy", "forwarded plain"],
    "every callback-bearing write completes exactly once, including a suppressed non-user copy");
  assert.deepEqual(strict.plainReturns, [false], "a forwarded write returns the original writer's value");
  assert.deepEqual(strict.copies.map((copy) => copy.value), [false, false],
    "suppressed and encapsulated writes return the original writer's value");
  const suppressed = strict.writes.find((write) => write.text === "");
  assert.ok(suppressed, "the `none` copy is suppressed without emitting clipboard bytes");
  assert.equal(suppressed!.callbackProvided, true);
  assert.equal(strict.writes[0]!.callbackProvided, false, "readiness carries no callback");
  assert.equal(strict.writes.some((write) => write.text.startsWith("\x1b]52;c;")), false,
    "the suppressed copy never leaks the raw native OSC 52");
  assert.equal(copyCapsules(strict).length, 1, "only the user-origin copy becomes a capsule");
  assert.ok(copyCapsules(strict)[0]!.startsWith("prg-native-copy-v2;"));
  assert.ok(strict.writes.every((write) => write.receiverIsStdout), "the original receiver is preserved");

  const legacy = runScenario({
    options: "omitted",
    writerReturns: false,
    steps: [
      { op: "session", tuple: { sessionId: "native-session-legacy-cb", sessionEpoch: 5 } },
      { op: "armCopy", text: "legacy callback copy", callback: true },
      { op: "feed", hex: Buffer.from("go", "latin1").toString("hex") },
      { op: "writeCallback", text: "legacy plain" },
    ],
  });
  assert.equal(legacy.installed, true);
  assert.deepEqual(legacy.callbackCompletions, ["legacy callback copy", "legacy plain"]);
  assert.deepEqual(legacy.plainReturns, [false]);
  assert.deepEqual(legacy.copies.map((copy) => copy.value), [false]);
  assert.equal(legacy.writes[0]!.callbackProvided, true, "the legacy capsule write keeps its callback");
  assert.ok(copyCapsules(legacy)[0]!.startsWith("prg-native-copy-v1;"));
  assert.ok(legacy.writes.every((write) => write.receiverIsStdout));
});

test("a stale viewer fence is consumed before any listener and never poisons the next dispatch", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const staleWhole = frameChunks(encoder.encode(
    Buffer.from("stale whole dispatch", "utf8"), viewer("opaque-viewer-stale"), fence("native-session-fence", 7),
  ));
  const midPayload = Buffer.from("M".repeat(70_000), "utf8");
  const mid = frameChunks(encoder.encode(midPayload, viewer("opaque-viewer-mid"), fence("native-session-fence", 8)));
  const localSpanning = frameChunks(encoder.encode(Buffer.from("local spans on", "utf8"), local));
  const currentWhole = frameChunks(encoder.encode(
    Buffer.from("current keys", "utf8"), viewer("opaque-viewer-current"), fence("native-session-fence", 9),
  ));
  assert.equal(mid.length, 3, "the mid dispatch spans the fragment boundary");

  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      // 1. The child already moved on: a whole viewer dispatch admitted against an
      //    older conversation is refused before its first byte reaches a listener.
      { op: "session", tuple: conversation("native-session-fence", 8) },
      { op: "feed", hex: staleWhole[0]! },
      // 2. A viewer dispatch for the CURRENT conversation starts normally, then the
      //    conversation changes before its tail arrives: the rest is consumed.
      { op: "feed", hex: mid[0]! },
      { op: "session", tuple: conversation("native-session-fence", 9) },
      { op: "feed", hex: mid[1]! },
      { op: "feed", hex: mid[2]! },
      // 3. A local dispatch on the newer conversation keeps its unchanged
      //    whole-dispatch delivery: the fence is a viewer-only rule.
      { op: "feed", hex: localSpanning[0]! },
      // 4. The next viewer dispatch matching the current conversation is delivered.
      { op: "feed", hex: currentWhole[0]! },
      { op: "session", tuple: null },
    ],
  });
  assert.equal(report.installed, true);
  assert.equal(readyWrites(report).length, 1, "readiness stays a one-time statement");
  assert.deepEqual(report.feeds, [true, true, true, true, true, true],
    "refused bytes are consumed, never thrown back to the caller");
  assert.deepEqual(otherTexts(report), [], "no framing byte and no refused payload byte reaches stdout");
  assert.deepEqual(copyCapsules(report), [], "a refused dispatch never produces a copy capsule");
  assert.equal(report.copies.length, 0, "no native listener ran for a refused dispatch");

  assert.equal(report.payloads.length, 2, "only whole current-tuple dispatches are delivered");
  assert.deepEqual(bytesOf(report.payloads[0]!), Buffer.from("local spans on", "utf8"),
    "local input semantics are unchanged by a stale viewer dispatch");
  assert.deepEqual(bytesOf(report.payloads[1]!), Buffer.from("current keys", "utf8"),
    "a valid viewer dispatch after a stale one is delivered normally, exactly once");
  const delivered = Buffer.concat(report.payloads.map(bytesOf)).toString("utf8");
  assert.equal(delivered.includes("stale whole dispatch"), false, "a whole stale dispatch delivers nothing");
  assert.equal(delivered.includes("M"), false,
    "the mid dispatch delivered ZERO native bytes: not even its admitted first fragment was a prefix");
});

/** Flip the last MAC nibble of one frame so its own bytes stay well-formed but unauthenticated. */
function flipFrameMac(frameHex: string): string {
  const bytes = Buffer.from(frameHex, "hex");
  const index = bytes.length - 2; // last MAC hex character, before the newline
  bytes[index] = bytes[index] === 0x30 ? 0x31 : 0x30;
  return bytes.toString("hex");
}

/**
 * Hand-build one viewer dispatch's frames, so an empty or tiny part can be
 * exercised without an encoder shortcut. The body follows the codec's exact
 * canonical key order; only the payload parts differ from an encoder output.
 */
function handBuiltViewerFrames(
  dispatchId: number, firstSequence: number, payloads: readonly Buffer[],
  token: string, expected: { sessionId: string; epoch: number },
): string[] {
  return payloads.map((payload, part) => frameNativeInputBody(bootstrap, Buffer.from(JSON.stringify({
    v: 1,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    sequence: firstSequence + part,
    dispatchId,
    part,
    final: part === payloads.length - 1,
    origin: { kind: "viewer", token },
    expectedNativeTuple: expected,
    encoded: payload.toString("base64url"),
  }), "utf8").toString("base64url")));
}

test("the ACTUAL pinned native StdinBuffer never sees a stale viewer paste prefix", () => {
  const pasteStart = "\x1b[200~";
  const pasteEnd = "\x1b[201~";
  const bPasteBody = "B-paste-body";

  /**
   * A's bracketed paste is larger than one technical fragment, so the old
   * per-fragment delivery handed native Pi an unterminated paste prefix. The
   * framing stream is split physically: no chunk boundary coincides with a frame,
   * a payload fragment, or a paste marker. Then one conversation event happens
   * with no stdin in between, then A's remainder and a corrupted or truncated
   * tail land, then the next conversation's keyboard input and its own paste.
   */
  const run = (variant: "changed" | "aba" | "corrupt" | "truncated"): Report => {
    const encoder = createNativeInputEncoder(bootstrap);
    const aPayload = Buffer.from(`${pasteStart}${"A".repeat(40_000)}${pasteEnd}`, "utf8");
    const aFrames = frameChunks(encoder.encode(aPayload, viewer("opaque-viewer-a"), fence("native-session-a", 1)));
    assert.equal(aFrames.length, 2, "the stale paste spans two technical fragments");
    const aStream = Buffer.from(aFrames.join(""), "hex");
    const aSplit = aFrames[0]!.length / 2 + 1_000; // part 0 complete, part 1 partly present
    assert.ok(aSplit < aStream.length, "the physical split leaves a real remainder of A");

    // "aba" returns to A's own tuple, so A's next dispatch is admitted on A.
    const nextFence = variant === "aba" ? fence("native-session-a", 1) : fence("native-session-b", 2);
    const keyboard = Buffer.from("ok\r", "utf8");
    const keyboardFrame = frameChunks(encoder.encode(
      keyboard, viewer("opaque-viewer-next"), nextFence,
    ))[0]!;
    const pasteFrame = frameChunks(encoder.encode(
      Buffer.from(`${pasteStart}${bPasteBody}${pasteEnd}`, "utf8"), viewer("opaque-viewer-next"), nextFence,
    ))[0]!;

    const feeds = (bytes: Buffer): Record<string, unknown>[] => {
      const steps: Record<string, unknown>[] = [];
      for (let offset = 0; offset < bytes.length; offset += 7_000) {
        steps.push({ op: "feed", hex: bytes.subarray(offset, Math.min(offset + 7_000, bytes.length)).toString("hex") });
      }
      return steps;
    };
    const steps: Record<string, unknown>[] = [
      { op: "session", tuple: conversation("native-session-a", 1) },
      ...feeds(aStream.subarray(0, aSplit)),
    ];
    if (variant === "changed") steps.push({ op: "session", tuple: conversation("native-session-b", 2) });
    if (variant === "aba") {
      steps.push({ op: "session", tuple: conversation("native-session-b", 2) });
      // Back to exactly the tuple A was admitted against, still with no stdin.
      steps.push({ op: "session", tuple: conversation("native-session-a", 1) });
    }
    if (variant === "truncated") steps.push({ op: "end" });
    // A's own final frame with one MAC nibble inverted: a strict decoder failure in
    // the middle of the dispatch, so A never completes.
    const remainder = variant === "corrupt"
      ? Buffer.from(flipFrameMac(aFrames[1]!), "hex").subarray(aSplit - aFrames[0]!.length / 2)
      : aStream.subarray(aSplit);
    steps.push(...feeds(remainder));
    if (variant === "changed" || variant === "aba") {
      steps.push({ op: "feed", hex: keyboardFrame });
      steps.push({ op: "feed", hex: pasteFrame });
    }
    steps.push({ op: "wait", ms: 80 });
    return runScenario({ options: { inputOriginFraming: true }, nativeParser: true, steps });
  };

  for (const variant of ["changed", "aba"] as const) {
    const report = run(variant);
    assert.equal(report.installed, true);
    assert.ok(report.feeds.every((value) => value === true), "every physical read is consumed");

    // The ACTUAL native parser is asserted FIRST and exactly, with no normalization
    // of anything the parser reported: the real pinned StdinBuffer native Pi 1.3.0
    // uses (not a reimplementation and not a patched native class) must report
    // exactly the next paste body and exactly the next keyboard input — no buffered
    // A prefix, no stray marker, no contamination of any kind. The old per-fragment
    // streaming cannot satisfy this: it hands the parser A's unterminated `200~`
    // prefix, and the next `201~` then closes an A+B paste.
    assert.deepEqual(report.parserPaste, [bPasteBody],
      `${variant}: the real parser sees exactly the next paste body, with no stale A contamination and no stray markers`);
    assert.equal(report.parserData.join(""), "ok\r",
      `${variant}: the next keyboard input reaches the real parser byte-exact and outside paste mode`);

    // Owned-bridge level, asserted afterwards: only the two current dispatches were
    // emitted at all, so no fragment of the stale A dispatch ever became a prefix.
    assert.equal(report.payloads.length, 2,
      `${variant}: the stale A dispatch emitted nothing at all, not even its first fragment`);
    const emitted = Buffer.concat(report.payloads.map(bytesOf)).toString("latin1");
    assert.equal(emitted, `ok\r${pasteStart}${bPasteBody}${pasteEnd}`);
    assert.equal(emitted.includes("A"), false, `${variant}: no A byte reached a native listener`);
  }

  for (const variant of ["corrupt", "truncated"] as const) {
    const report = run(variant);
    assert.equal(report.installed, true);
    // Again the real parser first: an incomplete viewer dispatch must leave it with
    // no paste and no data at all, rather than with an unclosed paste prefix.
    assert.deepEqual(report.parserPaste, [], `${variant}: the real parser saw no paste at all`);
    assert.deepEqual(report.parserData, [], `${variant}: the real parser saw no keyboard data`);
    assert.deepEqual(report.payloads, [],
      `${variant}: an incomplete viewer dispatch never becomes a native prefix`);
  }
});

test("one complete viewer dispatch is assembled whole against the technical bound", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const pasteStart = "\x1b[200~";
  const pasteEnd = "\x1b[201~";
  const exact = Buffer.from(
    `${pasteStart}${"U".repeat(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES - pasteStart.length - pasteEnd.length)}${pasteEnd}`,
    "utf8",
  );
  assert.equal(exact.length, NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
    "the technical bound is the agreed 1 MiB body plus its two six-byte markers");
  const exactFrames = frameChunks(encoder.encode(
    exact, viewer("opaque-viewer-exact"), fence("native-session-bound", 1),
  ));
  assert.ok(exactFrames.length > 1, "the bounded dispatch really spans many fragments");
  const over = Buffer.from("O".repeat(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES + 1), "utf8");
  const overFrames = frameChunks(encoder.encode(
    over, viewer("opaque-viewer-over"), fence("native-session-bound", 1),
  ));
  const next = frameChunks(encoder.encode(
    Buffer.from("next valid"), viewer("opaque-viewer-next"), fence("native-session-bound", 2),
  ));
  const unicodeText = `${"a".repeat(32_767)}\u00e9tail`;
  const unicode = frameChunks(encoder.encode(
    Buffer.from(unicodeText, "utf8"), viewer("opaque-viewer-unicode"), fence("native-session-bound", 2),
  ));
  assert.equal(unicode.length, 2, "a UTF-8 sequence straddles the fragment bound");
  // Encode and deliver in the same order: this case tests the byte bound, not a
  // replay/gap rejection of an accidentally reordered authenticated stream.
  const independentlyChecked = createNativeInputDecoder(bootstrap);
  for (const hex of [...exactFrames, ...overFrames, ...next, ...unicode]) {
    assert.equal(independentlyChecked.feed(Buffer.from(hex, "hex")).ok, true,
      "the bound fixture itself has a valid authenticated dispatch sequence");
  }
  assert.equal(independentlyChecked.finish().ok, true);

  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-bound", 1) },
      // Every fragment arrives in its own physical read: no early native emit.
      ...exactFrames.map((hex) => ({ op: "feed", hex })),
      ...overFrames.map((hex) => ({ op: "feed", hex })),
      // The next dispatch matches the current conversation and is delivered normally.
      { op: "session", tuple: conversation("native-session-bound", 2) },
      { op: "feed", hex: next[0]! },
      { op: "stringMode" },
      { op: "feed", hex: unicode[0]! },
      { op: "feed", hex: unicode[1]! },
    ],
  });
  assert.equal(report.installed, true);
  assert.ok(report.feeds.every((value) => value === true));

  assert.equal(report.payloads.length, 3,
    "the exact-bound dispatch emitted once, the +1 dispatch emitted nothing, the next dispatch emitted once");
  assert.deepEqual(bytesOf(report.payloads[0]!), exact,
    "the exact technical bound is accepted and delivered once, byte-exact");
  assert.deepEqual(bytesOf(report.payloads[1]!), Buffer.from("next valid"),
    "an over-bound refusal poisons nothing: the next valid dispatch is delivered exactly");
  assert.equal(Buffer.concat(report.payloads.slice(0, 2).map(bytesOf)).includes(Buffer.from("O")), false,
    "not one byte of the over-bound dispatch (no truncation, no prefix) reached a listener");
  const strings = report.payloads.filter((payload) => payload.kind === "string").map((payload) => payload.text!);
  assert.deepEqual(strings, [unicodeText],
    "string-mode viewer input is decoded once, whole, with the split UTF-8 sequence intact");
  assert.equal(strings.join("").includes("\ufffd"), false);
});

test("many empty or tiny viewer fragments stay bounded and never emit a prefix", () => {
  // 64 empty parts and one tiny final part in one logical dispatch: only payload
  // bytes are retained, so an empty-fragment flood cannot grow metadata.
  const payloads = [...Array.from({ length: 64 }, () => Buffer.alloc(0)), Buffer.from("tail after empty parts", "utf8")];
  const frames = frameChunks(handBuiltViewerFrames(
    1, 1, payloads, "opaque-viewer-empty", { sessionId: "native-session-sparse", epoch: 1 },
  ).join(""));
  assert.equal(frames.length, payloads.length);
  const report = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-sparse", 1) },
      ...frames.map((hex) => ({ op: "feed", hex })),
    ],
  });
  assert.equal(report.installed, true);
  assert.ok(report.feeds.every((value) => value === true));
  assert.equal(report.payloads.length, 1, "the whole dispatch is emitted exactly once, at its final part");
  assert.deepEqual(bytesOf(report.payloads[0]!), Buffer.from("tail after empty parts", "utf8"),
    "empty fragments add no bytes and no metadata");
});

test("an incomplete viewer dispatch before a malformed frame or end of input never reaches a listener", () => {
  const encoderA = createNativeInputEncoder(bootstrap);
  const partial = frameChunks(encoderA.encode(
    Buffer.from("P".repeat(40_000), "utf8"), viewer("opaque-viewer-partial"), fence("native-session-partial", 1),
  ));
  assert.equal(partial.length, 2);
  const afterPoison = frameChunks(encoderA.encode(Buffer.from("after poison"), local))[0]!;
  const malformed = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-partial", 1) },
      { op: "feed", hex: partial[0]! },
      { op: "feed", hex: flipFrameMac(partial[1]!) },
      { op: "feed", hex: afterPoison },
    ],
  });
  assert.equal(malformed.installed, true);
  assert.ok(malformed.feeds.every((value) => value === true));
  assert.deepEqual(malformed.payloads, [],
    "a viewer prefix is never a native prefix, and a poisoned decoder re-enables nothing");
  assert.deepEqual(malformed.copies, [], "no native listener ran at all");

  // End of input with an open viewer dispatch is a truncation, never a flush.
  const encoderB = createNativeInputEncoder(bootstrap);
  const truncated = frameChunks(encoderB.encode(
    Buffer.from("T".repeat(40_000), "utf8"), viewer("opaque-viewer-truncated"), fence("native-session-partial", 2),
  ));
  const eof = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-partial", 2) },
      { op: "feed", hex: truncated[0]! },
      { op: "end" },
      { op: "feed", hex: truncated[1]! },
    ],
  });
  assert.deepEqual(eof.payloads, [], "an open viewer dispatch at end of input delivers nothing");

  // A COMPLETE viewer dispatch in the same physical chunk as a later failing frame
  // is still delivered: completion, not chunking, decides.
  const encoderC = createNativeInputEncoder(bootstrap);
  const whole = frameChunks(encoderC.encode(
    Buffer.from("whole dispatch"), viewer("opaque-viewer-whole"), fence("native-session-partial", 3),
  ))[0]!;
  const failing = frameChunks(encoderC.encode(Buffer.from("never delivered"), local))[0]!;
  const coalesced = runScenario({
    options: { inputOriginFraming: true },
    steps: [
      { op: "session", tuple: conversation("native-session-partial", 3) },
      { op: "feed", hex: `${whole}${flipFrameMac(failing)}` },
      { op: "feed", hex: whole },
    ],
  });
  assert.deepEqual(coalesced.payloads.map(bytesOf), [Buffer.from("whole dispatch")],
    "the dispatch that completed before the failing frame is delivered once, and nothing after it");
});

test("A -> B -> A session updates never revive a buffered viewer dispatch", () => {
  const encoder = createNativeInputEncoder(bootstrap);
  const aPayload = Buffer.from("a".repeat(40_000), "utf8");
  const a = frameChunks(encoder.encode(aPayload, viewer("opaque-viewer-aba"), fence("native-session-aba", 1)));
  assert.equal(a.length, 2);
  const next = frameChunks(encoder.encode(
    Buffer.from("next good"), viewer("opaque-viewer-aba"), fence("native-session-aba", 1),
  ))[0]!;
  for (const intermediate of [conversation("native-session-aba", 2), null]) {
    const report = runScenario({
      options: { inputOriginFraming: true },
      steps: [
        { op: "session", tuple: conversation("native-session-aba", 1) },
        { op: "feed", hex: a[0]! },
        // The conversation leaves (a newer epoch, or no conversation at all) and
        // comes back with no stdin in between: A's buffered prefix must be gone.
        { op: "session", tuple: intermediate },
        { op: "session", tuple: conversation("native-session-aba", 1) },
        { op: "feed", hex: a[1]! },
        { op: "feed", hex: next },
      ],
    });
    assert.equal(report.installed, true);
    assert.deepEqual(report.feeds, [true, true, true]);
    assert.deepEqual(report.payloads.map(bytesOf), [Buffer.from("next good")],
      `a returned tuple (${JSON.stringify(intermediate)}) never revives buffered A bytes`);
  }
});
