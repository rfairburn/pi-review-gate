import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { executeWave, type WaveResult } from "../src/execution/wave-controller";
import { setDurableWriteFaultInjectionForTesting } from "../src/execution/durable-write";
import type { ReviewGateConfig } from "../src/config";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

async function mkTmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A ReviewGateConfig whose executor turn blocks forever (never dispatched in this test). */
function makeBlockingExecutorConfig(): ReviewGateConfig {
  return {
    enabled: false,
    modeCycleShortcut: "alt+m",
    operatingMode: "orchestrate",
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 0,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    execution: {
      workerResources: { "default": { selection: { source: "external", id: "fake-blocked" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    externalAgents: {
      "fake-blocked": {
        adapter: "run-as-binary",
        command: process.execPath,
        args: [],
        execution: {
          args: [
            "-e",
            [
              "process.stdin.resume();",
              "process.stdin.on('data',()=>{});",
            ].join(""),
          ],
          timeoutMs: 1_800_000,
          protocol: "pi-review-executor-jsonl-v1",
        },
      },
    },
  };
}

/**
 * PATH shim: every git invocation reaches the real git binary except the
 * worker base-snapshot `git ls-files -co --exclude-standard -z` executed
 * inside a wave worker worktree (cwd under `<waveRoot>/workers/…` with the
 * wave repository as grandparent). That invocation writes a handshake file,
 * then blocks until killed (the abort signal) or released via a marker file,
 * so the test can prove the capture child is genuinely in flight instead of
 * relying on artifact-directory presence. The block directory and real git
 * binary are baked into the generated shim so no inherited environment is
 * trusted.
 */
const GIT_SHIM_TEMPLATE = [
  "#!/usr/bin/env node",
  `const { existsSync, writeFileSync } = require("node:fs");`,
  `const { join, sep } = require("node:path");`,
  `const { spawnSync } = require("node:child_process");`,
  `const args = process.argv.slice(2);`,
  `const cwd = process.cwd();`,
  `const blockDir = {{blockDir}};`,
  `const realGit = {{realGit}};`,
  `const isWorkerBaseLsFiles = args[0] === "ls-files" && args[1] === "-co"`,
  `  && cwd.split(sep).includes("workers")`,
  `  && existsSync(join(cwd, "..", "..", "wave-repo.git"));`,
  `if (isWorkerBaseLsFiles) {`,
  `  writeFileSync(join(blockDir, "ls-files-blocked"), String(process.pid));`,
  `  const release = join(blockDir, "ls-files-release");`,
  `  setInterval(() => { if (existsSync(release)) process.exit(0); }, 10);`,
  `} else {`,
  `  const result = spawnSync(realGit, args, { stdio: "inherit" });`,
  `  process.exit(result.status ?? 1);`,
  `}`,
].join("\n");

function gitShimSource(blockDir: string, realGit: string): string {
  return GIT_SHIM_TEMPLATE
    .replaceAll("{{blockDir}}", JSON.stringify(blockDir))
    .replaceAll("{{realGit}}", JSON.stringify(realGit));
}

async function waitForFile(path: string, deadlineMs = 20_000, message = path): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      await chmod(path, 0o600);
      return;
    } catch {
      // Not present yet.
    }
    if (Date.now() - start > deadlineMs) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await delay(10);
  }
}

test("worker lifecycle rejection while the task-start manifest write is held is owned before the intervening await", async () => {
  const artifactDir = await mkTmp("pi-er-art-");
  const sourceDir = await mkTmp("pi-er-src-");
  const shimDir = await mkTmp("pi-er-shim-");
  const blockDir = await mkTmp("pi-er-block-");

  const realGit = (await execFileAsync("sh", ["-c", "command -v git"], { env: { ...process.env, ...GIT_ENV } })).stdout.trim();
  const shim = join(shimDir, "git");
  await writeFile(shim, gitShimSource(blockDir, realGit), "utf8");
  await chmod(shim, 0o755);

  const unhandledRejections: string[] = [];
  const lateHandlerWarnings: string[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  };
  const onWarning = (warning: Error): void => {
    if (warning.name === "PromiseRejectionHandledWarning") {
      lateHandlerWarnings.push(warning.message);
    }
  };

  // Existing test-only seam: hold the task-start manifest write at its
  // before-rename stage. The first wave-manifest.json write is the
  // "capturing" phase write; the second is the task-start write whose await
  // is the intervening await under test.
  let manifestBeforeRenameCount = 0;
  let releaseTaskStartManifestWrite: (() => void) | undefined;
  setDurableWriteFaultInjectionForTesting((stage, path) => {
    if (stage === "before_rename" && basename(path) === "wave-manifest.json") {
      manifestBeforeRenameCount += 1;
      if (manifestBeforeRenameCount === 2) {
        return new Promise<void>((resolve) => {
          releaseTaskStartManifestWrite = resolve;
        });
      }
    }
    return undefined;
  });

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("warning", onWarning);

  const previousPath = process.env.PATH;
  let wavePromise: Promise<WaveResult> | undefined;
  // Hoisted so the finally block can unwind the wave promptly on any
  // failure path (for example a handshake timeout) instead of letting the
  // deliberately blocking fake executor keep the run alive.
  const controller = new AbortController();
  try {
    process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
    wavePromise = executeWave({
      cwd: sourceDir,
      tasks: [{ title: "Early rejection", instructions: "noop", acceptanceCriteria: [] }],
      config: makeBlockingExecutorConfig(),
      artifactDir,
      waveId: "early-rejection",
      maxWorkers: 1,
      signal: controller.signal,
    });

    // Handshake 1: the worker base-snapshot `git ls-files -co` child is
    // genuinely running and blocked inside the worker worktree.
    await waitForFile(join(blockDir, "ls-files-blocked"), 20_000, "worker base-snapshot ls-files child in flight");
    // Handshake 2: the task-start manifest write is durably staged and
    // pending its rename — the intervening await under test is now in flight.
    const heldStart = Date.now();
    while (releaseTaskStartManifestWrite === undefined) {
      if (Date.now() - heldStart > 20_000) {
        throw new Error(`Timed out waiting for the task-start manifest write (before_rename count: ${manifestBeforeRenameCount})`);
      }
      await delay(10);
    }

    // Abort exactly as the production interruption path does, while the
    // manifest write is still held: the lifecycle promise must reject during
    // the intervening await.
    controller.abort(new Error("interrupt_as_failure"));

    // Give the rejection window time to surface (or not) before releasing
    // the intervening await.
    await delay(250);

    releaseTaskStartManifestWrite?.();
    const result = await wavePromise;
    wavePromise = undefined;

    assert.equal(
      unhandledRejections.length,
      0,
      `expected no unhandled rejection during the early lifecycle window; saw: ${unhandledRejections.join("; ")}`,
    );
    assert.equal(
      lateHandlerWarnings.length,
      0,
      `expected no late PromiseRejectionHandledWarning; saw: ${lateHandlerWarnings.join("; ")}`,
    );
    // The original failure must still be recorded truthfully, not converted
    // into success: the aborted wave reports the task as executor_error.
    assert.equal(result.phase, "aborted");
    const taskResult = result.taskResults[0];
    assert.equal(taskResult?.status, "executor_error");
    assert.match(taskResult?.error ?? "", /aborted/i);
  } finally {
    // Unwind the wave first so a failure path never waits on the blocking
    // fake executor; aborting an already-aborted signal is a no-op.
    controller.abort(new Error("test_cleanup"));
    releaseTaskStartManifestWrite?.();
    await writeFile(join(blockDir, "ls-files-release"), "", "utf8").catch(() => {});
    process.env.PATH = previousPath;
    setDurableWriteFaultInjectionForTesting(undefined);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("warning", onWarning);
    await wavePromise?.catch(() => {});
    await rm(artifactDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
    await rm(blockDir, { recursive: true, force: true });
  }
});
