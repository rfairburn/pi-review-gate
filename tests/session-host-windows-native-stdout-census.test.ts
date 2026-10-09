/**
 * Pure regression tests for the fresh native-child original-stdout census:
 * the bounded HMAC private proof (shared tuple only — incarnation excluded),
 * the strict request/reply payload contracts, the ONE strict readonly sticky
 * validator that accepts a FRESH sticky object carrying the identical
 * original bootstrap tuple while refusing foreign tuples, getters, and
 * present-but-invalid fields, the inert-by-default activation gates of the
 * test preload (including snapshot-time rechecks), one correlated
 * request/reply through fixed exclusive per-PID leaves driven by injected
 * fake IO with exact-once watcher closure, the immutable module-default
 * census ownership versus pure factory closures (default-vs-factory and
 * cached-only observer retention regressions), the PTY observer's private
 * binding lookup regressions, and the parent-side correlation + bounded
 * metadata-only diagnostic.
 *
 * No actual filesystem, process, PTY, or Windows runtime is touched: the CJS
 * fixtures are required directly as pure modules (or sliced into a fresh
 * context) and driven with fakes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import test from "node:test";
import { types } from "node:util";
import { createContext, runInContext, runInNewContext } from "node:vm";

import {
  NATIVE_CENSUS_COUNT_LIMIT,
  NATIVE_CENSUS_REPLY_FILENAME,
  NATIVE_CENSUS_REQUEST_FILENAME,
  NATIVE_CENSUS_SCHEMA_VERSION,
  formatNativeCensusDiagnostic,
  validateNativeCensusCorrelation,
  validateNativeCensusReply,
} from "./helpers/session-host-windows-native-stdout-census-contract";
import {
  validateMainNativeBindingSnapshot,
  type MainNativeBindingSnapshot,
} from "./helpers/session-host-windows-stdout-census-contract";

const nativeFixture = require("../../tests/fixtures/session-host-windows-native-stdout-census.cjs") as {
  NATIVE_CENSUS_SCHEMA_VERSION: number;
  NATIVE_CENSUS_REQUEST_FILENAME: string;
  NATIVE_CENSUS_REPLY_FILENAME: string;
  isNativeCensusRequestPayload(payload: unknown): boolean;
  buildNativeCensusReply(nonce: string, nativePid: number, snapshot: Record<string, unknown>): Record<string, unknown>;
  computeNativeCensusProof(fields: Record<string, unknown>): string | undefined;
  isNativeProof(value: unknown): boolean;
  isBoundedNonce(value: unknown): boolean;
  isValidNativeSessionIdValue(value: unknown): boolean;
};

const preloadFixture = require("../../tests/fixtures/session-host-windows-native-stdout-census-preload.cjs") as {
  ROOT_ENV: string;
  CANDIDATE_ENTRY_ENV: string;
  ROLE_ENV: string;
  validateStickyState(
    globalScope: object,
    stickyKey: symbol,
    protocol: Record<string, unknown>,
    reporter: Record<string, unknown>,
    originalBootstrap: Record<string, unknown> | undefined,
    env: Record<string, string | undefined>,
  ): { readonly sessionEpoch: number; readonly nativeSessionId?: string; readonly bootstrap: Record<string, unknown> } | undefined;
  captureRootChain(root: string, fsLike: object): Array<{ path: string; dev: bigint; ino: bigint }> | undefined;
  rootChainUnchanged(chain: Array<{ path: string; dev: bigint; ino: bigint }>, fsLike: object): boolean;
  activateNativeCensusPreload(options?: Record<string, unknown>): {
    installed: boolean;
    close?: () => boolean;
    service?: { start(): void; close(): void; readonly servedNonce: string | undefined };
    censusHandle?: { snapshot(): Record<string, unknown>; restore(): boolean };
    directory?: string;
  };
  closeOwnedNativeCensus(): boolean;
};

const STICKY_KEY_NAME = "pi-review-gate.session-host.state.v1";
const STICKY_KEY = Symbol.for(STICKY_KEY_NAME);
const NONCE = "0123456789abcdef01234567";
const OTHER_NONCE = "fedcba9876543210fedcba98";
/** The Main census nonce under which the expected proof is computed. */
const PROOF_NONCE = "proofnonce0123456789ab";
const RAW_SESSION_ID = "native-session-id-1";

/** A valid consumed bootstrap tuple (the only bootstrap the census ever knows). */
const BOOTSTRAP = {
  version: 1,
  socketPath: "/tmp/fake-native-socket",
  token: "ab".repeat(32),
  instanceId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  generation: "0ffeeddccbba99887766554433221100",
};

function fakeParseBootstrap(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return undefined;
  for (const field of ["socketPath", "token", "instanceId", "generation"]) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) return undefined;
  }
  return { ...BOOTSTRAP, ...value };
}

const fakeProtocol: Record<string, unknown> = {
  parseBootstrap: fakeParseBootstrap,
  isValidNativeSessionId: (value: unknown): boolean => nativeFixture.isValidNativeSessionIdValue(value),
};
const fakeReporter: Record<string, unknown> = { SESSION_HOST_STICKY_STATE_KEY: STICKY_KEY };

function primedSticky(): Record<string, unknown> {
  // Genuine startup state: consumed bootstrap, reporter fallback epoch 0, no session id.
  return { bootstrap: { ...BOOTSTRAP }, sequence: 0, sessionEpoch: 0 };
}

function authenticatedSticky(sessionId = RAW_SESSION_ID, sessionEpoch = 1): Record<string, unknown> {
  // A FRESH object (new identity) carrying the identical consumed tuple.
  return { bootstrap: { ...BOOTSTRAP }, sequence: 3, sessionEpoch, nativeSessionId: sessionId };
}

test("native proof is a bounded HMAC over the shared tuple only, with incarnation excluded", () => {
  const fields = {
    bootstrap: BOOTSTRAP,
    sessionId: RAW_SESSION_ID,
    sessionEpoch: 1,
    nonce: NONCE,
    pid: 4243,
  };
  const proof = nativeFixture.computeNativeCensusProof(fields);
  assert.ok(nativeFixture.isNativeProof(proof), "the proof is an opaque 64-hex digest");
  assert.equal(proof, nativeFixture.computeNativeCensusProof({ ...fields }), "the proof is deterministic");

  // The incarnation is NOT part of the proof: it never changes the digest.
  assert.equal(nativeFixture.computeNativeCensusProof({ ...fields, incarnation: 7 }), proof,
    "the parent-side incarnation cross-binding is independent of the shared proof");

  for (const [label, changed] of [
    ["nonce", { ...fields, nonce: OTHER_NONCE }],
    ["pid", { ...fields, pid: 4244 }],
    ["sessionEpoch", { ...fields, sessionEpoch: 2 }],
    ["sessionId", { ...fields, sessionId: "native-session-id-2" }],
    ["token", { ...fields, bootstrap: { ...BOOTSTRAP, token: "cd".repeat(32) } }],
    ["instanceId", { ...fields, bootstrap: { ...BOOTSTRAP, instanceId: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" } }],
    ["generation", { ...fields, bootstrap: { ...BOOTSTRAP, generation: "1ffeeddccbba99887766554433221100" } }],
  ] as const) {
    assert.notEqual(nativeFixture.computeNativeCensusProof(changed), proof, `${label} changes the proof`);
  }

  for (const [label, invalid] of [
    ["epoch zero", { ...fields, sessionEpoch: 0 }],
    ["negative epoch", { ...fields, sessionEpoch: -1 }],
    ["pid one", { ...fields, pid: 1 }],
    ["non-integer pid", { ...fields, pid: 4.5 }],
    ["path-like session id", { ...fields, sessionId: "a/b" }],
    ["control-char session id", { ...fields, sessionId: "a\u0000b" }],
    ["over-long session id", { ...fields, sessionId: "x".repeat(257) }],
    ["bad token", { ...fields, bootstrap: { ...BOOTSTRAP, token: "z".repeat(64) } }],
    ["missing nonce", Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "nonce"))],
  ] as const) {
    assert.equal(nativeFixture.computeNativeCensusProof(invalid), undefined, `${label} is refused`);
  }
});

test("native request payload validation is strict on keys, schema, nonces, and PID", () => {
  const valid = { schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 };
  assert.equal(nativeFixture.isNativeCensusRequestPayload(valid), true);
  for (const [label, value] of [
    ["extra key", { ...valid, extra: 1 }],
    ["missing key", Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "nonce"))],
    ["missing proofNonce", Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "proofNonce"))],
    ["wrong schema", { ...valid, schemaVersion: 2 }],
    ["short nonce", { ...valid, nonce: "abc" }],
    ["bad nonce char", { ...valid, nonce: "0123456789abcdef0123456!" }],
    ["short proofNonce", { ...valid, proofNonce: "abc" }],
    ["pid one", { ...valid, expectedNativePid: 1 }],
    ["non-integer pid", { ...valid, expectedNativePid: 4.5 }],
    ["array payload", [valid]],
    ["null payload", null],
  ] as const) {
    assert.equal(nativeFixture.isNativeCensusRequestPayload(value), false, `${label} is refused`);
  }
});

test("native reply builder and parent contract agree on the exact key set", () => {
  const snapshot: Record<string, unknown> = {
    hookActive: true,
    sameOutputStream: true,
    observationComplete: true,
    writeCalls: 2,
    mouseX10Set: 0, mouseX10Reset: 0,
    mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0,
    mouseAnySet: 1, mouseAnyReset: 0,
    mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 1, alternateBufferReset: 0,
    bracketedPasteSet: 1, bracketedPasteReset: 0,
    bindingScope: true,
    sessionEpoch: 1,
    proof: nativeFixture.computeNativeCensusProof({
      bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243,
    }),
  };
  const reply = nativeFixture.buildNativeCensusReply(NONCE, 4243, snapshot);
  const validated = validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(validated !== undefined, "the fixture-built reply validates under the parent contract");
  assert.equal(validated!.nativePid, 4243);
  assert.equal(validated!.writeCalls, 2);
  assert.equal(validated!.mouseAnySet, 1);

  const unknownSnapshot: Record<string, unknown> = {
    hookActive: true,
    sameOutputStream: true,
    observationComplete: false,
    bindingScope: false,
    sessionEpoch: null,
    proof: null,
  };
  for (const field of [
    "writeCalls",
    "mouseX10Set", "mouseX10Reset",
    "mouseVt200Set", "mouseVt200Reset",
    "mouseDragSet", "mouseDragReset",
    "mouseAnySet", "mouseAnyReset",
    "mouseSgrSet", "mouseSgrReset",
    "alternateBufferSet", "alternateBufferReset",
    "bracketedPasteSet", "bracketedPasteReset",
  ]) unknownSnapshot[field] = null;
  const unknownReply = nativeFixture.buildNativeCensusReply(NONCE, 4243, unknownSnapshot);
  assert.ok(validateNativeCensusReply(unknownReply, { nonce: NONCE, expectedNativePid: 4243 }) !== undefined,
    "an honest all-null unknown reply validates");
});

test("the raw native session id never appears in serialized census payloads", () => {
  const proof = nativeFixture.computeNativeCensusProof({
    bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243,
  })!;
  // Native reply: the id is bound only through the opaque proof.
  const nativeReply = nativeFixture.buildNativeCensusReply(NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1, proof,
  });
  assert.ok(!JSON.stringify(nativeReply).includes(RAW_SESSION_ID), "the native reply carries no raw session id");

  // Main reply native-binding group: the id is bound only through the opaque proof.
  const binding = validateMainNativeBindingSnapshot({
    scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: proof,
  })!;
  assert.ok(!JSON.stringify(binding).includes(RAW_SESSION_ID), "the Main binding group carries no raw session id");

  // The native request never carried the id either.
  const request = { schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 };
  assert.ok(!JSON.stringify(request).includes(RAW_SESSION_ID), "the native request carries no raw session id");
});

