import assert from "node:assert/strict";
import test from "node:test";

import type {
  InstanceManagerOptions,
  NativeInstanceView,
  SessionGeometry,
  StatusRegistrar,
} from "../src/session-host/instances";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import type { TerminalFrame, TerminalInputModes, TerminalSurface } from "../src/session-host/terminal-surface";
import {
  createLocalOwningHostService,
  type OwningHostManager,
  type OwningHostService,
  type OwningHostSessionContentSnapshot,
  type OwningHostSessionContentWatch,
} from "../src/session-host/owning-host-service";

/**
 * Focused coverage for the selected-session content watch (#389). Everything
 * here is synthetic: no PTY, real terminal, broker, listener, socket, timer, or
 * file is touched. Every assertion is about what the ONE manager was actually
 * asked for, what the service could truthfully observe, and what a subscriber
 * was able to see.
 */

/** Writable form of one manager row, for mutating this fixture's authoritative state. */
type MutableRow = { -readonly [K in keyof NativeInstanceView]: NativeInstanceView[K] };

/** Writable mirror of a delivered snapshot, used only to prove it cannot be mutated. */
type MutableSnapshot = {
  -readonly [K in keyof OwningHostSessionContentSnapshot]: OwningHostSessionContentSnapshot[K];
};

function nativeSession(id: string, epoch = 1): SessionHostNativeSession {
  return {
    sessionId: id,
    epoch,
    name: `Conversation ${id}`,
    persistence: "saved",
    currentFile: "/private/native-guard/current.jsonl",
  };
}

function rowView(id: string, native = nativeSession(`conversation-${id}`)): MutableRow {
  return {
    id,
    label: `Row ${id}`,
    workspace: "/synthetic/row-workspace",
    agentDir: "/synthetic/agent",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: native,
    hasLiveProcess: true,
    activity: [],
  };
}

/** One visible native frame with generated SGR, styles, cursor, and typed graphics. */
function frame(cols: number, rows: number, text: string): TerminalFrame {
  return {
    cols,
    rows,
    lines: Array.from({ length: rows }, (_, index) => index === 0
      ? `\x1b[0m\x1b[1;34m${text}\x1b[0m`
      : "\x1b[0m\x1b[0m"),
    cursor: { column: 3, row: 1, visible: true },
    styles: [{
      line: 0,
      runs: [{ startColumn: 0, text, bold: true, fg: { mode: "palette", value: 4 } }],
    }],
    graphics: {
      images: [{
        id: "image-1",
        mimeType: "image/png",
        widthPx: 4,
        heightPx: 3,
        base64: "iVBORw0KGgo=",
      }],
      placements: [{
        id: "placement-1",
        imageId: "image-1",
        column: 1,
        row: 1,
        columns: 2,
        rows: 2,
        crop: { x: 0, y: 0, width: 4, height: 3 },
        clip: { leftColumns: 0, topRows: 0, rightColumns: 0, bottomRows: 0 },
      }],
      fallbacks: [{
        id: "fallback-1",
        mimeType: "image/png",
        widthPx: 4,
        heightPx: 3,
        column: 4,
        row: 2,
        columns: 2,
        rows: 1,
        clip: { leftColumns: 0, topRows: 0, rightColumns: 1, bottomRows: 0 },
      }],
    },
  };
}

function inputModes(overrides: Partial<TerminalInputModes> = {}): TerminalInputModes {
  return {
    kittyFlags: 3,
    applicationCursorKeys: true,
    applicationKeypad: false,
    bracketedPaste: true,
    mouseTracking: "drag",
    modifyOtherKeys: 2,
    mouseEncoding: "sgr",
    ...overrides,
  };
}

/** One synthetic terminal surface that returns its own mutable frame/modes. */
class ContentSurface {
  frameValue: TerminalFrame;
  modes: TerminalInputModes;
  /**
   * Set while a native synchronized frame is held. `inputModes()` then withholds
   * mouse reporting exactly as the real surface does, while `publishedInputModes()`
   * reports the facts captured with the committed frame (#500).
   */
  committed: TerminalInputModes | undefined;
  frameCalls = 0;
  modesCalls = 0;
  frameThrows = false;
  modesThrows = false;
  /** Model a surface whose redraw observer cannot be installed, and one that cannot answer. */
  throwOnRedrawObserver = false;
  throwOnRedrawHeld = false;
  /**
   * Models a grounded pipeline (failed parse or disposal): the real surface answers
   * `"unavailable"`, which an owner must treat as cancel-everything, never as ready.
   */
  grounded = false;
  /** Observers of the end of a held frame, as the real surface keeps them. */
  readonly redrawObservers = new Set<() => void>();

  constructor(frameValue: TerminalFrame, modes: TerminalInputModes = inputModes()) {
    this.frameValue = frameValue;
    this.modes = modes;
  }

  frame(): TerminalFrame {
    this.frameCalls += 1;
    if (this.frameThrows) throw new Error("synthetic frame failure");
    // The live reference is returned on purpose: whatever isolation a snapshot
    // enjoys has to come from the service copying it.
    return this.frameValue;
  }

  inputModes(): TerminalInputModes {
    this.modesCalls += 1;
    if (this.modesThrows) throw new Error("synthetic input-mode failure");
    if (this.committed !== undefined) return { ...this.modes, mouseTracking: "none" };
    return this.modes;
  }

  /** The mode facts that belong with the last complete committed frame. */
  publishedInputModes(): TerminalInputModes {
    this.modesCalls += 1;
    if (this.modesThrows) throw new Error("synthetic input-mode failure");
    return this.committed !== undefined ? { ...this.committed } : { ...this.modes };
  }

  redrawState(): "clear" | "held" | "unavailable" {
    if (this.throwOnRedrawHeld) throw new Error("synthetic redraw-state failure");
    if (this.grounded) return "unavailable";
    return this.committed !== undefined ? "held" : "clear";
  }

