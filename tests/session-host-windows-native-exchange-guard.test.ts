/**
 * Pure regression tests for the original-Main-origin native exchange guard:
 * the single arm with complete actual-owner facts, sticky disturbance
 * latching (owner row, owner swap with identical captions, focus off->back,
 * foreign receiver, resize, geometry), the fresh pure current-scope serve
 * revalidation (self PID, live original PTY binding tuple, scope session
 * tuple, private proof self-consistency), strict request/reply contracts and
 * root-arm correlation, and the exact single-reply transport through the
 * shared census reply service with exact-once closure.
 *
 * No actual filesystem, process, PTY, or Windows runtime is touched: the CJS
 * fixtures are required directly as pure modules and driven with fakes.
 */
import assert from "node:assert/strict";
import { dirname, join as pathJoin } from "node:path";
import test from "node:test";

import {
  GUARD_REPLY_FILENAME,
  GUARD_REQUEST_FILENAME,
  NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION,
  validateNativeExchangeGuardCorrelation,
  validateNativeExchangeGuardReply,
} from "./helpers/session-host-windows-native-exchange-guard-contract";
import { type MainNativeBindingSnapshot } from "./helpers/session-host-windows-stdout-census-contract";

const guardFixture = require("../../tests/fixtures/session-host-windows-native-exchange-guard.cjs") as {
  GUARD_SCHEMA_VERSION: number;
  GUARD_REQUEST_FILENAME: string;
  GUARD_REPLY_FILENAME: string;
  isNativeExchangeGuardRequestPayload(payload: unknown): boolean;
  createNativeExchangeGuard(options: Record<string, unknown>): {
    arm(nonce: string | undefined, facts: unknown): boolean;
    onList(rows: unknown): void;
    onOwner(ownerId: unknown): void;
    onFocus(focusValue: unknown, receiver: unknown): void;
    observeResize(): void;
    willServe(payload: unknown): boolean;
    buildGuardReply(nonce: string, mainPid: number): Record<string, unknown>;
    readonly armed: boolean;
    readonly invalid: boolean;
  };
};

const censusFixture = require("../../tests/fixtures/session-host-windows-stdout-census.cjs") as {
  createCensusReplyService(options: Record<string, unknown>): {
    start(): void;
    close(): void;
    readonly servedNonce: string | undefined;
  };
};

const paneFixture = require("../../tests/fixtures/session-host-windows-pane-mode-observer.cjs") as {
  createPaneModeObserver(
    classes: unknown,
    options?: { nativeBinding?: (row: unknown, nonce: string | undefined) => unknown; guard?: unknown },
  ): {
    snapshot(nonce?: string): Record<string, unknown>;
    revalidateScope(facts: unknown): { sessionId: string; sessionEpoch: number } | undefined;
    restore(): boolean;
  };
};

const MAIN_PID = 7001;
const NATIVE_PID = 4243;
const ARM_NONCE = "armnonce0123456789ab";
const REQUEST_NONCE = "reqnonce0123456789ab";
const OTHER_REQUEST_NONCE = "othernonce0123456789ab";
const RAW_SESSION_ID = "native-session-id-1";

/** A valid consumed bootstrap tuple (the only tuple the guard ever knows). */
const BOOTSTRAP = {
  version: 1,
  socketPath: "/tmp/fake-native-socket",
  token: "ab".repeat(32),
  instanceId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  generation: "0ffeeddccbba99887766554433221100",
};

const PROOF = require("../../tests/fixtures/session-host-windows-native-stdout-census.cjs")
  .computeNativeCensusProof({
    bootstrap: BOOTSTRAP,
    sessionId: RAW_SESSION_ID,
    sessionEpoch: 1,
    nonce: ARM_NONCE,
    pid: NATIVE_PID,
  }) as string;

const BINDING: MainNativeBindingSnapshot = {
  scope: true,
  complete: true,
  ptyPid: NATIVE_PID,
  incarnation: 1,
  sessionEpoch: 1,
  expectedProof: PROOF,
};

interface GuardState {
  pid: number;
  columns: number;
  rows: number;
  binding: { pid: number; incarnation: number; bootstrap: Record<string, unknown> } | undefined;
  scope: { sessionId: string; sessionEpoch: number } | undefined;
}

