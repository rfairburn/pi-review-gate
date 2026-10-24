'use strict';

/**
 * Test-only controlled console-attachment probe for trusted Windows PowerShell
 * helpers (Refs #494). Diagnosis only: it never changes production code paths,
 * retries, raises a deadline, or decides acceptance.
 *
 * One fixed matrix of synchronous children is run with the production helper
 * deadline (10 s) and stdio shape (`['ignore', 'pipe', 'ignore']`), from either
 * the caller's own process (`direct`) or from inside an owned public outer
 * ConPTY (`conpty`, when this file runs as the ConPTY child). The variants
 * separate three candidate differentials one axis at a time:
 *
 * - console attachment, through public Node spawn options and their libuv
 *   mapping on Windows (`detached` is documented for `spawn` only; its
 *   `spawnSync` effect is an implementation fact of Node's spawn_sync.cc that
 *   this probe measures rather than assumes):
 *     `hidden`   windowsHide:true with no inherited stdio — libuv adds
 *                CREATE_NO_WINDOW: a fresh windowless console (the current
 *                production flags of every trusted PowerShell helper);
 *     `shared`   windowsHide:false — no console flag: the child attaches to
 *                the parent's console (inside the probe: the owned ConPTY);
 *     `detached` detached:true + windowsHide:true — libuv adds
 *                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP (no console at
 *                all; CREATE_NO_WINDOW is ignored with DETACHED_PROCESS) and
 *                skips its kill-on-parent-exit job assignment;
 * - command: the exact production cmdlet owner query (`Get-Process`, which
 *   needs PowerShell command discovery and module auto-loading), the same
 *   query through .NET only (no cmdlet), and the harness readiness command;
 * - environment: the exact minimal harness environment versus the same plus
 *   fixed system/profile variables (profile folders pointed at owned dirs).
 *
 * Only fixed vocabulary leaves this module: variant id, outcome class,
 * duration, integer exit status, fixed signal/errno classes, an output-shape
 * match boolean, and whether the child pid is gone after the synchronous call
 * returned. Never argv, paths, environment values, or output.
 */

const PROBE_SCHEMA_VERSION = 1;
/** The production synchronous Windows owner-query cap (roster-store / managed-generations). */
const PROBE_CHILD_CAP_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 4096;
const PROBE_CONTEXTS = Object.freeze(['direct', 'conpty']);
const PROBE_CONSOLES = Object.freeze(['hidden', 'shared', 'detached']);
const PROBE_OUTCOMES = Object.freeze(['ok', 'timeout', 'spawn-error', 'exit-nonzero', 'signal', 'output-mismatch']);
const PROBE_SIGNALS = Object.freeze(['SIGKILL', 'SIGTERM', 'other']);
const PROBE_CODES = Object.freeze(['ETIMEDOUT', 'ENOENT', 'ENOBUFS', 'EPERM', 'EACCES', 'EINVAL', 'other']);

/**
 * The exact production `win32:` owner query, as the same three literal pieces
 * that `src/session-host/roster-store.ts` and `scripts/managed-generations.cjs`
 * concatenate (a portable regression pins the parity).
 */
const PRODUCTION_OWNER_QUERY_PIECES = Object.freeze([
  "& { param([int]$OwnerPid) try { $p = Get-Process -Id $OwnerPid -ErrorAction Stop; ",
  "[Console]::Out.Write('win32:' + $p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)) } ",
  'catch { exit 2 } }',
]);
const PRODUCTION_OWNER_QUERY = PRODUCTION_OWNER_QUERY_PIECES.join('');
/** The same single-pid query through .NET only: no cmdlet discovery or module auto-load. */
const DOTNET_OWNER_QUERY = "& { param([int]$OwnerPid) try { $p = [System.Diagnostics.Process]::GetProcessById($OwnerPid); "
  + "[Console]::Out.Write('win32:' + $p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)) } "
  + 'catch { exit 2 } }';
/** The harness readiness command (`probeWindowsPowerShell`). */
const VERSION_QUERY = '$PSVersionTable.PSVersion.ToString()';
const POWERSHELL_PREFIX = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);

