/**
 * #126 D1 + U1 landing-conflict contract (ordinary reviewed landing).
 *
 * These tests drive the production runFresh -> executeWave -> onLandingConflict
 * path against a real target repository through the established fake-executor
 * transport seam, and assert the agreed contract for conflicts that the source
 * workspace drifts into during the executor turn:
 *
 * - D1: when the landing-conflict callback actually materializes conflicts in
 *   the source workspace, the durable wave manifest records
 *   `landingConflictMaterialized: true` (and the source really carries diff3
 *   markers) — never the false "source workspace unchanged" claim.
 * - U1: ordinary reviewed landing keeps the pre-#126 whole-transfer refusal for
 *   a conflict that cannot carry text markers (binary). Nothing is transferred
 *   (not even clean paths), no gate is created, no sidecar is written, and the
 *   task fails naming the concrete limit.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { createState } from "../src/state";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function makeRepo(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, "utf8");
    await git(root, "add", name);
  }
  await git(root, "commit", "-qm", "base");
  return root;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface ExecutorAction {
  sentinel: string;
  /** Files written into the worker's own worktree (candidate side), by repo-relative path. */
  worktreeFiles?: Record<string, string>;
  /** Absolute target-repository files mutated during the turn (current side). */
  targetFiles?: Record<string, string>;
}

/**
 * Fake executor seam: for the action whose sentinel appears in the prompt, write
 * the named worktree files (candidate side) and mutate the named absolute target
 * files (current side). Content is a plain string; embedding `\u0000` yields a
 * NUL byte so binary conflicts can be expressed.
 */
async function writeContractExecutorScript(root: string, actions: ExecutorAction[]): Promise<string> {
  const script = join(root, `executor-contract-${actions.map((a) => a.sentinel.toLowerCase()).join("-")}.cjs`);
  await writeFile(script, [
    "const fs=require('node:fs');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);",
    `process.stdin.on('end',()=>{const actions=${JSON.stringify(actions)};`,
    "for(const action of actions){if(prompt.includes(action.sentinel)){",
    "for(const [path,content] of Object.entries(action.worktreeFiles??{})){fs.writeFileSync(path,content);}",
    "for(const [path,content] of Object.entries(action.targetFiles??{})){fs.writeFileSync(path,content);}}}",
    "console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));",
    "console.log(JSON.stringify({type:'assistant',text:'completed requested edit'}));});",
  ].join("\n"), "utf8");
  return script;
}