function makeGuard() {
  const state: GuardState = {
    pid: MAIN_PID,
    columns: 120,
    rows: 50,
    binding: { pid: NATIVE_PID, incarnation: 1, bootstrap: { ...BOOTSTRAP } },
    scope: { sessionId: RAW_SESSION_ID, sessionEpoch: 1 },
  };
  const guard = guardFixture.createNativeExchangeGuard({
    mainPid: () => state.pid,
    geometry: () => ({ columns: state.columns, rows: state.rows }),
    revalidate: (armed: unknown) => {
      void armed;
      return state.scope === undefined ? undefined : { ...state.scope };
    },
    bindingLookup: (instanceId: unknown) => {
      if (state.binding === undefined || instanceId !== BOOTSTRAP.instanceId) return undefined;
      return { pid: state.binding.pid, incarnation: state.binding.incarnation, bootstrap: state.binding.bootstrap };
    },
  });
  return { guard, state };
}

function armFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: "owner-A",
    hasLiveProcess: true,
    lifecycle: "alive",
    nativeSession: { sessionId: RAW_SESSION_ID, epoch: 1, name: "caption" },
  };
  return {
    ownerId: "owner-A",
    focus: "main",
    row,
    binding: { ...BINDING },
    bootstrap: { ...BOOTSTRAP },
    manager: {},
    sidebar: {},
    surface: {},
    ...overrides,
  };
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION,
    nonce: REQUEST_NONCE,
    expectedMainPid: MAIN_PID,
    proofNonce: ARM_NONCE,
    expectedOriginalNativePID: NATIVE_PID,
    ...overrides,
  };
}

test("guard arms once with complete actual-owner facts and serves one correlated reply", () => {
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts()), true, "a complete fresh pass arms the single guard");
  assert.equal(guard.armed, true);
  assert.equal(guard.invalid, false);

  assert.equal(guard.willServe(validRequest()), true, "the fresh pure current-scope proof passes");
  const reply = guard.buildGuardReply(REQUEST_NONCE, MAIN_PID);
  const validated = validateNativeExchangeGuardReply(reply, {
    nonce: REQUEST_NONCE,
    expectedMainPid: MAIN_PID,
    proofNonce: ARM_NONCE,
    expectedOriginalNativePID: NATIVE_PID,
  });
  assert.ok(validated !== undefined, "the reply validates under the strict contract");
  assert.equal(validated!.incarnation, 1);
  assert.equal(validated!.sessionEpoch, 1);
  assert.equal(validated!.proof, PROOF, "the reply carries the armed expected private proof");
  const correlated = validateNativeExchangeGuardCorrelation(reply, {
    nonce: REQUEST_NONCE,
    expectedMainPid: MAIN_PID,
    proofNonce: ARM_NONCE,
    expectedOriginalNativePID: NATIVE_PID,
    binding: BINDING,
  });
  assert.ok(correlated !== undefined, "the reply correlates against the Main census binding");

  assert.equal(guard.willServe(validRequest()), false, "the serve is single-use");
  assert.equal(guard.arm(ARM_NONCE, armFacts()), false, "no rearm after arming");
});

test("guard refuses unsupported arm inputs and never arms positive or re-arms", () => {
  const cases: Array<[string, (facts: Record<string, unknown>) => void]> = [
    ["missing ownerId", (f) => { delete f.ownerId; }],
    ["non-string ownerId", (f) => { f.ownerId = 7; }],
    ["unsupported focus", (f) => { f.focus = "bogus"; }],
    ["row id mismatch", (f) => { (f.row as Record<string, unknown>).id = "owner-B"; }],
    ["row not live", (f) => { (f.row as Record<string, unknown>).hasLiveProcess = false; }],
    ["row not alive", (f) => { (f.row as Record<string, unknown>).lifecycle = "exited"; }],
    ["missing nativeSession", (f) => { delete (f.row as Record<string, unknown>).nativeSession; }],
    ["path-like session id", (f) => { (f.row as Record<string, unknown>).nativeSession = { sessionId: "a/b", epoch: 1 }; }],
    ["zero session epoch", (f) => { (f.row as Record<string, unknown>).nativeSession = { sessionId: RAW_SESSION_ID, epoch: 0 }; }],
    ["incomplete binding", (f) => { f.binding = { ...BINDING, complete: false }; }],
    ["short expected proof", (f) => { f.binding = { ...BINDING, expectedProof: "b".repeat(63) }; }],
    ["missing bootstrap field", (f) => { delete (f.bootstrap as Record<string, unknown>).token; }],
    ["non-hex bootstrap token", (f) => { (f.bootstrap as Record<string, unknown>).token = "z".repeat(64); }],
    ["bootstrap version drift", (f) => { (f.bootstrap as Record<string, unknown>).version = 2; }],
    ["missing manager", (f) => { delete f.manager; }],
    ["missing sidebar", (f) => { delete f.sidebar; }],
    ["missing surface", (f) => { delete f.surface; }],
  ];
  for (const [label, disturb] of cases) {
    const facts = armFacts();
    disturb(facts);
    const { guard } = makeGuard();
    assert.equal(guard.arm(ARM_NONCE, facts), false, `${label}: the arm is refused`);
    assert.equal(guard.armed, false, `${label}: nothing arms positive`);
    assert.equal(guard.willServe(validRequest()), false, `${label}: a refused guard never serves`);
  }

  // A bad nonce refuses too, and the refusal is sticky: a later valid arm is impossible.
  const { guard } = makeGuard();
  assert.equal(guard.arm("short", armFacts()), false, "an unbounded arm nonce is refused");
  assert.equal(guard.arm(ARM_NONCE, armFacts()), false, "an unsupported arm input never re-arms");
  assert.equal(guard.invalid, true);

  // An unreadable geometry refuses the arm.
  const geo = makeGuard();
  geo.state.columns = 0;
  assert.equal(geo.guard.arm(ARM_NONCE, armFacts()), false, "an unsupported geometry never arms positive");
});

