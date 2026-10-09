'use strict';

/**
 * Test-only original-Main-origin native exchange guard for the fresh
 * native-child original-stdout census.
 *
 * The guard is armed EXACTLY ONCE, inside the fresh Main census snapshot pass,
 * when that pass first constructs a complete actual-owner native binding and
 * the whole pass scope is intact — before the Main reply is published. It
 * retains the private arm facts (actual owner id, current authenticated
 * native session id/epoch, original native PTY PID/incarnation, consumed
 * bootstrap tuple, expected private proof, original manager/sidebar/surface
 * identities, genuine Main self PID, public stdout geometry, readable focus)
 * in process memory only: no raw data, token, socket path, instance identity,
 * session id, or proof ever crosses the wire or reaches a log.
 *
 * While armed, the guard latches actual owner/binding/live/pane/geometry
 * disturbances reported by the transparent original hooks (list rows,
 * active-owner setter arguments, focus getter returns, and the public stdout
 * resize event). Every latch is STICKY: a change-then-revert, an identical
 * caption with a different owner id, or a reverted slot replacement never
 * repairs the guard. Legitimate normal metadata updates that keep the same
 * owner, current native binding, and scope remain valid. The guard does not
 * promise detection of arbitrary unobserved hostile memory modifications;
 * the supported ownership/update boundaries plus the fresh final
 * revalidation are the contract.
 *
 * At serve time (one fresh exclusive request through the fixed known root
 * leaves) the guard performs the fresh pure current-scope proof: genuine
 * Main self PID, unchanged geometry without an observed resize, the live
 * original PTY binding lookup (PID/incarnation/bootstrap tuple), and the
 * pane observer's revalidation of owner/focus/row/session/surface/module
 * identity. Only then does it serve ONE reply bound to the fresh request
 * nonce, the genuine Main self PID, the initial arm nonce, the armed original
 * native PID, the numeric originals, and the freshly recomputed private proof
 * (which must equal the retained expected proof). No rearm, reuse, partial
 * reply, or unknown-true is possible: a refused guard writes no reply leaf,
 * and the parent fails closed on its bounded wait.
 */

const { computeNativeCensusProof, isBoundedNonce } = require('./session-host-windows-native-stdout-census.cjs');