  onRedrawSettled(listener: () => void): () => void {
    if (this.throwOnRedrawObserver) throw new Error("synthetic redraw-observer failure");
    this.redrawObservers.add(listener);
    return () => this.redrawObservers.delete(listener);
  }

  /** Model the child opening a synchronized frame over `committed` frame facts. */
  beginRedraw(committed: TerminalInputModes): void {
    this.committed = committed;
  }

  /**
   * Model a hold ending for any reason. `settled` is the child's live state after
   * the frame; omitting it ends the frame with nothing visually or mode-wise
   * changed, which is the case a change notification alone never reports.
   */
  endRedraw(settled?: TerminalInputModes): void {
    if (this.committed === undefined) return;
    this.committed = undefined;
    if (settled !== undefined) this.modes = settled;
    for (const listener of [...this.redrawObservers]) listener();
  }
}

/**
 * The synthetic authoritative manager for this seam. It owns mutable rows,
 * per-row surfaces, and per-row canonical geometry; `list()` deliberately hands
 * out row copies whose mutable payloads are still shared, and it publishes a
 * caller-installed change from inside a listing in flight, exactly where a
 * reentrant change can really be observed.
 */
class ContentManager {
  readonly receivedOptions: InstanceManagerOptions[] = [];
  readonly rows: MutableRow[] = [];
  readonly surfaces = new Map<string, ContentSurface>();
  readonly geometry = new Map<string, SessionGeometry>();
  /** Every non-observation operation anyone attempted. */
  readonly mutatorCalls: string[] = [];
  readonly surfaceReads: string[] = [];
  readonly geometryReads: string[] = [];
  listCalls = 0;
  listThrows = false;
  surfaceThrows = false;
  geometryThrows = false;
  /** Runs once, after the rows were read and before `list()` returns. */
  listHook: (() => void) | undefined;
  #hostChange: ((instanceId: string) => void) | undefined;

  openManager(options: InstanceManagerOptions): void {
    this.receivedOptions.push(options);
    this.#hostChange = options.onChange;
  }

  /** Mirror the manager's own notification path, including its containment. */
  emitChange(instanceId: string): void {
    try {
      this.#hostChange?.(instanceId);
    } catch {
      // The real manager contains host change-hook failures; so does this fixture.
    }
  }

  list(): NativeInstanceView[] {
    this.listCalls += 1;
    if (this.listThrows) throw new Error("synthetic listing failure");
    const views = this.rows.map((row) => Object.freeze({ ...row, activity: Object.freeze([...row.activity]) }));
    const hook = this.listHook;
    if (hook !== undefined) {
      // These views were read before a change that is about to be published.
      this.listHook = undefined;
      hook();
    }
    return views;
  }

  surface(id: string): TerminalSurface | undefined {
    this.surfaceReads.push(id);
    if (this.surfaceThrows) throw new Error("synthetic surface failure");
    return this.surfaces.get(id) as unknown as TerminalSurface | undefined;
  }

  instanceGeometry(id: string): SessionGeometry | undefined {
    this.geometryReads.push(id);
    if (this.geometryThrows) throw new Error("synthetic geometry failure");
    return this.geometry.get(id);
  }

  // Everything below is recorded and never needed by a content observation.
  create(): Promise<string> { this.mutatorCalls.push("create"); return Promise.resolve("never"); }
  write(): void { this.mutatorCalls.push("write"); }
  resize(): void { this.mutatorCalls.push("resize"); }
  rename(): void { this.mutatorCalls.push("rename"); }
  stop(): void { this.mutatorCalls.push("stop"); }
  closeExited(): boolean { this.mutatorCalls.push("closeExited"); return false; }
  closeError(): boolean { this.mutatorCalls.push("closeError"); return false; }
  openViewer(): undefined { this.mutatorCalls.push("openViewer"); return undefined; }
  viewerState(): undefined { this.mutatorCalls.push("viewerState"); return undefined; }
  sessionViewers(): readonly never[] { this.mutatorCalls.push("sessionViewers"); return []; }
  updateViewer(): never { this.mutatorCalls.push("updateViewer"); throw new Error("unreachable"); }
  closeViewer(): boolean { this.mutatorCalls.push("closeViewer"); return false; }
  setInitialGeometry(): void { this.mutatorCalls.push("setInitialGeometry"); }
  hasLiveProcesses(): boolean { return this.rows.some((row) => row.hasLiveProcess); }
  ownedLiveSessions(): readonly never[] { return []; }
  async shutdown(): Promise<{ forcedIds: string[]; remainingIds: string[] }> {
    this.mutatorCalls.push("shutdown");
    return { forcedIds: [], remainingIds: [] };
  }
  async dispose(): Promise<void> { this.mutatorCalls.push("dispose"); }

  asManager(): OwningHostManager {
    return this as unknown as OwningHostManager;
  }
}

interface Harness {
  readonly manager: ContentManager;
  readonly service: OwningHostService;
  /** Ids the host's own manager change hook actually received. */
  readonly hostChanges: string[];
  beginTeardown(): void;
}

function harness(options: { open?: boolean } = {}): Harness {
  const manager = new ContentManager();
  const registrar: StatusRegistrar = {
    register: () => { throw new Error("content observation never registers a reporter"); },
  };
  const hostChanges: string[] = [];
  let teardown = false;
  const service = createLocalOwningHostService({
    createManager: (managerOptions) => {
      manager.openManager(managerOptions);
      return manager.asManager();
    },
    teardownRequested: () => teardown,
  });
  if (options.open !== false) {
    service.openManager({
      packageRoot: "/synthetic/package",
      piExecutable: "/synthetic/pi",
      statusRegistrar: registrar,
      cols: 100,
      rows: 30,
      onChange: (instanceId: string) => { hostChanges.push(instanceId); },
    } as InstanceManagerOptions);
  }
  return {
    manager,
    service,
    hostChanges,
    beginTeardown: () => { teardown = true; },
  };
}

