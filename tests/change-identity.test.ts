import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { runAskReviewer, runReview } from "../src/review";
import { validateChangeIdentity } from "../src/schema";
import { createState, rememberUserRequest, beginAgentRun, setReviewWindowBaseline } from "../src/state";
import { fakeNeedsChangesConfig } from "./helpers";

const VALID_BASE = "0123456789abcdef0123456789abcdef01234567";
const VALID_CANDIDATE = "fedcba9876543210fedcba9876543210fedcba98";
const VALID_IDENTITY = { baseCommit: VALID_BASE, candidateCommit: VALID_CANDIDATE };

const baseConfig = fakeNeedsChangesConfig({ maxCorrectionCycles: 1 });

// --- Validation tests ---

test("validateChangeIdentity accepts valid 40-char hex", () => {
  assert.equal(validateChangeIdentity(VALID_IDENTITY), undefined);
});

test("validateChangeIdentity accepts valid 64-char hex", () => {
  assert.equal(validateChangeIdentity({
    baseCommit: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    candidateCommit: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  }), undefined);
});

test("validateChangeIdentity rejects uppercase hex", () => {
  const err = validateChangeIdentity({ baseCommit: VALID_BASE, candidateCommit: "FEDCBA9876543210FEDCBA9876543210FEDCBA98" });
  assert.ok(err?.includes("candidateCommit"));
});

test("validateChangeIdentity rejects too-short IDs", () => {
  const err = validateChangeIdentity({ baseCommit: "abcdef", candidateCommit: VALID_CANDIDATE });
  assert.ok(err?.includes("baseCommit"));
});

test("validateChangeIdentity rejects non-hex characters", () => {
  const err = validateChangeIdentity({ baseCommit: "0123456789abcdef0123456789abcdef0123456g", candidateCommit: VALID_CANDIDATE });
  assert.ok(err?.includes("baseCommit"));
});

test("validateChangeIdentity rejects null input", () => {
  const err = validateChangeIdentity(null);
  assert.ok(err?.includes("must be an object"));
});

test("validateChangeIdentity rejects non-object input", () => {
  assert.ok(validateChangeIdentity("just a string")?.includes("must be an object"));
  assert.ok(validateChangeIdentity(42)?.includes("must be an object"));
  assert.ok(validateChangeIdentity([])?.includes("must be an object"));
});

test("validateChangeIdentity rejects missing fields", () => {
  assert.ok(validateChangeIdentity({})?.includes("baseCommit"));
  assert.ok(validateChangeIdentity({ baseCommit: VALID_BASE })?.includes("candidateCommit"));
});

test("validateChangeIdentity rejects non-string fields", () => {
  assert.ok(validateChangeIdentity({ baseCommit: 123, candidateCommit: VALID_CANDIDATE })?.includes("baseCommit"));
  assert.ok(validateChangeIdentity({ baseCommit: VALID_BASE, candidateCommit: null })?.includes("candidateCommit"));
});

// --- Integration tests ---

