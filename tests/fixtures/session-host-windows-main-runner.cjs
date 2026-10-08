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
  return observePtyModule(nodePty, ptyJournal);
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
  // Transparent test-only actual-owner pane observer on the original candidate
  // compiled class prototypes, installed before Main is required so it captures
  // the genuine manager/sidebar instances Main constructs. It never throws and
  // reports an honest all-null unknown when the candidate classes or their
  // descriptors are unsupported, leaving public Main execution unchanged.
  const paneObserver = installPaneModeObserver(mainEntry);
  let censusService;
  try {
    censusService = createCensusReplyService({
      root: path.dirname(optionsPath),
      mainPid: () => process.pid,
      buildSnapshot: () => ({ ...censusHandle.snapshot(), activePane: paneObserver.snapshot() }),
      fs,
    });
    censusService.start();
  } catch {
    // start() closes its own partially registered watcher before rethrowing;
    // channel unavailable: the parent fails closed on its bounded wait.
    censusService = undefined;
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
