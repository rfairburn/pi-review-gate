import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

// Focused contract tests for .github/workflows/ci.yml. The workflow has no
// YAML parser dependency available, so these tests pin the invariants that CI
// correctness depends on with targeted structural assertions instead of
// snapshots: triggers, permissions, concurrency safety, action pins, browser
// prerequisites, and the full-suite command surface.

const projectRoot = join(dirname(__dirname), "..");
const workflowPath = join(projectRoot, ".github", "workflows", "ci.yml");
const releaseWorkflowPath = join(projectRoot, ".github", "workflows", "release.yml");
const sessionHostWorkflowPath = join(projectRoot, ".github", "workflows", "session-host-alpha.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function readReleaseWorkflow(): string {
  return readFileSync(releaseWorkflowPath, "utf8");
}

function readSessionHostWorkflow(): string {
  return readFileSync(sessionHostWorkflowPath, "utf8");
}

/** Collapse whitespace/newlines so folded YAML block scalars compare as one line. */
function flattened(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Drop full-line YAML comments so prose mentions of forbidden constructs don't trip negative assertions. */
function withoutComments(source: string): string {
  return source.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

/** Pinned `owner/repo@<sha>` references appearing in a workflow source. */
function pinnedActions(source: string): Set<string> {
  return new Set([...source.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((match) => match[1]));
}

/**
 * Return the body of a top-level (or job-level) YAML block key: the lines
 * after `key:` until the next line with indent <= the key's own indent.
 */
function blockOf(source: string, key: string, indent: number): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}${key}:`);
  assert.ok(start !== -1, `expected a ${key}: block at indent ${indent}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { body.push(line); continue; }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

type MatrixRow = { label: string; version: string };

/**
 * Parse a job's explicit `strategy.matrix.include:` rows into label/pin pairs.
 * The stable per-major check-identity contract requires each row to pair one
 * bare Node major (`node-major`, the value the check name renders) with that
 * line's exact `node-version` pin (the value setup-node installs and logs), so
 * raising a line's patch or minor floor changes only the pin.
 */
function matrixRows(jobBlock: string): MatrixRow[] {
  const lines = jobBlock.split("\n");
  const matrixAt = lines.findIndex((line) => line === "      matrix:");
  assert.ok(matrixAt !== -1, "the job must declare a strategy.matrix block");
  const includeAt = lines.findIndex((line, index) => index > matrixAt && line === "        include:");
  assert.ok(includeAt !== -1,
    "the matrix must declare explicit include: rows pairing each stable check-name label with its exact pinned runtime");
  const rows: MatrixRow[] = [];
  for (const line of lines.slice(includeAt + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.length - line.trimStart().length < 10) break;
    const row = /^(\s*)- node-major: (\S+)$/.exec(line);
    if (row) {
      rows.push({ label: row[2], version: "" });
      continue;
    }
    const pin = /^(\s*)node-version: (\S+)$/.exec(line);
    assert.ok(pin && rows.length > 0, `unexpected line inside the matrix include rows: ${line}`);
    assert.ok(rows[rows.length - 1].version === "", `a matrix row may pin node-version exactly once: ${line}`);
    rows[rows.length - 1].version = pin[2];
  }
  assert.ok(rows.length > 0, "the matrix must declare at least one include row");
  for (const row of rows) {
    assert.ok(row.version !== "", "every matrix row must pair a node-major label with a node-version pin");
  }
  return rows;
}

/**
 * Enforce the stable per-major check identity on parsed matrix rows: exactly
 * the expected leg per supported major in order, each label a bare major, each
 * pin an exact `major.minor.patch` of that same major, and no duplicated,
 * collapsed, or missing leg. Applied to the real workflows and to deliberately
 * mutated sources, so the contract cannot pass vacuously.
 */
function assertMatrixIdentity(rows: MatrixRow[], expected: MatrixRow[], what: string): void {
  assert.deepEqual(rows, expected,
    `${what} must pair each stable major label with its exact pinned runtime, with no collapsed, missing, duplicated, or reordered leg`);
  assert.equal(new Set(rows.map((row) => row.label)).size, rows.length,
    `${what} labels must stay distinct: two rows sharing a label collapse two required contexts into one`);
  assert.equal(new Set(rows.map((row) => row.version)).size, rows.length,
    `${what} runtime pins must stay distinct: one leg per supported line`);
  for (const row of rows) {
    assert.match(row.label, /^\d+$/,
      `${what} labels must be a bare Node major, never a pinned patch version that renames the required context on every floor bump`);
    assert.match(row.version, /^\d+\.\d+\.\d+$/,
      `${what} runtime pins must stay exact major.minor.patch security floors, never a floating line`);
    assert.equal(row.version.split(".")[0], row.label,
      `${what} labels must name the major of the runtime they pin`);
  }
}

test("workflow triggers cover pull requests, main pushes, and manual dispatch", () => {
  const source = readWorkflow();
  const on = blockOf(source, "on", 0);
  assert.match(on, /^  pull_request:$/m, "pull_request must be enabled and unrestricted");
  assert.match(on, /^  workflow_dispatch:$/m, "manual dispatch must be enabled");
  assert.match(on, /^  push:$/m, "push must be enabled");
  const push = blockOf(source, "push", 2);
  assert.match(push, /^    branches:$/m);
  assert.match(push, /^      - main$/m, "push must be limited to main");
  assert.doesNotMatch(source, /pull_request_target/, "pull_request_target must stay absent");
});

test("workflow keeps least-privilege read-only permissions", () => {
  const source = readWorkflow();
  const permissions = blockOf(source, "permissions", 0);
  assert.match(permissions.trim(), /^contents:\s*read$/m);
  assert.doesNotMatch(permissions, /write|packages|id-token|deployments|statuses|checks/,
    "no write-scoped permission is allowed");
});

test("concurrency cancels only superseded pull-request heads, never drops merged commits on main", () => {
  const source = readWorkflow();
  const concurrency = blockOf(source, "concurrency", 0);
  assert.match(concurrency,
    /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/,
    "groups must be separated by event type and keyed by PR number for pull requests, falling back to the commit SHA: without the event separator a dispatch (or a PR branch named like a main SHA) could replace or cancel the pending push run of that SHA");
  assert.match(concurrency, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.doesNotMatch(source, /cancel-in-progress: *true/, "cancellation must stay limited to pull_request events");
  assert.doesNotMatch(concurrency, /github\.head_ref/, "grouping by head branch name lets same-named fork branches cancel each other's PR checks");
  assert.doesNotMatch(concurrency, /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
    "do not group the whole main branch into a single pending slot");
});

// --- Concurrency group collision simulation ---------------------------------
// The workflow has no YAML/expression evaluator dependency, so evaluate the
// exact `group:` template against synthetic event contexts and assert the
// invariants that keep queued runs from being dropped or cancelled by an
// unrelated event. Unknown expressions fail loudly so any change to the group
// is reviewed rather than silently accepted.

type EventContext = {
  eventName: "pull_request" | "push" | "workflow_dispatch";
  sha: string;
  headRef?: string;
  pullRequestNumber?: number;
};

function lookupExpressionPath(path: string, context: EventContext): unknown {
  const parts = path.split(".");
  if (parts[0] === "github") {
    if (parts.length === 2 && parts[1] === "workflow") return "CI"; // workflow name
    if (parts.length === 2 && parts[1] === "event_name") return context.eventName;
    if (parts.length === 2 && parts[1] === "sha") return context.sha;
    if (parts.length === 2 && parts[1] === "head_ref") return context.headRef ?? "";
    if (parts.length === 4 && parts[1] === "event" && parts[2] === "pull_request" && parts[3] === "number") {
      return context.pullRequestNumber; // unset for non-PR events
    }
  }
  throw new Error(`unsupported concurrency group expression path: ${path}`);
}

function evaluateGroupExpression(expression: string, context: EventContext): string {
  // GitHub expressions use `||` as a truthy fallback (empty values are falsy).
  for (const part of expression.split("||")) {
    const value = lookupExpressionPath(part.trim(), context);
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function concurrencyGroup(context: EventContext): string {
  const source = readWorkflow();
  const concurrency = blockOf(source, "concurrency", 0);
  const match = concurrency.match(/^  group: (.+)$/m);
  assert.ok(match, "expected a concurrency group line");
  return match[1].replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => evaluateGroupExpression(expression, context));
}

test("concurrency groups never collide across event types or distinct PRs", () => {
  const mainSha = "a".repeat(40);
  const otherMainSha = "b".repeat(40);

  // Distinct PR numbers keep distinct groups even when two forks open PRs
  // from identically named branches (the old head_ref-based group collided).
  const prOne = concurrencyGroup({ eventName: "pull_request", sha: "c".repeat(40), headRef: "feature-x", pullRequestNumber: 1 });
  const prTwoSameBranch = concurrencyGroup({ eventName: "pull_request", sha: "d".repeat(40), headRef: "feature-x", pullRequestNumber: 2 });
  assert.notEqual(prOne, prTwoSameBranch, "distinct PR numbers must not share a group even with the same branch name");

  // A new commit on the SAME PR shares its group so superseded heads cancel
  // only their own previous run.
  const prOneUpdated = concurrencyGroup({ eventName: "pull_request", sha: "e".repeat(40), headRef: "feature-x", pullRequestNumber: 1 });
  assert.equal(prOne, prOneUpdated, "a new commit on the same PR must share its group so superseded heads cancel");

  // Push and manual dispatch of the same main SHA keep separate groups, so a
  // queued or running dispatch can never replace the pending push run (the
  // event that invokes the future push-only publisher).
  const pushMain = concurrencyGroup({ eventName: "push", sha: mainSha });
  const dispatchMain = concurrencyGroup({ eventName: "workflow_dispatch", sha: mainSha });
  assert.notEqual(pushMain, dispatchMain, "a manual dispatch must not share the push group of the same SHA");

  // A PR whose head branch is literally named after a main SHA cannot cancel
  // that push's run.
  const prNamedLikeSha = concurrencyGroup({ eventName: "pull_request", sha: "f".repeat(40), headRef: mainSha, pullRequestNumber: 3 });
  assert.notEqual(prNamedLikeSha, pushMain, "a PR branch named after a main SHA must not share the push group");

  // Distinct merged commits on main keep distinct groups: with the default
  // pending policy ("single") a shared group would drop a queued run for one
  // merged commit when another is enqueued.
  const pushOther = concurrencyGroup({ eventName: "push", sha: otherMainSha });
  assert.notEqual(pushMain, pushOther, "distinct main pushes must not share a pending slot");
});

test("every action is pinned to an immutable commit SHA with a human version comment", () => {
  const uses = [...readWorkflow().matchAll(/uses: (\S+?@([0-9a-f]{40}))(?:\s+#\s*(\S+))?/g)]
    .map((match) => [match[1], match[3] ?? ""] as const);
  assert.ok(uses.length >= 4, "expected pinned checkout and setup-node in both jobs");
  for (const [reference, comment] of uses) {
    assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, `not an immutable SHA pin: ${reference}`);
    assert.match(comment, /^v\d/, `missing human version comment for ${reference}`);
  }
  assert.ok(uses.some(([reference]) => reference.startsWith("actions/checkout@")), "checkout must be pinned");
  assert.ok(uses.some(([reference]) => reference.startsWith("actions/setup-node@")), "setup-node must be pinned");
  assert.doesNotMatch(readWorkflow(), /uses: \S+@v\d/, "no floating version tags are allowed");
});

test("verify job keeps its stable check name, Node matrix, and fast tiers", () => {
  const source = readWorkflow();
  assert.match(source, /name: Verify \(Node \$\{\{ matrix\.node-major \}\}\)/);
  const verify = blockOf(source, "verify", 2);
  assert.deepEqual(matrixRows(verify).map((row) => row.version), ["22.23.5", "24.22.3", "26.13.1"],
    "each supported Node line runs once, at its exact patched security floor");
  assert.equal((verify.match(/run: npm run test:package/g) ?? []).length, 1,
    "the Node 26 entry joins the same matrix: no duplicate broad stage is added");
  assert.match(verify, /fail-fast: false/);
  assert.match(verify, /timeout-minutes: \d+/);
  assert.match(verify, /run: npm run check:static/);
  assert.match(verify, /fetch-depth: 0/,
    "the PR candidate check needs full first-parent history from the immutable baseline");
  assert.match(verify, /run: node scripts\/release\/pr-candidate\.cjs/,
    "the verify job runs the read-only per-build changelog candidate prediction");
  assert.match(verify, /run: npm run test:fast/);
  assert.match(verify, /run: npm run test:package/);
  assert.match(verify, /PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM: "1"/,
    "the fast tier needs no browser, so Chromium provisioning stays skipped");
  assert.match(verify, /node --test dist-test\/tests\/ci-workflow\.test\.js/,
    "the verify jobs exercise these workflow contract tests");
});

// --- Stable per-major CI check identities (issue #669 follow-up) ----------
// Required contexts are named from the matrix's explicit per-major labels, not
// from the pinned runtime versions: raising a line's patch or minor security
// floor keeps every required context satisfiable with no ruleset edit, while
// setup-node still installs (and logs) the exact pinned runtime. Adding or
// dropping a supported major stays a separate support decision that renames
// checks. These are source-level contracts, not proof of live ruleset state.

const VERIFY_ROWS: MatrixRow[] = [
  { label: "22", version: "22.23.5" },
  { label: "24", version: "24.22.3" },
  { label: "26", version: "26.13.1" },
];

test("Verify legs pair each stable major label with its exact pinned floor", () => {
  const source = readWorkflow();
  const verify = blockOf(source, "verify", 2);
  assert.match(source, /^    name: Verify \(Node \$\{\{ matrix\.node-major \}\}\)$/m,
    "the check name must render the stable per-major label, never the pinned runtime version");
  assertMatrixIdentity(matrixRows(verify), VERIFY_ROWS, "the three Verify legs");
  assert.match(verify, /^          node-version: \$\{\{ matrix\.node-version \}\}$/m,
    "setup-node must install each row's exact pinned runtime, not the label's major");
  assert.doesNotMatch(source, /^ {4}name: [^\n]*\d+\.\d+\.\d+/m,
    "no required-check name may embed a pinned version: every floor bump would rename the required contexts");
});

test("the Verify identity contract rejects mismatched, collapsed, or missing legs", () => {
  const source = readWorkflow();
  const check = () => assertMatrixIdentity(matrixRows(blockOf(source, "verify", 2)), VERIFY_ROWS, "the three Verify legs");
  const reject = (mutated: string, why: string) => {
    assert.notEqual(mutated, source, `the ${why} mutation must actually change the workflow text`);
    const mutatedRows = () => assertMatrixIdentity(matrixRows(blockOf(mutated, "verify", 2)), VERIFY_ROWS, "the three Verify legs");
    assert.throws(mutatedRows, `the Verify identity contract must reject ${why}`);
  };

  check();
  reject(source.replace("          - node-major: 24\n            node-version: 24.22.3",
    "          - node-major: 24\n            node-version: 26.13.1"),
  "a stable label pinned to another major's runtime");
  reject(source.replace("          - node-major: 26\n            node-version: 26.13.1",
    "          - node-major: 24\n            node-version: 24.22.3"),
  "a duplicated leg that collapses two required contexts into one");
  reject(source.replace("          - node-major: 26\n            node-version: 26.13.1\n", ""),
    "a dropped major that removes a required context");
  reject(source.replace("          - node-major: 26\n            node-version: 26.13.1",
    "          - node-major: 26\n            node-version: 26"),
  "a floating Node 26 line in place of the exact pinned floor");
  reject(source.replace("          - node-major: 22\n            node-version: 22.23.5",
    "          - node-major: 22.23.5\n            node-version: 22.23.5"),
  "a patch-level label that renames the required context on the next floor bump");
});

test("full-tests job runs for pull requests, default-branch pushes, and manual dispatch", () => {
  const source = readWorkflow();
  assert.match(source, /^  full-tests:$/m, "the job id must stay stable for downstream callers");
  const full = blockOf(source, "full-tests", 2);
  assert.match(
    full,
    /if: github\.event_name != 'push' \|\| github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
    "the condition must run the suite on every enforced trigger path with no hidden push-only skip",
  );
  assert.match(full, /name: Full suite \(Node 24\)/);
  assert.match(full, /^    timeout-minutes: 30\s*$/m,
    "the Linux full-suite job must keep an active, job-scoped 30-minute runtime cap (a commented-out value or a 30 on a prerequisite step must not pass)");
  assert.match(full, /^          node-version: 24\.22\.3$/m,
    "the full suite must select the exact patched Node 24 security floor, never a floating 24.x that a stale runner tool cache could satisfy");
  assert.doesNotMatch(full, /node-version: 24\.x/);
});

test("full-suite provisions Chromium with Linux OS dependencies, narrowly", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);
  assert.match(full, /run: npx playwright install --with-deps chromium/,
    "the browser needs its Linux system libraries on the runner");
  assert.doesNotMatch(full, /npx playwright install(?! --with-deps)/m,
    "do not install browsers without OS dependencies");
  const installStep = full.slice(full.indexOf("Install dependencies"), full.indexOf("Install Chromium"));
  assert.match(installStep, /PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM: "1"/,
    "npm ci must not double-provision the browser outside the --with-deps step");
  assert.doesNotMatch(source, /^env:/m,
    "the skip flag must stay scoped to the jobs/steps that want it, never global");
});

/**
 * The exact full-suite command line CI runs. Its coverage is the local
 * `npm run test:run` command — same dist-test/tests/*.test.js glob, same
 * four-file concurrency — plus two additive, CI-only diagnostics: a 5-minute
 * built-in per-test bound and the stderr-bound per-file progress reporter.
 */
const FULL_SUITE_COMMAND = "node --test --test-concurrency=4 --test-timeout=300000 --test-reporter=spec --test-reporter=./scripts/ci/test-file-progress.cjs --test-reporter-destination=stdout --test-reporter-destination=stderr dist-test/tests/*.test.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The body of the named `Full test suite` step: from its entry to the next step entry of any kind. */
function suiteStepOf(full: string): string {
  const stepIndex = full.indexOf("      - name: Full test suite");
  assert.ok(stepIndex !== -1, "the named Full test suite step must exist");
  const afterStepEntry = full.slice(stepIndex + 1);
  const nextStep = afterStepEntry.search(/^      - /m);
  return nextStep === -1 ? afterStepEntry : afterStepEntry.slice(0, nextStep);
}

/** The suite step must run exactly the documented command: unchanged coverage plus only the two CI-only diagnostics. */
function assertExactSuiteCommand(scope: string): void {
  assert.match(scope, new RegExp(`^        run: ${escapeRegExp(FULL_SUITE_COMMAND)}\\s*$`, "m"),
    "the Full test suite step must keep the exact suite command line: the same dist-test/tests/*.test.js glob and four-file concurrency as npm run test:run, plus only --test-timeout=300000 and the spec+progress reporter/destination pair; any other change alters coverage or diagnostics");
}

test("full-suite compiles the test bundle and runs the compiled suite without mutating live dist", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);
  assert.match(full, /run: npm run build:test/);
  assertExactSuiteCommand(suiteStepOf(full));
  // The CI-only diagnostics must be the built-in bound and the real in-repo
  // reporter, and the selection must stay exactly the local full suite's.
  assert.ok(existsSync(join(projectRoot, "scripts", "ci", "test-file-progress.cjs")),
    "the stderr-bound progress reporter must exist in the repository");
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const localRun = pkg.scripts?.["test:run"] ?? "";
  assert.match(localRun, /^node --test --test-concurrency=4 dist-test\/tests\/\*\.test\.js$/,
    "the local full-suite command these assertions compare against must stay the plain glob run");
  for (const fragment of ["--test-concurrency=4", "dist-test/tests/*.test.js"]) {
    assert.ok(FULL_SUITE_COMMAND.includes(fragment), `the CI command must keep the local suite's ${fragment}`);
  }
  for (const line of full.split("\n").filter((candidate) => candidate.includes("run:"))) {
    assert.doesNotMatch(line, /npm (?:run )?test(?![\w:-])/, `unsafe full-suite command: ${line.trim()}`);
    assert.doesNotMatch(line, /npm run build(?![\w:-])/, "CI must not rebuild live dist; use build:test");
    assert.doesNotMatch(line, /npm run test:integration|npm run test:serial/, `unexpected full-suite command: ${line.trim()}`);
  }
});

test("full-suite runtime is bounded by independent job and step timeouts", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);

  // Job-level cap: the exact active job property line at the 4-space YAML
  // mapping indent. Commented-out caps and a 30 scoped to a prerequisite
  // step's own timeout property must not satisfy the job guard.
  assert.match(full, /^    timeout-minutes: 30\s*$/m,
    "the Linux full-suite job must carry an active, job-scoped 30-minute cap");
  assert.doesNotMatch(full, /^ *timeout-minutes: 45\s*$/m,
    "the over-generous 45-minute cap must not return at job or step level");

  // Step-level cap scoped to the named suite step itself: a hang stops at 15
  // minutes without waiting on the job-level budget, while the other steps of
  // this job keep their own provisioning budget. The step body extends to the
  // next step entry of any kind (named or uses), not just another named step.
  const suiteStep = suiteStepOf(full);
  assert.match(suiteStep, /^        timeout-minutes: 15\s*$/m,
    "the Full test suite step must carry its own active 15-minute cap, scoped to that step only");
  // The timeouts bound runtime, not coverage: the bounded step must keep the
  // exact documented command line (same glob/concurrency as the local suite,
  // plus only the two CI-only diagnostics).
  assertExactSuiteCommand(suiteStep);
  assert.doesNotMatch(suiteStep, /continue-on-error/,
    "the bounded suite step must fail loudly instead of tolerating failure");
});

