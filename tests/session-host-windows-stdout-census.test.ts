/**
 * Pure regression tests for the fresh numeric-only Main stdout mode-request
 * census: the incremental DECSET/DECRST parser, the exact-forwarding write
 * hook with own/inherited restoration semantics and permanent uncertainty
 * latches, the bounded request/reply service driven by injected fake IO, the
 * original Main PID binding, the strict reply contract (including the nested
 * independent active-pane diagnostic group), and the pre-Quit
 * diagnostic-preservation path exercised through a prototype-only driver
 * fake. No actual filesystem, process, PTY, or Windows runtime is touched;
 * the CJS fixture is required directly as a pure module.
 */
import assert from "node:assert/strict";
import { dirname, join as pathJoin } from "node:path";
import test from "node:test";

import {
  MAIN_CENSUS_COUNT_LIMIT,
  MAIN_PANE_GEOMETRY_LIMIT,
  OriginalMainPidBinding,
  formatMainCensusDiagnostic,
  validateMainActivePaneSnapshot,
  validateMainModeCensusReply,
  validateMainNativeBindingSnapshot,
  type MainModeCensusSnapshot,
} from "./helpers/session-host-windows-stdout-census-contract";
import { WindowsMainPtyDriver } from "./helpers/session-host-native-windows-harness";
import type { TerminalInputModes } from "../src/session-host/terminal-surface";

interface CensusOffer {
  commit(): void;
  discard(): void;
}

interface CensusCounts {
  readonly [field: string]: number;
}

interface Census {
  beginOffer(data: unknown, second?: unknown): CensusOffer | null;
  markUnknown(): void;
  snapshot(): { readonly unknown: boolean; readonly counts: CensusCounts };
}

interface CensusHandle {
  snapshot(): Record<string, unknown>;
  restore(): boolean;
}

interface FakeFsLike {
  lstatSync(p: string, options?: { bigint?: boolean }): unknown;
  openSync(p: string, flags: string, mode?: number): number;
  fstatSync(fd: number, options?: { bigint?: boolean }): unknown;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  writeSync(fd: number, data: string): number;
  watch(root: string): unknown;
}

interface CensusServiceOptions {
  root: string;
  mainPid: number | (() => number);
  buildSnapshot: () => Record<string, unknown>;
  fs: FakeFsLike;
  maxRequestBytes?: number;
  closeAfterServe?: boolean;
  rootChain?: Array<{ path: string; dev: bigint; ino: bigint }>;
}

interface CensusService {
  start(): void;
  close(): void;
  readonly servedNonce: string | undefined;
}

const censusFixture = require("../../tests/fixtures/session-host-windows-stdout-census.cjs") as {
  CENSUS_SCHEMA_VERSION: number;
  CENSUS_REQUEST_FILENAME: string;
  CENSUS_REPLY_FILENAME: string;
  CENSUS_KNOWN_MODES: ReadonlyArray<{ readonly mode: number; readonly field: string }>;
  CENSUS_COUNT_FIELDS: readonly string[];
  createStdoutModeCensus(options?: { maxCarry?: number; maxCount?: number }): Census;
  installStdoutWriteCensus(outputStream: object, census: Census, options?: { streamIdentity?: () => unknown }): CensusHandle;
  createCensusReplyService(options: CensusServiceOptions): CensusService;
  buildCensusReply(nonce: string, mainPid: number, snapshot: Record<string, unknown>): Record<string, unknown>;
  isCensusRequestPayload(payload: unknown): boolean;
};

const NONCE = "0123456789abcdef01234567";
const OTHER_NONCE = "fedcba9876543210fedcba98";
const REQUEST_NAME = censusFixture.CENSUS_REQUEST_FILENAME;
const REPLY_NAME = censusFixture.CENSUS_REPLY_FILENAME;

function feedCensus(census: Census, ...chunks: unknown[]): void {
  for (const chunk of chunks) {
    const offer = census.beginOffer(chunk);
    if (offer !== null) offer.commit();
  }
}

interface FakeWriteCall {
  readonly receiver: unknown;
  readonly args: unknown[];
}

function makeInheritedStream(options: { readonly errors?: Record<number, Error> } = {}) {
  const calls: FakeWriteCall[] = [];
  class FakeStream {
    write(...args: unknown[]): string {
      calls.push({ receiver: this, args });
      // A real Writable may invoke the caller callback synchronously, which
      // can mutate a Buffer before the original call returns.
      if (typeof args[1] === "function") (args[1] as () => void)();
      const error = options.errors?.[calls.length - 1];
      if (error !== undefined) throw error;
      return "SYNTHETIC-accept";
    }
  }
  const stream = new FakeStream();
  return { stream, calls, prototype: FakeStream.prototype };
}

function makeOwnStream() {
  const calls: FakeWriteCall[] = [];
  const original = function ownWrite(this: unknown, ...args: unknown[]): string {
    calls.push({ receiver: this, args });
    return "SYNTHETIC-own-accept";
  };
  const stream: Record<string, unknown> = {};
  Object.defineProperty(stream, "write", { value: original, writable: true, configurable: true, enumerable: false });
  return { stream, original, calls };
}

function sampleSnapshot(): Record<string, unknown> {
  const { stream } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  (stream.write as (data?: unknown) => unknown).call(stream, Buffer.from("\x1b[?1003;1006h\x1b[?1049h"));
  const snapshot = handle.snapshot();
  handle.restore();
  return { ...snapshot, activePane: completeActivePane(), nativeBinding: completeNativeBinding() };
}

/** A coherent, positively-known active-pane group used by the pure regressions. */
function completeActivePane(): Record<string, unknown> {
  return {
    complete: true,
    scope: true,
    ownerPresent: true,
    focusMain: true,
    viewMatched: true,
    hasLiveProcess: true,
    lifecycleAlive: true,
    surfacePresent: true,
    modesReadSucceeded: true,
    mouseTracking: 4,
    mouseEncoding: 1,
    geometryColumns: null,
    geometryRows: null,
  };
}

/** An honest all-null active-pane group with an explicit independent scope pair. */
function unknownActivePane(scope: boolean | null, complete: boolean | null): Record<string, unknown> {
  return {
    complete,
    scope,
    ownerPresent: null,
    focusMain: null,
    viewMatched: null,
    hasLiveProcess: null,
    lifecycleAlive: null,
    surfacePresent: null,
    modesReadSucceeded: null,
    mouseTracking: null,
    mouseEncoding: null,
    geometryColumns: null,
    geometryRows: null,
  };
}

/** A coherent, positively-known native-binding group used by the pure regressions. */
function completeNativeBinding(): Record<string, unknown> {
  return {
    scope: true,
    complete: true,
    ptyPid: 4243,
    incarnation: 1,
    sessionEpoch: 1,
    expectedProof: "a".repeat(64),
  };
}

/** An honest all-null native-binding group: the observation was never established. */
function unestablishedNativeBinding(): Record<string, unknown> {
  return {
    scope: null,
    complete: null,
    ptyPid: null,
    incarnation: null,
    sessionEpoch: null,
    expectedProof: null,
  };
}

test("census recognizes single, combined, and split complete DEC lists", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census, "\x1b[?1003h");
  let counts = census.snapshot().counts;
  assert.equal(counts.mouseAnySet, 1);
  assert.equal(census.snapshot().unknown, false);

  feedCensus(census, "\x1b[?1003;1006h");
  counts = census.snapshot().counts;
  assert.equal(counts.mouseAnySet, 2, "the combined list requests tracking mode 1003 again");
  assert.equal(counts.mouseSgrSet, 1, "the combined list requests the 1006 SGR encoding");

  feedCensus(census, "\x1b[", "?1003;100", "6l");
  counts = census.snapshot().counts;
  assert.equal(counts.mouseAnyReset, 1, "a list split across chunk boundaries is recognized complete");
  assert.equal(counts.mouseSgrReset, 1);
  assert.equal(counts.writeCalls, 5, "every non-throwing offer counts one write call");
});

test("census counts repeated same-mode requests within one chunk exactly", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census, "\x1b[?1006h\x1b[?1006h\x1b[?1006h");
  assert.equal(census.snapshot().counts.mouseSgrSet, 3, "three complete SGR requests in one chunk count three");
  assert.equal(census.snapshot().counts.writeCalls, 1, "one write call carried all three requests");
});

