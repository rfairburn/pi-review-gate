'use strict';

/**
 * Test-only bounded startup trace for the Windows real-Main runner (Refs #494).
 *
 * Diagnosis only: it never decides, waits, retries, or changes Main. It lets a
 * failed welcome-frame wait say WHERE startup stopped, using fixed vocabulary:
 *
 * - runner stages (fixed names) with elapsed milliseconds since runner start;
 * - one begin/end record per synchronous child-process call made inside the
 *   runner process (`spawnSync`, `execFileSync`, `execSync`). The observation
 *   is a strict transparent forwarder (exact receiver, arguments, return value,
 *   and thrown error identity). Only a fixed executable class from the basename
 *   (`powershell`, `pwsh`, `node`, `icacls`, `other`), a fixed argument shape
 *   (`version`, `encoded-command`, `command`, `other`), duration, integer exit
 *   status, a fixed signal/errno class, and timeout are recorded — never argv,
 *   paths, environment, input, or output;
 * - event-loop stalls observed by an unref'd interval (gap milliseconds only).
 *
 * It deliberately reads no acceptance census: a census snapshot is stateful (it
 * latches sticky unknown for an outstanding partial escape sequence), so an
 * intermediate trace event must never take one. Outer output timing comes from
 * the harness side instead.
 *
 * Records are appended synchronously so a later blocked call still leaves the
 * preceding begin record on disk. The journal is a caller-precreated regular
 * file; anything else keeps the trace inert. Every failure is swallowed.
 */

const TRACE_SCHEMA_VERSION = 1;
const MAX_TRACE_BYTES = 256 * 1024;
const LOOP_TICK_MS = 250;
const LOOP_GAP_REPORT_MS = 1000;
const MAX_LOOP_GAP_RECORDS = 64;

const STAGES = Object.freeze([
  'runner-start',
  'options-read',
  'tty-prerequisites',
  'pty-observation-installed',
  'baseline-written',
  'census-installed',
  'observers-installed',
  'main-required',
  'main-called',
  'main-returned',
  'main-threw',
  'child-begin',
  'child-end',
  'loop-gap',
  'trace-truncated',
]);
const CHILD_KINDS = Object.freeze(['powershell', 'pwsh', 'node', 'icacls', 'other']);
const ARG_SHAPES = Object.freeze(['version', 'encoded-command', 'command', 'other']);
const CHILD_APIS = Object.freeze(['spawnSync', 'execFileSync', 'execSync']);
const SIGNAL_CLASSES = Object.freeze(['SIGKILL', 'SIGTERM', 'other']);
const ERROR_CODES = Object.freeze(['ETIMEDOUT', 'ENOENT', 'ENOBUFS', 'EPERM', 'EACCES', 'EINVAL', 'other']);
const ERROR_NAMES = Object.freeze(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'other']);

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1 ? value : null;
}

function classifyExecutable(file) {
  if (typeof file !== 'string') return 'other';
  const base = file.split(/[\\/]/u).pop().toLowerCase().replace(/\.exe$/u, '');
  return CHILD_KINDS.includes(base) ? base : 'other';
}

function classifyArgs(args) {
  if (!Array.isArray(args)) return 'other';
  if (args.includes('--version')) return 'version';
  if (args.some((arg) => typeof arg === 'string' && arg.toLowerCase() === '-encodedcommand')) return 'encoded-command';
  if (args.some((arg) => typeof arg === 'string' && arg.toLowerCase() === '-command')) return 'command';
  return 'other';
}

function classifySignal(signal) {
  if (signal === null || signal === undefined) return null;
  return SIGNAL_CLASSES.includes(signal) ? signal : 'other';
}

function classifyCode(code) {
  if (code === null || code === undefined) return null;
  return ERROR_CODES.includes(code) ? code : 'other';
}

function classifyErrorName(error) {
  try {
    const name = error !== null && typeof error === 'object' && error.constructor ? error.constructor.name : undefined;
    return ERROR_NAMES.includes(name) ? name : 'other';
  } catch {
    return 'other';
  }
}

/** Fixed per-API child description: file and argv positions of the public signatures. */
function describeCall(api, args) {
  if (api === 'execSync') return { kind: 'other', shape: 'other' };
  const file = args[0];
  const argv = Array.isArray(args[1]) ? args[1] : [];
  return { kind: classifyExecutable(file), shape: classifyArgs(argv) };
}