test("full-suite always provides the Pi agent-core runtime for the native outer-error regression", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);
  assert.match(full, /cp scripts\/ci\/pi-agent-runtime\/package\.json scripts\/ci\/pi-agent-runtime\/package-lock\.json "\$RUNNER_TEMP\/pi-agent-runtime\/"/,
    "the isolated runtime must install from the canonical locked manifest, not an ad-hoc package.json");
  assert.match(full, /rm -rf "\$RUNNER_TEMP\/pi-agent-runtime"/,
    "the runtime must be freshly installed into a clean runner-temp directory");
  assert.match(full, /npm ci --no-audit --no-fund/,
    "the runtime install must be a lockfile-exact ci; live range re-resolution breaks on upstream publish races");
  const manifest = JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-agent-runtime", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.["@earendil-works/pi-agent-core"], "1.5.2",
    "the runtime must be pinned to exact Pi 1.5.2 in the canonical manifest");
  const lock = JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-agent-runtime", "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-agent-core"]?.version,
    manifest.dependencies?.["@earendil-works/pi-agent-core"],
    "the lock must freeze the exact pinned runtime version, not a drifted one");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-agent-core"]?.version, "1.5.2",
    "the lock must freeze exact Pi 1.5.2, not a drifted version");
  assert.match(full, /PI_BROWSER_AGENT_RUNTIME=\$RUNNER_TEMP\/pi-agent-runtime\/node_modules\/@earendil-works\/pi-agent-core\/dist\/index\.js/,
    "the regression points at the installed agent-core entry, not a mock");
  assert.doesNotMatch(full, /continue-on-error/, "the runtime step must not be an optional skip");
});

// --- Pinned Pi UI runtime, real-host gate, and fd provisioning ---------------
// The full suite must exercise the real Pi native UI (issue #26): a locked
// full pi-coding-agent runtime installed in the runner temp, the real-host
// helpers pointed at it, the required-host gate on, and the fd file-finder
// provisioned for the native `@` picker. None of this ships as a package
// dependency, and none of it may silently skip.

const PI_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core",
] as const;

function fullJobBlock(): string {
  return blockOf(readWorkflow(), "full-tests", 2);
}

function readRootPackageJson(): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
}

function readRootLock(): { packages?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(projectRoot, "package-lock.json"), "utf8"));
}

function readPiUiRuntimeManifest(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-ui-runtime", "package.json"), "utf8"));
}

function readPiUiRuntimeLock(): { packages?: Record<string, { version?: string; dependencies?: Record<string, string> }> } {
  return JSON.parse(readFileSync(join(projectRoot, "scripts", "ci", "pi-ui-runtime", "package-lock.json"), "utf8"));
}

