/**
 * Pure regression tests for the transparent actual-owner pane-mode observer:
 * exact original call forwarding (receiver, arguments, return identity, and
 * thrown error identity), the actual-owner row match independent of any
 * selection or roster inference, host focus reporting, known/unknown mode
 * mapping, descriptor ownership and restoration, ambiguity refusal, partial
 * installation unwind, and the bounded once-per-snapshot read contract.
 *
 * No filesystem, process, PTY, or Windows runtime is touched: the CJS fixture
 * is required directly as a pure module and driven with prototype-only fakes.
 * These fakes are contract tests, not genuine Windows proof.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { TerminalInputModes } from "../src/session-host/terminal-surface";

interface PaneObserver {
  snapshot(): Record<string, unknown>;
  restore(): boolean;
  readonly installed: boolean;
  readonly unsupported: boolean;
}

interface PaneObserverModule {
  PANE_REPLY_FIELD_NAMES: readonly string[];
  CANDIDATE_LEAVES: ReadonlyArray<{ readonly exportName: string; readonly leaf: string }>;
  resolveCandidatePaneClasses(mainEntry: string, options?: { fs?: unknown }): unknown;
  recheckCandidateModules(
    classes: Record<string, unknown>,
    modules: Record<string, { readonly cacheKey: string; readonly cacheEntry: unknown; readonly module: unknown }>,
    cache?: Record<string, unknown>,
  ): boolean;
  installOwnedHooks(
    slots: ReadonlyArray<{
      readonly prototype: object;
      readonly key: string;
      readonly descriptor: PropertyDescriptor;
      readonly hook: (...args: unknown[]) => unknown;
    }>,
    defineProperty: (target: object, key: string, descriptor: PropertyDescriptor) => void,
  ): boolean;
  createPaneModeObserver(classes: unknown): PaneObserver;
  installPaneModeObserver(mainEntry: string, options?: { fs?: unknown }): PaneObserver;
}

const paneFixture = require("../../tests/fixtures/session-host-windows-pane-mode-observer.cjs") as PaneObserverModule;

type SidebarFocus = "main" | "sidebar" | "form" | "confirm";

function modesWith(
  mouseTracking: TerminalInputModes["mouseTracking"],
  mouseEncoding: TerminalInputModes["mouseEncoding"],
): TerminalInputModes {
  return {
    kittyFlags: 0,
    applicationCursorKeys: false,
    applicationKeypad: false,
    bracketedPaste: false,
    mouseTracking,
    modifyOtherKeys: 0,
    mouseEncoding,
  };
}

/** Fake pane surface exposing only the public read the observer is allowed to make. */
class FakeSurface {
  private readonly value: unknown;
  inputModesCalls = 0;

  constructor(value: unknown) {
    this.value = value;
  }