const GUARD_SCHEMA_VERSION = 1;
const GUARD_REQUEST_FILENAME = 'native-exchange-guard-request.json';
const GUARD_REPLY_FILENAME = 'native-exchange-guard-reply.json';
const NATIVE_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;
const FOCUS_VALUES = new Set(['main', 'sidebar', 'form', 'confirm']);
const MAX_ID_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 2048;
const MAX_NATIVE_SESSION_ID_BYTES = 256;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bounded, path-free, control-free native session id (mirrors the protocol bound). */
function isValidSessionIdValue(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_NATIVE_SESSION_ID_BYTES
    && !/[\\/]/.test(value)
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

/**
 * Strict guard request payload: exact key set, schema, two bounded nonces,
 * and positive PIDs. `nonce` binds the one-shot reply; `proofNonce` is the
 * initial arm nonce (the Main census nonce under which the expected private
 * proof was computed).
 */
function isNativeExchangeGuardRequestPayload(payload) {
  if (!isRecord(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.length !== 5 || keys[0] !== 'expectedMainPid' || keys[1] !== 'expectedOriginalNativePID'
    || keys[2] !== 'nonce' || keys[3] !== 'proofNonce' || keys[4] !== 'schemaVersion') {
    return false;
  }
  if (payload.schemaVersion !== GUARD_SCHEMA_VERSION) return false;
  if (!isBoundedNonce(payload.nonce)) return false;
  if (!isBoundedNonce(payload.proofNonce)) return false;
  if (!Number.isSafeInteger(payload.expectedMainPid) || payload.expectedMainPid <= 1) return false;
  if (!Number.isSafeInteger(payload.expectedOriginalNativePID) || payload.expectedOriginalNativePID <= 1) return false;
  return true;
}

/**
 * Creates the single-use original-Main-origin exchange guard. All options are
 * required functions so pure tests can drive every input:
 * - `mainPid()` — the genuine current process PID;
 * - `geometry()` — the public retained stdout geometry `{ columns, rows }`;
 * - `revalidate(armed)` — the fresh pure current actual-scope proof supplied
 *   by the pane observer (returns `{ sessionId, sessionEpoch }` or undefined);
 * - `bindingLookup(instanceId)` — the exact original PTY registry lookup
 *   (returns `{ pid, incarnation, bootstrap }` or undefined).
 */
function createNativeExchangeGuard(options = {}) {
  if (!isRecord(options)) throw new TypeError('native exchange guard requires options');
  const mainPidFn = typeof options.mainPid === 'function' ? options.mainPid : undefined;
  const geometryFn = typeof options.geometry === 'function' ? options.geometry : undefined;
  const revalidate = typeof options.revalidate === 'function' ? options.revalidate : undefined;
  const bindingLookup = typeof options.bindingLookup === 'function' ? options.bindingLookup : undefined;
  if (mainPidFn === undefined || geometryFn === undefined || revalidate === undefined || bindingLookup === undefined) {
    throw new TypeError('native exchange guard requires mainPid, geometry, revalidate, and bindingLookup');
  }

  let armed; // undefined until the single arm
  let armRefused = false; // sticky: an unsupported arm input never arms positive
  let invalid = false; // sticky disturbance latch
  let resizeObserved = false; // sticky public geometry disturbance
  let servedAttempted = false; // single-use serve latch

  function readMainPid() {
    try {
      const value = mainPidFn();
      return Number.isSafeInteger(value) && value > 1 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function readGeometry() {
    try {
      const value = geometryFn();
      if (!isRecord(value)) return undefined;
      if (!Number.isSafeInteger(value.columns) || value.columns < 1
        || !Number.isSafeInteger(value.rows) || value.rows < 1) {
        return undefined;
      }
      return { columns: value.columns, rows: value.rows };
    } catch {
      return undefined;
    }
  }

  /**
   * Arms the single guard from one complete fresh pane-snapshot pass. The
   * facts are copied privately; any unsupported input latches a permanent
   * arm refusal (never arms positive, never re-arms). Returns true only when
   * this call armed the guard.
   */
  function arm(nonce, facts) {
    if (armed !== undefined || armRefused || invalid) return false; // single-use, no rearm
    try {
      if (!isBoundedNonce(nonce)) throw new Error('arm nonce');
      if (!isRecord(facts)) throw new Error('facts');
      const ownerId = facts.ownerId;
      if (typeof ownerId !== 'string' || ownerId.length === 0) throw new Error('ownerId');
      const focus = facts.focus;
      if (!FOCUS_VALUES.has(focus)) throw new Error('focus');
      const row = facts.row;
      if (!isRecord(row) || row.id !== ownerId) throw new Error('row');
      if (row.hasLiveProcess !== true || row.lifecycle !== 'alive') throw new Error('row live');
      const session = row.nativeSession;
      if (!isRecord(session)) throw new Error('nativeSession');
      const sessionId = session.sessionId;
      if (!isValidSessionIdValue(sessionId)) throw new Error('sessionId');
      const sessionEpoch = session.epoch;
      if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 1) throw new Error('sessionEpoch');
      const binding = facts.binding;
      if (!isRecord(binding) || binding.scope !== true || binding.complete !== true) throw new Error('binding');
      const nativePid = binding.ptyPid;
      if (!Number.isSafeInteger(nativePid) || nativePid <= 1) throw new Error('nativePid');
      const incarnation = binding.incarnation;
      if (!Number.isSafeInteger(incarnation) || incarnation < 1) throw new Error('incarnation');
      if (binding.sessionEpoch !== sessionEpoch) throw new Error('epoch coherence');
      const expectedProof = binding.expectedProof;
      if (typeof expectedProof !== 'string' || !NATIVE_PROOF_PATTERN.test(expectedProof)) throw new Error('expectedProof');
      const bootstrap = facts.bootstrap;
      // Mirror the shared proof helper's exact tuple bounds: an unsupported
      // tuple never arms positive (it could never recompute the proof).
      if (!isRecord(bootstrap) || bootstrap.version !== GUARD_SCHEMA_VERSION) throw new Error('bootstrap version');
      const socketPath = bootstrap.socketPath;
      if (typeof socketPath !== 'string' || socketPath.length < 1 || socketPath.length > MAX_SOCKET_PATH_LENGTH
        || socketPath.includes('\u0000')) {
        throw new Error('bootstrap socketPath');
      }
      const token = bootstrap.token;
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new Error('bootstrap token');
      for (const field of ['instanceId', 'generation']) {
        const id = bootstrap[field];
        if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) {
          throw new Error(`bootstrap ${field}`);
        }
      }
      const manager = facts.manager;
      const sidebar = facts.sidebar;
      const surface = facts.surface;
      if (!isRecord(manager)) throw new Error('manager');
      if (!isRecord(sidebar)) throw new Error('sidebar');
      if (!isRecord(surface)) throw new Error('surface');
      const selfPid = readMainPid();
      if (selfPid === undefined) throw new Error('self pid');
      const geometry = readGeometry();
      if (geometry === undefined) throw new Error('geometry');
      armed = {
        nonce,
        ownerId,
        focus,
        sessionId,
        sessionEpoch,
        nativePid,
        incarnation,
        expectedProof,
        bootstrap: {
          version: bootstrap.version,
          socketPath: bootstrap.socketPath,
          token: bootstrap.token,
          instanceId: bootstrap.instanceId,
          generation: bootstrap.generation,
        },
        manager,
        sidebar,
        surface,
        selfPid,
        columns: geometry.columns,
        rows: geometry.rows,
      };
      return true;
    } catch {
      armRefused = true; // unsupported input never arms positive and never re-arms
      return false;
    }
  }

  /**
   * Observes one returned original list() row set. The armed owner must match
   * exactly one live, alive row carrying the identical current native session
   * tuple; any other shape (absent, duplicate, changed, not live) is a sticky
   * disturbance. Never throws.
   */
  function onList(rows) {
    if (armed === undefined || invalid) return;
    try {
      if (!Array.isArray(rows)) throw new Error('rows');
      let match;
      let matches = 0;
      for (const view of rows) {
        if (view !== null && typeof view === 'object' && view.id === armed.ownerId) {
          match = view;
          matches += 1;
        }
      }
      if (matches !== 1) throw new Error('owner row');
      if (match.hasLiveProcess !== true || match.lifecycle !== 'alive') throw new Error('row live');
      const session = match.nativeSession;
      if (!isRecord(session)) throw new Error('nativeSession');
      if (!isValidSessionIdValue(session.sessionId) || session.sessionId !== armed.sessionId) throw new Error('sessionId');
      if (!Number.isSafeInteger(session.epoch) || session.epoch !== armed.sessionEpoch) throw new Error('sessionEpoch');
    } catch {
      invalid = true; // sticky: a reverted disturbance never repairs the guard
    }
  }

  /** Observes one original setActiveMainOwner argument. Any other owner (including cleared) is sticky. */
  function onOwner(ownerId) {
    if (armed === undefined || invalid) return;
    try {
      if (ownerId !== armed.ownerId) invalid = true;
    } catch {
      invalid = true;
    }
  }

  /** Observes one original focus getter return on the exact receiver. Any other focus or a foreign receiver is sticky. */
  function onFocus(focusValue, receiver) {
    if (armed === undefined || invalid) return;
    try {
      if (receiver !== armed.sidebar || focusValue !== armed.focus) invalid = true;
    } catch {
      invalid = true;
    }
  }

  /** Passive public stdout resize observation: sticky while armed. */
  function observeResize() {
    if (armed !== undefined) resizeObserved = true;
  }

  /**
   * The fresh pure current-scope proof at serve time. Returns true at most
   * once: the request must bind the initial arm nonce and the armed original
   * native PID, the genuine Main self PID and geometry must be unchanged,
   * the live original PTY binding must still present the identical
   * PID/incarnation/bootstrap tuple, and the pane observer's revalidation
   * must return the identical current session tuple. The freshly recomputed
   * private proof must equal the retained expected proof. Any failure is an
   * honest refusal (no reply) and never consumes a later valid request
   * except through the latches above.
   */
  function willServe(payload) {
    if (armed === undefined || armRefused || invalid || resizeObserved || servedAttempted) return false;
    try {
      if (!isNativeExchangeGuardRequestPayload(payload)) return false;
      if (payload.proofNonce !== armed.nonce) return false; // root-arm correlation
      if (payload.expectedOriginalNativePID !== armed.nativePid) return false;
      const selfPid = readMainPid();
      if (selfPid !== armed.selfPid) return false; // genuine original Main self PID
      if (payload.expectedMainPid !== selfPid) return false; // wrong Main PID: honest refusal, never consumes the serve
      const geometry = readGeometry();
      if (geometry === undefined || geometry.columns !== armed.columns || geometry.rows !== armed.rows) {
        return false; // public geometry disturbance
      }
      const currentBinding = bindingLookup(armed.bootstrap.instanceId);
      if (currentBinding === undefined || !isRecord(currentBinding)) return false; // exited/changed/unknown handle
      if (currentBinding.pid !== armed.nativePid || currentBinding.incarnation !== armed.incarnation) return false;
      const bootstrap = currentBinding.bootstrap;
      if (!isRecord(bootstrap)) return false;
      for (const field of ['version', 'socketPath', 'token', 'instanceId', 'generation']) {
        if (bootstrap[field] !== armed.bootstrap[field]) return false; // consumed tuple must be identical
      }
      const current = revalidate(armed); // fresh pure current actual scope proof
      if (!isRecord(current)) return false;
      if (current.sessionId !== armed.sessionId || current.sessionEpoch !== armed.sessionEpoch) return false;
      const proof = computeNativeCensusProof({
        bootstrap: armed.bootstrap,
        sessionId: current.sessionId,
        sessionEpoch: current.sessionEpoch,
        nonce: armed.nonce,
        pid: armed.nativePid,
      });
      if (proof === undefined || proof !== armed.expectedProof) return false; // private self-consistency
      servedAttempted = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Builds the exact one-shot guard reply (only after willServe passed for this request). */
  function buildGuardReply(nonce, mainPidValue) {
    if (armed === undefined) throw new Error('the exchange guard is not armed');
    const proof = computeNativeCensusProof({
      bootstrap: armed.bootstrap,
      sessionId: armed.sessionId,
      sessionEpoch: armed.sessionEpoch,
      nonce: armed.nonce,
      pid: armed.nativePid,
    });
    return {
      schemaVersion: GUARD_SCHEMA_VERSION,
      nonce,
      mainPid: mainPidValue,
      proofNonce: armed.nonce,
      expectedOriginalNativePID: armed.nativePid,
      incarnation: armed.incarnation,
      sessionEpoch: armed.sessionEpoch,
      proof: proof === undefined ? null : proof,
    };
  }

  return {
    arm,
    onList,
    onOwner,
    onFocus,
    observeResize,
    willServe,
    buildGuardReply,
    get armed() { return armed !== undefined; },
    get invalid() { return armRefused || invalid; },
  };
}

module.exports = {
  GUARD_SCHEMA_VERSION,
  GUARD_REQUEST_FILENAME,
  GUARD_REPLY_FILENAME,
  isNativeExchangeGuardRequestPayload,
  createNativeExchangeGuard,
};
