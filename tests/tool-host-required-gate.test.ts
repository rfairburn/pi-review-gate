/**
 * Isolated required-host gate fixtures for the two real-host tool-card suites
 * (#247): tests/tool-result-hints-host.test.ts and
 * tests/subtask-dispatch-host-lifecycle.test.ts must honor the established
 * skip-or-fail contract (tests/bridge-fakes.ts skipOrFail) instead of
 * registering an unconditional missing-host skip.
 *
 * Observable contract, proven without touching a live installation, a global
 * package root, or any available host:
 * - an unavailable installed host is virtualized in the fixture subprocesses
 *   (a preload hides the ambient global-root candidates and the explicit
 *   overrides are scrubbed): with PI_REVIEW_GATE_REQUIRE_PI_HOST unset — or
 *   at any non-required value — each suite keeps its honest reason-bearing
 *   skip and runs no host assertion;
 * - the same fixture with the gate at exactly "1" fails nonzero, naming the
 *   required missing Pi host;
 * - an explicitly pinned (PI_REVIEW_GATE_INSTALLED_AGENT) but unavailable
 *   agent package is the sole candidate and never falls back to ambient
 *   roots, in both gate modes;
 * - a relative explicit pin ("." against the fixture's own working
 *   directory) whose package.json exists but whose host modules do not is
 *   resolved to an absolute path by the loaders and reaches the same
 *   skip/fail placeholder — discovery must not crash with
 *   ERR_INVALID_ARG_VALUE from createRequire before the gate runs.
 *
 * The fixture runs each suite's own compiled test file under the runner's
 * build:test output — no fake-host coverage is substituted anywhere; the
 * available-host path is covered directly by the two suites themselves (the
 * full-suite glob runs them against a discoverable or pinned host).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skipOrFail } from "./bridge-fakes";
import { missingHostError, piHostRequired } from "./tool-host-gate";

/** The suite placeholder names, identical under the skip and gated-failure modes. */
const SUITES = [
  {
    file: "tool-result-hints-host.test.js",
    source: "tool-result-hints-host.test.ts",
    placeholder: "real-host integration coverage",
    realTest: "the real native Theme works end-to-end",
  },
  {
    file: "subtask-dispatch-host-lifecycle.test.js",
    source: "subtask-dispatch-host-lifecycle.test.ts",
    placeholder: "real-host original-card lifecycle coverage",
    realTest: "a mounted queued Start card re-renders to captured dispatch",
  },
];

/** The suites' own prerequisite reason string (registerMissingHostPlaceholder input). */
const MISSING_REASON =
  "installed Pi host not found (set PI_CODING_AGENT_DIR to a node_modules root containing @earendil-works/pi-coding-agent)";

/**
 * The ambient global-root candidates the suites' local discovery searches when
 * no explicit override is set. Both the preload and the probe derive them from
 * this single list so the virtualization cannot drift from discovery.
 */
const AMBIENT_ROOTS_SOURCE = [
  "'/opt/homebrew/lib/node_modules',",
  "'/usr/local/lib/node_modules',",
  "path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),",
];

/**
 * Test-only discovery virtualization: a subprocess preload that makes the
 * ambient global-root candidates look empty, so unavailable-host fixtures are
 * deterministic even on a machine whose live installs would satisfy
 * discovery. The agent package.json candidates are virtualized by EXACT path
 * — built with the same path.join the suites' discovery uses (backslash
 * separators on Windows) plus Windows-style separator variants, never a
 * substring pattern — so nothing else is patched and no filesystem is
 * modified. The original fs.existsSync is exposed for probe assertions.
 */
async function hideAmbientPreload(root: string): Promise<string> {
  const preload = join(root, "hide-ambient-agent.cjs");
  await writeFile(preload, [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "const ambientRoots = [",
    ...AMBIENT_ROOTS_SOURCE,
    "];",
    "const virtualized = new Set();",
    "for (const root of ambientRoots) {",
    "  for (const joinStyle of [path.join, path.win32.join]) {",
    "    virtualized.add(joinStyle(root, '@earendil-works', 'pi-coding-agent', 'package.json'));",
    "  }",
    "}",
    "const orig = fs.existsSync;",
    "fs.__prgOriginalExistsSync = orig;",
    "fs.existsSync = function patchedExistsSync(p) {",
    "  return virtualized.has(p) ? false : orig(p);",
    "};",
  ].join("\n"), "utf8");
  return preload;
}

