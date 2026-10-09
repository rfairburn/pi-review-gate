'use strict';

/**
 * Shared exact public-PTY observation fixture for the Windows session-host
 * acceptance lanes. It is authorized test instrumentation of the public
 * @lydell/node-pty API, never a production stub or factory override:
 *
 * - the pinned public spawn is a strict forwarder that preserves the original
 *   receiver, exact arguments, spawn errors, and returned IPty handle (no
 *   substitute, no adopted or guessed PID);
 * - ConPTY publishes `pid` asynchronously after its data pipe connects, so a
 *   positive public PID is sampled after real output delivery (public onData)
 *   and journaled as incarnation pending -> positive PID -> actual exit;
 *   a changed PID is a journal failure, never a silent rebind;
 * - `onExit` is subscribed through the read-only public accessor and is never
 *   assigned;
 * - every owned public `kill()` attempt (including production escalation and
 *   throws) is recorded stickily before the original method runs; the same
 *   real handle/method receiver/arguments are retained. On Windows the public
 *   no-argument kill is a force, so a graceful claim after a force is never
 *   possible;
 * - only bounded numeric/boolean and fixed allowlisted path metadata is
 *   journaled: argv, env, credentials, and terminal transcripts are never
 *   recorded.
 *
 * TESTONLY received-data census (only when `options.createReceivedCensus`
 * supplies a pure bounded census factory, e.g. the shared stdout mode census):
 * ONE owned public onData subscription per original returned handle is
 * registered in the same synchronous spawn return turn — even when the public
 * PID is already positive — so each public string payload is captured once,
 * before production's later subscriber, into the pure bounded census (its
 * internal writeCalls are public data events, never stdout writes). Non-string
 * payloads (including proxy/Buffer/object) are sticky unknown without any
 * property or descriptor trap; no raw bytes are retained or logged. The public
 * onData descriptor/prototype chain is captured within a finite bound and
 * revalidated at lookup time (by both lookups): a shadow, replacement, or
 * changed prototype chain is sticky unknown and latches the shared
 * private-binding scope so the exchange guard's binding lookup fails closed;
 * a proxy handle, registration failure, PID drift, or exit leaves the
 * received group sticky unknown. A contained census/observation failure,
 * unsupported payload, overflow, or partial-at-snapshot sequence makes only
 * the received counters unknown. The subscription carries the default PID
 * observation only when the default fixture would have subscribed (pending
 * PID), and it is disposed at most once on the original public onExit,
 * including a reentrant exit during registration. Default/option-absent
 * behavior stays exact, including the conditional PID onData subscription,
 * and this fixture never copies the census dependency (the factory is
 * runner-supplied).
 *
 * TESTONLY offered-bootstrap retention (only when `options.bootstrap` is
 * supplied as `{ envName, parse }`): BEFORE the original spawn call, the
 * exact one-shot bootstrap env value of that one spawn is parsed with the
 * supplied strict validator and retained privately in memory, bound to the
 * same retained public IPty and its once-positive original PID / current
 * incarnation (pending => positive => actual exit). The capture reads ONLY
 * bounded readonly own data descriptors (`spawnOptions.env`, then the env
 * leaf), refusing inherited properties and getters/setters WITHOUT invoking
 * them, and refusing ES Proxy spawn options/env through genuine `node:util`
 * `types.isProxy` BEFORE any descriptor operation (no trap is ever invoked),
 * so no observable getter or trap side effect can occur before the original
 * spawn. The env vector, options, and arguments are never mutated;
 * the original spawn runs exactly once with the exact original
 * receiver/arguments/return/error. Changed, duplicate, foreign, replaced,
 * unsupported, or disturbed inputs leave the binding unknown: a replaced
 * spawn slot, a changed public handle PID, a failed observation, or a
 * journal failure latches uncertainty that `nativeBindingFor` reports as
 * undefined without rebinding. The retained tuple is NEVER journaled: no
 * env, token, socket, raw bootstrap, private instance id, or native id
 * reaches the journal.
 *
 * The observation object is returned to the caller so a runner can assert its
 * final state; the process-exit path performs bounded exact-handle cleanup
 * only when a normal settled return did not already prove success.
 */

const fs = require('node:fs');
const { types } = require('node:util');

