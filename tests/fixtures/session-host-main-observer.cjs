'use strict';

/**
 * Observation-only native extension fixture for the real Main PTY test.
 * It records only public Pi lifecycle context and this owned process's public
 * terminal dimensions; it never selects a model, starts a turn, or calls a tool.
 */
const fs = require('node:fs');

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