/** Seed one row, its surface, and its canonical geometry in the fake manager. */
function seed(
  manager: ContentManager,
  id: string,
  cols = 9,
  rows = 4,
  text = "visible native chat",
): { readonly row: MutableRow; readonly surface: ContentSurface } {
  const row = rowView(id);
  manager.rows.push(row);
  const surface = new ContentSurface(frame(cols, rows, text));
  manager.surfaces.set(id, surface);
  manager.geometry.set(id, { cols, rows, revision: 4 });
  return { row, surface };
}

function freezeCheck(value: unknown, what: string): void {
  assert.ok(Object.isFrozen(value), `${what} must be frozen`);
}

test("a content watch observes the exact native tuple, frame, styles, graphics, modes, and geometry", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 9, 4, "visible native chat");
  const modes = inputModes();
  surface.modes = modes;

  const calls: (OwningHostSessionContentSnapshot | undefined)[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => { calls.push(snapshot); });
  assert.ok(watch);
  const snapshot = watch.snapshot;

  assert.equal(snapshot.hostRunId, h.service.readInventorySnapshot()?.hostRunId,
    "the content watch reuses this host run's existing identity");
  assert.equal(snapshot.sessionId, "row-1", "the session id is the owning manager's row id");
  assert.ok(Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 1);
  assert.deepEqual(snapshot.nativeSession, { sessionId: "conversation-row-1", epoch: 1 });
  assert.deepEqual(Object.keys(snapshot.nativeSession ?? {}).sort(), ["epoch", "sessionId"],
    "only the allowlisted native tuple crosses the seam");
  assert.equal("currentFile" in (snapshot.nativeSession ?? {}), false,
    "the private current-file guard fact is never exported");
  assert.equal("persistence" in (snapshot.nativeSession ?? {}), false);
  assert.equal("name" in (snapshot.nativeSession ?? {}), false);
  assert.deepEqual(Object.keys(snapshot).sort(),
    ["frame", "geometry", "hostRunId", "inputModes", "nativeSession", "sequence", "sessionId"],
    "the snapshot is content, not a row view with workspace/agent/lifecycle facts");

  assert.deepEqual(snapshot.geometry, { cols: 9, rows: 4, revision: 4 });
  assert.deepEqual(snapshot.frame, frame(9, 4, "visible native chat"));
  assert.equal(snapshot.frame.lines[0], "\x1b[0m\x1b[1;34mvisible native chat\x1b[0m",
    "generated SGR is observed verbatim, never stripped");
  assert.deepEqual(snapshot.frame.styles?.[0]?.runs[0], {
    startColumn: 0,
    text: "visible native chat",
    bold: true,
    fg: { mode: "palette", value: 4 },
  });
  assert.equal(snapshot.frame.graphics?.images[0]?.base64, "iVBORw0KGgo=",
    "the canonical base64 graphics payload is preserved");
  assert.equal(snapshot.frame.graphics?.placements.length, 1);
  assert.equal(snapshot.frame.graphics?.fallbacks.length, 1,
    "payload-free fallbacks are not dropped");
  assert.deepEqual(snapshot.inputModes, modes);

  assert.equal(calls.length, 0, "installation returns the snapshot; it is not re-delivered as a callback");
  assert.equal(surface.frameCalls, 1, "installation captures the frame exactly once");
  assert.equal(surface.modesCalls, 1, "installation captures the input modes exactly once");
  assert.deepEqual(h.manager.mutatorCalls, [],
    "observation never spawns, writes, resizes, renames, stops, removes, or touches a viewer");
  assert.deepEqual(h.hostChanges, [], "observation publishes no host change");
});

test("content snapshots are deeply frozen copies isolated from the surface and from each other", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 6, 2, "before");
  const first: OwningHostSessionContentSnapshot[] = [];
  const second: OwningHostSessionContentSnapshot[] = [];
  const a = h.service.watchSessionContent("row-1", (snapshot) => { if (snapshot) first.push(snapshot); });
  const b = h.service.watchSessionContent("row-1", (snapshot) => { if (snapshot) second.push(snapshot); });
  assert.ok(a);
  assert.ok(b);

  h.manager.emitChange("row-1");
  assert.equal(first.length, 1, "one row change is one notification per watch");
  assert.equal(second.length, 1);
  const held = first[0];
  const other = second[0];
  assert.ok(held);
  assert.ok(other);
  assert.equal(held, other, "the affected watches share one capture, not one per watch");
  assert.deepEqual(held, other);

  freezeCheck(held, "snapshot");
  freezeCheck(held.geometry, "geometry");
  freezeCheck(held.frame, "frame");
  freezeCheck(held.frame.lines, "frame lines");
  freezeCheck(held.frame.cursor, "cursor");
  freezeCheck(held.frame.styles, "style rows");
  const styleRow = held.frame.styles?.[0];
  assert.ok(styleRow);
  freezeCheck(styleRow, "style row");
  freezeCheck(styleRow.runs, "style runs");
  const run = styleRow.runs[0];
  assert.ok(run);
  freezeCheck(run, "style run");
  freezeCheck(run.fg, "run foreground");
  freezeCheck(held.frame.graphics, "graphics");
  freezeCheck(held.frame.graphics?.images, "graphics images");
  freezeCheck(held.frame.graphics?.images[0], "graphics image");
  freezeCheck(held.frame.graphics?.placements, "graphics placements");
  freezeCheck(held.frame.graphics?.placements[0], "graphics placement");
  freezeCheck(held.frame.graphics?.placements[0]?.crop, "graphics crop");
  freezeCheck(held.frame.graphics?.placements[0]?.clip, "graphics clip");
  freezeCheck(held.frame.graphics?.fallbacks, "graphics fallbacks");
  freezeCheck(held.frame.graphics?.fallbacks[0], "graphics fallback");
  freezeCheck(held.frame.graphics?.fallbacks[0]?.clip, "fallback clip");
  freezeCheck(held.inputModes, "input modes");
  freezeCheck(held.nativeSession, "native tuple");

  assert.throws(() => { (held as MutableSnapshot).sessionId = "row-2"; }, TypeError);
  assert.throws(() => { (held.frame.lines as string[]).push("injected"); }, TypeError);
  assert.throws(() => {
    (held.frame.graphics as unknown as { images: unknown[] }).images.push({});
  }, TypeError);
  assert.throws(() => { (run as { text: string }).text = "rewritten"; }, TypeError);

  // The owner's surface is not frozen by observation, and mutating it cannot
  // rewrite a snapshot a subscriber is still holding.
  assert.equal(Object.isFrozen(surface.frameValue), false, "observation never freezes the owner's live frame");
  assert.equal(Object.isFrozen(surface.frameValue.lines), false);
  const mutable = surface.frameValue as unknown as {
    lines: string[];
    styles?: { runs: { text: string; fg?: { value: number } }[] }[];
    graphics?: { images: { base64: string }[] };
  };
  mutable.lines[0] = "surface rewrite";
  mutable.styles![0]!.runs[0]!.text = "surface run";
  mutable.styles![0]!.runs[0]!.fg!.value = 9;
  mutable.graphics!.images[0]!.base64 = "surface payload";
  assert.equal(held.frame.lines[0], "\x1b[0m\x1b[1;34mbefore\x1b[0m");
  assert.equal(held.frame.styles?.[0]?.runs[0]?.text, "before");
  assert.equal(held.frame.styles?.[0]?.runs[0]?.fg?.value, 4);
  assert.equal(held.frame.graphics?.images[0]?.base64, "iVBORw0KGgo=");
  assert.deepEqual(other, held, "another subscriber's identical snapshot is unchanged too");
});

