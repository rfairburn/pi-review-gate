'use strict';

/**
 * Test-only NODE_OPTIONS preload for the real native Pi child of the Windows
 * direct-Main acceptance lane. It installs a fresh numeric-only original-
 * stdout mode-request census on the child's retained process.stdout BEFORE
 * the SDK/TUI starts, upstream of Main's inner pane mode parsing, and serves
 * exactly one correlated request/reply through fixed exclusive leaves in a
 * per-PID directory under the staged fixture root.
 *
 * Inert-by-default opt-in (issue: native original-stdout census): activation
 * requires ALL of
 * - the exact non-executor runtime ceiling (PI_REVIEW_GATE_RUNTIME_ROLE is not
 *   "executor");
 * - an explicitly staged absolute fixture root directory
 *   (PRG_SESSION_HOST_NATIVE_CENSUS_ROOT);
 * - a valid CONSUMED sticky bootstrap, read through its own data descriptor
 *   on the exported repo StickyState symbol and validated with the compiled
 *   repo protocol parseBootstrap. The production bootstrap preload runs first
 *   (NODE_OPTIONS order: real bootstrap -> this test observer -> original
 *   user preloads), so by now the one-shot bootstrap env is consumed and the
 *   sticky state holds the exact tuple. This preload never calls prime again,
 *   never mints a bootstrap, and never writes the registry;
 * - the canonical compiled repo protocol/reporter entry leaves resolved from
 *   the staged candidate entry (no dynamic scanning).
 * Any absent/invalid/foreign/throwing/getter/shadowed state is inert: no hook,
 * no directory, no watcher, no throw. A standalone run (no bootstrap) or an
 * executor runtime therefore observes no behavioral change.
 *
 * Truth-of-scope rules:
 * - the original child public process.pid, retained process.stdout, and exact
 *   parsed bootstrap tuple are captured BEFORE the SDK/TUI starts; all
 *   subsequent disturbance is sticky unknown, never known absence or zero;
 * - the write hook reuses the exact Main census forwarder (identical
 *   receiver/arguments/callback/return/backpressure/throw semantics);
 * - ONE strict readonly sticky validator serves both activation and snapshot
 *   time. It reads the exported symbol through its own data descriptor and
 *   every supported field through its own data descriptor, refusing getters,
 *   setters, proxies, and shadowed properties WITHOUT invoking them. A fresh
 *   validated object carrying the IDENTICAL original consumed bootstrap tuple
 *   is valid (the reporter legitimately assigns fresh objects on
 *   activation/status/reload; object identity is never latched). A foreign
 *   tuple, a present-but-invalid nativeSessionId, an invalid strict bounded
 *   sessionEpoch/sequence, a changed role ceiling, or a changed module/
 *   property scope is binding scope unknown — present-but-invalid values are
 *   refused, never normalized;
 * - the current native session id is kept in private process memory only and
 *   is bound through the opaque proof; the reply carries the bounded numeric
 *   epoch and the proof, never the raw id;
 * - the fresh private proof is an HMAC-SHA256 over the bounded tuple keyed by
 *   the consumed bootstrap token, computed with the shared helper; the token,
 *   socket path, instance identity, raw session id, and raw tuple are kept in
 *   private process memory only and never journaled, logged, or formatted;
 * - the root/ancestor directory-identity chain is captured ONCE at activation
 *   (before any intervening work) and must be unchanged when the per-PID
 *   child directory is created and the channel starts;
 * - the per-PID directory is created exclusively (no recursive mkdir, no
 *   reuse, no unlink/truncate); exactly one event-driven fs.watch/channel is
 *   owned per child and closed exactly once: after the single served reply
 *   (success or terminal failed publication), on watcher error, on a genuine
 *   public session_shutdown (the observer fixture calls the exported
 *   closeOwnedNativeCensus for this module instance's immutable default-owned
 *   service), or on process exit as an exact-own defensive fallback. The
 *   defaults are claimed once by the module-bottom autoactivation, which
 *   privately retains the exact service close function; pure explicit-options
 *   factory activations never replace that ownership and carry their own
 *   narrow closure instead. Public shutdown never rereads the returned
 *   activation or its mutable service/close slots. The
 *   process-exit path
 *   is not assumed to cover every quit path, so a never-requested child is
 *   released on the public shutdown regardless of natural exit; no unref,
 *   polling, or force occurs.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const {
  createStdoutModeCensus,
  installStdoutWriteCensus,
  createCensusReplyService,
} = require('./session-host-windows-stdout-census.cjs');
const {
  NATIVE_CENSUS_SCHEMA_VERSION,
  NATIVE_CENSUS_REQUEST_FILENAME,
  NATIVE_CENSUS_REPLY_FILENAME,
  isNativeCensusRequestPayload,
  buildNativeCensusReply,
  computeNativeCensusProof,
} = require('./session-host-windows-native-stdout-census.cjs');

const ROOT_ENV = 'PRG_SESSION_HOST_NATIVE_CENSUS_ROOT';
const CANDIDATE_ENTRY_ENV = 'PI_REVIEW_GATE_CANDIDATE_ENTRY';
const ROLE_ENV = 'PI_REVIEW_GATE_RUNTIME_ROLE';
const MAX_DIRECTORY_CHAIN_DEPTH = 32;

/** Bounded directory-identity chain from the root to the filesystem top. */
function captureRootChain(root, fsLike) {
  const chain = [];
  let current = root;
  for (let depth = 0; depth < MAX_DIRECTORY_CHAIN_DEPTH; depth += 1) {
    let stats;
    try {
      stats = fsLike.lstatSync(current, { bigint: true });
    } catch {
      return undefined;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev <= 0n || stats.ino <= 0n) {
      return undefined;
    }
    chain.push({ path: current, dev: stats.dev, ino: stats.ino });
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem top
    current = parent;
  }
  return chain;
}

