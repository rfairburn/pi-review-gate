import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

// Focused contract tests for .github/workflows/ci.yml. The workflow has no
// YAML parser dependency available, so these tests pin the invariants that CI
// correctness depends on with targeted structural assertions instead of
// snapshots: triggers, permissions, concurrency safety, action pins, browser
// prerequisites, and the full-suite command surface.

const projectRoot = join(dirname(__dirname), "..");
const workflowPath = join(projectRoot, ".github", "workflows", "ci.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
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
  assert.match(source, /name: Verify \(Node \$\{\{ matrix\.node-version \}\}\)/);
  const verify = blockOf(source, "verify", 2);
  assert.match(verify, /node-version: \[20\.x, 24\.x\]/, "both supported Node lines stay in the matrix");
  assert.match(verify, /fail-fast: false/);
  assert.match(verify, /timeout-minutes: \d+/);
  assert.match(verify, /run: npm run check:static/);
  assert.match(verify, /run: npm run test:fast/);
  assert.match(verify, /run: npm run test:package/);
  assert.match(verify, /PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM: "1"/,
    "the fast tier needs no browser, so Chromium provisioning stays skipped");
  assert.match(verify, /node --test dist-test\/tests\/ci-workflow\.test\.js/,
    "the verify jobs exercise these workflow contract tests");
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
  assert.match(full, /timeout-minutes: \d+/);
  assert.match(full, /node-version: 24\.x/);
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

test("full-suite compiles the test bundle and runs the compiled suite without mutating live dist", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);
  assert.match(full, /run: npm run build:test/);
  assert.match(full, /run: npm run test:run/);
  for (const line of full.split("\n").filter((candidate) => candidate.includes("run:"))) {
    assert.doesNotMatch(line, /npm (?:run )?test(?![\w:-])/, `unsafe full-suite command: ${line.trim()}`);
    assert.doesNotMatch(line, /npm run build(?![\w:-])/, "CI must not rebuild live dist; use build:test");
    assert.doesNotMatch(line, /npm run test:integration|npm run test:serial/, `unexpected full-suite command: ${line.trim()}`);
  }
});

test("full-suite always provides the Pi agent-core runtime for the native outer-error regression", () => {
  const source = readWorkflow();
  const full = blockOf(source, "full-tests", 2);
  assert.match(full, /@earendil-works\/pi-agent-core@\d+\.\d+\.\d+/,
    "the runtime must be pinned to an exact published version");
  assert.match(full, /PI_BROWSER_AGENT_RUNTIME=\$RUNNER_TEMP\/pi-agent-runtime\/node_modules\/@earendil-works\/pi-agent-core\/dist\/index\.js/,
    "the regression points at the installed agent-core entry, not a mock");
  assert.doesNotMatch(full, /continue-on-error/, "the runtime step must not be an optional skip");
});

test("activation tests keep the default runtime role in CI", () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /^ *PI_REVIEW_GATE_RUNTIME_ROLE:.*$/m,
    "PI_REVIEW_GATE_RUNTIME_ROLE must stay unset so activation tests observe default behavior");
});
