import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { createEvidenceState, recordAcceptedReviewerQuestion, recordToolCallEvidence } from "../src/evidence";
import { runAskReviewer, runReview } from "../src/review";
import { beginAgentRun, createState, rememberUserRequest, setReviewWindowBaseline } from "../src/state";

const baseConfig: ReviewGateConfig = {
  enabled: true,
  mode: "single-decider",
  maxCorrectionCycles: 1,
  implementationGuidanceAfterCorrectionAttempts: 1,
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
    assert.match(output.followUpMessage ?? "", /index\.ts\nIssue: missing test\nRecommendation: add coverage/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview removes its bundle when retainBundles is never", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-no-retain-"));
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

    assert.equal(output.bundleRetained, false);
    await assert.rejects(access(output.bundleDir ?? ""), /ENOENT/);
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

test("runReview uses an OR gate and preserves individual blocking finding identities", async () => {
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
    assert.equal(output.result?.summary, "2 needs_changes");
    assert.equal(output.result?.guidance, undefined);
    assert.match(output.followUpMessage ?? "", /\[alpha\] index\.ts\nIssue: alpha finding\nRecommendation: fix alpha/);
    assert.match(output.followUpMessage ?? "", /\[beta\] index\.ts\nIssue: beta finding\nRecommendation: fix beta/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(markerA, { force: true });
    await rm(markerB, { force: true });
  }
});

test("an aborted multi-review is atomic, records a tombstone, and preserves prior reviewer sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-atomic-abort-"));
  const fastCompleted = join(tmpdir(), `pi-review-gate-fast-completed-${process.pid}-${Date.now()}`);
  let bundleDir: string | undefined;
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    const state = createState();
    rememberUserRequest(state, "change index");
    beginAgentRun(state);
    setReviewWindowBaseline(state, before);
    const window = state.reviewWindow!;
    window.reviewerSessions.set("fast", { adapter: "codex-cli", id: "previous-fast-session" });
    window.reviewerSessions.set("slow", { adapter: "codex-cli", id: "previous-slow-session" });
    await writeFile(join(dir, "index.ts"), "first change\n", "utf8");

    const reviewer = (id: "fast" | "slow") => ({
      id,
      adapter: "generic-cli" as const,
      command: process.execPath,
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          "const path=require('node:path');",
          `const id=${JSON.stringify(id)};`,
          `const fastCompleted=${JSON.stringify(fastCompleted)};`,
          "const canceled=path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR,'reviews','0001','CANCELED.md');",
          "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{",
          "if(fs.existsSync(canceled)){process.stdout.write(JSON.stringify({verdict:'pass',summary:id+' resumed after canceled sequence',findings:[]}));return;}",
          "if(id==='fast'){fs.writeFileSync(fastCompleted,'done');process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'partial result must be discarded',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'discard me',recommendation:'do not transmit partial results'}]}));return;}",
          "const wait=setInterval(()=>{if(fs.existsSync(fastCompleted)){clearInterval(wait);setInterval(()=>{},1000);}},5);",
          "});",
        ].join(""),
      ],
      timeoutMs: 5000,
    });
    const config: ReviewGateConfig = {
      ...baseConfig,
      decider: undefined,
      reviewers: [reviewer("fast"), reviewer("slow")],
    };
    const controller = new AbortController();
    const pending = runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      window,
      signal: controller.signal,
    });
    await waitForPath(fastCompleted);
    controller.abort("escape");
    const aborted = await pending;
    bundleDir = aborted.bundleDir;

    assert.equal(aborted.result?.error, "aborted");
    assert.equal(aborted.reviewerResults, undefined);
    assert.equal(aborted.followUpMessage, undefined);
    assert.equal(window.nextReviewSequence, 2);
    assert.deepEqual(Object.fromEntries(window.reviewerSessions), {
      fast: { adapter: "codex-cli", id: "previous-fast-session" },
      slow: { adapter: "codex-cli", id: "previous-slow-session" },
    });
    const canceledDir = join(aborted.bundleDir!, "reviews", "0001");
    assert.match(
      await readFile(join(canceledDir, "CANCELED.md"), "utf8"),
      /A review would have been run here but was canceled by the user\./,
    );
    const canceled = JSON.parse(await readFile(join(canceledDir, "canceled.json"), "utf8"));
    assert.equal(canceled.reviewSequence, 1);
    assert.equal(canceled.canceledBy, "user");
    await assert.rejects(access(join(canceledDir, "reviewer-results.json")), /ENOENT/);
    await assert.rejects(access(join(canceledDir, "reviewers", "fast", "parsed-result.json")), /ENOENT/);

    const nextExchangeBaseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    beginAgentRun(state);
    setReviewWindowBaseline(state, nextExchangeBaseline);
    await writeFile(join(dir, "index.ts"), "second change\n", "utf8");
    const resumed = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      window,
    });

    assert.equal(resumed.reviewSequence, 2);
    assert.equal(resumed.result?.verdict, "pass");
    assert.equal(resumed.reviewerResults?.length, 2);
    assert.equal(window.nextReviewSequence, 3);
    assert.deepEqual(Object.fromEntries(window.reviewerSessions), {
      fast: { adapter: "codex-cli", id: "previous-fast-session" },
      slow: { adapter: "codex-cli", id: "previous-slow-session" },
    });
    assert.match(
      await readFile(join(aborted.bundleDir!, "REVIEW.md"), "utf8"),
      /CANCELED\.md.*cancellation tombstone/,
    );
    assert.match(
      await readFile(join(aborted.bundleDir!, "reviews", "0002", "reviewers", "fast", "parsed-result.json"), "utf8"),
      /resumed after canceled sequence/,
    );
    assert.match(
      await readFile(join(aborted.bundleDir!, "reviews", "0002", "reviewers", "slow", "parsed-result.json"), "utf8"),
      /resumed after canceled sequence/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(fastCompleted, { force: true });
    if (bundleDir) {
      await rm(bundleDir, { recursive: true, force: true });
    }
  }
});

