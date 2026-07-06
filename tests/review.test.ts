import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { createEvidenceState, recordToolCallEvidence } from "../src/evidence";
import { runAskReviewer, runReview } from "../src/review";

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

test("runReview runs configured reviewers in parallel and aggregates blocking findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reviewers-"));
  const markerA = join(tmpdir(), `pi-review-gate-reviewer-a-${process.pid}-${Date.now()}`);
  const markerB = join(tmpdir(), `pi-review-gate-reviewer-b-${process.pid}-${Date.now()}`);
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const config: ReviewGateConfig = {
      ...baseConfig,
      decider: undefined,
      reviewers: [
        blockingReviewer("alpha", markerA, markerB, "alpha finding", "fix alpha"),
        blockingReviewer("beta", markerB, markerA, "beta finding", "fix beta"),
      ],
    };

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
    });

    assert.equal(output.result?.verdict, "needs_changes");
    assert.match(output.result?.summary ?? "", /alpha:/);
    assert.match(output.result?.summary ?? "", /beta:/);
    assert.match(output.followUpMessage ?? "", /\[alpha\] index\.ts - alpha finding fix alpha/);
    assert.match(output.followUpMessage ?? "", /\[beta\] index\.ts - beta finding fix beta/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(markerA, { force: true });
    await rm(markerB, { force: true });
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

test("runAskReviewer answers with request and evidence even when there is no patch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-reviewer-"));
  try {
    const evidence = createEvidenceState();
    evidence.events.push({
      sequence: 1,
      phase: "tool_call",
      toolName: "read",
      summary: "planning-session-tool read terraform files before proposing a plan",
      candidatePaths: ["main.tf"],
      riskSignals: [],
    });
    evidence.finalAssistantSummary = "Plan: update shared docker locals after confirming release branch naming.";

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
            "const ok=s.includes('Reviewer question:')",
            "&& s.includes('does this plan look legit?')",
            "&& s.includes('Plan the Fleet release update')",
            "&& s.includes('planning-session-tool')",
            "&& s.includes('no baseline available');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'The plan is reviewable from evidence even without a patch.',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing planning context',findings:[{severity:'blocking',file:'session',line:null,issue:'prompt lacked planning evidence',recommendation:'include evidence for no-patch reviewer questions'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    };

    const output = await runAskReviewer({
      cwd: dir,
      question: "does this plan look legit?",
      request: "Plan the Fleet release update",
      config,
      evidence,
    });

    assert.equal(output.result?.verdict, "pass");
    assert.match(output.result?.summary ?? "", /reviewable from evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview frames temp-like outside files as captured side effects, not submitted changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-side-effects-"));
  const outside = join(tmpdir(), `test_debug_${Date.now()}.js`);
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    const evidence = createEvidenceState();
    await recordToolCallEvidence({
      state: evidence,
      cwd: dir,
      toolName: "bash",
      toolInput: { command: `cat > ${outside} <<EOF\nconsole.log('debug')\nEOF` },
      snapshotOptions: {
        maxFileBytes: baseConfig.maxFileBytes,
        maxSnapshotBytes: baseConfig.maxSnapshotBytes,
      },
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await writeFile(outside, "console.log('debug')\n", "utf8");

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
            "const submitted=(s.match(/<submitted_changes_json>\\n([\\s\\S]*?)\\n<\\/submitted_changes_json>/)||[])[1]||'';",
            "const side=(s.match(/<captured_side_effect_changes_json>\\n([\\s\\S]*?)\\n<\\/captured_side_effect_changes_json>/)||[])[1]||'';",
            "const submittedPatch=(s.match(/<submitted_patch_diff>\\n([\\s\\S]*?)\\n<\\/submitted_patch_diff>/)||[])[1]||'';",
            "const sidePatch=(s.match(/<captured_side_effect_patch_diff>\\n([\\s\\S]*?)\\n<\\/captured_side_effect_patch_diff>/)||[])[1]||'';",
            `const outside=${JSON.stringify(outside)};`,
            "const ok=submitted.includes('index.ts')",
            "&& !submitted.includes(outside)",
            "&& side.includes(outside)",
            "&& side.includes('external_temp_like')",
            "&& side.includes('heuristic')",
            "&& submittedPatch.includes('+after')",
            "&& !submittedPatch.includes(outside)",
            "&& sidePatch.includes(outside)",
            "&& s.includes('A temp-like side-effect classification is a heuristic');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'side effects framed separately',findings:[]}",
            ":{verdict:'needs_changes',summary:'side effects were not framed separately',findings:[{severity:'blocking',file:'reviewer-prompt',line:null,issue:'external temp side effect was mixed into submitted changes',recommendation:'separate submitted changes from captured side effects'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    };

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      evidence,
    });

    assert.equal(output.result?.verdict, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

function blockingReviewer(
  id: string,
  ownMarker: string,
  otherMarker: string,
  issue: string,
  recommendation: string,
): NonNullable<ReviewGateConfig["decider"]> {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: [
      "-e",
      [
        "const fs=require('node:fs');",
        `const own=${JSON.stringify(ownMarker)};`,
        `const other=${JSON.stringify(otherMarker)};`,
        `const issue=${JSON.stringify(issue)};`,
        `const recommendation=${JSON.stringify(recommendation)};`,
        "fs.writeFileSync(own,'started');",
        "const deadline=Date.now()+2000;",
        "while(!fs.existsSync(other)&&Date.now()<deadline){}",
        "if(!fs.existsSync(other)){process.stdout.write(JSON.stringify({verdict:'error',summary:'other reviewer did not start',findings:[]}));process.exit(0);}",
        "process.stdin.resume();",
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue,recommendation}]})));",
      ].join(""),
    ],
    timeoutMs: 5000,
  };
}
