'use strict';

/**
 * Test-only pure helpers for the fresh native-child original-stdout census:
 * the strict request/reply payload contracts, and the fresh private proof.
 *
 * The proof is a SHA256 HMAC keyed by the ORIGINAL bootstrap token over an
 * unambiguous bounded tuple (bootstrap version/socketPath/instanceId/generation
 * plus the current authenticated native sessionId/sessionEpoch, the fresh
 * request nonce, and the retained self PID). The native child computes it from
 * its CONSUMED sticky bootstrap and current sticky session id/epoch; Main
 * computes the expected value from the OFFERED per-child bootstrap tuple and
 * the actual owner row binding. Neither side ever journals, logs, or formats
 * the token, socket path, instance identity, or raw tuple: only the opaque
 * 64-hex digest crosses the wire. The original Main PTY incarnation is NOT
 * part of the proof; the parent cross-binds originalPID => incarnation from
 * its own pending=>positive ledger independently.
 *
 * Field validation mirrors the repo protocol bounds (protocol.ts): version 1,
 * bounded NUL-free socket path, hex64 token, UUID-like ids <=128 chars, and
 * the bounded path-free control-free native session id. These re-checks are
 * defense in depth: both sides already validated their tuple with the
 * compiled repo parseBootstrap before it reaches the proof.
 */

const crypto = require('node:crypto');

const NATIVE_CENSUS_SCHEMA_VERSION = 1;
const NATIVE_CENSUS_REQUEST_FILENAME = 'native-census-request.json';
const NATIVE_CENSUS_REPLY_FILENAME = 'native-census-reply.json';
const NATIVE_CENSUS_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const NATIVE_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const ID_PATTERN = /^[0-9a-f-]*[0-9a-f][0-9a-f-]*$/i;
const MAX_ID_LENGTH = 128;
const MAX_SOCKET_PATH_LENGTH = 2048;
const MAX_NATIVE_SESSION_ID_BYTES = 256;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidIdValue(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

function isValidTokenValue(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** Bounded NUL-free socket path; the full grammar is enforced by parseBootstrap upstream. */
function isValidSocketPathValue(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_SOCKET_PATH_LENGTH
    && !value.includes('\u0000');
}

/** Mirrors protocol.isValidNativeSessionId: bounded, path-free, control-free. */
function isValidNativeSessionIdValue(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_NATIVE_SESSION_ID_BYTES
    && !/[\\/]/.test(value)
    && !/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(value);
}

function isBoundedNonce(value) {
  return typeof value === 'string' && NATIVE_CENSUS_NONCE.test(value);
}

function isNativeProof(value) {
  return typeof value === 'string' && NATIVE_PROOF_PATTERN.test(value);
}

/**
 * Strict native request payload: exact key set, schema, two bounded nonces,
 * positive PID. `nonce` binds the one-shot reply; `proofNonce` is the Main
 * census nonce under which Main computed the expected private proof, so both
 * sides HMAC the identical fresh tuple (the reply-bound nonce stays separate
 * for replay protection).
 */
function isNativeCensusRequestPayload(payload) {
  if (!isRecord(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.length !== 4 || keys[0] !== 'expectedNativePid' || keys[1] !== 'nonce'
    || keys[2] !== 'proofNonce' || keys[3] !== 'schemaVersion') {
    return false;
  }
  if (payload.schemaVersion !== NATIVE_CENSUS_SCHEMA_VERSION) return false;
  if (!isBoundedNonce(payload.nonce)) return false;
  if (!isBoundedNonce(payload.proofNonce)) return false;
  if (!Number.isSafeInteger(payload.expectedNativePid) || payload.expectedNativePid <= 1) return false;
  return true;
}

/** Exact native reply shape shared with the parent-side contract validator. */
function buildNativeCensusReply(nonce, nativePidValue, snapshot) {
  return {
    schemaVersion: NATIVE_CENSUS_SCHEMA_VERSION,
    nonce,
    nativePid: nativePidValue,
    ...snapshot,
  };
}

/**
 * Fresh private proof: SHA256 HMAC keyed by the bootstrap token over the
 * unambiguous bounded tuple. Returns 64 lowercase hex, or undefined for any
 * unsupported input (never throws, never logs the key or tuple). The fixed
 * JSON array order makes the encoding unambiguous for every validated field.
 */
function computeNativeCensusProof(fields) {
  if (!isRecord(fields)) return undefined;
  const bootstrap = fields.bootstrap;
  if (!isRecord(bootstrap)) return undefined;
  if (bootstrap.version !== NATIVE_CENSUS_SCHEMA_VERSION) return undefined;
  if (!isValidSocketPathValue(bootstrap.socketPath)) return undefined;
  if (!isValidTokenValue(bootstrap.token)) return undefined;
  if (!isValidIdValue(bootstrap.instanceId) || !isValidIdValue(bootstrap.generation)) return undefined;
  const sessionId = fields.sessionId;
  if (!isValidNativeSessionIdValue(sessionId)) return undefined;
  const sessionEpoch = fields.sessionEpoch;
  if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 1) return undefined;
  const nonce = fields.nonce;
  if (!isBoundedNonce(nonce)) return undefined;
  const pid = fields.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const message = JSON.stringify([
    bootstrap.version,
    bootstrap.socketPath,
    bootstrap.instanceId,
    bootstrap.generation,
    sessionId,
    sessionEpoch,
    nonce,
    pid,
  ]);
  return crypto.createHmac('sha256', Buffer.from(bootstrap.token, 'utf8'))
    .update(message, 'utf8')
    .digest('hex');
}

module.exports = {
  NATIVE_CENSUS_SCHEMA_VERSION,
  NATIVE_CENSUS_REQUEST_FILENAME,
  NATIVE_CENSUS_REPLY_FILENAME,
  isNativeCensusRequestPayload,
  buildNativeCensusReply,
  computeNativeCensusProof,
  isNativeProof,
  isBoundedNonce,
  isValidNativeSessionIdValue,
};