/**
 * Focused-regression probe for the virtualization itself: a subprocess that
 * asserts the EXACT platform-native agent package.json candidates discovery
 * builds (backslash separators on Windows) are hidden, Windows-style
 * separator variants are hidden, and every other path is untouched — all with
 * existsSync reads only, never touching a live installation.
 */
async function writeHiddenPathProbe(root: string): Promise<string> {
  const probe = join(root, "probe-hidden-agent-paths.cjs");
  await writeFile(probe, [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    "const assert = require('node:assert/strict');",
    "const ambientRoots = [",
    ...AMBIENT_ROOTS_SOURCE,
    "];",
    "const original = fs.__prgOriginalExistsSync;",
    "assert.ok(typeof original === 'function', 'the preload exposes the original fs.existsSync');",
    "for (const root of ambientRoots) {",
    // Exactly the candidate path the suites' discovery builds with path.join.
    "  const native = path.join(root, '@earendil-works', 'pi-coding-agent', 'package.json');",
    "  assert.equal(fs.existsSync(native), false, `path.join candidate virtualized: ${native}`);",
    // Windows-style separators (what path.join produces on Windows) stay virtualized.
    "  const win = path.win32.join(root, '@earendil-works', 'pi-coding-agent', 'package.json');",
    "  assert.equal(fs.existsSync(win), false, `Windows-style candidate virtualized: ${win}`);",
    // Surgical scope: only the exact candidates are virtualized; everything
    // else compares equal to the original fs.existsSync.
    "  const sibling = path.join(root, '@earendil-works', 'some-other-package', 'package.json');",
    "  assert.equal(fs.existsSync(sibling), original(sibling), `unrelated path untouched: ${sibling}`);",
    "  const agentDir = path.join(root, '@earendil-works', 'pi-coding-agent');",
    "  assert.equal(fs.existsSync(agentDir), original(agentDir), `non-package.json path untouched: ${agentDir}`);",
    "}",
    // General fs functionality is intact (nothing else was hidden).
    "assert.equal(fs.existsSync(process.execPath), original(process.execPath), 'process.execPath remains visible');",
  ].join("\n"), "utf8");
  return probe;
}

/** Child environment for one fixture subprocess: all discovery inputs controlled. */
function fixtureEnv(patches: {
  requireFlag?: string;
  pinnedPackage?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Scrub every installed-host discovery input so only the fixture shapes it.
  for (const name of ["PI_REVIEW_GATE_REQUIRE_PI_HOST", "PI_REVIEW_GATE_INSTALLED_AGENT", "PI_CODING_AGENT_DIR"]) {
    delete env[name];
  }
  if (patches.requireFlag !== undefined) env.PI_REVIEW_GATE_REQUIRE_PI_HOST = patches.requireFlag;
  if (patches.pinnedPackage !== undefined) env.PI_REVIEW_GATE_INSTALLED_AGENT = patches.pinnedPackage;
  return env;
}

/**
 * Runs one compiled suite in a fixture subprocess. The optional `cwd` (by
 * default inherited from this process) lets a relative-pin fixture control
 * the child's working directory without touching other callers.
 */
function runCompiledSuite(
  file: string,
  patch: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { exit: number; output: string } {
  const suitePath = join(__dirname, file);
  assert.ok(existsSync(suitePath), `compiled suite missing (run build:test first): ${suitePath}`);
  const args = patch ? ["-r", patch, suitePath] : [suitePath];
  const child = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 120_000, cwd });
  assert.ok(!child.error, `fixture subprocess failed to spawn: ${child.error}`);
  return { exit: child.status ?? -1, output: `${child.stdout ?? ""}\n${child.stderr ?? ""}` };
}

test("the shared tool-host gate treats only a flag of exactly \"1\" as required", () => {
  const previous = process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST;
  try {
    for (const value of ["0", "true", "yes", "", " 1", "1 "]) {
      process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = value;
      assert.equal(piHostRequired(), false, `PI_REVIEW_GATE_REQUIRE_PI_HOST=${JSON.stringify(value)} stays optional`);
    }
    delete process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST;
    assert.equal(piHostRequired(), false, "an unset gate is optional (honest local skip)");
    process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = "1";
    assert.equal(piHostRequired(), true, "only the exact value \"1\" is required");
  } finally {
    if (previous === undefined) delete process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST;
    else process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = previous;
  }
});

