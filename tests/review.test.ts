import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewerDisplayLabel, type ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { createEvidenceState, recordAcceptedReviewerQuestion, recordToolCallEvidence } from "../src/evidence";
import { runAskReviewer, runReview } from "../src/review";
import { beginAgentRun, createState, rememberUserRequest, setReviewWindowBaseline } from "../src/state";
import { fakeNeedsChangesConfig } from "./helpers";

const baseConfig = fakeNeedsChangesConfig({ maxCorrectionCycles: 1 });

test("reviewerDisplayLabel shows models instead of encoded internal reviewer ids", () => {
  assert.equal(reviewerDisplayLabel({
    id: "little-coder-b3BlbmFpLWNvZGV4L2dwdC01LjYtbHVuYQ",
    adapter: "little-coder-model",
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "max",
  }), "openai-codex/gpt-5.6-luna (max)");
  assert.equal(reviewerDisplayLabel({
    id: "codex-luna",
    adapter: "codex-cli",
    model: "gpt-5.6-luna",
  }), "codex-luna [codex-cli/gpt-5.6-luna]");
});

test("runReview returns blocking findings", async () => {
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
    assert.equal(output.result?.findings[0]?.issue, "missing test");
    assert.equal(output.result?.findings[0]?.recommendation, "add coverage");
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
    assert.deepEqual(output.result?.findings.map((finding) => finding.reviewerId), ["alpha", "beta"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(markerA, { force: true });
    await rm(markerB, { force: true });
  }
});

test("multi-review aggregation treats pass plus infrastructure error as pass with warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-partial-review-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: undefined,
      reviewers: [
        jsonReviewer("passing", "{verdict:'pass',summary:'logic is sound',findings:[]}"),
        exitReviewer("offline"),
      ],
    };

    const output = await runReview({ cwd: dir, request: "change index", before, config });

    assert.equal(output.result?.verdict, "pass");
    assert.equal(output.result?.error, "partial_reviewer_error");
    assert.equal(output.result?.summary, "1 pass, 1 error");
    assert.deepEqual(output.reviewerResults?.map((result) => result.verdict), ["pass", "error"]);
    assert.equal(output.reviewerResults?.[1]?.telemetry?.sessionResumed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel reviewers cannot inspect in-flight sibling outputs or runtime sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reviewer-isolation-"));
  let bundleDir: string | undefined;
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const reviewer = (id: "fast" | "slow") => ({
      id,
      adapter: "generic-cli" as const,
      command: process.execPath,
      args: ["-e", [
        "const fs=require('node:fs');const path=require('node:path');",
        `const id=${JSON.stringify(id)};`,
        "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{",
        "const sibling=path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR,'reviews','0001','reviewers','fast');",
        "const exposed=id==='slow'&&fs.existsSync(sibling);",
        "process.stdout.write(JSON.stringify({verdict:'pass',summary:exposed?'sibling exposed':'reviewer isolated',findings:[]}));",
        "},id==='slow'?150:0));",
      ].join("" )],
      timeoutMs: 15000,
    });
    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: {
        ...baseConfig,
        retainBundles: "always",
        decider: undefined,
        reviewers: [reviewer("fast"), reviewer("slow")],
      },
    });
    bundleDir = output.bundleDir;

    assert.equal(output.result?.verdict, "pass");
    assert.equal(output.reviewerResults?.[1]?.summary, "reviewer isolated");
    await access(join(output.bundleDir!, "reviews", "0001", "reviewers", "fast", "parsed-result.json"));
    await access(join(output.bundleDir!, "reviews", "0001", "reviewers", "slow", "parsed-result.json"));
    await assert.rejects(access(join(output.bundleDir!, "sessions")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  }
});