test("validateStickyState accepts a fresh object with the identical consumed tuple and refuses foreign state", () => {
  const read = (sticky: unknown, original?: Record<string, unknown>): ReturnType<typeof preloadFixture.validateStickyState> => {
    const scope: Record<symbol, unknown> = {};
    Object.defineProperty(scope, STICKY_KEY, { value: sticky, writable: true, configurable: true });
    return preloadFixture.validateStickyState(scope, STICKY_KEY, fakeProtocol, fakeReporter, original ?? BOOTSTRAP, {});
  };

  // Genuine startup: primed epoch 0 / id undefined is a valid view, not a binding.
  const primed = read(primedSticky());
  assert.equal(primed?.sessionEpoch, 0);
  assert.equal(primed?.nativeSessionId, undefined);
  assert.deepEqual(primed?.bootstrap, BOOTSTRAP, "the validator returns the parsed original tuple");

  // A FRESH object (new identity) with the identical tuple validates.
  const fresh = read(authenticatedSticky());
  assert.equal(fresh?.sessionEpoch, 1);
  assert.equal(fresh?.nativeSessionId, RAW_SESSION_ID, "a fresh readonly snapshot with the identical consumed tuple is valid");

  // Foreign tuples are refused, never adopted.
  for (const [label, changed] of [
    ["instanceId", { ...BOOTSTRAP, instanceId: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" }],
    ["generation", { ...BOOTSTRAP, generation: "1ffeeddccbba99887766554433221100" }],
    ["socketPath", { ...BOOTSTRAP, socketPath: "/tmp/other-socket" }],
    ["token", { ...BOOTSTRAP, token: "cd".repeat(32) }],
    ["version", { ...BOOTSTRAP, version: 2 }],
  ] as const) {
    assert.equal(read({ bootstrap: changed, sequence: 1, sessionEpoch: 1, nativeSessionId: "id-1" }), undefined,
      `a foreign ${label} is unknown`);
  }

  // Invalid strict fields are refused.
  for (const [label, sticky] of [
    ["negative epoch", { bootstrap: BOOTSTRAP, sequence: 1, sessionEpoch: -1 }],
    ["non-integer epoch", { bootstrap: BOOTSTRAP, sequence: 1, sessionEpoch: 1.5 }],
    ["missing epoch", { bootstrap: BOOTSTRAP, sequence: 1 }],
    ["negative sequence", { bootstrap: BOOTSTRAP, sequence: -1, sessionEpoch: 1 }],
    ["non-integer sequence", { bootstrap: BOOTSTRAP, sequence: "1", sessionEpoch: 1 }],
    ["missing sequence", { bootstrap: BOOTSTRAP, sessionEpoch: 1 }],
    ["array sticky", [BOOTSTRAP]],
    ["null sticky", null],
  ] as const) {
    assert.equal(read(sticky), undefined, `${label} is refused`);
  }

  // A present-but-invalid nativeSessionId refuses the WHOLE state — it is
  // never normalized to unknown.
  for (const [label, invalidId] of [
    ["path-like", "a/b"],
    ["control char", "a\u0000b"],
    ["over-long", "x".repeat(257)],
    ["empty", ""],
  ] as const) {
    assert.equal(read({ bootstrap: BOOTSTRAP, sequence: 1, sessionEpoch: 1, nativeSessionId: invalidId }), undefined,
      `a present-but-invalid session id (${label}) is refused, never normalized`);
  }

  // A getter property on the sticky object is refused without being invoked.
  let getterCalls = 0;
  const getterScope: Record<symbol, unknown> = {};
  Object.defineProperty(getterScope, STICKY_KEY, {
    get: () => { getterCalls += 1; return primedSticky(); },
    configurable: true,
  });
  assert.equal(preloadFixture.validateStickyState(getterScope, STICKY_KEY, fakeProtocol, fakeReporter, BOOTSTRAP, {}), undefined,
    "a getter/shadowed property is refused");
  assert.equal(getterCalls, 0, "the sticky getter is never invoked");

  // An accessor FIELD on the sticky object is refused without being invoked.
  let fieldGetterCalls = 0;
  const fieldGetterSticky: Record<string, unknown> = { ...primedSticky() };
  Object.defineProperty(fieldGetterSticky, "sessionEpoch", {
    get: () => { fieldGetterCalls += 1; return 1; },
    configurable: true,
  });
  assert.equal(read(fieldGetterSticky), undefined, "an accessor field is refused");
  assert.equal(fieldGetterCalls, 0, "the field getter is never invoked");

  // An absent property is unknown.
  assert.equal(preloadFixture.validateStickyState({}, STICKY_KEY, fakeProtocol, fakeReporter, BOOTSTRAP, {}), undefined);

  // A throwing validator is contained.
  const throwingScope: Record<symbol, unknown> = {};
  Object.defineProperty(throwingScope, STICKY_KEY, { value: primedSticky(), writable: true, configurable: true });
  assert.equal(preloadFixture.validateStickyState(throwingScope, STICKY_KEY,
    { parseBootstrap: () => { throw new Error("SYNTHETIC"); }, isValidNativeSessionId: () => true },
    fakeReporter, BOOTSTRAP, {}), undefined, "a throwing validator is contained");

  // A changed module identity (reporter key or protocol scope) is unknown.
  assert.equal(preloadFixture.validateStickyState(throwingScope, STICKY_KEY, fakeProtocol,
    { SESSION_HOST_STICKY_STATE_KEY: Symbol("other") }, BOOTSTRAP, {}), undefined, "a changed reporter key is unknown");
  assert.equal(preloadFixture.validateStickyState(throwingScope, STICKY_KEY,
    { parseBootstrap: fakeParseBootstrap }, fakeReporter, BOOTSTRAP, {}), undefined, "a missing protocol validator is unknown");

  // A changed role ceiling is unknown.
  assert.equal(preloadFixture.validateStickyState(throwingScope, STICKY_KEY, fakeProtocol, fakeReporter, BOOTSTRAP,
    { [preloadFixture.ROLE_ENV]: "executor" }), undefined, "the executor role ceiling is rechecked");
});

test("sticky validator refuses bootstrap-field getters and proxies without invoking them", () => {
  const read = (sticky: unknown): ReturnType<typeof preloadFixture.validateStickyState> => {
    const scope: Record<symbol, unknown> = {};
    Object.defineProperty(scope, STICKY_KEY, { value: sticky, writable: true, configurable: true });
    return preloadFixture.validateStickyState(scope, STICKY_KEY, fakeProtocol, fakeReporter, BOOTSTRAP, {});
  };

  // A bootstrap-field getter is refused WITHOUT being invoked: the bootstrap
  // is parsed from a descriptor-derived plain copy only.
  let bootstrapGetterCalls = 0;
  const getterBootstrap: Record<string, unknown> = { ...BOOTSTRAP };
  Object.defineProperty(getterBootstrap, "token", {
    get: () => { bootstrapGetterCalls += 1; return BOOTSTRAP.token; },
    configurable: true,
  });
  assert.equal(read({ bootstrap: getterBootstrap, sequence: 1, sessionEpoch: 1 }), undefined,
    "a bootstrap-field getter is refused");
  assert.equal(bootstrapGetterCalls, 0, "the bootstrap getter is never invoked");

  // A proxy sticky object is refused before any descriptor operation runs.
  let trapCalls = 0;
  const proxySticky = new Proxy(primedSticky(), {
    getOwnPropertyDescriptor(target, prop) {
      trapCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  assert.equal(read(proxySticky), undefined, "a proxy sticky object is refused");
  assert.equal(trapCalls, 0, "no proxy trap runs during validation");

  // A proxy global scope is refused the same way.
  let scopeTrapCalls = 0;
  const proxyScope = new Proxy({} as Record<symbol, unknown>, {
    getOwnPropertyDescriptor() { scopeTrapCalls += 1; return undefined; },
  });
  assert.equal(preloadFixture.validateStickyState(proxyScope, STICKY_KEY, fakeProtocol, fakeReporter, BOOTSTRAP, {}),
    undefined, "a proxy global scope is refused");
  assert.equal(scopeTrapCalls, 0, "no scope proxy trap runs during validation");

  // A non-standard data attribute on a sticky field is refused.
  const attrSticky: Record<string, unknown> = { ...primedSticky() };
  Object.defineProperty(attrSticky, "sessionEpoch", { value: 1, writable: false, enumerable: true, configurable: true });
  assert.equal(read(attrSticky), undefined, "a non-writable field attribute is refused");
});

interface FakeFile { content: string; dev: bigint; ino: bigint; }

/** Path map with consistently normalized keys so POSIX-form test literals and the fixtures' native path.join results address the same entry on every platform. */
class FakePathMap<T> extends Map<string, T> {
  override set(path: string, value: T): this {
    return super.set(normalize(path), value);
  }
  override get(path: string): T | undefined {
    return super.get(normalize(path));
  }
  override has(path: string): boolean {
    return super.has(normalize(path));
  }
}

function makeFakeFs() {
  const dirs = new FakePathMap<{ dev: bigint; ino: bigint; symlink?: boolean }>();
  const files = new FakePathMap<FakeFile>();
  let nextIno = 100n;
  const addDir = (p: string): void => { dirs.set(p, { dev: 1n, ino: nextIno++ }); };
  const watcherHandlers: Record<string, (eventType: string, filename: string | null) => void> = {};
  let closedCount = 0;
  const watcher = {
    on(event: string, handler: (eventType: string, filename: string | null) => void): unknown {
      watcherHandlers[event] = handler;
      return watcher;
    },
    close(): void { closedCount += 1; },
  };
  let nextFd = 0;
  const fdToPath = new Map<number, string>();

  function errno(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
  }

  function statsOf(p: string) {
    const dir = dirs.get(p);
    if (dir !== undefined) {
      return { dev: dir.dev, ino: dir.ino, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => dir.symlink === true };
    }
    const file = files.get(p);
    if (file !== undefined) {
      return {
        dev: file.dev, ino: file.ino, size: BigInt(Buffer.byteLength(file.content, "utf8")),
        isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
      };
    }
    throw errno("ENOENT", `fake ENOENT ${p}`);
  }

  const fsLike = {
    lstatSync(p: string): unknown { return statsOf(p); },
    mkdirSync(p: string): void {
      if (dirs.has(p) || files.has(p)) throw errno("EEXIST", `fake EEXIST ${p}`);
      addDir(p);
    },
    openSync(p: string, flags: string): number {
      if (flags === "r") {
        if (!files.has(p)) throw errno("ENOENT", `fake ENOENT ${p}`);
        nextFd += 1;
        fdToPath.set(nextFd, p);
        return nextFd;
      }
      if (flags === "wx") {
        if (files.has(p)) throw errno("EEXIST", `fake EEXIST ${p}`);
        files.set(p, { content: "", dev: 1n, ino: nextIno++ });
        nextFd += 1;
        fdToPath.set(nextFd, p);
        return nextFd;
      }
      throw new Error(`fake unsupported flags ${flags}`);
    },
    fstatSync(fd: number): unknown { return statsOf(fdToPath.get(fd)!); },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number {
      const bytes = Buffer.from(files.get(fdToPath.get(fd)!)!.content, "utf8");
      const available = Math.min(length, bytes.length - position);
      if (available <= 0) return 0;
      bytes.copy(buffer, offset, position, position + available);
      return available;
    },
    closeSync(fd: number): void { fdToPath.delete(fd); },
    writeSync(fd: number, data: string): number {
      const p = fdToPath.get(fd)!;
      files.set(p, { ...files.get(p)!, content: files.get(p)!.content + data });
      return Buffer.byteLength(data, "utf8");
    },
    watch(): unknown { return watcher; },
  };
  return {
    fsLike,
    files,
    dirs,
    addDir,
    closedCount: () => closedCount,
    fire: (event: string, filename: string): void => { watcherHandlers[event]?.(event, filename); },
  };
}

function makeActivation(options: {
  readonly sticky?: unknown;
  readonly preexistingChildDir?: boolean;
  readonly envOverrides?: Record<string, string | undefined>;
  readonly fake?: ReturnType<typeof makeFakeFs>;
  readonly onExit?: (handler: () => void) => void;
  readonly reporter?: unknown;
} = {}) {
  const fake = options.fake ?? makeFakeFs();
  fake.addDir("/");
  fake.addDir("/tmp");
  fake.addDir("/tmp/fake-native-root");
  fake.files.set("/pkg/dist/src/session-host/protocol.js", { content: "", dev: 1n, ino: 200n });
  fake.files.set("/pkg/dist/src/session-host/reporter.js", { content: "", dev: 1n, ino: 201n });
  if (options.preexistingChildDir) fake.addDir("/tmp/fake-native-root/native-4243");

  const writeCalls: unknown[][] = [];
  const originalWrite = function fakeWrite(...args: unknown[]): string {
    writeCalls.push(args);
    return "SYNTHETIC-accept";
  };
  const stdout: Record<string, unknown> = {};
  Object.defineProperty(stdout, "write", { value: originalWrite, writable: true, configurable: true, enumerable: false });

  const exitHandlers: Array<() => void> = [];
  const env: Record<string, string | undefined> = {
    [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root",
    [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js",
    ...(options.envOverrides ?? {}),
  };
  const globalScope: Record<symbol, unknown> = {};
  Object.defineProperty(globalScope, STICKY_KEY, { value: options.sticky === undefined ? primedSticky() : options.sticky, writable: true, configurable: true });

  const requireModule = (request: string): unknown => {
    if (request.endsWith("protocol.js")) return fakeProtocol;
    return options.reporter === undefined ? fakeReporter : options.reporter;
  };

  const result = preloadFixture.activateNativeCensusPreload({
    env,
    fs: fake.fsLike,
    requireModule,
    globalScope,
    stdout,
    stdoutIdentity: () => stdout,
    pid: 4243,
    onExit: options.onExit ?? ((handler: () => void) => { exitHandlers.push(handler); }),
  });
  return { fake, result, stdout, originalWrite, writeCalls, exitHandlers, globalScope, env };
}

const preloadFixtureSource = readFileSync(
  resolve(__dirname, "../../tests/fixtures/session-host-windows-native-stdout-census-preload.cjs"), "utf8");
const stdoutCensusFixture = require("../../tests/fixtures/session-host-windows-stdout-census.cjs") as Record<string, unknown>;

/** Seeds a fake filesystem with the staged census root and candidate entry leaves. */
function seedNativeCensusFs(fake: ReturnType<typeof makeFakeFs>): void {
  fake.addDir("/");
  fake.addDir("/tmp");
  fake.addDir("/tmp/fake-native-root");
  fake.files.set("/pkg/dist/src/session-host/protocol.js", { content: "", dev: 1n, ino: 200n });
  fake.files.set("/pkg/dist/src/session-host/reporter.js", { content: "", dev: 1n, ino: 201n });
}

/**
 * Explicit-injection options for a pure factory activation on a fresh fake:
 * the factory path never claims the module-default ownership.
 */
function makeFactoryOptions(fake: ReturnType<typeof makeFakeFs>): {
  readonly options: Record<string, unknown>;
  readonly stdout: Record<string, unknown>;
  readonly exitHandlers: Array<() => void>;
} {
  const stdout: Record<string, unknown> = {};
  Object.defineProperty(stdout, "write", {
    value: function factoryWrite(): string { return "SYNTHETIC-factory"; },
    writable: true, configurable: true, enumerable: false,
  });
  const globalScope: Record<symbol, unknown> = {};
  Object.defineProperty(globalScope, STICKY_KEY, { value: primedSticky(), writable: true, configurable: true });
  const exitHandlers: Array<() => void> = [];
  return {
    stdout,
    exitHandlers,
    options: {
      env: {
        [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root",
        [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js",
      },
      fs: fake.fsLike,
      requireModule: (request: string) => (request.endsWith("protocol.js") ? fakeProtocol : fakeReporter),
      globalScope,
      stdout,
      stdoutIdentity: () => stdout,
      pid: 4243,
      onExit: (handler: () => void) => { exitHandlers.push(handler); },
    },
  };
}

interface FreshPreloadFixture {
  readonly exports: {
    activateNativeCensusPreload(options?: Record<string, unknown>): {
      installed: boolean;
      close?: () => boolean;
      service?: { start(): void; close(): void; readonly servedNonce: string | undefined };
      censusHandle?: { snapshot(): Record<string, unknown>; restore(): boolean };
      directory?: string;
    };
    closeOwnedNativeCensus(): boolean;
  };
  readonly fake: ReturnType<typeof makeFakeFs>;
  readonly stdout: Record<string, unknown>;
  readonly exitHandlers: Array<() => void>;
}

/**
 * Loads an INDEPENDENT instance of the real preload fixture in a fresh context
 * with fake filesystem, environment, stdout, PID, exit hook, and sticky
 * global, so its genuine module-bottom autoactivation installs a live
 * default-owned census watcher without touching any real process, PTY, or
 * filesystem. Each call gets its own module-default ownership, so
 * default-versus-factory closure semantics can be exercised in isolation.
 */
function loadFreshPreloadFixture(): FreshPreloadFixture {
  const fake = makeFakeFs();
  seedNativeCensusFs(fake);

  const originalWrite = function freshDefaultWrite(): string { return "SYNTHETIC-accept"; };
  const stdout: Record<string, unknown> = {};
  Object.defineProperty(stdout, "write", { value: originalWrite, writable: true, configurable: true, enumerable: false });

  const env: Record<string, string | undefined> = {
    [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root",
    [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js",
  };
  const exitHandlers: Array<() => void> = [];
  const requireMock = (request: string): unknown => {
    if (request === "node:fs") return fake.fsLike;
    if (request === "node:path") return require("node:path");
    if (request === "node:util") return { types };
    if (request === "./session-host-windows-stdout-census.cjs") return stdoutCensusFixture;
    if (request === "./session-host-windows-native-stdout-census.cjs") return nativeFixture;
    if (request.endsWith("protocol.js")) return fakeProtocol;
    if (request.endsWith("reporter.js")) return fakeReporter;
    throw new Error(`SYNTHETIC unexpected require: ${request}`);
  };
  const processStub = {
    env,
    pid: 4243,
    stdout,
    on(event: string, handler: () => void): void { if (event === "exit") exitHandlers.push(handler); },
  };
  const moduleStub: { exports: unknown } = { exports: {} };
  const sandbox: Record<string, unknown> = {
    require: requireMock,
    process: processStub,
    module: moduleStub,
    exports: moduleStub.exports,
    setInterval: () => ({ unref: () => {} }),
  };
  const context = createContext(sandbox);
  // Define the sticky tuple INSIDE the fresh context's own globalThis so the
  // module-bottom autoactivation reads a genuine own data property through its
  // strict descriptor validator, independent of host-side sandbox proxying.
  runInContext(
    `Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(STICKY_KEY_NAME)}), `
    + `{ value: ${JSON.stringify(primedSticky())}, writable: true, configurable: true });`,
    context);
  runInContext(preloadFixtureSource, context);
  return {
    exports: moduleStub.exports as FreshPreloadFixture["exports"],
    fake,
    stdout,
    exitHandlers,
  };
}

test("preload activation is inert for every unsupported gate", () => {
  const cases: Array<[string, () => { installed: boolean }]> = [
    ["executor role", () => makeActivation({ envOverrides: { [preloadFixture.ROLE_ENV]: "executor" } }).result],
    ["missing staged root", () => makeActivation({ envOverrides: { [preloadFixture.ROOT_ENV]: undefined } }).result],
    ["relative staged root", () => makeActivation({ envOverrides: { [preloadFixture.ROOT_ENV]: "relative-root" } }).result],
    ["missing candidate entry", () => makeActivation({ envOverrides: { [preloadFixture.CANDIDATE_ENTRY_ENV]: undefined } }).result],
    ["primed sticky missing bootstrap", () => makeActivation({ sticky: { sequence: 0, sessionEpoch: 0 } }).result],
    ["sticky missing sequence", () => makeActivation({ sticky: { bootstrap: { ...BOOTSTRAP }, sessionEpoch: 0 } }).result],
    ["sticky with negative epoch", () => makeActivation({ sticky: { bootstrap: { ...BOOTSTRAP }, sequence: 0, sessionEpoch: -1 } }).result],
    ["sticky with invalid session id", () => makeActivation({ sticky: { bootstrap: { ...BOOTSTRAP }, sequence: 0, sessionEpoch: 1, nativeSessionId: "a/b" } }).result],
    ["array sticky", () => makeActivation({ sticky: [BOOTSTRAP] }).result],
    ["pid one", () => {
      const made = makeActivation();
      return preloadFixture.activateNativeCensusPreload({
        env: { [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root", [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js" },
        fs: made.fake.fsLike, requireModule: (r: string) => r.endsWith("protocol.js") ? fakeProtocol : fakeReporter,
        globalScope: made.globalScope, stdout: made.stdout, pid: 1, onExit: () => {},
      });
    }],
    ["stdout without callable write", () => {
      const made = makeActivation();
      return preloadFixture.activateNativeCensusPreload({
        env: { [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root", [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js" },
        fs: made.fake.fsLike, requireModule: (r: string) => r.endsWith("protocol.js") ? fakeProtocol : fakeReporter,
        globalScope: made.globalScope, stdout: {}, pid: 4243, onExit: () => {},
      });
    }],
  ];
  for (const [label, run] of cases) {
    assert.equal(run().installed, false, `${label} stays inert`);
  }

  // A getter sticky is refused without being invoked.
  let getterCalls = 0;
  const getterScope: Record<symbol, unknown> = {};
  Object.defineProperty(getterScope, STICKY_KEY, {
    get: () => { getterCalls += 1; return primedSticky(); },
    configurable: true,
  });
  const made = makeActivation();
  const getterResult = preloadFixture.activateNativeCensusPreload({
    env: { [preloadFixture.ROOT_ENV]: "/tmp/fake-native-root", [preloadFixture.CANDIDATE_ENTRY_ENV]: "/pkg/dist/src/index.js" },
    fs: made.fake.fsLike, requireModule: (r: string) => r.endsWith("protocol.js") ? fakeProtocol : fakeReporter,
    globalScope: getterScope, stdout: made.stdout, pid: 4243, onExit: () => {},
  });
  assert.equal(getterResult.installed, false, "a getter sticky stays inert");
  assert.equal(getterCalls, 0, "the sticky getter is never invoked");

  // A pre-existing per-PID child directory is refused and the census hook is unwound.
  const existing = makeActivation({ preexistingChildDir: true });
  assert.equal(existing.result.installed, false, "a pre-existing child directory is refused, never reused");
  assert.equal(existing.stdout.write, existing.originalWrite, "the census hook is restored on refusal");
});

test("a genuine function-shaped reporter export admits activation and serves one correlated reply", () => {
  // The real compiled reporter exports a CALLABLE (module.exports = activate)
  // with the sticky key assigned as an own data property; admission must not
  // refuse that shape before native activation.
  let reporterCalls = 0;
  const callableReporter = Object.assign(
    function syntheticActivate(): void { reporterCalls += 1; },
    { SESSION_HOST_STICKY_STATE_KEY: STICKY_KEY });
  const made = makeActivation({ reporter: callableReporter });
  assert.equal(made.result.installed, true, "the genuine callable reporter export admits native census activation");

  // One fresh correlated reply through the existing fake root/stdout and the
  // current sticky consumed-bootstrap tuple.
  (made.stdout.write as (data: unknown) => unknown).call(made.stdout, Buffer.from("\x1b[?1049h"));
  Object.defineProperty(made.globalScope, STICKY_KEY, { value: authenticatedSticky(), writable: true, configurable: true });
  const requestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  made.fake.files.set(requestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 400n });
  made.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  const reply = JSON.parse(made.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
  const validated = validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(validated !== undefined, "the served reply validates under the parent contract");
  assert.equal(validated!.bindingScope, true);
  assert.equal(validated!.sessionEpoch, 1);
  const expectedProof = nativeFixture.computeNativeCensusProof({
    bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: PROOF_NONCE, pid: 4243,
  });
  assert.equal(validated!.proof, expectedProof, "the fresh private proof matches the shared-tuple HMAC under the Main census nonce");
  assert.ok(expectedProof !== undefined, "the supported fixture tuple computes its expected proof");
  assert.ok(validateNativeCensusCorrelation(reply, {
    nonce: NONCE,
    expectedNativePid: 4243,
    binding: { scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof },
  }) !== undefined, "the callable-export reply correlates against the Main binding contract");
  assert.equal(validated!.observationComplete, true);
  assert.equal(validated!.alternateBufferSet, 1, "the retained stream observation remains complete");
  assert.equal(reporterCalls, 0, "descriptor admission never invokes the reporter function");
  assert.equal(made.fake.closedCount(), 1, "the served reply closes its owned watcher exactly once");
});

test("a callable proxy reporter is refused before any descriptor trap and an accessor sticky key is never invoked", () => {
  // A proxy wrapping a function-shaped reporter is refused BEFORE any
  // descriptor operation runs (no get/apply/getOwnPropertyDescriptor trap).
  let trapCalls = 0;
  const proxyReporter = new Proxy(function syntheticActivate(): void { /* never invoked */ }, {
    get() { trapCalls += 1; return undefined; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    apply() { trapCalls += 1; return undefined; },
  });
  const proxied = makeActivation({ reporter: proxyReporter });
  assert.equal(proxied.result.installed, false, "a callable proxy reporter stays inert");
  assert.equal(trapCalls, 0, "no proxy trap runs during reporter admission");

  // A function-shaped reporter whose sticky key is an ACCESSOR is refused
  // without invoking the getter.
  let getterCalls = 0;
  const accessorReporter = function syntheticActivate(): void { /* never invoked */ };
  Object.defineProperty(accessorReporter, "SESSION_HOST_STICKY_STATE_KEY", {
    get: () => { getterCalls += 1; return STICKY_KEY; },
    configurable: true,
  });
  const accessor = makeActivation({ reporter: accessorReporter });
  assert.equal(accessor.result.installed, false, "a function-shaped accessor sticky key stays inert");
  assert.equal(getterCalls, 0, "the sticky-key getter is never invoked");
});

test("preload root chain capture and revalidation are exact", () => {
  const fake = makeFakeFs();
  fake.addDir("/");
  fake.addDir("/tmp");
  fake.addDir("/tmp/fake-native-root");
  const chain = preloadFixture.captureRootChain(normalize("/tmp/fake-native-root"), fake.fsLike);
  assert.ok(chain !== undefined, "a valid root captures its ancestor chain");
  assert.deepEqual(chain!.map((entry) => entry.path), [normalize("/tmp/fake-native-root"), normalize("/tmp"), normalize("/")],
    "the chain runs from the root to the filesystem top");
  assert.equal(preloadFixture.rootChainUnchanged(chain!, fake.fsLike), true, "an untouched chain is unchanged");

  // A replaced ancestor directory identity is detected.
  const tmpEntry = chain!.find((entry) => entry.path === normalize("/tmp"))!;
  fake.dirs.set("/tmp", { dev: 1n, ino: 999_999n });
  assert.equal(preloadFixture.rootChainUnchanged(chain!, fake.fsLike), false, "a changed ancestor identity is detected");

  // A missing root or a file root captures nothing.
  assert.equal(preloadFixture.captureRootChain("/tmp/absent", fake.fsLike), undefined, "a missing root is unknown");
  fake.files.set("/tmp/afile", { content: "", dev: 1n, ino: 500n });
  assert.equal(preloadFixture.captureRootChain("/tmp/afile", fake.fsLike), undefined, "a file root is unknown");
});

test("preload activation installs the census and serves exactly one correlated reply with exact-once closure", () => {
  const { fake, result, stdout, exitHandlers, globalScope } = makeActivation();
  assert.equal(result.installed, true, "a valid consumed sticky bootstrap activates the test observer");
  assert.equal(result.directory, normalize("/tmp/fake-native-root/native-4243"));

  // The census hook is installed on the retained stream before any SDK/TUI write.
  (stdout.write as (data: unknown) => unknown).call(stdout, Buffer.from("\x1b[?1003;1006h"));
  assert.equal(result.censusHandle!.snapshot().writeCalls, 1);

  // The genuine startup transition: a FRESH sticky object with the identical
  // consumed tuple and an authenticated session (epoch 1 / id known).
  Object.defineProperty(globalScope, STICKY_KEY, { value: authenticatedSticky(), writable: true, configurable: true });

  const requestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  fake.files.set(requestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 300n });
  fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);

  const replyPath = "/tmp/fake-native-root/native-4243/native-census-reply.json";
  const replyEntry = fake.files.get(replyPath);
  assert.ok(replyEntry !== undefined, "exactly one exclusive reply leaf is written");
  const reply = JSON.parse(replyEntry!.content) as Record<string, unknown>;
  const validated = validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(validated !== undefined, "the served reply validates under the parent contract");
  assert.equal(validated!.nativePid, 4243);
  assert.equal(validated!.writeCalls, 1);
  assert.equal(validated!.mouseAnySet, 1);
  assert.equal(validated!.mouseSgrSet, 1);
  assert.equal(validated!.bindingScope, true);
  assert.equal(validated!.sessionEpoch, 1);
  const expectedProof = nativeFixture.computeNativeCensusProof({
    bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: PROOF_NONCE, pid: 4243,
  });
  assert.equal(validated!.proof, expectedProof, "the fresh private proof matches the shared-tuple HMAC under the Main census nonce");

  // Exact-once closure: the single served reply closes the owned watcher
  // immediately (no unref, polling, or force), so a never-requested child is
  // the only case that relies on the process-exit path.
  assert.equal(fake.closedCount(), 1, "the served publication closes the owned watcher exactly once");

  // One-shot: a second request never consumes another serve (and the closed
  // watcher no longer observes it).
  fake.files.set(requestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: OTHER_NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 301n });
  fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  assert.equal(fake.files.get(replyPath), replyEntry, "the single served reply is never rewritten");
  assert.equal(result.service!.servedNonce, NONCE);

  // The exit handler close is an exact-once no-op after the serve closure.
  const closedBefore = fake.closedCount();
  for (const handler of exitHandlers) handler();
  assert.equal(fake.closedCount(), closedBefore, "the process-exit path never closes twice");

  // A wrong-PID request is refused before the first serve; the watcher stays
  // open until the authorized process-exit path.
  const second = makeActivation();
  assert.equal(second.result.installed, true);
  const wrongRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  second.fake.files.set(wrongRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 9999 }), dev: 1n, ino: 302n });
  second.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  assert.equal(second.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json"), undefined,
    "a wrong-PID request is an honest refusal");
  assert.equal(second.fake.closedCount(), 0, "a never-served child keeps its watcher open until the exit path");
  for (const handler of second.exitHandlers) handler();
  assert.equal(second.fake.closedCount(), 1, "the process-exit path closes a never-served child's watcher exactly once");

  // A terminal failed publication (pre-existing reply leaf) also closes the
  // owned watcher exactly once and leaves the foreign leaf untouched.
  const third = makeActivation();
  assert.equal(third.result.installed, true);
  const thirdReplyPath = "/tmp/fake-native-root/native-4243/native-census-reply.json";
  third.fake.files.set(thirdReplyPath, { content: "SYNTHETIC foreign reply", dev: 1n, ino: 305n });
  third.fake.files.set("/tmp/fake-native-root/native-4243/native-census-request.json",
    { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 306n });
  third.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  assert.equal(third.fake.files.get(thirdReplyPath)!.content, "SYNTHETIC foreign reply",
    "a terminal failed publication never truncates or replaces the foreign leaf");
  assert.equal(third.fake.closedCount(), 1, "a terminal failed publication closes the owned watcher exactly once");
});

test("preload snapshot-time rechecks refuse a changed role ceiling or module identity", () => {
  const { fake, result, stdout, globalScope, env } = makeActivation();
  assert.equal(result.installed, true);
  (stdout.write as (data: unknown) => unknown).call(stdout, Buffer.from("\x1b[?1049h"));

  // A role-ceiling change AFTER activation is refused at snapshot time.
  env[preloadFixture.ROLE_ENV] = "executor";
  const requestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  fake.files.set(requestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 307n });
  fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  const reply = JSON.parse(fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
  const validated = validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(validated !== undefined);
  assert.equal(validated!.bindingScope, false, "a changed role ceiling is binding scope unknown at snapshot time");
  assert.equal(validated!.sessionEpoch, null);
  assert.equal(validated!.proof, null);
  assert.equal(validated!.alternateBufferSet, 1, "honest counts survive the snapshot-time refusal");
});

test("preload snapshot-time rechecks refuse changed global attributes and callable replacement", () => {
  // A changed global slot attribute after activation is refused at snapshot time.
  const attr = makeActivation();
  assert.equal(attr.result.installed, true);
  (attr.stdout.write as (data: unknown) => unknown).call(attr.stdout, Buffer.from("\x1b[?1049h"));
  Object.defineProperty(attr.globalScope, STICKY_KEY, { value: authenticatedSticky(), writable: false, configurable: true });
  const attrRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  attr.fake.files.set(attrRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 308n });
  attr.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  const attrReply = JSON.parse(attr.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
  const attrValidated = validateNativeCensusReply(attrReply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(attrValidated !== undefined);
  assert.equal(attrValidated!.bindingScope, false, "a changed global slot attribute is binding scope unknown at snapshot time");
  assert.equal(attrValidated!.alternateBufferSet, 1, "honest counts survive the descriptor-scope refusal");

  // Replacing a protocol validator with another callable is refused at snapshot time.
  const repl = makeActivation();
  assert.equal(repl.result.installed, true);
  (repl.stdout.write as (data: unknown) => unknown).call(repl.stdout, Buffer.from("\x1b[?1049h"));
  const originalParse = fakeProtocol.parseBootstrap;
  try {
    fakeProtocol.parseBootstrap = () => BOOTSTRAP;
    const replRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
    repl.fake.files.set(replRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 309n });
    repl.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
    const replReply = JSON.parse(repl.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
    const replValidated = validateNativeCensusReply(replReply, { nonce: NONCE, expectedNativePid: 4243 });
    assert.ok(replValidated !== undefined);
    assert.equal(replValidated!.bindingScope, false, "a replaced protocol validator is binding scope unknown at snapshot time");
    assert.equal(replValidated!.alternateBufferSet, 1, "honest counts survive the callable replacement refusal");
  } finally {
    fakeProtocol.parseBootstrap = originalParse;
  }
});

test("preload refuses a replaced or symlinked child directory after activation", () => {
  // A replaced child directory identity is detected by the retained channel chain.
  const replaced = makeActivation();
  assert.equal(replaced.result.installed, true);
  (replaced.stdout.write as (data: unknown) => unknown).call(replaced.stdout, Buffer.from("\x1b[?1049h"));
  replaced.fake.dirs.set("/tmp/fake-native-root/native-4243", { dev: 1n, ino: 999_998n });
  const replacedRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  replaced.fake.files.set(replacedRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 310n });
  replaced.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  assert.equal(replaced.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json"), undefined,
    "a replaced child directory is an honest refusal with no reply leaf");

  // A symlinked child directory is refused the same way.
  const symlinked = makeActivation();
  assert.equal(symlinked.result.installed, true);
  (symlinked.stdout.write as (data: unknown) => unknown).call(symlinked.stdout, Buffer.from("\x1b[?1049h"));
  symlinked.fake.dirs.set("/tmp/fake-native-root/native-4243", { dev: 1n, ino: 999_997n, symlink: true });
  const symlinkRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  symlinked.fake.files.set(symlinkRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 311n });
  symlinked.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  assert.equal(symlinked.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json"), undefined,
    "a symlinked child directory is an honest refusal with no reply leaf");
});

test("preload activation serves an unknown binding scope without erasing honest counts", () => {
  const { fake, result, stdout, globalScope } = makeActivation();
  assert.equal(result.installed, true);
  (stdout.write as (data: unknown) => unknown).call(stdout, Buffer.from("\x1b[?1049h"));

  // A foreign tuple in a fresh sticky object is unknown scope, not adoption.
  Object.defineProperty(globalScope, STICKY_KEY, {
    value: { bootstrap: { ...BOOTSTRAP, instanceId: "b1b2c3d4-e5f6-7890-abcd-ef1234567890" }, sequence: 1, sessionEpoch: 1, nativeSessionId: "id-1" },
    writable: true, configurable: true,
  });
  const requestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  fake.files.set(requestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 303n });
  fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  const reply = JSON.parse(fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
  const validated = validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(validated !== undefined);
  assert.equal(validated!.bindingScope, false, "a foreign current tuple is binding scope unknown");
  assert.equal(validated!.sessionEpoch, null);
  assert.equal(validated!.proof, null);
  assert.equal(validated!.writeCalls, 1, "honest counts survive an unknown binding scope");
  assert.equal(validated!.alternateBufferSet, 1);

  // The primed epoch-0 / id-undefined state is not a binding and never converts to zero.
  const second = makeActivation();
  (second.stdout.write as (data: unknown) => unknown).call(second.stdout, Buffer.from("\x1b[?2004h"));
  const secondRequestPath = "/tmp/fake-native-root/native-4243/native-census-request.json";
  second.fake.files.set(secondRequestPath, { content: JSON.stringify({ schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION, nonce: NONCE, proofNonce: PROOF_NONCE, expectedNativePid: 4243 }), dev: 1n, ino: 304n });
  second.fake.fire("change", NATIVE_CENSUS_REQUEST_FILENAME);
  const secondReply = JSON.parse(second.fake.files.get("/tmp/fake-native-root/native-4243/native-census-reply.json")!.content) as Record<string, unknown>;
  const secondValidated = validateNativeCensusReply(secondReply, { nonce: NONCE, expectedNativePid: 4243 });
  assert.ok(secondValidated !== undefined);
  assert.equal(secondValidated!.bindingScope, true, "the primed consumed tuple is a positively validated scope");
  assert.equal(secondValidated!.sessionEpoch, null, "the primed epoch 0 is never published as a binding");
  assert.equal(secondValidated!.proof, null);
  assert.equal(secondValidated!.bracketedPasteSet, 1);
});

// ---------------------------------------------------------------------------
// Owned native census closure + genuine public session_shutdown observer
// regressions (pure fakes; no real process, PTY, filesystem, or Windows).
// ---------------------------------------------------------------------------

test("a pure factory activation is closed only by its own narrow closure, never by the module default", () => {
  // The host module autoactivated at require time with the census gates
  // absent, so its immutable module-default ownership is inert. A pure factory
  // activation must never become the public default target.
  const made = makeActivation();
  assert.equal(made.result.installed, true, "a never-requested child activates the census");
  assert.equal(made.fake.closedCount(), 0, "no closure occurs before an explicit shutdown");
  const hookBefore = made.stdout.write;
  const stickyBefore = made.globalScope[STICKY_KEY];
  const dirsBefore = made.fake.dirs.size;

  assert.equal(preloadFixture.closeOwnedNativeCensus(), false, "the inert module default owns nothing");
  assert.equal(made.fake.closedCount(), 0, "the module default closer never closes a factory watcher");

  assert.equal(made.result.close!(), true, "the factory's own closure closes its exact service");
  assert.equal(made.fake.closedCount(), 1, "the exact owned watcher is closed exactly once");
  assert.equal(made.stdout.write, hookBefore, "the owned stdout forwarder is preserved");
  assert.equal(made.globalScope[STICKY_KEY], stickyBefore, "the sticky registry is never mutated");
  assert.equal(made.fake.dirs.size, dirsBefore, "closure creates no directory or watcher");

  assert.equal(made.result.close!(), true, "repeated factory closure is still reported as owned");
  assert.equal(made.fake.closedCount(), 1, "repeated factory closure is exactly-once");
});

test("a pure factory activation preserves foreign activations and foreign stream slots", () => {
  const foreignFake = makeFakeFs();
  const foreign = makeActivation({ fake: foreignFake });
  assert.equal(foreign.result.installed, true);
  const owned = makeActivation();
  assert.equal(owned.result.installed, true);

  const foreignWrite = function foreignWrite(): string { return "SYNTHETIC-foreign"; };
  Object.defineProperty(owned.stdout, "write", { value: foreignWrite, writable: true, configurable: true, enumerable: false });

  assert.equal(owned.result.close!(), true);
  assert.equal(owned.fake.closedCount(), 1, "only the owned watcher is closed");
  assert.equal(owned.stdout.write, foreignWrite, "a foreign write slot replacement is never clobbered");
  assert.equal(foreignFake.closedCount(), 0, "a foreign activation's watcher is never touched");

  assert.equal(foreign.result.close!(), true, "the foreign factory result closes its own watcher");
  assert.equal(foreignFake.closedCount(), 1);
  assert.equal(owned.fake.closedCount(), 1, "closing a foreign result never re-closes the other owned watcher");

  // The module default closer still owns nothing and touches neither factory.
  assert.equal(preloadFixture.closeOwnedNativeCensus(), false);
  assert.equal(owned.fake.closedCount(), 1);
  assert.equal(foreignFake.closedCount(), 1);
});

test("the module default original watcher survives later inert, factory, and duplicate activation and is the sole public closure target", () => {
  const fresh = loadFreshPreloadFixture();
  // The genuine module-bottom autoactivation installed this instance's
  // immutable default-owned watcher.
  assert.equal(fresh.fake.closedCount(), 0, "the default-owned watcher is retained");
  const defaultHook = fresh.stdout.write;

  // A later INERT factory activation must not steal, lose, or replace the
  // default ownership.
  const inert = fresh.exports.activateNativeCensusPreload({ env: {} });
  assert.equal(inert.installed, false, "the inert factory activation stays inert");
  assert.equal(inert.close!(), false, "an inert factory result owns no service");
  assert.equal(fresh.fake.closedCount(), 0, "the inert factory activation never replaces the default owner");

  // A later LIVE factory activation gets its own watcher and its own narrow
  // closer, not the module default ownership.
  const factoryFake = makeFakeFs();
  seedNativeCensusFs(factoryFake);
  const factory = makeFactoryOptions(factoryFake);
  const factoryActivation = fresh.exports.activateNativeCensusPreload(factory.options);
  assert.equal(factoryActivation.installed, true, "the later factory activation installs its own census");
  assert.equal(fresh.fake.closedCount(), 0, "the live factory activation never touches the default watcher");
  assert.equal(factoryFake.closedCount(), 0, "the factory watcher is retained until its own closure");

  // A duplicate no-argument default call reuses the one immutable default
  // owner instead of installing a second watcher.
  const defaultOwner = fresh.exports.activateNativeCensusPreload();
  assert.equal(defaultOwner.installed, true);
  assert.equal(fresh.exports.activateNativeCensusPreload(), defaultOwner, "duplicate default activation reuses the immutable owner");
  assert.equal(fresh.fake.closedCount(), 0, "duplicate default activation installs no second watcher");

  // The public default closer closes ONLY the original module-default watcher.
  assert.equal(fresh.exports.closeOwnedNativeCensus(), true, "the default owner closes");
  assert.equal(fresh.fake.closedCount(), 1, "exactly the original default watcher closes");
  assert.equal(factoryFake.closedCount(), 0, "the later factory watcher is never closed by the default closer");
  assert.equal(fresh.stdout.write, defaultHook, "the default owned stdout forwarder is preserved");

  // Idempotent across repeated shutdown, the process-exit fallback, and later
  // factory closure.
  assert.equal(fresh.exports.closeOwnedNativeCensus(), true, "repeated default closure is still reported as owned");
  assert.equal(fresh.fake.closedCount(), 1, "repeated default closure is exactly-once");
  for (const handler of fresh.exitHandlers) handler();
  assert.equal(fresh.fake.closedCount(), 1, "the process-exit fallback never closes twice");
  assert.equal(fresh.exports.closeOwnedNativeCensus(), true);
  assert.equal(fresh.fake.closedCount(), 1);
  assert.equal(factoryActivation.close!(), true, "the factory's own closure still closes its own watcher");
  assert.equal(factoryFake.closedCount(), 1);
  assert.equal(fresh.fake.closedCount(), 1, "factory closure never touches the default watcher");
});

test("the module default closer is privately retained and survives returned-activation and service mutation", () => {
  let foreignCalls = 0;
  const fresh = loadFreshPreloadFixture();
  const owner = fresh.exports.activateNativeCensusPreload();
  assert.equal(owner.installed, true);
  const originalService = owner.service!;
  assert.equal(typeof originalService.close, "function");

  // After the default owner was claimed and returned, replace BOTH the
  // returned activation's service slot and the original service's own close
  // slot with foreign closers.
  owner.service = { start: () => {}, close: () => { foreignCalls += 1; }, servedNonce: undefined };
  originalService.close = () => { foreignCalls += 1; };

  // The process-exit fallback runs BEFORE public closure and must use the
  // exact retained owner closer, never the replacement close slot.
  for (const handler of fresh.exitHandlers) handler();
  assert.equal(fresh.fake.closedCount(), 1, "exit closes the original watcher despite service mutation");
  assert.equal(foreignCalls, 0, "exit never invokes the replacement close slot");

  assert.equal(fresh.exports.closeOwnedNativeCensus(), true, "the privately retained closer still closes");
  assert.equal(fresh.fake.closedCount(), 1, "the original default-owned watcher closes exactly once");
  assert.equal(foreignCalls, 0, "activation/service mutation never redirects public shutdown close");
  assert.equal(fresh.exports.closeOwnedNativeCensus(), true);
  assert.equal(fresh.fake.closedCount(), 1, "repeated default closure stays exactly-once after mutation");

  // Exit AFTER public closure remains an exact-once no-op and never invokes
  // the replacement close slot.
  for (const handler of fresh.exitHandlers) handler();
  assert.equal(fresh.fake.closedCount(), 1, "exit after public closure remains exactly-once");
  assert.equal(foreignCalls, 0);
});

test("preload activation unwinds exact owned resources when the exit registration fails", () => {
  const made = makeActivation({ onExit: () => { throw new Error("SYNTHETIC exit registration failure"); } });
  assert.equal(made.result.installed, false, "a failed exit registration stays inert");
  assert.equal(made.fake.closedCount(), 1, "the partially installed watcher is closed exactly once");
  assert.equal(made.stdout.write, made.originalWrite, "the owned stdout hook is restored on the inert unwind");
  assert.equal(preloadFixture.closeOwnedNativeCensus(), false, "nothing remains owned after the inert unwind");
});

const observerSource = readFileSync(resolve(__dirname, "../../tests/fixtures/session-host-main-observer.cjs"), "utf8");

/** Canonical resolved key the observer's exact cache lookup must use. */
const OBSERVER_PRELOAD_KEY = "/canonical/session-host-windows-native-stdout-census-preload.cjs";
const OBSERVER_PRELOAD_ID = "./session-host-windows-native-stdout-census-preload.cjs";

interface MainObserverHarness {
  readonly records: Array<Record<string, unknown>>;
  readonly stdout: { write: unknown };
  preloadResolves(): number;
  preloadEvaluations(): number;
  closeCalls(): number;
  setCloseImplementation(implementation: () => void): void;
  setCachedExports(exports: unknown): void;
  shutdown(event: Record<string, unknown>): unknown;
}

/**
 * Loads the real session_shutdown observer fixture in a fresh context with a
 * fake filesystem, process, and module cache, so its genuine callback wiring
 * is exercised without a real process or filesystem. `uncached: true` models a
 * preload that was never loaded: the exact canonical cache entry is absent,
 * and any evaluation of the module (which would autoactivate a census) is
 * recorded by `preloadEvaluations`.
 */
function loadMainObserver(options: {
  readonly loadedModule?: unknown;
  readonly cacheEntry?: unknown;
  readonly uncached?: boolean;
  readonly moduleFactory?: () => Record<string, unknown>;
  readonly resolveThrows?: boolean;
  readonly envOverrides?: Record<string, string>;
  readonly stdout?: { write: unknown; columns?: number; rows?: number; isTTY?: boolean };
} = {}): MainObserverHarness {
  const records: Array<Record<string, unknown>> = [];
  let closeImplementation: () => void = () => { /* default: no additional effect */ };
  let closeCalls = 0;
  let preloadResolves = 0;
  let preloadEvaluations = 0;
  const stdout = options.stdout ?? {
    write: function originalWrite(): string { return "SYNTHETIC-accept"; },
    columns: 120, rows: 50, isTTY: true,
  };
  const fsStub = {
    appendFileSync(_destination: string, line: string): void {
      records.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  const processStub = {
    pid: 4243,
    cwd: () => "/synthetic",
    env: { PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE: "/synthetic/native-main.jsonl", ...(options.envOverrides ?? {}) },
    stdout,
    on: () => {},
  };
  const stubModule: Record<string, unknown> = {
    closeOwnedNativeCensus: () => { closeCalls += 1; closeImplementation(); },
  };
  const loadedModule: unknown = options.loadedModule === undefined ? stubModule : options.loadedModule;
  const requireMock = ((request: string): unknown => {
    if (request === "node:fs") return fsStub;
    if (request === "node:util") return { types };
    if (request === OBSERVER_PRELOAD_ID) {
      // Evaluating the canonical preload here would run its module-bottom
      // autoactivation; the fixed observer must never reach this branch.
      preloadEvaluations += 1;
      return options.moduleFactory === undefined ? loadedModule : options.moduleFactory();
    }
    throw new Error(`SYNTHETIC unexpected require: ${request}`);
  }) as ((request: string) => unknown) & { resolve(request: string): string; cache: Record<string, unknown> };
  requireMock.resolve = (request: string): string => {
    if (request !== OBSERVER_PRELOAD_ID) throw new Error(`SYNTHETIC unexpected resolve: ${request}`);
    preloadResolves += 1;
    if (options.resolveThrows === true) throw new Error("SYNTHETIC resolve failure");
    return OBSERVER_PRELOAD_KEY;
  };
  requireMock.cache = {};
  if (options.uncached !== true) {
    requireMock.cache[OBSERVER_PRELOAD_KEY] = options.cacheEntry !== undefined
      ? options.cacheEntry
      : { exports: loadedModule, id: OBSERVER_PRELOAD_KEY, filename: OBSERVER_PRELOAD_KEY, loaded: true };
  }
  const moduleStub: { exports: unknown } = { exports: {} };
  const sandbox: Record<string, unknown> = {
    require: requireMock,
    process: processStub,
    module: moduleStub,
    exports: moduleStub.exports,
    setInterval: () => ({ unref: () => {} }),
  };
  runInNewContext(observerSource, sandbox);
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown): void { handlers[event] = handler; },
    getActiveTools: () => [],
  };
  (moduleStub.exports as (pi: unknown) => void)(pi);
  return {
    records,
    stdout: stdout as { write: unknown },
    preloadResolves: () => preloadResolves,
    preloadEvaluations: () => preloadEvaluations,
    closeCalls: () => closeCalls,
    setCloseImplementation: (implementation: () => void): void => { closeImplementation = implementation; },
    setCachedExports: (exports: unknown): void => {
      requireMock.cache[OBSERVER_PRELOAD_KEY] = {
        exports, id: OBSERVER_PRELOAD_KEY, filename: OBSERVER_PRELOAD_KEY, loaded: true,
      };
    },
    shutdown: (event: Record<string, unknown>): unknown => handlers.session_shutdown?.(event),
  };
}

test("the genuine public session_shutdown observer closes exactly the retained canonical close once", () => {
  const made = makeActivation();
  assert.equal(made.result.installed, true);
  assert.equal(made.fake.closedCount(), 0, "a never-requested child retains its watcher until shutdown");

  const observer = loadMainObserver();
  observer.setCloseImplementation(() => { made.result.close!(); });
  assert.equal(observer.closeCalls(), 0, "retention at registration never invokes the close function");
  assert.equal(observer.shutdown({ reason: "quit" }), undefined, "the shutdown callback returns normally");
  assert.equal(observer.closeCalls(), 1, "the retained close helper is invoked exactly once");
  assert.equal(made.fake.closedCount(), 1, "the genuine public shutdown closes exactly the owned watcher");
  assert.equal(observer.preloadResolves(), 1, "the canonical module is resolved exactly once, at registration");
  assert.equal(observer.preloadEvaluations(), 0, "the already-loaded module is never evaluated");

  const record = observer.records[observer.records.length - 1]!;
  assert.equal(record.type, "session_shutdown", "the existing journal action is unchanged");
  assert.equal(record.reason, "quit");

  // Repeated shutdown is safe and never reloads, re-resolves, or reactivates.
  observer.shutdown({ reason: "quit" });
  assert.equal(observer.closeCalls(), 2, "repeated shutdown invokes the retained close again");
  assert.equal(made.fake.closedCount(), 1, "repeated shutdown remains exactly-once on the owned watcher");
  assert.equal(observer.preloadResolves(), 1, "the cached helper is never re-resolved");
  assert.equal(observer.preloadEvaluations(), 0);
  assert.equal(observer.records[observer.records.length - 1]!.type, "session_shutdown");
});

test("the public observer retains the exact canonical close before shutdown and cached replacement cannot redirect it", () => {
  let retainedCalls = 0;
  let foreignCalls = 0;
  const loadedModule: Record<string, unknown> = {
    closeOwnedNativeCensus: () => { retainedCalls += 1; },
  };
  const observer = loadMainObserver({ loadedModule });
  assert.equal(retainedCalls, 0, "retention at registration never invokes the close function");
  assert.equal(observer.preloadResolves(), 1, "the exact canonical leaf is resolved once at registration");
  assert.equal(observer.preloadEvaluations(), 0, "retention never evaluates the canonical module");

  // A post-capture replacement of the SAME exports object's close slot is not
  // a redirect: the exact already-retained function still runs.
  loadedModule.closeOwnedNativeCensus = () => { foreignCalls += 1; };
  assert.equal(observer.shutdown({ reason: "quit" }), undefined);
  assert.equal(retainedCalls, 1, "the exact already-retained close runs");
  assert.equal(foreignCalls, 0, "a replaced export slot never runs");

  // A post-capture replacement of the WHOLE cached module record is not a
  // redirect either.
  let secondRetained = 0;
  const secondModule: Record<string, unknown> = {
    closeOwnedNativeCensus: () => { secondRetained += 1; },
  };
  const replacement = loadMainObserver({ loadedModule: secondModule });
  replacement.setCachedExports({ closeOwnedNativeCensus: () => { foreignCalls += 1; } });
  assert.equal(replacement.shutdown({ reason: "quit" }), undefined);
  assert.equal(secondRetained, 1, "the retained close still runs after a cached module replacement");
  assert.equal(foreignCalls, 0, "a replaced cached module never redirects the close");
  assert.equal(replacement.preloadEvaluations(), 0);

  // A post-capture ACCESSOR on the same exports object neither runs nor
  // redirects the already-retained close.
  let accessorAfter = 0;
  let accessorRetained = 0;
  const accessorModule: Record<string, unknown> = {
    closeOwnedNativeCensus: () => { accessorRetained += 1; },
  };
  const accessorObserver = loadMainObserver({ loadedModule: accessorModule });
  Object.defineProperty(accessorModule, "closeOwnedNativeCensus", {
    get: () => { accessorAfter += 1; return () => { accessorAfter += 1; }; }, configurable: true,
  });
  assert.equal(accessorObserver.shutdown({ reason: "quit" }), undefined);
  assert.equal(accessorRetained, 1, "the retained close still runs after a post-capture accessor");
  assert.equal(accessorAfter, 0, "a post-capture accessor is never invoked");
});

test("the public observer treats unsupported cached module and close shapes as inert without invoking accessors or traps", () => {
  // An accessor close slot is refused WITHOUT being invoked.
  let getterCalls = 0;
  const accessorExports: Record<string, unknown> = {};
  Object.defineProperty(accessorExports, "closeOwnedNativeCensus", {
    get: () => { getterCalls += 1; return () => { getterCalls += 1; }; }, configurable: true,
  });
  const accessorObserver = loadMainObserver({ loadedModule: accessorExports });
  assert.equal(accessorObserver.shutdown({ reason: "quit" }), undefined, "the callback still returns normally");
  assert.equal(getterCalls, 0, "an accessor close slot is never invoked");
  assert.equal(accessorObserver.records[accessorObserver.records.length - 1]!.type, "session_shutdown",
    "the journal action is unchanged for an accessor close slot");

  // A proxy exports object is refused with zero traps.
  let trapCalls = 0;
  const proxyExports = new Proxy({ closeOwnedNativeCensus: () => {} }, {
    get() { trapCalls += 1; return undefined; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    has() { trapCalls += 1; return false; },
  });
  const proxyObserver = loadMainObserver({ loadedModule: proxyExports });
  assert.equal(proxyObserver.shutdown({ reason: "quit" }), undefined);
  assert.equal(trapCalls, 0, "a proxy exports object never traps");

  // A proxy module record is refused with zero traps.
  let moduleTrapCalls = 0;
  const proxyModule = new Proxy({}, {
    get() { moduleTrapCalls += 1; return undefined; },
    getOwnPropertyDescriptor() { moduleTrapCalls += 1; return undefined; },
  });
  const proxyModuleObserver = loadMainObserver({ cacheEntry: proxyModule });
  assert.equal(proxyModuleObserver.shutdown({ reason: "quit" }), undefined);
  assert.equal(moduleTrapCalls, 0, "a proxy module record never traps");

  // A non-object module record and a non-callable close slot are inert unknown.
  const nonObject = loadMainObserver({ cacheEntry: 42 });
  assert.equal(nonObject.shutdown({ reason: "quit" }), undefined);
  assert.equal(nonObject.preloadEvaluations(), 0, "an unsupported module record never evaluates the preload");
  const nonCallable = loadMainObserver({ loadedModule: { closeOwnedNativeCensus: 42 } });
  assert.equal(nonCallable.shutdown({ reason: "quit" }), undefined);
  assert.equal(nonCallable.records[nonCallable.records.length - 1]!.type, "session_shutdown");
});

test("the public observer retains no closer for foreign, mismatched, missing-identity, or unloaded module records", () => {
  let foreignCalls = 0;
  const foreignClose = () => { foreignCalls += 1; };
  const foreignExports = { closeOwnedNativeCensus: foreignClose };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["foreign id and filename", { exports: foreignExports, id: "/foreign/preload.cjs", filename: "/foreign/preload.cjs", loaded: true }],
    ["mismatched id", { exports: foreignExports, id: "/canonical/other-preload.cjs", filename: OBSERVER_PRELOAD_KEY, loaded: true }],
    ["mismatched filename", { exports: foreignExports, id: OBSERVER_PRELOAD_KEY, filename: "/canonical/other-preload.cjs", loaded: true }],
    ["missing identity", { exports: foreignExports, loaded: true }],
    ["unloaded record", { exports: foreignExports, id: OBSERVER_PRELOAD_KEY, filename: OBSERVER_PRELOAD_KEY, loaded: false }],
  ];
  for (const [label, cacheEntry] of cases) {
    const observer = loadMainObserver({ cacheEntry });
    assert.equal(observer.shutdown({ reason: "quit" }), undefined, `${label} keeps the callback normal`);
    assert.equal(foreignCalls, 0, `${label} never invokes a foreign close`);
    assert.equal(observer.preloadEvaluations(), 0, `${label} never evaluates the preload`);
    assert.equal(observer.records[observer.records.length - 1]!.type, "session_shutdown", `${label} still journals shutdown`);
  }

  // Accessor identity fields are refused without being invoked.
  let getterCalls = 0;
  const accessorModule: Record<string, unknown> = { exports: foreignExports };
  for (const field of ["id", "filename", "loaded"] as const) {
    Object.defineProperty(accessorModule, field, {
      get: () => { getterCalls += 1; return field === "loaded" ? true : OBSERVER_PRELOAD_KEY; },
      configurable: true,
    });
  }
  const accessorObserver = loadMainObserver({ cacheEntry: accessorModule });
  assert.equal(accessorObserver.shutdown({ reason: "quit" }), undefined);
  assert.equal(getterCalls, 0, "accessor identity fields are never invoked");
  assert.equal(foreignCalls, 0, "an accessor identity record retains no foreign closer");
});

test("the public observer refuses a callable proxy close function without invoking its traps", () => {
  let trapCalls = 0;
  const callableProxy = new Proxy(function foreignClose(): void { trapCalls += 1; }, {
    apply() { trapCalls += 1; return undefined; },
    get() { trapCalls += 1; return undefined; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
  });
  const observer = loadMainObserver({ loadedModule: { closeOwnedNativeCensus: callableProxy } });
  assert.equal(observer.shutdown({ reason: "quit" }), undefined, "the callback still returns normally");
  assert.equal(trapCalls, 0, "a callable proxy close function never traps");
  assert.equal(observer.records[observer.records.length - 1]!.type, "session_shutdown",
    "the journal action is unchanged for a callable proxy close");
});

test("the observer's shutdown helper failure never overrides the SDK callback or journal", () => {
  const observer = loadMainObserver();
  observer.setCloseImplementation(() => { throw new Error("SYNTHETIC close failure"); });
  assert.equal(observer.shutdown({ reason: "quit" }), undefined, "a throwing helper does not change the callback return");
  assert.equal(observer.closeCalls(), 1, "the owned close helper is still invoked");
  assert.equal(observer.preloadEvaluations(), 0);
  assert.equal(observer.records[observer.records.length - 1]!.type, "session_shutdown",
    "the journal action still runs after a helper failure");

  const unresolvable = loadMainObserver({ resolveThrows: true });
  assert.doesNotThrow(() => unresolvable.shutdown({ reason: "quit" }));
  assert.equal(unresolvable.records[unresolvable.records.length - 1]!.type, "session_shutdown",
    "an unresolvable helper module never alters the journal");
  assert.equal(unresolvable.preloadEvaluations(), 0);
});

test("an uncached canonical preload is never evaluated by the shutdown bridge", () => {
  const originalWrite = function originalWrite(): string { return "SYNTHETIC-accept"; };
  const stdout = { write: originalWrite, columns: 120, rows: 50, isTTY: true };
  const activationEffects: string[] = [];
  const observer = loadMainObserver({
    uncached: true,
    stdout,
    envOverrides: {
      PRG_SESSION_HOST_NATIVE_CENSUS_ROOT: "/synthetic/staged-root",
      PI_REVIEW_GATE_CANDIDATE_ENTRY: "/synthetic/dist/src/index.js",
    },
    moduleFactory: () => {
      // Model the real module-bottom autoactivation side effects: create the
      // census directory, install a stdout hook, and open the watcher.
      // Reaching this factory at shutdown is exactly the failure the bridge
      // must prevent, so nothing here may ever run.
      activationEffects.push("directory", "stdout-hook", "watcher");
      Object.defineProperty(stdout, "write", {
        value: function activationHook(): string { return "SYNTHETIC-hook"; },
        writable: true, configurable: true, enumerable: false,
      });
      return { closeOwnedNativeCensus: () => { throw new Error("SYNTHETIC unexpected close"); } };
    },
  });
  assert.equal(observer.shutdown({ reason: "quit" }), undefined, "the shutdown callback still returns normally");
  assert.equal(activationEffects.length, 0, "no directory, stdout hook, or watcher is created");
  assert.equal(observer.preloadEvaluations(), 0, "no require() evaluation of the canonical preload");
  assert.equal(stdout.write, originalWrite, "no stdout hook is installed");
  assert.equal(observer.records[observer.records.length - 1]!.type, "session_shutdown",
    "the journal action is unchanged for a not-loaded helper");

  // Even a later shutdown never starts a census.
  observer.shutdown({ reason: "quit" });
  assert.equal(activationEffects.length, 0);
  assert.equal(stdout.write, originalWrite);
});

test("native reply validation is strict on keys, PID, nonce, schema, caps, and coherence", () => {
  const base = nativeFixture.buildNativeCensusReply(NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1,
    proof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243 }),
  });
  const expect = { nonce: NONCE, expectedNativePid: 4243 };
  assert.ok(validateNativeCensusReply(base, expect) !== undefined);

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["extra key", { ...base, extra: 1 }],
    ["missing key", Object.fromEntries(Object.entries(base).filter(([key]) => key !== "nonce"))],
    ["wrong nonce", { ...base, nonce: OTHER_NONCE }],
    ["wrong PID", { ...base, nativePid: 9999 }],
    ["PID zero", { ...base, nativePid: 0 }],
    ["wrong schema version", { ...base, schemaVersion: 2 }],
    ["string count", { ...base, writeCalls: "1" }],
    ["negative count", { ...base, mouseSgrSet: -1 }],
    ["over-cap count", { ...base, mouseSgrSet: NATIVE_CENSUS_COUNT_LIMIT + 1 }],
    ["complete with null count", { ...base, mouseSgrSet: null }],
    ["non-boolean flag", { ...base, hookActive: "true" }],
    ["proof without its epoch", { ...base, sessionEpoch: null }],
    ["epoch without its proof", { ...base, proof: null }],
    ["epoch zero", { ...base, sessionEpoch: 0, proof: null }],
    ["unknown scope carrying a binding", { ...base, bindingScope: false }],
    ["malformed proof", { ...base, proof: "z".repeat(64) }],
    ["non-string proof", { ...base, proof: 123 }],
  ];
  for (const [label, value] of invalid) {
    assert.equal(validateNativeCensusReply(value, expect), undefined, `${label} is refused`);
  }

  // A complete observation requires both flags.
  assert.equal(validateNativeCensusReply({ ...base, hookActive: false }, expect), undefined,
    "complete=true with an inactive hook is impossible");
  assert.equal(validateNativeCensusReply({ ...base, sameOutputStream: false }, expect), undefined,
    "complete=true without the retained stream is impossible");

  for (const value of [null, undefined, "reply", 7, [base]]) {
    assert.equal(validateNativeCensusReply(value, expect), undefined, "non-object replies are refused");
  }
});

test("native correlation requires the identical binding tuple and opaque proof", () => {
  const binding: MainNativeBindingSnapshot = validateMainNativeBindingSnapshot({
    scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1,
    expectedProof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243 }),
  })!;
  const reply = nativeFixture.buildNativeCensusReply(NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1,
    proof: binding.expectedProof,
  });
  const correlated = validateNativeCensusCorrelation(reply, { nonce: NONCE, expectedNativePid: 4243, binding });
  assert.ok(correlated !== undefined, "an identical fresh reply correlates");

  // A stale/changed proof (different nonce) is a refusal, never a fallback.
  const staleReply = nativeFixture.buildNativeCensusReply(OTHER_NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1,
    proof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: OTHER_NONCE, pid: 4243 }),
  });
  assert.equal(validateNativeCensusCorrelation(staleReply, { nonce: NONCE, expectedNativePid: 4243, binding }), undefined,
    "a stale proof is refused");

  // A changed session epoch is a refusal.
  const changedEpoch = nativeFixture.buildNativeCensusReply(NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 2,
    proof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 2, nonce: NONCE, pid: 4243 }),
  });
  assert.equal(validateNativeCensusCorrelation(changedEpoch, { nonce: NONCE, expectedNativePid: 4243, binding }), undefined,
    "a changed session epoch is refused");

  // A wrong PID is a refusal.
  const wrongPid = nativeFixture.buildNativeCensusReply(NONCE, 4244, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 0, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 0, alternateBufferReset: 0, bracketedPasteSet: 0, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1,
    proof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4244 }),
  });
  assert.equal(validateNativeCensusCorrelation(wrongPid, { nonce: NONCE, expectedNativePid: 4243, binding }), undefined,
    "a wrong native PID is refused");

  // An incomplete binding never correlates.
  const incompleteBinding = validateMainNativeBindingSnapshot({
    scope: true, complete: false, ptyPid: null, incarnation: null, sessionEpoch: null, expectedProof: null,
  })!;
  assert.equal(validateNativeCensusCorrelation(reply, { nonce: NONCE, expectedNativePid: 4243, binding: incompleteBinding }), undefined,
    "an incomplete actual-owner binding never correlates");
});