  inputModes(): unknown {
    this.inputModesCalls += 1;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

/**
 * Fresh fake original classes per call, so each test gets untouched prototypes
 * and can observe exact forwarded calls.
 */
function makeFakes() {
  const forwardedList: Array<{ readonly receiver: unknown; readonly args: readonly unknown[] }> = [];
  const forwardedOwner: Array<{ readonly receiver: unknown; readonly args: readonly unknown[] }> = [];

  class FakeInstanceManager {
    views: unknown[] = [];
    surfaces: Record<string, unknown> = {};
    listError?: Error;
    surfaceError?: Error;

    list(...args: unknown[]): unknown[] {
      forwardedList.push({ receiver: this, args });
      if (this.listError !== undefined) throw this.listError;
      return this.views;
    }

    surface(id: string): unknown {
      if (this.surfaceError !== undefined) throw this.surfaceError;
      return this.surfaces[id];
    }
  }

  class FakeSidebarController {
    private focusValue: SidebarFocus;
    private ownerValue: string | undefined;
    focusError?: Error;
    ownerError?: Error;
    setActiveMainOwnerCalls = 0;

    constructor(focus: SidebarFocus = "sidebar", owner?: string) {
      this.focusValue = focus;
      this.ownerValue = owner;
    }

    get focus(): SidebarFocus {
      if (this.focusError !== undefined) throw this.focusError;
      return this.focusValue;
    }

    get activeMainOwnerID(): string | undefined {
      if (this.ownerError !== undefined) throw this.ownerError;
      return this.ownerValue;
    }

    setActiveMainOwner(id: string | undefined): void {
      forwardedOwner.push({ receiver: this, args: [id] });
      this.setActiveMainOwnerCalls += 1;
      this.ownerValue = typeof id === "string" && id.length > 0 ? id : undefined;
    }
  }

  return { FakeInstanceManager, FakeSidebarController, forwardedList, forwardedOwner };
}

function installOn(fakes: ReturnType<typeof makeFakes>): PaneObserver {
  return paneFixture.createPaneModeObserver({
    InstanceManager: fakes.FakeInstanceManager,
    SidebarController: fakes.FakeSidebarController,
    TerminalSurface: FakeSurface,
  });
}

function liveViews(ids: readonly string[]): unknown[] {
  return ids.map((id) => ({ id, hasLiveProcess: true, lifecycle: "alive" }));
}

test("pane observer forwards exact receiver, arguments, and return identity", () => {
  const fakes = makeFakes();
  const originalList = fakes.FakeInstanceManager.prototype.list;
  const originalSetter = fakes.FakeSidebarController.prototype.setActiveMainOwner;
  const observer = installOn(fakes);
  assert.equal(observer.installed, true);
  assert.equal(observer.unsupported, false);

  const manager = new fakes.FakeInstanceManager();
  manager.views = ["row"];
  const extra = { sentinel: true };
  const returned = manager.list(extra, "second");
  assert.equal(returned, manager.views, "the exact original return value identity is preserved");
  assert.equal(fakes.forwardedList.length, 1, "the original is called exactly once");
  assert.equal(fakes.forwardedList[0]!.receiver, manager, "the exact original receiver is preserved");
  assert.deepEqual(fakes.forwardedList[0]!.args, [extra, "second"], "the exact argument vector is preserved");

  const sidebar = new fakes.FakeSidebarController("main", "A");
  const ownerReturn = sidebar.setActiveMainOwner("B");
  assert.equal(ownerReturn, undefined, "the exact original return value is preserved");
  assert.equal(fakes.forwardedOwner.length, 1, "the original active-owner setter is called exactly once");
  assert.equal(fakes.forwardedOwner[0]!.receiver, sidebar, "the exact original receiver is preserved");
  assert.deepEqual(fakes.forwardedOwner[0]!.args, ["B"], "the exact argument vector is preserved");

  assert.equal(observer.restore(), true);
  assert.equal(fakes.FakeInstanceManager.prototype.list, originalList,
    "restore returns the exact original list descriptor");
  assert.equal(fakes.FakeSidebarController.prototype.setActiveMainOwner, originalSetter,
    "restore returns the exact original setter descriptor");
});

test("pane observer rethrows the identical original error and records no failed receiver", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const manager = new fakes.FakeInstanceManager();
  const boom = new Error("SYNTHETIC list failure");
  manager.listError = boom;
  assert.throws(() => manager.list(), (error: unknown) => error === boom,
    "the identical original thrown error identity is preserved");
  const sidebar = new fakes.FakeSidebarController("main", "A");
  sidebar.setActiveMainOwner("A");

  const pane = observer.snapshot();
  assert.equal(pane.scope, true, "the observation scope stays intact");
  assert.equal(pane.ownerPresent, true, "the successful active-owner call is still recorded");
  assert.equal(pane.focusMain, true);
  assert.equal(pane.viewMatched, null, "an unrecorded manager leaves the owner row unknown, never guessed");
  assert.equal(pane.complete, false);
});

test("pane observer reports the actual owner row independently of any selection or roster inference", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const surfaceA = new FakeSurface(modesWith("none", "default"));
  const surfaceB = new FakeSurface(modesWith("any", "sgr"));
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A", "B"]);
  manager.surfaces = { A: surfaceA, B: surfaceB };
  const sidebar = new fakes.FakeSidebarController("main");
  manager.list();
  sidebar.setActiveMainOwner("B");

  const pane = observer.snapshot();
  assert.equal(pane.ownerPresent, true);
  assert.equal(pane.focusMain, true);
  assert.equal(pane.viewMatched, true, "the actual owner id matches exactly one of the two rows");
  assert.equal(pane.hasLiveProcess, true);
  assert.equal(pane.lifecycleAlive, true);
  assert.equal(pane.surfacePresent, true);
  assert.equal(pane.modesReadSucceeded, true);
  assert.equal(pane.mouseTracking, 4, "the actual owner pane reports tracking-any");
  assert.equal(pane.mouseEncoding, 1, "the actual owner pane reports SGR encoding");
  assert.equal(pane.complete, true);
  assert.equal(pane.scope, true);
  assert.equal(surfaceB.inputModesCalls, 1, "only the actual owner pane surface is read");
  assert.equal(surfaceA.inputModesCalls, 0, "a sibling row is never read as the owner");

  // One live row with no positively known owner is never treated as active.
  sidebar.setActiveMainOwner(undefined);
  const noOwner = observer.snapshot();
  assert.equal(noOwner.ownerPresent, false);
  assert.equal(noOwner.viewMatched, false, "no owner means no owner row, even with a live sibling");
  assert.equal(noOwner.hasLiveProcess, false);
  assert.equal(noOwner.surfacePresent, false);
  assert.equal(noOwner.mouseTracking, null, "an absent owner never borrows a mode value");
  assert.equal(noOwner.complete, false);
  assert.equal(noOwner.focusMain, true, "host focus is reported independently of owner presence");
});

test("pane observer reports host focus false while a positively known owner stays known", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  manager.surfaces = { A: new FakeSurface(modesWith("drag", "sgr-pixels")) };
  const sidebar = new fakes.FakeSidebarController("sidebar");
  manager.list();
  sidebar.setActiveMainOwner("A");

  const pane = observer.snapshot();
  assert.equal(pane.ownerPresent, true, "the actual owner stays known off-main");
  assert.equal(pane.focusMain, false, "host focus is reported false, never a fallback to the owner");
  assert.equal(pane.viewMatched, true);
  assert.equal(pane.mouseTracking, 3);
  assert.equal(pane.mouseEncoding, 2);
  assert.equal(pane.complete, true);
});

