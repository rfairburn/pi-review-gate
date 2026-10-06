// Issue #217 regression coverage: a same-workspace Git parent review
// checkpoint captured from a Pi session whose cwd is NESTED inside a Git
// repository is rooted at the repository top level (baseline.cwd stays the
// nested session cwd). The background controller's parent-checkpoint guard
// must resolve that verified repository root for admission, the landing
// boundary comparison and selective advancement instead of handing the nested
// cwd to the Git checkpoint engine (which refuses it as `not_repository_root`
// and so rejected every execute Start/Add before worker capture).
//
// Everything here is synthetic and model-free: the Pi, Codex, Claude and
// arbitrary-binary routes are real configured route selections resolved by
// the real adapter factory, but each launches a local stub executable instead
// of a model CLI, so no credentials, network or installed agent is used. The
// guard is route-independent controller code that runs before any adapter;
// the stubs only prove each configured route got past it into worker capture
// and adapter launch with the nested child cwd preserved.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { loadGitCheckpoint } from "../src/git-checkpoint";
import { captureReviewCheckpoint, compareReviewCheckpoints, type ReviewCheckpointDescriptor } from "../src/review-checkpoint";
import {
  BackgroundExecutionController,
  type BackgroundInspection,
  type BackgroundTaskDefinition,
} from "../src/execution/background-controller";
import { isActiveTaskState } from "../src/execution/task-state";
import { activeExchangeBaseline, beginAgentRun, createState, rememberUserRequest, setReviewWindowCheckpointBaseline, type ReviewGateState } from "../src/state";
import { initGitRepo, waitFor } from "./helpers/background-controller-fixtures";
import { disposableAgentDir, testCheckpointScope } from "./checkpoint-scope-helpers";

// #301: raw records live in this disposable agent dir's session namespace.
const checkpointScope = testCheckpointScope(disposableAgentDir(), "nested-parent-session");

const NESTED = "pkg";
const GUARD_REFUSAL = /Parent checkpoint guard refused|not_repository_root/;

function task(title: string, instructions: string): BackgroundTaskDefinition {
  return { title, instructions, acceptanceCriteria: [`${title} marker landed`] };
}

/** Execute-task definition as the SubtasksStart/SubtasksAdd tool layer
 *  produces it: with the authoritative parent-derived tool catalog the Pi
 *  route requires for native --tools enforcement. */
function routedTask(title: string, instructions: string): BackgroundTaskDefinition {
  const tools = ["read", "edit", "write"];
  return { ...task(title, instructions), executorToolCatalog: { allowedToolCatalog: tools, initialActiveTools: tools } };
}

/** A synthetic repository with a nested package directory and a sibling. */
async function nestedRepository(prefix: string): Promise<{ repo: string; nested: string }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await mkdir(join(repo, NESTED));
  await mkdir(join(repo, "other"));
  await initGitRepo(repo, {
    "base.txt": "base\n",
    [`${NESTED}/inner.txt`]: "inner\n",
    "other/sibling.txt": "sibling\n",
  });
  return { repo, nested: join(repo, NESTED) };
}

async function armCheckpoint(state: ReviewGateState, cwd: string, id: string): Promise<ReviewCheckpointDescriptor> {
  const armed = await captureReviewCheckpoint(cwd, id, { scope: checkpointScope });
  assert.equal(armed.status, "ok", JSON.stringify(armed));
  if (armed.status !== "ok") throw new Error("checkpoint arm failed");
  assert.equal(armed.value.kind, "git", "a nested Git cwd must record a Git checkpoint");
  setReviewWindowCheckpointBaseline(state, { kind: "checkpoint", descriptor: armed.value, cwd, capturedAt: new Date().toISOString() });
  return armed.value;
}

function parentState(): ReviewGateState {
  const state = Object.assign(createState(), { checkpointScope });
  rememberUserRequest(state, "run subtasks while I keep editing the parent workspace");
  beginAgentRun(state);
  return state;
}

/** The frozen repository-scope checkpoint difference the next primary review sees. */
async function checkpointDiff(state: ReviewGateState, cwd: string): Promise<string[]> {
  const baseline = activeExchangeBaseline(state);
  assert.equal(baseline?.kind, "checkpoint");
  if (baseline?.kind !== "checkpoint") throw new Error("missing checkpoint");
  const current = await captureReviewCheckpoint(cwd, `test-current-${Date.now()}-${Math.random().toString(16).slice(2)}`, { scope: checkpointScope });
  assert.equal(current.status, "ok");
  if (current.status !== "ok") throw new Error("missing checkpoint");
  const compared = await compareReviewCheckpoints(cwd, baseline.descriptor, current.value, { scope: checkpointScope });
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  return compared.status === "ok" ? compared.value.changes.map((change) => change.path).sort() : [];
}