test("Main native-binding group validation is strict on pair coherence and proof type", () => {
  const proof = nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243 })!;
  assert.ok(validateMainNativeBindingSnapshot({ scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: proof }) !== undefined);
  for (const [label, value] of [
    ["pid without incarnation", { scope: true, complete: false, ptyPid: 4243, incarnation: null, sessionEpoch: null, expectedProof: null }],
    ["incarnation without pid", { scope: true, complete: false, ptyPid: null, incarnation: 1, sessionEpoch: null, expectedProof: null }],
    ["epoch without proof", { scope: true, complete: false, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: null }],
    ["proof without tuple", { scope: true, complete: false, ptyPid: null, incarnation: null, sessionEpoch: null, expectedProof: proof }],
    ["non-string proof", { scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: 123 }],
    ["malformed proof", { scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: "z".repeat(64) }],
    ["scope null with data", { scope: null, complete: null, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: proof }],
    ["complete mismatch", { scope: true, complete: false, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: proof }],
    ["extra key", { scope: true, complete: true, ptyPid: 4243, incarnation: 1, sessionEpoch: 1, expectedProof: proof, sessionId: RAW_SESSION_ID }],
  ] as const) {
    assert.equal(validateMainNativeBindingSnapshot(value), undefined, `${label} is refused`);
  }
});