test("pane observer refuses to infer pane absence from a throwing lookup", (t) => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  t.after(() => observer.restore());
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  manager.surfaces = { A: new FakeSurface(modesWith("any", "sgr")) };
  manager.surfaceError = new Error("SYNTHETIC unreadable lookup");
  const sidebar = new fakes.FakeSidebarController("main");
  manager.list();
  sidebar.setActiveMainOwner("A");
  const pane = observer.snapshot();
  assert.equal(pane.scope, true);
  assert.equal(pane.ownerPresent, true);
  assert.equal(pane.viewMatched, true);
  assert.equal(pane.hasLiveProcess, true);
  assert.equal(pane.surfacePresent, null);
  assert.equal(pane.modesReadSucceeded, null);
  assert.equal(pane.mouseTracking, null);
  assert.equal(pane.complete, false);
});

test("pane observer reports an unsupported focus value as unknown", (t) => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  t.after(() => observer.restore());
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  manager.surfaces = { A: new FakeSurface(modesWith("none", "default")) };
  const sidebar = new fakes.FakeSidebarController("unsupported" as SidebarFocus);
  manager.list();
  sidebar.setActiveMainOwner("A");
  const pane = observer.snapshot();
  assert.equal(pane.focusMain, null);
  assert.equal(pane.ownerPresent, true);
  assert.equal(pane.mouseTracking, 0);
  assert.equal(pane.complete, false);
});

test("pane observer maps known modes and refuses unknown or throwing observation", () => {
  const known = makeFakes();
  const knownObserver = installOn(known);
  const knownManager = new known.FakeInstanceManager();
  knownManager.views = liveViews(["A"]);
  knownManager.surfaces = { A: new FakeSurface(modesWith("none", "default")) };
  const knownSidebar = new known.FakeSidebarController("main");
  knownManager.list();
  knownSidebar.setActiveMainOwner("A");
  const knownPane = knownObserver.snapshot();
  assert.equal(knownPane.mouseTracking, 0, "mouseTracking none is the known enum 0");
  assert.equal(knownPane.mouseEncoding, 0, "mouseEncoding default is the known enum 0");
  assert.equal(knownPane.complete, true);

  const bogus = makeFakes();
  const bogusObserver = installOn(bogus);
  const bogusManager = new bogus.FakeInstanceManager();
  bogusManager.views = liveViews(["A"]);
  bogusManager.surfaces = { A: new FakeSurface({ mouseTracking: "bogus", mouseEncoding: "bogus" }) };
  const bogusSidebar = new bogus.FakeSidebarController("main");
  bogusManager.list();
  bogusSidebar.setActiveMainOwner("A");
  const bogusPane = bogusObserver.snapshot();
  assert.equal(bogusPane.surfacePresent, true);
  assert.equal(bogusPane.modesReadSucceeded, true, "the read succeeded even though the enum is unrecognized");
  assert.equal(bogusPane.mouseTracking, null, "an unrecognized tracking value is unknown, never guessed");
  assert.equal(bogusPane.mouseEncoding, null, "an unrecognized encoding value is unknown, never guessed");
  assert.equal(bogusPane.complete, false);

  const throwing = makeFakes();
  const throwingObserver = installOn(throwing);
  const throwingManager = new throwing.FakeInstanceManager();
  throwingManager.views = liveViews(["A"]);
  throwingManager.surfaces = { A: new FakeSurface(new Error("SYNTHETIC disposed surface")) };
  const throwingSidebar = new throwing.FakeSidebarController("main");
  throwingManager.list();
  throwingSidebar.setActiveMainOwner("A");
  const throwingPane = throwingObserver.snapshot();
  assert.equal(throwingPane.surfacePresent, true);
  assert.equal(throwingPane.modesReadSucceeded, false, "a throwing mode read is unknown, never a functional failure");
  assert.equal(throwingPane.mouseTracking, null);
  assert.equal(throwingPane.complete, false);

  const getterThrow = makeFakes();
  const getterObserver = installOn(getterThrow);
  const getterManager = new getterThrow.FakeInstanceManager();
  getterManager.views = liveViews(["A"]);
  getterManager.surfaces = { A: new FakeSurface(modesWith("none", "default")) };
  const getterSidebar = new getterThrow.FakeSidebarController("main");
  getterManager.list();
  getterSidebar.setActiveMainOwner("A");
  getterSidebar.ownerError = new Error("SYNTHETIC owner getter failure");
  let getterPane = getterObserver.snapshot();
  assert.equal(getterPane.ownerPresent, null, "a throwing owner getter is unknown");
  assert.equal(getterPane.scope, true, "a throwing safety getter preserves an intact observation scope");
  assert.equal(getterPane.complete, false);
  assert.equal(getterPane.viewMatched, null);

  getterSidebar.ownerError = undefined;
  getterSidebar.focusError = new Error("SYNTHETIC focus getter failure");
  getterPane = getterObserver.snapshot();
  assert.equal(getterPane.focusMain, null, "a throwing focus getter is unknown");
  assert.equal(getterPane.ownerPresent, true, "the owner remains honestly known");
  assert.equal(getterPane.complete, false);
});