test("only the affected row is captured: no unrelated frame work and no inactive-row geometry reads", () => {
  const h = harness();
  const one = seed(h.manager, "row-1");
  const two = seed(h.manager, "row-2");

  // Nobody watches anything: no listing and no frame work at all.
  const listsBefore = h.manager.listCalls;
  for (let index = 0; index < 5; index += 1) h.manager.emitChange("row-1");
  assert.equal(h.manager.listCalls, listsBefore, "unwatched churn captures nothing");
  assert.equal(one.surface.frameCalls, 0);
  assert.equal(two.surface.frameCalls, 0);

  // An inventory watch alone never asks a surface for a frame.
  const inventorySeen: number[] = [];
  const inventory = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) inventorySeen.push(snapshot.revision);
  });
  assert.ok(inventory);
  h.manager.emitChange("row-1");
  h.manager.emitChange("row-2");
  assert.equal(inventorySeen.length, 2);
  assert.equal(one.surface.frameCalls, 0, "inventory observation never reads a frame");
  assert.equal(two.surface.frameCalls, 0);

  const seen: (OwningHostSessionContentSnapshot | undefined)[] = [];
  const watch = h.service.watchSessionContent("row-2", (snapshot) => { seen.push(snapshot); });
  assert.ok(watch);
  const listCallsAfterInstall = h.manager.listCalls;
  const geometryReadsAfterInstall = [...h.manager.geometryReads];
  const surfaceReadsAfterInstall = [...h.manager.surfaceReads];
  const oneFramesAfterInstall = one.surface.frameCalls;
  const twoFramesAfterInstall = two.surface.frameCalls;
  assert.equal(twoFramesAfterInstall, 1, "installation captured its own row once");

  h.manager.emitChange("row-1");
  assert.equal(seen.length, 0, "a change to another row is not this watch's news");
  assert.equal(one.surface.frameCalls, oneFramesAfterInstall, "an unrelated row is never framed");
  assert.equal(two.surface.frameCalls, twoFramesAfterInstall, "an inactive row is never framed");
  assert.deepEqual(h.manager.geometryReads, geometryReadsAfterInstall,
    "an unrelated row's geometry is never read");
  assert.deepEqual(h.manager.surfaceReads, surfaceReadsAfterInstall,
    "an unrelated row's surface is never read");
  assert.equal(h.manager.listCalls, listCallsAfterInstall + 1,
    "only the inventory capture listed for that change");

  h.manager.emitChange("row-2");
  assert.equal(seen.length, 1);
  assert.equal(two.surface.frameCalls, twoFramesAfterInstall + 1,
    "the affected row is captured exactly once per change");
  assert.equal(one.surface.frameCalls, oneFramesAfterInstall);
  assert.deepEqual(h.manager.geometryReads.slice(geometryReadsAfterInstall.length), ["row-2"]);
  assert.deepEqual(h.manager.surfaceReads.slice(surfaceReadsAfterInstall.length), ["row-2"]);

  inventory.unsubscribe();
  watch.unsubscribe();
  const quietLists = h.manager.listCalls;
  const quietFrames = two.surface.frameCalls;
  h.manager.emitChange("row-2");
  assert.equal(h.manager.listCalls, quietLists, "a retired watch stops capturing");
  assert.equal(two.surface.frameCalls, quietFrames);
});

test("a geometry and native epoch change on the same row is observed with strictly newer facts", () => {
  const h = harness();
  const { row, surface } = seed(h.manager, "row-1", 6, 2, "first");
  const seen: OwningHostSessionContentSnapshot[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => { if (snapshot) seen.push(snapshot); });
  assert.ok(watch);

  row.nativeSession = nativeSession("conversation-row-1", 2);
  const resized = frame(10, 5, "resized");
  surface.frameValue = resized;
  h.manager.geometry.set("row-1", { cols: 10, rows: 5, revision: 9 });
  h.manager.emitChange("row-1");

  assert.equal(seen.length, 1);
  const next = seen[0];
  assert.ok(next);
  assert.deepEqual(next.geometry, { cols: 10, rows: 5, revision: 9 });
  assert.deepEqual(next.nativeSession, { sessionId: "conversation-row-1", epoch: 2 });
  assert.deepEqual(next.frame, resized);
  assert.ok(next.sequence > watch.snapshot.sequence, "a later capture never reuses a sequence");
  assert.deepEqual(watch.snapshot.nativeSession, { sessionId: "conversation-row-1", epoch: 1 },
    "the install snapshot keeps the facts it captured");
  assert.equal(watch.snapshot.frame.cols, 6);
  assert.deepEqual(h.manager.mutatorCalls, []);
});

