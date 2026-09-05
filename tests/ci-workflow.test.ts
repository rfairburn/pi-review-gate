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
const releaseWorkflowPath = join(projectRoot, ".github", "workflows", "release.yml");

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function readReleaseWorkflow(): string {
  return readFileSync(releaseWorkflowPath, "utf8");
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

// --- Release publisher integration ------------------------------------------
// CI is the sole caller of the reusable prerelease builder. These assertions pin
// the caller's trust boundary: correct event/ref/repository, both required check
// jobs upstream, GitHub's implicit success() guard intact, no inherited secrets,
// and a single narrowly-scoped write grant.

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

function callerRunsOnlyAfterBothRequiredChecks(): void {
  const source = readWorkflow();
  const release = releaseJobBlock();
  assert.match(release, /needs: \[verify, full-tests\]/,
    "the publisher must need both required check jobs");
  assert.match(source, /^  verify:$/m);
  assert.match(source, /^  full-tests:$/m);
  // GitHub evaluates a needed job as failure when it fails OR is skipped; the
  // implicit success() guard therefore blocks the publisher in both cases, but
  // only as long as the condition is not overridden.
  assert.doesNotMatch(release, /always\(\)|failure\(\)|cancelled\(\)/,
    "overriding the implicit success() guard would let failed or skipped checks publish");
  for (const neededJob of ["verify", "full-tests"]) {
    const job = blockOf(source, neededJob, 2);
    assert.doesNotMatch(job, /continue-on-error/,
      `a continue-on-error step or job in ${neededJob} would convert failure into success upstream of the publisher`);
  }
}

function callerPassesNoSecrets(): void {
  const source = withoutComments(readWorkflow());
  assert.doesNotMatch(source, /secrets:\s*inherit/,
    "the callee needs only the event's GITHUB_TOKEN (github.token context); inheriting caller secrets would widen the blast radius");
  assert.doesNotMatch(releaseJobBlock(), /^    (secrets|with):/m,
    "the caller job must not pass secrets or inputs to the reusable publisher");
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
  const conditions = [...source.matchAll(/if: >-\n((?:.*\n)*?)(?:    runs-on:)/g)].map((match) => flattened(match[1]));
  assert.ok(conditions.length >= 2, "both the verify and publish jobs must re-validate the boundary");
  for (const condition of conditions) {
    assert.equal(condition, expectedCondition);
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
  assert.match(publish, /needs: verify/);
  assert.match(jobPermissions(publish) ?? "", /^      contents:\s*write$/m,
    "the publish job is the only write grant, scoped to release and tag management");
  // Same immutable action pins as CI, so the builder cannot drift to floating refs.
  const ciPins = pinnedActions(readWorkflow());
  for (const reference of pinnedActions(source)) {
    assert.ok(ciPins.has(reference), `${reference} must match a SHA pinned in ci.yml`);
    assert.doesNotMatch(source, new RegExp(`uses: \\S+@v\\d`), "no floating version tags");
  }
  assert.ok(pinnedActions(source).size >= 2, "checkout and setup-node must be SHA-pinned in the builder");
}

test("release caller publishes only correct main pushes after both required checks", () => {
  callerReleaseConditions();
  callerRunsOnlyAfterBothRequiredChecks();
});

test("release caller passes no secrets and carries the only write grant", () => {
  callerPassesNoSecrets();
  rootReadOnlyAndWriteOnlyPublisher();
});

test("reusable release builder independently enforces the same trust boundary", () => {
  reusableReleaseWorkflowMirrorsTheBoundary();
});

test("activation tests keep the default runtime role in CI", () => {
  const source = readWorkflow();
  assert.doesNotMatch(source, /^ *PI_REVIEW_GATE_RUNTIME_ROLE:.*$/m,
    "PI_REVIEW_GATE_RUNTIME_ROLE must stay unset so activation tests observe default behavior");
});