test("pane observer reports sticky unknown for a replaced slot, ambiguity, and a premature snapshot", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);

  // Premature: the observer is installed but no successful receiver call has
  // happened yet, so nothing is derived and nothing is guessed.
  const premature = observer.snapshot();
  assert.equal(premature.scope, true, "the installed scope is intact");
  assert.equal(premature.complete, false);
  assert.equal(premature.ownerPresent, null);
  assert.equal(premature.focusMain, null);
  assert.equal(premature.mouseTracking, null);

  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  manager.surfaces = { A: new FakeSurface(modesWith("none", "default")) };
  const sidebar = new fakes.FakeSidebarController("main", "A");
  manager.list();
  sidebar.setActiveMainOwner("A");
  assert.equal(observer.snapshot().complete, true);

  // A second distinct manager instance is sticky ambiguity, never last-wins.
  const otherManager = new fakes.FakeInstanceManager();
  otherManager.views = liveViews(["Z"]);
  otherManager.list();
  const ambiguous = observer.snapshot();
  assert.equal(ambiguous.scope, false, "a second actual instance is sticky ambiguity");
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.ownerPresent, null);
  assert.equal(ambiguous.mouseTracking, null);
  assert.equal(observer.snapshot().scope, false, "the ambiguity stays sticky on a later snapshot");
});

test("pane observer forwards a borrowed foreign receiver unchanged but reports unknown", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  const foreign = { id: "foreign" };
  Reflect.apply(manager.list, foreign, []);
  assert.equal(fakes.forwardedList[0]!.receiver, foreign, "the borrowed receiver reaches the original unchanged");
  const pane = observer.snapshot();
  assert.equal(pane.scope, false, "a borrowed receiver is never counted as the actual instance");
  assert.equal(pane.complete, false);
  assert.equal(pane.ownerPresent, null);
});

test("pane observer restore never clobbers a foreign replacement", () => {
  const fakes = makeFakes();
  const originalSetter = fakes.FakeSidebarController.prototype.setActiveMainOwner;
  const observer = installOn(fakes);
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  const sidebar = new fakes.FakeSidebarController("main", "A");
  manager.list();
  sidebar.setActiveMainOwner("A");

  const replacement = function foreignList(): string {
    return "SYNTHETIC-foreign";
  };
  Object.defineProperty(fakes.FakeInstanceManager.prototype, "list", {
    value: replacement, writable: true, configurable: true, enumerable: false,
  });
  const replaced = observer.snapshot();
  assert.equal(replaced.scope, false, "an observed owned-slot replacement is sticky unknown");

  assert.equal(observer.restore(), true, "the untouched sibling slot is still restored");
  assert.equal(fakes.FakeInstanceManager.prototype.list, replacement,
    "restore never deletes or overwrites a foreign replacement");
  assert.equal(fakes.FakeSidebarController.prototype.setActiveMainOwner, originalSetter,
    "the exact original descriptor is restored only while the owned hook still occupies the slot");
});

test("pane observer maps exactly the declared TerminalInputModes enum values", () => {
  const cases: Array<[TerminalInputModes["mouseTracking"], number, TerminalInputModes["mouseEncoding"], number]> = [
    ["none", 0, "default", 0],
    ["x10", 1, "sgr", 1],
    ["vt200", 2, "default", 0],
    ["drag", 3, "sgr-pixels", 2],
    ["any", 4, "sgr", 1],
  ];
  for (const [tracking, expectedTracking, encoding, expectedEncoding] of cases) {
    const fakes = makeFakes();
    const observer = installOn(fakes);
    const manager = new fakes.FakeInstanceManager();
    manager.views = liveViews(["A"]);
    manager.surfaces = { A: new FakeSurface(modesWith(tracking, encoding)) };
    const sidebar = new fakes.FakeSidebarController("main", "A");
    manager.list();
    sidebar.setActiveMainOwner("A");
    const pane = observer.snapshot();
    assert.equal(pane.mouseTracking, expectedTracking, `${tracking} maps to its declared enum`);
    assert.equal(pane.mouseEncoding, expectedEncoding, `${encoding} maps to its declared enum`);
    assert.equal(pane.complete, true);
  }
});