/** @param {{ journal: string | undefined, fs: typeof import('node:fs'), now?: () => number }} options */
function createStartupTrace(options) {
  const fs = options.fs;
  const now = typeof options.now === 'function' ? options.now : () => Number(process.hrtime.bigint() / 1000000n);
  const origin = now();
  let journal;
  try {
    const stats = typeof options.journal === 'string' && options.journal.length > 0 ? fs.lstatSync(options.journal) : undefined;
    if (stats !== undefined && stats.isFile() && !stats.isSymbolicLink()) journal = options.journal;
  } catch {
    journal = undefined;
  }
  let bytes = 0;
  let truncated = false;
  let seq = 0;
  function record(stage, fields) {
    if (journal === undefined || truncated || !STAGES.includes(stage)) return;
    try {
      seq += 1;
      const line = `${JSON.stringify({ v: TRACE_SCHEMA_VERSION, seq, stage, ms: Math.max(0, Math.round(now() - origin)), ...fields })}\n`;
      if (bytes + line.length > MAX_TRACE_BYTES) {
        truncated = true;
        fs.appendFileSync(journal, `${JSON.stringify({ v: TRACE_SCHEMA_VERSION, seq, stage: 'trace-truncated', ms: Math.max(0, Math.round(now() - origin)) })}\n`);
        return;
      }
      bytes += line.length;
      fs.appendFileSync(journal, line);
    } catch {
      // Diagnosis only: a failed append never reaches Main.
    }
  }

  return {
    stage(name, fields = {}) {
      const safe = {};
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'boolean' || value === null) safe[key] = value;
        else if (typeof value === 'number') safe[key] = boundedInteger(value);
        else if (key === 'errorName' && ERROR_NAMES.includes(value)) safe[key] = value;
      }
      record(name, safe);
    },
    classifyErrorName,
    /** Transparent synchronous child-process observation; returns an exact restore. */
    observeChildProcess(childProcess) {
      const installed = [];
      if (journal === undefined) return () => true;
      for (const api of CHILD_APIS) {
        const original = childProcess[api];
        if (typeof original !== 'function') continue;
        const wrapper = function observedSyncChild(...args) {
          let id = 0;
          let started = 0;
          let description = { kind: 'other', shape: 'other' };
          try {
            description = describeCall(api, args);
            id = seq + 1;
            started = now();
            record('child-begin', { id, api, ...description });
          } catch {
            id = 0;
          }
          let result;
          try {
            result = Reflect.apply(original, this, args);
          } catch (error) {
            if (id !== 0) {
              record('child-end', {
                id, api, ...description,
                durationMs: Math.max(0, Math.round(now() - started)),
                threw: true,
                status: boundedInteger(error && error.status),
                signal: classifySignal(error && error.signal),
                code: classifyCode(error && error.code),
              });
            }
            throw error;
          }
          if (id !== 0) {
            const syncResult = api === 'spawnSync' && result !== null && typeof result === 'object' ? result : undefined;
            record('child-end', {
              id, api, ...description,
              durationMs: Math.max(0, Math.round(now() - started)),
              threw: false,
              status: syncResult === undefined ? 0 : boundedInteger(syncResult.status),
              signal: syncResult === undefined ? null : classifySignal(syncResult.signal),
              code: syncResult === undefined || !syncResult.error ? null : classifyCode(syncResult.error.code),
            });
          }
          return result;
        };
        try {
          childProcess[api] = wrapper;
          if (childProcess[api] === wrapper) installed.push({ api, original, wrapper });
        } catch {
          // An unwritable slot stays unobserved.
        }
      }
      return () => {
        let restored = true;
        for (const { api, original, wrapper } of installed) {
          try {
            if (childProcess[api] === wrapper) childProcess[api] = original;
            else restored = false; // foreign slot: never touch
          } catch {
            restored = false;
          }
        }
        return restored;
      };
    },
    /** Unref'd event-loop stall observation; returns an exact stop. */
    observeLoop(timers = { setInterval, clearInterval }) {
      if (journal === undefined) return () => undefined;
      let last = now();
      let reported = 0;
      const handle = timers.setInterval(() => {
        const current = now();
        const gap = current - last - LOOP_TICK_MS;
        last = current;
        if (gap >= LOOP_GAP_REPORT_MS && reported < MAX_LOOP_GAP_RECORDS) {
          reported += 1;
          record('loop-gap', { gapMs: Math.round(gap) });
        }
      }, LOOP_TICK_MS);
      try { if (handle && typeof handle.unref === 'function') handle.unref(); } catch { /* best effort */ }
      return () => timers.clearInterval(handle);
    },
  };
}

module.exports = {
  ARG_SHAPES,
  CHILD_APIS,
  CHILD_KINDS,
  ERROR_CODES,
  ERROR_NAMES,
  SIGNAL_CLASSES,
  STAGES,
  TRACE_SCHEMA_VERSION,
  MAX_TRACE_BYTES,
  createStartupTrace,
};
