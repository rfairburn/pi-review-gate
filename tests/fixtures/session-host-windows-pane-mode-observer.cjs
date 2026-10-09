'use strict';

/**
 * Test-only transparent actual-owner pane-mode observer for the Windows Main
 * census.
 *
 * Diagnosis only: it reports the bounded boolean/enum state of the ACTUAL
 * active Main conversation pane (owner id presence, host focus, the matching
 * live roster row, and that pane surface's current parsed input modes) at one
 * fresh census snapshot. The mode values are current getter inputs of the
 * pane's own terminal surface — never a mirror decision, a terminal write,
 * byte delivery, delivery to the outer ConPTY, host start/shutdown, or a
 * native SDK emission. It never derives an owner from selection, roster order,
 * or a single/last child.
 *
 * Transparent forwarding rules:
 * - exactly two ORIGINAL candidate compiled class prototype methods are
 *   wrapped: `InstanceManager.prototype.list` and
 *   `SidebarController.prototype.setActiveMainOwner`. No constructor proxy,
 *   factory override, dependency-injection seam, or `__test` hook is used,
 *   and no input parser, writer, stream, or behavior is instrumented.
 * - each hook calls the exact captured original exactly once with the exact
 *   borrowed receiver and argument vector, returns the exact original return
 *   value, and rethrows the identical original error identity. Observation
 *   bookkeeping is entirely non-throwing: a receiver inspection that fails
 *   (including a proxy trap) becomes sticky unknown and never converts a
 *   successful original call into a throw.
 * - only the receiver object identity of a SUCCESSFUL original call is
 *   retained; a receiver whose exact immediate prototype is not the original
 *   candidate class prototype (borrowed/foreign/proxy) and a second distinct
 *   genuine instance are both sticky unknown, never last-wins.
 * - the observation reads ONLY current resolutions that production Main would
 *   see: bounded own/current descriptors are checked for `list`, `surface`,
 *   `focus`, `activeMainOwnerID`, and the pane surface's `inputModes`, and the
 *   exact captured object/immediate-prototype, class-prototype, constructor,
 *   and candidate module/export identities are revalidated at observation.
 *   That revalidation is descriptor/cache-only: it inspects own data
 *   descriptors and retained require-cache entries, never re-requires a
 *   possibly evicted candidate (which would rerun its top-level behavior) and
 *   never reads a replaced accessor export or constructor (which would invoke
 *   an arbitrary getter). Proxy prototypes and proxy receivers are refused
 *   before any trap can run. Any own shadow, replaced getter/method slot,
 *   changed prototype, changed module export, or non-original pane prototype
 *   is refused as unknown instead of being bypassed through a saved original.
 *   Only after that resolution check passes are the retained original `list` /
 *   `surface`, `inputModes`, and `activeMainOwnerID` / `focus` getters used for
 *   the bounded reads. No arbitrary prototype walk, private field, internal
 *   SDK state, frame, raw child data, id, PID, path, cwd, label, name,
 *   environment, transcript, or argument value is ever stored, formatted, or
 *   logged.
 * - an unsupported install (missing/replaced/non-configurable descriptor,
 *   failed preflight, or a mid-install refusal) never changes public Main
 *   execution and never throws: it reports unknown rather than a fabricated
 *   fallback, and restore only unwinds slots that still hold this observer's
 *   exact hook. A snapshot that observes an owned-slot replacement or a
 *   changed resolution latches sticky unknown permanently.
 *
 * TESTONLY native-binding extension (`options.nativeBinding`): a narrow
 * optional callback invoked INSIDE the same fresh pane snapshot, only after
 * the actual owner row is positively matched live and alive. It receives the
 * exact matched row and the fresh request nonce (when supplied to
 * `snapshot(nonce)`) and may return a bounded binding object
 * `{ ptyPid, incarnation, sessionEpoch, expectedProof }` (the raw session id
 * stays private to the callback; the opaque proof binds it) or undefined. The
 * result is strictly validated into the independent bounded `nativeBinding()`
 * group: scope true means the observation ran inside an intact matched live
 * owner view (fields report what was positively resolved); scope null means it
 * was never established (no callback, no owner, disturbed pane scope, or
 * unsupported install). The group is committed only when the WHOLE snapshot
 * pass completes with an intact scope: any later disturbance (replaced
 * resolution, failed mode read that invalidates scope) leaves the group
 * unestablished so a valid Main reply can never be rejected by cross-group
 * consistency. A throwing or invalid callback result is an all-null unknown
 * group and never changes the original call or the existing active-pane
 * fields. No constructor, factory, DI seam, or second owner read is
 * introduced; the callback is the only channel to the exact original PTY
 * registry. Extra private callback-result fields (such as the raw bootstrap
 * tuple) are never validated into or published by the group.
 *
 * TESTONLY exchange-guard extension (`options.guard`): an optional observation
 * sink `{ arm, onList, onOwner, onFocus }` for the original-Main-origin native
 * exchange guard. A THIRD owned hook wraps the original `focus` prototype
 * accessor exactly like the two method hooks: the exact original getter runs
 * once with the exact borrowed receiver, returns the exact value, and
 * rethrows the identical error; observation is non-throwing and a foreign or
 * proxy receiver is forwarded unchanged. While the guard is armed, every
 * successful original `list` result row set, `setActiveMainOwner` argument,
 * and `focus` getter return is forwarded to the sink (which latches sticky
 * disturbances itself). When a snapshot pass commits a COMPLETE native-binding
 * group with an intact scope, the sink's `arm(nonce, facts)` is invoked once
 * for that pass with the private pass facts (actual owner id, raw focus value,
 * matched live row, committed binding group, raw callback result, and the
 * original manager/sidebar/surface identities) — before any reply is
 * published. `revalidateScope(facts)` performs the fresh pure current
 * actual-scope proof for the armed guard: owned slots, current resolutions,
 * module identity, and the actual owner/focus/row/session/surface must all
 * still match the armed facts; it returns the current row's session tuple or
 * undefined and never throws.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { types } = require('node:util');

/** Fixed known candidate module leaves; no readdir/adoption is performed. */
const CANDIDATE_LEAVES = Object.freeze([
  Object.freeze({ exportName: 'InstanceManager', leaf: 'instances.js' }),
  Object.freeze({ exportName: 'SidebarController', leaf: 'sidebar.js' }),
  Object.freeze({ exportName: 'TerminalSurface', leaf: 'terminal-surface.js' }),
]);