test("pane observer refuses own shadows and replaced getter/method resolutions", () => {
  // Own instance shadow of the actual list resolution.
  const shadowedList = makeFakes();
  const shadowedListObserver = installOn(shadowedList);
  const shadowedManager = new shadowedList.FakeInstanceManager();
  shadowedManager.views = liveViews(["A"]);
  const shadowedSidebar = new shadowedList.FakeSidebarController("main", "A");
  shadowedManager.list();
  shadowedSidebar.setActiveMainOwner("A");
  Object.defineProperty(shadowedManager, "list", { value: () => [], configurable: true, writable: true });
  let pane = shadowedListObserver.snapshot();
  assert.equal(pane.scope, false, "an own shadow of the actual list resolution is refused");
  assert.equal(pane.ownerPresent, null);
  assert.equal(pane.complete, false);

  // Own instance shadow of an owner getter.
  const shadowedGetter = makeFakes();
  const shadowedGetterObserver = installOn(shadowedGetter);
  const getterManager = new shadowedGetter.FakeInstanceManager();
  getterManager.views = liveViews(["A"]);
  getterManager.surfaces = { A: new FakeSurface(modesWith("any", "sgr")) };
  const getterSidebar = new shadowedGetter.FakeSidebarController("main", "A");
  getterManager.list();
  getterSidebar.setActiveMainOwner("A");
  Object.defineProperty(getterSidebar, "activeMainOwnerID", { value: "Z", configurable: true, writable: true });
  pane = shadowedGetterObserver.snapshot();
  assert.equal(pane.scope, false, "an own shadow of the actual owner getter is refused");
  assert.equal(pane.ownerPresent, null);

  // Replaced prototype getter.
  const replacedGetter = makeFakes();
  const replacedGetterObserver = installOn(replacedGetter);
  const replacedGetterManager = new replacedGetter.FakeInstanceManager();
  replacedGetterManager.views = liveViews(["A"]);
  const replacedGetterSidebar = new replacedGetter.FakeSidebarController("main", "A");
  replacedGetterManager.list();
  replacedGetterSidebar.setActiveMainOwner("A");
  Object.defineProperty(replacedGetter.FakeSidebarController.prototype, "focus", { get: () => "main", configurable: true });
  pane = replacedGetterObserver.snapshot();
  assert.equal(pane.scope, false, "a replaced prototype getter is refused, never bypassed through a saved original");
  assert.equal(pane.focusMain, null);

  // Replaced prototype method.
  const replacedMethod = makeFakes();
  const replacedMethodObserver = installOn(replacedMethod);
  const replacedMethodManager = new replacedMethod.FakeInstanceManager();
  replacedMethodManager.views = liveViews(["A"]);
  const replacedMethodSidebar = new replacedMethod.FakeSidebarController("main", "A");
  replacedMethodManager.list();
  replacedMethodSidebar.setActiveMainOwner("A");
  Object.defineProperty(replacedMethod.FakeInstanceManager.prototype, "surface", {
    value: () => undefined, configurable: true, writable: true,
  });
  pane = replacedMethodObserver.snapshot();
  assert.equal(pane.scope, false, "a replaced prototype surface method is refused");
  assert.equal(pane.surfacePresent, null);

  // Own surface shadow of the pane mode resolution.
  const shadowedModes = makeFakes();
  const shadowedModesObserver = installOn(shadowedModes);
  const shadowedModesManager = new shadowedModes.FakeInstanceManager();
  const shadowedSurface = new FakeSurface(modesWith("any", "sgr"));
  shadowedModesManager.views = liveViews(["A"]);
  shadowedModesManager.surfaces = { A: shadowedSurface };
  const shadowedModesSidebar = new shadowedModes.FakeSidebarController("main", "A");
  shadowedModesManager.list();
  shadowedModesSidebar.setActiveMainOwner("A");
  Object.defineProperty(shadowedSurface, "inputModes", {
    value: () => modesWith("any", "sgr"), configurable: true, writable: true,
  });
  pane = shadowedModesObserver.snapshot();
  assert.equal(pane.scope, false, "an own inputModes shadow invalidates this first snapshot");
  assert.equal(pane.surfacePresent, null);
  assert.equal(pane.modesReadSucceeded, null, "a shadow is refused, never bypassed");
  assert.equal(pane.mouseTracking, null);
  assert.equal(pane.complete, false);
  for (const key of paneFixture.PANE_REPLY_FIELD_NAMES) {
    if (key !== "scope" && key !== "complete") assert.equal(pane[key], null);
  }
  delete (shadowedSurface as unknown as Record<string, unknown>).inputModes;
  assert.deepEqual(shadowedModesObserver.snapshot(), pane, "restoring a slot cannot repair lost scope");

  // A non-original pane prototype is refused.
  const foreignProto = makeFakes();
  const foreignProtoObserver = installOn(foreignProto);
  class ForeignSurface extends FakeSurface {}
  const foreignManager = new foreignProto.FakeInstanceManager();
  foreignManager.views = liveViews(["A"]);
  foreignManager.surfaces = { A: new ForeignSurface(modesWith("any", "sgr")) };
  const foreignSidebar = new foreignProto.FakeSidebarController("main", "A");
  foreignManager.list();
  foreignSidebar.setActiveMainOwner("A");
  pane = foreignProtoObserver.snapshot();
  assert.equal(pane.scope, false, "a non-original pane prototype invalidates the first snapshot");
  assert.equal(pane.modesReadSucceeded, null, "a non-original pane prototype is refused");
  assert.equal(pane.mouseTracking, null);
  assert.equal(pane.complete, false);
});

test("pane observer contains a throwing receiver inspection without changing the original call", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  const target: { views: unknown[] } = { views: manager.views };
  let trapCalls = 0;
  const throwingReceiver = new Proxy(target, {
    getPrototypeOf(): object {
      trapCalls += 1;
      throw new Error("SYNTHETIC prototype trap failure");
    },
  });
  let returned: unknown = undefined;
  assert.doesNotThrow(() => {
    returned = Reflect.apply(manager.list, throwingReceiver, []);
  }, "observation bookkeeping never converts a successful original call into a throw");
  assert.equal(returned, target.views, "the exact original return value is preserved");
  assert.equal(fakes.forwardedList[0]!.receiver, throwingReceiver, "the borrowed receiver reached the original");
  assert.equal(trapCalls, 0, "a proxy receiver is refused without invoking any of its traps");
  const pane = observer.snapshot();
  assert.equal(pane.scope, false, "an uninspectable proxy receiver is sticky unknown");
  assert.equal(pane.complete, false);
  assert.equal(pane.ownerPresent, null);
});

