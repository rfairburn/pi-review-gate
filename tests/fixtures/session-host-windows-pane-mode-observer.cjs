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
    restore: () => false,
    get installed() { return false; },
    get unsupported() { return true; },
  };
}

/**
 * Installs the owned hooks atomically: any failure unwinds exactly the slots
 * that still hold this observer's own hook, and a refused or foreign slot is
 * never touched. `defineProperty` is injectable so pure tests can exercise the
 * partial-installation unwind without a proxy.
 */
function installOwnedHooks(slots, defineProperty) {
  const installedSlots = [];
  try {
    for (const slot of slots) {
      defineProperty(slot.prototype, slot.key, {
        value: slot.hook,
        writable: true,
        enumerable: slot.descriptor.enumerable,
        configurable: true,
      });
      installedSlots.push(slot);
    }
    return true;
  } catch {
    for (const slot of installedSlots.reverse()) {
      try {
        const current = Object.getOwnPropertyDescriptor(slot.prototype, slot.key);
        if (current !== undefined && current.value === slot.hook) {
          Object.defineProperty(slot.prototype, slot.key, slot.descriptor);
        }
      } catch {
        // Exact owned slot only; a failed unwind leaves the foreign slot at rest.
      }
    }
    return false;
  }
}

/**
 * Installs the transparent prototype observers on the supplied original
 * candidate classes. Never throws: an unsupported install returns an observer
 * whose snapshot is an honest all-null unknown, so public Main execution is
 * unchanged and no fabricated fallback is reported.
 */
function createPaneModeObserver(candidate) {
  const state = {
    installed: false,
    unsupported: false,
    scopeInvalid: false,
    manager: undefined,
    sidebar: undefined,
  };
  const classes = candidate !== null && typeof candidate === 'object' ? candidate : undefined;
  const recheck = classes !== undefined && typeof classes.recheck === 'function' ? classes.recheck : undefined;
  let managerPrototype;
  let sidebarPrototype;
  let terminalSurfacePrototype;
  let descriptors;
  let slots = [];

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
        descriptors = {
          list: ownDataMethod(managerPrototype, 'list'),
          surface: ownDataMethod(managerPrototype, 'surface'),
          setActiveMainOwner: ownDataMethod(sidebarPrototype, 'setActiveMainOwner'),
          activeMainOwnerID: ownAccessorGetter(sidebarPrototype, 'activeMainOwnerID'),
          focus: ownAccessorGetter(sidebarPrototype, 'focus'),
          inputModes: ownDataMethod(terminalSurfacePrototype, 'inputModes'),
        };
        if (descriptors.list === undefined || descriptors.surface === undefined
          || descriptors.setActiveMainOwner === undefined
          || descriptors.activeMainOwnerID === undefined || descriptors.focus === undefined
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

  const listHook = function sessionHostPaneObserverList(...args) {
    // The original call happens exactly once and runs first: a throwing
    // original propagates its identical error and records no receiver.
    const result = Reflect.apply(descriptors.list.value, this, args);
    recordReceiver('manager', this, classes.InstanceManager);
    return result;
  };

  const ownerHook = function sessionHostPaneObserverSetActiveMainOwner(...args) {
    const result = Reflect.apply(descriptors.setActiveMainOwner.value, this, args);
    recordReceiver('sidebar', this, classes.SidebarController);
    return result;
  };

  if (!state.unsupported) {
    slots = [
      { prototype: managerPrototype, key: 'list', descriptor: descriptors.list, hook: listHook },
      { prototype: sidebarPrototype, key: 'setActiveMainOwner', descriptor: descriptors.setActiveMainOwner, hook: ownerHook },
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
    return current !== undefined && current.value === slot.hook;
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
        if (currentFocus === undefined || currentFocus.get !== descriptors.focus) return false;
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

  function observeOwnerView(fields, ownerId) {
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
    fields.hasLiveProcess = match.hasLiveProcess === true;
    fields.lifecycleAlive = match.lifecycle === 'alive';
    if (!fields.hasLiveProcess || !fields.lifecycleAlive) {
      fields.surfacePresent = false; // the actual pane gate is not satisfied: no surface read
      fields.modesReadSucceeded = false;
      return;
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

  function snapshot() {
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
        observeOwnerView(fields, ownerId);
      } else if (fields.ownerPresent === false) {
        fields.viewMatched = false;
        fields.hasLiveProcess = false;
        fields.lifecycleAlive = false;
        fields.surfacePresent = false;
        fields.modesReadSucceeded = false;
      }
      // Pane resolution checks can disturb scope during this very observation.
      // Never publish an intact scope first and invalidate only a later read.
      if (state.scopeInvalid) return unknownScopeFields();
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
        const current = Object.getOwnPropertyDescriptor(slot.prototype, slot.key);
        if (current === undefined || current.value !== slot.hook) continue; // never clobber a foreign replacement
        Object.defineProperty(slot.prototype, slot.key, slot.descriptor);
        restored = true;
      } catch {
        // Exact owned slot only.
      }
    }
    state.installed = false;
    return restored;
  }

  if (state.unsupported) return unsupportedObserver();

  return {
    snapshot,
    restore,
    get installed() { return state.installed; },
    get unsupported() { return state.unsupported; },
  };
}

/** Convenience install that never throws: an unresolved candidate is honest unknown. */
function installPaneModeObserver(mainEntry, options = {}) {
  try {
    const resolved = resolveCandidatePaneClasses(mainEntry, options);
    return createPaneModeObserver({ ...resolved.classes, recheck: resolved.recheck });
  } catch {
    try {
      return createPaneModeObserver(undefined);
    } catch {
      return unsupportedObserver();
    }
  }
}

module.exports = {
  CANDIDATE_LEAVES,
  PANE_REPLY_FIELD_NAMES,
  resolveCandidatePaneClasses,
  recheckCandidateModules,
  installOwnedHooks,
  createPaneModeObserver,
  installPaneModeObserver,
};