test("full-suite installs the locked Pi UI runtime, provisions fd, and requires real Pi hosts", () => {
  const full = fullJobBlock();

  // The locked full UI runtime installs from the canonical manifest, exactly
  // like the agent-core runtime, into the runner temp.
  assert.match(full, /Install pinned full Pi UI runtime/);
  assert.match(full, /cp scripts\/ci\/pi-ui-runtime\/package\.json scripts\/ci\/pi-ui-runtime\/package-lock\.json "\$RUNNER_TEMP\/pi-ui-runtime\/"/,
    "the UI runtime must install from the canonical locked manifest, not an ad-hoc package.json");
  assert.match(full, /rm -rf "\$RUNNER_TEMP\/pi-ui-runtime"/,
    "the UI runtime must be freshly installed into a clean runner-temp directory");
  assert.match(full, /npm ci --no-audit --no-fund/,
    "the runtime install must be a lockfile-exact ci; live range re-resolution breaks on upstream publish races");
  const manifest = readPiUiRuntimeManifest();
  const pin = manifest.dependencies?.["@earendil-works/pi-coding-agent"];
  assert.equal(pin, "1.5.2",
    "the UI runtime must be pinned to exact Pi 1.5.2 in the canonical manifest");
  const lock = readPiUiRuntimeLock();
  assert.equal(lock.packages?.[""]?.dependencies?.["@earendil-works/pi-coding-agent"], pin,
    "the UI runtime lock root must match the manifest's exact Pi version");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version, pin,
    "the UI runtime lock must freeze the exact pinned version, not a drifted one");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-tui"]?.version, pin,
    "the installed runtime must carry the pinned pi-tui peer for the real TUI components");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-agent-core"]?.version, pin,
    "the installed runtime must carry the same pinned pi-agent-core peer");

  // Real-host helpers point at the locked runtime; a missing host fails the
  // gated tests instead of silently skipping.
  assert.match(full, /PI_REVIEW_GATE_INSTALLED_AGENT=\$RUNNER_TEMP\/pi-ui-runtime\/node_modules\/@earendil-works\/pi-coding-agent/,
    "the real-host helpers must be pointed at the locked runtime, not ambient installs");
  assert.match(full, /PI_REVIEW_GATE_INSTALLED_PI_BIN=\$RUNNER_TEMP\/pi-ui-runtime\/node_modules\/\.bin/,
    "the command-path smoke must resolve the fresh npm-generated pi executable shim");
  assert.match(full, /PI_REVIEW_GATE_EXPECT_PI_VERSION=1\.5\.2/,
    "the installed-command smoke must assert exact Pi 1.5.2");
  assert.match(full, /PI_REVIEW_GATE_REQUIRE_PI_HOST=1/,
    "the full suite must require real Pi hosts: gated tests fail rather than skip when Pi is missing");
  assert.doesNotMatch(full, /continue-on-error/, "the runtime steps must not be optional");

  // The TUI smoke launches the built candidate through the public extension
  // seam; the candidate must be compiled into the runner temp, never into the
  // checkout's live dist.
  assert.match(full, /--outDir "\$RUNNER_TEMP\/review-gate-candidate\/dist"/,
    "the candidate extension must be built into scratch, never into the checkout's live dist");
  assert.match(full, /ln -sfn "\$GITHUB_WORKSPACE\/node_modules" "\$RUNNER_TEMP\/review-gate-candidate\/node_modules"/,
    "the candidate must reach the checkout's installed tree: the compiled entry resolves " +
    "playwright/linkedom/undici/... with plain Node resolution, which fails outside the checkout");
  assert.match(full, /ln -sfn "\$GITHUB_WORKSPACE\/scripts" "\$RUNNER_TEMP\/review-gate-candidate\/scripts"/,
    "the candidate loads packaged mode prompts from scripts/ at extension activation");
  assert.match(full, /PI_REVIEW_GATE_CANDIDATE_ENTRY=\$RUNNER_TEMP\/review-gate-candidate\/dist\/src\/index\.js/,
    "the smoke resolves the built candidate through an explicit test-only path");

  // The fd file-finder is provisioned for the native `@` picker; provisioning
  // failure fails the job, and the resolved path is exported so the @ test
  // never depends on ambient PATH variance.
  assert.match(full, /apt-get install -y --no-install-recommends fd-find/,
    "the full suite must provision the fd file-finder the native @ picker needs");
  assert.match(full, /command -v fd >\/dev\/null 2>&1 \|\| command -v fdfind >\/dev\/null 2>&1/,
    "the fd provisioning step must fail the job when no finder binary is available");
  assert.match(full, /PI_REVIEW_GATE_FD=\$\(command -v fd \|\| command -v fdfind\)/,
    "the resolved finder path must be exported so the @ test never depends on ambient PATH variance");

  // The gate must be scoped to required host jobs/steps, not preset globally.
  // Linux's full suite and the dedicated native Windows command smoke require
  // Pi; unrelated jobs retain their optional local-style host skips.
  for (const jobId of topLevelJobIds(readWorkflow())) {
    const job = blockOf(readWorkflow(), jobId, 2);
    const envBlock = job.match(/^    env:\n((?:      .*\n?)*)/m);
    if (!envBlock) continue;
    assert.doesNotMatch(envBlock[1], /PI_REVIEW_GATE_REQUIRE_PI_HOST/,
      `job ${jobId} must not preset PI_REVIEW_GATE_REQUIRE_PI_HOST; required-host gating stays scoped to the Linux full suite and Windows smoke step`);
  }

  // Nothing of the Pi runtime ships as a package dependency, and the root
  // lock never gains a Pi runtime entry.
  const pkg = readRootPackageJson();
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[section] ?? {};
    for (const name of PI_PACKAGES) {
      assert.equal(deps[name], undefined,
        `${section}.${name} would ship Pi as a package dependency; the UI runtime must stay a test-only CI install`);
    }
  }
  const rootLock = readRootLock();
  for (const name of PI_PACKAGES) {
    assert.equal(rootLock.packages?.[`node_modules/${name}`], undefined,
      `the root lock must not gain a Pi runtime entry (${name})`);
  }
});