test("a synchronous nested write commits its own offer, not the outer offer's deltas", () => {
  const { stream, calls } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  const outerBuffer = Buffer.from("\x1b[?1003h"); // the outer offer requests tracking mode
  const nestedBuffer = Buffer.from("\x1b[?1006h"); // the nested offer requests SGR mode
  stream.write(outerBuffer, () => {
    stream.write(nestedBuffer);
  });
  const snapshot = handle.snapshot();
  assert.equal(snapshot.observationComplete, true);
  assert.equal(snapshot.writeCalls, 2, "both the outer and nested original calls are counted");
  assert.equal(snapshot.mouseAnySet, 1, "the outer offer committed its own tracking request");
  assert.equal(snapshot.mouseSgrSet, 1, "the nested offer committed its own SGR request");
  assert.equal(calls.length, 2, "exact forwarded calls are preserved");
  assert.equal(calls[0]!.args[0], outerBuffer);
  assert.equal(calls[1]!.args[0], nestedBuffer);
});

test("census counts x10 mode 9 and keeps it distinct from other 9-prefixed modes", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census, "\x1b[?9h\x1b[?90h\x1b[?9l");
  const counts = census.snapshot().counts;
  assert.equal(counts.mouseX10Set, 1);
  assert.equal(counts.mouseX10Reset, 1);
  assert.equal(counts.mouseVt200Set, 0);
  assert.equal(counts.mouseDragSet, 0);
  assert.equal(counts.mouseAnySet, 0, "9 is x10 tracking, never a substring of another mode");
});

test("census treats leading-zero DEC parameters numerically", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census, "\x1b[?09;02004h");
  const counts = census.snapshot().counts;
  assert.equal(counts.mouseX10Set, 1);
  assert.equal(counts.bracketedPasteSet, 1);
});

test("census rejects partial, malformed, and unknown DEC lists without false positives", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census,
    "\x1b[?1003;", // trailing separator (abandoned by the next ESC)
    "\x1b[?;1006h", // empty first parameter
    "\x1b[?100 3h", // a space is not a decimal parameter byte
    "\x1b[?9999h", // unknown mode: never counted, never unknown
    "\x1b[2J\x1b[1;5H", // non-DEC CSI sequences do not corrupt the state machine
  );
  const snapshot = census.snapshot();
  assert.equal(snapshot.unknown, false);
  for (const field of censusFixture.CENSUS_COUNT_FIELDS) {
    if (field === "writeCalls") continue;
    assert.equal(snapshot.counts[field], 0, `no false positive in ${field}`);
  }
  assert.equal(snapshot.counts.writeCalls, 5);
});

test("census snapshot latches sticky unknown on an outstanding partial sequence", () => {
  const afterEsc = censusFixture.createStdoutModeCensus();
  feedCensus(afterEsc, "\x1b");
  let snapshot = afterEsc.snapshot();
  assert.equal(snapshot.unknown, true, "an outstanding ESC is a partial sequence, never a known zero");
  assert.deepEqual(Object.keys(snapshot).sort(), ["counts", "unknown"], "no raw data leaves the census state");

  const afterCsiIntro = censusFixture.createStdoutModeCensus();
  feedCensus(afterCsiIntro, "\x1b[");
  assert.equal(afterCsiIntro.snapshot().unknown, true, "an outstanding CSI intro is a partial sequence");

  const afterPartialList = censusFixture.createStdoutModeCensus();
  feedCensus(afterPartialList, "\x1b[?1003;100");
  snapshot = afterPartialList.snapshot();
  assert.equal(snapshot.unknown, true, "an incomplete DEC list is a partial sequence");
  assert.equal(afterPartialList.beginOffer("6h"), null, "the latched census never observes again");
  snapshot = afterPartialList.snapshot();
  assert.equal(snapshot.unknown, true, "a later completion cannot borrow known counts");
  assert.equal(snapshot.counts.mouseAnySet, 0, "no count is manufactured from the abandoned prefix");
});

test("census parses Buffer and string chunks identically, including non-ASCII data", () => {
  const fromBuffer = censusFixture.createStdoutModeCensus();
  feedCensus(fromBuffer, Buffer.from("\x1b[?1006h"));
  const fromString = censusFixture.createStdoutModeCensus();
  feedCensus(fromString, "\u{1F600}\x1b[?1006h");
  assert.equal(fromBuffer.snapshot().counts.mouseSgrSet, 1);
  assert.equal(fromString.snapshot().counts.mouseSgrSet, 1, "non-ASCII data never corrupts the state machine");
});

test("census models only utf8 string encodings and marks others sticky unknown", () => {
  const hex = censusFixture.createStdoutModeCensus();
  assert.equal(hex.beginOffer("1b5b3f3130303668", "hex"), null, "hex is not an explicitly modeled encoding");
  assert.equal(hex.snapshot().unknown, true);

  const base64 = censusFixture.createStdoutModeCensus();
  assert.equal(base64.beginOffer(Buffer.from("\x1b[?1006h").toString("base64"), "base64"), null);
  assert.equal(base64.snapshot().unknown, true);

  const utf16 = censusFixture.createStdoutModeCensus();
  assert.equal(utf16.beginOffer("\x1b[?1006h", "utf16le"), null);
  assert.equal(utf16.snapshot().unknown, true);

  const explicitUtf8 = censusFixture.createStdoutModeCensus();
  const utf8Offer = explicitUtf8.beginOffer("\x1b[?1006h", "utf8");
  assert.ok(utf8Offer !== null, "explicit utf8 is the modeled default encoding");
  utf8Offer.commit();
  assert.equal(explicitUtf8.snapshot().counts.mouseSgrSet, 1);

  const bufferWithEncoding = censusFixture.createStdoutModeCensus();
  const bufferOffer = bufferWithEncoding.beginOffer(Buffer.from("\x1b[?1006h"), "utf8");
  assert.ok(bufferOffer !== null, "buffer data is observed byte-exact regardless of the encoding argument");
  bufferOffer.commit();
  assert.equal(bufferWithEncoding.snapshot().counts.mouseSgrSet, 1);
});

test("census marks carry truncation and counter overflow as sticky unknown", () => {
  const truncated = censusFixture.createStdoutModeCensus({ maxCarry: 4 });
  feedCensus(truncated, "\x1b[?12345h");
  assert.equal(truncated.snapshot().unknown, true, "a list beyond the bounded carry is truncation, not zero");
  assert.equal(truncated.beginOffer("\x1b[?1006h"), null, "a truncated census never recovers");

  const overflowed = censusFixture.createStdoutModeCensus({ maxCount: 2 });
  feedCensus(overflowed, "\x1b[?1006h", "\x1b[?1006h", "\x1b[?1006h");
  assert.equal(overflowed.snapshot().unknown, true, "counter overflow is sticky unknown");
});

test("census bounds per-offer storage and marks overflow within one chunk", () => {
  const census = censusFixture.createStdoutModeCensus({ maxCount: 5 });
  const chunk = Buffer.from(Array.from({ length: 10 }, () => "\x1b[?1006h").join(""));
  assert.equal(census.beginOffer(chunk), null, "overflow within one offer is sticky unknown");
  assert.equal(census.snapshot().unknown, true);
});

test("census marks unsupported chunk types as sticky unknown", () => {
  const census = censusFixture.createStdoutModeCensus();
  feedCensus(census, "\x1b[?1006h");
  assert.equal(census.beginOffer(new ArrayBuffer(8)), null);
  assert.equal(census.snapshot().unknown, true);
  assert.equal(censusFixture.createStdoutModeCensus().beginOffer(undefined), null);
});

test("hook preserves exact receiver, arguments, callback identity, return, and error", () => {
  const { stream, calls } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  const callback = (): void => {};
  const buffer = Buffer.from("\x1b[?1006h");
  assert.equal(stream.write(buffer, callback), "SYNTHETIC-accept", "exact original return/backpressure value");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.receiver, stream, "exact original receiver is preserved");
  assert.equal(calls[0]!.args[0], buffer, "exact data argument is preserved");
  assert.equal(calls[0]!.args[1], callback, "exact callback identity is preserved");
  const snapshot = handle.snapshot();
  assert.equal(snapshot.observationComplete, true);
  assert.equal(snapshot.writeCalls, 1);
  assert.equal(snapshot.mouseSgrSet, 1);
  assert.equal(handle.restore(), true);
});