test("the shared tool-host gate failure names the required missing Pi host and any pinned package", () => {
  const previous = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  try {
    delete process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
    const error = missingHostError(MISSING_REASON);
    assert.match(error.message, /^required Pi host unavailable: installed Pi host not found/);
    assert.doesNotMatch(error.message, /pinned package/);

    process.env.PI_REVIEW_GATE_INSTALLED_AGENT = join(tmpdir(), "no-such-pinned-agent");
    const pinnedError = missingHostError(MISSING_REASON);
    assert.match(pinnedError.message, /^required Pi host unavailable: installed Pi host not found/);
    assert.match(pinnedError.message, /pinned package: .*no-such-pinned-agent/,
      "the failure points at the pinned package that could not resolve");
  } finally {
    if (previous === undefined) delete process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
    else process.env.PI_REVIEW_GATE_INSTALLED_AGENT = previous;
  }
});

test("the shared tool-host gate matches the established bridge-fakes skipOrFail semantics", () => {
  const previousGate = process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST;
  const previousPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  try {
    const skips: string[] = [];
    const t = { skip: (message?: string) => { skips.push(message ?? ""); } };
    process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = "0";
    process.env.PI_REVIEW_GATE_INSTALLED_AGENT = "";
    skipOrFail(t, "probe reason");
    assert.deepEqual(skips, ["probe reason"], "skipOrFail keeps skipping at non-required values");
    process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = "1";
    const bridgeMessage = (() => {
      try {
        skipOrFail(t, "probe reason");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    assert.match(bridgeMessage, /^required Pi host unavailable: probe reason$/);
    const gateMessage = missingHostError("probe reason").message;
    assert.equal(gateMessage, bridgeMessage as string,
      "the tool-host gate produces the established skipOrFail failure wording");
  } finally {
    if (previousGate === undefined) delete process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST;
    else process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST = previousGate;
    if (previousPin === undefined) delete process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
    else process.env.PI_REVIEW_GATE_INSTALLED_AGENT = previousPin;
  }
});

test("an unavailable installed host keeps the honest skip for every non-required gate value", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-required-host-"));
  try {
    const patch = await hideAmbientPreload(root);
    for (const flag of [undefined, "0"]) {
      for (const suite of SUITES) {
        const run = runCompiledSuite(suite.file, patch, fixtureEnv({ requireFlag: flag }));
        assert.equal(run.exit, 0, `${suite.file} exits zero when the host prerequisite is missing and the gate is ${flag ? `"${flag}"` : "unset"}`);
        assert.ok(run.output.includes(suite.placeholder), `${suite.file}: the placeholder test is present`);
        assert.ok(run.output.includes(MISSING_REASON),
          `${suite.file}: the placeholder carries the suite's honest missing-host reason`);
        assert.match(run.output, /skipped\s*1\b/, `${suite.file}: exactly the placeholder test skipped`);
        assert.ok(!run.output.includes(suite.realTest),
          `${suite.file}: no real-host assertion ran in the unavailable-host fixture`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same unavailable-host fixture is a clear nonzero failure when the gate is exactly \"1\"", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-required-host-"));
  try {
    const patch = await hideAmbientPreload(root);
    for (const suite of SUITES) {
      const run = runCompiledSuite(suite.file, patch, fixtureEnv({ requireFlag: "1" }));
      assert.notEqual(run.exit, 0, `${suite.file}: the required run must fail, not skip, when the Pi host prerequisite cannot resolve`);
      assert.ok(run.output.includes("required Pi host unavailable:"),
        `${suite.file}: the failure names the required missing Pi host`);
      assert.ok(run.output.includes(MISSING_REASON),
        `${suite.file}: the failure carries the suite's own prerequisite reason`);
      assert.ok(run.output.includes(suite.placeholder),
        `${suite.file}: the failure is reported on the suite's missing-host placeholder`);
      assert.match(run.output, /\bfail\s*1\b/, `${suite.file}: exactly one failing test under the required gate`);
      assert.ok(!run.output.includes(suite.realTest),
        `${suite.file}: no real-host assertion ran in the unavailable-host fixture`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly pinned unavailable agent package is the sole candidate and never falls back to ambient", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-required-host-"));
  try {
    // No discovery virtualization here on purpose: on a machine whose ambient
    // global roots hold a live install, a discovery fallback would actually
    // run the real suites instead of skipping, so this fixture would fail.
    const pinned = join(root, "no-such-pinned-agent");
    for (const flag of [undefined, "1"]) {
      for (const suite of SUITES) {
        const gateLabel = flag ? "the gate is exactly \"1\"" : "the gate is unset";
        const run = runCompiledSuite(suite.file, undefined, fixtureEnv({ requireFlag: flag, pinnedPackage: pinned }));
        if (flag === undefined) {
          assert.equal(run.exit, 0, `${suite.file}: an unusable pinned package is an honest skip while ${gateLabel}`);
          assert.ok(run.output.includes(MISSING_REASON),
            `${suite.file}: the skip still carries the suite's prerequisite reason`);
          assert.ok(!run.output.includes(suite.realTest),
            `${suite.file}: no ambient fallback ran the real-host assertions`);
        } else {
          assert.notEqual(run.exit, 0, `${suite.file}: the required run fails when the pinned package cannot resolve`);
          assert.match(run.output, /required Pi host unavailable: installed Pi host not found/,
            `${suite.file}: the required failure names the missing Pi host`);
          assert.match(run.output, new RegExp(`pinned package: ${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
            `${suite.file}: the required failure points at the pinned package that could not resolve`);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing but unloadable pinned package cannot silently skip a required run or fall back", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-unloadable-host-"));
  try {
    // Own package.json exists, but the required host modules do not: this
    // reaches the actual loaders' caught module-load failure, not merely
    // the missing-package prerequisite. No live installation is changed.
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.0.0-test-fixture",
    }), "utf8");
    assert.ok(existsSync(join(root, "package.json")));
    assert.equal(existsSync(join(root, "dist", "index.js")), false);
    for (const flag of [undefined, "1"]) {
      for (const suite of SUITES) {
        const run = runCompiledSuite(suite.file, undefined,
          fixtureEnv({ requireFlag: flag, pinnedPackage: root }));
        assert.ok(!run.output.includes(suite.realTest),
          `${suite.file}: an unloadable explicit pin must not substitute an ambient host`);
        if (flag === undefined) {
          assert.equal(run.exit, 0);
          assert.match(run.output, /skipped\s*1\b/);
          assert.ok(run.output.includes(MISSING_REASON));
        } else {
          assert.notEqual(run.exit, 0);
          assert.match(run.output, /required Pi host unavailable: installed Pi host not found/);
          assert.match(run.output, /\bfail\s*1\b/);
          assert.ok(run.output.includes(`pinned package: ${root}`));
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a relative existing-but-unloadable pin skips optionally and fails clearly when required", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-relative-pin-"));
  try {
    // A real package.json exists at the child's own working directory, but
    // the host modules do not: with PI_REVIEW_GATE_INSTALLED_AGENT set to the
    // relative pin "." against this cwd, the loaders must resolve the pin to
    // an absolute path and reach their caught module-load failure — not
    // throw ERR_INVALID_ARG_VALUE from createRequire before the placeholder.
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.0.0-test-fixture",
    }), "utf8");
    assert.ok(existsSync(join(root, "package.json")));
    assert.equal(existsSync(join(root, "dist", "index.js")), false);
    for (const flag of [undefined, "1"]) {
      for (const suite of SUITES) {
        const run = runCompiledSuite(suite.file, undefined,
          fixtureEnv({ requireFlag: flag, pinnedPackage: "." }), root);
        assert.ok(!run.output.includes("ERR_INVALID_ARG_VALUE"),
          `${suite.file}: the relative pin must not crash discovery before the placeholder`);
        assert.ok(!run.output.includes(suite.realTest),
          `${suite.file}: a relative unloadable pin must not substitute an ambient host`);
        if (flag === undefined) {
          assert.equal(run.exit, 0,
            `${suite.file}: a relative existing-but-unloadable pin is an honest optional skip`);
          assert.match(run.output, /skipped\s*1\b/);
          assert.ok(run.output.includes(MISSING_REASON));
        } else {
          assert.notEqual(run.exit, 0,
            `${suite.file}: the required run fails when a relative pinned package cannot load`);
          assert.match(run.output, /required Pi host unavailable: installed Pi host not found/);
          assert.match(run.output, /\bfail\s*1\b/);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the discovery virtualization hides exact ambient package.json candidates, including Windows-style separators", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-gate-required-host-"));
  try {
    const preload = await hideAmbientPreload(root);
    const probe = await writeHiddenPathProbe(root);
    // Pure existsSync reads on both POSIX and Windows: a Windows-shaped
    // candidate path (path.win32 separators) must be virtualized, and only
    // the exact package.json candidates may be hidden.
    const child = spawnSync(process.execPath, ["-r", preload, probe], {
      encoding: "utf8",
      env: fixtureEnv({}),
      timeout: 120_000,
    });
    assert.ok(!child.error, `probe subprocess failed to spawn: ${child.error}`);
    assert.equal(child.status, 0, `virtualization probe passes (stderr: ${child.stderr?.slice(0, 2000)})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});