/** The fixed matrix; ids are the only variant names that ever leave this module. */
const PROBE_VARIANTS = Object.freeze([
  Object.freeze({ id: 'node-version/hidden/harness', program: 'node', command: 'node-version', console: 'hidden', env: 'harness' }),
  Object.freeze({ id: 'ps-version/hidden/harness', program: 'powershell', command: 'ps-version', console: 'hidden', env: 'harness' }),
  Object.freeze({ id: 'ps-cmdlet/hidden/harness', program: 'powershell', command: 'cmdlet', console: 'hidden', env: 'harness' }),
  Object.freeze({ id: 'ps-cmdlet/shared/harness', program: 'powershell', command: 'cmdlet', console: 'shared', env: 'harness' }),
  Object.freeze({ id: 'ps-cmdlet/detached/harness', program: 'powershell', command: 'cmdlet', console: 'detached', env: 'harness' }),
  Object.freeze({ id: 'ps-dotnet/hidden/harness', program: 'powershell', command: 'dotnet', console: 'hidden', env: 'harness' }),
  Object.freeze({ id: 'ps-cmdlet/hidden/profile', program: 'powershell', command: 'cmdlet', console: 'hidden', env: 'profile' }),
]);
const PROBE_VARIANT_IDS = Object.freeze(PROBE_VARIANTS.map((variant) => variant.id));

/** Fixed system/profile variable names the `profile` environment adds (values never leave the caller). */
const PROFILE_SYSTEM_NAMES = Object.freeze([
  'PSModulePath', 'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC', 'PATHEXT', 'ComSpec',
  'SystemDrive', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
]);

function argsFor(variant, pid) {
  if (variant.command === 'node-version') return ['--version'];
  if (variant.command === 'ps-version') return [...POWERSHELL_PREFIX, VERSION_QUERY];
  const script = variant.command === 'cmdlet' ? PRODUCTION_OWNER_QUERY : DOTNET_OWNER_QUERY;
  return [...POWERSHELL_PREFIX, script, String(pid)];
}

/** The exact public Node spawnSync options for one variant. */
function spawnOptionsFor(variant, env) {
  const options = {
    encoding: 'utf8',
    timeout: PROBE_CHILD_CAP_MS,
    maxBuffer: PROBE_MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: variant.console !== 'shared',
    env,
  };
  if (variant.console === 'detached') options.detached = true;
  return options;
}

function expectedOutput(variant, stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (variant.command === 'node-version') return /^v\d+\.\d+\.\d+\s*$/u.test(text);
  if (variant.command === 'ps-version') return /^5\.1\.[0-9.]+\s*$/u.test(text);
  return /^win32:.{4,}$/u.test(text.trim());
}

function classifySignal(signal) {
  if (signal === null || signal === undefined) return null;
  return PROBE_SIGNALS.includes(signal) ? signal : 'other';
}

function classifyCode(error) {
  if (!error) return null;
  const code = error.code;
  return PROBE_CODES.includes(code) ? code : 'other';
}