test("synchronous callback mutation never changes the offered-mode counts", () => {
  const { stream } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  const buffer = Buffer.from("\x1b[?1003;1006h");
  stream.write(buffer, () => { buffer.fill(0); });
  const counts = census.snapshot().counts;
  assert.equal(counts.mouseAnySet, 1, "the offer was captured before the original call");
  assert.equal(counts.mouseSgrSet, 1);
});

test("a throwing original invalidates the entire census and rethrows the identical error", () => {
  const boom = new Error("SYNTHETIC original write failure");
  const { stream } = makeInheritedStream({ errors: { 0: boom } });
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  assert.throws(() => stream.write(Buffer.from("\x1b[?1006h")), (error: unknown) => error === boom,
    "identical original thrown error identity");
  const snapshot = handle.snapshot();
  assert.equal(snapshot.observationComplete, false, "a throwing original write invalidates the entire census");
  assert.equal(snapshot.writeCalls, null, "invalidated observation never reports counts");
  assert.equal(snapshot.mouseSgrSet, null);
});

test("a throwing partial sequence followed by a successful suffix never manufactures counts", () => {
  const boom = new Error("SYNTHETIC original write failure");
  const { stream } = makeInheritedStream({ errors: { 0: boom } });
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  assert.throws(() => stream.write(Buffer.from("\x1b[?100")), (error: unknown) => error === boom);
  stream.write(Buffer.from("6h")); // would complete the list if the failed parser state survived
  const snapshot = handle.snapshot();
  assert.equal(snapshot.observationComplete, false, "the failed partial offer invalidates the whole observation");
  assert.equal(snapshot.mouseSgrSet, null, "no count is manufactured from a failed call plus a later suffix");
});

test("hook snapshot between split writes latches sticky unknown and never borrows a later completion", () => {
  const { stream } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  stream.write(Buffer.from("\x1b[?1003;100"));
  const between = handle.snapshot();
  assert.equal(between.observationComplete, false, "an outstanding partial sequence is not a complete observation");
  for (const field of censusFixture.CENSUS_COUNT_FIELDS) {
    assert.equal(between[field], null, `no known zero in ${field}`);
  }
  stream.write(Buffer.from("6h")); // would complete the list if the partial state survived
  const after = handle.snapshot();
  assert.equal(after.observationComplete, false, "a later completion cannot borrow known counts");
  for (const field of censusFixture.CENSUS_COUNT_FIELDS) {
    assert.equal(after[field], null);
  }
});

test("hook snapshot after a fully completed split feed still counts the supported sequence", () => {
  const { stream } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  stream.write(Buffer.from("\x1b[?1003;100"));
  stream.write(Buffer.from("6h"));
  const snapshot = handle.snapshot();
  assert.equal(snapshot.observationComplete, true, "a split sequence completed before the snapshot is counted");
  assert.equal(snapshot.writeCalls, 2);
  assert.equal(snapshot.mouseAnySet, 1);
  assert.equal(snapshot.mouseSgrSet, 1);
});

test("a borrowed receiver forwards exactly but marks the census unknown", () => {
  const { stream, calls } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  const foreign: Record<string, never> = {};
  assert.equal(Reflect.apply(stream.write, foreign, [Buffer.from("\x1b[?1006h")]), "SYNTHETIC-accept",
    "the borrowed call still forwards the exact original receiver and return");
  assert.equal(calls[0]!.receiver, foreign, "the original received the exact borrowed receiver");
  const snapshot = handle.snapshot();
  assert.equal(snapshot.hookActive, true);
  assert.equal(snapshot.sameOutputStream, true);
  assert.equal(snapshot.observationComplete, false, "a different receiver is never counted as Main stdout");
  assert.equal(snapshot.writeCalls, null);
  assert.equal(snapshot.mouseSgrSet, null);
});

test("inherited write restore removes only the owned hook and refuses a second pass", () => {
  const { stream, prototype } = makeInheritedStream();
  const handle = censusFixture.installStdoutWriteCensus(stream, censusFixture.createStdoutModeCensus(), { streamIdentity: () => stream });
  assert.notEqual(stream.write, prototype.write, "the owned hook occupies the slot");
  assert.equal(handle.restore(), true);
  assert.equal(Object.getOwnPropertyDescriptor(stream, "write"), undefined, "no own property remains");
  assert.equal(stream.write, prototype.write, "the inherited original is visible again");
  assert.equal(handle.restore(), false, "a second restore never touches a restored slot");
});

test("own write descriptor is restored exactly", () => {
  const { stream, original } = makeOwnStream();
  const handle = censusFixture.installStdoutWriteCensus(stream, censusFixture.createStdoutModeCensus(), { streamIdentity: () => stream });
  assert.notEqual(stream.write, original);
  assert.equal(handle.restore(), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(stream, "write"),
    { value: original, writable: true, enumerable: false, configurable: true },
    "the exact original own descriptor is preserved");
  assert.equal(stream.write, original);
});

test("restore refuses a foreign replacement and leaves the slot untouched", () => {
  const { stream } = makeInheritedStream();
  const handle = censusFixture.installStdoutWriteCensus(stream, censusFixture.createStdoutModeCensus(), { streamIdentity: () => stream });
  const foreignFn = (): string => "SYNTHETIC-foreign";
  Object.defineProperty(stream, "write", { value: foreignFn, writable: true, configurable: true, enumerable: false });
  assert.equal(handle.restore(), false, "restore never deletes or overwrites a foreign replacement");
  assert.equal(stream.write, foreignFn);
});

test("observed hook replacement latches permanent uncertainty even after reinstallation", () => {
  const { stream } = makeInheritedStream();
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => stream });
  const ownedHook = stream.write;
  const foreignFn = (): string => "SYNTHETIC-foreign";
  Object.defineProperty(stream, "write", { value: foreignFn, writable: true, configurable: true, enumerable: false });
  let snapshot = handle.snapshot();
  assert.equal(snapshot.hookActive, false);
  assert.equal(snapshot.observationComplete, false);
  Object.defineProperty(stream, "write", { value: ownedHook, writable: true, configurable: true, enumerable: false });
  snapshot = handle.snapshot();
  assert.equal(snapshot.hookActive, true, "the owned hook occupies the slot again");
  assert.equal(snapshot.observationComplete, false, "writes during replacement were missed and stay uncertain");
  assert.equal(snapshot.mouseSgrSet, null);
});

test("observed stream-identity loss latches permanent uncertainty even after reversion", () => {
  const { stream } = makeInheritedStream();
  let identity: unknown = stream;
  const census = censusFixture.createStdoutModeCensus();
  const handle = censusFixture.installStdoutWriteCensus(stream, census, { streamIdentity: () => identity });
  stream.write(Buffer.from("\x1b[?1006h"));
  identity = {}; // simulate process.stdout being replaced by a foreign object
  let snapshot = handle.snapshot();
  assert.equal(snapshot.sameOutputStream, false);
  assert.equal(snapshot.observationComplete, false);
  identity = stream; // reverted
  snapshot = handle.snapshot();
  assert.equal(snapshot.sameOutputStream, true, "the identity source reports the retained stream again");
  assert.equal(snapshot.observationComplete, false, "writes on the foreign stream were missed and stay uncertain");
  assert.equal(snapshot.mouseSgrSet, null);
});

interface FakeEntry {
  kind: "file" | "directory" | "symlink";
  content?: string;
  dev: bigint;
  ino: bigint;
  partialRead?: boolean;
  growOnFstat?: string;
  replaceOnOpen?: FakeEntry;
  /** Swaps the file content once reads reach the original end (growth during read). */
  growOnReadComplete?: string;
  /** Swaps the map entry with another identity once reads reach the original end (replacement after open). */
  replaceOnReadComplete?: FakeEntry;
}