test("guard latches owner row disturbances stickily, including change-then-revert", () => {
  const originalRow = () => ({
    id: "owner-A",
    hasLiveProcess: true,
    lifecycle: "alive",
    nativeSession: { sessionId: RAW_SESSION_ID, epoch: 1, name: "caption" },
  });
  const cases: Array<[string, unknown[]]> = [
    ["absent owner row", [{ id: "owner-B", hasLiveProcess: true, lifecycle: "alive", nativeSession: originalRow().nativeSession }]],
    ["duplicate owner rows", [originalRow(), originalRow()]],
    ["changed session epoch", [{ ...originalRow(), nativeSession: { sessionId: RAW_SESSION_ID, epoch: 2 } }]],
    ["changed session id", [{ ...originalRow(), nativeSession: { sessionId: "other-session", epoch: 1 } }]],
    ["owner row not live", [{ ...originalRow(), hasLiveProcess: false }]],
  ];
  for (const [label, rows] of cases) {
    const { guard } = makeGuard();
    assert.equal(guard.arm(ARM_NONCE, armFacts()), true);
    guard.onList(rows);
    assert.equal(guard.invalid, true, `${label}: the disturbance latches`);
  }

  // Change-then-revert never repairs the guard.
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts()), true);
  guard.onList([{ ...originalRow(), nativeSession: { sessionId: RAW_SESSION_ID, epoch: 2 } }]);
  guard.onList([originalRow()]);
  assert.equal(guard.invalid, true, "a reverted disturbance stays latched");
  assert.equal(guard.willServe(validRequest()), false);

  // An identical current row set is a legitimate no-op.
  const intact = makeGuard();
  assert.equal(intact.guard.arm(ARM_NONCE, armFacts()), true);
  intact.guard.onList([originalRow()]);
  assert.equal(intact.guard.invalid, false, "an unchanged owner row is not a disturbance");
});

test("guard latches an owner swap even with identical captions", () => {
  const caption = "identical-caption";
  const rows = (ownerId: string) => ([{
    id: ownerId,
    hasLiveProcess: true,
    lifecycle: "alive",
    nativeSession: { sessionId: RAW_SESSION_ID, epoch: 1, name: caption },
  }]);
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts({ row: rows("owner-A")[0] })), true);
  guard.onList([...rows("owner-A"), ...rows("owner-B")]);
  assert.equal(guard.invalid, false, "both rows present with the armed owner matching is not a disturbance");
  guard.onOwner("owner-B");
  assert.equal(guard.invalid, true, "a different active owner latches even with an identical caption");
  guard.onOwner("owner-A");
  assert.equal(guard.invalid, true, "reverting the owner never repairs the guard");
});

