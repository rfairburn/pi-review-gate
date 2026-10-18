import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { mock } from "node:test";
import { captureReviewCheckpoint } from "../src/review-checkpoint";
import { isEligibleReviewCaptureFailure } from "../src/review-evidence";
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const exec = promisify(execFile);

for (const stage of ["acquisition", "revalidation", "cleanup"] as const) {
  test(`Git capture ${stage}: only acquisition with confirmed owned cleanup is fallback eligible`, async () => {
    const root = await mkdtemp(join(__dirname, "review-capture-stage-"));
    const cwd = join(root, "repo");
    const home = join(root, "home");
    await mkdir(cwd); await mkdir(home);
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "empty-config"),
      GIT_AUTHOR_NAME: "Capture Test", GIT_AUTHOR_EMAIL: "capture@example.invalid", GIT_COMMITTER_NAME: "Capture Test", GIT_COMMITTER_EMAIL: "capture@example.invalid" };
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    const priorHome = process.env.HOME;
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
    const git = (...args: string[]) => exec("git", args, { cwd, env });
    try {
      await git("init", "-q");
      await writeFile(join(cwd, "base.txt"), "base\n");
      await git("add", "base.txt");
      await git("commit", "-q", "-m", "owned fixture baseline");
      const target = join(cwd, "loose.txt");
      await writeFile(target, "captured content\n");
      const open = fs.open, lstat = fs.lstat, remove = fs.rm;
      if (stage === "acquisition" || stage === "cleanup") mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        if (String(args[0]) === target) throw Object.assign(new Error("injected content read refusal"), { code: "EACCES" });
        return open(...args);
      });
      if (stage === "revalidation") {
        let targetStats = 0;
        mock.method(fs, "lstat", async (...args: Parameters<typeof lstat>) => {
          if (String(args[0]) === target && ++targetStats === 2) throw Object.assign(new Error("injected post-read revalidation failure"), { code: "EACCES" });
          return lstat(...args);
        });
      }
      if (stage === "cleanup") mock.method(fs, "rm", async (...args: Parameters<typeof remove>) => {
        if (args[1]?.recursive === true && String(args[0]).includes("checkpoints/stage-capture/")) throw Object.assign(new Error("injected owned scratch cleanup failure"), { code: "EACCES" });
        return remove(...args);
      });
      const result = await captureReviewCheckpoint(cwd, "stage-capture");
      assert.equal(result.status, "failed");
      assert.equal(isEligibleReviewCaptureFailure(result), stage === "acquisition");
      assert.equal(result.reason, "untracked_unreadable");
      // The fixture's Git child calls have settled before its positively owned
      // directory is removed. No worktree/source metadata is inspected or changed.
    } finally {
      mock.restoreAll();
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("reason names alone never prove acquisition-stage and cleanup eligibility", () => {
  for (const reason of ["patch_too_large", "untracked_too_large", "untracked_unreadable", "raw_checkpoint_failed", "aborted", "capture_inconsistent", "checkpoint_digest_mismatch"]) {
    assert.equal(isEligibleReviewCaptureFailure({ status: "failed", reason }), false);
  }
  for (const reason of ["aborted", "capture_inconsistent", "checkpoint_digest_mismatch", "git_failed", "unknown"]) {
    assert.equal(isEligibleReviewCaptureFailure({ status: "failed", reason, evidenceCaptureFailure: true }), false);
  }
});