test("pane observer contains a throwing-descriptor proxy preflight without changing public state", () => {
  const fakes = makeFakes();
  const originalList = fakes.FakeInstanceManager.prototype.list;
  function ProxyPreflightSidebar(): void {
    // Test-only prototype holder whose descriptor trap would throw if inspected.
  }
  let descriptorTrapCalls = 0;
  const throwingPrototype = new Proxy({}, {
    getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
      descriptorTrapCalls += 1;
      throw new Error("SYNTHETIC descriptor trap failure");
    },
  });
  Object.defineProperty(ProxyPreflightSidebar, "prototype", {
    value: throwingPrototype, writable: true, enumerable: false, configurable: false,
  });
  let observer: PaneObserver | undefined = undefined;
  try {
    observer = paneFixture.createPaneModeObserver({
      InstanceManager: fakes.FakeInstanceManager,
      SidebarController: ProxyPreflightSidebar,
      TerminalSurface: FakeSurface,
    });
  } catch {
    observer = undefined;
  }
  assert.ok(observer !== undefined, "a throwing preflight is contained, never an install exception");
  assert.equal(observer!.unsupported, true);
  assert.equal(observer!.installed, false);
  assert.equal(descriptorTrapCalls, 0, "a proxy prototype is refused before its descriptor trap can run");
  assert.equal(fakes.FakeInstanceManager.prototype.list, originalList,
    "no owned slot is installed when the preflight is unsupported");
  const pane = observer!.snapshot();
  for (const name of paneFixture.PANE_REPLY_FIELD_NAMES) {
    assert.equal(pane[name], null, `${name} is an explicit null`);
  }
});

test("pane observer refuses changed manager/sidebar prototypes, constructors, and module exports", () => {
  // Manager instance prototype changed to a derived object.
  const derivedManager = makeFakes();
  const derivedManagerObserver = installOn(derivedManager);
  const derivedManagerInstance = new derivedManager.FakeInstanceManager();
  derivedManagerInstance.views = liveViews(["A"]);
  const derivedManagerSidebar = new derivedManager.FakeSidebarController("main", "A");
  derivedManagerInstance.list();
  derivedManagerSidebar.setActiveMainOwner("A");
  Object.setPrototypeOf(derivedManagerInstance, Object.create(derivedManager.FakeInstanceManager.prototype));
  let pane = derivedManagerObserver.snapshot();
  assert.equal(pane.scope, false, "a changed manager immediate prototype is refused");
  assert.equal(pane.ownerPresent, null);

  // Sidebar instance prototype changed to a derived object with a different owner getter.
  const derivedSidebar = makeFakes();
  const derivedSidebarObserver = installOn(derivedSidebar);
  const derivedSidebarManager = new derivedSidebar.FakeInstanceManager();
  derivedSidebarManager.views = liveViews(["A"]);
  const derivedSidebarInstance = new derivedSidebar.FakeSidebarController("main", "A");
  derivedSidebarManager.list();
  derivedSidebarInstance.setActiveMainOwner("A");
  const replacementPrototype = Object.create(derivedSidebar.FakeSidebarController.prototype);
  Object.defineProperty(replacementPrototype, "activeMainOwnerID", { get: () => "Z", configurable: true });
  Object.setPrototypeOf(derivedSidebarInstance, replacementPrototype);
  pane = derivedSidebarObserver.snapshot();
  assert.equal(pane.scope, false, "a changed sidebar immediate prototype is refused, never read through a saved getter");
  assert.equal(pane.ownerPresent, null);

  // Class prototype redefined at observation time.
  const changedConstructor = makeFakes();
  const changedConstructorObserver = installOn(changedConstructor);
  const changedConstructorManager = new changedConstructor.FakeInstanceManager();
  changedConstructorManager.views = liveViews(["A"]);
  const changedConstructorSidebar = new changedConstructor.FakeSidebarController("main", "A");
  changedConstructorManager.list();
  changedConstructorSidebar.setActiveMainOwner("A");
  Object.defineProperty(changedConstructor.FakeInstanceManager.prototype, "constructor", {
    value: function otherConstructor(): void {}, configurable: true,
  });
  pane = changedConstructorObserver.snapshot();
  assert.equal(pane.scope, false, "a changed class constructor identity is refused");

  // Candidate module/export identity recheck failure.
  const recheck = makeFakes();
  const recheckObserver = paneFixture.createPaneModeObserver({
    InstanceManager: recheck.FakeInstanceManager,
    SidebarController: recheck.FakeSidebarController,
    TerminalSurface: FakeSurface,
    recheck: () => false,
  });
  const recheckManager = new recheck.FakeInstanceManager();
  recheckManager.views = liveViews(["A"]);
  const recheckSidebar = new recheck.FakeSidebarController("main", "A");
  recheckManager.list();
  recheckSidebar.setActiveMainOwner("A");
  pane = recheckObserver.snapshot();
  assert.equal(pane.scope, false, "a changed candidate module/export identity is refused");
  assert.equal(pane.complete, false);
});

test("pane observer keeps an observed hook replacement sticky across reinstallation", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const ownedHook = fakes.FakeInstanceManager.prototype.list;
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  const sidebar = new fakes.FakeSidebarController("main", "A");
  manager.list();
  sidebar.setActiveMainOwner("A");
  Object.defineProperty(fakes.FakeInstanceManager.prototype, "list", {
    value: function foreignList(): unknown[] { return []; }, writable: true, configurable: true, enumerable: false,
  });
  assert.equal(observer.snapshot().scope, false, "a replaced owned slot is observed as unknown");
  Object.defineProperty(fakes.FakeInstanceManager.prototype, "list", {
    value: ownedHook, writable: true, configurable: true, enumerable: false,
  });
  const after = observer.snapshot();
  assert.equal(after.scope, false, "reinstalling the hook never repairs the already-observed gap");
  assert.equal(after.complete, false);
  assert.equal(after.ownerPresent, null);
});