function rootChainUnchanged(chain, fsLike) {
  for (const entry of chain) {
    let stats;
    try {
      stats = fsLike.lstatSync(entry.path, { bigint: true });
    } catch {
      return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== entry.dev || stats.ino !== entry.ino) {
      return false;
    }
  }
  return true;
}

/**
 * Own DATA descriptor read that accepts non-null objects OR functions (the
 * genuine reporter module exports a callable), refuses proxies before any
 * descriptor operation, and returns undefined for accessors, absence, and
 * unreadable targets. No trap or accessor can run through this path, and the
 * target is never invoked.
 */
function ownDataDescriptor(target, key) {
  try {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function') || types.isProxy(target)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

/** Descriptor-scope equality: attributes (and optionally the value) must match. */
function sameDescriptorScope(current, original, compareValue = true) {
  return current !== undefined && original !== undefined
    && current.writable === original.writable
    && current.enumerable === original.enumerable
    && current.configurable === original.configurable
    && (!compareValue || current.value === original.value);
}

/**
 * Retains the initial supported descriptor scope of the global sticky slot,
 * the protocol validators, the reporter key, and the role env leaf, and
 * returns a recheck closure. A changed attribute, a replaced callable, a
 * proxy, or an executor role at any later check is a failed guard — never a
 * re-adopted scope.
 */
function captureStickyGuard(globalScope, stickyKey, protocol, reporter, env) {
  const globalDescriptor = ownDataDescriptor(globalScope, stickyKey);
  const references = [
    [protocol, 'parseBootstrap'],
    [protocol, 'isValidNativeSessionId'],
    [reporter, 'SESSION_HOST_STICKY_STATE_KEY'],
  ];
  const descriptors = references.map(([target, key]) => ownDataDescriptor(target, key));
  if (globalDescriptor === undefined || !globalDescriptor.writable || !globalDescriptor.configurable
    || descriptors.some((descriptor) => descriptor === undefined)
    || typeof descriptors[0].value !== 'function'
    || typeof descriptors[1].value !== 'function'
    || descriptors[2].value !== stickyKey) return undefined;
  let roleDescriptor;
  try {
    if (env === null || typeof env !== 'object' || types.isProxy(env)) return undefined;
    roleDescriptor = Object.getOwnPropertyDescriptor(env, ROLE_ENV);
    if (roleDescriptor !== undefined
      && (!Object.hasOwn(roleDescriptor, 'value') || roleDescriptor.value === 'executor')) return undefined;
  } catch {
    return undefined;
  }
  return () => {
    try {
      const role = Object.getOwnPropertyDescriptor(env, ROLE_ENV);
      return sameDescriptorScope(ownDataDescriptor(globalScope, stickyKey), globalDescriptor, false)
        && references.every(([target, key], index) =>
          sameDescriptorScope(ownDataDescriptor(target, key), descriptors[index]))
        && (roleDescriptor === undefined ? role === undefined : sameDescriptorScope(role, roleDescriptor));
    } catch {
      return false;
    }
  };
}

/**
 * The ONE strict readonly sticky validator, used for activation AND snapshot
 * time. Returns a bounded view `{ sessionEpoch, nativeSessionId, bootstrap }`
 * or undefined for any absent/getter/shadowed/foreign/invalid state. Every
 * read goes through own data descriptors without invoking accessors; proxies
 * are refused before descriptor operations; the bootstrap is parsed from a
 * plain copy assembled exclusively from supported own data descriptors (no
 * nested getter can run); and the retained descriptor scope (global slot,
 * protocol validators, reporter key, role env) must be unchanged. The raw
 * native session id stays in the returned object (private process memory) and
 * is never journaled, logged, or formatted. A fresh object with the identical
 * original consumed bootstrap tuple validates (field identity, not object
 * identity); a present-but-invalid nativeSessionId refuses the whole state.
 */
function validateStickyState(globalScope, stickyKey, protocol, reporter, originalBootstrap, env, retainedGuard) {
  const guard = retainedGuard === undefined
    ? captureStickyGuard(globalScope, stickyKey, protocol, reporter, env)
    : retainedGuard;
  if (guard === undefined || !guard()) return undefined;
  let descriptor;
  try {
    descriptor = ownDataDescriptor(globalScope, stickyKey);
  } catch {
    return undefined; // an unreadable own descriptor is refused, never assumed absent
  }
  if (descriptor === undefined) return undefined;
  const raw = descriptor.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || types.isProxy(raw)) return undefined;
  // Every supported field through its own data descriptor; accessors are
  // refused WITHOUT being invoked, and required fields must be present.
  const fields = {};
  for (const name of ['bootstrap', 'sequence', 'sessionEpoch', 'nativeSessionId']) {
    let fieldDescriptor;
    try {
      fieldDescriptor = ownDataDescriptor(raw, name);
    } catch {
      return undefined;
    }
    if (fieldDescriptor === undefined) {
      if (name === 'nativeSessionId'
        && Object.getOwnPropertyDescriptor(raw, name) === undefined) {
        fields[name] = undefined; // primed absence
        continue;
      }
      return undefined; // a required field is absent or an accessor: unknown
    }
    if (!fieldDescriptor.writable || !fieldDescriptor.enumerable || !fieldDescriptor.configurable) {
      return undefined; // non-standard data attributes are refused without invoking anything
    }
    fields[name] = fieldDescriptor.value;
  }
  let bootstrap;
  try {
    // Parse only a descriptor-derived plain bootstrap copy: no nested getter
    // or trap can run during validation.
    const bootstrapCopy = {};
    for (const name of ['version', 'socketPath', 'token', 'instanceId', 'generation']) {
      const field = ownDataDescriptor(fields.bootstrap, name);
      if (field === undefined || !field.writable || !field.enumerable || !field.configurable) return undefined;
      bootstrapCopy[name] = field.value;
    }
    bootstrap = protocol.parseBootstrap(bootstrapCopy);
  } catch {
    return undefined;
  }
  if (bootstrap === undefined) return undefined;
  if (originalBootstrap !== undefined) {
    for (const field of ['version', 'socketPath', 'token', 'instanceId', 'generation']) {
      if (bootstrap[field] !== originalBootstrap[field]) return undefined; // foreign tuple: unknown
    }
  }
  const sessionEpoch = fields.sessionEpoch;
  if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) return undefined; // strict, no reporter fallback
  const sequence = fields.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) return undefined;
  if (fields.nativeSessionId !== undefined) {
    let valid;
    try {
      valid = protocol.isValidNativeSessionId(fields.nativeSessionId);
    } catch {
      return undefined;
    }
    if (!valid) return undefined; // present-but-invalid: refused, never normalized
  }
  return { sessionEpoch, nativeSessionId: fields.nativeSessionId, bootstrap };
}