test("unobservable content is reported as unavailable, never fabricated", () => {
  const unopened = harness({ open: false });
  assert.equal(unopened.service.watchSessionContent("row-1", () => { /* refused */ }), undefined,
    "no manager means no content watch");
  assert.deepEqual(unopened.manager.surfaceReads, []);
  assert.deepEqual(unopened.manager.geometryReads, []);

  const h = harness();
  const { row, surface } = seed(h.manager, "row-1");
  const seen: (OwningHostSessionContentSnapshot | undefined)[] = [];
  const sequences: number[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => {
    seen.push(snapshot);
    if (snapshot !== undefined) sequences.push(snapshot.sequence);
  });
  assert.ok(watch);

  h.manager.geometry.delete("row-1");
  h.manager.emitChange("row-1");
  assert.equal(seen[0], undefined, "a missing geometry is unknown, not a default size");

  h.manager.geometry.set("row-1", { cols: 9, rows: 4, revision: 4 });
  h.manager.surfaces.delete("row-1");
  h.manager.emitChange("row-1");
  assert.equal(seen[1], undefined, "a missing surface is unknown, not an empty frame");

  h.manager.surfaces.set("row-1", surface);
  h.manager.rows.splice(h.manager.rows.indexOf(row), 1);
  h.manager.emitChange("row-1");
  assert.equal(seen[2], undefined, "a missing row is unavailable, never proof of process exit");
  assert.equal(h.service.watchSessionContent("row-1", () => { assert.fail("no install on a missing row"); }), undefined,
    "an unobservable row installs nothing");

  h.manager.rows.push(row);
  h.manager.emitChange("row-1");
  const recovered = seen[3];
  assert.ok(recovered, "the still-installed watch observes the row again");
  assert.deepEqual(recovered.nativeSession, { sessionId: "conversation-row-1", epoch: 1 });
  assert.ok(recovered.sequence > watch.snapshot.sequence,
    "unavailable captures consume no sequence, and a recovery is still newer");

  surface.frameThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen[4], undefined, "a throwing frame read is unavailable");
  surface.frameThrows = false;

  surface.modesThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen[5], undefined, "a throwing input-mode read is unavailable");
  surface.modesThrows = false;

  h.manager.surfaceThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen[6], undefined, "a throwing surface read is unavailable");
  assert.equal(h.service.watchSessionContent("row-1", () => { assert.fail("no install"); }), undefined);
  h.manager.surfaceThrows = false;

  h.manager.geometryThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen[7], undefined, "a throwing geometry read is unavailable");
  h.manager.geometryThrows = false;

  h.manager.listThrows = true;
  h.manager.emitChange("row-1");
  assert.equal(seen[8], undefined, "a throwing row listing is unavailable");
  h.manager.listThrows = false;

  h.beginTeardown();
  h.manager.emitChange("row-1");
  assert.equal(seen[9], undefined, "a closing host is unavailable");
  assert.equal(h.service.watchSessionContent("row-1", () => { assert.fail("no install"); }), undefined,
    "a closing host installs no watch");

  assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
  assert.deepEqual(sequences, [...new Set(sequences)], "no sequence is reused");
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(sequences[index]! > sequences[index - 1]!, "delivered sequences never regress");
  }
  assert.deepEqual(h.manager.mutatorCalls, [], "every unavailable state is still observation only");
});

test("a frame whose size disagrees with the canonical geometry is refused, never resized or padded", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 8, 3);
  h.manager.geometry.set("row-1", { cols: 8, rows: 4, revision: 5 });
  assert.equal(h.service.watchSessionContent("row-1", () => { assert.fail("no install"); }), undefined,
    "an incoherent install captures no snapshot and installs nothing");
  assert.equal(surface.frameCalls, 1, "the frame was read and refused, not silently resized");

  h.manager.geometry.set("row-1", { cols: 8, rows: 3, revision: 5 });
  const seen: (OwningHostSessionContentSnapshot | undefined)[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => { seen.push(snapshot); });
  assert.ok(watch);
  assert.equal(watch.snapshot.frame.rows, 3);

  // The canonical geometry moved without the surface: the two facts disagree.
  h.manager.geometry.set("row-1", { cols: 9, rows: 3, revision: 6 });
  h.manager.emitChange("row-1");
  assert.deepEqual(seen, [undefined],
    "a mismatched frame is reported unavailable instead of mixing a frame with another geometry");
  assert.equal(h.service.readSessionGeometry("row-1")?.cols, 9,
    "the manager's own canonical geometry is unchanged by observation");
  assert.deepEqual(h.manager.mutatorCalls, []);
});

test("a change during a capture is retained and delivered as one coherent newer observation", () => {
  const h = harness();
  const { row, surface } = seed(h.manager, "row-1", 8, 3, "before");
  const seen: OwningHostSessionContentSnapshot[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => { if (snapshot) seen.push(snapshot); });
  assert.ok(watch);

  // A real change lands while a capture's listing is still in flight: its views
  // are already older than the row and surface the change just produced.
  h.manager.listHook = () => {
    row.nativeSession = nativeSession("conversation-row-1", 2);
    surface.frameValue = frame(8, 3, "during");
    h.manager.emitChange("row-1");
  };
  h.manager.emitChange("row-1");

  assert.equal(seen.length, 1, "only the coherent capture is delivered, exactly once");
  assert.deepEqual(seen[0]?.nativeSession, { sessionId: "conversation-row-1", epoch: 2 },
    "the tuple is not older than the frame it is published with");
  assert.deepEqual(seen[0]?.frame, frame(8, 3, "during"));
  assert.ok(seen[0]!.sequence > watch.snapshot.sequence);
  assert.deepEqual(h.hostChanges, ["row-1", "row-1"],
    "both manager changes still reach the host's own hook exactly once");
});