const MAX_CANDIDATE_LEAF_BYTES = 4n * 1024n * 1024n;

/** Known bounded mouse tracking enum taken from the declared TerminalInputModes union. */
const MOUSE_TRACKING_ENUM = Object.freeze({ none: 0, x10: 1, vt200: 2, drag: 3, any: 4 });
/** Known bounded mouse encoding enum taken from the declared TerminalInputModes union. */
const MOUSE_ENCODING_ENUM = Object.freeze({ default: 0, sgr: 1, 'sgr-pixels': 2 });

/** Observed boolean fields (excluding the independent complete/scope flags). */
const PANE_DATA_BOOLEAN_FIELDS = Object.freeze([
  'focusMain', 'hasLiveProcess', 'lifecycleAlive', 'modesReadSucceeded',
  'ownerPresent', 'surfacePresent', 'viewMatched',
]);

/** Exact bounded active-pane field names shared with the parent contract validator. */
const PANE_REPLY_FIELD_NAMES = Object.freeze([
  'complete', 'focusMain', 'geometryColumns', 'geometryRows', 'hasLiveProcess',
  'lifecycleAlive', 'modesReadSucceeded', 'mouseEncoding', 'mouseTracking',
  'ownerPresent', 'scope', 'surfacePresent', 'viewMatched',
]);

/** All-null unknown active-pane group. */
function unknownPaneFields() {
  const fields = {};
  for (const name of PANE_REPLY_FIELD_NAMES) fields[name] = null;
  return fields;
}

/** All-null group with a disturbed scope and an honestly incomplete result. */
function unknownScopeFields() {
  const fields = unknownPaneFields();
  fields.scope = false;
  fields.complete = false;
  return fields;
}

/** Exact bounded native-binding field names shared with the parent contract validator. */
const NATIVE_BINDING_FIELD_NAMES = Object.freeze([
  'complete', 'expectedProof', 'incarnation', 'ptyPid', 'scope', 'sessionEpoch',
]);
const NATIVE_PROOF_PATTERN = /^[0-9a-f]{64}$/;

/** All-null group: the native binding observation was never established. */
function unestablishedNativeBinding() {
  const fields = {};
  for (const name of NATIVE_BINDING_FIELD_NAMES) fields[name] = null;
  return fields;
}

/** Bounded unknown group from an attempted-but-unresolved binding observation. */
function unknownNativeBinding() {
  const fields = unestablishedNativeBinding();
  fields.scope = true;
  fields.complete = false;
  return fields;
}

/**
 * Strictly validates one TESTONLY callback result into the bounded group.
 * Pair coherence is enforced here (ptyPid/incarnation and sessionEpoch/
 * expectedProof are published together or not at all) so a broken callback
 * can never publish a partial tuple; expectedProof requires its inputs. The
 * raw sessionId may be present in the callback result (the callback needs it
 * to compute the proof) but is never validated into or published by the
 * group. Any unsupported value is an honest all-null unknown with scope true
 * (the observation ran inside a valid owner view but resolved nothing).
 */
function buildNativeBindingGroup(result) {
  if (result === undefined || result === null || typeof result !== 'object' || Array.isArray(result)) {
    return unknownNativeBinding();
  }
  let ptyPid = Number.isSafeInteger(result.ptyPid) && result.ptyPid > 1 ? result.ptyPid : null;
  let incarnation = Number.isSafeInteger(result.incarnation) && result.incarnation >= 1 ? result.incarnation : null;
  let sessionEpoch = Number.isSafeInteger(result.sessionEpoch) && result.sessionEpoch >= 1 ? result.sessionEpoch : null;
  let expectedProof = typeof result.expectedProof === 'string' && NATIVE_PROOF_PATTERN.test(result.expectedProof)
    ? result.expectedProof
    : null;
  if (ptyPid !== null && incarnation === null) ptyPid = null; // pair coherence
  if (incarnation !== null && ptyPid === null) incarnation = null;
  if (sessionEpoch !== null && expectedProof === null) sessionEpoch = null;
  if (expectedProof !== null && (ptyPid === null || incarnation === null || sessionEpoch === null)) {
    expectedProof = null; // a proof without its full tuple is never published
    sessionEpoch = null; // the epoch travels with the refused proof pair
  }
  const complete = ptyPid !== null && incarnation !== null && sessionEpoch !== null
    && expectedProof !== null;
  return { scope: true, complete, ptyPid, incarnation, sessionEpoch, expectedProof };
}

