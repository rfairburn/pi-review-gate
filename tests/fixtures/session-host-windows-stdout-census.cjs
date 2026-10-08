'use strict';

/**
 * Test-only numeric stdout mode-request census for the Windows Main runner.
 *
 * This is diagnosis, never acceptance proof: it counts write calls offered
 * through the retained process.stdout and the complete DECSET/DECRST lists
 * that request the fixed known tracking/SGR/alternate/paste modes Main's
 * mirror code may emit (x10 mode 9 included). It observes offered requests
 * only — not byte delivery, negotiated terminal state, or original process
 * settlement.
 *
 * Truth-of-scope rules:
 * - the write hook is a strict forwarder: exact original receiver, arguments,
 *   callback identity, return/backpressure value, and thrown error identity;
 *   no extra terminal write, flush, end, or destroy is ever issued;
 * - offered-mode observation is captured BEFORE the original call (a
 *   synchronous caller callback may mutate a Buffer) and invalidated when the
 *   original throws — any throwing original write invalidates the ENTIRE
 *   census to sticky unknown while rethrowing the identical error, so a failed
 *   partial sequence can never combine with a later successful suffix;
 * - only explicitly modeled string encodings are observed (no encoding or
 *   utf8/utf-8); every other explicit string encoding is sticky unknown
 *   instead of masquerading as supported observation;
 * - per-offer mode deltas are fixed-size and cap-checked while parsing, so
 *   maxCarry and maxCount bound observation storage for any chunk size;
 * - a borrowed call with a foreign receiver still forwards exactly but marks
 *   the census unknown instead of counting a different receiver as Main
 *   stdout; observed hook replacement or stream-identity loss latches
 *   permanent uncertainty (writes during the gap were missed);
 * - unsupported chunk types, carry truncation, counter overflow, or a changed
 *   hook are sticky unknown (null), never zero;
 * - a snapshot observed while an ESC/CSI/DEC sequence is still outstanding
 *   (after ESC, after the CSI intro, or mid DEC parameter list) latches
 *   sticky unknown: the incomplete prefix can never be completed after the
 *   observation, so no later suffix may borrow known counts; supported split
 *   sequences that fully complete before the snapshot are counted normally;
 * - only bounded no-transcript state is retained: one partial DEC parameter
 *   list and integer counters. Raw stream data is never stored, formatted, or
 *   logged.
 *
 * The request/reply service exchanges through FIXED per-fresh-root leaves
 * (`main-census-request.json` / `main-census-reply.json`); the fresh nonce
 * lives in the payload only. It watches exactly one owned nonrecursive
 * directory, ignores every other filename, validates the original root AND
 * ancestor directory identities (rechecked after request reading, before
 * reply creation), validates a bounded regular nonsymlink request through
 * readonly descriptor/BigInt type/size/identity checks, and writes exactly
 * one exclusive reply leaf bound to the same nonce and the genuine Main PID.
 * The snapshot is built and serialized BEFORE the exclusive reply opens, so a
 * failed snapshot build leaves no reply leaf. Missing, malformed, oversized,
 * replayed, wrong-PID, changed-root/ancestor, or partially published requests
 * are honest refusals: no reply is written. A watcher error permanently
 * degrades the channel and closes the owned watcher exactly once. All fs
 * operations are injected so pure tests can drive the service with fake IO;
 * no scanning, cleanup, retry, or polling occurs.
 */

const path = require('node:path');

const CENSUS_SCHEMA_VERSION = 1;
const CENSUS_REQUEST_FILENAME = 'main-census-request.json';
const CENSUS_REPLY_FILENAME = 'main-census-reply.json';

/** Fixed known DEC private modes Main's mirror code may request. */
const CENSUS_KNOWN_MODES = Object.freeze([
  { mode: 9, field: 'mouseX10' },
  { mode: 1000, field: 'mouseVt200' },
  { mode: 1002, field: 'mouseDrag' },
  { mode: 1003, field: 'mouseAny' },
  { mode: 1006, field: 'mouseSgr' },
  { mode: 1049, field: 'alternateBuffer' },
  { mode: 2004, field: 'bracketedPaste' },
]);

const CENSUS_COUNT_FIELDS = ['writeCalls'].concat(
  CENSUS_KNOWN_MODES.flatMap((entry) => [`${entry.field}Set`, `${entry.field}Reset`]),
);
const CENSUS_MODE_COUNT_FIELDS = CENSUS_KNOWN_MODES.flatMap((entry) => [`${entry.field}Set`, `${entry.field}Reset`]);