/**
 * This module instance's immutable default-owned census activation. It is
 * claimed exactly once by the module-bottom autoactivation (or, in a fresh
 * module loaded by a pure test, by the equivalent first no-argument call) and
 * is never replaced afterwards. Public shutdown closure targets ONLY this
 * activation, so a later inert or alternative factory activation can never
 * redirect it away from the original live watcher.
 */
let defaultOwnedActivation;
/** Exact privately retained close closure of the immutable default-owned service. */
let defaultOwnedServiceClose;

/**
 * Captures, at activation time, the exact own DATA close function of one
 * installed activation's service together with its exact service receiver.
 * The returned zero-argument closure never rereads the activation or service
 * object, so a later replacement of the returned activation's `service`
 * property or of the service's own `close` slot cannot redirect it to a
 * foreign function. Returns undefined for an inert activation or an
 * unsupported (absent, accessor, proxy, or non-callable) close slot.
 */
function retainOwnedServiceCloser(activation) {
  if (activation === null || typeof activation !== 'object' || activation.installed !== true) return undefined;
  const service = activation.service;
  if (service === null || typeof service !== 'object') return undefined;
  const close = ownDataDescriptor(service, 'close')?.value;
  if (typeof close !== 'function') return undefined;
  return function closeRetainedOwnedService() {
    return Reflect.apply(close, service, []);
  };
}