function makeFakeFs(options: { readonly watcherFailOnCall?: number; readonly onReadComplete?: () => void } = {}) {
  const entries = new Map<string, FakeEntry>();
  const fdToPath = new Map<number, string>();
  const closedFds: number[] = [];
  let nextFd = 0;
  let inoCounter = 100n;
  let onCallIndex = 0;
  const watches: string[] = [];
  const watcherHandlers: Record<string, (eventType: string, filename: string | null) => void> = {};
  const watcher = {
    closedCount: 0,
    on(event: string, handler: (eventType: string, filename: string | null) => void): unknown {
      if (options.watcherFailOnCall !== undefined && onCallIndex === options.watcherFailOnCall) {
        throw new Error("SYNTHETIC watcher listener registration failure");
      }
      onCallIndex += 1;
      watcherHandlers[event] = handler;
      return watcher;
    },
    close(): void { watcher.closedCount += 1; },
  };

  function errno(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
  }

  function statsOf(entry: FakeEntry) {
    return {
      dev: entry.dev,
      ino: entry.ino,
      size: BigInt(Buffer.byteLength(entry.content ?? "", "utf8")),
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.kind === "symlink",
    };
  }

  const fs: FakeFsLike = {
    lstatSync(p: string) {
      const entry = entries.get(p);
      if (!entry) throw errno("ENOENT", `fake ENOENT ${p}`);
      return statsOf(entry);
    },
    openSync(p: string, flags: string) {
      if (flags === "r") {
        const existing = entries.get(p);
        if (existing?.replaceOnOpen !== undefined) entries.set(p, existing.replaceOnOpen);
        const entry = entries.get(p);
        if (!entry || entry.kind !== "file") throw errno("ENOENT", `fake ENOENT ${p}`);
        nextFd += 1;
        fdToPath.set(nextFd, p);
        return nextFd;
      }
      if (flags === "wx") {
        if (entries.has(p)) throw errno("EEXIST", `fake EEXIST ${p}`);
        inoCounter += 1n;
        entries.set(p, { kind: "file", content: "", dev: 1n, ino: inoCounter });
        nextFd += 1;
        fdToPath.set(nextFd, p);
        return nextFd;
      }
      throw new Error(`fake fs does not support flags ${flags}`);
    },
    fstatSync(fd: number) {
      const p = fdToPath.get(fd);
      if (p === undefined) throw errno("EBADF", "fake EBADF");
      const entry = entries.get(p)!;
      if (entry.growOnFstat !== undefined) entry.content = entry.growOnFstat; // simulate concurrent growth
      return statsOf(entry);
    },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      const p = fdToPath.get(fd);
      const entry = p !== undefined ? entries.get(p) : undefined;
      if (!entry || entry.content === undefined) return 0;
      const bytes = Buffer.from(entry.content, "utf8");
      const limit = entry.partialRead ? Math.floor(bytes.length / 2) : bytes.length;
      if (position >= limit) return 0;
      const end = Math.min(position + length, limit);
      bytes.copy(buffer, offset, position, end);
      // Concurrent mutation after the complete original content was served:
      // the descriptor stat already bounded allocation, so these changes are
      // only visible to the post-read validation.
      if (end >= bytes.length) {
        if (entry.growOnReadComplete !== undefined) entry.content = entry.growOnReadComplete;
        else if (entry.replaceOnReadComplete !== undefined && p !== undefined) entries.set(p, entry.replaceOnReadComplete);
      }
      options.onReadComplete?.();
      return end - position;
    },
    closeSync(fd: number) {
      closedFds.push(fd);
      fdToPath.delete(fd);
    },
    writeSync(fd: number, data: string) {
      const p = fdToPath.get(fd);
      if (p === undefined) throw errno("EBADF", "fake EBADF");
      const entry = entries.get(p)!;
      entry.content = (entry.content ?? "") + data;
      return Buffer.byteLength(data, "utf8");
    },
    watch(root: string) {
      watches.push(root);
      return watcher;
    },
  };

  return {
    fs,
    entries,
    watcher,
    watches,
    closedFds,
    addFile(p: string, content: string, overrides: Partial<FakeEntry> = {}): FakeEntry {
      inoCounter += 1n;
      const entry: FakeEntry = { kind: "file", content, dev: 1n, ino: inoCounter, ...overrides };
      entries.set(p, entry);
      return entry;
    },
    addDirectory(p: string): FakeEntry {
      inoCounter += 1n;
      const entry: FakeEntry = { kind: "directory", dev: 1n, ino: inoCounter };
      entries.set(p, entry);
      return entry;
    },
    emit(event: string, filename: string | null): void {
      watcherHandlers[event]?.(event, filename);
    },
  };
}

const FAKE_ROOT = pathJoin("/synthetic", "root");

/** Seeds the root AND every ancestor directory (to the filesystem top) so the bounded chain validates. */
function seedFakeRoot(fake: ReturnType<typeof makeFakeFs>): void {
  fake.addDirectory(FAKE_ROOT);
  let current = dirname(FAKE_ROOT);
  for (;;) {
    fake.addDirectory(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function startFakeService(fake: ReturnType<typeof makeFakeFs>, overrides: Partial<CensusServiceOptions> = {}): CensusService {
  const service = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => sampleSnapshot(),
    fs: fake.fs,
    ...overrides,
  });
  service.start();
  return service;
}

function validRequest(nonce: string, pid: number): string {
  return JSON.stringify({ schemaVersion: 1, nonce, expectedMainPid: pid });
}

test("census reply service serves exactly one validated request through fake IO", () => {
  const fake = makeFakeFs();
  seedFakeRoot(fake);
  fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  let snapshots = 0;
  const service = startFakeService(fake, {
    buildSnapshot: () => { snapshots += 1; return sampleSnapshot(); },
  });
  assert.deepEqual(fake.watches, [FAKE_ROOT], "exactly one owned nonrecursive watch");
  fake.emit("rename", REQUEST_NAME);
  const replyEntry = fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME));
  assert.ok(replyEntry, "the exclusive reply leaf was created");
  assert.equal(snapshots, 1, "the snapshot is built exactly once");
  const parsed = JSON.parse(replyEntry!.content!) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.nonce, NONCE);
  assert.equal(parsed.mainPid, 4242, "the reply binds the genuine Main PID");
  assert.equal(fake.closedFds.length, 2, "request and reply descriptors are each closed exactly once");
  fake.emit("rename", REQUEST_NAME);
  assert.equal(snapshots, 1, "a replayed request is refused after one serve");
  service.close();
  assert.equal(fake.watcher.closedCount, 1, "the exact watcher closes");
  service.close();
  assert.equal(fake.watcher.closedCount, 1, "the exact watcher closes only once");
});

test("census reply service refuses malformed, wrong-PID, and mismatched requests", () => {
  const cases: Array<{ label: string; payload: string }> = [
    { label: "wrong PID", payload: validRequest(NONCE, 9999) },
    { label: "extra key", payload: `${validRequest(NONCE, 4242).slice(0, -1)}, "extra": true}` },
    { label: "missing key", payload: JSON.stringify({ schemaVersion: 1, nonce: NONCE }) },
    { label: "wrong schema version", payload: validRequest(NONCE, 4242).replace('"schemaVersion":1', '"schemaVersion":2') },
    { label: "nonce outside bounded pattern", payload: JSON.stringify({ schemaVersion: 1, nonce: "short", expectedMainPid: 4242 }) },
    { label: "non-numeric PID", payload: validRequest(NONCE, 4242).replace("4242", '"4242"') },
  ];
  for (const testCase of cases) {
    const fake = makeFakeFs();
    seedFakeRoot(fake);
    fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), testCase.payload);
    const service = startFakeService(fake);
    fake.emit("rename", REQUEST_NAME);
    assert.equal(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
      `${testCase.label}: honest refusal writes no reply`);
    service.close();
  }
});