async function settled(controller: BackgroundExecutionController, executionId: string, taskId: string): Promise<BackgroundInspection["tasks"][number]> {
  await waitFor(() => {
    const current = controller.inspect(executionId, taskId).tasks.find((candidate) => candidate.taskId === taskId);
    return current !== undefined && !isActiveTaskState(current.state);
  }, 60_000);
  return controller.inspect(executionId, taskId).tasks.find((candidate) => candidate.taskId === taskId)!;
}

function taskText(record: BackgroundInspection["tasks"][number]): string {
  return [record.error, record.summary, ...(record.activity ?? []).map((event) => event.message)].filter(Boolean).join("\n");
}

type Route = "pi" | "codex" | "claude" | "binary";
const ROUTES: readonly Route[] = ["pi", "codex", "claude", "binary"];

/** A stub executable that records its launch (route and cwd) and exits. */
async function writeRecordingStub(dir: string, name: string, route: Route, marker: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({route:${JSON.stringify(route)},cwd:process.cwd()})+'\\n');`,
    "process.stderr.write('synthetic stub executor: no model is available here\\n');",
    "process.exit(1);",
  ].join("\n"), "utf8");
  await chmod(path, 0o755);
  return path;
}

function routeConfig(route: Route, stub: string): ReviewGateConfig {
  const external = route === "codex"
    ? { "route-stub": { adapter: "codex-cli" as const, command: stub, execution: { model: "stub-model" } } }
    : route === "claude"
      ? { "route-stub": { adapter: "claude-cli" as const, command: stub, execution: { model: "stub-model" } } }
      : route === "binary"
        ? { "route-stub": { adapter: "run-as-binary" as const, command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [stub] } } }
        : {};
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: external,
    execution: {
      maxWorkers: 1,
      workerResources: {
        "default": {
          selection: route === "pi" ? { source: "pi", model: "stub-provider/stub-model" } : { source: "external", id: "route-stub" },
          maxConcurrent: 1,
        },
      },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

async function launches(marker: string): Promise<Array<{ route: Route; cwd: string }>> {
  const text = await readFile(marker, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { route: Route; cwd: string });
}

test("precondition: the nested session cwd is not the Git checkpoint root the engine accepts", async () => {
  const { repo, nested } = await nestedRepository("pi-review-nested-precondition-");
  try {
    const state = parentState();
    const descriptor = await armCheckpoint(state, nested, "nested-precondition");
    if (descriptor.kind !== "git") throw new Error("expected git descriptor");
    const fromNested = await loadGitCheckpoint(nested, descriptor.checkpoint);
    assert.notEqual(fromNested.status, "ok");
    if (fromNested.status !== "ok") assert.equal(fromNested.reason, "not_repository_root");
    assert.equal((await loadGitCheckpoint(repo, descriptor.checkpoint)).status, "ok");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

for (const route of ROUTES) {
  test(`nested Git parent checkpoint admits ${route} route Start and Add into worker capture and adapter launch`, async () => {
    const { repo, nested } = await nestedRepository(`pi-review-nested-route-${route}-`);
    const stubs = await realpath(await mkdtemp(join(tmpdir(), `pi-review-nested-stub-${route}-`)));
    const marker = join(stubs, "launches.jsonl");
    const stub = await writeRecordingStub(stubs, route === "pi" ? "pi" : `${route}-stub`, route, marker);
    const originalPath = process.env.PATH;
    // The Pi adapter launches the default `pi` command; resolve it to the
    // recording stub for this test only (no installed Pi or model is used).
    if (route === "pi") process.env.PATH = `${stubs}${delimiter}${originalPath ?? ""}`;
    let controller: BackgroundExecutionController | undefined;
    try {
      const state = parentState();
      const armed = await armCheckpoint(state, nested, `nested-route-${route}`);
      // Pre-existing parent edits inside and above the nested cwd.
      await writeFile(join(nested, "parent.txt"), "nested parent edit\n");
      await writeFile(join(repo, "other", "sibling.txt"), "sibling parent edit\n");
      controller = new BackgroundExecutionController({ config: routeConfig(route, stub), state, cwd: () => nested, pi: {} });

      const started = await controller.start([routedTask(`${route} start`, "NESTED_ROUTE_START")]);
      const first = await settled(controller, started.executionId, started.tasks[0]!.taskId);
      assert.doesNotMatch(taskText(first), GUARD_REFUSAL, `${route} Start must not be refused by the parent checkpoint guard`);
      assert.ok(first.waveRoot, `${route} Start must reach worker capture`);
      const afterStart = await launches(marker);
      assert.ok(afterStart.length >= 1, `${route} Start must launch its configured adapter past the guard: ${taskText(first)}`);

      const added = await controller.add(started.executionId, [routedTask(`${route} add`, "NESTED_ROUTE_ADD")]);
      const addedId = added.addedTaskIds?.[0] ?? added.tasks.at(-1)!.taskId;
      const second = await settled(controller, started.executionId, addedId);
      assert.doesNotMatch(taskText(second), GUARD_REFUSAL, `${route} Add must not be refused by the parent checkpoint guard`);
      assert.ok(second.waveRoot, `${route} Add must reach worker capture`);
      const all = await launches(marker);
      assert.ok(all.length > afterStart.length, `${route} Add must launch its configured adapter past the guard`);

      for (const launch of all) {
        assert.equal(launch.route, route);
        // The child runs in the isolated worktree at the same nested relative
        // cwd, never in the source checkout.
        const cwd = launch.cwd;
        assert.ok(cwd.endsWith(`${sep}${NESTED}`), `child cwd keeps the nested relative directory: ${cwd}`);
        const fromRepo = relative(repo, cwd);
        assert.ok(fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo), `child cwd must not be inside the source checkout: ${cwd}`);
      }
      // Nothing landed; the parent's own edits (nested and sibling) stay reviewable
      // against the untouched owner.
      const baseline = activeExchangeBaseline(state);
      assert.equal(baseline?.kind === "checkpoint" ? baseline.descriptor : undefined, armed, "the parent owner is not replaced");
      assert.deepEqual(await checkpointDiff(state, nested), ["other/sibling.txt", `${NESTED}/parent.txt`]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await controller?.shutdown().catch(() => undefined);
      await controller?.detach().catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
      await rm(stubs, { recursive: true, force: true });
    }
  });
}

/** Binary executor that lands a nested file and also edits the sibling above the nested cwd. */
async function writeLandingExecutor(dir: string): Promise<string> {
  const script = join(dir, "nested-landing-executor.cjs");
  await writeFile(script, [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    "process.stdin.on('end',()=>{",
    "if(prompt.includes('NESTED_LAND')){",
    "fs.writeFileSync('landed.txt','landed\\n');",
    "const sibling=require('node:path').join('..','other','sibling.txt');",
    "if(fs.existsSync(sibling))fs.appendFileSync(sibling,'worker addition\\n');",
    "}",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
  ].join("\n"), "utf8");
  await chmod(script, 0o755);
  return script;
}

function landingConfig(script: string, policy: "off" | "reviewed" | "unreviewed"): ReviewGateConfig {
  const reviewed = policy === "reviewed";
  return normalizeConfig({
    enabled: true,
    review: {
      activeReviewers: reviewed ? [{ source: "external", id: "passing" }] : [],
      ...(policy === "off" ? {} : { reviewLandedChanges: true }),
    },
    externalAgents: {
      "nested-landing": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
      },
      ...(reviewed ? {
        "passing": {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: {
            args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})),100))"],
            timeoutMs: 5000,
          },
        },
      } : {}),
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: "nested-landing" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

for (const where of ["nested", "root"] as const) {
  for (const policy of ["off", "reviewed", "unreviewed"] as const) {
    test(`${where} Git parent checkpoint: ${policy} landing advances only eligible repository-relative paths`, async () => {
      const { repo, nested } = await nestedRepository(`pi-review-nested-land-${where}-${policy}-`);
      const scripts = await realpath(await mkdtemp(join(tmpdir(), "pi-review-nested-land-script-")));
      const sessionCwd = where === "nested" ? nested : repo;
      // Worker-relative paths: in the root control the worker cwd is the repo
      // top level, so its edits land at the top level instead.
      const landed = where === "nested" ? `${NESTED}/landed.txt` : "landed.txt";
      let controller: BackgroundExecutionController | undefined;
      try {
        const script = await writeLandingExecutor(scripts);
        const state = parentState();
        const armed = await armCheckpoint(state, sessionCwd, `nested-land-${where}-${policy}`);
        await writeFile(join(nested, "parent.txt"), "nested parent edit\n");
        await writeFile(join(repo, "other", "sibling.txt"), "sibling parent edit\n");
        controller = new BackgroundExecutionController({ config: landingConfig(script, policy), state, cwd: () => sessionCwd, pi: {} });
        const started = await controller.start([task("nested landing", "NESTED_LAND")]);
        const record = await settled(controller, started.executionId, started.tasks[0]!.taskId);
        assert.equal(record.state, "landed", taskText(record));
        assert.equal(await readFile(join(repo, landed), "utf8"), "landed\n");
        if (where === "nested") {
          assert.equal(await readFile(join(repo, "other", "sibling.txt"), "utf8"), "sibling parent edit\nworker addition\n", "the worker's sibling edit must actually land");
        }
        const diff = await checkpointDiff(state, sessionCwd);
        // Pre-existing parent edits, nested and above the nested cwd, remain
        // reviewable in every policy. In the nested case the worker also
        // touched the pre-edited sibling: it is never advanced.
        assert.ok(diff.includes(`${NESTED}/parent.txt`), JSON.stringify(diff));
        assert.ok(diff.includes("other/sibling.txt"), JSON.stringify(diff));
        const baseline = activeExchangeBaseline(state);
        if (policy === "unreviewed") {
          assert.ok(diff.includes(landed), `an unreviewed landing stays in the primary review window: ${JSON.stringify(diff)}`);
          assert.equal(baseline?.kind === "checkpoint" ? baseline.descriptor : undefined, armed, "no advancement for unreviewed work");
        } else {
          assert.equal(diff.includes(landed), false, `an eligible landed path is advanced out of review: ${JSON.stringify(diff)}`);
          assert.notEqual(baseline?.kind === "checkpoint" ? baseline.descriptor : undefined, armed, "the owner advanced");
          assert.equal(baseline?.kind === "checkpoint" ? baseline.cwd : undefined, sessionCwd, "the advanced owner keeps the session cwd");
        }
        assert.doesNotMatch(taskText(record), GUARD_REFUSAL);
      } finally {
        await controller?.shutdown().catch(() => undefined);
        await controller?.detach().catch(() => undefined);
        await rm(repo, { recursive: true, force: true });
        await rm(scripts, { recursive: true, force: true });
      }
    });
  }
}

test("a nested session's explicit foreign-target landing never touches the parent Git checkpoint", async () => {
  const { repo, nested } = await nestedRepository("pi-review-nested-foreign-parent-");
  const foreign = await nestedRepository("pi-review-nested-foreign-target-");
  const scripts = await realpath(await mkdtemp(join(tmpdir(), "pi-review-nested-foreign-script-")));
  let controller: BackgroundExecutionController | undefined;
  const owned = [repo, foreign.repo, scripts];
  try {
    const script = await writeLandingExecutor(scripts);
    const state = parentState();
    const armed = await armCheckpoint(state, nested, "nested-foreign");
    await writeFile(join(repo, "other", "sibling.txt"), "sibling parent edit\n");
    controller = new BackgroundExecutionController({ config: landingConfig(script, "off"), state, cwd: () => nested, pi: {} });
    const started = await controller.start([task("foreign landing", "NESTED_LAND")], "execute", foreign.nested);
    owned.push(started.root);
    const record = await settled(controller, started.executionId, started.tasks[0]!.taskId);
    assert.equal(record.state, "landed", taskText(record));
    assert.equal(await readFile(join(foreign.nested, "landed.txt"), "utf8"), "landed\n");
    const baseline = activeExchangeBaseline(state);
    assert.equal(baseline?.kind === "checkpoint" ? baseline.descriptor : undefined, armed, "a foreign landing never advances the parent owner");
    assert.deepEqual(await checkpointDiff(state, nested), ["other/sibling.txt"]);
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    for (const root of owned) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a nested parent checkpoint whose owner cannot be verified still refuses admission before capture", async () => {
  const { repo, nested } = await nestedRepository("pi-review-nested-refusal-");
  const other = await nestedRepository("pi-review-nested-refusal-other-");
  const stubs = await realpath(await mkdtemp(join(tmpdir(), "pi-review-nested-refusal-stub-")));
  const marker = join(stubs, "launches.jsonl");
  let controller: BackgroundExecutionController | undefined;
  try {
    const stub = await writeRecordingStub(stubs, "binary-stub", "binary", marker);
    // A descriptor owned by a different repository, attributed to this
    // nested cwd: the resolved root must still verify it and refuse.
    const foreignArm = await captureReviewCheckpoint(other.nested, "nested-refusal-foreign", { scope: checkpointScope });
    assert.equal(foreignArm.status, "ok");
    if (foreignArm.status !== "ok") throw new Error("arm failed");
    const state = parentState();
    setReviewWindowCheckpointBaseline(state, { kind: "checkpoint", descriptor: foreignArm.value, cwd: nested, capturedAt: new Date().toISOString() });
    controller = new BackgroundExecutionController({ config: routeConfig("binary", stub), state, cwd: () => nested, pi: {} });
    const started = await controller.start([task("refused", "NESTED_REFUSED")]);
    const record = await settled(controller, started.executionId, started.tasks[0]!.taskId);
    assert.equal(record.state, "failed", taskText(record));
    assert.match(taskText(record), /Parent checkpoint guard refused: wrong_repository/);
    assert.equal(record.waveRoot, undefined, "a refused admission never captures a worker base");
    assert.deepEqual(await launches(marker), [], "a refused admission never launches an adapter");
  } finally {
    await controller?.shutdown().catch(() => undefined);
    await controller?.detach().catch(() => undefined);
    for (const root of [repo, other.repo, stubs]) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
