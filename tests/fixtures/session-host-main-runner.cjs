'use strict';

/**
 * Public-Main PTY entry fixture. The parent supplies private, test-owned paths
 * through its allowlisted environment and observes only the owned outer PTY.
 */
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function readControllingTtyState() {
  const result = spawnSync('stty', ['-g'], {
    stdio: [0, 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('the owned PTY controlling-terminal state could not be observed');
  }
  return result.stdout.trim();
}

async function main() {
  const options = JSON.parse(fs.readFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_OPTIONS, 'utf8'));
  const { runSessionHost } = require(process.env.PRG_SESSION_HOST_NATIVE_MAIN_ENTRY);
  const before = readControllingTtyState();
  const rawBefore = process.stdin.isRaw;
  const baseline = process.env.PRG_SESSION_HOST_NATIVE_MAIN_BASELINE;
  process.stdout.write(`\x1b[2J\x1b[H${baseline}`);

  let status = 1;
  let threw = false;
  try {
    status = await runSessionHost(options);
  } catch {
    threw = true;
  }

  let after;
  try {
    after = readControllingTtyState();
  } catch {
    after = null;
    threw = true;
  }
  fs.writeFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_RESULT, JSON.stringify({
    status,
    threw,
    before,
    after,
    rawBefore,
    rawAfter: process.stdin.isRaw,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  }) + '\n', { mode: 0o600 });
  process.exitCode = status;
}

void main().catch(() => {
  try {
    fs.writeFileSync(process.env.PRG_SESSION_HOST_NATIVE_MAIN_RESULT, JSON.stringify({
      status: 1,
      threw: true,
      before: null,
      after: null,
    }) + '\n', { mode: 0o600 });
  } catch {
    // The parent will report the missing result from its owned PTY exit.
  }
  process.exitCode = 1;
});