test("a change during an install capture becomes the new watch's first notification", () => {
  const h = harness();
  const { row, surface } = seed(h.manager, "row-1", 8, 3, "before");
  const seen: number[] = [];
  h.manager.listHook = () => {
    row.nativeSession = nativeSession("conversation-row-1", 2);
    surface.frameValue = frame(8, 3, "during");
    h.manager.emitChange("row-1");
  };
  const watch = h.service.watchSessionContent("row-1", (snapshot) => {
    assert.ok(snapshot);
    seen.push(snapshot.sequence);
    assert.deepEqual(snapshot.frame, frame(8, 3, "during"));
  });
  assert.ok(watch);
  assert.equal(watch.snapshot.nativeSession?.epoch, 2,
    "the install snapshot is the coherent post-change capture");
  assert.deepEqual(watch.snapshot.frame, frame(8, 3, "during"));
  assert.equal(seen.length, 1, "the retained change is the first callback, not a duplicate install callback");
  assert.ok(seen[0]! > watch.snapshot.sequence, "the first notification is a newer capture");
  assert.deepEqual(h.hostChanges, ["row-1"], "the change reached the host hook exactly once");
  assert.equal(h.manager.listCalls, 3,
    "one superseded attempt, one coherent retry, and one retained delivery: no retry loop");
});

test("reentrant watches, retirement, and listener failures cannot lose, retarget, or reorder deliveries", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 8, 3, "initial");
  const trail: string[] = [];
  let installed: OwningHostSessionContentWatch | undefined;
  let toRetire: OwningHostSessionContentWatch | undefined;
  let reentered = false;

  const first = h.service.watchSessionContent("row-1", (snapshot) => {
    trail.push(`first:${snapshot?.sequence ?? "unavailable"}`);
    if (reentered) return;
    reentered = true;
    // Retire a watch selected for this same delivery, and install a new one
    // whose initial snapshot already reflects the current surface.
    toRetire?.unsubscribe();
    installed = h.service.watchSessionContent("row-1", (next) => {
      trail.push(`installed:${next?.sequence ?? "unavailable"}`);
    });
  });
  const second = h.service.watchSessionContent("row-1", (snapshot) => {
    trail.push(`second:${snapshot?.sequence ?? "unavailable"}`);
  });
  toRetire = h.service.watchSessionContent("row-1", (snapshot) => {
    trail.push(`retired:${snapshot?.sequence ?? "unavailable"}`);
  });
  assert.ok(first);
  assert.ok(second);
  assert.ok(toRetire);

  h.manager.emitChange("row-1");
  assert.equal(trail.length, 2, "only watches live at selection time were called");
  assert.ok(trail[0]?.startsWith("first:"));
  assert.ok(trail[1]?.startsWith("second:"));
  assert.equal(trail.some((entry) => entry.startsWith("retired:")), false,
    "a watch retired by an earlier listener in the same pass is never resurrected");
  assert.equal(trail.some((entry) => entry.startsWith("installed:")), false,
    "a watch installed mid-pass already has its install snapshot and gets no in-flight callback");
  assert.ok(installed);

  trail.length = 0;
  surface.frameValue = frame(8, 3, "later");
  h.manager.emitChange("row-1");
  assert.equal(trail.length, 3);
  const firstSequence = Number(trail[0]?.split(":")[1]);
  const secondSequence = Number(trail[1]?.split(":")[1]);
  const installedSequence = Number(trail[2]?.split(":")[1]);
  assert.equal(secondSequence, firstSequence, "one change is one shared capture");
  assert.equal(installedSequence, firstSequence);
  assert.ok(installedSequence > installed.snapshot.sequence,
    "the reentrantly installed watch only ever moves forward");

  // A throwing listener never starves another watcher or skips the host hook.
  const survivor: number[] = [];
  const throwing = h.service.watchSessionContent("row-1", () => { throw new Error("listener failure"); });
  const after = h.service.watchSessionContent("row-1", (snapshot) => {
    if (snapshot !== undefined) survivor.push(snapshot.sequence);
  });
  assert.ok(throwing);
  assert.ok(after);
  assert.doesNotThrow(() => h.manager.emitChange("row-1"));
  assert.equal(survivor.length, 1, "a throwing watcher cannot starve another watcher");
  assert.deepEqual(h.hostChanges, ["row-1", "row-1", "row-1"],
    "every change still reached the host hook exactly once");
  assert.deepEqual(h.manager.mutatorCalls, [], "no watch failure stops, closes, or restarts a session");

  first.unsubscribe();
  first.unsubscribe();
  second.unsubscribe();
  installed.unsubscribe();
  throwing.unsubscribe();
  after.unsubscribe();
  const quiet = h.manager.listCalls;
  h.manager.emitChange("row-1");
  assert.equal(h.manager.listCalls, quiet, "retirement is idempotent and a retired watch captures nothing");
});

test("inventory snapshots, host callbacks, and content watches coexist without changing each other", () => {
  const h = harness();
  seed(h.manager, "row-1");
  const inventorySeen: number[] = [];
  const contentSeen: number[] = [];
  const inventory = h.service.watchInventory((snapshot) => {
    if (snapshot !== undefined) inventorySeen.push(snapshot.revision);
  });
  const content = h.service.watchSessionContent("row-1", (snapshot) => {
    if (snapshot !== undefined) contentSeen.push(snapshot.sequence);
  });
  assert.ok(inventory);
  assert.ok(content);

  h.manager.emitChange("row-1");
  assert.equal(inventorySeen.length, 1, "one change is one inventory notification");
  assert.equal(contentSeen.length, 1, "one change is one content notification");
  assert.deepEqual(h.hostChanges, ["row-1"], "the host's own hook still runs exactly once per change");

  const inventorySnapshot = h.service.readInventorySnapshot();
  assert.ok(inventorySnapshot);
  assert.deepEqual(inventorySnapshot.rows.map((row) => row.id), ["row-1"]);
  assert.equal(inventorySnapshot.hostRunId, content.snapshot.hostRunId,
    "inventory and content share the one run identity");
  assert.equal(h.manager.receivedOptions.length, 1, "content observation never opens a second manager");
  assert.deepEqual(h.manager.mutatorCalls, []);

  inventory.unsubscribe();
  content.unsubscribe();
});

