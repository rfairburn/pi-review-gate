'use strict';

/**
 * Observation-only native extension fixture for the real Main PTY test.
 * It records only public Pi lifecycle context and this owned process's public
 * terminal dimensions; it never selects a model, starts a turn, or calls a tool.
 */
const fs = require('node:fs');
const { types } = require('node:util');

/**
 * Reads an OWN DATA property value without invoking any accessor or proxy
 * trap. A proxy target, an absent property, and an accessor (or otherwise
 * value-less) descriptor all read as undefined: no getter, setter, trap, or
 * prototype lookup can run through this path.
 */
function ownDataValue(target, key) {
  try {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
    if (types === null || typeof types !== 'object' || types.isProxy(target)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Retains, ONCE at fixture evaluation BEFORE any shutdown, the exact
 * already-loaded canonical census preload module's public
 * closeOwnedNativeCensus DATA function. `require.resolve` only names the exact
 * known leaf; exactly one keyed `require.cache` lookup follows and the cached
 * record's own-data canonical identity (`id` and `filename` equal to the
 * resolved leaf, `loaded === true`) must be established (never a scan, never a
 * `require()` evaluation, never a readdir), so an uncached, foreign, or
 * unloaded canonical preload stays inert instead of autoactivating a census at
 * shutdown.
 * Unsupported or foreign shapes — an absent cache entry, a non-object module
 * record, a record whose own-data `id`/`filename` do not name the resolved
 * leaf or whose own-data `loaded` flag is not true, a non-object, accessor,
 * or proxy `exports`, or an absent, non-callable, or callable-proxy close
 * slot — are inert unknown. The captured DATA function reference is the only
 * closure this observer may ever run: replacing the cache entry, the exports
 * object, the close slot, or the function after capture cannot redirect
 * shutdown closure to a foreign function, and no accessor, getter, or proxy
 * trap is invoked to find it.
 */
function captureOwnedNativeCensusClose() {
  try {
    const resolved = require.resolve('./session-host-windows-native-stdout-census-preload.cjs');
    if (typeof resolved !== 'string' || resolved.length === 0) return undefined;
    // The module registry is this module's built-in plain cache object; only
    // its exact keyed entry is consulted (an exact keyed lookup, never a scan).
    const cache = require.cache;
    if (cache === null || typeof cache !== 'object') return undefined;
    const cachedModule = ownDataValue(cache, resolved);
    if (cachedModule === null || typeof cachedModule !== 'object') return undefined;
    // Only a genuinely loaded canonical Node module record at this exact leaf
    // is supported: its own-data `id` AND `filename` must name the resolved
    // leaf and its own-data `loaded` flag must be true. A hand-inserted or
    // foreign record, a mismatched/replaced record, an accessor identity
    // field, or an unloaded record is inert unknown; no closer is retained.
    if (ownDataValue(cachedModule, 'id') !== resolved) return undefined;
    if (ownDataValue(cachedModule, 'filename') !== resolved) return undefined;
    if (ownDataValue(cachedModule, 'loaded') !== true) return undefined;
    const moduleExports = ownDataValue(cachedModule, 'exports');
    if (moduleExports === null || typeof moduleExports !== 'object') return undefined;
    const close = ownDataValue(moduleExports, 'closeOwnedNativeCensus');
    return typeof close === 'function' && !types.isProxy(close) ? close : undefined;
  } catch {
    return undefined; // resolution or lookup failure: inert unknown
  }
}

/** The exact already-loaded owner close retained before shutdown (or undefined). */
const ownedNativeCensusClose = captureOwnedNativeCensusClose();

function closeOwnedNativeCensusObservation() {
  try {
    // Only the exact already-captured owner closure may run; the cache is
    // never re-resolved or re-read at shutdown.
    if (typeof ownedNativeCensusClose === 'function') ownedNativeCensusClose();
  } catch {
    // A helper close observation failure must never change the real Pi process.
  }
}

const destination = process.env.PRG_SESSION_HOST_NATIVE_MAIN_OBSERVER_FILE;
if (!destination) throw new Error('session-host Main observer destination is missing');

let nativeSessionId;
let currentSessionManager;
let lastStoredName;

function contextFrom(args) {
  return args.find((value) => value && typeof value === 'object' && value.sessionManager);
}

function sessionIdFrom(context) {
  const manager = context && context.sessionManager;
  return manager && typeof manager.getSessionId === 'function'
    ? manager.getSessionId()
    : nativeSessionId;
}

function storedNameFrom(context) {
  const manager = context && context.sessionManager;
  if (!manager || typeof manager.getSessionName !== 'function') return undefined;
  try {
    const name = manager.getSessionName();
    return typeof name === 'string' && name.trim() ? name : undefined;
  } catch {
    return undefined;
  }
}

function displayNameFromStoredName(name) {
  const safe = Array.from(name.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')).slice(0, 256);
  return safe.join('').trim() || '(no messages)';
}

function observeStoredName() {
  const name = storedNameFrom({ sessionManager: currentSessionManager });
  if (!name || name === lastStoredName) return;
  lastStoredName = name;
  append('native_session_name', {
    sessionId: nativeSessionId,
    storedName: name,
    displayName: displayNameFromStoredName(name),
  });
}

const namePoller = setInterval(observeStoredName, 50);
namePoller.unref();

function append(type, fields = {}) {
  fs.appendFileSync(destination, `${JSON.stringify({
    type,
    pid: process.pid,
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionId: nativeSessionId,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    ...fields,
  })}\n`, 'utf8');
}

module.exports = (pi) => {
  pi.on('session_start', (...args) => {
    const context = contextFrom(args);
    nativeSessionId = sessionIdFrom(context);
    currentSessionManager = context?.sessionManager;
    lastStoredName = storedNameFrom(context);
    let activeTools;
    try { activeTools = pi.getActiveTools(); } catch { activeTools = undefined; }
    const storedName = lastStoredName;
    // These fixture-created sessions start empty. Never journal first-user
    // fallback text: the question/privacy case intentionally stores prompts.
    append('session_start', {
      contextCwd: typeof context?.cwd === 'string' ? context.cwd : undefined,
      sessionFile: context?.sessionManager && typeof context.sessionManager.getSessionFile === 'function'
        ? context.sessionManager.getSessionFile()
        : undefined,
      storedName,
      displayName: storedName ? displayNameFromStoredName(storedName) : '(no messages)',
      mode: context?.mode,
      tty: process.stdout.isTTY === true,
      activeTools: Array.isArray(activeTools) ? activeTools : undefined,
      credentialLikeEnvironmentNames: Object.keys(process.env)
        .filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name))
        .sort(),
    });
  });

  pi.on('session_shutdown', (event, ...args) => {
    // Genuine public shutdown: close ONLY this preload's exact owned native
    // census watcher, then keep the original journal action and return
    // behavior unchanged.
    closeOwnedNativeCensusObservation();
    observeStoredName();
    append('session_shutdown', {
      reason: typeof event?.reason === 'string' ? event.reason : undefined,
      contextSessionId: sessionIdFrom(contextFrom(args)),
    });
  });

  pi.on('agent_start', () => append('agent_start'));
  pi.on('agent_settled', () => append('agent_settled'));
  pi.on('tool_call', (event) => append('tool_call', {
    toolName: typeof event?.toolName === 'string' ? event.toolName : undefined,
  }));

  // The owned PTY resize itself is the evidence. This listener observes the
  // ordinary Node SIGWINCH notification and does not alter the terminal or
  // Pi's handlers.
  process.on('SIGWINCH', () => append('resize'));
};

module.exports.default = module.exports;
