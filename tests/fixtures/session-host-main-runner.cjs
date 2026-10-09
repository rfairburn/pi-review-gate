'use strict';

/**
 * Public-Main PTY entry fixture. The parent supplies private, test-owned paths
 * through its allowlisted environment and observes only the owned outer PTY.
 *
 * Test-only exit observation: when PRG_SESSION_HOST_NATIVE_MAIN_PTY_EXIT_LOG
 * is set, this runner wraps the real pinned @lydell/node-pty public spawn API
 * on the exact module instance production lazily loads (instances.js uses
 * createRequire(__filename).require('@lydell/node-pty')). The wrapper is a
 * strict forwarder: it calls the original spawn with the identical receiver
 * and arguments, returns the same actual IPty handle (no substitute), and attaches
 * a public onExit listener that appends the actual exitCode/signal plus
 * the owned PID/cwd to the private journal. It records metadata only (never
 * argv/env/tokens/transcripts). An optional structural-control journal observes
 * unmodified Escape delivered through the real public write() method, forwarding
 * identical arguments/receiver/return values without synthesizing input or
 * adding a terminal listener/writer. It performs no kills and preserves errors. This is authorized test
 * instrumentation of the public API, not a production stub or factory
 * override: production code paths are untouched.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function installPtyExitObservation(mainEntry, logPath, controlLogPath) {
  // Resolve @lydell/node-pty exactly as production will: the compiled
  // instances.js loads it lazily through createRequire(__filename). Requiring
  // that same resolved file gives this runner the identical module instance,
  // so wrapping its public spawn API observes the real handles production
  // actually spawns (module-cache identity, not an unrelated copy).
  const productionRequire = createRequire(path.join(path.dirname(mainEntry), 'instances.js'));
  const ptyModulePath = productionRequire.resolve('@lydell/node-pty');
  const nodePty = require(ptyModulePath);
  if (typeof nodePty.spawn !== 'function') {
    throw new Error('the pinned @lydell/node-pty module has no public spawn API to observe');
  }
  const originalSpawn = nodePty.spawn;
  nodePty.spawn = function observedSpawn(file, args, options) {
    // Strict forwarding: identical receiver and arguments; the real IPty
    // handle identity is preserved and spawn errors propagate untouched.
    const handle = originalSpawn.call(nodePty, file, args, options);
    if (controlLogPath && typeof handle.write === 'function') {
      const originalWrite = handle.write;
      handle.write = function observedWrite(...writeArgs) {
        const result = originalWrite.apply(this, writeArgs);
        const data = writeArgs[0];
        if (typeof data === 'string' && (data === '\x1b' || /^\x1b\[27(?:;1(?::1)?)?u$/.test(data))) {
          try {
            fs.appendFileSync(controlLogPath, `${JSON.stringify({
              type: 'pty_control', key: 'escape', pid: handle.pid,
              cwd: options && typeof options.cwd === 'string' ? options.cwd : undefined,
              encoding: data === '\x1b' ? 'legacy' : 'csi-u',
            })}\n`, 'utf8');
          } catch { /* observation never changes the real write outcome */ }
        }
        return result;
      };
    }
    try {
      handle.onExit((event) => {
        try {
          fs.appendFileSync(logPath, `${JSON.stringify({
            type: 'pty_exit',
            pid: typeof handle.pid === 'number' ? handle.pid : undefined,
            cwd: options && typeof options.cwd === 'string' ? options.cwd : undefined,
            exitCode: event && typeof event.exitCode === 'number' ? event.exitCode : undefined,
            signal: event && event.signal !== undefined ? event.signal : null,
          })}\n`, 'utf8');
        } catch {
          // Observation must never alter the real child lifecycle.
        }
      });
    } catch {
      try {
        fs.appendFileSync(logPath, `${JSON.stringify({ type: 'pty_exit_observation_failed' })}\n`, 'utf8');
      } catch { /* metadata only */ }
    }
    return handle;
  };
}

function readControllingTtyState() {
  const result = spawnSync('stty', ['-g'], {
    stdio: [0, 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('the owned PTY controlling-terminal state could not be observed');
  }
  return result.stdout.trim();
}

async function main() {
  const options = JSON.parse(fs.readFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_OPTIONS, 'utf8'));
  const exitLog = process.env.PRG_SESSION_HOST_NATIVE_MAIN_PTY_EXIT_LOG;
  if (exitLog) {
    installPtyExitObservation(process.env.PRG_SESSION_HOST_NATIVE_MAIN_ENTRY, exitLog,
      process.env.PRG_SESSION_HOST_NATIVE_MAIN_PTY_CONTROL_LOG);
  }
  const { runSessionHost } = require(process.env.PRG_SESSION_HOST_NATIVE_MAIN_ENTRY);
  const before = readControllingTtyState();
  const rawBefore = process.stdin.isRaw;
  const baseline = process.env.PRG_SESSION_HOST_NATIVE_MAIN_BASELINE;
  process.stdout.write(`\x1b[2J\x1b[H${baseline}`);

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
  fs.writeFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_RESULT, JSON.stringify({
    status,
    threw,
    before,
    after,
    rawBefore,
    rawAfter: process.stdin.isRaw,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  }) + '\n', { mode: 0o600 });
  process.exitCode = status;
}

void main().catch(() => {
  try {
    fs.writeFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_RESULT, JSON.stringify({
      status: 1,
      threw: true,
      before: null,
      after: null,
    }) + '\n', { mode: 0o600 });
  } catch {
    // The parent will report the missing result from its owned PTY exit.
  }
  process.exitCode = 1;
});