const DEFAULT_MAX_CARRY = 64;
const DEFAULT_MAX_COUNT = 2 ** 31 - 1;
const DEFAULT_MAX_REQUEST_BYTES = 4096;
const MAX_DIRECTORY_CHAIN_DEPTH = 32;
const CENSUS_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Bounded incremental census of offered DEC private-mode requests.
 * `options.maxCarry` bounds the retained partial parameter list and
 * `options.maxCount` bounds every counter; either violation is sticky unknown.
 */
function createStdoutModeCensus(options = {}) {
  const maxCarry = options.maxCarry === undefined ? DEFAULT_MAX_CARRY : options.maxCarry;
  const maxCount = options.maxCount === undefined ? DEFAULT_MAX_COUNT : options.maxCount;
  if (!Number.isSafeInteger(maxCarry) || maxCarry < 1) throw new RangeError('census maxCarry must be a positive safe integer');
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) throw new RangeError('census maxCount must be a positive safe integer');

  let unknown = false;
  // 0 = idle, 1 = after ESC, 2 = after CSI intro, 3 = DEC parameter list
  let state = 0;
  let carry = '';
  const counts = {};
  for (const field of CENSUS_COUNT_FIELDS) counts[field] = 0;
  // Fixed-size per-offer deltas: observation storage is bounded by the known
  // mode set, never by chunk size.
  let pendingDeltas = {};

  function markUnknown() {
    unknown = true;
    state = 0;
    carry = '';
  }

  function bump(field, amount = 1) {
    counts[field] += amount;
    if (counts[field] > maxCount) markUnknown();
  }

  function completeList(isSet) {
    const list = carry;
    state = 0;
    carry = '';
    if (unknown) return;
    const parts = list.split(';');
    for (const part of parts) {
      if (!/^[0-9]+$/.test(part)) return; // malformed list: no counts at all
    }
    const seen = new Set();
    for (const part of parts) {
      const value = Number(part);
      if (Number.isSafeInteger(value)) seen.add(value);
    }
    for (const entry of CENSUS_KNOWN_MODES) {
      if (!seen.has(entry.mode)) continue;
      const field = `${entry.field}${isSet ? 'Set' : 'Reset'}`;
      // Cap-checked while parsing: overflow invalidates before unbounded growth.
      if (counts[field] + pendingDeltas[field] + 1 > maxCount) { markUnknown(); return; }
      pendingDeltas[field] += 1;
    }
  }

  function feed(chunk) {
    const isString = typeof chunk === 'string';
    for (let index = 0; index < chunk.length; index += 1) {
      const code = isString ? chunk.charCodeAt(index) : chunk[index];
      if (state === 0) {
        if (code === 0x1b) state = 1;
      } else if (state === 1) {
        if (code === 0x5b) state = 2;
        else if (code !== 0x1b) state = 0;
      } else if (state === 2) {
        if (code === 0x3f) { state = 3; carry = ''; }
        else if (code === 0x1b) state = 1;
        else state = 0;
      } else {
        if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
          carry += isString ? chunk[index] : String.fromCharCode(code);
          if (carry.length > maxCarry) { markUnknown(); return; }
        } else if (code === 0x68 || code === 0x6c) {
          completeList(code === 0x68);
        } else if (code === 0x1b) {
          state = 1; // a new ESC abandons the malformed list and restarts
          carry = '';
        } else {
          state = 0;
          carry = '';
        }
      }
    }
  }

  return {
    /**
     * Pre-captures the offered mode requests of one write data argument before
     * the original write runs. `second` is the exact second forwarded
     * argument, inspected ONLY for string-encoding modeling: an explicit
     * string encoding other than utf8/utf-8 is sticky unknown (hex, base64,
     * utf16le, ... are never decoded here). Returns a commit/discard handle,
     * or null when the census is already unknown, the chunk type is
     * unsupported (sticky unknown), the encoding is unmodeled (sticky
     * unknown), or capture overflowed (sticky unknown). The captured offer is
     * committed only for a non-throwing original call and invalidated when
     * the original throws.
     */
    beginOffer(data, second) {
      if (unknown) return null;
      const isBuffer = Buffer.isBuffer(data);
      const isString = typeof data === 'string';
      if (!isBuffer && !isString) {
        markUnknown();
        return null;
      }
      if (isString && typeof second === 'string' && second !== 'utf8' && second !== 'utf-8') {
        markUnknown(); // explicitly modeled encodings only
        return null;
      }
      pendingDeltas = {};
      for (const field of CENSUS_MODE_COUNT_FIELDS) pendingDeltas[field] = 0;
      feed(data);
      if (unknown) return null;
      // Capture this offer's own fixed-size delta object: a synchronous
      // callback that performs a nested write reassigns the shared
      // pendingDeltas, and must never replace or dilute this offer's deltas.
      const offeredDeltas = pendingDeltas;
      let settled = false;
      return {
        commit() {
          if (settled || unknown) return;
          settled = true;
          bump('writeCalls');
          for (const field of CENSUS_MODE_COUNT_FIELDS) {
            if (unknown) return;
            if (offeredDeltas[field] !== 0) bump(field, offeredDeltas[field]);
          }
        },
        discard() {
          settled = true; // the pre-captured offer is invalidated; nothing commits
        },
      };
    },
    markUnknown,
    /**
     * Observing an outstanding partial parser sequence (state 1/2/3: after
     * ESC, after the CSI intro, or mid DEC parameter list) latches sticky
     * unknown and drops the retained carry: the incomplete prefix can never
     * be completed after the observation, so no later suffix may borrow
     * known counts. Supported split sequences that fully complete before
     * the snapshot are counted normally; only bounded integer state is
     * returned, never raw data.
     */
    snapshot() {
      if (!unknown && state !== 0) markUnknown(); // outstanding partial sequence: sticky unknown
      const result = {};
      for (const field of CENSUS_COUNT_FIELDS) result[field] = counts[field];
      return { unknown, counts: result };
    },
  };
}