test("census reply service refuses oversized, symlinked, changed-root, and partial requests", () => {
  const oversized = makeFakeFs();
  seedFakeRoot(oversized);
  oversized.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const oversizedService = startFakeService(oversized, { maxRequestBytes: 32 });
  oversized.emit("rename", REQUEST_NAME);
  assert.equal(oversized.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "an oversized request is refused");
  oversizedService.close();

  const symlinked = makeFakeFs();
  seedFakeRoot(symlinked);
  symlinked.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242), { kind: "symlink" });
  const symlinkService = startFakeService(symlinked);
  symlinked.emit("rename", REQUEST_NAME);
  assert.equal(symlinked.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a symlinked request is refused");
  symlinkService.close();

  const changedRoot = makeFakeFs();
  seedFakeRoot(changedRoot);
  changedRoot.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const changedService = startFakeService(changedRoot);
  changedRoot.entries.get(FAKE_ROOT)!.ino += 1n; // the original root identity changed after the watch started
  changedRoot.emit("rename", REQUEST_NAME);
  assert.equal(changedRoot.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a changed root is refused");
  changedService.close();

  const partial = makeFakeFs();
  seedFakeRoot(partial);
  partial.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242), { partialRead: true });
  const partialService = startFakeService(partial);
  partial.emit("rename", REQUEST_NAME);
  assert.equal(partial.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "partial file publication cannot authorize a snapshot");
  partialService.close();
});

test("census reply service refuses changed ancestors, post-stat growth, and replacement", () => {
  const changedAncestor = makeFakeFs();
  seedFakeRoot(changedAncestor);
  changedAncestor.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const ancestorService = startFakeService(changedAncestor);
  changedAncestor.entries.get(dirname(FAKE_ROOT))!.ino += 1n; // an ancestor identity changed after the watch started
  changedAncestor.emit("rename", REQUEST_NAME);
  assert.equal(changedAncestor.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a changed ancestor directory is refused");
  ancestorService.close();

  const growth = makeFakeFs();
  seedFakeRoot(growth);
  const grownEntry = growth.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  grownEntry.growOnFstat = "x".repeat(5000); // grows past the 4096 cap between pre-stat and fstat
  const growthService = startFakeService(growth);
  growth.emit("rename", REQUEST_NAME);
  assert.equal(growth.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a request that grows after its pre-stat is refused");
  growthService.close();

  const replaced = makeFakeFs();
  seedFakeRoot(replaced);
  const originalEntry = replaced.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  originalEntry.replaceOnOpen = { kind: "file", content: validRequest(NONCE, 4242), dev: 9n, ino: 999n };
  const replacedService = startFakeService(replaced);
  replaced.emit("rename", REQUEST_NAME);
  assert.equal(replaced.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a request replaced with another identity after its pre-stat is refused");
  replacedService.close();
});

test("census reply service refuses growth, replacement, and ancestor change during the bounded read", () => {
  const growthDuringRead = makeFakeFs();
  seedFakeRoot(growthDuringRead);
  const grownEntry = growthDuringRead.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  grownEntry.growOnReadComplete = "x".repeat(5000); // grows past the cap after the complete read is served
  const growthService = startFakeService(growthDuringRead);
  growthDuringRead.emit("rename", REQUEST_NAME);
  assert.equal(growthDuringRead.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "growth between the descriptor stat and the post-read check is refused");
  growthService.close();

  const replacedAfterOpen = makeFakeFs();
  seedFakeRoot(replacedAfterOpen);
  const replacedEntry = replacedAfterOpen.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  replacedEntry.replaceOnReadComplete = { kind: "file", content: validRequest(NONCE, 4242), dev: 7n, ino: 777n };
  const replacedService = startFakeService(replacedAfterOpen);
  replacedAfterOpen.emit("rename", REQUEST_NAME);
  assert.equal(replacedAfterOpen.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a request leaf replaced after its descriptor was opened is refused");
  replacedService.close();

  let ancestorEntry: FakeEntry | undefined;
  const ancestorDuringRead = makeFakeFs({
    onReadComplete: () => { if (ancestorEntry !== undefined) ancestorEntry.ino += 1n; },
  });
  seedFakeRoot(ancestorDuringRead);
  ancestorEntry = ancestorDuringRead.entries.get(dirname(FAKE_ROOT));
  ancestorDuringRead.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const ancestorService = startFakeService(ancestorDuringRead);
  ancestorDuringRead.emit("rename", REQUEST_NAME);
  assert.equal(ancestorDuringRead.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "an ancestor identity change during the read is refused by the post-read chain check");
  ancestorService.close();
});

test("census reply service ignores other nonce-shaped request leaves", () => {
  const fake = makeFakeFs();
  seedFakeRoot(fake);
  fake.addFile(pathJoin(FAKE_ROOT, `${OTHER_NONCE}.census-request.json`), validRequest(OTHER_NONCE, 4242));
  const service = startFakeService(fake);
  fake.emit("rename", `${OTHER_NONCE}.census-request.json`);
  assert.equal(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a nonce-shaped stranger cannot consume the single serve");
  fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  fake.emit("rename", REQUEST_NAME);
  assert.ok(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), "the fixed known leaf still serves exactly once");
  service.close();
});

test("census reply service ignores unrelated events and survives snapshot failure once", () => {
  const fake = makeFakeFs();
  seedFakeRoot(fake);
  fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const service = startFakeService(fake);
  fake.emit("change", "main-result.json");
  fake.emit("rename", null);
  assert.equal(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "unrelated filenames and non-string events are ignored");
  service.close();

  const failing = makeFakeFs();
  seedFakeRoot(failing);
  failing.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const failingService = startFakeService(failing, {
    buildSnapshot: () => { throw new Error("SYNTHETIC snapshot failure"); },
  });
  failing.emit("rename", REQUEST_NAME);
  assert.equal(failing.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a failed snapshot build is an honest one-shot refusal that leaves no reply leaf");
  assert.equal(failingService.servedNonce, NONCE, "the single serve attempt is recorded");
  failing.emit("rename", REQUEST_NAME);
  assert.equal(failing.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "no retry after a failed one-shot serve");
  failingService.close();
});

test("census reply service closes its watcher when listener registration fails", () => {
  const fake = makeFakeFs({ watcherFailOnCall: 1 });
  seedFakeRoot(fake);
  const service = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => sampleSnapshot(),
    fs: fake.fs,
  });
  assert.throws(() => service.start(), /listener registration failure/);
  assert.equal(fake.watcher.closedCount, 1, "the partially registered watcher is closed exactly once");
  service.close();
  assert.equal(fake.watcher.closedCount, 1, "teardown close does not double-close");
});

test("census reply service degrades permanently and closes its watcher on a watcher error", () => {
  const fake = makeFakeFs();
  seedFakeRoot(fake);
  fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const service = startFakeService(fake);
  fake.emit("error", null);
  assert.equal(fake.watcher.closedCount, 1, "the owned watcher closes exactly once on error");
  fake.emit("rename", REQUEST_NAME);
  assert.equal(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a degraded channel never authorizes a reply");
  service.close();
  assert.equal(fake.watcher.closedCount, 1, "teardown close does not double-close");
});

test("census reply service requires a supplied retained chain to include its channel root", () => {
  const missingRoot = makeFakeFs();
  seedFakeRoot(missingRoot);
  const badChainService = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => sampleSnapshot(),
    fs: missingRoot.fs,
    rootChain: [{ path: dirname(FAKE_ROOT), dev: 1n, ino: 50n }],
  });
  assert.throws(() => badChainService.start(), /must include its channel root/,
    "a chain that omits the watched directory would leave it unvalidated");

  const empty = makeFakeFs();
  seedFakeRoot(empty);
  const emptyChainService = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => sampleSnapshot(),
    fs: empty.fs,
    rootChain: [],
  });
  assert.throws(() => emptyChainService.start(), /must include its channel root/);
});

test("census reply service refuses a chain disturbance during snapshot construction", () => {
  const fake = makeFakeFs();
  seedFakeRoot(fake);
  const rootEntry = fake.entries.get(FAKE_ROOT)!;
  const parentEntry = fake.entries.get(dirname(FAKE_ROOT))!;
  const chain = [
    { path: FAKE_ROOT, dev: rootEntry.dev, ino: rootEntry.ino },
    { path: dirname(FAKE_ROOT), dev: parentEntry.dev, ino: parentEntry.ino },
  ];
  fake.addFile(pathJoin(FAKE_ROOT, REQUEST_NAME), validRequest(NONCE, 4242));
  const service = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => {
      fake.entries.set(FAKE_ROOT, { kind: "directory", dev: 1n, ino: 999_001n }); // replaced identity mid-construction
      return sampleSnapshot();
    },
    fs: fake.fs,
    rootChain: chain,
  });
  service.start();
  fake.emit("change", REQUEST_NAME);
  assert.equal(fake.entries.get(pathJoin(FAKE_ROOT, REPLY_NAME)), undefined,
    "a mid-snapshot channel-root disturbance is an honest refusal with no reply leaf");
  service.close();
});