test("runReview retains on any reviewer error even when another reviewer requests changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-retain-partial-error-"));
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
      config: {
        ...baseConfig,
        retainBundles: "on-failure",
        decider: undefined,
        reviewers: [
          jsonReviewer("blocking", "{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]}"),
          jsonReviewer("bad-json", "{verdict:'maybe',summary:'invalid verdict',findings:[]}"),
        ],
      },
    });

    assert.equal(output.result?.verdict, "needs_changes");
    assert.equal(output.result?.error, "partial_reviewer_error");
    assert.equal(output.bundleRetained, true);
    await access(join(output.bundleDir ?? "", "reviews", "0001", "reviewers", "bad-json", "raw-output.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview writes changed file artifacts into retained bundles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-artifacts-"));
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
      config: {
        ...baseConfig,
        retainBundles: "always",
        decider: jsonReviewer("passing", "{verdict:'pass',summary:'ok',findings:[]}"),
      },
    });

    assert.equal(output.bundleRetained, true);
    await access(join(output.bundleDir ?? "", "reviews", "0001", "artifacts", "submitted", "before", "index.ts"));
    await access(join(output.bundleDir ?? "", "reviews", "0001", "artifacts", "submitted", "after", "index.ts"));
    await access(join(output.bundleDir ?? "", "reviews", "0001", "artifacts", "index.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAskReviewer retains on any reviewer error even when another answer is usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-retain-partial-error-"));
  try {
    const output = await runAskReviewer({
      cwd: dir,
      question: "do you agree?",
      request: "review the plan",
      config: {
        ...baseConfig,
        retainBundles: "on-failure",
        decider: undefined,
        reviewers: [
          jsonReviewer("passing", "{verdict:'pass',summary:'answer ready',findings:[]}"),
          jsonReviewer("bad-json", "{verdict:'maybe',summary:'invalid verdict',findings:[]}"),
        ],
      },
    });

    assert.equal(output.result?.verdict, "error");
    assert.equal(output.bundleRetained, true);
    await access(join(output.bundleDir ?? "", "questions", "0001", "reviewers", "bad-json", "raw-output.txt"));
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

test("accepted reviewer Q&A is visible to later automatic and question reviews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-accepted-question-evidence-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const evidence = createEvidenceState();
    recordAcceptedReviewerQuestion(evidence, {
      question: "show the exact fix",
      acceptedAnswer: "Use:\n\n```diff\n-before\n+after\n```",
    });
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
            "const ok=s.includes('Accepted reviewer questions and answers')",
            "&&s.includes('show the exact fix')",
            "&&s.includes('```diff');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'accepted Q&A visible',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing accepted Q&A',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    };

    const automatic = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      evidence,
    });
    const question = await runAskReviewer({
      cwd: dir,
      question: "is that still right?",
      request: "change index",
      before,
      config,
      evidence,
    });

    assert.equal(automatic.result?.verdict, "pass");
    assert.equal(question.result?.verdict, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("correction-attempt escalation reaches automatic and question review prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-guidance-escalation-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      implementationGuidanceAfterCorrectionAttempts: 1,
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
            "const ok=s.includes('MUST provide a concrete implementation example or minimal diff');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'escalation visible',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing escalation',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    };

    const automatic = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      correctionAttemptCount: 1,
    });
    const question = await runAskReviewer({
      cwd: dir,
      question: "what exact change remains?",
      request: "change index",
      before,
      config,
      correctionAttemptCount: 1,
    });

    assert.equal(automatic.result?.verdict, "pass");
    assert.equal(question.result?.verdict, "pass");
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
        `const guidance=${JSON.stringify(`Apply ${id}:\n\n\`\`\`diff\n-${id} old\n+${id} new\n\`\`\``)};`,
        "fs.writeFileSync(own,'started');",
        "const deadline=Date.now()+2000;",
        "while(!fs.existsSync(other)&&Date.now()<deadline){}",
        "if(!fs.existsSync(other)){process.stdout.write(JSON.stringify({verdict:'error',summary:'other reviewer did not start',findings:[]}));process.exit(0);}",
        "process.stdin.resume();",
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',guidance,findings:[{severity:'blocking',file:'index.ts',line:null,issue,recommendation}]})));",
      ].join(""),
    ],
    timeoutMs: 5000,
  };
}

function jsonReviewer(id: string, objectLiteral: string): NonNullable<ReviewGateConfig["decider"]> {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: [
      "-e",
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(${objectLiteral})))`,
    ],
    timeoutMs: 5000,
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
