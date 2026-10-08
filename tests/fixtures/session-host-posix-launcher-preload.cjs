'use strict';

/**
 * Test-only NODE_OPTIONS preload for the real POSIX (macOS/Linux) source-launcher
 * acceptance lane.
 *
 * It is inert unless this exact Node process is positively identified as one of
 * two things:
 *
 * 1. the actual POSIX source launcher entry
 *    (`<sourceRoot>/scripts/pi-review-sessions.cjs`) for the fixture root named
 *    by PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT while carrying the bounded
 *    PRG_SESSION_HOST_LAUNCHER_NONCE. Only then does it install POSIX-aware
 *    exact-handle observation of the pinned public @lydell/node-pty spawn API at
 *    the exact production lazy-load anchor (dist/src/session-host/instances.js),
 *    journal bounded metadata, and paint the outer VT restoration baseline
 *    before the launcher runs. It never uses a production dependency-injection
 *    seam, never substitutes a handle, and never records argv, env, credentials,
 *    or terminal transcripts.
 *
 * 2. a real native Pi child launched from the pinned installed agent root
 *    (PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT), where it records bounded booleans
 *    proving the production bootstrap preload consumed its one-shot restore
 *    sidecar and left the original NODE_OPTIONS in place. It never writes to
 *    stdout in this branch, so the native TUI is untouched.
 *
 * npm/tsc/version-probe Node processes are deliberately not identified: matching
 * requires the exact launcher entry path or the pinned agent root.
 *
 * POSIX kill semantics differ from the shared Windows lane: an explicit
 * SIGTERM is the graceful graceful-shutdown fallback and MUST NOT be mislabeled
 * as force, while a no-argument kill is not force either. Only SIGKILL is sticky
 * force. Every attempt is journaled before the original method runs, with the
 * original receiver, arguments, return value, and thrown errors preserved.
 *
 * The bounded restoration comparisons are the existing shared implementation,
 * required through the POSIX-owned re-export module rather than copied.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const {
  captureLauncherBaseline,
  launcherRestorationSnapshot,
  nativeRestorationSnapshot,
} = require('./session-host-posix-launcher-restoration.cjs');

const SOURCE_ROOT_ENV = 'PRG_SESSION_HOST_LAUNCHER_SOURCE_ROOT';
const NONCE_ENV = 'PRG_SESSION_HOST_LAUNCHER_NONCE';
const PTY_JOURNAL_ENV = 'PRG_SESSION_HOST_LAUNCHER_PTY_JOURNAL';
const BASELINE_ENV = 'PRG_SESSION_HOST_LAUNCHER_BASELINE';
const NATIVE_AGENT_ENV = 'PRG_SESSION_HOST_LAUNCHER_NATIVE_AGENT';
const EXPECT_PROVIDER_DIGEST_ENV = 'PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_DIGEST';
const LAUNCHER_ENTRY_RELATIVE = path.join('scripts', 'pi-review-sessions.cjs');
const LAUNCHER_INSTANCES_PATTERN = /[\\/]dist[\\/]src[\\/]session-host[\\/]instances\.js$/;
const MIN_NONCE_LENGTH = 16;
const MAX_NONCE_LENGTH = 128;
const PROVIDER_ENV_PATTERN = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PROVIDER)/i;

function appendMetadata(destination, record) {
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8');
}

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

/**
 * Bounded, value-free fingerprint of the caller's provider-relevant
 * environment names/values. Only the digest is ever journaled; no value is
 * copied or logged.
 */
function providerEnvironmentDigest(env) {
  const pairs = Object.keys(env)
    .filter((name) => PROVIDER_ENV_PATTERN.test(name) && !name.startsWith('PRG_'))
    .sort()
    .map((name) => `${name}=${env[name] === undefined ? '' : String(env[name])}`);
  return crypto.createHash('sha256').update(pairs.join('\u0000')).digest('hex');
}

/** True only for the exact POSIX source launcher entry of the named fixture root. */
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
  // PTY, while the launcher's own bounded Pi --version probe (which also runs
  // the pinned CLI path) and the npm/tsc setup children capture pipes, so they
  // are never mistaken for a native child.
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

