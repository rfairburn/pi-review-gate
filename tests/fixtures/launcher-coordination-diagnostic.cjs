"use strict";

/**
 * Test-only observational preload for the eight-racer concurrent first-launch
 * regression ("concurrent first launches never clobber or expose partial JSON")
 * in tests/launcher-cmd.test.ts.
 *
 * Scope and contract
 * ------------------
 * - It is loaded ONLY into that test's racer helper processes, through the
 *   fixture's appended NODE_OPTIONS `--require` token. No production code loads
 *   it, and nothing outside tests/launcher-cmd.test.ts sets its variables.
 * - It observes exactly two things: filesystem operations on the fixture's own
 *   synthetic application state directory, and the known native PowerShell
 *   owner-birth probe invocation. Everything else passes through untouched.
 * - Observation only. Each wrapper calls the ORIGINAL function through
 *   `Reflect.apply` with the caller's own receiver, returns that call's exact
 *   value, and rethrows that call's exact error object. No return value,
 *   exception, errno, flag, deadline, retry count, or hold duration is altered,
 *   and no product module state is patched.
 * - It never records paths, arguments, process-owner tokens, lock bodies, JSON
 *   config, environment values, or credentials: only fixed operation/context
 *   codes, a bounded safe errno code, and monotonic millisecond measurements.
 * - Memory and output are bounded: aggregate counters, at most the 32 most
 *   recent scoped events (a rolling tail), at most 8 birth-probe samples, and
 *   ONE bounded JSON report written on process exit. When diagnostics cannot be
 *   produced the parent reports `unknown`; the launcher's own exit status is
 *   never changed.
 *
 * Environment (both are removed from the child's own environment after being
 * read, so no descendant process is instrumented):
 *   PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_DIR
 *     Existing directory that receives `report-<pid>.json`.
 *   PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_STATE_ROOT
 *     The exact synthetic application state root to scope observation to.
 *
 * Report schema (one `report-<pid>.json` per process, at most 8192 bytes; every
 * value is a number, boolean, null, or one of these fixed codes):
 *   schema      "prg-launcher-coordination-diagnostic/1"
 *   pid, nodeVersion, platform
 *   entry       launcher-helper | descendant | unknown-entry
 *   stateRoot   { kind: not-observed|missing|directory|symlink|other|unreadable,
 *                 errno: safe errno|null, firstKind, firstErrno, lstatAttempts }
 *               (`kind` is the last observation, `firstKind` the first — the
 *               initial selection decision reads the first one)
 *   ops         { lstat, open, link, write, fsync, unlink, close }
 *               lstat/open/link/unlink count scoped calls; write/fsync count
 *               tracked candidate-fd calls, close only failed candidate closes.
 *   errno       [{ op, code, count }] (at most 6), errnoOverflow
 *   scopedOps   number of observed in-scope operations
 *   cleanupLock { attempts, acquired, eexist, ownerRecordReads, released,
 *                 reclaimUnlinks, holdMsTotal, holdMsMax, heldAtExit }
 *               (attempts count calls; acquired counts successful canonical
 *               links, NOT product ownership after post-link validation. Released
 *               counts successful unlinks; held/hold facts derive only from
 *               those observed operations, not verified lock ownership.)
 *   birthProbe  { calls, self, foreign, ok, failed, timedOut, totalMs, maxMs,
 *                 lastErrno, lastSignal, probes[<=8] { atMs, ms, self, code } }
 *   events      [<=32] { op, target, code, atMs, ms }  (rolling tail: the most
 *               recent operations, so the ones closest to a failure survive;
 *               initial-selection evidence is kept in stateRoot.firstKind)
 *   truncated, droppedEvents, unknown (<=8 fixed reason codes)
 */

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPORT_SCHEMA = "prg-launcher-coordination-diagnostic/1";
const TRACE_DIR_ENV = "PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_DIR";
const STATE_ROOT_ENV = "PRG_LAUNCHER_COORDINATION_DIAGNOSTIC_STATE_ROOT";

/** The coordination entry this diagnostic exists to explain. */
const CLEANUP_LOCK_NAME = "cleanup.lock";
/** Fixed marker of the native Windows owner-birth probe's PowerShell script. */
const BIRTH_PROBE_MARKER = "Get-Process -Id";

const MAX_EVENTS = 32;
const MAX_PROBES = 8;
const MAX_ERRNO_ENTRIES = 6;
const MAX_REPORT_BYTES = 8192;
const MAX_SAFE_CODE_LENGTH = 16;

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/u;
const NODE_VERSION_PATTERN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;