test("guard latches focus off->back transitions and a foreign receiver", () => {
  const sidebar = {};
  const foreign = {};
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts({ sidebar })), true);
  guard.onFocus("main", sidebar);
  assert.equal(guard.invalid, false, "the armed focus on the exact receiver is not a disturbance");
  guard.onFocus("sidebar", sidebar);
  assert.equal(guard.invalid, true, "focus leaving main latches");
  guard.onFocus("main", sidebar);
  assert.equal(guard.invalid, true, "an off->back focus transition stays latched");

  const foreignGuard = makeGuard();
  assert.equal(foreignGuard.guard.arm(ARM_NONCE, armFacts({ sidebar })), true);
  foreignGuard.guard.onFocus("main", foreign);
  assert.equal(foreignGuard.guard.invalid, true, "a foreign focus receiver latches even with the same value");

  const unsupportedGuard = makeGuard();
  assert.equal(unsupportedGuard.guard.arm(ARM_NONCE, armFacts({ sidebar })), true);
  unsupportedGuard.guard.onFocus("bogus", sidebar);
  assert.equal(unsupportedGuard.guard.invalid, true, "an unsupported focus value latches");
});

test("guard latches a resize and refuses geometry drift at serve time", () => {
  const resized = makeGuard();
  assert.equal(resized.guard.arm(ARM_NONCE, armFacts()), true);
  resized.guard.observeResize();
  assert.equal(resized.guard.willServe(validRequest()), false, "an observed resize is a sticky serve refusal");

  const drifted = makeGuard();
  assert.equal(drifted.guard.arm(ARM_NONCE, armFacts()), true);
  drifted.state.columns = 121;
  assert.equal(drifted.guard.willServe(validRequest()), false, "a changed public geometry is refused");

  // A resize before arming is not a disturbance (the guard was unarmed).
  const earlyResize = makeGuard();
  earlyResize.guard.observeResize();
  assert.equal(earlyResize.guard.arm(ARM_NONCE, armFacts()), true);
  assert.equal(earlyResize.guard.willServe(validRequest()), true, "a pre-arm resize never latches");
});

test("guard refuses a changed native PID, incarnation, bootstrap tuple, or exit at serve time", () => {
  const pidDrift = makeGuard();
  assert.equal(pidDrift.guard.arm(ARM_NONCE, armFacts()), true);
  pidDrift.state.binding!.pid = 9999;
  assert.equal(pidDrift.guard.willServe(validRequest()), false, "a changed original native PID is refused");

  const incarnationDrift = makeGuard();
  assert.equal(incarnationDrift.guard.arm(ARM_NONCE, armFacts()), true);
  incarnationDrift.state.binding!.incarnation = 2;
  assert.equal(incarnationDrift.guard.willServe(validRequest()), false, "a changed PTY incarnation is refused");

  const bootstrapDrift = makeGuard();
  assert.equal(bootstrapDrift.guard.arm(ARM_NONCE, armFacts()), true);
  bootstrapDrift.state.binding!.bootstrap = { ...BOOTSTRAP, generation: "1".repeat(32) };
  assert.equal(bootstrapDrift.guard.willServe(validRequest()), false, "a changed consumed bootstrap tuple is refused");

  const exited = makeGuard();
  assert.equal(exited.guard.arm(ARM_NONCE, armFacts()), true);
  exited.state.binding = undefined;
  assert.equal(exited.guard.willServe(validRequest()), false, "an exited or unknown original handle is refused");
});

test("guard refuses self PID drift and a failed scope revalidation", () => {
  const pidDrift = makeGuard();
  assert.equal(pidDrift.guard.arm(ARM_NONCE, armFacts()), true);
  pidDrift.state.pid = 7002;
  assert.equal(pidDrift.guard.willServe(validRequest()), false, "a self PID drift is refused");

  const noScope = makeGuard();
  assert.equal(noScope.guard.arm(ARM_NONCE, armFacts()), true);
  noScope.state.scope = undefined;
  assert.equal(noScope.guard.willServe(validRequest()), false, "a failed current-scope revalidation is refused");

  const epochDrift = makeGuard();
  assert.equal(epochDrift.guard.arm(ARM_NONCE, armFacts()), true);
  epochDrift.state.scope = { sessionId: RAW_SESSION_ID, sessionEpoch: 2 };
  assert.equal(epochDrift.guard.willServe(validRequest()), false, "a changed current session tuple is refused");
});