test("runReview includes changeIdentity in reviewer context and invocation metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-"));
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
      decider: {
        id: "ci-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            `const base=${JSON.stringify(VALID_BASE)};`,
            `const candidate=${JSON.stringify(VALID_CANDIDATE)};`,
            "const ok=s.includes('<change_identity>')",
            "&& s.includes('base: '+base)",
            "&& s.includes('candidate: '+candidate)",
            "&& s.includes('range: '+base+'..'+candidate)",
            "&& s.includes('This review verdict applies specifically to candidate commit '+candidate);",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'change identity visible',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing change identity',findings:[{severity:'blocking',file:'session',line:null,issue:'change identity not in prompt',recommendation:'include change identity'}]}));",
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
      changeIdentity: VALID_IDENTITY,
    });

    assert.equal(output.result?.verdict, "pass");

    // Verify metadata.json contains changeIdentity
    const metadata = JSON.parse(await readFile(join(output.bundleDir!, "reviews", "0001", "metadata.json"), "utf8"));
    assert.equal(metadata.changeIdentity.baseCommit, VALID_BASE);
    assert.equal(metadata.changeIdentity.candidateCommit, VALID_CANDIDATE);

    // Verify current/change-identity.json exists
    await access(join(output.bundleDir!, "current", "change-identity.json"));
    const ci = JSON.parse(await readFile(join(output.bundleDir!, "current", "change-identity.json"), "utf8"));
    assert.equal(ci.baseCommit, VALID_BASE);
    assert.equal(ci.candidateCommit, VALID_CANDIDATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAskReviewer includes changeIdentity in reviewer context and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-ask-"));
  try {
    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: {
        id: "ci-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            `const base=${JSON.stringify(VALID_BASE)};`,
            `const candidate=${JSON.stringify(VALID_CANDIDATE)};`,
            "const ok=s.includes('<change_identity>')",
            "&& s.includes('base: '+base)",
            "&& s.includes('candidate: '+candidate)",
            "&& s.includes('range: '+base+'..'+candidate);",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'change identity visible',findings:[]}",
            ":{verdict:'needs_changes',summary:'missing change identity',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    };

    const output = await runAskReviewer({
      cwd: dir,
      question: "is this correct?",
      request: "review the change",
      config,
      changeIdentity: VALID_IDENTITY,
    });

    assert.equal(output.result?.verdict, "pass");

    const metadata = JSON.parse(await readFile(join(output.bundleDir!, "questions", "0001", "metadata.json"), "utf8"));
    assert.equal(metadata.changeIdentity.baseCommit, VALID_BASE);
    assert.equal(metadata.changeIdentity.candidateCommit, VALID_CANDIDATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview rejects invalid changeIdentity before reviewer execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-invalid-"));
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
      changeIdentity: { baseCommit: "INVALID", candidateCommit: VALID_CANDIDATE },
    });

    assert.equal(output.changed, false);
    assert.ok(output.error?.includes("Invalid changeIdentity"));
    assert.ok(output.error?.includes("baseCommit"));
    assert.equal(output.bundleDir, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAskReviewer rejects invalid changeIdentity before reviewer execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-invalid-ask-"));
  try {
    const output = await runAskReviewer({
      cwd: dir,
      question: "is this correct?",
      request: "review",
      config: baseConfig,
      changeIdentity: { baseCommit: VALID_BASE, candidateCommit: "TOO_SHORT" },
    });

    assert.ok(output.error?.includes("Invalid changeIdentity"));
    assert.ok(output.error?.includes("candidateCommit"));
    assert.equal(output.bundleDir, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runReview preserves existing behavior when changeIdentity is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-omit-"));
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
      decider: {
        id: "omit-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            "const noIdentity=!s.includes('<change_identity>')",
            "&& !s.includes('change identity');",
            "process.stdout.write(JSON.stringify(noIdentity",
            "?{verdict:'pass',summary:'no identity when omitted',findings:[]}",
            ":{verdict:'needs_changes',summary:'unexpected identity',findings:[]}));",
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
    });

    assert.equal(output.result?.verdict, "pass");

    // Verify metadata.json does NOT contain changeIdentity
    const metadata = JSON.parse(await readFile(join(output.bundleDir!, "reviews", "0001", "metadata.json"), "utf8"));
    assert.equal(metadata.changeIdentity, undefined);

    // Verify current/change-identity.json does NOT exist
    await assert.rejects(access(join(output.bundleDir!, "current", "change-identity.json")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAskReviewer preserves existing behavior when changeIdentity is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-omit-ask-"));
  try {
    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: {
        id: "omit-checker",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            "let s='';",
            "process.stdin.on('data',c=>s+=c);",
            "process.stdin.on('end',()=>{",
            "const noIdentity=!s.includes('<change_identity>');",
            "process.stdout.write(JSON.stringify(noIdentity",
            "?{verdict:'pass',summary:'no identity when omitted',findings:[]}",
            ":{verdict:'needs_changes',summary:'unexpected identity',findings:[]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    };

    const output = await runAskReviewer({
      cwd: dir,
      question: "is this correct?",
      request: "review",
      config,
    });

    assert.equal(output.result?.verdict, "pass");

    const metadata = JSON.parse(await readFile(join(output.bundleDir!, "questions", "0001", "metadata.json"), "utf8"));
    assert.equal(metadata.changeIdentity, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reused bundle removes stale change-identity.json when identity is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-reuse-"));
  const bundleDir = await mkdtemp(join(tmpdir(), "pi-review-gate-ci-bundle-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const state = createState();
    rememberUserRequest(state, "change index");
    beginAgentRun(state);
    setReviewWindowBaseline(state, before);
    state.reviewWindow!.bundleDir = bundleDir;

    const config: ReviewGateConfig = {
      ...baseConfig,
      retainBundles: "always",
      decider: {
        id: "passing",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'ok',findings:[]})))",
        ],
        timeoutMs: 15000,
      },
    };

    // First review with identity
    const withIdentity = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      changeIdentity: VALID_IDENTITY,
      window: state.reviewWindow!,
    });
    assert.equal(withIdentity.result?.verdict, "pass");
    await access(join(bundleDir, "current", "change-identity.json"));

    // Second review without identity — should remove the stale file
    const after = await createWorkspaceSnapshot(dir, {
      maxFileBytes: baseConfig.maxFileBytes,
      maxSnapshotBytes: baseConfig.maxSnapshotBytes,
    });
    await writeFile(join(dir, "index.ts"), "after2\n", "utf8");
    beginAgentRun(state);
    setReviewWindowBaseline(state, after);

    const withoutIdentity = await runReview({
      cwd: dir,
      request: "change index again",
      before: after,
      config,
      window: state.reviewWindow!,
    });
    assert.equal(withoutIdentity.result?.verdict, "pass");

    // Stale change-identity.json must be removed
    await assert.rejects(access(join(bundleDir, "current", "change-identity.json")), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(bundleDir, { recursive: true, force: true });
  }
});