function executionConfig(script: string): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "contract-fake": {
        adapter: "run-as-binary" as const,
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" as const, args: [script] },
      },
    },
    execution: {
      maxWorkers: 1,
      workerResources: { "default": { selection: { source: "external", id: "contract-fake" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

function task(title: string, instructions: string): { title: string; instructions: string; acceptanceCriteria: string[] } {
  return { title, instructions, acceptanceCriteria: [`${title} marker landed`] };
}

async function readManifest(waveRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(waveRoot, "wave-manifest.json"), "utf8"));
}

test("D1 — a materialized text conflict is recorded as materialized, not unchanged", async () => {
  const target = await makeRepo("d1-target-", { "shared.txt": "base\n" });
  const script = await writeContractExecutorScript(target, [
    {
      sentinel: "D1_CONFLICT",
      worktreeFiles: { "shared.txt": "worker side\n", "clean.txt": "clean worker file\n" },
      targetFiles: { [join(target, "shared.txt")]: "user side\n" },
    },
  ]);
  const controller = new BackgroundExecutionController({ pi: {}, config: executionConfig(script), state: createState(), cwd: () => target });
  try {
    const group = await controller.start([task("d1", "D1_CONFLICT")], "execute", target);
    await waitUntil(
      () => controller.inspect(group.executionId).tasks[0]?.state === "conflicted",
      "the text conflict to materialize in the source workspace",
    );

    // The source workspace really carries diff3 markers for the conflicted path…
    assert.match(await readFile(join(target, "shared.txt"), "utf8"), /^<<<<<<< /m);
    // …and the clean path was applied alongside it (all-or-nothing materialization).
    assert.equal(await readFile(join(target, "clean.txt"), "utf8"), "clean worker file\n");

    // D1: the durable manifest records that conflicts were materialized — the
    // truthful counterpart to the old false "source workspace unchanged" claim.
    // The conflicted-branch manifest is written after the callback returns, so
    // poll for it rather than racing the task-state transition.
    const waveRoot = controller.inspect(group.executionId).tasks[0]!.waveRoot!;
    await waitUntil(
      async () => (await readManifest(waveRoot)).landingStatus === "conflicted",
      "the conflicted landing to be recorded in the durable manifest",
    );
    const manifest = await readManifest(waveRoot);
    assert.equal(manifest.landingConflictMaterialized, true, "a materialized conflict must be recorded as materialized in the durable manifest");

    // D1 progress half: the durable activity log records that conflicts were
    // materialized (the truthful counterpart to the old false "unchanged" claim),
    // not only the manifest flag. The conflicted-phase line is written by the
    // landing-conflict callback before the task settles, so it is present once
    // the conflicted manifest has been recorded.
    const activity = controller.inspect(group.executionId).tasks[0]!.activity ?? [];
    assert.ok(
      activity.some((event) => event.phase === "conflicted" && /Conflicts materialized in shared\.txt/.test(event.message)),
      "the durable activity log must record the materialized conflict (progress half of D1)",
    );

    // The gate is active and names the conflicted path for manual resolution.
    const gate = controller.inspect(group.executionId).conflictGate;
    assert.ok(gate, "the materialized text conflict must activate a gate");
    assert.deepEqual([...gate!.paths], ["shared.txt"]);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("U1 — ordinary reviewed landing refuses a binary conflict before any mutation", async () => {
  const target = await makeRepo("u1-target-", { "shared.bin": "base\n" });
  // Both sides change the same path to incompatible BINARY content (NUL bytes),
  // so the landing plan is a modify/modify conflict that cannot carry text
  // markers. A separate clean path proves the whole transfer — not just the
  // conflicted path — is refused.
  const script = await writeContractExecutorScript(target, [
    {
      sentinel: "U1_BINARY",
      worktreeFiles: { "shared.bin": "worker\u0000bin\n", "clean.txt": "should not transfer\n" },
      targetFiles: { [join(target, "shared.bin")]: "user\u0000bin\n" },
    },
  ]);
  const controller = new BackgroundExecutionController({ pi: {}, config: executionConfig(script), state: createState(), cwd: () => target });
  try {
    const group = await controller.start([task("u1", "U1_BINARY")], "execute", target);
    // The launch rejects (materializeLandingConflicts throws) and the task ends
    // in a terminal failure — not "conflicted".
    await waitUntil(
      () => controller.inspect(group.executionId).tasks[0]?.state === "failed",
      "the binary conflict to refuse the whole transfer and fail the task",
    );

    const inspection = controller.inspect(group.executionId);
    assert.equal(inspection.tasks[0]?.state, "failed", "a non-representable conflict fails the task rather than gating it");
    assert.equal(inspection.conflictGate, undefined, "no gate is created when the transfer is refused before mutation");

    // Nothing from the worker was merged: the target keeps its own drifted
    // binary content (the current side) with no diff3 markers and no worker
    // bytes folded in.
    const landed = await readFile(join(target, "shared.bin"), "utf8");
    assert.equal(landed, "user\u0000bin\n", "the target's own drift remains; the worker version was not merged");
    assert.doesNotMatch(landed, /^<<<<<<< /m, "no conflict markers are written on refusal");
    // The clean path is refused too (whole-transfer refusal, not clean-only).
    await assert.rejects(readFile(join(target, "clean.txt")), /ENOENT/, "no clean path may transfer when a conflict cannot be represented");
    // No sidecar was written for the refused binary conflict.
    const entries = await readdir(target);
    assert.ok(!entries.some((entry) => /^shared\.bin\.worker-/.test(entry)), "no worker sidecar is written on refusal");

    // The failure names the concrete representability limit.
    const errorText = `${inspection.tasks[0]?.error ?? ""}`;
    assert.match(errorText, /cannot carry text conflict markers|Cannot represent/i);
  } finally {
    await controller.shutdown().catch(() => undefined);
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
});