/**
 * Bounded physical controlling-terminal state of this real launcher process,
 * read directly from its own PTY slave. Returns the exact `stty -g` string, or
 * undefined when the platform tool is unavailable; never throws.
 */
function readControllingTtyState() {
  try {
    const result = spawnSync('stty', ['-g'], {
      stdio: [0, 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const value = result.stdout.trim();
    return value.length > 0 && value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POSIX-aware exact-handle observation of the public @lydell/node-pty module.
 *
 * - strict forwarder: identical receiver, exact arguments, spawn errors, and
 *   the exact returned IPty handle (never a substitute or an adopted/guessed
 *   PID);
 * - `onExit` is subscribed through the read-only public accessor, never
 *   assigned;
 * - every public `kill()` attempt (including production escalation and throws)
 *   is recorded stickily BEFORE the original method runs, preserving the same
 *   real handle/method receiver/arguments/return;
 * - graceful POSIX signals (for example SIGTERM) and a no-argument kill are not
 *   force; only SIGKILL is sticky force;
 * - only bounded numeric/boolean and fixed allowlisted path metadata is
 *   journaled.
 */
function observePtyModulePosix(nodePty, ptyJournal) {
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('the pinned public @lydell/node-pty spawn API is unavailable');
  }
  const originalSpawn = nodePty.spawn;
  const ownedHandles = [];
  let normalMainReturn = false;
  let forceAttempted = false;
  let journalFailed = false;
  let gracefulSignalAttempts = 0;
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
      handle.kill = function observedKill(...killArgs) {
        const signal = killArgs.length > 0 && typeof killArgs[0] === 'string' ? killArgs[0] : null;
        const isForce = signal === 'SIGKILL';
        if (isForce) forceAttempted = true;
        else gracefulSignalAttempts += 1;
        observePublicPid();
        journal({ type: 'pty_kill_attempt', signal, force: isForce, ...record });
        if (isForce) journal({ type: 'pty_force_attempt', signal, ...record });
        return Reflect.apply(originalKill, this, killArgs);
      };
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
      // On POSIX forkpty, the public pid is available shortly after spawn;
      // observe it on public data delivery as well, without inspecting data.
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
  // successful public Main return never reaches this path. POSIX uses an
  // explicit SIGKILL so the attempt is truthfully classified as force.
  process.on('exit', () => {
    if (normalMainReturn) return;
    for (const owner of ownedHandles) {
      if (owner.exited) continue;
      forceAttempted = true;
      journal({ type: 'pty_kill_attempt', signal: 'SIGKILL', force: true, cleanup: true, ...owner.record });
      journal({ type: 'pty_force_attempt', signal: 'SIGKILL', cleanup: true, ...owner.record });
      try { owner.handle.kill('SIGKILL'); } catch { /* exact owned public PTY only */ }
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
        gracefulSignalAttempts,
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

function activateLauncher(journal) {
  const baseline = captureLauncherBaseline({ stdin: process.stdin, stdout: process.stdout, env: process.env });
  const ttyBefore = readControllingTtyState();
  const providerDigestBefore = providerEnvironmentDigest(process.env);
  let observation;
  // Registered before the shared observer's own exit handler so a normal settled
  // return is marked first; the observer's bounded exact-handle cleanup then
  // skips a proven success and never overwrites force history.
  process.on('exit', (code) => {
    const restoration = launcherRestorationSnapshot(baseline, {
      stdin: process.stdin,
      stdout: process.stdout,
      env: process.env,
    });
    const providerDigestAfter = providerEnvironmentDigest(process.env);
    const expectedDigest = process.env[EXPECT_PROVIDER_DIGEST_ENV];
    appendMetadata(journal, {
      type: 'launcher_restoration',
      pid: process.pid,
      ttyBefore,
      ttyAfter: readControllingTtyState(),
      providerDigestBefore,
      providerDigestAfter,
      providerDigestExact: providerDigestAfter === providerDigestBefore
        && (typeof expectedDigest !== 'string' || providerDigestAfter === expectedDigest),
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
      observation = observePtyModulePosix(result, journal);
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