const traceDirectory = process.env[TRACE_DIR_ENV];
const configuredStateRoot = process.env[STATE_ROOT_ENV];
delete process.env[TRACE_DIR_ENV];
delete process.env[STATE_ROOT_ENV];

if (isNonEmptyString(traceDirectory) && isNonEmptyString(configuredStateRoot)) {
  install(traceDirectory, configuredStateRoot);
}

/** Install the observational wrappers. Called only when the fixture opted in. */
function install(traceDirectoryPath, stateRootPath) {
  const stateRoot = path.resolve(stateRootPath);
  const stateRootPrefix = stateRoot.endsWith(path.sep) ? stateRoot : `${stateRoot}${path.sep}`;
  const installedAt = process.hrtime.bigint();

  // Originals are captured before any wrapper is installed, so this module's
  // own reporting never runs through its own instrumentation.
  const originals = {
    closeSync: fs.closeSync,
    execFileSync: childProcess.execFileSync,
    fsyncSync: fs.fsyncSync,
    linkSync: fs.linkSync,
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    unlinkSync: fs.unlinkSync,
    writeFileSync: fs.writeFileSync,
  };

  const unknown = [];
  const noteUnknown = (code) => {
    if (unknown.length < 8 && !unknown.includes(code)) unknown.push(code);
  };

  const stateRootObservation = { kind: "not-observed", errno: null, firstKind: "not-observed", firstErrno: null, lstatAttempts: 0 };
  const opCounts = { lstat: 0, open: 0, link: 0, write: 0, fsync: 0, unlink: 0, close: 0 };
  const errnoEntries = [];
  let errnoOverflow = 0;
  let droppedEvents = 0;
  let scopedOps = 0;

  const cleanupLock = {
    attempts: 0,
    acquired: 0,
    eexist: 0,
    ownerRecordReads: 0,
    released: 0,
    reclaimUnlinks: 0,
    holdMsTotal: 0,
    holdMsMax: 0,
  };
  let cleanupLockHeld = false;
  let cleanupLockHeldAtMs = 0;

  const birthProbe = {
    calls: 0,
    self: 0,
    foreign: 0,
    ok: 0,
    failed: 0,
    timedOut: 0,
    totalMs: 0,
    maxMs: 0,
    lastErrno: null,
    lastSignal: null,
  };

  const events = [];
  const probes = [];
  /** File descriptors opened on a lock candidate, so fd-only writes attribute. */
  const candidateDescriptors = new Set();

  // A path is in scope only when it is the synthetic state root itself or a
  // path beneath it; fixed context codes keep the report free of paths.
  const targetKindOf = (target) => {
    if (typeof target !== "string") return undefined;
    if (target === stateRoot) return "state-root";
    if (!target.startsWith(stateRootPrefix)) return undefined;
    const base = path.basename(target);
    if (base === CLEANUP_LOCK_NAME) return "cleanup-lock";
    if (base.startsWith(`.${CLEANUP_LOCK_NAME}.`)) return "lock-candidate";
    return "state-other";
  };

  const safeErrno = (error) => {
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    return typeof code === "string" && code.length <= MAX_SAFE_CODE_LENGTH && SAFE_CODE_PATTERN.test(code)
      ? code
      : null;
  };

  const safeSignal = (error) => {
    const signal = error !== null && typeof error === "object" ? error.signal : undefined;
    return typeof signal === "string" && signal.length <= MAX_SAFE_CODE_LENGTH && SAFE_CODE_PATTERN.test(signal)
      ? signal
      : null;
  };

  const describeStateRootKind = (stats) => {
    if (stats === null || typeof stats !== "object") return "other";
    if (typeof stats.isSymbolicLink === "function" && stats.isSymbolicLink()) return "symlink";
    if (typeof stats.isDirectory === "function" && stats.isDirectory()) return "directory";
    return "other";
  };

  const elapsedMsSince = (startedAt) => {
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;
  };

  const noteErrno = (op, code) => {
    const existing = errnoEntries.find((entry) => entry.op === op && entry.code === code);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    if (errnoEntries.length < MAX_ERRNO_ENTRIES) {
      errnoEntries.push({ op, code, count: 1 });
      return;
    }
    errnoOverflow += 1;
  };

  const record = (op, target, code, startedAt, value) => {
    const atMs = elapsedMsSince(installedAt);
    const durationMs = elapsedMsSince(startedAt);
    scopedOps += 1;
    opCounts[op] += 1;
    if (code !== null) noteErrno(op, code);

    if (op === "lstat" && target === "state-root") {
      const observedKind = code === null
        ? describeStateRootKind(value)
        : (code === "ENOENT" ? "missing" : "unreadable");
      if (stateRootObservation.lstatAttempts === 0) {
        stateRootObservation.firstKind = observedKind;
        stateRootObservation.firstErrno = code;
      }
      stateRootObservation.lstatAttempts += 1;
      stateRootObservation.errno = code;
      stateRootObservation.kind = observedKind;
    } else if (op === "link" && target === "cleanup-lock") {
      cleanupLock.attempts += 1;
      if (code === null) {
        cleanupLock.acquired += 1;
        cleanupLockHeld = true;
        cleanupLockHeldAtMs = atMs;
      } else if (code === "EEXIST") {
        cleanupLock.eexist += 1;
      }
    } else if (op === "open" && target === "cleanup-lock") {
      cleanupLock.ownerRecordReads += 1;
    } else if (op === "unlink" && target === "cleanup-lock") {
      if (cleanupLockHeld) {
        // Only a successful unlink ends this process's hold. A failed release
        // (EACCES/EPERM/...) stays visible in `errno` and the event tail, is
        // never counted as a completed release, and leaves `heldAtExit` honest.
        if (code === null) {
          const holdMs = Math.max(0, atMs - cleanupLockHeldAtMs);
          cleanupLock.released += 1;
          cleanupLock.holdMsTotal += holdMs;
          cleanupLock.holdMsMax = Math.max(cleanupLock.holdMsMax, holdMs);
          cleanupLockHeld = false;
        }
      } else {
        cleanupLock.reclaimUnlinks += 1;
      }
    }

    if (events.length < MAX_EVENTS) {
      events.push({ op, target, code, atMs, ms: durationMs });
    } else {
      // Bounded rolling tail rather than the first N operations: under prolonged
      // contention the operations closest to the failure are the evidence worth
      // keeping. The first state-root observation is retained separately.
      events.shift();
      events.push({ op, target, code, atMs, ms: durationMs });
      droppedEvents += 1;
    }
  };

  // Every observation is isolated: a bookkeeping failure must never surface in
  // the launcher's own call path.
  const observe = (bookkeeping) => {
    try {
      bookkeeping();
    } catch {
      noteUnknown("observation-error");
    }
  };

  const instrument = (container, name, classify) => {
    const original = container[name];
    if (typeof original !== "function") {
      noteUnknown(`${name}-unavailable`);
      return;
    }
    container[name] = function instrumented(...args) {
      let observation;
      try {
        observation = classify(args);
      } catch {
        observation = undefined;
      }
      if (observation === undefined) return Reflect.apply(original, this, args);
      const startedAt = process.hrtime.bigint();
      let value;
      try {
        value = Reflect.apply(original, this, args);
      } catch (error) {
        observe(() => record(observation.op, observation.target, safeErrno(error), startedAt, undefined));
        throw error;
      }
      observe(() => {
        if (observation.trackDescriptor === true && typeof value === "number" && candidateDescriptors.size < 16) {
          candidateDescriptors.add(value);
        }
        record(observation.op, observation.target, null, startedAt, value);
      });
      return value;
    };
  };

  const observationFor = (op) => (args) => {
    const target = targetKindOf(args[0]);
    return target === undefined ? undefined : { op, target };
  };

  instrument(fs, "lstatSync", observationFor("lstat"));
  instrument(fs, "openSync", (args) => {
    const target = targetKindOf(args[0]);
    if (target === undefined) return undefined;
    return { op: "open", target, trackDescriptor: target === "lock-candidate" };
  });
  instrument(fs, "linkSync", (args) => {
    // The canonical entry is the link DESTINATION; that is the publication
    // attempt the coordination outcome depends on.
    const target = targetKindOf(args[1]);
    return target === undefined ? undefined : { op: "link", target };
  });
  instrument(fs, "writeFileSync", (args) => {
    if (typeof args[0] === "number") {
      return candidateDescriptors.has(args[0]) ? { op: "write", target: "lock-candidate" } : undefined;
    }
    return undefined;
  });
  instrument(fs, "fsyncSync", (args) => {
    if (typeof args[0] === "number") {
      return candidateDescriptors.has(args[0]) ? { op: "fsync", target: "lock-candidate" } : undefined;
    }
    return undefined;
  });
  instrument(fs, "unlinkSync", (args) => {
    const target = targetKindOf(args[0]);
    // Only the canonical coordination entry is interesting; candidate cleanup
    // is routine and would fill the bounded event tail with noise.
    return target === "cleanup-lock" ? { op: "unlink", target } : undefined;
  });

  if (typeof originals.closeSync === "function") {
    fs.closeSync = function instrumentedCloseSync(...args) {
      // A close failure inside the candidate publication is the one remaining
      // non-EEXIST exit the coordination path can take, so a candidate close is
      // timed; successful closes are never recorded (they are pure hot path).
      const tracked = candidateDescriptors.has(args[0]);
      const startedAt = tracked ? process.hrtime.bigint() : 0n;
      observe(() => {
        if (typeof args[0] === "number") candidateDescriptors.delete(args[0]);
      });
      try {
        return Reflect.apply(originals.closeSync, this, args);
      } catch (error) {
        if (tracked) observe(() => record("close", "lock-candidate", safeErrno(error), startedAt, undefined));
        throw error;
      }
    };
  } else {
    noteUnknown("closeSync-unavailable");
  }

  const isOwnerBirthProbe = (file, argv) => {
    if (typeof file !== "string" || !Array.isArray(argv)) return false;
    let base;
    try {
      base = path.basename(file).toLowerCase();
    } catch {
      return false;
    }
    if (base !== "powershell.exe" && base !== "pwsh.exe") return false;
    return argv.some((entry) => typeof entry === "string" && entry.includes(BIRTH_PROBE_MARKER));
  };

  if (typeof originals.execFileSync === "function") {
    childProcess.execFileSync = function instrumentedExecFileSync(...args) {
      const observation = isOwnerBirthProbe(args[0], args[1]);
      if (!observation) return Reflect.apply(originals.execFileSync, this, args);
      const startedAt = process.hrtime.bigint();
      const lastArg = args[1][args[1].length - 1];
      const probedPid = Number(lastArg);
      const isSelf = probedPid === process.pid;
      observe(() => {
        birthProbe.calls += 1;
        if (isSelf) birthProbe.self += 1;
        else birthProbe.foreign += 1;
      });
      let value;
      try {
        value = Reflect.apply(originals.execFileSync, this, args);
      } catch (error) {
        observe(() => {
          birthProbe.failed += 1;
          const code = safeErrno(error);
          if (code === "ETIMEDOUT") birthProbe.timedOut += 1;
          birthProbe.lastErrno = code;
          birthProbe.lastSignal = safeSignal(error);
          recordProbe(startedAt, isSelf, code);
        });
        throw error;
      }
      observe(() => {
        birthProbe.ok += 1;
        recordProbe(startedAt, isSelf, null);
      });
      return value;
    };
  } else {
    noteUnknown("execFileSync-unavailable");
  }

  function recordProbe(startedAt, isSelf, code) {
    const atMs = elapsedMsSince(installedAt);
    const durationMs = elapsedMsSince(startedAt);
    birthProbe.totalMs += durationMs;
    birthProbe.maxMs = Math.max(birthProbe.maxMs, durationMs);
    if (probes.length < MAX_PROBES) probes.push({ atMs, ms: durationMs, self: isSelf, code });
  }

  const entryCode = () => {
    const entry = process.argv[1];
    if (typeof entry !== "string") return "unknown-entry";
    try {
      return path.basename(entry) === "pi-review-gate-launcher.cjs" ? "launcher-helper" : "descendant";
    } catch {
      return "unknown-entry";
    }
  };

  const buildReport = () => ({
    schema: REPORT_SCHEMA,
    pid: process.pid,
    nodeVersion: NODE_VERSION_PATTERN.test(process.versions.node) ? process.versions.node : "unknown",
    platform: process.platform,
    entry: entryCode(),
    stateRoot: {
      kind: stateRootObservation.kind,
      errno: stateRootObservation.errno,
      firstKind: stateRootObservation.firstKind,
      firstErrno: stateRootObservation.firstErrno,
      lstatAttempts: stateRootObservation.lstatAttempts,
    },
    ops: { ...opCounts },
    errno: errnoEntries.map((entry) => ({ op: entry.op, code: entry.code, count: entry.count })),
    errnoOverflow,
    scopedOps,
    cleanupLock: { ...cleanupLock, heldAtExit: cleanupLockHeld },
    birthProbe: { ...birthProbe, probes: [...probes] },
    events: [...events],
    truncated: droppedEvents > 0,
    droppedEvents,
    unknown: [...unknown],
  });

  process.on("exit", () => {
    try {
      // Nothing was observed: this process (usually a launched descendant) has
      // no evidence to contribute, and no report is written for it.
      if (scopedOps === 0 && birthProbe.calls === 0) return;
      let report = buildReport();
      let text = `${JSON.stringify(report)}\n`;
      if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
        report = { ...report, events: [], truncated: true, unknown: [...report.unknown.slice(0, 7), "report-size-capped"] };
        text = `${JSON.stringify(report)}\n`;
      }
      originals.writeFileSync(path.join(traceDirectoryPath, `report-${process.pid}.json`), text, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      // Diagnostics are evidence only: never change the process exit status.
    }
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