test("both real-host @ picker cases honor the required-host CI gate", () => {
  for (const name of ["native-editor-bridge.test.ts", "user-question-editor-parity.test.ts"]) {
    const source = readFileSync(join(projectRoot, "tests", name), "utf8");
    const start = source.indexOf('test("real host: the fd-backed @ picker');
    assert.ok(start >= 0, `${name} must exercise the real Pi @ picker`);
    const next = source.indexOf("\ntest(", start + 5);
    const pickerCase = source.slice(start, next < 0 ? undefined : next);
    assert.match(pickerCase, /if \(!fdPath\) \{[\s\S]*?skipOrFail\(t,/,
      `${name} must fail instead of skip when fd is absent under the required-host gate`);
    assert.doesNotMatch(pickerCase, /\bt\.skip\(/,
      `${name} must not silently skip the picker under the required-host gate`);
  }
});

// --- Release publisher integration ------------------------------------------
// CI is the sole caller of the reusable prerelease builder. These assertions pin
// the caller's trust boundary: correct event/ref/repository, both required check
// jobs upstream, a closed three-name secret forwarding allowlist (never
// `secrets: inherit`), and a single narrowly-scoped write grant.

const RELEASE_JOB = "release";

function releaseJobBlock(): string {
  return blockOf(readWorkflow(), RELEASE_JOB, 2);
}

const RELEASE_IF = "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'rfairburn/pi-review-gate'";

function releaseJobCondition(): string {
  const release = releaseJobBlock();
  const match = release.match(/if: >-\n((?:.*\n)*?)(?:    permissions:|    uses:)/);
  assert.ok(match, "the release caller job must carry an explicit if: condition");
  return flattened(match[1]);
}

function topLevelJobIds(source: string): string[] {
  return [...source.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
}

function jobPermissions(jobBlock: string): string | null {
  const match = jobBlock.match(/^    permissions:\n((?:      .*\n?)*)/m);
  return match ? match[1] : null;
}

/** Every `uses: actions/setup-java@...` step block, up to the next step or job key. */
function setupJavaSteps(source: string): string[] {
  const lines = source.split("\n");
  const steps: string[] = [];
  lines.forEach((line, index) => {
    if (!/^\s*- uses: actions\/setup-java@/.test(line)) return;
    const body = [line];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === "") continue;
      if (next.length - next.trimStart().length <= 6) break;
      body.push(next);
    }
    steps.push(body.join("\n"));
  });
  return steps;
}

function callerReleaseConditions(): void {
  const source = readWorkflow();
  assert.match(source, /^  release:$/m, "the release caller job id must exist for the reusable publisher");
  const release = releaseJobBlock();
  assert.match(release, /uses: \.\/\.github\/workflows\/release\.yml$/m,
    "the caller must invoke the local reusable release workflow");
  assert.equal(flattened(releaseJobCondition()), RELEASE_IF,
    "the caller must pin the original push event, refs/heads/main, and this exact repository; PRs, manual dispatch, forks, and other refs must not reach the publisher");
  assert.doesNotMatch(release, /pull_request_target|workflow_dispatch|workflow_run/,
    "the publisher must not gain alternate trigger paths through the caller");
}

function callerRunsOnlyAfterAllRequiredChecks(): void {
  const source = readWorkflow();
  const release = releaseJobBlock();
  assert.match(release, /needs: \[verify, full-tests, windows-launcher, windows-shell, windows-session-host\]/,
    "the publisher must need Linux verification, both native Windows check jobs, and the native session-host alpha matrix");
  assert.match(source, /^  verify:$/m);
  assert.match(source, /^  full-tests:$/m);
  assert.match(source, /^  windows-shell:$/m);
  // GitHub evaluates a needed job as failure when it fails OR is skipped; the
  // implicit success() guard therefore blocks the publisher in both cases, but
  // only as long as the condition is not overridden.
  assert.doesNotMatch(release, /always\(\)|failure\(\)|cancelled\(\)/,
    "overriding the implicit success() guard would let failed or skipped checks publish");
  for (const neededJob of ["verify", "full-tests", "windows-launcher", "windows-shell", "windows-session-host"]) {
    const job = blockOf(source, neededJob, 2);
    assert.doesNotMatch(job, /continue-on-error/,
      `a continue-on-error step or job in ${neededJob} would convert failure into success upstream of the publisher`);
  }
}

/**
 * The closed allowlist of secret names the CI caller may forward to the reusable
 * publisher: exactly the three the protected `android-release` signing step reads.
 * Declaring and forwarding these names is the approved interface — the caller
 * still passes no other secret and no input, so `secrets: inherit` and every
 * other name stay forbidden.
 */
const ANDROID_SIGNING_SECRET_NAMES = [
  "ANDROID_SIGNING_KEYSTORE_BASE64",
  "ANDROID_SIGNING_PASSWORD",
  "ANDROID_SIGNING_ALIAS",
];

/** The caller's exact contiguous `secrets:` mapping, as it must appear verbatim. */
const callerSecretMappingLines = ANDROID_SIGNING_SECRET_NAMES
  .map((name) => `      ${name}: \${{ secrets.${name} }}`)
  .join("\n");

/** The callee's exact contiguous `on.workflow_call.secrets` declaration block. */
const calleeSecretDeclarationLines = ANDROID_SIGNING_SECRET_NAMES
  .map((name) => `      ${name}:\n        required: true`)
.join("\n");

/**
 * The COMPLETE nested `secrets:` mapping text written at `keyIndent` spaces
 * inside `container`, taken through the blank-line-aware `blockOf` helper: a
 * YAML mapping continues across empty lines, so every deeper-indented line —
 * including an entry separated from the approved ones by a blank line — is part
 * of the extracted block. Trailing blank lines are trimmed for exact comparison.
 */
function secretsMappingText(container: string, keyIndent: number): string {
  return blockOf(container, "secrets", keyIndent).replace(/\s+$/, "");
}

/**
 * Every entry name declared directly inside a secrets mapping block, in any
 * case and in either block or inline flow style, so an extra or renamed entry
 * cannot hide in text an extractor would otherwise ignore.
 */
function mappingEntryNames(block: string): string[] {
  return [...block.matchAll(/^      ([^\s:][^:]*):/gm)].map((match) => match[1].trim());
}

/** The caller release job's complete `secrets:` mapping, as [name, expression]. */
function callerSecretMapping(source: string): [string, string][] {
  const block = secretsMappingText(blockOf(source, RELEASE_JOB, 2), 4);
  const entries = [...block.matchAll(/^      ([^\s:][^:]*): (.+)$/gm)]
    .map((match) => [match[1].trim(), match[2].trim()] as [string, string]);
  assert.equal(entries.length, block.split("\n").length,
    "every line of the caller's secrets block must be one flat `name: value` mapping entry");
  return entries;
}

/**
 * The callee's complete `on.workflow_call.secrets` mapping text. Both levels use
 * the blank-line-aware `blockOf` helper, so neither `workflow_call` nor the
 * `secrets:` mapping can be truncated at an empty line.
 */
function calleeSecretsBlockText(source: string): string {
  const on = blockOf(source, "on", 0);
  const call = blockOf(on, "workflow_call", 2);
  assert.deepEqual([...call.matchAll(/^    ([a-z_]+):/gm)].map((match) => match[1]), ["secrets"],
    "on.workflow_call must declare only secrets: — no inputs and no other call surface");
  return secretsMappingText(call, 4);
}

/** A declaration body normalized for comparison: 8-space indent stripped, blanks trimmed. */
function dedentDeclaration(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/^ {8}/, "").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * The callee's consumed entries, as [name, declaration body]. Every declared
 * entry name is enumerated (any case or style), and a name whose value is not a
 * block body is counted as an entry without one, so nothing passes unconsumed.
 */
function calleeSecretDeclarations(source: string): [string, string][] {
  const block = calleeSecretsBlockText(source);
  const names = mappingEntryNames(block);
  assert.deepEqual([...names].sort(), [...ANDROID_SIGNING_SECRET_NAMES].sort(),
    "on.workflow_call.secrets must declare exactly the three approved names — no omission and no extra name in any case or flow style");
  const bodies = [...block.matchAll(/^      ([^\s:][^:]*):\n((?:        .*\n?)*)/gm)]
    .map((match) => [match[1].trim(), dedentDeclaration(match[2])] as [string, string]);
  assert.equal(bodies.length, names.length,
    "every declared secrets entry must be a block-style `name:` key carrying its own declaration body");
  return bodies;
}

/**
 * Caller side of the approved interface: exactly the three names, each forwarded
 * through its own exact named reference, with no inheritance, no extra secret,
 * and no input. Takes the source so the negative controls can mutate it.
 */
function assertCallerSecretAllowlist(source: string): void {
  const clean = withoutComments(source);
  assert.doesNotMatch(clean, /secrets:\s*inherit/,
    "inheriting caller secrets would widen the callee's blast radius beyond the three approved names");
  // The whole mapping is compared, not a recognized prefix of it: an appended,
  // renamed, lowercased, duplicated, or reformatted entry fails here.
  assert.equal(secretsMappingText(blockOf(clean, RELEASE_JOB, 2), 4), callerSecretMappingLines,
    "the caller's complete secrets mapping must be exactly the three pinned named forwardings");
  assert.equal((clean.match(/^    secrets:$/gm) ?? []).length, 1,
    "the release caller job is the only job in ci.yml that may pass secrets");
  assert.doesNotMatch(blockOf(clean, RELEASE_JOB, 2), /^    with:/m,
    "the caller must pass no inputs: the reusable publisher declares none");
  const names = callerSecretMapping(clean).map(([name]) => name);
  assert.deepEqual([...names].sort(), [...ANDROID_SIGNING_SECRET_NAMES].sort(),
    "the caller must forward exactly the three approved secret names — no omission, no extra name");
  assert.equal(new Set(names).size, ANDROID_SIGNING_SECRET_NAMES.length, "no duplicate forwarded name");
  for (const name of ANDROID_SIGNING_SECRET_NAMES) {
    const entry = callerSecretMapping(clean).find(([key]) => key === name);
    assert.ok(entry, `the caller must forward ${name}`);
    assert.equal(entry[1], `\${{ secrets.${name} }}`,
      `the caller must forward ${name} through its own exact named reference, not another name's or a non-secret expression`);
  }
  const references = [...clean.matchAll(/\bsecrets\.[A-Z0-9_]+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(references)].sort(), ANDROID_SIGNING_SECRET_NAMES.map((name) => `secrets.${name}`).sort(),
    "no other secret reference may appear anywhere in ci.yml");
}

/**
 * Callee side of the approved interface: the reusable publisher declares exactly
 * the three names, each `required: true`. Forwarding presence is what GitHub
 * validates here; the signer's own all-three non-empty gate stays the value check.
 */
function assertCalleeSecretDeclarations(source: string): void {
  const clean = withoutComments(source);
  assert.doesNotMatch(clean, /secrets:\s*inherit/, "the reusable builder must never inherit caller secrets");
  // Complete-mapping comparison first: the extracted block must equal the pinned
  // declarations byte for byte, so no declaration form the extractor does not
  // recognize can slip past the name and `required` checks below.
  assert.equal(calleeSecretsBlockText(clean), calleeSecretDeclarationLines,
    "on.workflow_call.secrets must contain exactly the three pinned required declarations — no omission, no extra or reformatted entry");
  for (const [name, body] of calleeSecretDeclarations(clean)) {
    assert.equal(body, "required: true",
      `${name} must be declared exactly required: true, so an unforwarded name fails the call instead of resolving empty`);
  }
}

function callerForwardsOnlySigningSecrets(): void {
  assertCallerSecretAllowlist(readWorkflow());
}

function calleeDeclaresRequiredSigningSecrets(): void {
  assertCalleeSecretDeclarations(readReleaseWorkflow());
}

function rootReadOnlyAndWriteOnlyPublisher(): void {
  const source = withoutComments(readWorkflow());
  const rootPermissions = blockOf(source, "permissions", 0);
  assert.match(rootPermissions.trim(), /^contents:\s*read$/m,
    "the workflow-level default must stay read-only");
  const release = releaseJobBlock();
  assert.match(jobPermissions(release) ?? "", /^      contents:\s*write$/m,
    "the release caller job must grant contents: write for release and tag creation");
  // Every job-level permissions block in the file: only the publisher may write.
  for (const jobId of topLevelJobIds(source)) {
    const jobPermissionsBlock = jobPermissions(blockOf(source, jobId, 2));
    if (!jobPermissionsBlock) continue;
    const grantsWrite = /write/.test(jobPermissionsBlock);
    assert.ok(jobId === RELEASE_JOB || !grantsWrite,
      `job ${jobId} must not carry a write-scoped permission`);
  }
  assert.doesNotMatch(source, /workflows:\s*write/,
    "GITHUB_TOKEN cannot obtain the workflows permission; the caller must not request it");
}

function reusableReleaseWorkflowMirrorsTheBoundary(): void {
  const source = withoutComments(readReleaseWorkflow());
  const on = blockOf(source, "on", 0);
  assert.match(on, /^  workflow_call:$/m, "the builder must stay reusable-workflow-call only");
  assert.doesNotMatch(on, /^  (push|pull_request|pull_request_target|workflow_dispatch|schedule|workflow_run):/m,
    "the builder must have no independent trigger path outside the CI caller");
  // Independent enforcement of the same trust boundary (reusable runs inherit the
  // caller's original event context, so the condition pins the triggering push).
  const expectedCondition = "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_type == 'branch' && github.repository == 'rfairburn/pi-review-gate'";
  for (const job of ["verify", "plan", "android-build", "android-sign", "release"]) {
    const block = blockOf(source, job, 2);
    const condition = flattened(block.match(/    if: >-\n((?:      .*\n)+)/)?.[1] ?? "");
    assert.ok(condition.includes(expectedCondition), `${job} must repeat the exact push/main/repository boundary`);
  }
  assert.doesNotMatch(source, /workflow_run/, "no workflow_run privilege chain");
  const concurrency = blockOf(source, "concurrency", 0);
  assert.match(concurrency, /group: release-publish-\$\{\{ github\.sha \}\}/,
    "one publication group per exact target SHA");
  assert.match(concurrency, /cancel-in-progress: false/,
    "an in-flight publication must never be auto-cancelled");
  const rootPermissions = blockOf(source, "permissions", 0);
  assert.match(rootPermissions.trim(), /^contents:\s*read$/m);
  assert.doesNotMatch(source, /workflows:\s*write|secrets:\s*inherit/,
    "no unsupported permission and no inherited secrets anywhere in the builder");
  const verify = blockOf(source, "verify", 2);
  assert.match(jobPermissions(verify) ?? "", /^      contents:\s*read$/m,
    "the builder's verify job stays read-only");
  const publish = blockOf(source, "release", 2);
  assert.match(publish, /needs: \[verify, plan, android-build, android-sign\]/);
  assert.match(jobPermissions(publish) ?? "", /^      contents:\s*write$/m,
    "the publish job is the only write grant, scoped to release and tag management");
  // Shared pins match CI; Android-only actions use verified immutable pins.
  const ciPins = pinnedActions(readWorkflow());
  const androidPins = new Set([
    "actions/setup-java@dded0888837ed1f317902acf8a20df0ad188d165",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  ]);
  for (const reference of pinnedActions(source)) {
    assert.ok(ciPins.has(reference) || androidPins.has(reference), `${reference} must match an independently verified immutable action pin`);
    assert.doesNotMatch(source, new RegExp(`uses: \\S+@v\\d`), "no floating version tags");
  }
  assert.ok(pinnedActions(source).size >= 2, "checkout and setup-node must be SHA-pinned in the builder");
}

test("release caller publishes only correct main pushes after all required checks", () => {
  callerReleaseConditions();
  callerRunsOnlyAfterAllRequiredChecks();
});

test("release caller forwards exactly the three signing secret names and carries the only write grant", () => {
  callerForwardsOnlySigningSecrets();
  rootReadOnlyAndWriteOnlyPublisher();
});

test("reusable release builder independently enforces the same trust boundary", () => {
  reusableReleaseWorkflowMirrorsTheBoundary();
});

test("reusable release builder declares exactly the three required signing secrets", () => {
  calleeDeclaresRequiredSigningSecrets();
});

// Negative controls for the approved forwarding interface. Every mutation is
// derived from the real workflow text and must be rejected by the same assertion
// the real file passes, so neither side of the contract can hold vacuously: a
// dropped name, an extra name in any case, an entry in inline flow style, a
// crossed or non-secret reference, a loosened `required`, a misplaced
// declaration, an added input, or broad inheritance all fail here. The mutations
// are pure string edits on in-memory copies: no file is written and no workflow
// is executed.
function rejectMutations(label: string, original: string, cases: [string, string][], check: (source: string) => void): void {
  assert.doesNotThrow(check.bind(null, original), `the real ${label} must satisfy its own contract`);
  for (const [caseLabel, mutated] of cases) {
    assert.notEqual(mutated, original, `the ${label}/${caseLabel} control must actually change the text before it is rejected`);
    assert.throws(() => check(mutated), `the ${label} contract must reject ${caseLabel}`);
  }
}

test("the caller secret allowlist rejects omissions, extras, crossed references, and inheritance", () => {
  const ci = readWorkflow();
  const secretsBlock = `    secrets:\n${callerSecretMappingLines}`;
  assert.ok(ci.includes(secretsBlock), "the caller mapping must be the pinned contiguous block");
  rejectMutations("caller", ci, [
    ["a dropped forwarded name", ci.replace(`      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_ALIAS }}\n`, "")],
    ["an extra forwarded name", ci.replace(secretsBlock, `${secretsBlock}\n      ANDROID_SIGNING_CERT_SHA256: \${{ secrets.ANDROID_SIGNING_CERT_SHA256 }}`)],
    ["an extra lowercase forwarded name", ci.replace(secretsBlock, `${secretsBlock}\n      extra_secret: \${{ secrets.extra_secret }}`)],
    ["an appended inline flow-style forwarded entry", ci.replace(secretsBlock, `${secretsBlock}\n      EXTRA_SECRET: { value: secret }`)],
    ["an extra forwarding after a blank line", ci.replace(secretsBlock, `${secretsBlock}\n\n      extra_secret: \${{ secrets.extra_secret }}`)],
    ["an inline flow forwarding after a blank line", ci.replace(secretsBlock, `${secretsBlock}\n\n      EXTRA_SECRET: { value: secret }`)],
    ["an approved name reformatted to inline flow style", ci.replace(`      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_ALIAS }}`, "      ANDROID_SIGNING_ALIAS: { value: alias }")],
    ["a duplicate forwarded name", ci.replace(secretsBlock, `${secretsBlock}\n      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_ALIAS }}`)],
    ["a crossed name mapping", ci.replace(`      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_ALIAS }}`, `      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_PASSWORD }}`)],
    ["a non-secret forwarded value", ci.replace(`      ANDROID_SIGNING_ALIAS: \${{ secrets.ANDROID_SIGNING_ALIAS }}`, `      ANDROID_SIGNING_ALIAS: \${{ vars.ANDROID_SIGNING_ALIAS }}`)],
    ["broad inheritance instead of named forwarding", ci.replace(secretsBlock, "    secrets: inherit")],
    ["a removed secrets block", ci.replace(`${secretsBlock}\n`, "")],
    ["an added input alongside the secrets", ci.replace("    uses: ./.github/workflows/release.yml", "    with:\n      release-number: main\n    uses: ./.github/workflows/release.yml")],
  ], assertCallerSecretAllowlist);
});

test("the reusable publisher's secret declarations reject omissions, extras, loosened required, and added inputs", () => {
  const release = readReleaseWorkflow();
  const declarationBlock = `    secrets:\n${calleeSecretDeclarationLines}`;
  assert.ok(release.includes(declarationBlock), "the callee declarations must be the pinned contiguous block");
  rejectMutations("callee", release, [
    ["a dropped declaration", release.replace(`      ANDROID_SIGNING_ALIAS:\n        required: true\n`, "")],
    ["an extra declared name", release.replace(declarationBlock, `${declarationBlock}\n      ANDROID_SIGNING_CERT_SHA256:\n        required: true`)],
    ["an appended lowercase declaration", release.replace(declarationBlock, `${declarationBlock}\n      extra_secret:\n        required: false`)],
    ["an appended inline flow-style declaration", release.replace(declarationBlock, `${declarationBlock}\n      EXTRA_SECRET: { required: false }`)],
    ["an extra declaration after a blank line", release.replace(declarationBlock, `${declarationBlock}\n\n      extra_secret:\n        required: false`)],
    ["an inline flow declaration after a blank line", release.replace(declarationBlock, `${declarationBlock}\n\n      EXTRA_SECRET: { required: false }`)],
    ["an approved name reformatted to inline flow style", release.replace("      ANDROID_SIGNING_ALIAS:\n        required: true", "      ANDROID_SIGNING_ALIAS: { required: true }")],
    ["a loosened required", release.replace(`      ANDROID_SIGNING_ALIAS:\n        required: true`, `      ANDROID_SIGNING_ALIAS:\n        required: false`)],
    ["a declaration without required", release.replace(`      ANDROID_SIGNING_ALIAS:\n        required: true`, "      ANDROID_SIGNING_ALIAS:")],
    ["a declaration moved beside workflow_call", release.replace(declarationBlock, "  secrets:\n    ANDROID_SIGNING_KEYSTORE_BASE64:\n      required: true")],
    ["an added inputs block", release.replace(declarationBlock, `    inputs:\n      release-number:\n        type: string\n${declarationBlock}`)],
    ["broad inheritance in the callee", release.replace(declarationBlock, "    secrets: inherit")],
  ], assertCalleeSecretDeclarations);
});
test("Android release isolates unsigned build, protected signing, and immutable transfer", () => {
  const source = withoutComments(readReleaseWorkflow());
  const build = blockOf(source, "android-build", 2);
  const signer = blockOf(source, "android-sign", 2);
  const publisher = blockOf(source, "release", 2);
  assert.match(build, /needs: \[verify, plan\]/);
  assert.match(build, /:client-core:test :app:assembleRelease -PreleaseNumber=/);
  assert.doesNotMatch(build, /secrets\.|contents: write/);
  assert.match(signer, /needs: \[plan, android-build\]/);
  assert.match(signer, /environment: android-release/);
  assert.doesNotMatch(signer, /npm |gradlew|cache:|contents: write/);
  assert.match(signer, /artifact-ids: \$\{\{ needs.android-build.outputs.artifact_id \}\}/);
  assert.match(publisher, /artifact-ids: \$\{\{ needs.android-sign.outputs.artifact_id \}\}/);
  for (const block of [signer, publisher]) {
    assert.match(block, /node scripts\/release\/android.cjs check-artifact/);
    assert.match(block, /ARTIFACT_DIGEST: \$\{\{ needs.android-(build|sign).outputs.artifact_digest \}\}/);
    assert.doesNotMatch(block, /run-id:|pattern:|overwrite:|continue-on-error/);
  }
  for (const secret of ["ANDROID_SIGNING_KEYSTORE_BASE64", "ANDROID_SIGNING_PASSWORD", "ANDROID_SIGNING_ALIAS"]) {
    assert.equal((source.match(new RegExp(`secrets\\.${secret}`, "g")) ?? []).length, 1);
    assert.ok(signer.includes(`secrets.${secret}`));
    assert.ok(!publisher.includes(`secrets.${secret}`));
  }
  assert.ok(signer.indexOf("android.cjs sdk") < signer.indexOf("secrets.ANDROID_SIGNING"));
  assert.doesNotMatch(source, /secrets: inherit|\.p12|\.keystore|path: \$\{\{ runner.temp \}\}\s*$/m);
  assert.match(releaseJobBlock(), /actions: read/, "caller must permit read-only immutable artifact lookup");
});

test("Android failures/skips cannot publish; only already-published verification skips builds", () => {
  const publisher = blockOf(withoutComments(readReleaseWorkflow()), "release", 2);
  const expression = flattened(publisher.match(/    if: >-\n((?:      .*\n)+)/)?.[1] ?? "");
  assert.match(expression, /needs.verify.result == 'success' && needs.plan.result == 'success'/);
  const evaluate = (outcome: string, build: string, sign: string, verify = "success", plan = "success") => {
    const values: Record<string, string> = {
      "needs.verify.result": verify, "needs.plan.result": plan,
      "needs.plan.outputs.outcome": outcome, "needs.android-build.result": build,
      "needs.android-sign.result": sign, "github.event_name": "push",
      "github.ref": "refs/heads/main", "github.ref_type": "branch", "github.repository": "rfairburn/pi-review-gate",
    };
    const substituted = expression.replace(/!cancelled\(\)/g, "true").replace(/needs\.[\w.-]+|github\.[\w.]+/g, (key) => {
      assert.ok(key in values, `unexpected workflow expression ${key}`);
      return JSON.stringify(values[key]);
    });
    return Function(`return (${substituted})`)() as boolean;
  };
  assert.equal(evaluate("build-draft", "success", "success"), true);
  assert.equal(evaluate("verify-published", "skipped", "skipped"), true);
  for (const outcome of ["build-draft", "verify-published"]) {
    for (const bad of ["failure", "cancelled", "skipped"]) {
      if (outcome === "build-draft" || bad !== "skipped") {
        assert.equal(evaluate(outcome, bad, "success"), false);
        assert.equal(evaluate(outcome, "success", bad), false);
      }
      assert.equal(evaluate(outcome, "success", "success", bad), false);
      assert.equal(evaluate(outcome, "success", "success", "success", bad), false);
    }
  }
  assert.equal(evaluate("unknown", "success", "success"), false);
  assert.match(publisher, /RELEASE_PLAN_OUTCOME: \$\{\{ needs.plan.outputs.outcome \}\}/);
  assert.match(publisher, /if: needs.plan.outputs.outcome == 'build-draft'\n        run: npm ci/);
});

// --- Native Windows session-host alpha matrix caller (issue #211) ----------
// ci.yml calls .github/workflows/session-host-alpha.yml as a read-only reusable
// workflow so the native Windows session-host legs become an enforced publication
// dependency instead of a parallel automatic matrix. These are source-level DAG
// and trust-boundary contracts. They are NOT proof of live GitHub state: the
// required-context names a called matrix actually produces, and the repository
// ruleset that requires them, can only be confirmed from a live run and the live
// ruleset, neither of which these tests can observe. They also do not claim that
// a required-context list alone rejects a fabricated skipped conclusion — the
// design instead keeps every automatic verification path unconditional.

const SESSION_HOST_CALLER_JOB = "windows-session-host";

function sessionHostCallerBlock(): string {
  return blockOf(readWorkflow(), SESSION_HOST_CALLER_JOB, 2);
}

/** Evaluate any workflow's top-level concurrency group template for a context. */
function evaluateConcurrencyGroup(source: string, context: EventContext): string {
  const start = source.indexOf("\nconcurrency:");
  assert.ok(start !== -1, "expected a top-level concurrency block");
  const concurrency = source.slice(start, source.indexOf("\njobs:"));
  const match = concurrency.match(/^  group: (.+)$/m);
  assert.ok(match, "expected a concurrency group line");
  return match[1].replace(/\$\{\{ (.+?) \}\}/g, (_, expression: string) => evaluateGroupExpression(expression, context));
}

test("ci calls the session-host alpha matrix as an unconditional read-only reusable job", () => {
  const source = readWorkflow();
  assert.ok(existsSync(sessionHostWorkflowPath),
    "the called matrix workflow must exist in the checkout: a missing callee fails closed at workflow-parse time, and a caller pointing at an absent file must never be tolerated");
  assert.match(source, new RegExp(`^  ${SESSION_HOST_CALLER_JOB}:$`, "m"),
    "the caller job id must stay stable for the publisher's needs list");
  const job = sessionHostCallerBlock();
  assert.match(job, /uses: \.\/\.github\/workflows\/session-host-alpha\.yml$/m,
    "the caller must invoke the local reusable matrix workflow by relative path");
  // Unconditional on every enforced trigger path: an `if:` here would be a way
  // to skip the native legs out of the publisher's dependency set, and a
  // `needs:` here would let an earlier failure skip the matrix instead of
  // reporting it.
  assert.doesNotMatch(job, /^ {4}(if|needs):/m,
    "the caller must carry no if:/needs: so the matrix runs on every enforced trigger path and can never be skipped out of the publisher's dependency set");
  assert.match(jobPermissions(job) ?? "", /^      contents:\s*read$/m,
    "the caller-side grant must stay read-only so the effective token cannot widen");
  assert.doesNotMatch(job, /^ {4}(secrets|with):/m,
    "no secret or input may be passed to the read-only verification matrix");
  assert.doesNotMatch(job, /runs-on:|steps:/,
    "a reusable-workflow job carries no runner or steps of its own");
  assert.doesNotMatch(job, /continue-on-error/,
    "the caller must not tolerate a failed matrix leg");
  // The caller itself must never be able to publish.
  assert.doesNotMatch(job, /contents:\s*write|gh release|uses: \.\/\.github\/workflows\/release\.yml/,
    "the verification caller must carry no publish path");
});

test("publication depends on all eight verification legs and the Windows matrix still runs once", () => {
  const source = readWorkflow();
  const alpha = readSessionHostWorkflow();
  const alphaOn = alpha.slice(alpha.indexOf("\non:"));
  // The matrix no longer starts on its own: ci.yml is the only automatic path,
  // so exactly one automatic Windows session-host matrix runs per CI run.
  assert.match(alphaOn.slice(0, alphaOn.indexOf("\npermissions:")), /^  workflow_call:$/m,
    "the matrix must stay callable by ci.yml");
  assert.doesNotMatch(alphaOn.slice(0, alphaOn.indexOf("\npermissions:")), /^  (pull_request|push):/m,
    "an independent pull_request/push trigger would run a duplicate automatic Windows matrix beside the caller");
  assert.match(alphaOn, /^  workflow_dispatch:$/m,
    "the targeted single-commit host run must remain available");

  // Eight real verification legs gate publication: three Verify floors, the full
  // suite, the two native Windows jobs, and the matrix's two Node lines.
  const verifyRows = matrixRows(blockOf(source, "verify", 2));
  assert.deepEqual(verifyRows.map((row) => row.version), ["22.23.5", "24.22.3", "26.13.1"],
    "three Verify legs at the exact patched floors");
  const alphaRows = matrixRows(blockOf(alpha, "windows-acceptance", 2));
  assert.deepEqual(alphaRows.map((row) => row.version), ["22.23.5", "24.22.3"],
    "the matrix contributes exactly two native legs");
  assert.equal(verifyRows.length + 1 + 2 + alphaRows.length, 8,
    "verify legs + full suite + two native Windows jobs + two native session-host legs = eight verification legs");
  const release = releaseJobBlock();
  for (const needed of ["verify", "full-tests", "windows-launcher", "windows-shell", SESSION_HOST_CALLER_JOB]) {
    assert.ok(release.includes(needed), `the publisher must still need ${needed}`);
  }
  // No duplicated full suite or Windows matrix inside the callee: it runs its
  // own focused native tiers only.
  assert.doesNotMatch(alpha, /npm run test:run|npm run test:integration|dist-test\/tests\/\*\.test\.js/,
    "the called matrix must stay focused; the full suite stays in full-tests");
  assert.equal((source.match(/runs-on: windows-latest/g) ?? []).length, 2,
    "ci.yml itself keeps exactly two automatic Windows jobs; the third native matrix arrives only through the callee");
});

test("matrix keeps its fail-closed prerequisites, pins, and deadlines while reused", () => {
  const alpha = readSessionHostWorkflow();
  assert.equal((alpha.match(/PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST: "1"/g) ?? []).length, 2,
    "both opt-in fail-closed native acceptance steps must survive the reuse conversion");
  for (const required of [
    "Real public Windows ConPTY Main acceptance (opt-in, fail-closed)",
    "Real source launcher acceptance (cmd and direct PowerShell, opt-in, fail-closed)",
    "Named-pipe broker/reporter/protocol component tests",
    "Pure Windows helper-contract tests",
    "Real pinned-provider Windows workspace completion regression",
  ]) {
    assert.ok(alpha.includes(`- name: ${required}`), `the reused matrix must retain the ${required} step`);
  }
  // Unchanged finite bounds and read-only posture.
  assert.match(alpha, /^    timeout-minutes: 45$/m, "the job budget must stay unchanged");
  assert.match(alpha, /timeout-minutes: 10\n/, "the Main acceptance step cap must stay unchanged");
  assert.match(alpha, /timeout-minutes: 20\n/, "the launcher acceptance step cap must stay unchanged");
  assert.doesNotMatch(alpha, /continue-on-error/, "no step may tolerate a missing prerequisite");
  // The matrix job itself stays unconditional, and the only step condition is
  // the launcher acceptance prerequisite gate pinned by
  // tests/session-host-windows-workflow.test.ts. It can only start the launcher
  // more often than before, never vacuously and never on a cancelled run.
  assert.doesNotMatch(withoutComments(alpha), /^ {2,6}if:/m,
    "no matrix job may carry a condition: a conditional job could be skipped out of the enforced dependency set");
  assert.equal((withoutComments(alpha).match(/^ {8}if: /gm) ?? []).length, 1,
    "the launcher acceptance prerequisite gate must stay the only step condition: no other enforced native leg may become skippable");
  assert.match(alpha, /^permissions:\n  contents: read$/m, "the reused matrix stays read-only");
  assert.doesNotMatch(alpha, /contents:\s*write|secrets:|workflows:/,
    "reuse must not add a write grant or any secret surface");
  const alphaPins = pinnedActions(alpha);
  const ciPins = pinnedActions(readWorkflow());
  for (const reference of alphaPins) {
    assert.ok(ciPins.has(reference), `${reference} must stay pinned identically to ci.yml`);
  }
  assert.ok(alphaPins.size >= 2, "checkout and setup-node must stay SHA-pinned");
});

test("matrix concurrency can never cancel the caller, another PR head, or a main publication run", () => {
  const source = readWorkflow();
  const alpha = readSessionHostWorkflow();
  const mainSha = "a".repeat(40);
  const contexts: EventContext[] = [
    { eventName: "push", sha: mainSha },
    { eventName: "workflow_dispatch", sha: mainSha },
    { eventName: "pull_request", sha: "c".repeat(40), headRef: "feature-x", pullRequestNumber: 7 },
  ];
  for (const context of contexts) {
    const caller = evaluateConcurrencyGroup(source, context);
    const callee = evaluateConcurrencyGroup(alpha, context);
    assert.notEqual(callee, caller,
      `the matrix must never share the caller's pending slot (${context.eventName})`);
    assert.ok(callee.startsWith("session-host-alpha-"), `unexpected matrix group: ${callee}`);
    assert.ok(caller.startsWith("ci-"), `unexpected caller group: ${caller}`);
  }
  // A matrix run of one event can never replace another event's run, and a
  // targeted dispatch can never cancel the main push that publishes.
  assert.notEqual(
    evaluateConcurrencyGroup(alpha, { eventName: "push", sha: mainSha }),
    evaluateConcurrencyGroup(alpha, { eventName: "workflow_dispatch", sha: mainSha }),
    "a manual matrix dispatch must not share the main push group"
  );
  assert.notEqual(
    evaluateConcurrencyGroup(alpha, { eventName: "pull_request", sha: "d".repeat(40), pullRequestNumber: 1 }),
    evaluateConcurrencyGroup(alpha, { eventName: "pull_request", sha: "e".repeat(40), pullRequestNumber: 2 }),
    "distinct PRs must not share a matrix group"
  );
  assert.match(alpha, /^  cancel-in-progress: false$/m,
    "the matrix must never cancel a run: PR supersession belongs to the caller's own PR-only cancellation");
  assert.doesNotMatch(withoutComments(source), /cancel-in-progress: *true/,
    "ci.yml cancellation must stay event-conditional so a main push is never cancelled");
});

test("failed, skipped, cancelled, missing, and stale matrix outcomes keep publication blocked", () => {
  const source = readWorkflow();
  const release = releaseJobBlock();
  const job = sessionHostCallerBlock();
  // Failed or cancelled matrix leg: the caller job's conclusion is derived from
  // the called workflow's jobs, and the publisher keeps GitHub's implicit
  // success() guard, so it cannot run on a failed or cancelled dependency.
  assert.doesNotMatch(release, /always\(\)|failure\(\)|cancelled\(\)|!cancelled\(\)/,
    "overriding the implicit success() guard would let a failed, cancelled, or skipped matrix publish");
  // Skipped: nothing on the enforced path may skip the matrix, so a skipped
  // dependency can only come from a real problem, which the implicit guard blocks.
  assert.doesNotMatch(job, /^ {4}if:/m, "a conditional caller could be skipped out of the dependency set");
  const alphaWorkflow = readSessionHostWorkflow();
  assert.doesNotMatch(withoutComments(alphaWorkflow), /^ {2,6}if:/m,
    "a conditional matrix job could be skipped out of the dependency set");
  const alphaStepConditions = withoutComments(alphaWorkflow).match(/^ {8}if: (.+)$/gm) ?? [];
  assert.equal(alphaStepConditions.length, 1,
    "only the launcher acceptance step may carry a condition, so no enforced native leg can be skipped out of the dependency set");
  assert.match(alphaStepConditions[0] ?? "", /\$\{\{ !cancelled\(\) && steps\.[a-z][a-z0-9_]*\.outcome == 'success' \}\}/,
    "the one condition must keep requiring a non-cancelled run and a successful prerequisite export, so a skipped launcher can only mean a real failure that already failed the job");
  assert.doesNotMatch(withoutComments(source), /secrets:\s*inherit/, "reuse must not widen the secret blast radius");
  // Missing: the callee must exist and stay read-only, or the whole run fails to
  // parse rather than publishing unverified.
  assert.ok(existsSync(sessionHostWorkflowPath), "the callee workflow must exist");
  // Stale: reuse adds no second publish path and no event that could publish a
  // commit other than the exact merged main SHA the publisher re-validates.
  assert.equal(flattened(releaseJobCondition()), RELEASE_IF,
    "the publisher condition must stay pinned to the original push/main/repository even with the extra dependency");
  assert.doesNotMatch(readSessionHostWorkflow(), /gh (release|pr merge|workflow run|repo deploy)|make release|npm publish/,
    "the reused matrix must not gain a publish path");
});

test("the six original CI check names stay stable and the new caller name is distinct", () => {
  const source = readWorkflow();
  const stableNames = [
    "name: Verify (Node ${{ matrix.node-major }})",
    "name: Full suite (Node 24)",
    "name: Windows launcher (Node 22)",
    "name: Windows shell (Node 24)",
    "name: Publish numbered prerelease",
  ];
  for (const name of stableNames) {
    assert.ok(source.includes(name), `existing check name must stay byte-identical: ${name}`);
  }
  const callerName = sessionHostCallerBlock().match(/^    name: (.+)$/m);
  assert.ok(callerName, "the caller job must carry an explicit stable name");
  assert.equal(callerName![1], "Session host alpha matrix",
    "the caller's stable name is the qualified-context prefix of the two matrix legs: Session host alpha matrix / Windows session host alpha (Node 22) and (Node 24)");
  assert.doesNotMatch(callerName![1], /Verify|Full suite|Windows launcher|Windows shell|Publish/,
    "the new caller's check name must not shadow an existing required-check name");
  // What the live contexts actually are (including the names the called matrix
  // contributes) is confirmed from a live run plus the ruleset, not from here.
});

test("windows launcher job runs the native .cmd coverage on every enforced trigger path", () => {
  const source = readWorkflow();
  const job = blockOf(source, "windows-launcher", 2);
  assert.match(source, /^  windows-launcher:$/m, "the job id must stay stable for downstream callers");
  assert.match(job, /runs-on: windows-latest/,
    "the .cmd launcher and helper need a genuinely native Windows runner");
  assert.match(job, /name: Windows launcher \(Node 22\)/,
    "the native job name keeps the stable per-major label, so a Node 22 patch or minor floor bump never renames this required context");
  assert.match(job, /^          node-version: 22\.23\.5$/m, "the patched Node 22 security floor must be exercised natively");
  assert.doesNotMatch(withoutComments(job), /22\.19\.0/, "the native job must not keep selecting or naming the superseded Node 22 floor");
  assert.match(job, /PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM: "1"/,
    "the launcher tier needs no browser, so Chromium provisioning stays skipped");
  assert.match(job, /run: npm run build:test/,
    "dist-test is not checked in: the job must compile the tests it runs");
  assert.match(job, /run: node --test dist-test\/tests\/launcher-cmd\.test\.js/,
    "the focused launcher test file (including native win32 cases) must run");
  assert.match(job, /run: npm run build$/m,
    "the launcher's development build seam must be validated with the native toolchain");
  assert.match(job, /run: node scripts\/check-docs\.cjs/,
    "the public docs surface must validate with the same deterministic rules");
  assert.doesNotMatch(job, /shellcheck/, "shellcheck is unavailable on Windows runners");
  for (const line of job.split("\n").filter((candidate) => candidate.includes("run:"))) {
    assert.doesNotMatch(line, /npm run test:run|npm run test:integration/,
      `the native job must stay focused on launcher coverage, not the full suite: ${line.trim()}`);
  }

  // Keep the pre-existing native Windows regression suites as required steps;
  // the installed-Pi smoke is additive, not a replacement for launcher/Git
  // checkpoint/child-process coverage.
  for (const requiredStep of [
    "Windows Git checkpoint native smoke",
    "Windows raw checkpoint regressions",
    "Windows exact source identity regressions",
    "Launcher tests (helper pipeline + native .cmd cases)",
    "Pi child launch tests (alias-independent, native Windows)",
    "Docs checker regression tests",
  ]) {
    assert.ok(job.includes(`- name: ${requiredStep}`), `native Windows job must retain ${requiredStep}`);
  }
});

test("bounded cleanup ownership regressions run natively after the unchanged launcher race tier", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  const launcherName = "Launcher tests (helper pipeline + native .cmd cases)";
  const cleanupName = "Bounded cleanup-lock ownership regressions (native Windows)";
  const launcher = withoutComments(stepOf(job, launcherName));
  const cleanup = withoutComments(stepOf(job, cleanupName));
  // These two existing YAML steps use single-line run values, not the block
  // scalars the sampling helper stepRunOf parses.
  assert.equal(launcher.match(/^        run: ([^\r\n]+)$/m)?.[1], "node --test dist-test/tests/launcher-cmd.test.js",
    "the original eight-racer tier keeps its exact command and concurrency");
  assert.equal(cleanup.match(/^        run: ([^\r\n]+)$/m)?.[1],
    "node --test --test-concurrency=1 dist-test/tests/prepare-application-cleanup-probe.test.js",
    "the complete ownership module runs separately and sequentially, without a case filter or retry");
  assert.ok(job.indexOf(`- name: ${cleanupName}`) > job.indexOf(`- name: ${launcherName}`),
    "the additional helper probes never precede or warm the original cold-launch tier");
  assert.doesNotMatch(cleanup, /^\s*if:|continue-on-error|timeout-minutes/m,
    "native ownership coverage is unconditional and adds no new timeout or error exemption");
  assert.match(job, /^    timeout-minutes: 20\s*$/m,
    "the existing Windows job budget is unchanged");
});

test("native Windows launcher job freshly installs and requires exact Pi 1.5.2 command-path coverage", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  const installStart = job.indexOf("      - name: Install fresh locked Pi runtime (native Windows)");
  const smokeStart = job.indexOf("      - name: Installed Pi command RPC and registration smoke (native Windows)");
  assert.ok(installStart >= 0, "the native job must install a separate full Pi runtime");
  assert.ok(smokeStart > installStart, "the native smoke must run after the fresh runtime install");
  const install = job.slice(installStart, smokeStart);
  assert.match(install, /Join-Path \$env:RUNNER_TEMP "pi-ui-runtime"/,
    "the Windows Pi runtime must live in RUNNER_TEMP, outside the checkout and developer profile");
  assert.match(install, /Remove-Item -LiteralPath \$runtime -Recurse -Force/,
    "the Windows runtime directory must be clean before installation");
  assert.match(install, /Copy-Item scripts\/ci\/pi-ui-runtime\/package\.json, scripts\/ci\/pi-ui-runtime\/package-lock\.json/,
    "the native install must use the canonical locked manifest");
  assert.match(install, /npm ci --no-audit --no-fund/,
    "the native runtime must be installed from the exact lock, not global/ambient Pi or a floating installer");
  const smoke = job.slice(smokeStart, job.indexOf("      - name:", smokeStart + 1));
  assert.match(smoke, /node --test dist-test\/tests\/pi-installed-launch\.test\.js/,
    "the native Windows host must run the actual installed-command RPC/registration smoke");
  assert.match(smoke, /dist-test\/tests\/session-host-native-editor-handoff\.test\.js/,
    "the same Windows step must prove universal handoff enablement and the Windows launch adaptation");
  assert.match(smoke, /PI_REVIEW_GATE_INSTALLED_PI_BIN: \$\{\{ runner\.temp \}\}\\pi-ui-runtime\\node_modules\\\.bin/,
    "the Windows smoke must resolve npm's actual installed pi.cmd bin directory");
  assert.match(smoke, /PI_REVIEW_GATE_INSTALLED_AGENT: \$\{\{ runner\.temp \}\}\\pi-ui-runtime\\node_modules\\@earendil-works\\pi-coding-agent/,
    "the Windows smoke must pin the exact installed package root");
  assert.match(smoke, /PI_REVIEW_GATE_CANDIDATE_ENTRY: \$\{\{ github\.workspace \}\}\\dist\\src\\index\.js/,
    "the Windows smoke must load the built candidate extension");
  assert.match(smoke, /PI_REVIEW_GATE_REQUIRE_PI_HOST: "1"/,
    "missing installed-host/bin/candidate prerequisites must hard-fail on Windows");
  assert.match(smoke, /PI_REVIEW_GATE_EXPECT_PI_VERSION: "1\.5\.2"/,
    "the native smoke must require the actual Pi CLI to report exact 1.5.2");
  assert.doesNotMatch(smoke, /continue-on-error|t\.skip\(/,
    "the native installed-command smoke is required, never an optional skip");

  const childStart = job.indexOf("      - name: Pi child launch tests (alias-independent, native Windows)");
  assert.ok(childStart > smokeStart, "the child adapter regressions must run against the installed runtime");
  const child = job.slice(childStart, job.indexOf("      - name:", childStart + 1));
  for (const name of ["PI_REVIEW_GATE_INSTALLED_PI_BIN", "PI_REVIEW_GATE_INSTALLED_AGENT", "PI_REVIEW_GATE_CANDIDATE_ENTRY"]) {
    assert.match(child, new RegExp(`${name}:`), `the real child cases must receive ${name}`);
  }
  assert.match(child, /PI_REVIEW_GATE_REQUIRE_PI_HOST: "1"/,
    "the real child registration cases must fail rather than skip missing Windows prerequisites");
  assert.match(child, /PI_REVIEW_GATE_EXPECT_PI_VERSION: "1\.5\.2"/,
    "the Windows real child cases must use the same exact 1.5.2 runtime");
  assert.match(child, /run: node --test dist-test\/tests\/pi-child-launch\.test\.js dist-test\/tests\/pi-child-teardown\.test\.js/,
    "native Windows must also exercise bounded reviewer, RPC executor, and recovery teardown");

  const shell = blockOf(readWorkflow(), "windows-shell", 2);
  for (const suite of [
    "dist-test/tests/background-shell-windows.test.js",
    "dist-test/tests/background-shell-jobs.test.js",
    "dist-test/tests/background-process-readiness.test.js",
    // #421: the real native PowerShell host probe behind shell parity.
    "dist-test/tests/native-powershell-support.test.js",
  ]) {
    assert.ok(shell.includes(suite), `the separate Windows shell cleanup suite must remain required: ${suite}`);
  }
});

test("native Windows child step includes production cancellation settlement and unknown-exception regressions", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  const child = withoutComments(stepOf(job, CHILD_LAUNCH_STEP));
  const suites = [
    "pi-child-launch",
    "pi-child-teardown",
    "pi-settlement-lineage-diagnostics",
    "review-cancellation-settlement",
    "review-cancellation-unknown",
  ].map((name) => `dist-test/tests/${name}.test.js`);
  assert.match(child, new RegExp(`^        run: ${escapeRegExp(`node --test ${suites.join(" ")}`)}\\s*$`, "m"),
    "#397 regressions must run in the same native step with all previous child-process coverage and no changed test flags");
  assert.doesNotMatch(child, /^        (?:if|continue-on-error|timeout-minutes):/m,
    "the required child step must not gain a skip, tolerated failure, or new timeout policy");
});