test("module/export identity recheck inspects the retained cache without requiring or reading accessors", () => {
  class A {}
  class B {}
  class C {}
  const classes: Record<string, unknown> = { InstanceManager: A, SidebarController: B, TerminalSurface: C };
  const makeIdentity = () => {
    const cache: Record<string, unknown> = {};
    const modules: Record<string, { cacheKey: string; cacheEntry: unknown; module: unknown }> = {};
    for (const leaf of paneFixture.CANDIDATE_LEAVES) {
      const loaded: Record<string, unknown> = {};
      loaded[leaf.exportName] = classes[leaf.exportName];
      // A cache key that names no real file: an intact `true` proves the
      // checker never re-required it (a require would throw ENOENT).
      const cacheKey = `/synthetic/never-required/${leaf.leaf}`;
      const cacheEntry = { exports: loaded };
      cache[cacheKey] = cacheEntry;
      modules[leaf.exportName] = { cacheKey, cacheEntry, module: loaded };
    }
    return { cache, modules };
  };

  const intact = makeIdentity();
  assert.equal(paneFixture.recheckCandidateModules(classes, intact.modules, intact.cache), true,
    "an intact retained cache/module/export identity validates without any require");

  const evicted = makeIdentity();
  delete evicted.cache[evicted.modules.InstanceManager!.cacheKey];
  assert.equal(paneFixture.recheckCandidateModules(classes, evicted.modules, evicted.cache), false,
    "an evicted cache entry is refused, never re-required");

  const replacedModule = makeIdentity();
  replacedModule.cache[replacedModule.modules.SidebarController!.cacheKey] = { exports: {} };
  assert.equal(paneFixture.recheckCandidateModules(classes, replacedModule.modules, replacedModule.cache), false,
    "a replaced cache entry object is refused");

  const replacedExport = makeIdentity();
  const replacedLoaded = replacedExport.modules.TerminalSurface!.module as Record<string, unknown>;
  replacedLoaded.TerminalSurface = class Other {};
  assert.equal(paneFixture.recheckCandidateModules(classes, replacedExport.modules, replacedExport.cache), false,
    "a replaced export value is refused");

  let getterCalls = 0;
  const accessorExport = makeIdentity();
  const accessorLoaded = accessorExport.modules.TerminalSurface!.module as Record<string, unknown>;
  Object.defineProperty(accessorLoaded, "TerminalSurface", {
    get: () => { getterCalls += 1; return C; },
    configurable: true,
  });
  assert.equal(paneFixture.recheckCandidateModules(classes, accessorExport.modules, accessorExport.cache), false,
    "a replaced export accessor is refused");
  assert.equal(getterCalls, 0, "the replacement export getter is never invoked");

  assert.equal(paneFixture.recheckCandidateModules(classes, makeIdentity().modules, {}), false,
    "an empty cache is refused");
});

test("pane observer refuses a constructor accessor and an own constructor shadow without invoking them", () => {
  // Replaced prototype constructor accessor.
  const replacedConstructor = makeFakes();
  const replacedConstructorObserver = installOn(replacedConstructor);
  const replacedConstructorManager = new replacedConstructor.FakeInstanceManager();
  replacedConstructorManager.views = liveViews(["A"]);
  const replacedConstructorSidebar = new replacedConstructor.FakeSidebarController("main", "A");
  replacedConstructorManager.list();
  replacedConstructorSidebar.setActiveMainOwner("A");
  let prototypeGetterCalls = 0;
  Object.defineProperty(replacedConstructor.FakeInstanceManager.prototype, "constructor", {
    get: () => { prototypeGetterCalls += 1; return replacedConstructor.FakeInstanceManager; },
    configurable: true,
  });
  let pane = replacedConstructorObserver.snapshot();
  assert.equal(pane.scope, false, "a replaced prototype constructor accessor is refused");
  assert.equal(prototypeGetterCalls, 0, "the prototype constructor accessor is never invoked");

  // Own instance constructor shadow.
  const ownShadow = makeFakes();
  const ownShadowObserver = installOn(ownShadow);
  const ownShadowManager = new ownShadow.FakeInstanceManager();
  ownShadowManager.views = liveViews(["A"]);
  const ownShadowSidebar = new ownShadow.FakeSidebarController("main", "A");
  ownShadowManager.list();
  ownShadowSidebar.setActiveMainOwner("A");
  let instanceGetterCalls = 0;
  Object.defineProperty(ownShadowManager, "constructor", {
    get: () => { instanceGetterCalls += 1; return ownShadow.FakeInstanceManager; },
    configurable: true,
  });
  pane = ownShadowObserver.snapshot();
  assert.equal(pane.scope, false, "an own instance constructor shadow is refused");
  assert.equal(instanceGetterCalls, 0, "the instance constructor accessor is never invoked");
});

