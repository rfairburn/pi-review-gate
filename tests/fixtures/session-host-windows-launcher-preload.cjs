'use strict';

/**
 * Test-only NODE_OPTIONS preload for the real Windows source-launcher
 * acceptance lane.
 *
 * It is inert unless this exact Node process is positively identified as one
 * of two things:
 *
 * 1. the actual source launcher entry (`<sourceRoot>/scripts/pi-review-sessions.cjs`)
 *    for the fixture root named by PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT while
 *    carrying the bounded PRG_SESSION_HOST_LAUNCHER_NONCE. Only then does it
 *    wrap the pinned public @lydell/node-pty spawn API at the exact production
 *    lazy-load anchor (dist/src/session-host/instances.js) through the shared
 *    observation fixture, journal bounded metadata, and paint the outer VT
 *    restoration baseline before the launcher runs. It never uses a production
 *    dependency-injection seam, never substitutes a handle, and never records
 *    argv, env, credentials, or terminal transcripts.
 *
 * 2. a real native Pi child launched from the pinned installed agent root
 *    (PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT), where it records bounded
 *    booleans proving the production bootstrap preload consumed its one-shot
 *    restore sidecar and left the original NODE_OPTIONS in place. It never
 *    writes to stdout in this branch, so the native TUI is untouched.
 *
 * npm/tsc/version-probe Node processes are deliberately not identified:
 * matching requires the exact launcher entry path or the pinned agent root.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { appendMetadata, observePtyModule } = require('./session-host-windows-pty-observer.cjs');
const {
  captureLauncherBaseline,
  launcherRestorationSnapshot,
  nativeRestorationSnapshot,
} = require('./session-host-windows-launcher-restoration.cjs');

const SOURCE_ROOT_ENV = 'PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT';
const NONCE_ENV = 'PRG_SESSION_HOST_LAUNCHER_NONCE';
const PTY_JOURNAL_ENV = 'PRG_SESSION_HOST_LAUNCHER_PTY_JOURNAL';
const BASELINE_ENV = 'PRG_SESSION_HOST_LAUNCHER_BASELINE';
const NATIVE_AGENT_ENV = 'PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT';
const LAUNCHER_ENTRY_RELATIVE = path.join('scripts', 'pi-review-sessions.cjs');
const LAUNCHER_INSTANCES_PATTERN = /[\\/]dist[\\/]src[\\/]session-host[\\/]instances\.js$/;
const MIN_NONCE_LENGTH = 16;
const MAX_NONCE_LENGTH = 128;

function realpathOrUndefined(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function isBoundedNonce(value) {
  return typeof value === 'string' && value.length >= MIN_NONCE_LENGTH && value.length <= MAX_NONCE_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isAbsoluteEntry(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** True only for the exact source launcher entry of the named fixture root. */
function launcherEntryIsActual() {
  const sourceRoot = process.env[SOURCE_ROOT_ENV];
  if (!isAbsoluteEntry(sourceRoot)) return false;
  if (!isBoundedNonce(process.env[NONCE_ENV])) return false;
  const actualEntry = realpathOrUndefined(process.argv[1]);
  const expectedEntry = realpathOrUndefined(path.join(sourceRoot, LAUNCHER_ENTRY_RELATIVE));
  return actualEntry !== undefined && expectedEntry !== undefined && actualEntry === expectedEntry;
}

/** True only for a real native Pi child launched from the pinned agent root. */
function nativeChildIsActual() {
  const nativeAgent = process.env[NATIVE_AGENT_ENV];
  if (!isAbsoluteEntry(nativeAgent)) return false;
  // Positive TTY discriminator: the real native child runs inside the host's
  // ConPTY, while the launcher's own bounded Pi --version probe (which also
  // runs the pinned CLI path) captures a pipe, so it is never mistaken for a
  // native child.
  if (!process.stdout || process.stdout.isTTY !== true) return false;
  const actualEntry = realpathOrUndefined(process.argv[1]);
  const expectedAgent = realpathOrUndefined(nativeAgent);
  return actualEntry !== undefined && expectedAgent !== undefined && isWithin(expectedAgent, actualEntry);
}

function resolvedPtyPath(request, parent, isMain) {
  try {
    return Module._resolveFilename(request, parent, isMain);
  } catch {
    return undefined;
  }
}

function activateLauncher(journal) {
  const baseline = captureLauncherBaseline({ stdin: process.stdin, stdout: process.stdout, env: process.env });
  let observation;
  // Registered before the shared observer's own exit handler so a normal
  // settled return is marked first; the observer's bounded exact-handle
  // cleanup then skips a proven success and never overwrites force history.
  process.on('exit', (code) => {
    const restoration = launcherRestorationSnapshot(baseline, {
      stdin: process.stdin,
      stdout: process.stdout,
      env: process.env,
    });
    appendMetadata(journal, {
      type: 'launcher_restoration',
      pid: process.pid,
      ...restoration,
    });
    if (observation === undefined) return;
    observation.markNormalMainReturn(typeof code === 'number' ? code : 1, false);
    appendMetadata(journal, {
      type: 'launcher_summary',
      pid: process.pid,
      exitCode: typeof code === 'number' ? code : null,
      ...observation.snapshot(),
    });
  });
  appendMetadata(journal, {
    type: 'launcher_entry',
    pid: process.pid,
    entry: realpathOrUndefined(process.argv[1]),
    rawBefore: baseline.rawBefore,
  });
  const originalLoad = Module._load;
  Module._load = function launcherLoad(request, parent, isMain) {
    const result = Reflect.apply(originalLoad, this, arguments);
    if (observation === undefined && request === '@lydell/node-pty'
        && parent && typeof parent.filename === 'string'
        && LAUNCHER_INSTANCES_PATTERN.test(parent.filename)) {
      appendMetadata(journal, {
        type: 'pty_module',
        pid: process.pid,
        parent: realpathOrUndefined(parent.filename),
        modulePath: (() => {
          const resolved = resolvedPtyPath(request, parent, isMain);
          return resolved === undefined ? undefined : realpathOrUndefined(resolved);
        })(),
      });
      observation = observePtyModule(result, journal);
    }
    return result;
  };
  const vtBaseline = process.env[BASELINE_ENV];
  if (typeof vtBaseline === 'string' && vtBaseline.length > 0) {
    process.stdout.write(`\x1b[2J\x1b[H${vtBaseline}`);
  }
}

function activateNativeChild(journal) {
  // The production bootstrap preload is prepended to NODE_OPTIONS and runs
  // before this module, so by now it has consumed its one-shot sidecar and
  // restored the caller's original NODE_OPTIONS. Only bounded booleans are
  // journaled; no env value is ever copied.
  appendMetadata(journal, {
    type: 'native_preload',
    pid: process.pid,
    entry: realpathOrUndefined(process.argv[1]),
    ...nativeRestorationSnapshot(process.env),
  });
}

try {
  const journal = process.env[PTY_JOURNAL_ENV];
  if (typeof journal === 'string' && journal.length > 0) {
    if (launcherEntryIsActual()) activateLauncher(journal);
    else if (nativeChildIsActual()) activateNativeChild(journal);
  }
} catch {
  // A preload observation failure is surfaced by the missing journal record;
  // it must never change the real process outcome.
}
