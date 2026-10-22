/**
 * Focused tests for the inert, opt-in stdin-origin framing mode of the
 * child-side native clipboard bridge, including its one-shot signed readiness
 * statement.
 *
 * Evidence scope (MOCK, source-only): every bridge case runs in an isolated Node
 * child process whose "native CLI" is a throwaway fake package
 * (tests/fixtures/session-host-native-clipboard-origin-bridge.cjs) that only
 * reproduces the named call frames the bridge's unchanged provenance gate
 * observes. These cases prove the owned bridge's strict input framing, its
 * per-dispatch AsyncLocalStorage tuple/origin capture, the readiness statement,
 * the v2 capsule wire shape, and that the default one-argument install stays the
 * legacy bridge. They make no claim about the installed Pi source, a real native
 * PTY/Windows/SSH child, the broker or viewer plumbing, or any physical
 * clipboard — none of those runs here, and no production caller enables the mode.
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
import { createNativeInputEncoder, NATIVE_INPUT_RAW_FRAGMENT_BYTES, type NativeInputOrigin } from "../src/session-host/native-input-origin";
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
      // A's copy is scheduled while A's part 0 is the live dispatch, then deferred.
      { op: "armCopy", text: "copy-alpha", defer: true, delay: 0 },
      { op: "feed", hex: alpha[0]! },
      { op: "feed", hex: alpha[1]! },
      // The Reporter publishes a newer epoch in the middle of A's dispatch — what
      // an in-child /new or /resume performed by an earlier listener looks like.
      { op: "session", tuple: conversation("native-session-a", 4) },
      { op: "feed", hex: alpha[2]! },
      // B is a local dispatch on the newer tuple, delivered before A's deferred copy.
      { op: "armCopy", text: "copy-beta", defer: false },
      { op: "feed", hex: beta[0]! },
      { op: "wait", ms: 30 },
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
    "every authenticated chunk is consumed, including a stale viewer tail");

  // Alpha's own fence named epoch 3, so once the child moved to epoch 4 its tail
  // belonged to no conversation: consumed, never delivered, never re-tagged onto
  // the newer one. The local beta dispatch carries no such fence and keeps its
  // unchanged whole-dispatch delivery on the newer tuple.
  assert.equal(report.payloads.length, 5);
  assert.equal(Buffer.concat(report.payloads.map(bytesOf)).equals(Buffer.concat([
    alphaPayload.subarray(0, 2 * NATIVE_INPUT_RAW_FRAGMENT_BYTES),
    betaPayload, deltaPayload, epsilonPayload,
  ])), true,
  "no framing byte reaches native listeners, no admitted payload byte is lost, and no stale byte is added");
  assert.deepEqual(bytesOf(report.payloads[1]!),
    alphaPayload.subarray(NATIVE_INPUT_RAW_FRAGMENT_BYTES, 2 * NATIVE_INPUT_RAW_FRAGMENT_BYTES));
  assert.deepEqual(bytesOf(report.payloads[2]!), betaPayload,
    "the next dispatch is delivered normally: a stale viewer tail poisons nothing");
  assert.ok(report.payloads.every((payload) => payload.kind === "buffer"));
  assert.ok(report.payloads.every((payload) => payload.thisIsStdin && payload.argCount === 0));
  assert.ok(copyCapsules(report).every((capsule) => capsule.startsWith("prg-native-copy-v2;")),
    "strict mode emits only v2 origin capsules");
  assert.equal(copyCapsules(report).some((capsule) => capsule.includes("prg-ni-v1")), false,
    "framing headers never reach stdout");

  const byText = new Map(receiveOrigin(report).map((receipt): [string, NativeClipboardOriginEvent] =>
    [copiedText(receipt.event), receipt]));
  assert.deepEqual([...byText.keys()].sort(),
    ["copy-alpha", "copy-beta", "copy-delta", "copy-epsilon"], "every proven copy arrives once");

  const alphaReceipt = byText.get("copy-alpha")!;
  assert.deepEqual(alphaReceipt.event, {
    kind: "copy", encoded: copyText("copy-alpha"), sessionId: "native-session-a", sessionEpoch: 3,
  });
  assert.deepEqual(alphaReceipt.origin, { kind: "viewer", token: "opaque-viewer-1" });
  assert.equal(alphaReceipt.dispatchId, 1);
  assert.equal(alphaReceipt.event.sessionEpoch, 3,
    "a deferred copy keeps the epoch captured at dispatch start, not the most recent one");

  assert.deepEqual(byText.get("copy-beta")!.origin, { kind: "local" });
  assert.equal(byText.get("copy-beta")!.dispatchId, 2);
  assert.equal(byText.get("copy-beta")!.event.sessionEpoch, 4);

  assert.deepEqual(byText.get("copy-delta")!.origin, { kind: "viewer", token: "opaque-viewer-2" });
  assert.deepEqual(byText.get("copy-epsilon")!.origin, { kind: "local" });
  assert.equal(byText.get("copy-delta")!.dispatchId, 3);
  assert.equal(byText.get("copy-epsilon")!.dispatchId, 4);
  assert.equal(byText.get("copy-delta")!.event.sessionEpoch, 5);
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
  assert.equal(buffers.length, 6);
  assert.deepEqual(buffers[0], decoy, "NUL, controls, paste markers and framing decoys survive exactly");
  assert.equal(Buffer.concat(buffers.slice(1, 4)).equals(large), true);
  assert.equal(Buffer.concat(buffers.slice(4)).toString("utf8"), "thirdfourth",
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

  assert.equal(report.payloads.length, 3, "only admitted fragments are delivered");
  assert.deepEqual(bytesOf(report.payloads[0]!), midPayload.subarray(0, NATIVE_INPUT_RAW_FRAGMENT_BYTES),
    "the fragment admitted against the live conversation is delivered exactly");
  assert.deepEqual(bytesOf(report.payloads[1]!), Buffer.from("local spans on", "utf8"),
    "local input semantics are unchanged by a stale viewer tail");
  assert.deepEqual(bytesOf(report.payloads[2]!), Buffer.from("current keys", "utf8"),
    "a valid viewer dispatch after a stale one is delivered normally");
  const delivered = Buffer.concat(report.payloads.map(bytesOf)).toString("utf8");
  assert.equal(delivered.includes("stale whole dispatch"), false, "a whole stale dispatch delivers nothing");
  assert.equal(delivered.includes("M".repeat(NATIVE_INPUT_RAW_FRAGMENT_BYTES + 1)), false,
    "the stale tail is never re-tagged onto the newer conversation");
});
