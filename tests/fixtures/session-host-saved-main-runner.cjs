'use strict';

/**
 * Dedicated owned-PTY runner for the real Saved conversations acceptance.
 * It invokes only the public runSessionHost entry and observes the exact
 * @lydell/node-pty module instance that production lazily loads from
 * instances.js. The public spawn wrapper forwards the original receiver and
 * argument objects unchanged and returns the exact real IPty handle. Its
 * public onExit/kill observations append bounded metadata only; a parent
 * release handshake retains the owner until kernel watchers confirm children.
 * No argv, env, terminal input/output, transcript, or fabricated lifecycle is recorded.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function appendJournal(pathname, record) {
  try {
    fs.appendFileSync(pathname, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    // Metadata observation never changes the real public PTY operation.
    return false;
  }
}

function installPtyObservation(mainEntry, journalPath) {
  const productionRequire = createRequire(path.join(path.dirname(mainEntry), 'instances.js'));
  const ptyModulePath = productionRequire.resolve('@lydell/node-pty');
  const nodePty = require(ptyModulePath);
  if (typeof nodePty.spawn !== 'function') {
    throw new Error('the exact public @lydell/node-pty module has no spawn API');
  }

  const observation = { forceAttempted: false, journalFailed: false };
  const appendJournal = (pathname, record) => {
    try {
      fs.appendFileSync(pathname, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch {
      observation.journalFailed = true;
      return false;
    }
  };
  const originalSpawn = nodePty.spawn;
  const ownedHandles = new Map();
  let nextReceipt = 0;
  nodePty.spawn = function observedSpawn(...args) {
    // Apply with the exact call receiver and argument identities. Do not wrap,
    // replace, or emulate the returned public IPty handle.
    const handle = originalSpawn.apply(this, args);
    const options = args[2];
    const receipt = ++nextReceipt;
    const pid = handle && typeof handle.pid === 'number' ? handle.pid : undefined;
    const cwd = options && typeof options.cwd === 'string' ? options.cwd : undefined;
    appendJournal(journalPath, {
      type: 'pty_spawn', receipt, pid, cwd,
    });
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof cwd !== 'string') {
      appendJournal(journalPath, { type: 'pty_spawn_metadata_invalid', receipt });
    }

    const originalKill = handle && handle.kill;
    const retained = { handle, pid, cwd, originalKill, exitObserved: false };
    ownedHandles.set(receipt, retained);
    const originalOnExit = handle && handle.onExit;
    if (typeof originalOnExit !== 'function') {
      appendJournal(journalPath, { type: 'pty_observation_failed', receipt, operation: 'onExit-unavailable' });
      return handle;
    }
    try {
      // Install this metadata-only observer before returning the handle to
      // Main, so the manager cannot register its listener first.
      originalOnExit.call(handle, (event) => {
        retained.exitObserved = true;
        appendJournal(journalPath, {
          type: 'pty_exit',
          receipt,
          pid,
          cwd,
          exitCode: event && typeof event.exitCode === 'number' ? event.exitCode : undefined,
          signal: event && event.signal !== undefined ? event.signal : null,
        });
      });
    } catch {
      appendJournal(journalPath, { type: 'pty_observation_failed', receipt, operation: 'onExit-observer' });
    }

    // onExit is a read-only public accessor. Observe through it without
    // replacing it; the exact real handle is still returned to production.

    if (typeof originalKill === 'function') {
      try {
        handle.kill = function observedKill(...killArgs) {
          observation.forceAttempted = true;
          const signal = typeof killArgs[0] === 'string' || typeof killArgs[0] === 'number'
            ? killArgs[0]
            : null;
          appendJournal(journalPath, { type: 'force_attempt', receipt, pid, cwd, signal, source: 'manager' });
          try {
            return originalKill.apply(this, killArgs);
          } catch (error) {
            appendJournal(journalPath, { type: 'force_attempt_failed', receipt, pid, cwd, signal, source: 'manager' });
            throw error;
          }
        };
      } catch {
        appendJournal(journalPath, { type: 'pty_observation_failed', receipt, operation: 'kill-spy' });
      }
    } else {
      appendJournal(journalPath, { type: 'pty_observation_failed', receipt, operation: 'kill-unavailable' });
    }
    return handle;
  };

  return {
    snapshot() { return { ...observation }; },
    noteObservationFailure() { observation.journalFailed = true; },
    forceExactReceipt(receipt, requestId) {
      const owned = ownedHandles.get(receipt);
      if (owned && owned.exitObserved) {
        appendJournal(journalPath, {
          type: 'force_fallback_result', requestId, receipt, pid: owned.pid, cwd: owned.cwd,
          attempted: false, failed: false, alreadyExited: true,
        });
        return;
      }
      if (!owned || typeof owned.originalKill !== 'function') {
        appendJournal(journalPath, {
          type: 'force_fallback_result', requestId, receipt,
          pid: owned && owned.pid, cwd: owned && owned.cwd, attempted: false, failed: true,
        });
        return;
      }
      const signal = 'SIGKILL';
      const journaled = appendJournal(journalPath, {
        type: 'force_attempt', requestId, receipt, pid: owned.pid, cwd: owned.cwd,
        signal, source: 'failure_fallback',
      });
      if (!journaled) {
        appendJournal(journalPath, {
          type: 'force_fallback_result', requestId, receipt, pid: owned.pid, cwd: owned.cwd,
          attempted: false, failed: true,
        });
        return;
      }
      let failed = false;
      observation.forceAttempted = true;
      try {
        // Use only the original public kill method on this exact retained IPty.
        owned.originalKill.call(owned.handle, signal);
      } catch {
        failed = true;
        appendJournal(journalPath, {
          type: 'force_attempt_failed', requestId, receipt, pid: owned.pid, cwd: owned.cwd,
          signal, source: 'failure_fallback',
        });
      }
      appendJournal(journalPath, {
        type: 'force_fallback_result', requestId, receipt, pid: owned.pid, cwd: owned.cwd,
        attempted: true, failed,
      });
    },
  };
}

function startParentControl(controlPath, journalPath, ptyObservation) {
  let lastRequestId = 0;
  let released = false;
  let resolveRelease;
  const releasePromise = new Promise((resolve) => { resolveRelease = resolve; });

  const poll = () => {
    let request;
    try {
      const stats = fs.lstatSync(controlPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) return;
      const raw = fs.readFileSync(controlPath, 'utf8');
      if (!raw.trim()) return;
      request = JSON.parse(raw);
    } catch {
      return;
    }
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId <= lastRequestId) return;
    if (request.action === 'release') {
      lastRequestId = request.requestId;
      released = true;
      resolveRelease();
      return;
    }
    if (request.action !== 'force' || !Array.isArray(request.receipts) || request.receipts.length === 0
      || request.receipts.length > 128
      || !request.receipts.every((receipt) => Number.isSafeInteger(receipt) && receipt > 0)) return;
    lastRequestId = request.requestId;
    for (const receipt of new Set(request.receipts)) ptyObservation.forceExactReceipt(receipt, request.requestId);
  };

  const watcher = fs.watch(path.dirname(controlPath), (_event, filename) => {
    if (filename === null || filename.toString() === path.basename(controlPath)) poll();
  });
  watcher.on('error', () => {
    ptyObservation.noteObservationFailure();
    appendJournal(journalPath, { type: 'pty_observation_failed', operation: 'parent-control-watch' });
    // Retain this owner: a broken observation channel grants no exit authority.
  });
  poll();
  return {
    async waitForRelease() {
      poll();
      if (!released) await releasePromise;
    },
    dispose() {
      watcher.close();
    },
  };
}

function readControllingTtyState() {
  const result = spawnSync('stty', ['-g'], {
    stdio: [0, 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4_096,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('the owned outer controlling-terminal state could not be observed');
  }
  return result.stdout.trim();
}

let parentControl;

async function main() {
  const mainEntry = process.env.PRG_SESSION_HOST_SAVED_MAIN_ENTRY;
  const optionsPath = process.env.PRG_SESSION_HOST_SAVED_MAIN_OPTIONS;
  const resultPath = process.env.PRG_SESSION_HOST_SAVED_MAIN_RESULT;
  const journalPath = process.env.PRG_SESSION_HOST_SAVED_MAIN_PTY_JOURNAL;
  const controlPath = process.env.PRG_SESSION_HOST_SAVED_MAIN_CONTROL;
  const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  const ptyObservation = installPtyObservation(mainEntry, journalPath);
  parentControl = startParentControl(controlPath, journalPath, ptyObservation);
  const { runSessionHost } = require(mainEntry);
  const before = readControllingTtyState();
  const rawBefore = process.stdin.isRaw;
  process.stdout.write(`\x1b[2J\x1b[H${process.env.PRG_SESSION_HOST_SAVED_MAIN_BASELINE}`);

  let status = 1;
  let threw = false;
  try {
    status = await runSessionHost(options);
  } catch {
    threw = true;
  }

  let after;
  try {
    after = readControllingTtyState();
  } catch {
    after = null;
    threw = true;
  }
  fs.writeFileSync(resultPath, `${JSON.stringify({
    status,
    threw,
    before,
    after,
    rawBefore,
    rawAfter: process.stdin.isRaw,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    ...ptyObservation.snapshot(),
  })}\n`, { mode: 0o600 });
  await parentControl.waitForRelease();
  parentControl.dispose();
  process.exitCode = status;
}

void main().catch(async () => {
  try {
    fs.writeFileSync(process.env.PRG_SESSION_HOST_SAVED_MAIN_RESULT, `${JSON.stringify({
      status: 1,
      threw: true,
      before: null,
      after: null,
    })}\n`, { mode: 0o600 });
  } catch {
    // The parent reports a missing result through its exact outer PTY handle.
  }
  if (parentControl) {
    try { await parentControl.waitForRelease(); } catch { /* exact parent-control loop only */ }
    parentControl.dispose();
  }
  process.exitCode = 1;
});