test("census reply service start validates the root and is single-use", () => {
  const missing = makeFakeFs();
  const service = censusFixture.createCensusReplyService({
    root: FAKE_ROOT,
    mainPid: () => 4242,
    buildSnapshot: () => sampleSnapshot(),
    fs: missing.fs,
  });
  assert.throws(() => service.start(), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    "a missing root is a start failure");

  const fake = makeFakeFs();
  seedFakeRoot(fake);
  const started = startFakeService(fake);
  assert.throws(() => started.start(), /already started/, "the single owned watch is not re-created");
  started.close();
});

test("original Main PID binding admits once and refuses drift, exit, and repeats", () => {
  const binding = new OriginalMainPidBinding();
  assert.equal(binding.admit(4242, false), 4242);
  assert.throws(() => binding.admit(4242, false), /already admitted/);
  assert.equal(binding.request(4242, false), 4242);
  assert.throws(() => binding.request(9999, false), /differs from the admitted/);
  assert.throws(() => binding.request("4242", false), /differs from the admitted/);
  assert.throws(() => binding.request(4242, true), /exit was observed/);
  const fresh = new OriginalMainPidBinding();
  assert.throws(() => fresh.admit("4242", false), /no positively admitted public PID/);
  assert.throws(() => fresh.admit(1, false), /no positively admitted public PID/);
  assert.throws(() => fresh.request(4242, false), /never admitted/);
  const exited = new OriginalMainPidBinding();
  assert.throws(() => exited.admit(4242, true), /live outer ConPTY/);
});

test("fixture reply builder and parent contract agree on the exact key set", () => {
  const reply = censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot());
  const validated = validateMainModeCensusReply(reply, { nonce: NONCE, expectedMainPid: 4242 });
  assert.ok(validated !== undefined, "the fixture-built reply validates under the parent contract");
  assert.equal(validated!.mainPid, 4242);
  assert.equal(validated!.writeCalls, 1);
  assert.equal(validated!.mouseAnySet, 1);
  assert.equal(validated!.mouseSgrSet, 1);
  assert.equal(validated!.alternateBufferSet, 1);

  const unknownSnapshot: Record<string, unknown> = {
    hookActive: true,
    sameOutputStream: true,
    observationComplete: false,
    activePane: completeActivePane(),
    nativeBinding: unestablishedNativeBinding(),
  };
  for (const field of censusFixture.CENSUS_COUNT_FIELDS) unknownSnapshot[field] = null;
  assert.ok(validateMainModeCensusReply(censusFixture.buildCensusReply(NONCE, 4242, unknownSnapshot),
    { nonce: NONCE, expectedMainPid: 4242 }) !== undefined, "a complete-unknown reply validates with all-null counts");
});

test("census reply validation is strict on keys, PID, nonce, schema, and caps", () => {
  const base = censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot());
  const expect = { nonce: NONCE, expectedMainPid: 4242 };
  assert.ok(validateMainModeCensusReply(base, expect) !== undefined);

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["extra key", { ...base, extra: 1 }],
    ["missing key", Object.fromEntries(Object.entries(base).filter(([key]) => key !== "nonce"))],
    ["wrong nonce", { ...base, nonce: OTHER_NONCE }],
    ["wrong PID", { ...base, mainPid: 9999 }],
    ["PID zero", { ...base, mainPid: 0 }],
    ["wrong schema version", { ...base, schemaVersion: 2 }],
    ["string count", { ...base, writeCalls: "1" }],
    ["negative count", { ...base, mouseSgrSet: -1 }],
    ["over-cap count", { ...base, mouseSgrSet: MAIN_CENSUS_COUNT_LIMIT + 1 }],
    ["complete with null count", { ...base, mouseSgrSet: null }],
    ["non-boolean flag", { ...base, hookActive: "true" }],
  ];
  for (const [label, value] of invalid) {
    assert.equal(validateMainModeCensusReply(value, expect), undefined, `${label} is refused`);
  }
  const incomplete = censusFixture.buildCensusReply(NONCE, 4242, (() => {
    const snapshot: Record<string, unknown> = { hookActive: true, sameOutputStream: true, observationComplete: false, activePane: completeActivePane(), nativeBinding: unestablishedNativeBinding() };
    for (const field of censusFixture.CENSUS_COUNT_FIELDS) snapshot[field] = null;
    return snapshot;
  })());
  assert.equal(validateMainModeCensusReply({ ...incomplete, writeCalls: 0 }, expect), undefined,
    "an incomplete census never carries numeric counts");
  for (const value of [null, undefined, "reply", 7, [base]]) {
    assert.equal(validateMainModeCensusReply(value, expect), undefined, "non-object replies are refused");
  }
});

test("census reply validation refuses impossible complete flags and keeps honest all-null unknowns", () => {
  const base = censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot());
  const expect = { nonce: NONCE, expectedMainPid: 4242 };
  assert.ok(validateMainModeCensusReply(base, expect) !== undefined, "complete with both flags true validates");

  assert.equal(validateMainModeCensusReply({ ...base, hookActive: false }, expect), undefined,
    "complete=true with an inactive hook is impossible");
  assert.equal(validateMainModeCensusReply({ ...base, sameOutputStream: false }, expect), undefined,
    "complete=true without the retained stream is impossible");
  assert.equal(validateMainModeCensusReply({ ...base, hookActive: false, sameOutputStream: false }, expect), undefined,
    "complete=true with both flags false is impossible");

  const unknownReply = (hookActive: boolean, sameOutputStream: boolean): Record<string, unknown> => {
    const snapshot: Record<string, unknown> = { hookActive, sameOutputStream, observationComplete: false, activePane: completeActivePane(), nativeBinding: unestablishedNativeBinding() };
    for (const field of censusFixture.CENSUS_COUNT_FIELDS) snapshot[field] = null;
    return censusFixture.buildCensusReply(NONCE, 4242, snapshot);
  };
  for (const [hookActive, sameOutputStream] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    assert.ok(validateMainModeCensusReply(unknownReply(hookActive, sameOutputStream), expect) !== undefined,
      `honest all-null unknown with hookActive=${hookActive}, sameOutputStream=${sameOutputStream} validates`);
  }
});

test("census reply validation treats the active-pane group independently of the producer scope", () => {
  const expect = { nonce: NONCE, expectedMainPid: 4242 };
  // An unknown producer scope never erases a fully known active pane.
  const producerUnknownPaneComplete = (() => {
    const snapshot: Record<string, unknown> = {
      hookActive: true, sameOutputStream: true, observationComplete: false, activePane: completeActivePane(),
      nativeBinding: unestablishedNativeBinding(),
    };
    for (const field of censusFixture.CENSUS_COUNT_FIELDS) snapshot[field] = null;
    return censusFixture.buildCensusReply(NONCE, 4242, snapshot);
  })();
  const validatedUnknownProducer = validateMainModeCensusReply(producerUnknownPaneComplete, expect);
  assert.ok(validatedUnknownProducer !== undefined, "an unknown producer with a known pane validates");
  assert.equal(validatedUnknownProducer!.writeCalls, null, "an unknown producer never borrows pane success");
  assert.equal(validatedUnknownProducer!.activePane.complete, true, "the honest pane group survives an unknown producer");
  assert.equal(validatedUnknownProducer!.activePane.ownerPresent, true);
  assert.equal(validatedUnknownProducer!.activePane.mouseTracking, 4);

  // An unknown active pane never erases a complete producer scope. A
  // positively established native binding requires the intact actual-owner
  // guard chain, so an unknown pane also unestablishes the binding group.
  const producerCompletePaneUnknown = sampleSnapshot();
  producerCompletePaneUnknown.activePane = unknownActivePane(null, null);
  producerCompletePaneUnknown.nativeBinding = unestablishedNativeBinding();
  const validatedUnknownPane = validateMainModeCensusReply(
    censusFixture.buildCensusReply(NONCE, 4242, producerCompletePaneUnknown), expect);
  assert.ok(validatedUnknownPane !== undefined, "a complete producer with an unknown pane validates");
  assert.equal(validatedUnknownPane!.observationComplete, true);
  assert.equal(validatedUnknownPane!.writeCalls, 1, "honest producer counts survive an unknown pane");
  assert.equal(validatedUnknownPane!.activePane.scope, null);
  assert.equal(validatedUnknownPane!.activePane.complete, null);
  assert.equal(validatedUnknownPane!.nativeBinding.scope, null, "an unknown pane never carries a known native binding");

  // A coherent partial-but-unknown pane group is accepted alongside known counts.
  const partialPane = sampleSnapshot();
  partialPane.activePane = unknownActivePane(true, false);
  partialPane.nativeBinding = unestablishedNativeBinding();
  const validatedPartial = validateMainModeCensusReply(censusFixture.buildCensusReply(NONCE, 4242, partialPane), expect);
  assert.ok(validatedPartial !== undefined, "an intact scope with unknown fields stays a valid honest partial observation");
  assert.equal(validatedPartial!.activePane.scope, true);
  assert.equal(validatedPartial!.activePane.complete, false);

  // A complete native binding alongside a disturbed owner guard chain is refused.
  const bindingWithoutOwner = sampleSnapshot();
  bindingWithoutOwner.activePane = { ...completeActivePane(), hasLiveProcess: false };
  assert.equal(validateMainModeCensusReply(
    censusFixture.buildCensusReply(NONCE, 4242, bindingWithoutOwner), expect), undefined,
    "a known native binding requires the intact actual-owner guard chain");
});