test("pane observer refuses a proxy prototype at preflight without installing any slot", () => {
  const fakes = makeFakes();
  const originalList = fakes.FakeInstanceManager.prototype.list;

  function ProxySidebarController(): void {
    // Test-only prototype holder for the install refusal below.
  }
  const sidebarPrototype: Record<string, unknown> = {};
  Object.defineProperty(sidebarPrototype, "constructor", {
    value: ProxySidebarController, writable: true, configurable: true,
  });
  Object.defineProperty(sidebarPrototype, "setActiveMainOwner", {
    value: function noop(): void {}, writable: true, configurable: true, enumerable: false,
  });
  Object.defineProperty(sidebarPrototype, "activeMainOwnerID", { get: () => undefined, configurable: true });
  Object.defineProperty(sidebarPrototype, "focus", { get: () => "sidebar", configurable: true });
  let defineTrapCalls = 0;
  const proxy = new Proxy(sidebarPrototype, {
    defineProperty(): boolean {
      defineTrapCalls += 1;
      throw new Error("SYNTHETIC defineProperty refusal");
    },
  });
  Object.defineProperty(ProxySidebarController, "prototype", {
    value: proxy, writable: true, enumerable: false, configurable: false,
  });

  const observer = paneFixture.createPaneModeObserver({
    InstanceManager: fakes.FakeInstanceManager,
    SidebarController: ProxySidebarController,
    TerminalSurface: FakeSurface,
  });
  assert.equal(observer.installed, false, "a proxy prototype is refused at preflight");
  assert.equal(observer.unsupported, true);
  assert.equal(defineTrapCalls, 0, "the proxy prototype define trap is never invoked");
  assert.equal(fakes.FakeInstanceManager.prototype.list, originalList,
    "no owned slot is installed when the preflight refuses a proxy prototype");
  const pane = observer.snapshot();
  for (const name of paneFixture.PANE_REPLY_FIELD_NAMES) {
    assert.equal(pane[name], null, `${name} is an explicit null for an unsupported installation`);
  }
  assert.equal(observer.restore(), false);
});

test("owned hook installation unwinds a partial install for exact owned slots only", () => {
  const prototypeA: Record<string, unknown> = {};
  const prototypeB: Record<string, unknown> = {};
  const originalA = function originalA(): string { return "A"; };
  const originalB = function originalB(): string { return "B"; };
  Object.defineProperty(prototypeA, "list", { value: originalA, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(prototypeB, "setActiveMainOwner", { value: originalB, writable: true, configurable: true, enumerable: false });
  const hookA = function hookA(): string { return "hookA"; };
  const hookB = function hookB(): string { return "hookB"; };
  const slots = [
    { prototype: prototypeA, key: "list", descriptor: Object.getOwnPropertyDescriptor(prototypeA, "list")!, hook: hookA },
    { prototype: prototypeB, key: "setActiveMainOwner", descriptor: Object.getOwnPropertyDescriptor(prototypeB, "setActiveMainOwner")!, hook: hookB },
  ];
  const attempted: string[] = [];
  const defineProperty = (target: object, key: string, descriptor: PropertyDescriptor): void => {
    attempted.push(key);
    if (target === prototypeB && key === "setActiveMainOwner") throw new Error("SYNTHETIC install refusal");
    Object.defineProperty(target, key, descriptor);
  };
  assert.equal(paneFixture.installOwnedHooks(slots, defineProperty), false, "a refused install reports failure");
  assert.deepEqual(attempted, ["list", "setActiveMainOwner"], "the first slot was installed before the refusal");
  assert.equal(prototypeA.list, originalA, "the already-installed owned slot is unwound to its exact original descriptor");
  assert.equal(prototypeB.setActiveMainOwner, originalB, "the refused slot is never touched");
});

test("each pane snapshot performs exactly one bounded read and issues no extra production call", () => {
  const fakes = makeFakes();
  const observer = installOn(fakes);
  const surfaceA = new FakeSurface(modesWith("any", "sgr"));
  const manager = new fakes.FakeInstanceManager();
  manager.views = liveViews(["A"]);
  manager.surfaces = { A: surfaceA };
  const sidebar = new fakes.FakeSidebarController("main", "A");
  manager.list();
  sidebar.setActiveMainOwner("A");

  const forwardedLists = fakes.forwardedList.length;
  const forwardedOwners = fakes.forwardedOwner.length;
  const pane = observer.snapshot();
  assert.equal(pane.complete, true);
  assert.equal(surfaceA.inputModesCalls, 1, "exactly one pane mode read per snapshot");
  assert.equal(fakes.forwardedList.length, forwardedLists + 1, "the snapshot reads fresh views exactly once");
  assert.equal(fakes.forwardedOwner.length, forwardedOwners, "the snapshot never invokes the active-owner setter");

  observer.restore();
  assert.equal(observer.installed, false);
  const afterRestore = observer.snapshot();
  assert.equal(afterRestore.scope, null, "a restored observer reports unknown rather than a stale snapshot");
  assert.equal(afterRestore.complete, null);
});

test("an unsupported candidate class set reports an honest all-null unknown", () => {
  const observer = paneFixture.createPaneModeObserver(undefined);
  assert.equal(observer.installed, false);
  assert.equal(observer.unsupported, true);
  const pane = observer.snapshot();
  for (const name of paneFixture.PANE_REPLY_FIELD_NAMES) {
    assert.equal(pane[name], null, `${name} is an explicit null`);
  }
  assert.equal(observer.restore(), false);

  const absentEntry = join(process.cwd(), "tests", "fixtures", "__no-such-candidate-entry__", "main.js");
  const installed = paneFixture.installPaneModeObserver(absentEntry);
  assert.equal(installed.unsupported, true, "an unresolvable candidate is unsupported, never a fallback");
  assert.equal(installed.snapshot().scope, null);
});
