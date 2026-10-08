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
 * The observation object is returned to the caller so a runner can assert its
 * final state; the process-exit path performs bounded exact-handle cleanup
 * only when a normal settled return did not already prove success.
 */

const fs = require('node:fs');

function appendMetadata(destination, record) {
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8');
}

function observePtyModule(nodePty, ptyJournal) {
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('the pinned public @lydell/node-pty spawn API is unavailable');
  }
  const originalSpawn = nodePty.spawn;
  const ownedHandles = [];
  let normalMainReturn = false;
  let forceAttempted = false;
  let journalFailed = false;
  const journal = (record) => {
    try { appendMetadata(ptyJournal, record); } catch { journalFailed = true; }
  };
  const observedSpawn = function observedSpawn(...args) {
    // Preserve the real receiver, exact arguments, spawn errors, and handle.
    const handle = Reflect.apply(originalSpawn, this, args);
    const options = args[2];
    const record = {
      incarnation: ownedHandles.length + 1,
      cwd: options && typeof options.cwd === 'string' ? options.cwd : undefined,
    };
    const owner = { handle, record, exited: false, dataSubscription: undefined };
    ownedHandles.push(owner);
    journal({ type: 'pty_spawn_pending', ...record });
    const observePublicPid = () => {
      let pid;
      try { pid = handle.pid; } catch { journalFailed = true; return; }
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      if (record.pid === undefined) {
        record.pid = pid;
        journal({ type: 'pty_spawn', ...record });
      } else if (record.pid !== pid) {
        journalFailed = true; // Never silently rebind one owned handle to a new PID.
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
    restore() {
      if (nodePty.spawn === observedSpawn) nodePty.spawn = originalSpawn;
    },
  };
}

module.exports = { appendMetadata, observePtyModule };
