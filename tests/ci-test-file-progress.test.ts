import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Focused regressions for the CI-only full-suite diagnostics used by the Linux
// `Full test suite` step in .github/workflows/ci.yml: the per-test-file
// progress reporter (scripts/ci/test-file-progress.cjs) and the built-in
// per-test timeout bound. The unit case drives the reporter's event mapping
// directly; the real-child cases run a bounded `node --test` against owned
// temp fixtures with the exact CI command shape (spec reporter on stdout plus
// the progress reporter on stderr, same file specs) and prove: immediate
// unbuffered file start/complete lines with no per-test spam, whole-fixture
// coverage with unchanged node failure reporting and exit codes, and the
// per-test timeout bound failing a hung test quickly.

type ProgressEvent = { type: string; data?: Record<string, unknown> };
type ProgressModule = {
  progressLines(events: AsyncIterable<ProgressEvent>, fileSpecs: Set<string>): AsyncGenerator<string>;
};

const projectRoot = join(__dirname, "..", "..");
const reporterPath = join(projectRoot, "scripts", "ci", "test-file-progress.cjs");
const reporterModule = require(reporterPath) as ProgressModule;

/** The exact CI full-suite command shape: same glob/concurrency coverage plus the two CI-only diagnostics. */
const CI_SHAPE_ARGS = [
  "--test-concurrency=4",
  "--test-reporter=spec",
  `--test-reporter=${reporterPath}`,
  "--test-reporter-destination=stdout",
  "--test-reporter-destination=stderr",
];

type ChildResult = { code: number | null; stdout: string; stderr: string };

/**
 * This file itself runs under `node --test` (the full suite), so its children
 * inherit NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID; a nested `node --test` in that
 * environment refuses to run files ("run() is being called recursively").
 * Scrub both markers so the controlled child behaves exactly like CI, where the
 * step runs the command directly from a plain shell.
 */
const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_TEST_CONTEXT: undefined,
  NODE_TEST_WORKER_ID: undefined,
};

/** Run a bounded `node --test` child in an owned temp directory and capture both streams. */
function runNodeTest(cwd: string, args: string[], files: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...args, ...files], {
      cwd,
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("bounded node --test child exceeded its 30s guard"));
    }, 30_000);
    child.on("error", (error) => { clearTimeout(guard); reject(error); });
    child.on("close", (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });
}

test("progress lines map root-file dequeue/complete events only, in order", async () => {
  const fileA = join(tmpdir(), "ci-progress-unit", "a.test.js");
  const fileB = join(tmpdir(), "ci-progress-unit", "b.test.js");
  const specs = new Set([fileA, fileB]);
  const events: ProgressEvent[] = [
    // Enqueue is not an execution-order signal; only dequeue/complete are.
    { type: "test:enqueue", data: { nesting: 0, name: fileA } },
    { type: "test:dequeue", data: { nesting: 0, name: fileA } },
    // In-file tests never produce progress lines, whether nested or top-level.
    { type: "test:dequeue", data: { nesting: 1, name: "nested case", file: fileA } },
    { type: "test:complete", data: { nesting: 1, name: "nested case", details: { passed: true, duration_ms: 1 } } },
    { type: "test:dequeue", data: { nesting: 0, name: "top-level case in a", file: fileA } },
    { type: "test:complete", data: { nesting: 0, name: fileA, details: { passed: true, duration_ms: 12.4 } } },
    { type: "test:dequeue", data: { nesting: 0, name: fileB } },
    { type: "test:complete", data: { nesting: 0, name: fileB, details: { passed: false, duration_ms: 3 } } },
  ];
  const lines: string[] = [];
  for await (const line of reporterModule.progressLines((async function* () { yield* events; })(), specs)) {
    lines.push(line);
  }
  assert.deepEqual(lines, [
    `[ci-test-progress] start ${fileA}`,
    `[ci-test-progress] complete ${fileA} pass 12ms`,
    `[ci-test-progress] start ${fileB}`,
    `[ci-test-progress] complete ${fileB} fail 3ms`,
  ]);
});