test("a content watcher that mutates on every notification stays bounded and never repeats a sequence", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 8, 3, "initial");
  const storm: number[] = [];
  let mutations = 0;
  const pathological = h.service.watchSessionContent("row-1", (snapshot) => {
    if (snapshot !== undefined) storm.push(snapshot.sequence);
    // Pathological consumer: mutates the authoritative row on every notice.
    mutations += 1;
    surface.frameValue = frame(8, 3, `pass-${mutations}`);
    h.manager.emitChange("row-1");
  });
  assert.ok(pathological);
  assert.doesNotThrow(() => h.manager.emitChange("row-1"),
    "one manager change cannot trap the host inside content delivery");

  assert.ok(mutations > 1, "the watcher-driven feedback really started");
  assert.ok(storm.length <= 9, `re-delivery stays bounded (${storm.length} deliveries)`);
  assert.equal(mutations, storm.length,
    "every delivery caused exactly one further mutation, so the bound is what stopped the loop");
  assert.deepEqual(storm, [...new Set(storm)], "no sequence is reused");
  for (let index = 1; index < storm.length; index += 1) {
    assert.ok(storm[index]! > storm[index - 1]!, "delivered sequences never regress");
  }

  // The bounded drain stops with the newest change still retained; that
  // observation reaches the next watch instead of being lost.
  pathological.unsubscribe();
  const catchUp: OwningHostSessionContentSnapshot[] = [];
  const watcher = h.service.watchSessionContent("row-1", (snapshot) => {
    if (snapshot !== undefined) catchUp.push(snapshot);
  });
  assert.ok(watcher);
  assert.equal(catchUp.length, 1, "the retained observation is delivered forward exactly once");
  assert.deepEqual(catchUp[0]?.frame, frame(8, 3, `pass-${mutations}`),
    "the catch-up watch sees the newest content, not the state one mutation behind");
  assert.ok(catchUp[0]!.sequence > (storm[storm.length - 1] ?? 0),
    "the catch-up capture is newer than every bounded delivery");
  watcher.unsubscribe();
});

test("an unavailable native tuple stays null while the visible content is still observed", () => {
  const h = harness();
  const { row } = seed(h.manager, "row-1", 5, 2, "chat without a binding");
  row.nativeSession = null;
  const watch = h.service.watchSessionContent("row-1", () => { /* observation only */ });
  assert.ok(watch);
  assert.equal(watch.snapshot.nativeSession, null, "an unknown native binding is null, never invented");
  assert.equal(watch.snapshot.frame.lines[0], "\x1b[0m\x1b[1;34mchat without a binding\x1b[0m",
    "the ordinary visible content is still observed");
  assert.deepEqual(watch.snapshot.geometry, { cols: 5, rows: 2, revision: 4 });
});

test("a non-callable content listener is refused instead of silently watching nothing", () => {
  const h = harness();
  seed(h.manager, "row-1");
  assert.throws(
    () => h.service.watchSessionContent("row-1", undefined as unknown as () => void),
    /requires a listener function/,
  );
  assert.deepEqual(h.manager.surfaceReads, [], "the refusal captures nothing");
  assert.deepEqual(h.manager.geometryReads, []);
  assert.ok(h.service.watchInventory(() => { /* a real inventory watch still installs */ }));
});

test("a published snapshot pairs the committed frame's modes, never the mid-frame withholding", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 9, 4, "committed frame");
  const committed = inputModes({ mouseTracking: "any" });
  surface.modes = committed;
  const delivered: OwningHostSessionContentSnapshot[] = [];
  const watch = h.service.watchSessionContent("row-1", (snapshot) => {
    if (snapshot !== undefined) delivered.push(snapshot);
  });
  assert.ok(watch);
  assert.deepEqual(watch.snapshot.inputModes, committed, "an idle surface publishes its live modes");

  // The child opens a synchronized redraw. Its live request now differs, and the
  // surface withholds mouse routing locally, while the screen still shows the
  // committed frame. What is published beside that frame must be the frame's own
  // facts, not a mode the viewer was never shown (#500).
  surface.beginRedraw(committed);
  surface.modes = inputModes({ mouseTracking: "none", modifyOtherKeys: 0 });
  assert.equal(surface.inputModes().mouseTracking, "none",
    "local packet routing still withholds mouse reporting while a frame is incomplete");
  h.manager.emitChange("row-1");
  const published = delivered.at(-1);
  assert.ok(published, "the row change was delivered");
  assert.deepEqual(published.inputModes, committed,
    "the mode facts published beside a frame are that frame's committed facts");
  assert.equal(published.inputModes.mouseTracking, "any",
    "a temporary mid-frame withholding is never exported as a published mode fact");

  // The published object is a copy: later surface movement cannot rewrite it.
  surface.modes = inputModes({ mouseTracking: "x10" });
  assert.deepEqual(published.inputModes, committed, "a published snapshot is never a live alias");

  // Once the frame commits, the new state is what the next snapshot carries.
  surface.endRedraw(inputModes({ mouseTracking: "any", modifyOtherKeys: 1 }));
  h.manager.emitChange("row-1");
  const settled = delivered.at(-1);
  assert.ok(settled);
  assert.notEqual(settled, published, "the settled frame is a newer observation");
  assert.deepEqual(settled.inputModes, inputModes({ mouseTracking: "any", modifyOtherKeys: 1 }),
    "after the commit the live parsed modes are the committed frame's modes");
  assert.deepEqual(h.manager.mutatorCalls, [], "observation still never mutates a row");
});