/** Non-throwing own-descriptor read; undefined covers both absence and unreadable. */
function safeGetOwnDescriptor(target, key) {
  try {
    return Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return undefined;
  }
}

/** True only when the own descriptor is positively absent. */
function ownDescriptorAbsent(receiver, key) {
  try {
    return Object.getOwnPropertyDescriptor(receiver, key) === undefined;
  } catch {
    return false; // an unreadable own descriptor is refused, never assumed absent
  }
}

function safeGetPrototypeOf(receiver) {
  try {
    return Object.getPrototypeOf(receiver);
  } catch {
    return undefined;
  }
}

function ownDataMethod(prototype, key) {
  const descriptor = safeGetOwnDescriptor(prototype, key);
  if (descriptor === undefined) return undefined;
  if (descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
  if (typeof descriptor.value !== 'function') return undefined;
  if (descriptor.configurable !== true) return undefined; // an unsupported slot is never touched
  return descriptor;
}

function ownAccessorGetter(prototype, key) {
  const descriptor = safeGetOwnDescriptor(prototype, key);
  if (descriptor === undefined) return undefined;
  return typeof descriptor.get === 'function' ? descriptor.get : undefined;
}

/** True only for a proxy object, detected without invoking any of its traps. */
function isProxyObject(value) {
  try {
    return types.isProxy(value);
  } catch {
    return true; // an uninspectable value is refused
  }
}

/**
 * True only when the prototype's own `constructor` data descriptor names the
 * expected class. A replaced constructor accessor is refused without invoking
 * its getter.
 */
function ownConstructorIs(prototype, expected) {
  if (isProxyObject(prototype)) return false;
  const descriptor = safeGetOwnDescriptor(prototype, 'constructor');
  return descriptor !== undefined && descriptor.value === expected;
}

/** True only for a receiver whose exact immediate prototype is the class prototype. */
function isGenuineReceiver(receiver, Class) {
  if (receiver === null || typeof receiver !== 'object') return false;
  if (isProxyObject(receiver)) return false; // a proxy receiver is refused without invoking its traps
  if (Class === undefined || Class.prototype === null || typeof Class.prototype !== 'object') return false;
  return safeGetPrototypeOf(receiver) === Class.prototype;
}

/**
 * Resolves the exact candidate compiled class constructors from the fixed
 * known sibling leaves of the candidate Main entry. Only bounded regular,
 * non-symlink JS leaves are read; a missing, replaced, or oversized leaf
 * refuses rather than falling back to ambient resolution. Also returns a
 * bounded module/export identity recheck for observation time.
 */
function resolveCandidatePaneClasses(mainEntry, options = {}) {
  const fs = options.fs === undefined ? nodeFs : options.fs;
  if (typeof mainEntry !== 'string' || mainEntry.length === 0) {
    throw new TypeError('pane-mode observer requires the candidate Main entry path');
  }
  const directory = path.dirname(mainEntry);
  const classes = {};
  const modules = {};
  for (const entry of CANDIDATE_LEAVES) {
    const target = path.join(directory, entry.leaf); // fixed known leaf: no readdir/adoption
    const stats = fs.lstatSync(target, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0n || stats.size > MAX_CANDIDATE_LEAF_BYTES) {
      throw new Error(`pane-mode observer candidate ${entry.leaf} is not a bounded regular nonsymlink module leaf`);
    }
    const loaded = require(target);
    const exportDescriptor = loaded === null || typeof loaded !== 'object' || isProxyObject(loaded)
      ? undefined
      : safeGetOwnDescriptor(loaded, entry.exportName);
    const value = exportDescriptor === undefined ? undefined : exportDescriptor.value;
    if (typeof value !== 'function') {
      throw new Error(`pane-mode observer candidate ${entry.leaf} does not export the ${entry.exportName} constructor`);
    }
    const cacheKey = require.resolve(target);
    const cacheDescriptor = safeGetOwnDescriptor(require.cache, cacheKey);
    classes[entry.exportName] = value;
    modules[entry.exportName] = {
      cacheKey,
      cacheEntry: cacheDescriptor === undefined ? undefined : cacheDescriptor.value,
      module: loaded,
    };
  }
  return { classes, recheck: (cache) => recheckCandidateModules(classes, modules, cache) };
}

/**
 * Bounded module/export identity recheck that inspects only retained require
 * cache entries and own data descriptors: it never re-requires a possibly
 * evicted candidate (which would rerun its top-level behavior) and never reads
 * a replaced accessor export (which would invoke an arbitrary getter). An
 * optional injected `cache` keeps the checker purely testable; it defaults to
 * the live `require.cache`. Never throws.
 */
function recheckCandidateModules(classes, modules, cache) {
  try {
    const resolvedCache = cache === undefined ? require.cache : cache;
    if (resolvedCache === null || typeof resolvedCache !== 'object' || isProxyObject(resolvedCache)) return false;
    for (const entry of CANDIDATE_LEAVES) {
      const record = modules[entry.exportName];
      if (record === undefined) return false;
      const cacheDescriptor = safeGetOwnDescriptor(resolvedCache, record.cacheKey);
      const cached = cacheDescriptor === undefined ? undefined : cacheDescriptor.value;
      if (cached === undefined || cached !== record.cacheEntry || isProxyObject(cached)) return false;
      const exportsDescriptor = safeGetOwnDescriptor(cached, 'exports');
      const loaded = exportsDescriptor === undefined ? undefined : exportsDescriptor.value;
      if (loaded !== record.module || loaded === null || typeof loaded !== 'object' || isProxyObject(loaded)) {
        return false;
      }
      const exportDescriptor = safeGetOwnDescriptor(loaded, entry.exportName);
      if (exportDescriptor === undefined || exportDescriptor.value !== classes[entry.exportName]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Minimal all-unknown observer returned when even construction is refused. */
function unsupportedObserver() {
  return {
    snapshot: () => unknownPaneFields(),
    nativeBinding: () => unestablishedNativeBinding(),
    revalidateScope: () => undefined,
    restore: () => false,
    get installed() { return false; },
    get unsupported() { return true; },
  };
}

/**
 * Installs the owned hooks atomically: any failure unwinds exactly the slots
 * that still hold this observer's own hook, and a refused or foreign slot is
 * never touched. Data-method slots install `{ value: hook }`; accessor slots
 * (`slot.accessor === true`) install `{ get: hook }`. The original descriptor
 * (data or accessor) is restored exactly on unwind. `defineProperty` is
 * injectable so pure tests can exercise the partial-installation unwind
 * without a proxy.
 */
function installOwnedHooks(slots, defineProperty) {
  const installedSlots = [];
  try {
    for (const slot of slots) {
      if (slot.accessor === true) {
        defineProperty(slot.prototype, slot.key, { get: slot.hook, configurable: true });
      } else {
        defineProperty(slot.prototype, slot.key, {
          value: slot.hook,
          writable: true,
          enumerable: slot.descriptor.enumerable,
          configurable: true,
        });
      }
      installedSlots.push(slot);
    }
    return true;
  } catch {
    for (const slot of installedSlots.reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(slot.prototype, slot.key);
        if (current !== undefined && (slot.accessor === true ? current.get === slot.hook : current.value === slot.hook)) {
          Object.defineProperty(slot.prototype, slot.key, slot.descriptor);
        }
      } catch {
        // Exact owned slot only; a failed unwind leaves the foreign slot at rest.
      }
    }
    return false;
  }
}

/** Strict TESTONLY guard-sink shape; anything else is ignored (no guard). */
function isGuardSink(value) {
  return value !== null && typeof value === 'object'
    && typeof value.arm === 'function' && typeof value.onList === 'function'
    && typeof value.onOwner === 'function' && typeof value.onFocus === 'function';
}

/**
 * Installs the transparent prototype observers on the supplied original
 * candidate classes. Never throws: an unsupported install returns an observer
 * whose snapshot is an honest all-null unknown, so public Main execution is
 * unchanged and no fabricated fallback is reported.
 */
function createPaneModeObserver(candidate, options = {}) {
  const nativeBindingCallback = options !== null && typeof options === 'object' && typeof options.nativeBinding === 'function'
    ? options.nativeBinding
    : undefined;
  const guard = options !== null && typeof options === 'object' && isGuardSink(options.guard)
    ? options.guard
    : undefined;
  const state = {
    installed: false,
    unsupported: false,
    scopeInvalid: false,
    manager: undefined,
    sidebar: undefined,
    snapshotNonce: undefined,
  };
  // The bounded native-binding group produced by the most recent snapshot
  // pass (TESTONLY); reset at every snapshot start so a stale binding can
  // never outlive its fresh pane observation. `pendingNativeBinding` is the
  // provisional result of this pass; it is committed to lastNativeBinding
  // ONLY when the whole pass completes with an intact scope, so a later
  // disturbance can never leave a complete group behind an unknown pane.
  let lastNativeBinding = unestablishedNativeBinding();
  let pendingNativeBinding;
  const classes = candidate !== null && typeof candidate === 'object' ? candidate : undefined;
  const recheck = classes !== undefined && typeof classes.recheck === 'function' ? classes.recheck : undefined;
  let managerPrototype;
  let sidebarPrototype;
  let terminalSurfacePrototype;
  let descriptors;
  // The complete original focus PropertyDescriptor, retained separately from
  // its getter function: restoration and unwind must return the exact
  // original accessor, and a non-configurable accessor is never touched.
  let focusOriginal;
  let slots = [];
  // The first successfully armed pane scope, retained privately so every
  // later observation boundary can re-check its supported resolution.
  let armedPaneScope;

  function classIdentitiesIntact() {
    try {
      return ownConstructorIs(managerPrototype, classes.InstanceManager)
        && ownConstructorIs(sidebarPrototype, classes.SidebarController)
        && ownConstructorIs(terminalSurfacePrototype, classes.TerminalSurface)
        && classes.InstanceManager.prototype === managerPrototype
        && classes.SidebarController.prototype === sidebarPrototype
        && classes.TerminalSurface.prototype === terminalSurfacePrototype;
    } catch {
      return false;
    }
  }

  try {
    const supported = classes !== undefined
      && typeof classes.InstanceManager === 'function'
      && typeof classes.SidebarController === 'function'
      && typeof classes.TerminalSurface === 'function'
      && !isProxyObject(classes.InstanceManager)
      && !isProxyObject(classes.SidebarController)
      && !isProxyObject(classes.TerminalSurface);
    if (!supported) {
      state.unsupported = true;
    } else {
      managerPrototype = classes.InstanceManager.prototype;
      sidebarPrototype = classes.SidebarController.prototype;
      terminalSurfacePrototype = classes.TerminalSurface.prototype;
      if (managerPrototype === null || typeof managerPrototype !== 'object'
        || sidebarPrototype === null || typeof sidebarPrototype !== 'object'
        || terminalSurfacePrototype === null || typeof terminalSurfacePrototype !== 'object'
        || isProxyObject(managerPrototype) || isProxyObject(sidebarPrototype)
        || isProxyObject(terminalSurfacePrototype)) {
        state.unsupported = true; // a proxy prototype is refused before any trap can run
      } else {
        const focusDescriptor = safeGetOwnDescriptor(sidebarPrototype, 'focus');
        focusOriginal = focusDescriptor !== undefined && typeof focusDescriptor.get === 'function'
          && focusDescriptor.configurable === true
          ? focusDescriptor
          : undefined;
        descriptors = {
          list: ownDataMethod(managerPrototype, 'list'),
          surface: ownDataMethod(managerPrototype, 'surface'),
          setActiveMainOwner: ownDataMethod(sidebarPrototype, 'setActiveMainOwner'),
          activeMainOwnerID: ownAccessorGetter(sidebarPrototype, 'activeMainOwnerID'),
          focus: focusOriginal !== undefined ? focusOriginal.get : undefined,
          inputModes: ownDataMethod(terminalSurfacePrototype, 'inputModes'),
        };
        if (descriptors.list === undefined || descriptors.surface === undefined
          || descriptors.setActiveMainOwner === undefined
          || descriptors.activeMainOwnerID === undefined || descriptors.focus === undefined
          || focusOriginal === undefined
          || descriptors.inputModes === undefined) {
          state.unsupported = true; // unsupported descriptor: report unknown, never a partial install
        } else if (!classIdentitiesIntact()) {
          state.unsupported = true; // prototype/constructor/module identity mismatch
        }
      }
    }
  } catch {
    state.unsupported = true;
  }

  function recordReceiver(kind, receiver, Class) {
    try {
      if (state.scopeInvalid) return;
      if (!isGenuineReceiver(receiver, Class)) {
        state.scopeInvalid = true; // a foreign/proxy receiver is never the actual instance
        return;
      }
      const current = state[kind];
      if (current === undefined) {
        state[kind] = receiver;
        return;
      }
      if (receiver !== current) {
        state.scopeInvalid = true; // a second actual instance is sticky ambiguity, never last-wins
      }
    } catch {
      state.scopeInvalid = true; // observation-only bookkeeping never changes a successful original call
    }
  }

  /**
   * Bounded non-throwing scope check at an observation boundary: while a
   * supported original hook is running, the current descriptor/module/surface
   * resolutions must still be intact. A disturbed boundary (even one restored
   * before the next snapshot) latches sticky uncertainty permanently.
   */
  function observeScopeAtBoundary() {
    try {
      for (const slot of slots) {
        if (!slotHoldsOurHook(slot)) state.scopeInvalid = true; // a replaced owned slot missed calls: sticky
      }
      if (!currentResolutionsIntact()) state.scopeInvalid = true;
      if (!state.scopeInvalid && armedPaneScope !== undefined) {
        const surface = Reflect.apply(descriptors.surface.value, state.manager, [armedPaneScope.ownerId]);
        if (surface !== armedPaneScope.surface || resolveInputModes(surface) === undefined) {
          state.scopeInvalid = true; // the armed pane scope was disturbed and restored: sticky
        }
      }
    } catch {
      state.scopeInvalid = true; // an unreadable scope is sticky unknown, never bypassed
    }
  }

  const listHook = function sessionHostPaneObserverList(...args) {
    // The original call happens exactly once and runs first: a throwing
    // original propagates its identical error and records no receiver.
    const result = Reflect.apply(descriptors.list.value, this, args);
    recordReceiver('manager', this, classes.InstanceManager);
    observeScopeAtBoundary();
    if (guard !== undefined) {
      try { guard.onList(result); } catch { /* observation-only bookkeeping never changes the call */ }
    }
    return result;
  };

  const ownerHook = function sessionHostPaneObserverSetActiveMainOwner(...args) {
    const result = Reflect.apply(descriptors.setActiveMainOwner.value, this, args);
    recordReceiver('sidebar', this, classes.SidebarController);
    observeScopeAtBoundary();
    if (guard !== undefined) {
      try { guard.onOwner(args[0]); } catch { /* observation-only bookkeeping never changes the call */ }
    }
    return result;
  };

  const focusHook = function sessionHostPaneObserverFocus() {
    // The original getter runs exactly once with the exact borrowed receiver:
    // a throwing original propagates its identical error and records nothing.
    const result = Reflect.apply(descriptors.focus, this, []);
    observeScopeAtBoundary();
    if (guard !== undefined) {
      try { guard.onFocus(result, this); } catch { /* observation-only bookkeeping never changes the call */ }
    }
    return result;
  };

  if (!state.unsupported) {
    slots = [
      { prototype: managerPrototype, key: 'list', descriptor: descriptors.list, hook: listHook },
      { prototype: sidebarPrototype, key: 'setActiveMainOwner', descriptor: descriptors.setActiveMainOwner, hook: ownerHook },
      { prototype: sidebarPrototype, key: 'focus', descriptor: focusOriginal, hook: focusHook, accessor: true },
    ];
    if (installOwnedHooks(slots, Object.defineProperty)) {
      state.installed = true;
    } else {
      state.installed = false;
      state.unsupported = true;
    }
  }

  function slotHoldsOurHook(slot) {
    const current = safeGetOwnDescriptor(slot.prototype, slot.key);
    if (current === undefined) return false;
    return slot.accessor === true ? current.get === slot.hook : current.value === slot.hook;
  }

  /**
   * Bounded current-resolution check. Production Main resolves `list`,
   * `surface`, `focus`, and `activeMainOwnerID` through the instance and its
   * immediate prototype; a changed resolution must be refused, never bypassed
   * through a saved original.
   */
  function currentResolutionsIntact() {
    try {
      if (typeof recheck === 'function' && !recheck()) return false; // candidate module/export changed
      if (!classIdentitiesIntact()) return false; // class prototype/constructor changed
      if (state.manager !== undefined) {
        if (safeGetPrototypeOf(state.manager) !== managerPrototype) return false; // immediate prototype changed
        if (!ownDescriptorAbsent(state.manager, 'constructor')) return false; // own constructor shadow refused unread
        if (!ownDescriptorAbsent(state.manager, 'list') || !ownDescriptorAbsent(state.manager, 'surface')) return false;
        const currentSurface = safeGetOwnDescriptor(managerPrototype, 'surface');
        if (currentSurface === undefined || currentSurface.value !== descriptors.surface.value) return false;
      }
      if (state.sidebar !== undefined) {
        if (safeGetPrototypeOf(state.sidebar) !== sidebarPrototype) return false; // immediate prototype changed
        if (!ownDescriptorAbsent(state.sidebar, 'constructor')) return false; // own constructor shadow refused unread
        if (!ownDescriptorAbsent(state.sidebar, 'activeMainOwnerID') || !ownDescriptorAbsent(state.sidebar, 'focus')) {
          return false;
        }
        const currentOwner = safeGetOwnDescriptor(sidebarPrototype, 'activeMainOwnerID');
        const currentFocus = safeGetOwnDescriptor(sidebarPrototype, 'focus');
        if (currentOwner === undefined || currentOwner.get !== descriptors.activeMainOwnerID) return false;
        // The focus slot holds our owned hook while installed; any other
        // resolution (original or foreign) is refused, never bypassed.
        if (currentFocus === undefined || (currentFocus.get !== descriptors.focus && currentFocus.get !== focusHook)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Bounded current-resolution check for one pane surface's own `inputModes`. */
  function resolveInputModes(surface) {
    try {
      if (isProxyObject(surface)) return undefined; // a proxy surface is refused without invoking its traps
      if (!ownDescriptorAbsent(surface, 'constructor')) return undefined; // own constructor shadow refused unread
      if (!ownDescriptorAbsent(surface, 'inputModes')) return undefined; // own shadow refused
      if (safeGetPrototypeOf(surface) !== terminalSurfacePrototype) return undefined; // exact original prototype only
      if (classes.TerminalSurface.prototype !== terminalSurfacePrototype) return undefined;
      const current = safeGetOwnDescriptor(terminalSurfacePrototype, 'inputModes');
      if (current === undefined || current.value !== descriptors.inputModes.value) return undefined;
      return descriptors.inputModes.value;
    } catch {
      return undefined;
    }
  }

  function paneFieldsAllKnown(fields) {
    for (const name of PANE_DATA_BOOLEAN_FIELDS) {
      if (typeof fields[name] !== 'boolean') return false;
    }
    return typeof fields.mouseTracking === 'number' && typeof fields.mouseEncoding === 'number';
  }

  function observeOwnerView(fields, ownerId, pass) {
    let views;
    try {
      // Current production resolution was validated; the saved original is
      // therefore the exact method production Main would reach.
      views = Reflect.apply(descriptors.list.value, state.manager, []);
    } catch {
      views = undefined; // a throwing original list leaves the owner view unknown
    }
    if (!Array.isArray(views)) {
      fields.viewMatched = null;
      return;
    }
    let match;
    let matches = 0;
    for (const view of views) {
      if (view !== null && typeof view === 'object' && view.id === ownerId) {
        match = view;
        matches += 1;
      }
    }
    if (matches === 0) {
      fields.viewMatched = false; // a positively known owner with no row is never redirected to a sibling
      fields.hasLiveProcess = false;
      fields.lifecycleAlive = false;
      fields.surfacePresent = false;
      fields.modesReadSucceeded = false;
      return;
    }
    if (matches > 1) {
      fields.viewMatched = null; // duplicate matching rows: never guess which row the owner is
      return;
    }
    fields.viewMatched = true;
    pass.row = match; // private pass fact for the TESTONLY exchange-guard arm
    fields.hasLiveProcess = match.hasLiveProcess === true;
    fields.lifecycleAlive = match.lifecycle === 'alive';
    if (!fields.hasLiveProcess || !fields.lifecycleAlive) {
      fields.surfacePresent = false; // the actual pane gate is not satisfied: no surface read
      fields.modesReadSucceeded = false;
      return;
    }
    // TESTONLY native binding, produced inside this same fresh pane snapshot
    // for the exact matched live owner row. Observation bookkeeping only:
    // a throwing callback never changes the original call or the pane fields.
    if (nativeBindingCallback !== undefined) {
      let result;
      try {
        result = nativeBindingCallback(match, state.snapshotNonce);
      } catch {
        result = undefined;
      }
      pass.rawBinding = result; // private raw callback result for the guard arm
      pendingNativeBinding = buildNativeBindingGroup(result); // provisional until the scope stays intact
    }
    let surface;
    try {
      surface = Reflect.apply(descriptors.surface.value, state.manager, [ownerId]);
    } catch {
      // A failed lookup does not establish absence of an otherwise live pane.
      fields.surfacePresent = null;
      fields.modesReadSucceeded = null;
      return;
    }
    if (surface === null || typeof surface !== 'object') {
      fields.surfacePresent = false;
      fields.modesReadSucceeded = false;
      return;
    }
    pass.surface = surface; // private pass fact for the TESTONLY exchange-guard arm
    const inputModes = resolveInputModes(surface);
    if (inputModes === undefined) {
      state.scopeInvalid = true; // a changed pane-mode resolution is persistently unknown
      fields.surfacePresent = true; // the pane object exists, but its mode resolution is refused
      fields.modesReadSucceeded = false;
      fields.mouseTracking = null;
      fields.mouseEncoding = null;
      return;
    }
    fields.surfacePresent = true;
    let modes;
    try {
      modes = Reflect.apply(inputModes, surface, []); // one pure current getter read
    } catch {
      modes = undefined; // disposed or otherwise unreadable surface: unknown, never a fabricated mode
    }
    if (modes === null || typeof modes !== 'object') {
      fields.modesReadSucceeded = false;
      fields.mouseTracking = null;
      fields.mouseEncoding = null;
      return;
    }
    fields.modesReadSucceeded = true;
    const tracking = MOUSE_TRACKING_ENUM[modes.mouseTracking];
    const encoding = MOUSE_ENCODING_ENUM[modes.mouseEncoding];
    fields.mouseTracking = typeof tracking === 'number' ? tracking : null;
    fields.mouseEncoding = typeof encoding === 'number' ? encoding : null;
  }

  function snapshot(nonce) {
    state.snapshotNonce = typeof nonce === 'string' ? nonce : undefined;
    lastNativeBinding = unestablishedNativeBinding();
    pendingNativeBinding = undefined;
    // Pass-scoped private facts for the TESTONLY exchange-guard arm: the raw
    // focus value, owner id, matched live row, pane surface, and raw binding
    // callback result of THIS pass only (never retained across passes).
    const pass = { ownerId: undefined, focusValue: undefined, row: undefined, surface: undefined, rawBinding: undefined };
    try {
      if (!state.installed) {
        return unknownPaneFields(); // complete null, scope null: the observation scope was never established
      }
      let scopeIntact = true;
      for (const slot of slots) {
        if (!slotHoldsOurHook(slot)) {
          state.scopeInvalid = true; // a replaced slot missed calls: sticky, never repaired by reinstallation
          scopeIntact = false;
        }
      }
      if (state.scopeInvalid) scopeIntact = false;
      if (!scopeIntact) return unknownScopeFields();
      if (!currentResolutionsIntact()) {
        state.scopeInvalid = true; // a changed own/prototype/module resolution is sticky unknown, never bypassed
        return unknownScopeFields();
      }
      const fields = unknownPaneFields();
      fields.scope = true;
      try {
        const focus = Reflect.apply(descriptors.focus, state.sidebar, []);
        pass.focusValue = focus;
        fields.focusMain = focus === 'main' ? true
          : focus === 'sidebar' || focus === 'form' || focus === 'confirm' ? false : null;
      } catch {
        fields.focusMain = null; // a throwing getter is unknown, never a functional failure
      }
      let ownerId;
      if (state.sidebar === undefined) {
        fields.ownerPresent = null;
      } else {
        try {
          const raw = Reflect.apply(descriptors.activeMainOwnerID, state.sidebar, []);
          if (raw === undefined || raw === null || raw === '') {
            fields.ownerPresent = false; // a missing actual owner is a known no-owner, never an active pane
            ownerId = undefined;
          } else if (typeof raw === 'string') {
            fields.ownerPresent = true;
            ownerId = raw;
          } else {
            fields.ownerPresent = null;
          }
        } catch {
          fields.ownerPresent = null;
        }
      }
      if (fields.ownerPresent === true && ownerId !== undefined && state.manager !== undefined) {
        pass.ownerId = ownerId;
        observeOwnerView(fields, ownerId, pass);
      } else if (fields.ownerPresent === false) {
        fields.viewMatched = false;
        fields.hasLiveProcess = false;
        fields.lifecycleAlive = false;
        fields.surfacePresent = false;
        fields.modesReadSucceeded = false;
      }
      // Pane resolution checks can disturb scope during this very observation.
      // Never publish an intact scope first and invalidate only a later read;
      // a disturbed pass also never commits the provisional native binding,
      // so the Main reply stays valid with an unestablished binding group.
      if (state.scopeInvalid) return unknownScopeFields();
      if (pendingNativeBinding !== undefined) {
        lastNativeBinding = pendingNativeBinding;
        // TESTONLY: arm the single original-Main-origin exchange guard when
        // this pass first constructs a complete actual-owner binding, before
        // the reply is published. Observation-only bookkeeping: it never
        // changes the pane fields or any original call.
        if (guard !== undefined && pendingNativeBinding.complete === true) {
          try {
            const armedNow = guard.arm(state.snapshotNonce, {
              ownerId: pass.ownerId,
              focus: pass.focusValue,
              row: pass.row,
              binding: pendingNativeBinding,
              bootstrap: pass.rawBinding === null || typeof pass.rawBinding !== 'object'
                ? undefined
                : pass.rawBinding.bootstrap,
              manager: state.manager,
              sidebar: state.sidebar,
              surface: pass.surface,
            });
            if (armedNow === true && armedPaneScope === undefined) {
              armedPaneScope = { ownerId: pass.ownerId, surface: pass.surface };
            }
          } catch { /* observation-only bookkeeping never changes the reply */ }
        }
      }
      fields.complete = paneFieldsAllKnown(fields);
      return fields;
    } catch {
      state.scopeInvalid = true; // an unexpected observation failure is unknown, never a functional failure
      return unknownScopeFields();
    }
  }

  function restore() {
    let restored = false;
    for (const slot of slots) {
      try {
        if (!slotHoldsOurHook(slot)) continue; // never clobber a foreign replacement
        Object.defineProperty(slot.prototype, slot.key, slot.descriptor);
        restored = true;
      } catch {
        // Exact owned slot only.
      }
    }
    state.installed = false;
    return restored;
  }

  /**
   * TESTONLY fresh pure current actual-scope proof for the armed exchange
   * guard. `facts` is the guard's private armed object (the copies produced
   * by createNativeExchangeGuard.arm: ownerId, focus, sessionId, sessionEpoch,
   * manager, sidebar, surface). Every owned slot, current resolution, and
   * module identity must still be intact, and the actual owner id, focus
   * value, matched live row (with its current native session tuple equal to
   * the armed copies), pane surface, and pane-mode resolution must all still
   * match. Returns the current row's session tuple `{ sessionId,
   * sessionEpoch }` or undefined; never throws.
   */
  function revalidateScope(facts) {
    try {
      if (facts === null || typeof facts !== 'object') return undefined;
      if (state.unsupported || !state.installed || state.scopeInvalid) return undefined;
      for (const slot of slots) {
        if (!slotHoldsOurHook(slot)) return undefined; // a replaced slot missed calls: refuse
      }
      if (!currentResolutionsIntact()) return undefined; // own/prototype/module drift: refuse
      if (state.manager === undefined || state.sidebar === undefined) return undefined;
      if (state.manager !== facts.manager || state.sidebar !== facts.sidebar) return undefined; // identity must be identical
      if (typeof facts.ownerId !== 'string' || typeof facts.focus !== 'string') return undefined;
      // The armed tuple fields are the guard's private copies, not the live row.
      if (typeof facts.sessionId !== 'string' || !Number.isSafeInteger(facts.sessionEpoch)) return undefined;
      const ownerId = Reflect.apply(descriptors.activeMainOwnerID, state.sidebar, []);
      if (ownerId !== facts.ownerId) return undefined;
      const focus = Reflect.apply(descriptors.focus, state.sidebar, []);
      if (focus !== facts.focus) return undefined;
      const views = Reflect.apply(descriptors.list.value, state.manager, []);
      if (!Array.isArray(views)) return undefined;
      let match;
      let matches = 0;
      for (const view of views) {
        if (view !== null && typeof view === 'object' && view.id === facts.ownerId) {
          match = view;
          matches += 1;
        }
      }
      if (matches !== 1) return undefined; // absent or duplicate owner row: refuse
      if (match.hasLiveProcess !== true || match.lifecycle !== 'alive') return undefined;
      const session = match.nativeSession;
      if (session === null || typeof session !== 'object') return undefined;
      if (typeof session.sessionId !== 'string' || session.sessionId.length === 0) return undefined;
      if (!Number.isSafeInteger(session.epoch)) return undefined;
      if (session.sessionId !== facts.sessionId || session.epoch !== facts.sessionEpoch) {
        return undefined; // the current native binding must match the armed tuple
      }
      const surface = Reflect.apply(descriptors.surface.value, state.manager, [facts.ownerId]);
      if (surface === null || typeof surface !== 'object') return undefined;
      if (surface !== facts.surface) return undefined; // the pane scope identity must be unchanged
      if (resolveInputModes(surface) === undefined) return undefined; // the pane mode resolution must still be intact
      return { sessionId: session.sessionId, sessionEpoch: session.epoch };
    } catch {
      return undefined; // any failure is a refusal, never an exception
    }
  }

  if (state.unsupported) return unsupportedObserver();

  return {
    snapshot,
    /** TESTONLY: the bounded native-binding group from the most recent snapshot pass. */
    nativeBinding() { return lastNativeBinding; },
    revalidateScope,
    restore,
    get installed() { return state.installed; },
    get unsupported() { return state.unsupported; },
  };
}

/** Convenience install that never throws: an unresolved candidate is honest unknown. */
function installPaneModeObserver(mainEntry, options = {}) {
  try {
    const resolved = resolveCandidatePaneClasses(mainEntry, { fs: options.fs });
    return createPaneModeObserver(
      { ...resolved.classes, recheck: resolved.recheck },
      { nativeBinding: options.nativeBinding, guard: options.guard },
    );
  } catch {
    try {
      return createPaneModeObserver(undefined, { nativeBinding: options.nativeBinding, guard: options.guard });
    } catch {
      return unsupportedObserver();
    }
  }
}

module.exports = {
  CANDIDATE_LEAVES,
  PANE_REPLY_FIELD_NAMES,
  NATIVE_BINDING_FIELD_NAMES,
  resolveCandidatePaneClasses,
  recheckCandidateModules,
  installOwnedHooks,
  createPaneModeObserver,
  installPaneModeObserver,
};