function appendMetadata(destination, record) {
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8');
}

function observePtyModule(nodePty, ptyJournal, options = {}) {
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('the pinned public @lydell/node-pty spawn API is unavailable');
  }
  const originalSpawn = nodePty.spawn;
  const ownedHandles = [];
  let normalMainReturn = false;
  let forceAttempted = false;
  let journalFailed = false;
  let nativeScopeInvalid = false; // observed private-binding scope failure is sticky
  const bootstrapOptions = options !== null && typeof options === 'object' && options.bootstrap !== null && typeof options.bootstrap === 'object'
    ? options.bootstrap
    : undefined;
  const bootstrapSupported = bootstrapOptions !== undefined
    && typeof bootstrapOptions.envName === 'string' && bootstrapOptions.envName.length > 0
    && typeof bootstrapOptions.parse === 'function';
  // TESTONLY received-data census factory (runner-supplied): never a top-level
  // dependency of this shared fixture; absent options preserve the exact
  // default behavior, including the conditional PID onData subscription.
  const receivedFactory = options !== null && typeof options === 'object' && typeof options.createReceivedCensus === 'function'
    ? options.createReceivedCensus
    : undefined;
  const receivedSupported = receivedFactory !== undefined;
  const journal = (record) => {
    try { appendMetadata(ptyJournal, record); } catch { journalFailed = true; }
  };
  /**
   * TESTONLY: revalidates one owner's captured public onData slot within the
   * same finite descriptor/prototype bound (exact holder, exact method value,
   * and the exact visited prototype chain). Never invokes an accessor.
   */
  const receivedSlotIntact = (owner) => {
    if (owner.onDataSlot === undefined) return false;
    const current = resolveOnDataSlot(owner.handle);
    return current !== undefined && sameOnDataSlot(current, owner.onDataSlot);
  };
  /**
   * TESTONLY: one bounded numeric census snapshot. A contained observation
   * failure (or a throwing/malformed snapshot) is sticky unknown; only the
   * fixed integer counters are copied, never raw data.
   */
  const receivedSnapshot = (owner) => {
    try {
      const base = owner.receivedCensus.snapshot();
      if (base === null || typeof base !== 'object' || base.counts === null || typeof base.counts !== 'object') {
        return { unknown: true, counts: {} };
      }
      return { unknown: base.unknown !== false || owner.receivedFailed, counts: base.counts };
    } catch {
      return { unknown: true, counts: {} };
    }
  };
  /**
   * Captures the exact one-shot offered bootstrap of this one spawn BEFORE
   * the original call, read-only. Every read goes through a bounded readonly
   * OWN data descriptor; inherited properties and getters/setters are refused
   * WITHOUT being invoked, and ES Proxy spawn options/env are refused via
   * genuine `types.isProxy` before any descriptor operation, without invoking
   * their traps, so no observable getter or trap side effect can occur
   * before the original spawn. Any unsupported/foreign/throwing input leaves
   * the private binding unknown; the spawn itself is never disturbed.
   */
  const captureOfferedBootstrap = (args) => {
    if (!bootstrapSupported) return undefined;
    try {
      const spawnOptions = args[2];
      if (spawnOptions === null || typeof spawnOptions !== 'object') return undefined;
      if (types.isProxy(spawnOptions)) return undefined; // an ES Proxy is refused before any descriptor trap
      const envDescriptor = Object.getOwnPropertyDescriptor(spawnOptions, 'env');
      if (envDescriptor === undefined || envDescriptor.get !== undefined || envDescriptor.set !== undefined) {
        return undefined; // an accessor or inherited env is refused without invoking it
      }
      const env = envDescriptor.value;
      if (env === null || typeof env !== 'object') return undefined;
      if (types.isProxy(env)) return undefined; // an ES Proxy env is refused before any descriptor trap
      const rawDescriptor = Object.getOwnPropertyDescriptor(env, bootstrapOptions.envName);
      if (rawDescriptor === undefined || rawDescriptor.get !== undefined || rawDescriptor.set !== undefined) {
        return undefined; // an accessor or inherited leaf is refused without invoking it
      }
      const raw = rawDescriptor.value;
      if (typeof raw !== 'string') return undefined;
      const parsed = bootstrapOptions.parse(JSON.parse(raw));
      return parsed === undefined ? undefined : parsed;
    } catch {
      return undefined; // unsupported/foreign: private binding stays unknown
    }
  };
  const observedSpawn = function observedSpawn(...args) {
    // Preserve the real receiver, exact arguments, spawn errors, and handle.
    const offeredBootstrap = captureOfferedBootstrap(args);
    const handle = Reflect.apply(originalSpawn, this, args);
    const spawnOptions = args[2];
    const record = {
      incarnation: ownedHandles.length + 1,
      cwd: spawnOptions && typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : undefined,
    };
    const owner = {
      handle, record, exited: false, observationFailed: false, pidChanged: false,
      dataSubscription: undefined, bootstrap: offeredBootstrap,
      receivedCensus: undefined, onDataSlot: undefined, receivedFailed: false,
      dataSubscriptionSettled: false, pidObservedOnData: false,
    };
    // TESTONLY received mode: the ONE owned onData subscription is disposed at
    // most once (public onExit, or right after a registration that observed a
    // reentrant exit). A dispose failure makes the received group unknown; it
    // is a journal failure only when that same subscription also carried the
    // default pending-PID observation (exact default parity).
    const settleReceivedSubscription = () => {
      if (owner.dataSubscription === undefined || owner.dataSubscriptionSettled) return;
      owner.dataSubscriptionSettled = true;
      try {
        owner.dataSubscription.dispose();
      } catch {
        owner.receivedFailed = true;
        if (owner.pidObservedOnData) journalFailed = true;
      }
    };
    ownedHandles.push(owner);
    journal({ type: 'pty_spawn_pending', ...record });
    const observePublicPid = () => {
      let pid;
      try { pid = handle.pid; } catch {
        journalFailed = true;
        owner.observationFailed = true; // a PID-read failure latches private binding uncertainty
        return;
      }
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      if (record.pid === undefined) {
        record.pid = pid;
        journal({ type: 'pty_spawn', ...record });
      } else if (record.pid !== pid) {
        journalFailed = true; // Never silently rebind one owned handle to a new PID.
        owner.pidChanged = true; // the private binding is sticky-unknown from here on
      }
    };
    try {
      const originalKill = handle.kill;
      if (typeof originalKill !== 'function') throw new Error('public kill unavailable');
      // Observe ALL owned public kill attempts, including production escalation
      // and throws. The same real handle/method receiver/arguments are retained.
      handle.kill = function observedKill(...killArgs) {
        forceAttempted = true;
        observePublicPid();
        journal({ type: 'pty_force_attempt', ...record });
        return Reflect.apply(originalKill, this, killArgs);
      };
      // Subscribe through the read-only public onExit accessor; never assign it.
      handle.onExit((event) => {
        observePublicPid();
        owner.exited = true;
        journal({
          type: 'pty_exit',
          ...record,
          exitCode: event && typeof event.exitCode === 'number' ? event.exitCode : undefined,
          signal: event && event.signal !== undefined ? event.signal : null,
        });
        if (receivedSupported) settleReceivedSubscription();
        else {
          try { owner.dataSubscription?.dispose(); } catch { journalFailed = true; }
        }
      });
      // ConPTY's public pid becomes available asynchronously. Observe it on
      // public data delivery, without inspecting data or using a private ready
      // event. The actual stream continues to production's own subscribers.
      observePublicPid();
      if (receivedSupported) {
        // TESTONLY received-data census: ONE owned onData subscription per
        // original returned handle, registered in the same synchronous spawn
        // return turn BEFORE production's later subscriber. Each public string
        // payload is captured once before the original subscribers run; no raw
        // bytes are retained or logged, and every observation failure is
        // contained so it can never escape or alter production.
        let receivedCensus;
        try {
          receivedCensus = receivedFactory();
        } catch {
          receivedCensus = undefined; // a throwing factory is a registration failure
        }
        if (receivedCensus === null || typeof receivedCensus !== 'object'
            || typeof receivedCensus.beginOffer !== 'function'
            || typeof receivedCensus.markUnknown !== 'function'
            || typeof receivedCensus.snapshot !== 'function') {
          receivedCensus = undefined; // unsupported factory result: sticky unknown
        }
        owner.receivedCensus = receivedCensus;
        // Exact default parity: the default fixture subscribes for the PID only
        // while it is still pending, and that subscription keeps observing the
        // public PID on every later delivery. The single owned subscription
        // carries that same PID observation only in that same case.
        const pidObservedOnData = record.pid === undefined && !owner.exited;
        owner.pidObservedOnData = pidObservedOnData;
        const onDataSlot = owner.exited ? undefined : resolveOnDataSlot(handle);
        if (owner.exited) {
          // Exited before registration (exactly like the default fixture, no
          // subscription is made): the received group stays sticky unknown.
        } else if (onDataSlot === undefined && pidObservedOnData) {
          // Unresolved/unsupported public onData: the received group is
          // unknown, and the default pending-PID subscription still runs
          // exactly as the option-absent fixture would register it.
          owner.dataSubscription = handle.onData(() => observePublicPid());
          if (owner.exited) settleReceivedSubscription();
        } else if (onDataSlot !== undefined) {
          const receivedListener = (data) => {
            if (pidObservedOnData) observePublicPid();
            try {
              if (owner.receivedCensus === undefined || owner.receivedFailed || owner.dataSubscriptionSettled) return;
              // typeof never invokes a proxy trap; every non-string payload
              // (Buffer/object/proxy) is sticky unknown without inspection.
              if (typeof data !== 'string') {
                owner.receivedCensus.markUnknown();
                return;
              }
              const offer = owner.receivedCensus.beginOffer(data, undefined);
              if (offer !== null) offer.commit();
            } catch {
              owner.receivedFailed = true; // an observation failure is sticky and never escapes
            }
          };
          let subscription;
          let registered = false;
          try {
            // The ordinary public call form production itself uses: for the
            // getter-backed accessor this reads the original public event
            // function exactly once with the original handle receiver.
            subscription = handle.onData(receivedListener);
            registered = true;
          } catch (error) {
            // A registration failure that also lost the default pending-PID
            // observation keeps the exact default failure path; otherwise it
            // only leaves the received group sticky unknown.
            if (pidObservedOnData) throw error;
          }
          if (registered) {
            owner.onDataSlot = onDataSlot;
            owner.dataSubscription = subscription;
            if (subscription === null || typeof subscription !== 'object' || typeof subscription.dispose !== 'function') {
              owner.receivedFailed = true; // an unsettleable subscription is sticky unknown
            }
            if (owner.exited) settleReceivedSubscription(); // reentrant exit during registration: exact once
          }
        }
      } else if (record.pid === undefined && !owner.exited) {
        owner.dataSubscription = handle.onData(() => observePublicPid());
        if (owner.exited) owner.dataSubscription.dispose();
      }
    } catch {
      journalFailed = true;
      owner.observationFailed = true; // a failed observation latches private binding uncertainty
      journal({ type: 'pty_observation_failed', ...record });
    }
    return handle;
  };
  nodePty.spawn = observedSpawn;

  // A failed runner shutdown gets bounded exact-handle cleanup only. A normal
  // successful public Main return never reaches this force path. Every attempt
  // is journaled and uses the same actual public IPty.kill() with no signal.
  process.on('exit', () => {
    if (normalMainReturn) return;
    for (const owner of ownedHandles) {
      if (owner.exited) continue;
      forceAttempted = true;
      journal({ type: 'pty_exit_cleanup_force_attempt', ...owner.record });
      try { owner.handle.kill(); } catch { /* exact owned public PTY only */ }
    }
  });

  return {
    markNormalMainReturn(status, threw) {
      normalMainReturn = status === 0 && threw === false && !forceAttempted && !journalFailed
        && ownedHandles.every((owner) => owner.exited && Number.isSafeInteger(owner.record.pid));
    },
    snapshot() {
      return {
        forceAttempted,
        journalFailed,
        unresolvedSpawns: ownedHandles.filter((owner) => !Number.isSafeInteger(owner.record.pid)).length,
        unexitedSpawns: ownedHandles.filter((owner) => !owner.exited).length,
      };
    },
    /**
     * TESTONLY private binding lookup, never journaled: the exact retained
     * offered bootstrap tuple for one instance id, bound to the same owned
     * public IPty and its once-positive original PID / current incarnation.
     * Unknown (undefined) for absent, pending, exited, foreign, or duplicate
     * inputs; a second distinct handle with the same instance id is sticky
     * ambiguity, never last-wins. The lookup revalidates the observation at
     * call time: a replaced spawn slot, a journal failure, a failed
     * observation, an unreadable PID read, or a changed public handle PID
     * (re-read against the once-positive value, never rebound) all report
     * unknown and LATCH that uncertainty — reverting the disturbance never
     * rebinds.
     */
    nativeBindingFor(instanceId) {
      try {
        const slot = Object.getOwnPropertyDescriptor(nodePty, 'spawn');
        if (slot === undefined || slot.value !== observedSpawn || journalFailed) nativeScopeInvalid = true;
      } catch {
        nativeScopeInvalid = true;
      }
      if (nativeScopeInvalid) return undefined; // an observed scope failure is sticky, never rebound
      if (typeof instanceId !== 'string' || instanceId.length === 0) return undefined;
      let match;
      for (const owner of ownedHandles) {
        if (owner.bootstrap !== undefined && owner.bootstrap.instanceId === instanceId) {
          if (match !== undefined) return undefined; // duplicate: ambiguous, never guess
          match = owner;
        }
      }
      if (match === undefined || match.exited || match.observationFailed || match.pidChanged) return undefined;
      // TESTONLY received mode: a supported received-scope onData slot
      // disturbance (shadow/replacement/changed prototype chain) observed here
      // latches the shared scope, so the exchange guard's binding lookup fails
      // closed and a change-then-revert can never certify.
      if (receivedSupported && match.onDataSlot !== undefined && !receivedSlotIntact(match)) {
        nativeScopeInvalid = true;
        return undefined;
      }
      const pid = match.record.pid;
      if (!Number.isSafeInteger(pid) || pid <= 1) return undefined; // still pending: unknown
      let currentPid;
      try {
        currentPid = match.handle.pid; // re-read the current public PID at call time
      } catch {
        match.observationFailed = true; // an unreadable PID latches uncertainty without rebinding
        return undefined; // an unreadable PID is unknown, never a cached guess
      }
      if (currentPid !== pid) {
        match.pidChanged = true; // changed PID: sticky unknown, never rebound
        return undefined;
      }
      return { pid, incarnation: match.record.incarnation, bootstrap: match.bootstrap };
    },
    /**
     * TESTONLY private received-data census lookup, never journaled: the exact
     * retained original-handle public onData census for one instance id, bound
     * to the same owned public IPty and its once-positive original PID /
     * current incarnation through the same provenance as `nativeBindingFor`.
     * Returns undefined when the observation is not enabled or the instance id
     * resolves to no (or a duplicate) offered-bootstrap owner; `{ disturbed:
     * true }` for a supported-scope disturbance — registration failure, spawn
     * slot replacement, journal failure, exit/settled subscription, PID
     * drift, or a shadowed / replaced / prototype-changed public onData slot
     * (sticky; a slot disturbance also latches the shared private-binding
     * scope so the exchange guard's binding lookup fails closed); otherwise
     * `{ pid, incarnation, snapshot }` with pid null while the public PID is
     * still pending (the runner never publishes that as an established
     * scope) and a sticky-unknown snapshot after any contained observation
     * failure. The public onData descriptor /
     * prototype chain is captured at spawn and revalidated within the same
     * finite bound; a reverted disturbance never repairs the scope. No raw
     * payload, id, or tuple is ever returned or journaled.
     */
    receivedBindingFor(instanceId) {
      if (typeof instanceId !== 'string' || instanceId.length === 0) return undefined;
      if (!receivedSupported) return undefined; // observation not enabled: unestablished
      let match;
      for (const owner of ownedHandles) {
        if (owner.bootstrap !== undefined && owner.bootstrap.instanceId === instanceId) {
          if (match !== undefined) return undefined; // duplicate: ambiguous, never guess
          match = owner;
        }
      }
      if (match === undefined) return undefined; // no offered-bootstrap owner: unestablished
      if (match.receivedCensus === undefined || match.onDataSlot === undefined) {
        return { disturbed: true }; // a registration failure is sticky unknown
      }
      try {
        const slot = Object.getOwnPropertyDescriptor(nodePty, 'spawn');
        if (slot === undefined || slot.value !== observedSpawn || journalFailed) nativeScopeInvalid = true;
      } catch {
        nativeScopeInvalid = true;
      }
      if (nativeScopeInvalid) return { disturbed: true }; // an observed scope failure is sticky, never rebound
      if (match.exited || match.observationFailed || match.pidChanged || match.dataSubscriptionSettled) {
        return { disturbed: true };
      }
      if (!receivedSlotIntact(match)) {
        nativeScopeInvalid = true; // shadow/replacement/changed prototype: sticky, fails the guard too
        return { disturbed: true };
      }
      const pid = match.record.pid;
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        return { pid: null, incarnation: null, snapshot: receivedSnapshot(match) }; // pending: intact but unbound
      }
      let currentPid;
      try {
        currentPid = match.handle.pid; // re-read the current public PID at call time
      } catch {
        match.observationFailed = true; // an unreadable PID latches uncertainty without rebinding
        return { disturbed: true };
      }
      if (currentPid !== pid) {
        match.pidChanged = true; // changed PID: sticky unknown, never rebound
        return { disturbed: true };
      }
      return { pid, incarnation: match.record.incarnation, snapshot: receivedSnapshot(match) };
    },
    restore() {
      if (nodePty.spawn === observedSpawn) nodePty.spawn = originalSpawn;
    },
  };
}

