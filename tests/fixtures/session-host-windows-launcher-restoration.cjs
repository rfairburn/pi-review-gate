'use strict';

/**
 * Pure restoration witnesses for the Windows source-launcher acceptance preload.
 *
 * The acceptance contract requires the caller's original stdin/stdout
 * references, raw-mode state, NODE_OPTIONS, and provider value to survive the
 * wrapper, the source-stage build, the compiled Main process, and the native
 * child's production NODE_OPTIONS restore. These helpers turn those
 * comparisons into bounded booleans. They never copy, hash, or log the values
 * themselves, so no environment or transcript content can reach diagnostics.
 *
 * Pure and side-effect free: the preload calls them at activation and at exit,
 * and the source-reading synthetic test exercises exact, corrupted,
 * unrestored-raw-mode, and provider-drift cases directly.
 */

const BOOTSTRAP_ENV = 'PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP';
const RESTORE_SIDECAR_ENV = 'PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE';
const EXPECT_NODE_OPTIONS_ENV = 'PRG_SESSION_HOST_LAUNCHER_EXPECT_NODE_OPTIONS';
const EXPECT_PROVIDER_ENV = 'PRG_SESSION_HOST_LAUNCHER_EXPECT_PROVIDER_VALUE';
const PROVIDER_NAME = 'PI_PROVIDER_TEST_KEY';

function readableIsRaw(stream) {
  return stream && typeof stream.isRaw === 'boolean' ? stream.isRaw : null;
}

/**
 * Capture the caller's original stream references, raw-mode state, and the
 * exact expected NODE_OPTIONS/provider values (from test-owned expectation
 * env) before Main runs. Values are retained only for identity comparison.
 */
function captureLauncherBaseline(input) {
  const env = input.env || {};
  return {
    stdin: input.stdin,
    stdout: input.stdout,
    rawBefore: readableIsRaw(input.stdin),
    expectedNodeOptions: env[EXPECT_NODE_OPTIONS_ENV],
    expectedProvider: env[EXPECT_PROVIDER_ENV],
    providerName: PROVIDER_NAME,
  };
}

/**
 * Compare the actual launcher process's final stream/env state with the
 * captured baseline. Returns only booleans and the original raw-mode literal;
 * never the option string, provider value, or terminal content.
 */
function launcherRestorationSnapshot(baseline, current) {
  const env = current.env || {};
  const rawAfter = readableIsRaw(current.stdin);
  return {
    sameStdin: current.stdin === baseline.stdin,
    sameStdout: current.stdout === baseline.stdout,
    rawBefore: baseline.rawBefore,
    rawAfter,
    rawRestored: typeof baseline.rawBefore === 'boolean' && rawAfter === baseline.rawBefore,
    nodeOptionsExact: typeof baseline.expectedNodeOptions === 'string'
      && env.NODE_OPTIONS === baseline.expectedNodeOptions,
    providerExact: typeof baseline.expectedProvider === 'string'
      && env[baseline.providerName] === baseline.expectedProvider,
  };
}

/**
 * Compare a native child's environment with the exact expected restoration
 * state. The production bootstrap preload must have consumed its one-shot
 * sidecar, restored the caller's exact NODE_OPTIONS, and carried the synthetic
 * provider value through unchanged.
 */
function nativeRestorationSnapshot(env) {
  const source = env || {};
  return {
    bootstrapPresent: source[BOOTSTRAP_ENV] !== undefined,
    restoreSidecarPresent: source[RESTORE_SIDECAR_ENV] !== undefined,
    nodeOptionsExact: typeof source[EXPECT_NODE_OPTIONS_ENV] === 'string'
      && source.NODE_OPTIONS === source[EXPECT_NODE_OPTIONS_ENV],
    providerExact: typeof source[EXPECT_PROVIDER_ENV] === 'string'
      && source[PROVIDER_NAME] === source[EXPECT_PROVIDER_ENV],
  };
}

module.exports = {
  captureLauncherBaseline,
  launcherRestorationSnapshot,
  nativeRestorationSnapshot,
  EXPECT_NODE_OPTIONS_ENV,
  EXPECT_PROVIDER_ENV,
  PROVIDER_NAME,
};
