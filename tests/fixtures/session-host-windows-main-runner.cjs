'use strict';

/**
 * Test-only real-Main runner hosted in the caller's public Windows ConPTY.
 * The public node-pty spawn is a strict forwarder: the exact pinned module,
 * original receiver/arguments, and returned IPty handles are preserved. Only
 * public spawn/onExit metadata is journaled; argv, env, credentials, and
 * terminal transcripts are never recorded. The shared exact observer fixture
 * owns that logic so the source-launcher acceptance lane reuses the identical
 * incarnation/force-proof semantics.
 *
 * A test-only numeric stdout mode-request census hooks the same retained
 * process.stdout after the baseline write and before Main starts: it counts
 * offered write calls and complete DECSET/DECRST requests for the fixed known
 * tracking/SGR/alternate/paste modes. It is a strict forwarder (exact original
 * receiver, arguments, callback identity, return, and thrown error) and serves
 * exactly one fresh request/reply through the fixed known child leaves in the
 * options file's fixture root. Diagnosis only: offered requests never prove
 * negotiated or delivered terminal state.
 *
 * The same single fresh reply carries an independent bounded active-pane group
 * produced by a transparent test-only observer on the original candidate
 * compiled `InstanceManager.prototype.list` and
 * `SidebarController.prototype.setActiveMainOwner` prototypes. It forwards
 * each original call exactly once with the exact receiver/arguments/return and
 * the identical thrown error, retains only successful receiver identities, and
 * reports an honest all-null unknown for any unsupported, replaced, ambiguous,
 * or throwing observation. It never derives an owner from selection or roster
 * order and never emits raw id, PID, path, label, frame, transcript, or
 * argument data.
 *
 * The same reply carries an independent bounded native-binding group: inside
 * the same fresh pane snapshot, a narrow TESTONLY callback resolves the exact
 * matched live owner row against the exact original PTY registry (the shared
 * observer retains each child's parsed offered bootstrap tuple privately in
 * memory, captured before the original spawn, never journaled) and computes
 * the expected fresh private proof with the shared helper. The raw bootstrap
 * tuple stays in private process memory; only the opaque 64-hex proof and the
 * bounded numeric/string binding fields cross the wire.
 *
 * A single original-Main-origin native exchange guard is armed exactly once,
 * inside that same fresh Main census snapshot pass, when the pass first
 * constructs a complete actual-owner native binding (before the reply is
 * published). It retains the private arm facts (actual owner id, current
 * authenticated native session tuple, original native PTY PID/incarnation,
 * consumed bootstrap tuple, expected private proof, original manager/sidebar/
 * surface identities, genuine Main self PID, public stdout geometry, readable
 * focus) in process memory only. While armed it latches actual disturbances
 * reported by the transparent original hooks (list rows, active-owner setter
 * arguments, focus getter returns) and passively observes the public stdout
 * resize event; every latch is sticky. At serve time it performs the fresh
 * pure current-scope proof and serves at most one fresh reply through the
 * fixed known root leaves (`native-exchange-guard-request.json` /
 * `native-exchange-guard-reply.json`) via the shared strict census reply
 * transport with exact-once closure after serve. The guard service and resize
 * listener are closed/removed exactly once in the runner finally on every
 * return/error path.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { observePtyModule } = require('./session-host-windows-pty-observer.cjs');
const {
  createCensusReplyService,
  createStdoutModeCensus,
  installStdoutWriteCensus,
} = require('./session-host-windows-stdout-census.cjs');
const {
  installPaneModeObserver,
} = require('./session-host-windows-pane-mode-observer.cjs');
const {
  computeNativeCensusProof,
  isValidNativeSessionIdValue,
} = require('./session-host-windows-native-stdout-census.cjs');
const {
  GUARD_REQUEST_FILENAME,
  GUARD_REPLY_FILENAME,
  createNativeExchangeGuard,
  isNativeExchangeGuardRequestPayload,
} = require('./session-host-windows-native-exchange-guard.cjs');

function installPtyObservation(mainEntry, expectedPtyModule, ptyJournal) {
  // Match production's exact lazy createRequire anchor in instances.js.
  const productionRequire = createRequire(path.join(path.dirname(mainEntry), 'instances.js'));
  const resolvedPtyModule = productionRequire.resolve('@lydell/node-pty');
  const actualPtyPath = path.resolve(resolvedPtyModule);
  const expectedPtyPath = path.resolve(expectedPtyModule);
  const samePtyPath = process.platform === 'win32'
    ? actualPtyPath.toLocaleLowerCase('en-US') === expectedPtyPath.toLocaleLowerCase('en-US')
    : actualPtyPath === expectedPtyPath;
  if (!samePtyPath) {
    throw new Error('candidate Main and the outer harness do not resolve the same pinned public @lydell/node-pty file');
  }
  const nodePty = require(resolvedPtyModule);
  // The compiled repo protocol (canonical known sibling leaf) supplies the
  // strict offered-bootstrap validator and env name. Unavailable means the
  // private native binding stays unknown; spawn observation is unchanged.
  let bootstrap;
  try {
    const protocol = productionRequire(path.join(path.dirname(mainEntry), 'protocol.js'));
    if (protocol !== null && typeof protocol === 'object'
      && typeof protocol.parseBootstrap === 'function'
      && typeof protocol.HOST_BOOTSTRAP_ENV === 'string' && protocol.HOST_BOOTSTRAP_ENV.length > 0) {
      bootstrap = { envName: protocol.HOST_BOOTSTRAP_ENV, parse: protocol.parseBootstrap };
    }
  } catch {
    // unsupported: the private binding stays unknown
  }
  return observePtyModule(nodePty, ptyJournal, bootstrap === undefined ? {} : { bootstrap });
}

function writeResult(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function main() {
  const optionsPath = process.env.PRG_SESSION_HOST_WINDOWS_OPTIONS;
  const resultPath = process.env.PRG_SESSION_HOST_WINDOWS_RESULT;
  const mainEntry = process.env.PRG_SESSION_HOST_WINDOWS_MAIN_ENTRY;
  const ptyJournal = process.env.PRG_SESSION_HOST_WINDOWS_PTY_JOURNAL;
  const expectedPtyModule = process.env.PRG_SESSION_HOST_WINDOWS_PTY_MODULE;
  const baseline = process.env.PRG_SESSION_HOST_WINDOWS_BASELINE;
  if (!optionsPath || !resultPath || !mainEntry || !ptyJournal || !expectedPtyModule || !baseline) {
    throw new Error('Windows Main runner is missing a bounded private fixture path');
  }

  const optionsStats = fs.lstatSync(optionsPath, { bigint: true });
  if (!optionsStats.isFile() || optionsStats.isSymbolicLink() || optionsStats.size > 64n * 1024n) {
    throw new Error('Windows Main runner options are not a bounded regular fixture file');
  }
  const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  const inputStream = process.stdin;
  const outputStream = process.stdout;
  if (!inputStream.isTTY || !outputStream.isTTY || typeof inputStream.isRaw !== 'boolean') {
    throw new Error('actual public Main stdin/stdout TTY and original raw mode are required');
  }
  const rawBefore = inputStream.isRaw;
  const observation = installPtyObservation(mainEntry, expectedPtyModule, ptyJournal);
  outputStream.write(`\x1b[2J\x1b[H${baseline}`);

  // Census after the baseline write so the baseline is not counted, and before
  // Main starts so every offered Main/TUI write is observed. The reply service
  // watches exactly one owned nonrecursive fixture-root watch and serves at
  // most one fresh request; it is closed on every return/error path.
  const census = createStdoutModeCensus();
  const censusHandle = installStdoutWriteCensus(outputStream, census);
  // Single original-Main-origin native exchange guard: armed exactly once
  // inside the fresh Main census snapshot pass when that pass first constructs
  // a complete actual-owner native binding (before the reply is published),
  // and serving at most one fresh reply through the fixed known root leaves
  // only while its private armed binding and the fresh current actual scope
  // are all intact. No raw data, token, socket path, instance identity,
  // session id, or proof ever crosses the wire or reaches a log.
  let paneObserver;
  const exchangeGuard = createNativeExchangeGuard({
    mainPid: () => process.pid,
    geometry: () => ({ columns: outputStream.columns, rows: outputStream.rows }),
    revalidate: (armed) => (paneObserver === undefined ? undefined : paneObserver.revalidateScope(armed)),
    bindingLookup: (instanceId) => observation.nativeBindingFor(instanceId),
  });
  // Passive public stdout resize observation for the guard: a real terminal
  // geometry change is a sticky disturbance while armed. The exact listener is
  // removed in the finally on every return/error path.
  const resizeObserver = () => exchangeGuard.observeResize();
  outputStream.on('resize', resizeObserver);
  // Transparent test-only actual-owner pane observer on the original candidate
  // compiled class prototypes, installed before Main is required so it captures
  // the genuine manager/sidebar instances Main constructs. It never throws and
  // reports an honest all-null unknown when the candidate classes or their
  // descriptors are unsupported, leaving public Main execution unchanged.
  // The narrow TESTONLY native-binding callback resolves the exact matched
  // live owner row against the exact original PTY registry (retained offered
  // bootstrap tuple + once-positive original PID / current incarnation) and
  // computes the expected fresh private proof. It never journals the tuple.
  paneObserver = installPaneModeObserver(mainEntry, {
    nativeBinding: (row, nonce) => {
      try {
        if (row === null || typeof row !== 'object' || typeof row.id !== 'string') return undefined;
        const binding = observation.nativeBindingFor(row.id);
        if (binding === undefined) return undefined; // absent/pending/exited/duplicate: unknown
        let sessionId = null;
        let sessionEpoch = null;
        const nativeSession = row.nativeSession;
        if (nativeSession !== null && typeof nativeSession === 'object') {
          const id = nativeSession.sessionId;
          const epoch = nativeSession.epoch;
          if (isValidNativeSessionIdValue(id) && Number.isSafeInteger(epoch) && epoch >= 1) {
            sessionId = id;
            sessionEpoch = epoch;
          }
        }
        let expectedProof = null;
        if (sessionId !== null && sessionEpoch !== null) {
          const proof = computeNativeCensusProof({
            bootstrap: binding.bootstrap,
            sessionId,
            sessionEpoch,
            nonce,
            pid: binding.pid,
          });
          if (proof !== undefined) expectedProof = proof;
        }
        // The raw sessionId stays private to this callback (it is bound
        // through the opaque proof); only the bounded numeric epoch and the
        // proof are published. The raw bootstrap tuple is returned privately
        // for the exchange-guard arm; it is never validated into or published
        // by the bounded binding group.
        return { ptyPid: binding.pid, incarnation: binding.incarnation, sessionEpoch, expectedProof, bootstrap: binding.bootstrap };
      } catch {
        return undefined; // observation bookkeeping never changes the original call
      }
    },
    guard: exchangeGuard,
  });
  let censusService;
  try {
    censusService = createCensusReplyService({
      root: path.dirname(optionsPath),
      mainPid: () => process.pid,
      buildSnapshot: (nonce) => ({
        ...censusHandle.snapshot(),
        activePane: paneObserver.snapshot(nonce),
        nativeBinding: paneObserver.nativeBinding(),
      }),
      fs,
    });
    censusService.start();
  } catch {
    // start() closes its own partially registered watcher before rethrowing;
    // channel unavailable: the parent fails closed on its bounded wait.
    censusService = undefined;
  }

  // The single fresh original-Main-origin guard exchange through the fixed
  // known root leaves, reusing the shared strict census reply transport with
  // exact-once closure after serve. A refused guard writes no reply leaf; the
  // parent fails closed on its bounded wait (no fallback certification).
  let guardService;
  try {
    guardService = createCensusReplyService({
      root: path.dirname(optionsPath),
      mainPid: () => process.pid,
      requestFilename: GUARD_REQUEST_FILENAME,
      replyFilename: GUARD_REPLY_FILENAME,
      isRequestPayload: (payload) => isNativeExchangeGuardRequestPayload(payload) && exchangeGuard.willServe(payload),
      buildSnapshot: () => ({}),
      buildReply: (nonce, mainPidValue) => exchangeGuard.buildGuardReply(nonce, mainPidValue),
      closeAfterServe: true,
      fs,
    });
    guardService.start();
  } catch {
    // start() closes its own partially registered watcher before rethrowing;
    // channel unavailable: the parent fails closed on its bounded wait.
    guardService = undefined;
  }

  let status = 1;
  let threw = false;
  try {
    const { runSessionHost } = require(mainEntry);
    status = await runSessionHost(options);
  } catch {
    threw = true;
  } finally {
    // The exact census watcher closure and the exact pane observer restore sit
    // in nested finally blocks so a restoration exception can never bypass
    // either one or keep Main alive. Restore only unwinds slots that still hold
    // this observer's own hook.
    try {
      observation.markNormalMainReturn(status, threw);
      observation.restore();
      censusHandle.restore();
    } finally {
      try {
        if (censusService !== undefined) censusService.close();
        if (guardService !== undefined) guardService.close();
        outputStream.removeListener('resize', resizeObserver);
      } finally {
        paneObserver.restore();
      }
    }
  }

  const result = {
    status,
    threw,
    ...observation.snapshot(),
    stdinIsTTY: inputStream.isTTY === true,
    stdoutIsTTY: outputStream.isTTY === true,
    sameInputStream: process.stdin === inputStream,
    sameOutputStream: process.stdout === outputStream,
    rawBefore,
    rawAfter: inputStream.isRaw,
  };
  try {
    writeResult(resultPath, result);
  } catch {
    // The caller treats the missing CreateNew result as a failed proof.
  }
  process.exitCode = threw ? 1 : status;
}

void main().catch(() => {
  const resultPath = process.env.PRG_SESSION_HOST_WINDOWS_RESULT;
  if (resultPath) {
    try {
      writeResult(resultPath, {
        status: 1,
        threw: true,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        sameInputStream: false,
        sameOutputStream: false,
        rawBefore: null,
        rawAfter: process.stdin.isRaw,
      });
    } catch {
      // A missing result is a bounded test failure, not a fabricated success.
    }
  }
  process.exitCode = 1;
});
