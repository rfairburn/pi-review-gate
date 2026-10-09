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
 * TESTONLY offered-bootstrap retention (only when `options.bootstrap` is
 * supplied as `{ envName, parse }`): BEFORE the original spawn call, the
 * exact one-shot bootstrap env value of that one spawn is parsed with the
 * supplied strict validator and retained privately in memory, bound to the
 * same retained public IPty and its once-positive original PID / current
 * incarnation (pending => positive => actual exit). The capture reads ONLY
 * bounded readonly own data descriptors (`spawnOptions.env`, then the env
 * leaf), refusing inherited properties and getters/setters WITHOUT invoking
 * them, so no observable getter side effect can occur before the original
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
  const journal = (record) => {
    try { appendMetadata(ptyJournal, record); } catch { journalFailed = true; }
  };
  /**
   * Captures the exact one-shot offered bootstrap of this one spawn BEFORE
   * the original call, read-only. Every read goes through a bounded readonly
   * OWN data descriptor; inherited properties and getters/setters are refused
   * WITHOUT being invoked, so no observable getter side effect can occur
   * before the original spawn. Any unsupported/foreign/throwing input leaves
   * the private binding unknown; the spawn itself is never disturbed.
   */
  const captureOfferedBootstrap = (args) => {
    if (!bootstrapSupported) return undefined;
    try {
      const spawnOptions = args[2];
      if (spawnOptions === null || typeof spawnOptions !== 'object') return undefined;
      const envDescriptor = Object.getOwnPropertyDescriptor(spawnOptions, 'env');
      if (envDescriptor === undefined || envDescriptor.get !== undefined || envDescriptor.set !== undefined) {
        return undefined; // an accessor or inherited env is refused without invoking it
      }
      const env = envDescriptor.value;
      if (env === null || typeof env !== 'object') return undefined;
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
    const owner = { handle, record, exited: false, observationFailed: false, pidChanged: false, dataSubscription: undefined, bootstrap: offeredBootstrap };
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
        try { owner.dataSubscription?.dispose(); } catch { journalFailed = true; }
      });
      // ConPTY's public pid becomes available asynchronously. Observe it on
      // public data delivery, without inspecting data or using a private ready
      // event. The actual stream continues to production's own subscribers.
      observePublicPid();
      if (record.pid === undefined && !owner.exited) {
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
    restore() {
      if (nodePty.spawn === observedSpawn) nodePty.spawn = originalSpawn;
    },
  };
}

module.exports = { appendMetadata, observePtyModule };