test("active-pane validation rejects inconsistent flags, enums, geometry, and impossible field combinations", () => {
  assert.ok(validateMainActivePaneSnapshot(completeActivePane()) !== undefined, "the known coherent group validates");
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["extra key", { ...completeActivePane(), extra: 1 }],
    ["missing key", Object.fromEntries(Object.entries(completeActivePane()).filter(([key]) => key !== "scope"))],
    ["complete true with a null scope", unknownActivePane(null, true)],
    ["null scope with a false complete", unknownActivePane(null, false)],
    ["complete true with a null field", { ...completeActivePane(), ownerPresent: null }],
    ["intact scope marked incomplete while fully known", { ...completeActivePane(), complete: false }],
    ["disturbed scope marked complete", { ...unknownActivePane(false, false), complete: true }],
    ["unknown tracking enum", { ...completeActivePane(), mouseTracking: 5 }],
    ["unknown encoding enum", { ...completeActivePane(), mouseEncoding: 3 }],
    ["non-integer geometry", { ...completeActivePane(), geometryColumns: 1.5 }],
    ["over-cap geometry", { ...completeActivePane(), geometryRows: MAIN_PANE_GEOMETRY_LIMIT + 1 }],
    ["negative geometry", { ...completeActivePane(), geometryColumns: -1 }],
    ["failed mode read carrying a mode value", { ...completeActivePane(), modesReadSucceeded: false }],
    ["absent surface carrying a mode read", { ...completeActivePane(), surfacePresent: false }],
    ["not-live row carrying a surface", { ...completeActivePane(), hasLiveProcess: false }],
    ["unmatched view carrying a live pane", { ...completeActivePane(), viewMatched: false }],
    ["non-boolean flag", { ...completeActivePane(), scope: "true" }],
    ["absent owner carrying a matched live pane", { ...completeActivePane(), ownerPresent: false }],
    ["disturbed scope carrying known pane data", { ...completeActivePane(), scope: false, complete: false }],
    ["unknown scope carrying known pane data", { ...completeActivePane(), scope: null, complete: null }],
    ["unknown owner carrying a matched view", { ...completeActivePane(), ownerPresent: null }],
    ["null view carrying liveness", { ...completeActivePane(), viewMatched: null }],
    ["unknown scope carrying mode evidence", { ...unknownActivePane(true, false), mouseTracking: 1 }],
    ["unknown owner carrying a live surface", { ...completeActivePane(), ownerPresent: null, viewMatched: null }],
    ["disturbed scope carrying geometry", { ...unknownActivePane(false, false), geometryColumns: 80 }],
    ["unestablished scope carrying geometry", { ...unknownActivePane(null, null), geometryRows: 24 }],
    ["unknown owner carrying geometry", { ...unknownActivePane(true, false), geometryColumns: 80 }],
    ["absent surface carrying geometry", { ...completeActivePane(), surfacePresent: false, geometryRows: 24 }],
    ["not-live row carrying geometry", { ...completeActivePane(), hasLiveProcess: false, geometryColumns: 80 }],
  ];
  for (const [label, pane] of invalid) {
    assert.equal(validateMainActivePaneSnapshot(pane), undefined, `${label} is refused`);
  }
  for (const value of [null, undefined, "pane", 7, []]) {
    assert.equal(validateMainActivePaneSnapshot(value), undefined, "a non-object active-pane group is refused");
  }
  // Honest partial unknowns and an off-main focus observation stay valid.
  const valid: Array<[string, Record<string, unknown>]> = [
    ["off-main focus with a known owner", { ...completeActivePane(), focusMain: false }],
    ["live surface with numeric geometry", { ...completeActivePane(), geometryColumns: 80, geometryRows: 24 }],
    ["known owner with no matching row", {
      ...completeActivePane(), complete: false, viewMatched: false, hasLiveProcess: false, lifecycleAlive: false,
      surfacePresent: false, modesReadSucceeded: false, mouseTracking: null, mouseEncoding: null,
    }],
    ["matched live owner with an unreadable surface", {
      ...completeActivePane(), complete: false, surfacePresent: false, modesReadSucceeded: false,
      mouseTracking: null, mouseEncoding: null,
    }],
    ["matched live surface with unknown modes", {
      ...completeActivePane(), complete: false, mouseTracking: null, mouseEncoding: null,
    }],
    ["honest intact-scope partial unknown", unknownActivePane(true, false)],
    ["disturbed all-null unknown", unknownActivePane(false, false)],
    ["unestablished all-null unknown", unknownActivePane(null, null)],
  ];
  for (const [label, pane] of valid) {
    assert.ok(validateMainActivePaneSnapshot(pane) !== undefined, `${label} is accepted`);
  }
});

test("native-binding validation enforces exact keys, pair coherence, and proof implications", () => {
  assert.ok(validateMainNativeBindingSnapshot(completeNativeBinding()) !== undefined, "the known coherent group validates");
  assert.ok(validateMainNativeBindingSnapshot(unestablishedNativeBinding()) !== undefined, "the unestablished all-null group validates");
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["extra key", { ...completeNativeBinding(), extra: 1 }],
    ["missing key", Object.fromEntries(Object.entries(completeNativeBinding()).filter(([key]) => key !== "scope"))],
    ["pid without incarnation", { ...completeNativeBinding(), incarnation: null }],
    ["incarnation without pid", { ...completeNativeBinding(), ptyPid: null }],
    ["epoch without proof", { ...completeNativeBinding(), expectedProof: null }],
    ["proof without its full tuple", { ...completeNativeBinding(), ptyPid: null, incarnation: null }],
    ["epoch/proof pair without PID inputs", { scope: true, complete: false, ptyPid: null, incarnation: null, sessionEpoch: 1, expectedProof: "a".repeat(64) }],
    ["zero epoch", { ...completeNativeBinding(), sessionEpoch: 0 }],
    ["epoch zero is never a binding", { scope: true, complete: false, ptyPid: 4243, incarnation: 1, sessionEpoch: 0, expectedProof: null }],
    ["malformed proof", { ...completeNativeBinding(), expectedProof: "z".repeat(64) }],
    ["non-string proof", { ...completeNativeBinding(), expectedProof: 123 }],
    ["raw session id is not a wire field", { ...completeNativeBinding(), sessionId: "native-session-id-1" }],
    ["non-integer pid", { ...completeNativeBinding(), ptyPid: 4.5 }],
    ["pid one", { ...completeNativeBinding(), ptyPid: 1 }],
    ["incarnation zero", { ...completeNativeBinding(), incarnation: 0 }],
    ["null scope carrying data", { ...completeNativeBinding(), scope: null, complete: true }],
    ["scope false with data", { ...completeNativeBinding(), scope: false, complete: true }],
    ["complete mismatch", { ...completeNativeBinding(), complete: false }],
    ["non-boolean scope", { ...completeNativeBinding(), scope: "true" }],
  ];
  for (const [label, value] of invalid) {
    assert.equal(validateMainNativeBindingSnapshot(value), undefined, `${label} is refused`);
  }
  // An attempted-but-unresolved binding (scope true, all-null fields) stays valid.
  const attemptedUnknown = { scope: true, complete: false, ptyPid: null, incarnation: null, sessionEpoch: null, expectedProof: null };
  assert.ok(validateMainNativeBindingSnapshot(attemptedUnknown) !== undefined, "an attempted unknown binding validates");
});