/**
 * Installs the observational census hook on the retained stream's write slot.
 * The original own/inherited property descriptor is preserved; restore() only
 * acts while the current slot still holds this exact owned hook and never
 * deletes or overwrites a foreign replacement (it returns false and leaves
 * the slot untouched). `options.streamIdentity` supplies the object that must
 * still be the process's stdout at snapshot time (default: () =>
 * process.stdout). A snapshot that observes hook replacement or stream
 * identity loss latches permanent census uncertainty: writes during the gap
 * were missed and can never be recovered, so reinstallation or reversion does
 * not restore completeness.
 */
function installStdoutWriteCensus(outputStream, census, options = {}) {
  if (!outputStream || typeof outputStream !== 'object') throw new TypeError('census hook requires a retained stream object');
  const ownDescriptor = Object.getOwnPropertyDescriptor(outputStream, 'write');
  const hadOwn = ownDescriptor !== undefined;
  const originalWrite = hadOwn ? ownDescriptor.value : outputStream.write;
  if (typeof originalWrite !== 'function') throw new TypeError('retained stream has no callable original write');

  let installed = false;
  const hook = function stdoutCensusHook(...args) {
    let offer = null;
    try {
      if (this === outputStream) offer = census.beginOffer(args[0], args[1]);
      else census.markUnknown(); // borrowed receiver: forward exactly, never count as Main stdout
    } catch {
      offer = null;
      census.markUnknown();
    }
    let result;
    try {
      result = Reflect.apply(originalWrite, this, args);
    } catch (error) {
      if (offer !== null) offer.discard(); // invalidate the pre-captured offer
      census.markUnknown(); // a failed original call invalidates the entire observation
      throw error; // identical original thrown error identity
    }
    if (offer !== null) offer.commit();
    return result;
  };

  Object.defineProperty(outputStream, 'write', { value: hook, writable: true, configurable: true, enumerable: false });
  installed = true;
  const streamIdentity = options.streamIdentity === undefined ? () => process.stdout : options.streamIdentity;

  return {
    snapshot() {
      const descriptor = Object.getOwnPropertyDescriptor(outputStream, 'write');
      const hookActive = installed && descriptor !== undefined && descriptor.value === hook;
      let sameOutputStream = false;
      try { sameOutputStream = streamIdentity() === outputStream; } catch { sameOutputStream = false; }
      if (!hookActive || !sameOutputStream) census.markUnknown(); // latch missed-write uncertainty permanently
      const base = census.snapshot();
      const observationComplete = !base.unknown && hookActive && sameOutputStream;
      const result = { hookActive, sameOutputStream, observationComplete };
      for (const field of CENSUS_COUNT_FIELDS) {
        result[field] = observationComplete ? base.counts[field] : null;
      }
      return result;
    },
    restore() {
      const descriptor = Object.getOwnPropertyDescriptor(outputStream, 'write');
      if (descriptor === undefined || descriptor.value !== hook) return false; // foreign slot: never touch
      installed = false;
      if (hadOwn) Object.defineProperty(outputStream, 'write', ownDescriptor);
      else delete outputStream.write;
      return true;
    },
  };
}