test("multi-review aggregation keeps needs_changes authoritative despite pass or error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-blocking-mixed-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: undefined,
      reviewers: [
        jsonReviewer("passing", "{verdict:'pass',summary:'looks good',findings:[]}"),
        jsonReviewer("blocking", "{verdict:'needs_changes',summary:'bug remains',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'wrong branch',recommendation:'fix branch'}]}"),
        exitReviewer("offline"),
      ],
    };

    const output = await runReview({ cwd: dir, request: "change index", before, config });

    assert.equal(output.result?.verdict, "needs_changes");
    assert.equal(output.result?.error, "partial_reviewer_error");
    assert.equal(output.result?.findings[0]?.reviewerId, "blocking");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-review aggregation returns error when no reviewer completes a usable review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-all-review-errors-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: undefined,
      reviewers: [exitReviewer("offline-a"), exitReviewer("offline-b")],
    };

    const output = await runReview({ cwd: dir, request: "change index", before, config });

    assert.equal(output.result?.verdict, "error");
    assert.equal(output.result?.summary, "2 error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an aborted multi-review is atomic, records a tombstone, and later passes start fresh reviewer sessions", async () => {
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
      timeoutMs: 15000,
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
    assert.deepEqual(Object.fromEntries(window.reviewerSessions), {});
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
    const artifactRoot = join(output.bundleDir ?? "", "reviews", "0001", "artifacts");
    const artifactIndex = JSON.parse(await readFile(join(artifactRoot, "index.json"), "utf8")) as Array<{
      kind: string;
      artifactPath: string;
    }>;
    const beforeArtifact = artifactIndex.find((entry) => entry.kind === "submitted-before")?.artifactPath;
    const afterArtifact = artifactIndex.find((entry) => entry.kind === "submitted-after")?.artifactPath;
    assert.ok(beforeArtifact);
    assert.ok(afterArtifact);
    await access(join(output.bundleDir ?? "", "reviews", "0001", beforeArtifact));
    await access(join(output.bundleDir ?? "", "reviews", "0001", afterArtifact));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAskReviewer passes with a warning and retains evidence when another answer is usable", async () => {
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

    assert.equal(output.result?.verdict, "pass");
    assert.equal(output.result?.error, "partial_reviewer_error");
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
        timeoutMs: 15000,
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
    evidence.finalAssistantSummaries.push("Plan: update shared docker locals after confirming release branch naming.");

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
        timeoutMs: 15000,
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
    assert.deepEqual(output.reviewerDisplayLabels, { "prompt-checker": "prompt-checker" });
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
        timeoutMs: 15000,
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
            "const ok=s.includes('Concrete-guidance escalation is active: 1 correction attempt(s) have occurred, meeting the configured threshold of 1')",
            "&&s.includes('concise prose that explains and defends the proposed correction')",
            "&&s.includes('concise fenced implementation diff showing exactly what code you expect to see for that finding to pass')",
            "&&s.includes('the diff does not have to be minimal')",
            "&&s.includes('rendered under the formatted Guidance section');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'escalation visible',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing escalation',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
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

test("concrete-guidance escalation starts at the configured correction-attempt threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-guidance-threshold-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      implementationGuidanceAfterCorrectionAttempts: 2,
      decider: {
        id: "threshold-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            "const active=s.includes('Concrete-guidance escalation is active:');",
            "const below=s.includes('below threshold');",
            "const ok=below?!active:active&&s.includes('2 correction attempt(s) have occurred, meeting the configured threshold of 2');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'threshold honored',guidance:null,findings:[],error:null}",
            ":{verdict:'needs_changes',summary:'wrong threshold mode',guidance:null,findings:[],error:null}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    };

    const below = await runReview({
      cwd: dir,
      request: "below threshold",
      before,
      config,
      correctionAttemptCount: 1,
    });
    const reached = await runReview({
      cwd: dir,
      request: "threshold reached",
      before,
      config,
      correctionAttemptCount: 2,
    });

    assert.equal(below.result?.verdict, "pass");
    assert.equal(reached.result?.verdict, "pass");
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
        timeoutMs: 15000,
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
    timeoutMs: 15000,
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
    timeoutMs: 15000,
  };
}

function exitReviewer(id: string): NonNullable<ReviewGateConfig["decider"]> {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    timeoutMs: 15000,
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

// ── exactChange tests ────────────────────────────────────────────────────────

test("runReview rejects exactChange without changeIdentity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-no-ci-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });

    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: baseConfig,
      exactChange: {
        changedPaths: ["index.ts"],
        patch: "diff --git a/index.ts b/index.ts\n--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-before\n+after\n",
        truncated: false,
        omitted: [],
      },
    });

    assert.equal(output.changed, false);
    assert.ok(output.error?.includes("exactChange requires changeIdentity"), `expected error about exactChange requiring changeIdentity, got: ${output.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview treats exactChange nonempty changedPaths as reviewable even with no workspace content changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-mode-"));
  try {
    await writeFile(join(dir, "script.sh"), "#!/bin/sh\necho hi\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });

    // No actual file content change — simulate a mode-only change via exactChange.
    // The workspace snapshot comparison will show no changes, but exactChange says there are.
    const output = await runReview({
      cwd: dir,
      request: "make script executable",
      before,
      config: baseConfig,
      changeIdentity: {
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
      },
      exactChange: {
        changedPaths: ["script.sh"],
        patch: "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n",
        truncated: false,
        omitted: [],
      },
    });

    // Should NOT return no_initial_changes — the exactChange says there are changes.
    assert.equal(output.changed, true, "exactChange should make changes reviewable");
    assert.notEqual(output.noReviewReason, "no_initial_changes", "should not skip review due to no_initial_changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview uses exactChange patch in review bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-patch-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const exactPatch = "diff --git a/index.ts b/index.ts\n--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: { ...baseConfig, retainBundles: "always" },
      changeIdentity: {
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
      },
      exactChange: {
        changedPaths: ["index.ts"],
        patch: exactPatch,
        truncated: false,
        omitted: [],
      },
    });

    assert.equal(output.changed, true);
    // Verify the exact patch was written to the bundle.
    const bundlePatch = await readFile(join(output.invocationDir!, "patch.diff"), "utf8");
    assert.equal(bundlePatch, exactPatch, "bundle patch should be the exactChange patch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview records exactChange truncation in metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-trunc-"));
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
      config: { ...baseConfig, retainBundles: "always" },
      changeIdentity: {
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
      },
      exactChange: {
        changedPaths: ["index.ts", "other.ts"],
        patch: "diff --git a/index.ts b/index.ts\n# truncated\n",
        truncated: true,
        omitted: [{ path: "other.ts", reason: "truncated_by_max_patch_bytes" }],
      },
    });

    assert.equal(output.changed, true);
    // Verify metadata contains truncation info.
    const metadata = JSON.parse(await readFile(join(output.invocationDir!, "metadata.json"), "utf8"));
    assert.equal(metadata.exactPatchTruncated, true, "metadata should record exactPatchTruncated");
    assert.ok(Array.isArray(metadata.exactChangedPaths), "metadata should have exactChangedPaths");
    assert.ok(Array.isArray(metadata.exactOmittedDiffs), "metadata should have exactOmittedDiffs");
    assert.equal(metadata.exactOmittedDiffs[0].path, "other.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview serial behavior unchanged when exactChange is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-serial-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    // No exactChange — should behave exactly as before.
    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config: { ...baseConfig, retainBundles: "always" },
    });

    assert.equal(output.changed, true);
    assert.equal(output.result?.verdict, "needs_changes");
    // No exactChange metadata should be present.
    const metadata = JSON.parse(await readFile(join(output.invocationDir!, "metadata.json"), "utf8"));
    assert.equal(metadata.exactChangedPaths, undefined, "no exactChangedPaths when exactChange omitted");
    assert.equal(metadata.exactPatchTruncated, undefined, "no exactPatchTruncated when exactChange omitted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview exactChange with empty changedPaths and no workspace changes returns no_initial_changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-empty-"));
  try {
    await writeFile(join(dir, "index.ts"), "same\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });

    // exactChange with empty changedPaths — should still skip.
    const output = await runReview({
      cwd: dir,
      request: "no change",
      before,
      config: baseConfig,
      changeIdentity: {
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
      },
      exactChange: {
        changedPaths: [],
        patch: "",
        truncated: false,
        omitted: [],
      },
    });

    assert.equal(output.changed, false);
    assert.equal(output.noReviewReason, "no_initial_changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview rejects malformed exactChange fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-exact-malformed-"));
  try {
    await writeFile(join(dir, "index.ts"), "same\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });

    const ci = { baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40) };

    // Test: changedPaths is not an array.
    const out1 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: "not-array" as any, patch: "", truncated: false, omitted: [] },
    });
    assert.ok(out1.error?.includes("changedPaths must be an array"), `expected changedPaths error, got: ${out1.error}`);

    // Test: patch is not a string.
    const out2 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: [], patch: 123 as any, truncated: false, omitted: [] },
    });
    assert.ok(out2.error?.includes("patch must be a string"), `expected patch error, got: ${out2.error}`);

    // Test: truncated is not a boolean.
    const out3 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: [], patch: "", truncated: "yes" as any, omitted: [] },
    });
    assert.ok(out3.error?.includes("truncated must be a boolean"), `expected truncated error, got: ${out3.error}`);

    // Test: omitted is not an array.
    const out4 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: [], patch: "", truncated: false, omitted: "not-array" as any },
    });
    assert.ok(out4.error?.includes("omitted must be an array"), `expected omitted error, got: ${out4.error}`);

    // Test: exactChange is null.
    const out5 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: null as any,
    });
    assert.ok(out5.error?.includes("exactChange must be an object"), `expected object error, got: ${out5.error}`);

    // Test: changedPaths contains null.
    const out6 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: [null as any], patch: "", truncated: false, omitted: [] },
    });
    assert.ok(out6.error?.includes("changedPaths must contain non-empty strings"), `expected non-empty strings error, got: ${out6.error}`);

    // Test: omitted entry is null.
    const out7 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: ["a.ts"], patch: "", truncated: true, omitted: [null as any] },
    });
    assert.ok(out7.error?.includes("omitted entries must be objects"), `expected omitted objects error, got: ${out7.error}`);

    // Test: omitted path not in changedPaths.
    const out8 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: ["a.ts"], patch: "", truncated: true, omitted: [{ path: "b.ts", reason: "truncated" }] },
    });
    assert.ok(out8.error?.includes("omitted path not in changedPaths"), `expected omitted path error, got: ${out8.error}`);

    // Test: truncated false with omitted entries.
    const out9 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: ["a.ts"], patch: "", truncated: false, omitted: [{ path: "a.ts", reason: "truncated" }] },
    });
    assert.ok(out9.error?.includes("cannot have omitted entries when truncated is false"), `expected truncation consistency error, got: ${out9.error}`);

    // Test: patch exceeds maxPatchBytes.
    const out10 = await runReview({
      cwd: dir, request: "test", before, config: baseConfig,
      changeIdentity: ci,
      exactChange: { changedPaths: ["a.ts"], patch: "x".repeat(baseConfig.maxPatchBytes + 1), truncated: false, omitted: [] },
    });
    assert.ok(out10.error?.includes("exceeds maxPatchBytes"), `expected maxPatchBytes error, got: ${out10.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
