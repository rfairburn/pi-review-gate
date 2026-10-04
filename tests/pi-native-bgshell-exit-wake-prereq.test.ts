/**
 * Focused prerequisite-gate checks for tests/pi-native-bgshell-exit-wake.test.ts.
 *
 * The real-host wake tests skip when their prerequisites (compiled candidate,
 * installed Pi 1.x) are missing — hard-failing under
 * PI_REVIEW_GATE_REQUIRE_PI_HOST=1. A runtime t.skip() does not stop an async
 * test body, so after a skip the caller must return before constructing the
 * fixture; otherwise the construction throw surfaces as a confusing failing
 * stack attached to an already-skipped test. These checks run the compiled
 * wake test file in a subprocess with fully controlled gate variables (a
 * bogus PI_REVIEW_GATE_INSTALLED_AGENT pin is the sole host candidate, so no
 * ambient install can influence the outcome) and assert the TAP contract:
 * missing prerequisites produce clean skips only, while require-host mode
 * produces hard failures instead of skips.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/** The compiled sibling the checks drive (this suite always runs from dist-test). */
const WAKE_TEST_FILE = join(__dirname, "pi-native-bgshell-exit-wake.test.js");
const WAKE_TEST_NAMES = [
  "aborted run recovers its queued exit wake (#281)",
  "canceling recovery does not restart the same exit delivery (#281)",
  "immediate job exit wakes the owning session without polling (#281)",
  "short-lived job exit wakes the owning session without polling (#281)",
];

const GATE_VARS: readonly string[] = [
  "PI_REVIEW_GATE_CANDIDATE_ENTRY",
  "PI_REVIEW_GATE_INSTALLED_AGENT",
  "PI_REVIEW_GATE_REQUIRE_PI_HOST",
];

/** Child environment with every gate variable controlled by the caller. The
 *  NODE_TEST_* variables are dropped so the child's own `node --test` run is
 *  standalone: inheriting the parent runner's context makes Node treat it as
 *  a recursive in-test run and skip executing the file. */
function gateEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (GATE_VARS.includes(key) || key.startsWith("NODE_TEST_")) delete env[key];
  }
  return { ...env, ...overrides };
}

async function runWakeTests(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--test", "--test-reporter=tap", WAKE_TEST_FILE],
      { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      output: `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`,
    };
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** TAP escapes backslashes and '#' inside test descriptions; match the
 *  escaped form when looking up a result line or anchoring a regex. */
const tapDescription = (name: string): string => name.replace(/\\/g, "\\\\").replace(/#/g, "\\#");

/** The TAP result line for one wake test, or undefined when absent. */
function resultLine(output: string, name: string): string | undefined {
  const escaped = tapDescription(name);
  return output
    .split("\n")
    .find((line) => /^(ok|not ok) \d+ - /.test(line) && line.includes(escaped));
}

async function scratchCwd(t: { after(fn: () => void | Promise<void>): unknown }): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "prg-exit-wake-prereq-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("missing candidate skips the exit-wake tests cleanly without a failing stack", async (t) => {
  assert.ok(existsSync(WAKE_TEST_FILE), `compiled wake test not found at ${WAKE_TEST_FILE}`);
  // Empty cwd, no PI_REVIEW_GATE_CANDIDATE_ENTRY: the candidate prerequisite
  // fails before host resolution is even reached.
  const cwd = await scratchCwd(t);
  const run = await runWakeTests(gateEnv(), cwd);
  for (const name of WAKE_TEST_NAMES) {
    const line = resultLine(run.output, name);
    assert.ok(line, `no TAP result line for ${name}; output:\n${run.output}`);
    assert.match(
      line!,
      new RegExp(`^ok \\d+ - ${escapeRegExp(tapDescription(name))} # SKIP `),
      `expected a clean skip for ${name}, got: ${line}`,
    );
  }
  assert.ok(!/^not ok \d+ /m.test(run.output), `a failing test appeared in the skip run:\n${run.output}`);
  assert.match(run.output, /^# fail 0$/m);
  assert.equal(run.code, 0, `expected exit 0 for a fully skipped run; output:\n${run.output}`);
});

test("an unresolvable pinned host skips after the prerequisite check, never via a fixture-construction failure", async (t) => {
  assert.ok(existsSync(WAKE_TEST_FILE), `compiled wake test not found at ${WAKE_TEST_FILE}`);
  const cwd = await scratchCwd(t);
  // The candidate prerequisite passes (dummy entry exists); the pinned host is
  // bogus and, being explicitly set, is the sole candidate — no ambient
  // install can satisfy it. This is the exact boundary where a post-skip
  // fixture construction would previously throw a confusing failure stack.
  const dummyCandidate = join(cwd, "dummy-candidate.js");
  writeFileSync(dummyCandidate, "// dummy candidate entry for the prerequisite gate\n", "utf8");
  const bogusPin = join(cwd, "no-such-agent-install");
  const run = await runWakeTests(gateEnv({
    PI_REVIEW_GATE_CANDIDATE_ENTRY: dummyCandidate,
    PI_REVIEW_GATE_INSTALLED_AGENT: bogusPin,
  }), cwd);
  for (const name of WAKE_TEST_NAMES) {
    const line = resultLine(run.output, name);
    assert.ok(line, `no TAP result line for ${name}; output:\n${run.output}`);
    assert.match(
      line!,
      new RegExp(`^ok \\d+ - ${escapeRegExp(tapDescription(name))} # SKIP `),
      `expected a clean skip for ${name}, got: ${line}`,
    );
    // The skip message must come from host resolution, not a later throw.
    assert.match(line!, /no installed @earendil-works\/pi-coding-agent found/);
  }
  assert.ok(!/^not ok \d+ /m.test(run.output), `a failing test appeared in the skip run:\n${run.output}`);
  assert.match(run.output, /^# fail 0$/m);
  assert.equal(run.code, 0, `expected exit 0 for a fully skipped run; output:\n${run.output}`);
});

test("PI_REVIEW_GATE_REQUIRE_PI_HOST=1 turns the missing host into a hard failure instead of a skip", async (t) => {
  assert.ok(existsSync(WAKE_TEST_FILE), `compiled wake test not found at ${WAKE_TEST_FILE}`);
  const cwd = await scratchCwd(t);
  const dummyCandidate = join(cwd, "dummy-candidate.js");
  writeFileSync(dummyCandidate, "// dummy candidate entry for the prerequisite gate\n", "utf8");
  const bogusPin = join(cwd, "no-such-agent-install");
  const run = await runWakeTests(gateEnv({
    PI_REVIEW_GATE_CANDIDATE_ENTRY: dummyCandidate,
    PI_REVIEW_GATE_INSTALLED_AGENT: bogusPin,
    PI_REVIEW_GATE_REQUIRE_PI_HOST: "1",
  }), cwd);
  for (const name of WAKE_TEST_NAMES) {
    const line = resultLine(run.output, name);
    assert.ok(line, `no TAP result line for ${name}; output:\n${run.output}`);
    assert.match(
      line!,
      new RegExp(`^not ok \\d+ - ${escapeRegExp(tapDescription(name))}$`),
      `expected a hard failure (not a skip) for ${name}, got: ${line}`,
    );
  }
  assert.ok(run.output.includes("required Pi host unavailable"), `missing the require-host failure message; output:\n${run.output}`);
  assert.match(run.output, /^# fail 4$/m);
  assert.equal(run.code, 1, `expected a nonzero exit for the require-host run; output:\n${run.output}`);
});