test("the input-readiness seam reports a held redraw and settles it even when nothing changed", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 9, 4, "unchanged frame");
  const notifications: boolean[] = [];
  const seam = h.service.watchInputReadiness?.("row-1", (ready) => {
    notifications.push(ready);
  });
  assert.ok(seam, "a row with a parse pipeline offers an input-readiness observation");
  assert.equal(seam.isReady(), true, "no redraw is in flight when the watch installs");
  assert.deepEqual(notifications, [], "installing never fabricates a notification");

  surface.beginRedraw(inputModes());
  assert.equal(seam.isReady(), false, "a redraw in flight is reported as held, however it is read");

  // The frame completes with nothing visually or mode-wise changed. The ordinary
  // change notification dedupes that away, so the wake-up has to be its own fact.
  surface.endRedraw();
  assert.deepEqual(notifications, [true], "an unchanged frame end still wakes the waiter");
  assert.equal(seam.isReady(), true, "and the read agrees");

  // A hold ending with real movement wakes it once as well, and never twice.
  notifications.length = 0;
  surface.beginRedraw(inputModes());
  surface.endRedraw(inputModes({ modifyOtherKeys: 1 }));
  assert.deepEqual(notifications, [true], "one hold end is one wake-up");

  // A retired watch is silent and can never answer for a live subscription.
  notifications.length = 0;
  surface.beginRedraw(inputModes());
  seam.unsubscribe();
  surface.endRedraw();
  assert.deepEqual(notifications, [], "a retired watch is never notified again");
  assert.throws(() => seam.isReady(), /readiness observation is unavailable/,
    "a retired watch never reports readiness");
  seam.unsubscribe();
  assert.equal(surface.redrawObservers.size, 0, "retirement releases the surface observer");

  // A row with no surface has no redraw in flight: that is the seam answering.
  const other = h.service.watchInputReadiness?.("row-3", () => { /* no fixture row */ });
  assert.ok(other);
  assert.equal(other.isReady(), true, "an unobservable row answers honestly instead of blocking forever");
});

test("a readiness observation that cannot attach or answer fails closed instead of reporting ready", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 9, 4, "held frame");
  surface.throwOnRedrawObserver = true;
  const seam = h.service.watchInputReadiness?.("row-1", () => { /* waiter cannot be woken */ });
  assert.ok(seam);
  assert.throws(() => seam.isReady(), /readiness observation is unavailable/,
    "an observation that can never report is never read as ready");

  // A surface that stops answering mid-watch fails the same way, rather than
  // silently granting permission to write into a state nobody observed.
  surface.throwOnRedrawObserver = false;
  surface.throwOnRedrawHeld = true;
  const live = h.service.watchInputReadiness?.("row-1", () => { /* second watch */ });
  assert.ok(live);
  assert.throws(() => live.isReady(), /synthetic redraw-state failure/,
    "a surface that cannot answer propagates instead of guessing");
  assert.doesNotThrow(() => h.manager.emitChange("row-1"),
    "an unanswerable observation is contained for the row and its other watchers");

  // A grounded pipeline (a failed parse, or a surface being disposed) is not a healthy
  // surface with nothing in flight: work waiting there must be cancelled, never handed
  // to a parser whose behaviour after failure is undefined.
  const held = h.service.watchInputReadiness?.("row-1", () => { /* waiter */ });
  assert.ok(held);
  surface.throwOnRedrawHeld = false;
  surface.grounded = true;
  assert.throws(() => held.isReady(), /readiness observation is unavailable/,
    "a failed pipeline is reported unavailable, never ready");
  surface.grounded = false;
  assert.equal(held.isReady(), true, "the same watch reads a surface that is grounded no more");

  // When the row's pipeline comes back, the same watch reads it again.
  surface.throwOnRedrawHeld = false;
  h.manager.surfaces.set("row-1", new ContentSurface(frame(9, 4, "new pipeline")));
  h.manager.emitChange("row-1");
  assert.equal(live.isReady(), true, "a re-attached watch reads the current surface");
});

test("a readiness watch whose surface lookup starts failing stops answering, releases its observer, and never grants a write", () => {
  const h = harness();
  const { surface } = seed(h.manager, "row-1", 9, 4, "held frame");
  const seam = h.service.watchInputReadiness?.("row-1", () => { /* waiter */ });
  assert.ok(seam);
  surface.beginRedraw(surface.modes);
  assert.equal(seam.isReady(), false, "a working watch reports the hold, which is what keeps input waiting");
  assert.equal(surface.redrawObservers.size, 1, "and it is observing that hold");

  // The manager can no longer say which surface this row has. That is NOT the same fact
  // as "this row has no pipeline": reporting `undefined` here would be reported as
  // readiness and the endpoint would write. The watch stops answering, and it lets go of
  // an observer on an identity it can no longer confirm instead of leaking it.
  h.manager.surfaceThrows = true;
  assert.throws(() => seam.isReady(), /readiness observation is unavailable/,
    "a lookup that cannot be answered is unavailable, never ready");
  assert.equal(surface.redrawObservers.size, 0, "the failed watch released its observer");
  assert.doesNotThrow(() => h.manager.emitChange("row-1"),
    "the failure stays in the watch record instead of leaking out of a registered watch");
  assert.throws(() => seam.isReady(), /readiness observation is unavailable/,
    "and it keeps refusing to answer while the lookup is broken");

  // A row whose surface is genuinely absent is a different fact and stays readable,
  // which is what keeps a display-only or pipeline-less source on the direct handoff.
  h.manager.surfaceThrows = false;
  assert.equal(seam.isReady(), false, "the same watch reads the hold again once the lookup answers");
  surface.endRedraw();
  assert.equal(seam.isReady(), true, "and it reports the settled frame normally");
  assert.equal(surface.redrawObservers.size, 1, "the recovered watch observes again");
  h.manager.surfaces.delete("row-1");
  assert.equal(seam.isReady(), true,
    "an absent surface is the seam answering honestly: no pipeline, nothing in flight");
});