/** Strict request payload validation: exact key set, schema, bounded nonce pattern, positive PID. */
function isCensusRequestPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.length !== 3 || keys[0] !== 'expectedMainPid' || keys[1] !== 'nonce' || keys[2] !== 'schemaVersion') {
    return false;
  }
  if (payload.schemaVersion !== CENSUS_SCHEMA_VERSION) return false;
  if (typeof payload.nonce !== 'string' || !CENSUS_NONCE.test(payload.nonce)) return false;
  if (!Number.isSafeInteger(payload.expectedMainPid) || payload.expectedMainPid <= 1) return false;
  return true;
}

/**
 * Exact reply shape shared with the parent-side contract validator. The
 * producer's numeric stdout snapshot is spread verbatim; a nested
 * `activePane` group supplied by the independent transparent actual-owner
 * observer passes through unchanged, so the reply carries both the offered
 * mode counts and the bounded pane diagnosis under their own flags.
 */
function buildCensusReply(nonce, mainPidValue, snapshot) {
  return {
    schemaVersion: CENSUS_SCHEMA_VERSION,
    nonce,
    mainPid: mainPidValue,
    ...snapshot,
  };
}

/**
 * Bounded one-shot request/reply service for the fresh census snapshot. It
 * watches exactly one owned nonrecursive directory and serves ONLY the fixed
 * known child leaf `main-census-request.json`; every other watcher filename
 * (including nonce-shaped leaves) is ignored so a foreign request cannot
 * consume the single serve. It validates the original root AND ancestor
 * directory identities — rechecked after request reading, before reply
 * creation — and a bounded regular nonsymlink request through readonly
 * descriptor/BigInt type/size/identity checks, then writes exactly one
 * exclusive reply leaf bound to the payload nonce and the genuine Main PID.
 * Missing, malformed, oversized, replayed, wrong-PID, changed-root/ancestor,
 * or partially published requests are honest refusals: no reply is written.
 */