test("native diagnostic is bounded and metadata-only", () => {
  assert.equal(formatNativeCensusDiagnostic(undefined), "nativeCensusDiag{absent}");
  const reply = nativeFixture.buildNativeCensusReply(NONCE, 4243, {
    hookActive: true, sameOutputStream: true, observationComplete: true,
    writeCalls: 1, mouseX10Set: 0, mouseX10Reset: 0, mouseVt200Set: 0, mouseVt200Reset: 0,
    mouseDragSet: 0, mouseDragReset: 0, mouseAnySet: 1, mouseAnyReset: 0, mouseSgrSet: 1, mouseSgrReset: 0,
    alternateBufferSet: 1, alternateBufferReset: 0, bracketedPasteSet: 1, bracketedPasteReset: 0,
    bindingScope: true, sessionEpoch: 1,
    proof: nativeFixture.computeNativeCensusProof({ bootstrap: BOOTSTRAP, sessionId: RAW_SESSION_ID, sessionEpoch: 1, nonce: NONCE, pid: 4243 }),
  });
  const line = formatNativeCensusDiagnostic(validateNativeCensusReply(reply, { nonce: NONCE, expectedNativePid: 4243 })!);
  assert.match(line, /^nativeCensusDiag\{[a-zA-Z0-9= ,{}]+\}$/, "only bounded numeric/boolean tokens are emitted");
  assert.ok(line.includes("complete=true"));
  assert.ok(line.includes("pid=4243"));
  assert.ok(line.includes("sgrSet=1"));
  assert.ok(line.includes("epoch=1"));
  assert.ok(line.includes("proof=ok}"), "the proof is disclosed only as a present flag");
  assert.ok(line.length < 1_024, "the diagnostic line stays bounded");
  for (const forbidden of [BOOTSTRAP.token, BOOTSTRAP.socketPath, BOOTSTRAP.instanceId, RAW_SESSION_ID, NONCE]) {
    assert.ok(!line.includes(forbidden), `diagnostic must not contain ${forbidden.slice(0, 8)}…`);
  }

  const unknown = formatNativeCensusDiagnostic(validateNativeCensusReply(
    nativeFixture.buildNativeCensusReply(NONCE, 4243, {
      hookActive: false, sameOutputStream: true, observationComplete: false,
      writeCalls: null, mouseX10Set: null, mouseX10Reset: null, mouseVt200Set: null, mouseVt200Reset: null,
      mouseDragSet: null, mouseDragReset: null, mouseAnySet: null, mouseAnyReset: null, mouseSgrSet: null, mouseSgrReset: null,
      alternateBufferSet: null, alternateBufferReset: null, bracketedPasteSet: null, bracketedPasteReset: null,
      bindingScope: false, sessionEpoch: null, proof: null,
    }), { nonce: NONCE, expectedNativePid: 4243 })!);
  assert.ok(unknown.includes("calls=null"), "unknown state is disclosed as null, never zero");
  assert.ok(unknown.includes("proof=none}"));
});