test("guard refuses a wrong arm nonce or native PID without consuming the serve", () => {
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts()), true);
  assert.equal(guard.willServe(validRequest({ proofNonce: "otherarm0123456789ab" })), false,
    "a request bound to a different arm nonce is refused");
  assert.equal(guard.willServe(validRequest({ expectedOriginalNativePID: 9999 })), false,
    "a request bound to a different original native PID is refused");
  assert.equal(guard.willServe(validRequest({ expectedMainPid: 9999 })), false,
    "a request bound to a different Main PID is refused");
  assert.equal(guard.willServe(validRequest()), true, "an honest refusal never consumes the single serve");

  // A fresh request nonce binds a fresh reply; replay of the served nonce is refused.
  const replayed = makeGuard();
  assert.equal(replayed.guard.arm(ARM_NONCE, armFacts()), true);
  assert.equal(replayed.guard.willServe(validRequest({ nonce: OTHER_REQUEST_NONCE })), true);
  assert.equal(replayed.guard.willServe(validRequest({ nonce: OTHER_REQUEST_NONCE })), false,
    "the single serve is never repeated for a replayed request");
});

test("guard request payload validation is strict", () => {
  assert.equal(guardFixture.isNativeExchangeGuardRequestPayload(validRequest()), true);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing key", (() => { const p = validRequest(); delete p.nonce; return p; })()],
    ["extra key", validRequest({ stray: true })],
    ["schema drift", validRequest({ schemaVersion: 2 })],
    ["short nonce", validRequest({ nonce: "short" })],
    ["bad arm nonce", validRequest({ proofNonce: "x".repeat(129) })],
    ["zero main pid", validRequest({ expectedMainPid: 0 })],
    ["non-integer native pid", validRequest({ expectedOriginalNativePID: 4.5 })],
  ];
  for (const [label, payload] of cases) {
    assert.equal(guardFixture.isNativeExchangeGuardRequestPayload(payload), false, `${label} is refused`);
  }
  assert.equal(guardFixture.isNativeExchangeGuardRequestPayload("not-an-object"), false);
});

// ---------------------------------------------------------------------------
// Composed regression: the pane observer arms the REAL guard through the
// runner's actual callback wiring, and the final exchange certifies.
// ---------------------------------------------------------------------------

function makeComposedFakes() {
  class FakeInstanceManager {
    views: unknown[] = [];
    surfaces: Record<string, unknown> = {};
    list(): unknown[] { return this.views; }
    surface(id: unknown): unknown { return this.surfaces[String(id)]; }
  }
  class FakeSidebarController {
    private focusValue: string;
    private ownerValue: string | undefined;
    constructor(focus: string, owner?: string) {
      this.focusValue = focus;
      this.ownerValue = owner;
    }
    get focus(): string { return this.focusValue; }
    get activeMainOwnerID(): string | undefined { return this.ownerValue; }
    setActiveMainOwner(owner: string | undefined): void { this.ownerValue = owner; }
  }
  class FakeSurface {
    inputModes(): Record<string, unknown> { return { mouseTracking: "any", mouseEncoding: "sgr" }; }
  }
  return { FakeInstanceManager, FakeSidebarController, FakeSurface };
}

/** One composed setup: the exact runner wiring, one complete fresh armed pass. */
function makeComposedSetup() {
  const fakes = makeComposedFakes();
  let observer: ReturnType<typeof paneFixture.createPaneModeObserver> | undefined;
  // The exact runner wiring: the guard's revalidate is the pane observer's
  // fresh current-scope proof, and the observer arms the real guard.
  const guard = guardFixture.createNativeExchangeGuard({
    mainPid: () => MAIN_PID,
    geometry: () => ({ columns: 120, rows: 50 }),
    revalidate: (armed: unknown) => (observer === undefined ? undefined : observer.revalidateScope(armed)),
    bindingLookup: (instanceId: unknown) => instanceId === BOOTSTRAP.instanceId
      ? { pid: NATIVE_PID, incarnation: 1, bootstrap: { ...BOOTSTRAP } }
      : undefined,
  });
  observer = paneFixture.createPaneModeObserver(
    {
      InstanceManager: fakes.FakeInstanceManager,
      SidebarController: fakes.FakeSidebarController,
      TerminalSurface: fakes.FakeSurface,
    },
    {
      nativeBinding: () => ({ ptyPid: NATIVE_PID, incarnation: 1, sessionEpoch: 1, expectedProof: PROOF, bootstrap: { ...BOOTSTRAP } }),
      guard,
    },
  );
  const manager = new fakes.FakeInstanceManager();
  manager.views = [{ id: "owner-A", hasLiveProcess: true, lifecycle: "alive", nativeSession: { sessionId: RAW_SESSION_ID, epoch: 1 } }];
  const surface = new fakes.FakeSurface();
  manager.surfaces = { "owner-A": surface };
  const sidebar = new fakes.FakeSidebarController("main", "owner-A");
  manager.list();
  sidebar.setActiveMainOwner("owner-A");
  observer.snapshot(ARM_NONCE);
  return { guard, observer, manager, sidebar, surface, fakes };
}

