#!/usr/bin/env node
"use strict";

/**
 * CI-only Node test-runner custom reporter: unbuffered per-test-FILE progress.
 *
 * Used only by the Linux full-suite CI step (see .github/workflows/ci.yml) as a
 * second, stderr-bound reporter alongside the spec reporter on stdout:
 *
 *   node --test --test-concurrency=4 --test-timeout=300000 \
 *     --test-reporter=spec --test-reporter=./scripts/ci/test-file-progress.cjs \
 *     --test-reporter-destination=stdout --test-reporter-destination=stderr \
 *     dist-test/tests/*.test.js
 *
 * It prints exactly two lines per test file to stderr, as the runner's events
 * arrive (no buffering, no per-test output):
 *
 *   [ci-test-progress] start <file>          on the root file's test:dequeue
 *   [ci-test-progress] complete <file> ...   on the root file's test:complete
 *
 * Root file wrappers are identified by nesting 0 plus a name that matches one
 * of the test-file paths passed on the command line; nested (in-file) tests
 * never produce output. If the run is killed before every file completes (for
 * example by the CI step timeout), unmatched start lines identify files with
 * no observed completion; they do not prove the processes remain alive.
 * The reporter never alters exit codes, test selection, or spec output.
 */

const path = require("node:path");

const PREFIX = "[ci-test-progress]";

/**
 * Resolve the test-file specs from the runner's argv (everything after the
 * node binary that is not an option) into a set of absolute paths. The custom
 * reporter module runs inside the main test-runner process, whose argv lists
 * exactly the files being executed.
 */
function fileSpecsFromArgv(argv) {
  const specs = new Set();
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith("-")) continue;
    specs.add(path.resolve(arg));
  }
  return specs;
}

/** True when a test event belongs to a root test-file wrapper, not an in-file test. */
function isRootFileEvent(data, fileSpecs) {
  return Boolean(
    data &&
      data.nesting === 0 &&
      typeof data.name === "string" &&
      fileSpecs.has(path.resolve(data.name)),
  );
}

/**
 * Consume an async iterable of test-runner events ({type, data}) and yield one
 * progress line per root-file dequeue/complete. Exported so focused unit tests
 * can drive it with synthetic event streams without spawning a runner.
 */
async function* progressLines(events, fileSpecs) {
  for await (const event of events) {
    const data = event && event.data;
    if (!isRootFileEvent(data, fileSpecs)) continue;
    if (event.type === "test:dequeue") {
      yield `${PREFIX} start ${data.name}`;
    } else if (event.type === "test:complete") {
      const details = data.details || {};
      const failed = details.passed === false || Boolean(details.failureType);
      const duration =
        typeof details.duration_ms === "number" ? ` ${Math.round(details.duration_ms)}ms` : "";
      yield `${PREFIX} complete ${data.name} ${failed ? "fail" : "pass"}${duration}`;
    }
  }
}

/**
 * Custom reporter entry point. Node loads this module for
 * `--test-reporter=<path>` and invokes the default export as an async
 * generator over the runner's event stream (verified against Node 24).
 */
module.exports = async function* (stream) {
  const fileSpecs = fileSpecsFromArgv(process.argv);
  for await (const line of progressLines(stream, fileSpecs)) {
    process.stderr.write(line + "\n");
  }
};
module.exports.progressLines = progressLines;
module.exports.fileSpecsFromArgv = fileSpecsFromArgv;
module.exports.isRootFileEvent = isRootFileEvent;