// ---------------------------------------------------------------------------
// PTY observer private binding lookup regressions (sliced exact source, no
// real PTY or filesystem).
// ---------------------------------------------------------------------------

const ptySource = readFileSync(resolve(__dirname, "../../tests/fixtures/session-host-windows-pty-observer.cjs"), "utf8");
const ptyDeclaration = ptySource.slice(ptySource.indexOf("function observePtyModule("), ptySource.indexOf("module.exports"));
assert.ok(ptyDeclaration.startsWith("function observePtyModule("));

const BOOTSTRAP_ENV_NAME = "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP";

function ptyFixture(options: { immediatePid?: number; throwPidOnce?: boolean; failJournalOnce?: boolean } = {}) {
  const records: Record<string, unknown>[] = [];
  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((event: { exitCode: number }) => void)[] = [];
  let pid = options.immediatePid ?? 0;
  let pidThrows = options.throwPidOnce === true;
  const handle = {
    get pid() {
      if (pidThrows) { pidThrows = false; throw new Error("SYNTHETIC unreadable PID"); }
      return pid;
    },
    onData(listener: (data: string) => void) {
      dataListeners.push(listener);
      return { dispose() { const i = dataListeners.indexOf(listener); if (i >= 0) dataListeners.splice(i, 1); } };
    },
    kill(): unknown { return "SYNTHETIC kill return"; },
  };
  Object.defineProperty(handle, "onExit", { configurable: false, get: () => (listener: (event: { exitCode: number }) => void) => {
    exitListeners.push(listener);
    return { dispose() {} };
  } });
  let spawnReceiver: unknown;
  const originalSpawn = function(this: unknown, ...args: unknown[]) { spawnReceiver = this; return handle; };
  const module: { spawn: (this: unknown, ...args: unknown[]) => unknown } = { spawn: originalSpawn };
  let journalCalls = 0;
  const install = runInNewContext(`${ptyDeclaration}\nobservePtyModule`, {
    process: { platform: "win32", on: () => {} },
    appendMetadata: (_destination: string, record: Record<string, unknown>) => {
      journalCalls += 1;
      if (options.failJournalOnce === true && journalCalls === 1) throw new Error("SYNTHETIC journal failure");
      records.push({ ...record });
    },
    types,
  }) as (nodePty: unknown, journal: string, options?: Record<string, unknown>) => {
    nativeBindingFor(instanceId: string): { pid: number; incarnation: number; bootstrap: Record<string, unknown> } | undefined;
    snapshot(): { forceAttempted: boolean; journalFailed: boolean };
    restore(): void;
  };
  const observation = install(module, "/synthetic/journal", {
    bootstrap: {
      envName: BOOTSTRAP_ENV_NAME,
      parse: (value: unknown): Record<string, unknown> | undefined => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
        const v = value as Record<string, unknown>;
        if (v.instanceId !== BOOTSTRAP.instanceId) return undefined;
        return { ...BOOTSTRAP, ...v };
      },
    },
  });
  const env: Record<string, unknown> = { [BOOTSTRAP_ENV_NAME]: JSON.stringify({ ...BOOTSTRAP }) };
  const args = ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace", env }];
  assert.equal(Reflect.apply(module.spawn, module, args), handle, "observer returns the identical public handle");
  assert.equal(spawnReceiver, module, "original spawn receiver is preserved");
  return {
    handle, module, originalSpawn, observation, records,
    data(nextPid: number) { pid = nextPid; for (const listener of [...dataListeners]) listener("SYNTHETIC ignored terminal data"); },
    exit() { for (const listener of exitListeners) listener({ exitCode: 0 }); },
  };
}