test("real run: per-file progress on stderr, spec and failure reporting on stdout, exit preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-progress-run-"));
  try {
    writeFileSync(join(dir, "a.test.js"), [
      'const test = require("node:test");',
      'test("alpha", (t) => { t.test("alpha one", () => {}); t.test("alpha two", () => {}); });',
      "",
    ].join("\n"));
    writeFileSync(join(dir, "b.test.js"), [
      'const test = require("node:test");',
      'test("beta explodes", () => { throw new Error("boom"); });',
      "",
    ].join("\n"));
    const result = await runNodeTest(dir, CI_SHAPE_ARGS, ["a.test.js", "b.test.js"]);
    assert.equal(result.code, 1, `the failing fixture must keep the nonzero exit; stdout:\n${result.stdout}`);

    // Exactly one start and one complete line per file on stderr — no per-test spam.
    const lines = result.stderr.split("\n").filter((line) => line.startsWith("[ci-test-progress] "));
    assert.equal(lines.length, 4, `expected exactly four progress lines: ${JSON.stringify(lines)}`);
    for (const name of ["a.test.js", "b.test.js"]) {
      const start = lines.findIndex((line) => line === `[ci-test-progress] start ${name}`);
      assert.notEqual(start, -1, `missing start line for ${name}: ${JSON.stringify(lines)}`);
      const complete = lines.findIndex((line) => line.startsWith(`[ci-test-progress] complete ${name} `));
      assert.ok(complete !== -1 && start < complete, `${name} must start before it completes: ${JSON.stringify(lines)}`);
    }
    assert.match(lines.find((line) => line.includes("complete a.test.js ")) ?? "", / pass /);
    assert.match(lines.find((line) => line.includes("complete b.test.js ")) ?? "", / fail /);

    // The spec reporter on stdout keeps whole-fixture coverage and node's own failure reporting.
    assert.match(result.stdout, /ℹ tests 4/, "all cases in both fixture files must run");
    assert.match(result.stdout, /ℹ fail 1/);
    assert.match(result.stdout, /beta explodes/);
    assert.match(result.stdout, /boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file progress streams as events fire: the start line arrives long before the run ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-progress-stream-"));
  try {
    writeFileSync(join(dir, "slow.test.js"), [
      'const test = require("node:test");',
      'test("slow case", async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); });',
      "",
    ].join("\n"));
    const startedAt = Date.now();
    let startLineAt = -1;
    const child = spawn(process.execPath, ["--test", ...CI_SHAPE_ARGS, "slow.test.js"], {
      cwd: dir,
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      if (startLineAt === -1 && chunk.toString().includes("[ci-test-progress] start slow.test.js")) {
        startLineAt = Date.now() - startedAt;
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const guard = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("30s guard")); }, 30_000);
      child.on("close", (c) => { clearTimeout(guard); resolve(c); });
    });
    const endedAt = Date.now() - startedAt;
    assert.equal(code, 0);
    assert.notEqual(startLineAt, -1, "the start line must arrive on stderr");
    // A reporter that flushed at run end would emit the start line within
    // milliseconds of exit; here it must arrive while the 1.5s test is running.
    assert.ok(endedAt - startLineAt > 1000,
      `the start line arrived only ${endedAt - startLineAt}ms before the run ended — progress must stream, not flush at exit`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the per-test timeout bound fails a hung test quickly through the same command shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-progress-timeout-"));
  try {
    // The owned timer keeps the child alive past the bound (a control run
    // without --test-timeout never finishes), so completing at all proves the
    // bound fired rather than an event-loop drain cancelling the promise;
    // t.after clears it on cancellation so the bounded run exits promptly.
    writeFileSync(join(dir, "stuck.test.js"), [
      'const test = require("node:test");',
      'test("stuck case", async (t) => {',
      '  const timer = setTimeout(() => {}, 60_000);',
      '  t.after(() => clearTimeout(timer));',
      '  await new Promise(() => {});',
      '});',
      "",
    ].join("\n"));
    const result = await runNodeTest(dir, [...CI_SHAPE_ARGS, "--test-timeout=500"], ["stuck.test.js"]);
    assert.equal(result.code, 1, `the bounded hang must fail the run; stdout:\n${result.stdout}`);
    // Node's timeout-specific failure text: this is timeout enforcement, not a
    // cancellation that merely happened to end the run quickly.
    assert.match(result.stdout, /test timed out after 500ms/);
    assert.match(result.stderr, /\[ci-test-progress\] start stuck\.test\.js/);
    assert.match(result.stderr, /\[ci-test-progress\] complete stuck\.test\.js fail /);
    assert.match(result.stdout, /stuck case/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