/**
 * Claims the immutable module-default ownership exactly once. The FIRST
 * no-argument autoactivation wins; a later call reuses it and can never
 * replace, lose, or rebound it. The exact owned closer is retained privately
 * BEFORE the activation is ever returned to a caller, so mutating the
 * returned activation or its service cannot redirect public shutdown.
 */
function claimDefaultOwnedActivation(activation) {
  if (defaultOwnedActivation !== undefined) return;
  defaultOwnedActivation = activation;
  defaultOwnedServiceClose = retainOwnedServiceCloser(activation);
}

/**
 * Narrow closure owned by ONE pure factory activation result. It closes only
 * that exact result's installed one-shot watcher: idempotent, never throws,
 * and never touches the module-default ownership or any other activation.
 * Like the default owner, it retains its exact service close function at
 * creation, so mutating the returned result cannot redirect it either.
 */
function makeFactoryOwnedCloser(activation) {
  const closeRetained = retainOwnedServiceCloser(activation);
  return function closeFactoryOwnedNativeCensus() {
    try {
      if (closeRetained === undefined) return false;
      closeRetained();
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Runs the pure native census activation.
 *
 * A no-argument call is the module-default autoactivation path: the FIRST
 * such call claims the immutable default-owned activation, and
 * closeOwnedNativeCensus always closes exactly that activation's privately
 * retained service close. A repeated no-argument call reuses it instead of
 * installing a second watcher, so duplicate helper activation cannot create
 * an unowned resource or steal ownership.
 *
 * An explicit-options call is the pure factory path used by tests: it never
 * replaces the module-default ownership, so a later inert or alternative
 * activation cannot redirect the public shutdown closure, and it returns its
 * own narrow `close` owned by that exact result.
 */
function activateNativeCensusPreload(options) {
  if (options === undefined) {
    if (defaultOwnedActivation === undefined) {
      claimDefaultOwnedActivation(runNativeCensusActivation({}));
    }
    return defaultOwnedActivation;
  }
  const activation = runNativeCensusActivation(options);
  return { ...activation, close: makeFactoryOwnedCloser(activation) };
}

/**
 * Activates the test-only native census. Pure dependency injection: every
 * ambient source (env, global scope, fs, stdout, pid, module loader, exit
 * hook) is overridable so pure tests drive it with fakes. Returns
 * `{ installed: false }` for every inert path and
 * `{ installed: true, service, censusHandle, directory }` when active. Never
 * throws.
 */
function runNativeCensusActivation(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  if (env[ROLE_ENV] === 'executor') return { installed: false }; // exact non-executor ceiling
  const root = env[ROOT_ENV];
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) return { installed: false };
  const fsLike = options.fs === undefined ? nodeFs : options.fs;
  let rootStats;
  try {
    rootStats = fsLike.lstatSync(root, { bigint: true });
  } catch {
    return { installed: false };
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return { installed: false };
  // The root/ancestor identity chain is retained BEFORE any intervening work
  // (module loading, mkdir) and must be unchanged when the channel starts.
  const rootChain = captureRootChain(root, fsLike);
  if (rootChain === undefined) return { installed: false };

  // Canonical compiled repo entry leaves from the staged candidate entry:
  // <packageRoot>/dist/src/index.js -> dist/src/session-host/{protocol,reporter}.js.
  const candidateEntry = env[CANDIDATE_ENTRY_ENV];
  if (typeof candidateEntry !== 'string' || candidateEntry.length === 0 || !path.isAbsolute(candidateEntry)) {
    return { installed: false };
  }
  const sessionHostDir = path.join(path.dirname(candidateEntry), 'session-host');
  const protocolPath = path.join(sessionHostDir, 'protocol.js');
  const reporterPath = path.join(sessionHostDir, 'reporter.js');
  for (const leaf of [protocolPath, reporterPath]) {
    let stats;
    try {
      stats = fsLike.lstatSync(leaf, { bigint: true });
    } catch {
      return { installed: false };
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return { installed: false };
  }
  const requireModule = options.requireModule === undefined ? (request) => require(request) : options.requireModule;
  let protocol;
  let reporter;
  try {
    protocol = requireModule(protocolPath);
    reporter = requireModule(reporterPath);
  } catch {
    return { installed: false };
  }
  const stickyKey = ownDataDescriptor(reporter, 'SESSION_HOST_STICKY_STATE_KEY')?.value;
  if (typeof stickyKey !== 'symbol') return { installed: false };

  // The consumed valid sticky bootstrap, read through the ONE strict readonly
  // validator under the retained descriptor scope. This exact tuple is
  // retained privately and is the only bootstrap this preload ever knows.
  const globalScope = options.globalScope === undefined ? globalThis : options.globalScope;
  const stickyGuard = captureStickyGuard(globalScope, stickyKey, protocol, reporter, env);
  if (stickyGuard === undefined) return { installed: false };
  const primed = validateStickyState(globalScope, stickyKey, protocol, reporter, undefined, env, stickyGuard);
  if (primed === undefined) return { installed: false };
  const originalBootstrap = primed.bootstrap;

  // Capture the original child public identity BEFORE the SDK/TUI starts.
  const selfPid = options.pid === undefined ? process.pid : options.pid;
  if (!Number.isSafeInteger(selfPid) || selfPid <= 1) return { installed: false };
  const outputStream = options.stdout === undefined ? process.stdout : options.stdout;
  let censusHandle;
  try {
    censusHandle = installStdoutWriteCensus(
      outputStream,
      createStdoutModeCensus(),
      { streamIdentity: options.stdoutIdentity === undefined ? () => process.stdout : options.stdoutIdentity },
    );
  } catch {
    return { installed: false }; // no callable original write: inert
  }

  // Exclusive per-PID child directory under the staged root: no recursive
  // mkdir, no reuse, no unlink/truncate. A pre-existing directory or a changed
  // root chain is refused.
  const directory = path.join(root, `native-${selfPid}`);
  if (!rootChainUnchanged(rootChain, fsLike)) {
    censusHandle.restore(); // exact owned hook only
    return { installed: false };
  }
  try {
    fsLike.mkdirSync(directory, { mode: 0o700 });
  } catch {
    censusHandle.restore(); // exact owned hook only
    return { installed: false };
  }

  let service;
  try {
    // The per-PID child directory itself is part of the retained chain: the
    // service watches and accesses it, so a replaced or symlinked child
    // directory must be detected by the native-side checks. No atomic
    // containment is claimed; the identity is simply retained and rechecked.
    const childStats = fsLike.lstatSync(directory, { bigint: true });
    if (!childStats.isDirectory() || childStats.isSymbolicLink()
      || childStats.dev <= 0n || childStats.ino <= 0n
      || !rootChainUnchanged(rootChain, fsLike)) {
      throw new Error('native census child directory admission failed');
    }
    const channelChain = [
      { path: directory, dev: childStats.dev, ino: childStats.ino },
      ...rootChain,
    ];
    service = createCensusReplyService({
      root: directory,
      mainPid: () => selfPid,
      requestFilename: NATIVE_CENSUS_REQUEST_FILENAME,
      replyFilename: NATIVE_CENSUS_REPLY_FILENAME,
      isRequestPayload: isNativeCensusRequestPayload,
      buildReply: buildNativeCensusReply,
      fs: fsLike,
      rootChain: channelChain,
      closeAfterServe: true, // exact single-reply closure; Main keeps its default
      buildSnapshot: (nonce, requestPayload) => {
        const base = censusHandle.snapshot();
        const current = validateStickyState(globalScope, stickyKey, protocol, reporter, originalBootstrap, env, stickyGuard);
        if (current === undefined) {
          // Disturbed/foreign current state: binding scope unknown. The count
          // fields stay independent of the metadata scope.
          return { ...base, bindingScope: false, sessionEpoch: null, proof: null };
        }
        let sessionEpoch = null;
        let proof = null;
        if (current.nativeSessionId !== undefined && current.sessionEpoch >= 1) {
          // The raw session id stays private: it is bound through the opaque
          // proof only. The proof is bound to the Main census nonce
          // (proofNonce), the same fresh nonce under which Main computed its
          // expected proof; the reply-bound `nonce` stays separate for replay
          // protection.
          const proofNonce = requestPayload !== null && typeof requestPayload === 'object'
            ? requestPayload.proofNonce
            : undefined;
          if (typeof proofNonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(proofNonce)) {
            sessionEpoch = current.sessionEpoch;
            proof = computeNativeCensusProof({
              bootstrap: originalBootstrap,
              sessionId: current.nativeSessionId,
              sessionEpoch,
              nonce: proofNonce,
              pid: selfPid,
            });
            if (proof === undefined) { sessionEpoch = null; } // fail closed
          }
        }
        return { ...base, bindingScope: true, sessionEpoch, proof };
      },
    });
    service.start();
  } catch {
    try { if (service !== undefined) service.close(); } catch { /* exact owned watcher only */ }
    try { censusHandle.restore(); } catch { /* exact owned hook only */ }
    return { installed: false };
  }

  const onExit = options.onExit === undefined ? (handler) => process.on('exit', handler) : options.onExit;
  try {
    // Retain the exact owned service closer BEFORE registering the exit
    // fallback, so process exit can never be redirected through a later
    // replacement of the service's mutable `close` slot.
    const closeOnExit = retainOwnedServiceCloser({ installed: true, service });
    if (closeOnExit === undefined) throw new Error('native census owned exit closer unavailable');
    onExit(() => { closeOnExit(); }); // exact retained owner, never a mutable close slot
  } catch {
    // A failed exit-registration leaves no authorized shutdown path for a
    // never-requested child: unwind the exact own resources and stay inert
    // rather than retaining the watcher.
    try { service.close(); } catch { /* exact owned watcher only */ }
    try { censusHandle.restore(); } catch { /* exact owned hook only */ }
    return { installed: false };
  }

  return { installed: true, service, censusHandle, directory };
}

/**
 * TESTONLY narrow closure for the exact native census service this module
 * instance's immutable module-default autoactivation owns. It closes ONLY
 * that original default-owned one-shot watcher: idempotent, never throws, and
 * never destroys streams, forces the native child, changes user data, or
 * mutates the sticky or owned-activity registries. A later factory, inert, or
 * duplicate helper activation, or mutation of the returned activation or its
 * service/close slots, can never redirect it: only the exact privately
 * retained default-owned service close may run. The public session_shutdown
 * observer fixture
 * calls it so a native child that never received its one-shot request cannot
 * retain the watcher on a natural shutdown; process-exit closure remains an
 * exact defensive fallback. Returns true when this instance's default owned
 * an installed service (whether or not it was already closed), false
 * otherwise. It deliberately never restores or replaces the observational
 * stdout hook, so a foreign replacement or the native VT write path is never
 * clobbered.
 */
function closeOwnedNativeCensus() {
  try {
    if (typeof defaultOwnedServiceClose !== 'function') return false;
    defaultOwnedServiceClose();
    return true;
  } catch {
    return false; // an observational close failure never alters the real native shutdown
  }
}

try {
  activateNativeCensusPreload();
} catch {
  // A preload observation failure must never change the real Pi process.
}

module.exports = {
  ROOT_ENV,
  CANDIDATE_ENTRY_ENV,
  ROLE_ENV,
  validateStickyState,
  captureRootChain,
  rootChainUnchanged,
  activateNativeCensusPreload,
  closeOwnedNativeCensus,
};