test("pty observer native binding captures the offered bootstrap transparently and revalidates at call time", () => {
  const f = ptyFixture();
  assert.equal(f.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a pending PID is unknown, never guessed");
  f.data(731);
  const binding = f.observation.nativeBindingFor(BOOTSTRAP.instanceId);
  assert.ok(binding !== undefined, "the offered bootstrap binds to the once-positive original PID");
  assert.equal(binding!.pid, 731);
  assert.equal(binding!.incarnation, 1);
  assert.deepEqual(binding!.bootstrap, BOOTSTRAP, "the retained tuple is the exact consumed offer");

  // A changed public handle PID latches uncertainty without rebinding, and
  // reverting the disturbance never rebinds.
  f.data(999);
  assert.equal(f.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a changed PID is sticky unknown, never rebound");
  assert.equal(f.observation.snapshot().journalFailed, true, "the changed PID is a journal failure");
  f.data(731); // the disturbance is reverted
  assert.equal(f.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a reverted PID change never rebinds");

  // An actual exit is unknown.
  const second = ptyFixture({ immediatePid: 732 });
  assert.ok(second.observation.nativeBindingFor(BOOTSTRAP.instanceId) !== undefined);
  second.exit();
  assert.equal(second.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "an exited handle is unknown");

  // A replaced spawn slot invalidates the observation; restore preserves the
  // foreign replacement and does not repair the observation.
  const third = ptyFixture({ immediatePid: 733 });
  assert.ok(third.observation.nativeBindingFor(BOOTSTRAP.instanceId) !== undefined);
  const foreignSpawn = function foreign(): unknown { return undefined; };
  third.module.spawn = foreignSpawn;
  assert.equal(third.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a replaced spawn slot is unknown");
  third.observation.restore();
  assert.equal(third.module.spawn, foreignSpawn, "restore preserves a foreign replacement");
  assert.equal(third.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a restored slot does not repair a completed observation");

  // Reverting the spawn slot manually never rebinds either.
  const slotRevert = ptyFixture({ immediatePid: 735 });
  assert.ok(slotRevert.observation.nativeBindingFor(BOOTSTRAP.instanceId) !== undefined);
  slotRevert.module.spawn = function foreignSlot(): unknown { return undefined; };
  assert.equal(slotRevert.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a replaced spawn slot is unknown");
  slotRevert.module.spawn = slotRevert.originalSpawn;
  assert.equal(slotRevert.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a reverted spawn slot never rebinds");

  // A throwing PID read latches uncertainty; a later readable PID never rebinds.
  const pidThrow = ptyFixture({ throwPidOnce: true });
  assert.equal(pidThrow.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a throwing PID read is sticky unknown");
  pidThrow.data(737);
  assert.equal(pidThrow.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a throwing-then-readable PID never rebinds");

  // A journal failure latches the private binding scope without rebinding.
  const journalFail = ptyFixture({ immediatePid: 736, failJournalOnce: true });
  assert.equal(journalFail.observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a journal failure is sticky unknown");

  // A foreign instance id is unknown.
  const fourth = ptyFixture({ immediatePid: 734 });
  assert.equal(fourth.observation.nativeBindingFor("other-instance-id"), undefined, "a foreign instance id is unknown");
});

test("pty observer bootstrap capture refuses getters and inherited env without invoking them", () => {
  // A getter env leaf is refused WITHOUT being invoked.
  const source = ptySource;
  const declaration = source.slice(source.indexOf("function observePtyModule("), source.indexOf("module.exports"));
  let getterCalls = 0;
  const install = runInNewContext(`${declaration}\nobservePtyModule`, {
    process: { platform: "win32", on: () => {} },
    appendMetadata: () => {},
    types,
  }) as (nodePty: unknown, journal: string, options?: Record<string, unknown>) => {
    nativeBindingFor(instanceId: string): unknown;
    restore(): void;
  };
  const exitListeners: ((event: { exitCode: number }) => void)[] = [];
  const handle = { pid: 735, onData: () => ({ dispose() {} }), kill: () => "SYNTHETIC" };
  Object.defineProperty(handle, "onExit", { configurable: false, get: () => (listener: (event: { exitCode: number }) => void) => { exitListeners.push(listener); return { dispose() {} }; } });
  const originalSpawn = function(this: unknown): unknown { return handle; };
  const module = { spawn: originalSpawn };
  const observation = install(module, "/synthetic/journal", {
    bootstrap: { envName: BOOTSTRAP_ENV_NAME, parse: (value: unknown) => (value === null || typeof value !== "object" ? undefined : value as Record<string, unknown>) },
  });
  const env: Record<string, unknown> = {};
  Object.defineProperty(env, BOOTSTRAP_ENV_NAME, {
    get: () => { getterCalls += 1; return JSON.stringify({ ...BOOTSTRAP }); },
    configurable: true,
  });
  Reflect.apply(module.spawn, module, ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace", env }]);
  assert.equal(observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a getter env leaf leaves the binding unknown");
  assert.equal(getterCalls, 0, "the env getter is never invoked before the original spawn");

  // An inherited env (no own descriptor) is refused.
  const handle2 = { pid: 736, onData: () => ({ dispose() {} }), kill: () => "SYNTHETIC" };
  Object.defineProperty(handle2, "onExit", { configurable: false, get: () => (listener: (event: { exitCode: number }) => void) => { exitListeners.push(listener); return { dispose() {} }; } });
  const originalSpawn2 = function(this: unknown): unknown { return handle2; };
  const module2 = { spawn: originalSpawn2 };
  const observation2 = install(module2, "/synthetic/journal", {
    bootstrap: { envName: BOOTSTRAP_ENV_NAME, parse: (value: unknown) => (value === null || typeof value !== "object" ? undefined : value as Record<string, unknown>) },
  });
  const inheritedEnv = Object.create({ [BOOTSTRAP_ENV_NAME]: JSON.stringify({ ...BOOTSTRAP }) });
  Reflect.apply(module2.spawn, module2, ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace", env: inheritedEnv }]);
  assert.equal(observation2.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "an inherited env leaves the binding unknown");
});

test("pty observer bootstrap capture refuses proxy spawn options and env before any descriptor trap", () => {
  const declaration = ptySource.slice(ptySource.indexOf("function observePtyModule("), ptySource.indexOf("module.exports"));
  const journalRecords: Record<string, unknown>[] = [];
  const install = runInNewContext(`${declaration}\nobservePtyModule`, {
    process: { platform: "win32", on: () => {} },
    appendMetadata: (_destination: string, record: Record<string, unknown>) => { journalRecords.push({ ...record }); },
    types,
  }) as (nodePty: unknown, journal: string, options?: Record<string, unknown>) => {
    nativeBindingFor(instanceId: string): unknown;
    restore(): void;
  };
  const bootstrapOptions = {
    envName: BOOTSTRAP_ENV_NAME,
    parse: (value: unknown): Record<string, unknown> | undefined =>
      value === null || typeof value !== "object" ? undefined : value as Record<string, unknown>,
  };
  const makeHandle = (pid: number) => {
    const handle = { pid, onData: () => ({ dispose() {} }), kill: () => "SYNTHETIC" };
    Object.defineProperty(handle, "onExit", { configurable: false, get: () => () => ({ dispose() {} }) });
    return handle;
  };

  // A proxy spawn options whose descriptor trap would FORGE a positive env if
  // read; the refusal must happen before any trap runs.
  let optionsTrapCalls = 0;
  const forgedEnv: Record<string, unknown> = { [BOOTSTRAP_ENV_NAME]: JSON.stringify({ ...BOOTSTRAP }) };
  const proxyOptions = new Proxy({ cwd: "/synthetic/workspace", env: {} }, {
    getOwnPropertyDescriptor(target, prop) {
      optionsTrapCalls += 1;
      if (prop === "env") return { value: forgedEnv, writable: true, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const handle = makeHandle(741);
  let receiver: unknown;
  let receivedArgs: unknown[] = [];
  const originalSpawn = function (this: unknown, ...args: unknown[]) { receiver = this; receivedArgs = args; return handle; };
  const module = { spawn: originalSpawn };
  const observation = install(module, "/synthetic/journal", { bootstrap: bootstrapOptions });
  assert.equal(Reflect.apply(module.spawn, module, ["SYNTHETIC-node", ["SYNTHETIC-cli"], proxyOptions]), handle,
    "the original spawn returns the identical handle");
  assert.equal(receiver, module, "the original receiver is preserved");
  assert.equal(receivedArgs[2], proxyOptions, "the exact proxy argument object identity is forwarded");
  assert.equal(optionsTrapCalls, 0, "no descriptor trap runs during pre-spawn bootstrap capture");
  assert.equal(journalRecords.filter((r) => r.type === "pty_spawn_pending").length, 1, "post-spawn journaling is preserved");
  assert.equal(observation.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a proxy spawn options leaves the binding unknown");

  // Plain spawn options whose env is a proxy forging a positive bootstrap leaf.
  journalRecords.length = 0;
  let envTrapCalls = 0;
  const proxyEnv = new Proxy({}, {
    getOwnPropertyDescriptor(target, prop) {
      envTrapCalls += 1;
      if (prop === BOOTSTRAP_ENV_NAME) return { value: JSON.stringify({ ...BOOTSTRAP }), writable: true, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const handle2 = makeHandle(742);
  let receiver2: unknown;
  let receivedArgs2: unknown[] = [];
  const originalSpawn2 = function (this: unknown, ...args: unknown[]) { receiver2 = this; receivedArgs2 = args; return handle2; };
  const module2 = { spawn: originalSpawn2 };
  const observation2 = install(module2, "/synthetic/journal", { bootstrap: bootstrapOptions });
  const envOptions = { cwd: "/synthetic/workspace", env: proxyEnv };
  assert.equal(Reflect.apply(module2.spawn, module2, ["SYNTHETIC-node", ["SYNTHETIC-cli"], envOptions]), handle2,
    "the original spawn returns the identical handle");
  assert.equal(receiver2, module2, "the original receiver is preserved");
  assert.equal(receivedArgs2[2], envOptions, "the exact argument object identity is forwarded");
  assert.equal((receivedArgs2[2] as { env: unknown }).env, proxyEnv, "the exact proxy env object identity is forwarded");
  assert.equal(envTrapCalls, 0, "no env descriptor trap runs during pre-spawn bootstrap capture");
  assert.equal(journalRecords.filter((r) => r.type === "pty_spawn_pending").length, 1, "post-spawn journaling is preserved");
  assert.equal(observation2.nativeBindingFor(BOOTSTRAP.instanceId), undefined, "a proxy env leaves the binding unknown");

  // A throwing original spawn still throws its exact error through a refused proxy.
  journalRecords.length = 0;
  let envTrapCalls2 = 0;
  const proxyEnv2 = new Proxy({}, {
    getOwnPropertyDescriptor(target, prop) {
      envTrapCalls2 += 1;
      if (prop === BOOTSTRAP_ENV_NAME) return { value: JSON.stringify({ ...BOOTSTRAP }), writable: true, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const boom = new Error("SYNTHETIC spawn failure");
  let receiver3: unknown;
  const throwingSpawn = function (this: unknown): unknown { receiver3 = this; throw boom; };
  const module3 = { spawn: throwingSpawn };
  install(module3, "/synthetic/journal", { bootstrap: bootstrapOptions });
  let thrown: unknown;
  try {
    Reflect.apply(module3.spawn, module3, ["SYNTHETIC-node", ["SYNTHETIC-cli"], { cwd: "/synthetic/workspace", env: proxyEnv2 }]);
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown, boom, "the original spawn error is thrown identically through a refused proxy env");
  assert.equal(receiver3, module3, "the original receiver is preserved for a throwing spawn");
  assert.equal(envTrapCalls2, 0, "no env descriptor trap runs before the original spawn throws");
});