function createCensusReplyService(options) {
  if (!options || typeof options !== 'object') throw new TypeError('census reply service requires options');
  if (typeof options.root !== 'string' || options.root.length === 0) throw new TypeError('census reply service requires a root directory');
  if (typeof options.buildSnapshot !== 'function') throw new TypeError('census reply service requires buildSnapshot');
  const fs = options.fs;
  if (!fs || typeof fs !== 'object') throw new TypeError('census reply service requires an injected fs object');
  for (const name of ['lstatSync', 'openSync', 'fstatSync', 'readSync', 'closeSync', 'writeSync', 'watch']) {
    if (typeof fs[name] !== 'function') throw new TypeError(`census reply service fs.${name} is unavailable`);
  }
  const maxRequestBytes = options.maxRequestBytes === undefined ? DEFAULT_MAX_REQUEST_BYTES : options.maxRequestBytes;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new RangeError('census maxRequestBytes must be a positive safe integer');
  const mainPid = typeof options.mainPid === 'function' ? options.mainPid : () => options.mainPid;

  const root = options.root;
  let watcher;
  let started = false;
  let closed = false;
  let degraded = false;
  let servedNonce;
  let rootChain;

  /** Bounded directory-identity chain from the root to the filesystem top. */
  function captureChain() {
    const chain = [];
    let current = root;
    for (let depth = 0; depth < MAX_DIRECTORY_CHAIN_DEPTH; depth += 1) {
      const stats = fs.lstatSync(current, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
        throw new Error('census reply service root chain is not a real directory with a usable BigInt identity');
      }
      chain.push({ path: current, dev: stats.dev, ino: stats.ino });
      const parent = path.dirname(current);
      if (parent === current) break; // filesystem top
      current = parent;
    }
    return chain;
  }

  function chainUnchanged() {
    for (const entry of rootChain) {
      let stats;
      try { stats = fs.lstatSync(entry.path, { bigint: true }); } catch { return false; }
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== entry.dev || stats.ino !== entry.ino) {
        return false;
      }
    }
    return true;
  }

  /** Closes the exact owned watcher at most once (latched by undefined). */
  function releaseWatcher() {
    if (watcher === undefined) return;
    const current = watcher;
    watcher = undefined;
    try { current.close(); } catch { /* exact owned watcher */ }
  }

  function start() {
    if (started) throw new Error('census reply service is already started');
    started = true;
    rootChain = captureChain();
    try {
      watcher = fs.watch(root);
      watcher.on('change', onEvent);
      watcher.on('rename', onEvent);
      watcher.on('error', () => { degraded = true; releaseWatcher(); }); // permanent refusal, exact-once closure
    } catch (error) {
      releaseWatcher(); // a partially registered watcher is closed before the failure propagates
      throw error;
    }
  }

  function onEvent(_eventType, filename) {
    if (closed || degraded || servedNonce !== undefined) return;
    try {
      handleEvent(filename);
    } catch {
      // Any validation or IO failure is an honest refusal: no reply is written.
    }
  }

  function handleEvent(filename) {
    if (filename !== CENSUS_REQUEST_FILENAME) return; // fixed known leaf only; nonce-shaped strangers are ignored
    if (!chainUnchanged()) return; // changed root or ancestor: refusal
    const requestPath = path.join(root, CENSUS_REQUEST_FILENAME);
    let preStats;
    try {
      preStats = fs.lstatSync(requestPath, { bigint: true });
    } catch {
      return;
    }
    if (!preStats.isFile() || preStats.isSymbolicLink() || preStats.dev <= 0n || preStats.ino <= 0n
      || preStats.size > BigInt(maxRequestBytes)) {
      return;
    }
    let fd;
    try {
      fd = fs.openSync(requestPath, 'r');
    } catch {
      return;
    }
    try {
      const stats = fs.fstatSync(fd, { bigint: true });
      if (!stats.isFile() || stats.dev !== preStats.dev || stats.ino !== preStats.ino
        || stats.size > BigInt(maxRequestBytes)) {
        return; // replaced or grew after the pre-stat: refusal
      }
      const buffer = Buffer.alloc(Number(stats.size));
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (read === 0) break; // partial publication cannot authorize a snapshot
        offset += read;
      }
      if (offset !== buffer.length) return;
      // Post-read validation: the descriptor and the path leaf must still
      // present the exact identity and size observed at the descriptor stat,
      // and the root chain must be stable. Growth or replacement after the
      // initial fstat can leave a valid JSON prefix that is not the complete
      // file; it is refused.
      const afterRead = fs.fstatSync(fd, { bigint: true });
      const requestLeaf = fs.lstatSync(requestPath, { bigint: true });
      if (!afterRead.isFile() || afterRead.dev !== stats.dev || afterRead.ino !== stats.ino
        || afterRead.size !== stats.size
        || !requestLeaf.isFile() || requestLeaf.isSymbolicLink()
        || requestLeaf.dev !== stats.dev || requestLeaf.ino !== stats.ino
        || requestLeaf.size !== stats.size || !chainUnchanged()) return;
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }
      if (!isCensusRequestPayload(payload)) return;
      if (payload.expectedMainPid !== mainPid()) return; // wrong PID: refusal
      servedNonce = payload.nonce;
      writeReply(payload.nonce);
    } finally {
      try { fs.closeSync(fd); } catch { /* exact owned descriptor */ }
    }
  }

  function writeReply(nonce) {
    if (!chainUnchanged()) return; // root/ancestor stability after request reading
    // Build and serialize BEFORE opening the exclusive reply: a failed
    // snapshot build leaves no reply leaf behind.
    const payload = `${JSON.stringify(buildCensusReply(nonce, mainPid(), options.buildSnapshot()))}\n`;
    if (!chainUnchanged()) return; // rechecked after snapshot construction, right before the exclusive open
    const fd = fs.openSync(path.join(root, CENSUS_REPLY_FILENAME), 'wx', 0o600);
    try {
      fs.writeSync(fd, payload);
    } finally {
      try { fs.closeSync(fd); } catch { /* exact owned descriptor */ }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    releaseWatcher();
  }

  return { start, close, get servedNonce() { return servedNonce; } };
}

module.exports = {
  CENSUS_SCHEMA_VERSION,
  CENSUS_REQUEST_FILENAME,
  CENSUS_REPLY_FILENAME,
  CENSUS_KNOWN_MODES,
  CENSUS_COUNT_FIELDS,
  createStdoutModeCensus,
  installStdoutWriteCensus,
  createCensusReplyService,
  buildCensusReply,
  isCensusRequestPayload,
};
