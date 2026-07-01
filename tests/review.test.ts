import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { runReview } from "../src/review";

const baseConfig: ReviewGateConfig = {
  enabled: true,
  mode: "single-decider",
  maxCorrectionCycles: 1,
  reviewWhen: "changed-files",
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
  decider: {
    id: "fake",
    adapter: "generic-cli",
    command: process.execPath,
    args: [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
    ],
    timeoutMs: 5000,
  },
};

test("runReview returns a follow-up message for blocking findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: baseConfig,
    });

    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "needs_changes");
    assert.match(output.followUpMessage ?? "", /Review found blocking issues/);
    assert.match(output.followUpMessage ?? "", /index\.ts - missing test add coverage/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview skips reviewer when no files changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-empty-"));
  try {
    await writeFile(join(dir, "index.ts"), "same\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: baseConfig,
    });

    assert.equal(output.changed, false);
    assert.equal(output.result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview prompt preserves request context and original baseline across continued work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-continued-"));
  try {
    await writeFile(join(dir, "main.tf"), "fleet_image = \"before\"\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "main.tf"), "fleet_image = \"during\"\n", "utf8");
    await writeFile(join(dir, "main.tf"), "fleet_image = \"after-geolite2\"\n", "utf8");

    const config: ReviewGateConfig = {
      ...baseConfig,
      decider: {
        id: "prompt-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            "const ok=s.includes('Initial user request:')",
            "&& s.includes('update Fleet release bits')",
            "&& s.includes('Additional user guidance during the same agent run:')",
            "&& s.includes('the -geolite2 needs to go back for pinterest')",
            "&& s.includes('-fleet_image = \"before\"')",
            "&& s.includes('+fleet_image = \"after-geolite2\"');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'ok',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing context',findings:[{severity:'blocking',file:'main.tf',line:null,issue:'prompt lacked continued context',recommendation:'include original and mid-run request context'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    };

    const output = await runReview({
      cwd: dir,
      request: [
        "Initial user request:",
        "update Fleet release bits",
        "",
        "Additional user guidance during the same agent run:",
        "2. the -geolite2 needs to go back for pinterest",
      ].join("\n"),
      before,
      config,
    });

    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
