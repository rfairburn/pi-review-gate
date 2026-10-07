'use strict';

/**
 * Test-only real-Main runner hosted in the caller's public Windows ConPTY.
 * The public node-pty spawn is a strict forwarder: the exact pinned module,
 * original receiver/arguments, and returned IPty handles are preserved. Only
 * public spawn/onExit metadata is journaled; argv, env, credentials, and
 * terminal transcripts are never recorded.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function appendMetadata(destination, record) {
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8');
}

function installPtyObservation(mainEntry, expectedPtyModule, ptyJournal) {
  // Match production's exact lazy createRequire anchor in instances.js.
  const productionRequire = createRequire(path.join(path.dirname(mainEntry), 'instances.js'));
  const resolvedPtyModule = productionRequire.resolve('@lydell/node-pty');
  const actualPtyPath = path.resolve(resolvedPtyModule);
  const expectedPtyPath = path.resolve(expectedPtyModule);
  const samePtyPath = process.platform === 'win32'
    ? actualPtyPath.toLocaleLowerCase('en-US') === expectedPtyPath.toLocaleLowerCase('en-US')
    : actualPtyPath === expectedPtyPath;
  if (!samePtyPath) {
    throw new Error('candidate Main and the outer harness do not resolve the same pinned public @lydell/node-pty file');
  }
  const nodePty = require(resolvedPtyModule);
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('the pinned public @lydell/node-pty spawn API is unavailable');
  }
  const originalSpawn = nodePty.spawn;
  const ownedHandles = [];
  let normalMainReturn = false;
  const observedSpawn = function observedSpawn(...args) {
    // Preserve the real receiver, exact arguments, spawn errors, and handle.
    const handle = Reflect.apply(originalSpawn, this, args);
    const options = args[2];
    const record = {
      pid: typeof handle.pid === 'number' ? handle.pid : undefined,
      cwd: options && typeof options.cwd === 'string' ? options.cwd : undefined,
    };
    const owner = { handle, record, exited: false };
    ownedHandles.push(owner);
    try {
      appendMetadata(ptyJournal, { type: 'pty_spawn', ...record });
      // This is the exact real IPty returned by the public spawn method. The
      // added listener only journals the public event and never controls it.
      handle.onExit((event) => {
        owner.exited = true;
        try {
          appendMetadata(ptyJournal, {
            type: 'pty_exit',
            ...record,
            exitCode: event && typeof event.exitCode === 'number' ? event.exitCode : undefined,
            signal: event && event.signal !== undefined ? event.signal : null,
          });
        } catch {
          // A journal I/O problem cannot alter the actual native child.
        }
      });
    } catch {
      try { appendMetadata(ptyJournal, { type: 'pty_exit_observation_failed', ...record }); } catch { /* metadata only */ }
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
      try { appendMetadata(ptyJournal, { type: 'pty_force_attempt', ...owner.record }); } catch { /* retain fail-closed result */ }
      try { owner.handle.kill(); } catch { /* exact owned public PTY only */ }
    }
  });

  return {
    markNormalMainReturn(status, threw) {
      normalMainReturn = status === 0 && threw === false;
    },
    restore() {
      if (nodePty.spawn === observedSpawn) nodePty.spawn = originalSpawn;
    },
  };
}

function writeResult(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function main() {
  const optionsPath = process.env.PRG_SESSION_HOST_WINDOWS_OPTIONS;
  const resultPath = process.env.PRG_SESSION_HOST_WINDOWS_RESULT;
  const mainEntry = process.env.PRG_SESSION_HOST_WINDOWS_MAIN_ENTRY;
  const ptyJournal = process.env.PRG_SESSION_HOST_WINDOWS_PTY_JOURNAL;
  const expectedPtyModule = process.env.PRG_SESSION_HOST_WINDOWS_PTY_MODULE;
  const baseline = process.env.PRG_SESSION_HOST_WINDOWS_BASELINE;
  if (!optionsPath || !resultPath || !mainEntry || !ptyJournal || !expectedPtyModule || !baseline) {
    throw new Error('Windows Main runner is missing a bounded private fixture path');
  }

  const optionsStats = fs.lstatSync(optionsPath, { bigint: true });
  if (!optionsStats.isFile() || optionsStats.isSymbolicLink() || optionsStats.size > 64n * 1024n) {
    throw new Error('Windows Main runner options are not a bounded regular fixture file');
  }
  const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  const inputStream = process.stdin;
  const outputStream = process.stdout;
  if (!inputStream.isTTY || !outputStream.isTTY || typeof inputStream.isRaw !== 'boolean') {
    throw new Error('actual public Main stdin/stdout TTY and original raw mode are required');
  }
  const rawBefore = inputStream.isRaw;
  const observation = installPtyObservation(mainEntry, expectedPtyModule, ptyJournal);
  outputStream.write(`\x1b[2J\x1b[H${baseline}`);

  let status = 1;
  let threw = false;
  try {
    const { runSessionHost } = require(mainEntry);
    status = await runSessionHost(options);
  } catch {
    threw = true;
  } finally {
    observation.markNormalMainReturn(status, threw);
    observation.restore();
  }

  const result = {
    status,
    threw,
    stdinIsTTY: inputStream.isTTY === true,
    stdoutIsTTY: outputStream.isTTY === true,
    sameInputStream: process.stdin === inputStream,
    sameOutputStream: process.stdout === outputStream,
    rawBefore,
    rawAfter: inputStream.isRaw,
  };
  try {
    writeResult(resultPath, result);
  } catch {
    // The caller treats the missing CreateNew result as a failed proof.
  }
  process.exitCode = threw ? 1 : status;
}

void main().catch(() => {
  const resultPath = process.env.PRG_SESSION_HOST_WINDOWS_RESULT;
  if (resultPath) {
    try {
      writeResult(resultPath, {
        status: 1,
        threw: true,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        sameInputStream: false,
        sameOutputStream: false,
        rawBefore: null,
        rawAfter: process.stdin.isRaw,
      });
    } catch {
      // A missing result is a bounded test failure, not a fabricated success.
    }
  }
  process.exitCode = 1;
});