test("census diagnostic reports the bounded active-pane group without raw data", () => {
  const validated = validateMainModeCensusReply(censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot()),
    { nonce: NONCE, expectedMainPid: 4242 })!;
  const line = formatMainCensusDiagnostic(validated);
  assert.ok(line.includes("activePane{complete=true scope=true owner=true"), "the known pane flags are disclosed");
  assert.ok(line.includes("tracking=4 encoding=1"), "the known pane modes are disclosed as bounded enums");
  assert.ok(line.includes("geomCols=null geomRows=null}"), "absent public geometry stays explicit null");
  assert.ok(line.length < 1_024, "the extended diagnostic line stays bounded");

  const unknownPane = (() => {
    const snapshot: Record<string, unknown> = {
      hookActive: true, sameOutputStream: true, observationComplete: false, activePane: unknownActivePane(null, null),
      nativeBinding: unestablishedNativeBinding(),
    };
    for (const field of censusFixture.CENSUS_COUNT_FIELDS) snapshot[field] = null;
    return snapshot;
  })();
  const unknownLine = formatMainCensusDiagnostic(validateMainModeCensusReply(
    censusFixture.buildCensusReply(NONCE, 4242, unknownPane), { nonce: NONCE, expectedMainPid: 4242 })!);
  assert.ok(unknownLine.includes("activePane{complete=null scope=null owner=null"),
    "an unknown pane reports explicit nulls, never a guessed value");
});

/**
 * The structural surface of the driver that assertBeforeQuitModes touches.
 * A prototype-only fake (no constructor, no PTY, no filesystem) exercises the
 * real pre-Quit assertion path with a retained census.
 */
interface FakeCensusDriver {
  surface: { flush(): Promise<void>; inputModes(): TerminalInputModes };
  modeWitnesses: { readonly representatives: readonly TerminalInputModes[]; record(modes: TerminalInputModes): void };
  parserError?: Error;
  sawAlternateEnter: boolean;
  sawAlternateLeave: boolean;
  mainCensus?: MainModeCensusSnapshot;
  outputTail: string;
  replyLog: string[];
  assertBeforeQuitModes(): Promise<void>;
}

function makeFakeCensusDriver(modes: TerminalInputModes, census: MainModeCensusSnapshot | undefined): FakeCensusDriver {
  const fake = Object.create(WindowsMainPtyDriver.prototype) as unknown as FakeCensusDriver;
  fake.surface = { flush: async () => {}, inputModes: () => modes };
  fake.modeWitnesses = { representatives: [modes], record: () => {} };
  fake.parserError = undefined;
  fake.sawAlternateEnter = false;
  fake.sawAlternateLeave = false;
  fake.mainCensus = census;
  fake.outputTail = "";
  fake.replyLog = ["\x1b[?1;2c", "\x1b[?0u"];
  return fake;
}

test("alternate-buffer failure preserves the retained census diagnostic", async () => {
  const modes: TerminalInputModes = {
    kittyFlags: 0,
    applicationCursorKeys: true, // non-baseline keyboard observed
    applicationKeypad: false,
    bracketedPaste: true, // bracketed paste observed
    mouseTracking: "any", // tracking active with SGR encoding
    modifyOtherKeys: 0,
    mouseEncoding: "sgr",
  };
  const census = validateMainModeCensusReply(
    censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot()),
    { nonce: NONCE, expectedMainPid: 4242 },
  );
  assert.ok(census !== undefined, "the retained census validates under the parent contract");
  const fake = makeFakeCensusDriver(modes, census);
  let failure: unknown;
  try {
    await fake.assertBeforeQuitModes();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "the missing alternate-screen entry fails the pre-Quit assertions");
  assert.match(failure.message, /actual Main output entered the outer VT alternate buffer/);
  assert.ok(failure.message.includes("mainCensusDiag"), "the retained producer census survives the failure");
  assert.ok(failure.message.includes("sgrSet=1"), "the SGR request count is preserved in the diagnostic");
  assert.ok(failure.message.includes("anySet=1"), "the tracking request count is preserved in the diagnostic");
});

test("a failing outer-VT assertion keeps complete producer counts alongside an unknown pane", async () => {
  const modes: TerminalInputModes = {
    kittyFlags: 0,
    applicationCursorKeys: true,
    applicationKeypad: false,
    bracketedPaste: true,
    mouseTracking: "any",
    modifyOtherKeys: 0,
    mouseEncoding: "sgr",
  };
  const reply = sampleSnapshot();
  reply.activePane = unknownActivePane(true, false);
  reply.nativeBinding = unestablishedNativeBinding();
  const census = validateMainModeCensusReply(censusFixture.buildCensusReply(NONCE, 4242, reply),
    { nonce: NONCE, expectedMainPid: 4242 });
  assert.ok(census !== undefined, "complete producer counts with a coherent unknown pane still validate");
  assert.equal(census!.observationComplete, true);
  assert.equal(census!.activePane.complete, false);
  const fake = makeFakeCensusDriver(modes, census);
  let failure: unknown;
  try {
    await fake.assertBeforeQuitModes();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "the missing alternate-screen entry still fails the genuine VT assertions");
  assert.match(failure.message, /actual Main output entered the outer VT alternate buffer/);
  assert.ok(failure.message.includes("mainCensusDiag"), "the diagnostic survives the failure");
  assert.ok(failure.message.includes("calls=1"), "complete producer counts remain available");
  assert.ok(failure.message.includes("sgrSet=1"), "the SGR request count remains available");
  assert.ok(failure.message.includes("activePane{complete=false scope=true"),
    "the unknown pane is disclosed without erasing the producer evidence");
  assert.ok(failure.message.includes("owner=null"), "the unknown pane reports null, never a guessed owner");
});

test("census diagnostic is bounded, metadata-only, and free of raw output", () => {
  assert.equal(formatMainCensusDiagnostic(undefined), "mainCensusDiag{absent}");
  const validated = validateMainModeCensusReply(censusFixture.buildCensusReply(NONCE, 4242, sampleSnapshot()),
    { nonce: NONCE, expectedMainPid: 4242 })!;
  const line = formatMainCensusDiagnostic(validated);
  assert.match(line, /^mainCensusDiag\{[a-zA-Z0-9= ,{}]+\}$/, "only bounded numeric/boolean tokens are emitted");
  assert.ok(line.includes("complete=true"));
  assert.ok(line.includes("hookActive=true"));
  assert.ok(line.includes("sameStream=true"));
  assert.ok(line.includes("pid=4242"));
  assert.ok(line.includes("sgrSet=1"));
  assert.ok(line.length < 1_024, "the diagnostic line stays bounded");

  const unknownSnapshot: Record<string, unknown> = {
    hookActive: false,
    sameOutputStream: true,
    observationComplete: false,
    activePane: completeActivePane(),
    nativeBinding: unestablishedNativeBinding(),
  };
  for (const field of censusFixture.CENSUS_COUNT_FIELDS) unknownSnapshot[field] = null;
  const unknownLine = formatMainCensusDiagnostic(validateMainModeCensusReply(
    censusFixture.buildCensusReply(NONCE, 4242, unknownSnapshot), { nonce: NONCE, expectedMainPid: 4242 }) as MainModeCensusSnapshot);
  assert.ok(unknownLine.includes("complete=false"));
  assert.ok(unknownLine.includes("hookActive=false"));
  assert.ok(unknownLine.includes("calls=null"), "unknown state is disclosed as null, never zero");
});