function boundedStatus(value) {
  return Number.isSafeInteger(value) && value >= -(2 ** 31) && value <= 2 ** 32 ? value : null;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * Runs the fixed matrix strictly in order; every child is awaited synchronously
 * before the next one starts. Never throws for a child failure.
 *
 * @param {{
 *   context: 'direct' | 'conpty',
 *   powershell: string,
 *   node: string,
 *   envs: { harness: Record<string, string>, profile: Record<string, string> },
 *   pid?: number,
 *   spawnSync?: typeof import('node:child_process').spawnSync,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 * }} options
 */
function runConsoleProbe(options) {
  const spawnSync = options.spawnSync || require('node:child_process').spawnSync;
  const isAlive = options.isAlive || defaultIsAlive;
  const now = options.now || (() => Number(process.hrtime.bigint() / 1000000n));
  const pid = Number.isSafeInteger(options.pid) ? options.pid : process.pid;
  const records = [];
  for (const variant of PROBE_VARIANTS) {
    const file = variant.program === 'node' ? options.node : options.powershell;
    const env = options.envs[variant.env];
    const started = now();
    let result;
    let thrown = false;
    try {
      result = spawnSync(file, argsFor(variant, pid), spawnOptionsFor(variant, env));
    } catch {
      thrown = true;
    }
    const durationMs = Math.max(0, Math.round(now() - started));
    const error = thrown ? { code: 'other' } : result && result.error;
    const status = thrown || !result ? null : boundedStatus(result.status);
    const signal = thrown || !result ? null : classifySignal(result.signal);
    const code = classifyCode(error);
    const outputMatched = !thrown && !!result && expectedOutput(variant, result.stdout);
    let outcome;
    if (code === 'ETIMEDOUT') outcome = 'timeout';
    else if (error) outcome = 'spawn-error';
    else if (signal !== null) outcome = 'signal';
    else if (status !== 0) outcome = 'exit-nonzero';
    else outcome = outputMatched ? 'ok' : 'output-mismatch';
    const childPid = !thrown && result && Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null;
    records.push({
      id: variant.id,
      outcome,
      durationMs,
      status,
      signal,
      code,
      outputMatched,
      childGone: childPid === null ? null : !isAlive(childPid),
    });
  }
  return { v: PROBE_SCHEMA_VERSION, context: options.context, capMs: PROBE_CHILD_CAP_MS, records };
}

const RECORD_KEYS = Object.freeze(['id', 'outcome', 'durationMs', 'status', 'signal', 'code', 'outputMatched', 'childGone']);

/** Strict validator for one probe result: the exact fixed vocabulary and ordered matrix, nothing more. */
function isConsoleProbeResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'capMs,context,records,v') return false;
  if (value.v !== PROBE_SCHEMA_VERSION || !PROBE_CONTEXTS.includes(value.context) || value.capMs !== PROBE_CHILD_CAP_MS) return false;
  if (!Array.isArray(value.records) || value.records.length !== PROBE_VARIANTS.length) return false;
  return value.records.every((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
    const recordKeys = Object.keys(record);
    if (recordKeys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => Object.hasOwn(record, key))) return false;
    return record.id === PROBE_VARIANT_IDS[index]
      && PROBE_OUTCOMES.includes(record.outcome)
      && Number.isSafeInteger(record.durationMs) && record.durationMs >= 0 && record.durationMs <= 10 * 60_000
      && (record.status === null || Number.isSafeInteger(record.status))
      && (record.signal === null || PROBE_SIGNALS.includes(record.signal))
      && (record.code === null || PROBE_CODES.includes(record.code))
      && typeof record.outputMatched === 'boolean'
      && (record.childGone === null || typeof record.childGone === 'boolean');
  });
}

/** One bounded fixed-vocabulary line per result, e.g. `conpty: ps-cmdlet/hidden/harness=timeout(10012ms) ...`. */
function formatConsoleProbe(result) {
  if (!isConsoleProbeResult(result)) return 'console-probe: invalid result';
  const parts = result.records.map((record) => {
    const extra = [];
    if (record.status !== null && record.status !== 0) extra.push(`status=${record.status}`);
    if (record.signal !== null) extra.push(`signal=${record.signal}`);
    if (record.code !== null) extra.push(`code=${record.code}`);
    if (record.childGone !== true) extra.push(`childGone=${record.childGone}`);
    return `${record.id}=${record.outcome}(${record.durationMs}ms${extra.length > 0 ? ` ${extra.join(' ')}` : ''})`;
  });
  return `console-probe ${result.context}: ${parts.join(' ')}`;
}

/** ConPTY child entry: fixed options/result leaves from the owning test; exactly-once result. */
function runAsConPtyChild() {
  const fs = require('node:fs');
  const optionsPath = process.env.PRG_SESSION_HOST_WINDOWS_CONSOLE_PROBE_OPTIONS;
  const resultPath = process.env.PRG_SESSION_HOST_WINDOWS_CONSOLE_PROBE_RESULT;
  if (!optionsPath || !resultPath) {
    process.exitCode = 2;
    return;
  }
  const stats = fs.lstatSync(optionsPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    process.exitCode = 2;
    return;
  }
  const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  const result = runConsoleProbe({
    context: 'conpty',
    powershell: options.powershell,
    node: process.execPath,
    envs: options.envs,
  });
  fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  process.exitCode = 0;
}

if (require.main === module) {
  try {
    runAsConPtyChild();
  } catch {
    // A missing result is a bounded test failure, never a fabricated outcome.
    process.exitCode = 1;
  }
}

module.exports = {
  DOTNET_OWNER_QUERY,
  PRODUCTION_OWNER_QUERY,
  PRODUCTION_OWNER_QUERY_PIECES,
  PROBE_CHILD_CAP_MS,
  PROBE_CODES,
  PROBE_CONSOLES,
  PROBE_CONTEXTS,
  PROBE_OUTCOMES,
  PROBE_SCHEMA_VERSION,
  PROBE_SIGNALS,
  PROBE_VARIANTS,
  PROBE_VARIANT_IDS,
  PROFILE_SYSTEM_NAMES,
  VERSION_QUERY,
  argsFor,
  formatConsoleProbe,
  isConsoleProbeResult,
  runConsoleProbe,
  spawnOptionsFor,
};