// --- Manual-dispatch compaction lineage sampling (#335 follow-up) ----------
// The exact-head diagnostic run of the settlement-lineage stage codes collected
// no refusal, so the workflow carries one finite sampling step. These assertions
// pin it as evidence collection and nothing else: inert on every required-check
// trigger path, exactly five fresh invocations of the one existing compiled case,
// every predetermined sample run regardless of an earlier failure, any failure
// failing the step, and no new configuration, model call, or deadline.

const SAMPLING_STEP = "Compaction lineage sampling (manual dispatch only)";
const CHILD_LAUNCH_STEP = "Pi child launch tests (alias-independent, native Windows)";
const COMPACTION_CASE_TITLE = "executor compaction recovery launches the default pi child through the same resolver";
const COMPACTION_SAMPLE_COUNT = 5;

/** One named step inside a job block: from its entry to the next step entry. */
function stepOf(jobBlock: string, stepName: string): string {
  const start = jobBlock.indexOf(`      - name: ${stepName}`);
  assert.ok(start >= 0, `the ${stepName} step must exist`);
  const after = jobBlock.slice(start + 1);
  const next = after.search(/^      - /m);
  return next === -1 ? after : after.slice(0, next);
}

/** Every step entry in a job block, in file order. */
function stepsOf(jobBlock: string): string[] {
  const steps: string[] = [];
  let current: string[] | null = null;
  for (const line of jobBlock.split("\n")) {
    if (/^      - /.test(line)) {
      if (current) steps.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/** A step's `env:` mapping lines, or the empty string when it declares none. */
function stepEnvOf(stepBlock: string): string {
  const match = stepBlock.match(/^        env:\n((?:          .*\n?)*)/m);
  return match ? match[1] : "";
}

/** A step's block-scalar `run:` body. */
function stepRunOf(stepBlock: string): string {
  const match = stepBlock.match(/^        run: \|\n((?:          .*\n?)*)/m);
  assert.ok(match, "the step must carry a block-scalar run body");
  return match[1];
}

/** The sampling loop body: from the counted `while` line to its own closing brace. */
function samplingLoopBody(run: string): string {
  const lines = run.split("\n");
  const start = lines.findIndex((line) => /^          while \(\$samples -lt \d+\) \{$/.test(line));
  assert.ok(start !== -1, "the samples must be driven by a counted while loop over $samples");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "          }") break;
    body.push(line);
  }
  assert.ok(body.length > 0, "the sampling loop must have a body");
  return body.join("\n");
}

test("compaction lineage sampling runs only on manual dispatch with the pinned Pi environment", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  assert.doesNotMatch(readWorkflow(), /^  [a-z-]*sampl[a-z-]*:$/m,
    "sampling must stay a step of the existing Windows launcher job, never a new job");
  assert.doesNotMatch(job, /^    if:/m,
    "the Windows launcher job itself must stay unconditional so every enforced trigger path keeps its required native coverage");

  const dispatchGated = stepsOf(job).filter((step) => /^        if: github\.event_name == 'workflow_dispatch'$/m.test(step));
  assert.equal(dispatchGated.length, 1, "exactly one Windows launcher step may be manual-dispatch gated");
  assert.ok(dispatchGated[0].includes(`- name: ${SAMPLING_STEP}`),
    "the manual-dispatch gate belongs to the compaction lineage sampling step alone");

  const step = stepOf(job, SAMPLING_STEP);
  assert.match(step, /^        if: github\.event_name == 'workflow_dispatch'\s*$/m,
    "the sampling step must be gated on the workflow_dispatch event alone");

  // Same pinned installed Pi 1.5.2 environment as the required child-launch step:
  // no new configuration surface, and missing prerequisites still hard-fail.
  const child = stepOf(job, CHILD_LAUNCH_STEP);
  assert.ok(job.indexOf(`- name: ${CHILD_LAUNCH_STEP}`) < job.indexOf(`- name: ${SAMPLING_STEP}`),
    "the samples must run against the installed runtime the child-launch step provisions");
  assert.equal(stepEnvOf(step), stepEnvOf(child),
    "the sampling step must reuse the child-launch step's pinned installed-Pi environment exactly: no new flags, no relaxed host gate");
  assert.match(stepEnvOf(step), /PI_REVIEW_GATE_REQUIRE_PI_HOST: "1"/,
    "missing installed-host prerequisites must fail the sample rather than skip it");
  assert.match(stepEnvOf(step), /PI_REVIEW_GATE_EXPECT_PI_VERSION: "1\.5\.2"/,
    "the samples must use the same exact Pi 1.5.2 runtime as the required native step");
  assert.doesNotMatch(step, /continue-on-error/,
    "a sampling failure must fail the step; it can never be tolerated into green");
  assert.doesNotMatch(step, /--model|API_KEY|OPENAI|ANTHROPIC|provider/i,
    "the samples must not add a provider or model call");

  // Bounded, and bounded only by this step: the job cap and every deadline inside
  // the tested process/lineage paths stay exactly as they were.
  assert.match(step, /^        timeout-minutes: 10\s*$/m,
    "the sampling step must carry its own finite cap");
  assert.match(job, /^    timeout-minutes: 20\s*$/m,
    "the Windows launcher job cap must stay exactly 20 minutes; the samples fit inside it");
  assert.doesNotMatch(stepRunOf(step), /--test-timeout|--test-concurrency|--test-only/,
    "the sampling command must not add or relax per-test bounds or selection beyond the anchored name pattern");
});

test("compaction lineage sampling runs five fixed fresh samples and fails on any failed sample", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  const run = stepRunOf(stepOf(job, SAMPLING_STEP));

  // The sampled case is the existing compiled case, selected by an anchored
  // exact-title pattern that matches exactly one test in the file. A rename must
  // fail here rather than turn every sample into a vacuous green.
  const testSource = readFileSync(join(projectRoot, "tests", "pi-child-launch.test.ts"), "utf8");
  const titles = [...testSource.matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(titles.includes(COMPACTION_CASE_TITLE),
    "the sampled case must keep its exact title in tests/pi-child-launch.test.ts");
  assert.doesNotMatch(COMPACTION_CASE_TITLE, /[.*+?^${}()|[\]\\]/,
    "the anchored-pattern assertions below assume a metacharacter-free case title");
  const titleAssignment = run.match(/^          \$title = '([^']+)'\s*$/m);
  assert.ok(titleAssignment, "the sampled case title must be pinned verbatim in the step");
  assert.equal(titleAssignment[1], COMPACTION_CASE_TITLE);
  assert.match(run, /^          \$pattern = '\^' \+ \$title \+ '\$'$/m,
    "the selection pattern must anchor the exact case title with ^ and $");
  assert.equal(titles.filter((title) => new RegExp(`^${COMPACTION_CASE_TITLE}$`).test(title)).length, 1,
    "the anchored pattern must select exactly the one sampled case");

  // Exactly one test invocation exists in the step: the five samples come from the
  // counted loop, never from duplicated, fallback, or retry command lines.
  const invocations = run.match(/^\s*node --test .*$/gm) ?? [];
  assert.equal(invocations.length, 1,
    "the step must contain exactly one test invocation: five samples come from the counted loop, never from repeated or fallback command lines");
  assert.match(invocations[0], /--test-name-pattern="\$pattern"/,
    "each sample must select the case through the anchored pattern");
  assert.match(run, /^          \$suite = 'dist-test\/tests\/pi-child-launch\.test\.js'\s*$/m,
    "the sampled suite must be the existing compiled child-launch file");
  assert.ok(invocations[0].trim().endsWith("$suite"),
    "each sample must run only that one existing compiled suite file, with no additional targets");
  assert.equal((run.match(/dist-test\/tests\/[\w.-]+/g) ?? []).length, 1,
    "exactly one compiled test file may be named anywhere in the step");
  assert.doesNotMatch(invocations[0], /--test-update|sed |perl |Set-Content|Out-File|Add-Content/,
    "the step must not rewrite the sampled test, its assertions, or its fixtures");

  // Fixed size, one increment per iteration, no early exit, accumulated failure.
  assert.match(run, new RegExp(`^          while \\(\\$samples -lt ${COMPACTION_SAMPLE_COUNT}\\) \\{$`, "m"),
    `the loop must be fixed at exactly ${COMPACTION_SAMPLE_COUNT} predetermined samples`);
  assert.equal((run.match(/-lt \d+/g) ?? []).length, 1, "the sample count must appear exactly once, as the loop bound");
  const loop = samplingLoopBody(run);
  assert.equal((loop.match(/\$samples\+\+/g) ?? []).length, 1,
    "one sample consumed per iteration: no sample is ever rerun");
  assert.doesNotMatch(loop, /^\s*(?:break|continue|exit)\b|;\s*(?:break|continue|exit)\b/m,
    "an earlier failure must never stop a later predetermined sample or leave the loop early");
  assert.match(loop, /\$ran = \(Test-Path[\s\S]*Select-String[\s\S]*-SimpleMatch -Quiet\)/,
    "a sample counts only when the anchored case actually ran: a filtered zero-test run must not report green");
  assert.equal((loop.match(/\$failed\+\+/g) ?? []).length, 2,
    "both failure paths must accumulate: a nonzero sample exit and a sample that ran no matching case");
  assert.match(run, /if \(\$failed -gt 0\) \{[\s\S]*exit 1/,
    "any accumulated sample failure must fail the step");
  assert.equal((run.match(/^\s*exit \d+$/gm) ?? []).length, 1,
    "the step exits exactly once, after every sample has run");
  assert.ok(run.indexOf("exit 1") > run.indexOf("fixed samples passed"),
    "the failure exit must come after the post-loop summary, never inside the sampling loop");
  assert.doesNotMatch(run, /\|\| *true|-RetryCount|retry/i, "no retry-for-green path is allowed anywhere in the step");
});

/**
 * Per-line Node security floors (November 2026 Node.js security releases).
 * A bare `>=22.23.5` would still admit unpatched 24.x and 26.x releases, so
 * the engine range distinguishes each supported line's floor while leaving
 * other majors' existing eligibility (23.x, 25.x, and later majors) unchanged.
 */
const NODE_ENGINE_RANGE = ">=22.23.5 <24.0.0 || >=24.22.3 <26.0.0 || >=26.13.1";

test("engine floor, CI minimum, and locked Pi fixtures stay consistent", () => {
  // Keep the package engine floors aligned with CI's per-line minimums; the
  // independently pinned Pi test runtimes retain their own version contracts.
  const pkg = readRootPackageJson();
  assert.equal(pkg.engines?.node, NODE_ENGINE_RANGE,
    "the package engine range must carry each supported line's patched security floor");
  const rootLock = readRootLock() as { packages?: Record<string, { engines?: { node?: string } }> };
  assert.equal(rootLock.packages?.[""]?.engines?.node, pkg.engines?.node,
    "the lock's root package must mirror the engine floor exactly");
  const source = readWorkflow();
  assert.deepEqual(matrixRows(blockOf(source, "verify", 2)).map((row) => row.version),
    ["22.23.5", "24.22.3", "26.13.1"],
    "CI's matrix must exercise each engine line's exact floor, never an older Node");
  assert.doesNotMatch(withoutComments(source), /node-version: 24\.x|22\.19\.0/,
    "no CI selection or check name may keep a floating Node 24 line or the superseded Node 22 floor");
  assert.match(source, /^          node-version: 22\.23\.5$/m,
    "the native Windows floor job must exercise the same patched Node 22 engine floor");
  // The independently useful agent-core fixture tracks Pi 1.5.2; the full
  // UI fixture tracks the alpha's Pi 1.5.2 pin, above its stable 1.0.4 minimum.
  const agentManifest = JSON.parse(
    readFileSync(join(projectRoot, "scripts", "ci", "pi-agent-runtime", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(agentManifest.dependencies?.["@earendil-works/pi-agent-core"], "1.5.2",
    "the agent-core runtime must stay pinned to the exact Pi 1.5.2 release");
  assert.equal(readPiUiRuntimeManifest().dependencies?.["@earendil-works/pi-coding-agent"], "1.5.2",
    "the Pi UI runtime must stay pinned to the exact Pi 1.5.2 release");
  // The sidebar's managed fallback default, the shipped TUI alias, and the
  // pinned full UI fixture are one Pi release: they may not drift apart.
  const managedDefault = /const PI_PROVISION_VERSION = "([\d.]+)"/u
    .exec(readFileSync(join(projectRoot, "scripts", "pi-review-sessions.cjs"), "utf8"))?.[1];
  assert.equal(managedDefault, readPiUiRuntimeManifest().dependencies?.["@earendil-works/pi-coding-agent"],
    "the managed fallback default and the pinned UI runtime must track the same exact Pi release");
  assert.equal(pkg.dependencies?.["pi-session-host-tui"], `npm:@earendil-works/pi-tui@${managedDefault}`,
    "the shipped TUI alias must pin the same exact Pi release as the managed fallback default");
});

test("Windows shell and the reusable release builder select the exact patched Node 24 floor", () => {
  // A floating 24.x can be satisfied by an older runner tool-cache entry, so
  // every remaining Node 24 selection names the exact patched floor.
  const shell = blockOf(readWorkflow(), "windows-shell", 2);
  assert.match(shell, /name: Windows shell \(Node 24\)/, "the Windows shell check name keeps naming its Node line");
  assert.match(shell, /^          node-version: 24\.22\.3$/m);
  const release = withoutComments(readReleaseWorkflow());
  const selections = [...release.matchAll(/^\s*node-version: (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual(selections, Array(5).fill("24.22.3"),
    "every builder, signer, planner, and publisher job must select the exact patched Node 24 floor");
});

test("Android release jobs select the pinned Temurin JDK with the exact vendor selector", () => {
  // actions/setup-java resolves a requested version that carries build metadata with
  // semver.compareBuild, so the canonical `21.0.9+10` label is never satisfied by the
  // vendor's `21.0.9+10.0.LTS` release and the cold job fails before any build. Every
  // setup-java step must quote the full vendor selector for that same JDK build; this
  // is a source-level contract, not proof of an installed tool.
  const source = withoutComments(readReleaseWorkflow());
  const steps = setupJavaSteps(source);
  assert.equal(steps.length, 3, "the builder, signer, and publisher each provision the pinned JDK");
  for (const step of steps) {
    assert.match(step, /^\s*- uses: actions\/setup-java@dded0888837ed1f317902acf8a20df0ad188d165 # v5\.0\.0$/m,
      "the JDK provisioner stays on its independently verified immutable pin");
    assert.match(step, /^\s*distribution: temurin$/m);
    assert.match(step, /^\s*java-version: '21\.0\.9\+10\.0\.LTS'$/m,
      "the selector must stay quoted so YAML keeps the vendor build metadata intact");
  }
  assert.doesNotMatch(source, /java-version:\s*'21\.0\.9\+10'/,
    "the unsatisfiable short label must not return anywhere in the release builder");
  assert.doesNotMatch(source, /java-version:\s*'?(?:latest|openjdk|21(?:\.x|\.\*)?)'?,?\s*$/im,
    "no floating major, wildcard, or latest JDK selection may replace the pinned build");
});

test("activation tests keep the default runtime role in CI", () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /^ *PI_REVIEW_GATE_RUNTIME_ROLE:.*$/m,
    "PI_REVIEW_GATE_RUNTIME_ROLE must stay unset so activation tests observe default behavior");
});

test("the native Windows storage step also runs the Network storage protection proofs (Refs #494)", () => {
  const job = blockOf(readWorkflow(), "windows-launcher", 2);
  const step = stepOf(job, "Protected peer state and native ACL storage (not terminal UI readiness)");
  assert.match(step, /^        timeout-minutes: 8$/m, "the step keeps its existing cap");
  const run = step.match(/^        run: (.+)$/m)?.[1] ?? "";
  for (const file of [
    "session-host-peer-state-permissions-windows-native",
    "session-host-network-peer-state-default",
    "session-host-storage-protection-windows-native",
  ]) {
    assert.ok(run.includes(`dist-test/tests/${file}.test.js`), `${file} runs in the native storage step`);
  }
  assert.match(run, /--test-concurrency=1 --test-timeout=120000/, "the native storage files stay serialized and bounded");
});

// Issue #277: the native interactive CLI hosting path is only proven on a real
// Windows host. These assertions pin the two additive native steps — one per
// existing Windows job — as unconditional executions of the two new compiled
// suites, and pin that the suites still exist as sources. Nothing here changes
// an existing check name, pin, or step.
const NATIVE_CLI_WINDOWS_SUITES = [
  "session-host-native-cli-windows-pty",
  "session-host-native-cli-windows-delivery",
];

for (const [jobId, stepName] of [
  // The step label names the job's stable per-major Node line, not a pinned
  // patch release, so raising that line's security floor never renames it.
  ["windows-launcher", "Native interactive CLI Windows ConPTY acceptance (Node 22)"],
  ["windows-shell", "Native interactive CLI Windows ConPTY acceptance (Node 24)"],
] as const) {
  test(`${jobId} natively runs the native interactive CLI ConPTY acceptance suites`, () => {
    const job = blockOf(readWorkflow(), jobId, 2);
    const step = stepOf(job, stepName);
    for (const suite of NATIVE_CLI_WINDOWS_SUITES) {
      assert.ok(step.includes(`dist-test/tests/${suite}.test.js`),
        `${suite} must run natively in the ${jobId} job`);
      assert.ok(existsSync(join(projectRoot, "tests", `${suite}.test.ts`)),
        `${suite} must exist as a test source for the ${jobId} step to compile`);
    }
    // The real ConPTY tier is required evidence on a Windows host: never a
    // conditional, a tolerated failure, or a step with its own new deadline.
    const command = withoutComments(step);
    assert.doesNotMatch(command, /^        (?:if|continue-on-error|timeout-minutes):/m,
      `the ${jobId} native CLI step stays unconditional with no new exemption or timeout`);
    assert.doesNotMatch(command, /--test-name-pattern|--test-only|skip/,
      `the ${jobId} native CLI step selects whole suites, never a narrowed subset`);
    assert.doesNotMatch(command, /--model|API_KEY|OPENAI|ANTHROPIC|provider/i,
      "the native CLI acceptance adds no provider or model call");
    // Both suites must be inside the job that already builds the test bundle.
    assert.match(job, /run: npm run build:test/, `${jobId} must compile the suites it runs`);
  });
}