test("composed pane observer + real guard certifies one fresh reply through the runner wiring", () => {
  const { guard } = makeComposedSetup();
  assert.equal(guard.armed, true, "the complete fresh pass armed the real guard with its private facts");
  assert.equal(guard.willServe(validRequest()), true,
    "the final exchange certifies through the runner's actual callback wiring");
  const reply = guard.buildGuardReply(REQUEST_NONCE, MAIN_PID);
  const correlated = validateNativeExchangeGuardCorrelation(reply, {
    nonce: REQUEST_NONCE,
    expectedMainPid: MAIN_PID,
    proofNonce: ARM_NONCE,
    expectedOriginalNativePID: NATIVE_PID,
    binding: BINDING,
  });
  assert.ok(correlated !== undefined, "the published reply correlates against the Main census binding");
});

test("observed pane disturbances remain refused after restoration", () => {
  for (const kind of ["surface", "prototype", "shadow", "method"]) {
    const setup = makeComposedSetup();
    let restore: () => void;
    if (kind === "surface") {
      setup.manager.surfaces["owner-A"] = new setup.fakes.FakeSurface();
      restore = () => { setup.manager.surfaces["owner-A"] = setup.surface; };
    } else if (kind === "prototype") {
      Object.setPrototypeOf(setup.surface, Object.create(setup.fakes.FakeSurface.prototype));
      restore = () => { Object.setPrototypeOf(setup.surface, setup.fakes.FakeSurface.prototype); };
    } else if (kind === "shadow") {
      Object.defineProperty(setup.surface, "inputModes", {
        value: () => ({ mouseTracking: "any", mouseEncoding: "sgr" }), configurable: true,
      });
      restore = () => { Reflect.deleteProperty(setup.surface, "inputModes"); };
    } else {
      const original = setup.fakes.FakeSurface.prototype.inputModes;
      setup.fakes.FakeSurface.prototype.inputModes = () => ({ mouseTracking: "any", mouseEncoding: "sgr" });
      restore = () => { setup.fakes.FakeSurface.prototype.inputModes = original; };
    }
    try {
      assert.equal(setup.manager.list(), setup.manager.views);
    } finally {
      restore();
    }
    try {
      assert.equal(setup.guard.willServe(validRequest()), false, kind);
    } finally {
      setup.observer.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Exact single-reply transport through the shared census reply service.
// ---------------------------------------------------------------------------

interface FakeFile { content: string; dev: bigint; ino: bigint; }

class FakePathMap<T> extends Map<string, T> {
  override set(path: string, value: T): this {
    return super.set(normalizeFake(path), value);
  }
  override get(path: string): T | undefined {
    return super.get(normalizeFake(path));
  }
  override has(path: string): boolean {
    return super.has(normalizeFake(path));
  }
}

function normalizeFake(p: string): string {
  let current = p;
  while (current.length > 1 && current.endsWith("/")) current = current.slice(0, -1);
  return current;
}

function makeFakeFs() {
  const dirs = new FakePathMap<{ dev: bigint; ino: bigint }>();
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
      return { dev: dir.dev, ino: dir.ino, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
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
  const setFile = (p: string, content: string): void => {
    files.set(p, { content, dev: 1n, ino: nextIno++ });
  };
  return {
    fsLike,
    files,
    addDir,
    setFile,
    closedCount: () => closedCount,
    fire: (event: string, filename: string): void => { watcherHandlers[event]?.(event, filename); },
  };
}

/** Seeds one typed request-file record with a positive stable identity. */
function seedRequest(fake: ReturnType<typeof makeFakeFs>, payload: Record<string, unknown>): void {
  fake.setFile(pathJoin(GUARD_ROOT, GUARD_REQUEST_FILENAME), JSON.stringify(payload));
}

const GUARD_ROOT = pathJoin("/synthetic", "guard-root");

function seedGuardRoot(fake: ReturnType<typeof makeFakeFs>): void {
  fake.addDir(GUARD_ROOT);
  let current = dirname(GUARD_ROOT);
  for (;;) {
    fake.addDir(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function startGuardService(fake: ReturnType<typeof makeFakeFs>, guard: ReturnType<typeof makeGuard>["guard"]) {
  const service = censusFixture.createCensusReplyService({
    root: GUARD_ROOT,
    mainPid: () => MAIN_PID,
    requestFilename: guardFixture.GUARD_REQUEST_FILENAME,
    replyFilename: guardFixture.GUARD_REPLY_FILENAME,
    isRequestPayload: (payload: unknown) => guardFixture.isNativeExchangeGuardRequestPayload(payload) && guard.willServe(payload),
    buildSnapshot: () => ({}),
    buildReply: (nonce: string, mainPidValue: number) => guard.buildGuardReply(nonce, mainPidValue),
    closeAfterServe: true,
    fs: fake.fsLike,
  });
  service.start();
  return service;
}

test("guard exchange serves exactly one fresh reply through the fixed known leaves with exact-once closure", () => {
  const fake = makeFakeFs();
  seedGuardRoot(fake);
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts()), true);
  const service = startGuardService(fake, guard);

  // A wrong-PID request is an honest refusal: no reply, no closure.
  seedRequest(fake, validRequest({ expectedMainPid: 9999 }));
  fake.fire("change", GUARD_REQUEST_FILENAME);
  assert.equal(fake.files.get(pathJoin(GUARD_ROOT, GUARD_REPLY_FILENAME)), undefined,
    "a wrong-PID request writes no reply leaf");
  assert.equal(fake.closedCount(), 0, "a refused request never closes the channel");

  // The fresh valid request serves exactly one reply.
  seedRequest(fake, validRequest());
  fake.fire("change", GUARD_REQUEST_FILENAME);
  const replyLeaf = fake.files.get(pathJoin(GUARD_ROOT, GUARD_REPLY_FILENAME));
  assert.ok(replyLeaf !== undefined, "the fresh request serves one reply leaf");
  const reply = JSON.parse(replyLeaf!.content.trim());
  const correlated = validateNativeExchangeGuardCorrelation(reply, {
    nonce: REQUEST_NONCE,
    expectedMainPid: MAIN_PID,
    proofNonce: ARM_NONCE,
    expectedOriginalNativePID: NATIVE_PID,
    binding: BINDING,
  });
  assert.ok(correlated !== undefined, "the published reply correlates against the Main census binding");
  assert.equal(fake.closedCount(), 1, "the single served publication closes the owned watcher exactly once");

  // A replayed request after serve finds a closed channel and writes nothing.
  seedRequest(fake, validRequest({ nonce: OTHER_REQUEST_NONCE }));
  fake.fire("change", GUARD_REQUEST_FILENAME);
  assert.equal(fake.files.get(pathJoin(GUARD_ROOT, GUARD_REPLY_FILENAME))!.content, replyLeaf!.content,
    "no second reply is ever published");
  service.close();
  assert.equal(fake.closedCount(), 1, "teardown close does not double-close");
});

test("guard exchange writes no reply and leaves the channel open for a refused guard", () => {
  const fake = makeFakeFs();
  seedGuardRoot(fake);
  const { guard } = makeGuard();
  assert.equal(guard.arm(ARM_NONCE, armFacts()), true);
  guard.onOwner("owner-B"); // sticky disturbance before the exchange
  const service = startGuardService(fake, guard);
  seedRequest(fake, validRequest());
  fake.fire("change", GUARD_REQUEST_FILENAME);
  assert.equal(fake.files.get(pathJoin(GUARD_ROOT, GUARD_REPLY_FILENAME)), undefined,
    "a disturbed guard writes no reply leaf");
  assert.equal(fake.closedCount(), 0, "a refused guard leaves the channel open for teardown");
  service.close();
  assert.equal(fake.closedCount(), 1);
});

test("guard exchange refuses an unarmed guard with no reply leaf", () => {
  const fake = makeFakeFs();
  seedGuardRoot(fake);
  const { guard } = makeGuard();
  // Never armed: the Main census pass never constructed a complete binding.
  const service = startGuardService(fake, guard);
  seedRequest(fake, validRequest());
  fake.fire("change", GUARD_REQUEST_FILENAME);
  assert.equal(fake.files.get(pathJoin(GUARD_ROOT, GUARD_REPLY_FILENAME)), undefined,
    "an unarmed guard never certifies");
  service.close();
});