/**
 * Resolves the exact public onData slot within a finite descriptor/prototype
 * bound, on the handle or its retained prototype chain. An ES Proxy handle is refused via genuine `types.isProxy` BEFORE any
 * descriptor operation (no trap is ever invoked). Both supported public
 * forms are resolved WITHOUT invoking anything: a plain data method, and the
 * getter-backed public accessor the pinned node-pty API exposes (its getter
 * and setter function identities are captured, never called here). An
 * unresolved, non-function, or getter-less slot is unsupported.
 * Returns `{ holder, kind, value, get, set, chain, prototypes }` — chain is
 * the exact visited objects from the handle to the holder and prototypes is
 * the immediate prototype identity of EACH visited object (including the
 * holder) — or undefined.
 */
function resolveOnDataSlot(handle, bound = 16) {
  if (handle === null || typeof handle !== 'object') return undefined;
  let current = handle;
  const chain = [];
  const prototypes = [];
  for (let depth = 0; depth < bound && current !== null && typeof current === 'object'; depth += 1) {
    try {
      if (types.isProxy(current)) return undefined; // a proxy handle/prototype is refused before any trap
    } catch {
      return undefined; // an uninspectable object is refused
    }
    let descriptor;
    let parent;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, 'onData');
      parent = Object.getPrototypeOf(current); // non-proxy: no trap can run
    } catch {
      return undefined; // an unreadable descriptor/prototype is refused, never bypassed
    }
    chain.push(current);
    prototypes.push(parent);
    if (descriptor !== undefined) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        // The public accessor form: identities only, never invoked here.
        if (typeof descriptor.get !== 'function') return undefined;
        return { holder: current, kind: 'accessor', value: undefined, get: descriptor.get, set: descriptor.set, chain, prototypes };
      }
      if (typeof descriptor.value !== 'function') return undefined;
      return { holder: current, kind: 'data', value: descriptor.value, get: undefined, set: undefined, chain, prototypes };
    }
    current = parent;
  }
  return undefined; // unresolved within the finite bound: unsupported
}

/**
 * Exact identity comparison of two resolved onData slots: holder, descriptor
 * kind, method or getter/setter function identity, every visited object, and
 * each visited object's immediate prototype. Never invokes a getter and
 * never compares callback closures an accessor returns.
 */
function sameOnDataSlot(current, captured) {
  if (current.holder !== captured.holder || current.kind !== captured.kind) return false;
  if (current.value !== captured.value || current.get !== captured.get || current.set !== captured.set) return false;
  if (current.chain.length !== captured.chain.length || current.prototypes.length !== captured.prototypes.length) return false;
  for (let index = 0; index < current.chain.length; index += 1) {
    if (current.chain[index] !== captured.chain[index]) return false;
    if (current.prototypes[index] !== captured.prototypes[index]) return false;
  }
  return true;
}

module.exports = { appendMetadata, observePtyModule };
