import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerApplyPatchTool } from "../src/apply-patch/tool";
import {
  captureObservedToolPathAfterStates,
  createEvidenceState,
  recordObservedToolEventEvidence,
  recordToolCallEvidence,
  recordToolResultEvidence,
  serializeEvidenceState,
} from "../src/evidence";
import { runReview } from "../src/review";
import { fakeNeedsChangesConfig } from "./helpers";

const execute = promisify(execFile);
const snapshotOptions = { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 };

// The generic CLI actually reads the retained production bundle and its content
// artifacts. A passing helper-path match or an inline prompt alone cannot pass.
const reviewer = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const expected = JSON.parse(process.argv[1]);
process.stdin.resume();
process.stdin.on('end', () => {
  try {
    const root = path.join(process.env.PI_REVIEW_GATE_BUNDLE_DIR, 'reviews', '0001');
    const text = p => fs.readFileSync(path.join(root, p), 'utf8');
    const evidence = JSON.parse(text('evidence.json'));
    const index = JSON.parse(text('artifacts/index.json'));
    const content = (kind, name) => {
      const entry = index.find(e => e.kind === kind && e.path === name);
      assert.ok(entry && entry.artifactPath, kind + ': ' + name);
      return text(entry.artifactPath);
    };
    if (expected.script) {
      const kind = expected.ignored ? 'side-effect' : 'submitted';
      assert.equal(content(kind + '-before', 'build/SCRIPT.sh'), 'SCRIPT-OLD\n');
      assert.equal(content(kind + '-after', 'build/SCRIPT.sh'), 'SCRIPT-NEW');
      assert.ok(evidence.events.some(e => e.candidatePaths.includes('build/SCRIPT.sh')), 'SCRIPT candidate retained');
      assert.ok(!evidence.events.some(e => e.candidatePaths.includes('build/REPORT')), 'quoted REPORT is not executable syntax');
      assert.ok(!evidence.candidates.some(c => c.path === 'build/REPORT'), 'no REPORT candidate');
      assert.ok(!index.some(e => e.kind.startsWith('side-effect') && e.path === 'build/REPORT'), 'no REPORT side-effect artifact');
      assert.ok(!text('side-effect.patch.diff').includes('INDEPENDENT-REPORT'), 'no REPORT side-effect bytes');
      if (!expected.ignored) {
        assert.equal(content('submitted-after', 'build/REPORT'), 'INDEPENDENT-REPORT');
        assert.ok(text('patch.diff').includes('+INDEPENDENT-REPORT'), 'snapshot default keeps concurrent workspace state');
      }
    }
    if (expected.envMove) {
      assert.equal(content('side-effect-before', 'build/SCRIPT.sh'), 'SCRIPT-OLD\n');
      assert.equal(content('side-effect-after', 'build/MOVED.sh'), 'SCRIPT-OLD\n');
      for (const name of ['build/SCRIPT.sh', 'build/MOVED.sh']) {
        assert.ok(evidence.events.some(e => e.candidatePaths.includes(name) && e.riskSignals.includes('shell_mv')), 'assignment-prefixed move: ' + name);
      }
      assert.ok(!evidence.events.some(e => e.candidatePaths.includes('build/REPORT')), 'quoted/escaped prefix-like executable names do not promote their arguments');
      assert.ok(!index.some(e => e.path === 'build/REPORT'), 'no REPORT side-effect artifact');
      assert.ok(text('side-effect.patch.diff').includes('-SCRIPT-OLD'));
      assert.ok(text('side-effect.patch.diff').includes('+SCRIPT-OLD'));
    }
    if (expected.envDeletion) {
      const candidate = evidence.candidates.find(c => c.path === expected.envDeletion);
      assert.equal(candidate?.baseline, 'unverified');
      assert.equal(candidate?.externalSideEffect, true);
      assert.equal(candidate?.afterSnapshot?.exists, false);
      assert.equal(evidence.requiresReview, true, 'external deletion requires review even without workspace changes');
      assert.ok(evidence.events.some(e => e.candidatePaths.includes(expected.envDeletion) && e.riskSignals.includes('shell_rm')));
      if (expected.negated) {
        assert.ok(evidence.events.some(e => e.phase === 'tool_result' && e.isError && e.riskSignals.includes('tool_result_error')), 'negated rm keeps its nonzero result and deletion evidence');
      }
      assert.equal(text('patch.diff'), '(no submitted workspace changes detected; review captured side effects below)');
      assert.equal(text('side-effect.patch.diff'), '', 'observation is not a fabricated before/after diff');
    }
    if (expected.partial) {
      assert.equal(content('side-effect-before', 'build/SCRIPT.sh'), 'SCRIPT-OLD\n');
      assert.equal(content('side-effect-after', 'build/SCRIPT.sh'), 'SCRIPT-NEW\n');
      assert.equal(content('side-effect-after', 'build/created.txt'), 'CREATED\n');
      assert.ok(evidence.events.some(e => e.phase === 'tool_result' && e.isError && e.detail.includes('failed at operation 3')));
      assert.ok(!index.some(e => e.path === 'build/not-attempted.txt' && e.kind === 'side-effect-after' && e.artifactPath));
      assert.ok(text('side-effect.patch.diff').includes('+CREATED'));
    }
    if (expected.timing) {
      const candidate = evidence.candidates.find(c => c.path === expected.timing);
      assert.equal(candidate?.afterSnapshot?.content, 'LATER-INDEPENDENT-WRITER');
      assert.equal(candidate?.baseline, 'unverified');
      assert.ok(text('evidence.md').includes('not a diff'));
      assert.equal(text('side-effect.patch.diff'), '', 'an after-observation is not a fabricated tool diff');
    }
    if (expected.exactIdentity) {
      assert.equal(evidence.candidates.length, 1);
      assert.equal(evidence.candidates[0].path, expected.exactIdentity);
      assert.equal(evidence.candidates[0].afterSnapshot?.content, 'SAFE-EXTERNAL');
      assert.equal(evidence.toolObservationsTruncated, expected.recordOmission === true);
      assert.ok(evidence.events.every(e => e.candidatePaths.includes(expected.exactIdentity)));
    }
    if (expected.genericArgs) {
      const detail = JSON.parse(evidence.events[0].detail);
      assert.equal(detail.url, 'https://example.test');
      if (evidence.events[0].adapter === 'claude-sdk') assert.equal(detail.command, 'opaque request');
      assert.equal(detail.options.method, 'POST');
      assert.equal(detail.options.headers.authorization, '[REDACTED]');
      assert.equal(detail.options.headers.accept, 'application/json');
      assert.deepEqual(detail.options.metadata, { source: 'adapter', labels: ['one', { name: 'two', secret: '[REDACTED]' }] });
      assert.equal(detail.options.body.password, '[REDACTED]');
      assert.equal(detail.options.body.message, 'token=[REDACTED]');
      assert.equal(detail.options.body.enabled, true);
      assert.equal(detail.options.body.count, 0);
      assert.equal(detail.options.body.empty, null);
      assert.deepEqual(detail.files, [{ name: 'payload', metadata: { secret: '[REDACTED]' } }]);
      assert.equal(evidence.toolObservationsTruncated, false);
      assert.equal(evidence.requiresReview, false);
      assert.equal(evidence.candidates.length, 0, 'generic arguments are not inferred file effects');
      assert.ok(evidence.events[0].summary.includes('POST'));
      assert.ok(text('evidence.md').includes('https://example.test'));
      for (const secret of ['GENERIC-HEADER-PRIVATE', 'GENERIC-NESTED-PRIVATE', 'GENERIC-PASSWORD-PRIVATE', 'GENERIC-TEXT-PRIVATE', 'GENERIC-FILE-PRIVATE']) {
        assert.ok(!text('evidence.json').includes(secret));
        assert.ok(!text('evidence.md').includes(secret));
      }
    }
    if (expected.genericOmissions) {
      assert.equal(evidence.requiresReview, true);
      assert.equal(evidence.toolObservationsTruncated, true);
      assert.ok(evidence.toolObservabilityNotes.some(n => /tool input evidence is incomplete/i.test(n)));
      assert.ok(text('evidence.md').includes('additional observations were omitted'));
      assert.equal(evidence.candidates.length, 0);
      const details = evidence.events.map(e => JSON.parse(e.detail));
      assert.equal(details[0].url, 'https://example.test');
      assert.equal(details[0].options.method, 'POST');
      assert.equal(details[0].options.large, '[... truncated ...]');
      assert.equal(details[0].options.accessor, '[... truncated ...]');
      assert.equal(details[0].options.items.length, 20);
      assert.equal(details[0].options.items[19], 'item-19');
      assert.equal(details[1].field29, 'kept-29');
      assert.ok(!Object.hasOwn(details[1], 'field30'));
      assert.equal(details[2].options.field29, 'kept-29');
      assert.ok(!Object.hasOwn(details[2].options, 'field30'));
      for (const omitted of ['OMITTED-GENERIC-FIELD', 'OMITTED-GENERIC-STRING', 'OMITTED-GENERIC-ITEM']) {
        assert.ok(!text('evidence.json').includes(omitted));
      }
    }
    if (expected.recordOmission) {
      assert.equal(evidence.requiresReview, true);
      assert.ok(evidence.toolObservabilityNotes.some(n => /tool input evidence is incomplete/i.test(n)));
      const detail = JSON.parse(evidence.events[0].detail);
      assert.equal(detail.metadata, '[... truncated ...]');
      assert.deepEqual(detail.edits, ['[... truncated ...]', ['[... truncated ...]']]);
      assert.deepEqual(detail.files, [null, expected.exactIdentity]);
      assert.ok(!text('evidence.json').includes('RAW-RECORD-NOT-RETAINED'));
    }
    if (expected.boundedIdentity) {
      assert.equal(evidence.requiresReview, true);
      assert.equal(evidence.toolObservationsTruncated, true);
      assert.ok(evidence.toolObservabilityNotes.some(n => /path.*unavailable.*bounded identity retention/i.test(n)));
      assert.ok(text('evidence.md').includes('unavailable'));
      assert.ok(text('evidence.md').includes('additional observations were omitted'));
      assert.equal(evidence.candidates.length, 1, 'only the safely retained exact address is readable');
      const safe = evidence.candidates[0];
      assert.equal(safe.path, expected.boundedIdentity);
      assert.equal(safe.baseline, 'unverified');
      assert.equal(safe.afterSnapshot?.content, 'SAFE-EXTERNAL');
      assert.equal(text('side-effect.patch.diff'), '', 'no fabricated clean/missing-file diff');
      for (const forbidden of ['DECOY-PREFIX', 'ORIGINAL-UNRETAINED', 'prefix-decoy', 'beyond-limit']) {
        assert.ok(!text('evidence.json').includes(forbidden), 'no substituted or unretained evidence: ' + forbidden);
        assert.ok(!text('evidence.md').includes(forbidden));
        assert.ok(!index.some(e => e.path.includes(forbidden)));
      }
      assert.ok(!index.some(e => e.path.includes('alias-decoy')), 'an unselected command alias is not an address');
    }
    if (expected.external || expected.unavailable) {
      if (expected.external) {
        const safe = evidence.candidates.find(c => c.path === expected.external);
        assert.equal(safe?.afterSnapshot?.content, 'SAFE-EXTERNAL');
        assert.equal(safe?.baseline, 'unverified');
        assert.equal(safe?.externalSideEffect, true);
      }
      assert.equal(evidence.candidates.length, expected.external ? 1 : 0, 'transformed addresses have no readable candidate');
      assert.equal(evidence.requiresReview, true);
      assert.equal(evidence.toolObservationsTruncated, true);
      assert.ok(evidence.toolObservabilityNotes.some(n => /path.*unavailable/i.test(n)), 'unavailable address disclosed');
      assert.ok(text('evidence.md').includes('REDACTED'), 'sanitized event stays visible');
      for (const forbidden of ['DECOY-REDACTED', 'DECOY-TRUNCATED', 'ORIGINAL-PRIVATE', 'harmless.txt']) {
        assert.ok(!text('evidence.json').includes(forbidden), 'private/decoy bytes absent: ' + forbidden);
        assert.ok(!text('side-effect.patch.diff').includes(forbidden));
      }
    }
    process.stdout.write(JSON.stringify({verdict:'pass',summary:'retained bundle content verified',findings:[]}));
  } catch (error) {
    process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:error.message,findings:[{severity:'blocking',file:'evidence',line:null,issue:error.message,recommendation:'retain only correctly addressed evidence'}]}));
  }
});
`;

async function fixture(run: (root: string, workspace: string) => Promise<void>): Promise<void> {
  // All fixture/config/content files are invocation-owned and outside the selected
  // capture tree. TMPDIR may be redirected by an isolated worker's test runner.
  const root = await mkdtemp(join(tmpdir(), "pi-evidence-fidelity-"));
  const env = {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "home", "agent"),
    GIT_CONFIG_GLOBAL: join(root, "home", "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(join(root, "home"));
    Object.assign(process.env, env);
    // This invocation-owned fixture repository is not the managed worktree. Its
    // Git inventory lets the snapshot-default control include unignored build/.
    await execute("git", ["init", "--quiet"], { cwd: workspace, timeout: 10_000 });
    await run(root, workspace);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Every child below is awaited through execFile close or runReview settlement
    // before this cleanup, including nonzero exits and reviewer failures.
    await rm(root, { recursive: true, force: true });
  }
}

async function review(
  root: string, workspace: string,
  before: Awaited<ReturnType<typeof createWorkspaceSnapshot>>,
  evidence: ReturnType<typeof createEvidenceState>,
  expected: Record<string, unknown>,
): Promise<void> {
  const result = await runReview({
    cwd: workspace, before, evidence, request: "Review the recorded changes; workspace state is not proof of authorship.",
    config: fakeNeedsChangesConfig({
      ...snapshotOptions,
      retainBundles: "always",
      externalAgents: {
        fidelity: {
          adapter: "generic-cli", command: process.execPath, args: [],
          env: { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home", "agent") },
          review: { args: ["-e", reviewer, JSON.stringify(expected)], timeoutMs: 15_000 },
        },
      },
      review: { activeReviewers: [{ source: "external", id: "fidelity" }] },
    }),
  });
  try {
    assert.equal(result.bundleRetained, true);
    assert.equal(result.result?.verdict, "pass", JSON.stringify(result.result));
    assert.match(await readFile(join(result.bundleDir!, "reviews/0001/reviewers/fidelity/raw-output.txt"), "utf8"), /retained bundle content verified/);
  } finally {
    if (result.bundleDir) await rm(result.bundleDir, { recursive: true, force: true });
  }
}

for (const ignored of [true, false]) {
  for (const redirect of [" > ", ">", ">'", '>"']) {
    test(`production bundle: ${ignored ? "ignored side effect" : "snapshot default"}, redirect ${JSON.stringify(redirect)}`, async (t) => {
      if (process.platform === "win32") return t.skip("literal POSIX shell fixture; not a PowerShell parser claim");
      await fixture(async (root, workspace) => {
        await mkdir(join(workspace, "build"));
        if (ignored) await writeFile(join(workspace, ".gitignore"), "build/\n");
        await writeFile(join(workspace, "build/SCRIPT.sh"), "SCRIPT-OLD\n");
        const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
        const evidence = createEvidenceState();
        const closeQuote = redirect.endsWith("'") ? "'" : redirect.endsWith('"') ? '"' : "";
        const command = `printf SCRIPT-NEW${redirect}build/SCRIPT.sh${closeQuote}; `
          + `printf '%s' "data touch build/REPORT end"; printf '%s' 'data rm build/REPORT end'; `
          + `printf '%s' data\\ touch\\ build/REPORT; printf '%s' "data > build/REPORT end"`;
        await recordToolCallEvidence({ state: evidence, cwd: workspace, toolName: "bash", toolInput: { command }, snapshotOptions });
        // Independent owned writer, same workspace, no event claiming its REPORT.
        await execute(process.execPath, ["-e", "require('node:fs').writeFileSync('build/REPORT','INDEPENDENT-REPORT')"], { cwd: workspace, timeout: 10_000 });
        await execute("/bin/bash", ["-c", command], { cwd: workspace, timeout: 10_000 });
        recordToolResultEvidence({ state: evidence, toolName: "bash", toolInput: { command }, result: "printed data", isError: false });
        await review(root, workspace, before, evidence, { script: true, ignored });
      });
    });
  }
}

test("production bundle retains an assignment-prefixed ignored-file move without matching assignment-like data", async (t) => {
  if (process.platform === "win32") return t.skip("literal POSIX assignment syntax");
  await fixture(async (root, workspace) => {
    await mkdir(join(workspace, "build"));
    await writeFile(join(workspace, ".gitignore"), "build/\n");
    await writeFile(join(workspace, "build/SCRIPT.sh"), "SCRIPT-OLD\n");
    await writeFile(join(workspace, "build/REPORT"), "INDEPENDENT-REPORT");
    // Quoted/escaped spellings name executables, not reserved prefixes or
    // assignments. Their arguments must not become executable rm commands.
    for (const name of ["LC_ALL=C", "{", "!"]) {
      await writeFile(join(workspace, name), "#!/bin/sh\nprintf '%s' \"$*\"\n");
      await chmod(join(workspace, name), 0o700);
    }
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const command = "LC_ALL=C EMPTY= NOTE='literal value' mv build/SCRIPT.sh build/MOVED.sh; "
      + "'LC_ALL=C' rm -f build/REPORT; LC\\_ALL=C rm -f build/REPORT; "
      + "'{' rm -f build/REPORT; \\{ rm -f build/REPORT; "
      + "'!' rm -f build/REPORT; \\! rm -f build/REPORT; "
      + "printf '%s' 'LC_ALL=C rm -f build/REPORT'";
    await recordToolCallEvidence({ state: evidence, cwd: workspace, toolName: "bash", toolInput: { command }, snapshotOptions });
    await execute("/bin/bash", ["-c", command], { cwd: workspace, timeout: 10_000, env: { ...process.env, PATH: `${workspace}:${process.env.PATH}` } });
    recordToolResultEvidence({ state: evidence, toolName: "bash", toolInput: { command }, result: "moved and printed data", isError: false });
    assert.equal(await readFile(join(workspace, "build/REPORT"), "utf8"), "INDEPENDENT-REPORT");
    await review(root, workspace, before, evidence, { envMove: true });
  });
});

for (const prefix of ["LC_ALL=C EMPTY=", "2>/dev/null", "LC_ALL=C EMPTY= 2>/dev/null", "{", "!"]) {
  test(`production bundle reviews an external-only deletion prefixed by ${prefix}`, async (t) => {
    if (process.platform === "win32") return t.skip("literal POSIX assignment/redirection syntax");
    await fixture(async (root, workspace) => {
      const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
      const evidence = createEvidenceState();
      const path = join(root, "owned-external.txt");
      await writeFile(path, "OWNED-EXTERNAL");
      const command = `${prefix} rm -f '${path}'${prefix === "{" ? "; }" : ""}`;
      const observation = { state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", toolName: "bash", toolInput: { command } };
      recordObservedToolEventEvidence({ ...observation, stage: "start" });
      let isError = false;
      try {
        await execute("/bin/bash", ["-c", command], { cwd: workspace, timeout: 10_000 });
      } catch (error) {
        if (prefix !== "!") throw error;
        assert.equal((error as { code?: unknown }).code, 1);
        isError = true; // Negation reverses successful rm's status, not its effect.
      }
      recordObservedToolEventEvidence({ ...observation, stage: "end", result: "deleted", isError });
      await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
      await review(root, workspace, before, evidence, { envDeletion: path, negated: prefix === "!" });
    });
  });
}

test("production bundle retains successful ApplyPatch content when a later operation fails", async () => {
  await fixture(async (root, workspace) => {
    await mkdir(join(workspace, "build"));
    await writeFile(join(workspace, ".gitignore"), "build/\n");
    await writeFile(join(workspace, "build/SCRIPT.sh"), "SCRIPT-OLD\n");
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const toolInput = { patch: [
      "*** Begin Patch", "*** Update File: build/SCRIPT.sh", "@@", "-SCRIPT-OLD", "+SCRIPT-NEW",
      "*** Add File: build/created.txt", "+CREATED",
      "*** Update File: build/missing.txt", "@@", "-missing", "+replacement",
      "*** Add File: build/not-attempted.txt", "+NEVER", "*** End Patch",
    ].join("\n") };
    let executePatch: ((...args: any[]) => Promise<unknown>) | undefined;
    registerApplyPatchTool({ registerTool(tool: { execute: typeof executePatch }) { executePatch = tool.execute; } });
    assert.ok(executePatch);
    await recordToolCallEvidence({ state: evidence, cwd: workspace, toolName: "ApplyPatch", toolInput, snapshotOptions });
    let failure: unknown;
    try { await executePatch("partial", toolInput, undefined, undefined, { cwd: workspace }); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /failed at operation 3/);
    recordToolResultEvidence({ state: evidence, toolName: "ApplyPatch", toolInput, isError: true, result: failure.message });
    await review(root, workspace, before, evidence, { partial: true });
  });
});

test("production bundle refuses transformed/marker external addresses, retaining safe external after-content", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const safe = join(root, "safe.txt");
    const privatePath = join(root, "token=harmless.txt");
    const redactedDecoy = join(root, "token=[REDACTED]");
    // Long redundant spelling resolves to an existing file without requiring a
    // filesystem that permits paths over 2048 bytes (macOS does not).
    const longPath = `${root}/${"./".repeat(1100)}long.txt`;
    const truncatedDecoy = join(root, "short\n[... truncated ...]");
    for (const [path, content] of [
      [safe, "SAFE-EXTERNAL"], [privatePath, "ORIGINAL-PRIVATE"], [redactedDecoy, "DECOY-REDACTED"],
      [join(root, "long.txt"), "ORIGINAL-PRIVATE"], [truncatedDecoy, "DECOY-TRUNCATED"],
    ]) {
      await writeFile(path!, content!);
    }
    // Exercise structured paths, shell targets, and patch headers through the same
    // production observation entry point; nothing new persists a raw address.
    for (const [toolName, toolInput] of [
      ["write", { path: privatePath }],
      ["bash", { command: `printf data > '${privatePath}'` }],
      ["ApplyPatch", { patch: `*** Begin Patch\n*** Delete File: ${privatePath}\n*** End Patch` }],
      ["write", { files: [longPath, redactedDecoy, truncatedDecoy, safe] }],
      ["bash", { command: `printf '%s' 'token=unused' > '${safe}'` }],
    ] as Array<[string, Record<string, unknown>]>) {
      recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName, toolInput });
    }
    await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
    assert.ok(!JSON.stringify(serializeEvidenceState(evidence)).includes("harmless.txt"), "no sensitive raw address in durable state");
    await review(root, workspace, before, evidence, { external: safe });
  });
});

test("unavailable external address alone still reaches the production reviewer with no invented missing-file state", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const path = join(root, "token=harmless.txt");
    await writeFile(path, "ORIGINAL-PRIVATE");
    await writeFile(join(root, "token=[REDACTED]"), "DECOY-REDACTED");
    recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "end", toolName: "write", toolInput: { path }, result: "written", isError: true });
    await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
    await review(root, workspace, before, evidence, { unavailable: true });
  });
});

for (const kind of ["command", "patch", "path", "paths", "files"] as const) {
  test(`production bundle: bounded raw ${kind} ingestion never reads a clipped prefix or omitted target`, async () => {
    await fixture(async (root, workspace) => {
      const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
      const evidence = createEvidenceState();
      const safe = join(root, "safe.txt");
      const decoy = join(root, "prefix-decoy");
      await writeFile(safe, "SAFE-EXTERNAL");
      await writeFile(decoy, "DECOY-PREFIX");
      await writeFile(`${decoy}-original`, "ORIGINAL-UNRETAINED");
      const alias = join(root, "alias-decoy");
      await writeFile(alias, "DECOY-PREFIX");
      let toolName = "write";
      let toolInput: Record<string, unknown>;
      if (kind === "command") {
        // The 20k boundary lands exactly after a real, existing decoy's name.
        const tail = `printf ORIGINAL-UNRETAINED > ${decoy}`;
        const command = `${" ".repeat(20_000 - tail.length)}${tail}-original`;
        toolName = "bash";
        toolInput = { command, cmd: `touch ${alias}` };
      } else if (kind === "patch") {
        const head = "*** Begin Patch\n*** Add File: padding.txt\n+";
        const tail = `\n*** Delete File: ${decoy}`;
        toolName = "ApplyPatch";
        toolInput = { patch: `${head}${"x".repeat(20_000 - head.length - tail.length)}${tail}-original\n*** End Patch` };
      } else if (kind === "path") {
        // Redundant spelling keeps the resolved path portable on macOS while
        // making the raw identity unsupported (>2000 characters).
        toolInput = { path: `${root}/${"./".repeat(1100)}prefix-decoy-original` };
      } else {
        // A sparse huge collection must be bounded BEFORE iteration/copying.
        // Access beyond the retained prefix (or via its iterator) fails the test.
        const paths = new Array<string>(1_000_000_000);
        paths[99] = safe; // The full supported 100-item prefix remains usable.
        Object.defineProperty(paths, "100", { get() { throw new Error("beyond-limit item was inspected"); } });
        Object.defineProperty(paths, Symbol.iterator, { value() { throw new Error("raw collection was iterated"); } });
        toolInput = { [kind]: paths };
      }
      recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName, toolInput });
      if (kind !== "paths" && kind !== "files") {
        assert.deepEqual(evidence.events[0]?.candidatePaths, [], "no clipped or alternate identity is extracted");
        recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "end", toolName: "write", toolInput: { path: safe }, result: "written" });
      }
      await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
      assert.equal(evidence.candidates.size, 1);
      assert.ok(!JSON.stringify(serializeEvidenceState(evidence)).includes("prefix-decoy"), "unsupported raw identity is not durable");
      await review(root, workspace, before, evidence, { boundedIdentity: safe });
    });
  });
}

test("production bundle retains an exact path when raw input or nested records refuse enumeration", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const safe = join(root, "safe.txt");
    await writeFile(safe, "SAFE-EXTERNAL");
    const noEnumeration = {
      ownKeys(): never { throw new Error("raw record keys were enumerated"); },
    };
    const metadata = new Proxy({ secret: "RAW-RECORD-NOT-RETAINED" }, noEnumeration);
    const rawInput = {
      path: safe,
      metadata,
      edits: [metadata, [metadata]],
      files: [metadata, safe],
    };
    Object.defineProperty(rawInput, "unsupported", {
      enumerable: true,
      get(): never { throw new Error("unsupported raw field was inspected"); },
    });
    const toolInput = new Proxy(rawInput, noEnumeration);
    recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName: "write", toolInput });
    assert.equal(evidence.externalObservationRevision, 1);
    assert.deepEqual(evidence.events[0]?.candidatePaths, [safe], "omission markers never become path candidates");
    await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
    await review(root, workspace, before, evidence, { exactIdentity: safe, recordOmission: true });
  });
});

for (const adapter of ["pi-model", "claude-sdk", "codex-cli"]) {
  test(`production bundle retains redacted generic MCP arguments from ${adapter}`, async () => {
    await fixture(async (root, workspace) => {
      const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
      const evidence = createEvidenceState();
      recordObservedToolEventEvidence({
        state: evidence, cwd: workspace, selectedRoot: workspace, adapter, stage: "start", toolName: "mcp__example__request",
        toolInput: {
          url: "https://example.test",
          ...(adapter === "claude-sdk" ? { command: "opaque request" } : {}),
          options: {
            method: "POST", headers: { authorization: "GENERIC-HEADER-PRIVATE", accept: "application/json" },
            metadata: { source: "adapter", labels: ["one", { name: "two", secret: "GENERIC-NESTED-PRIVATE" }] },
            body: { password: "GENERIC-PASSWORD-PRIVATE", message: "token=GENERIC-TEXT-PRIVATE", enabled: true, count: 0, empty: null },
          },
          files: [{ name: "payload", metadata: { secret: "GENERIC-FILE-PRIVATE" } }],
        },
      });
      assert.equal(evidence.externalObservationRevision, 0, "complete generic history does not invent external effects");
      assert.ok(!JSON.stringify(serializeEvidenceState(evidence)).includes("GENERIC-HEADER-PRIVATE"));
      // A normal workspace delta opens review; generic argument history alone
      // must not invent an external filesystem effect or require review.
      await writeFile(join(workspace, "submitted.txt"), "NORMAL-WORKSPACE-DELTA");
      await review(root, workspace, before, evidence, { genericArgs: true });
    });
  });
}

test("production bundle discloses generic field, array, string and accessor omissions", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const items = Array.from({ length: 21 }, (_, index) => `item-${index}`);
    items[20] = "OMITTED-GENERIC-ITEM";
    Object.defineProperty(items, "20", { get(): never { throw new Error("out-of-bounds item read"); } });
    const options = { method: "POST", large: `${"x".repeat(500)}OMITTED-GENERIC-STRING`, items };
    Object.defineProperty(options, "accessor", { enumerable: true, get(): never { throw new Error("accessor invoked"); } });
    const fields = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`field${index}`, index === 30 ? "OMITTED-GENERIC-FIELD" : `kept-${index}`]));
    Object.defineProperty(fields, "field30", { enumerable: true, get(): never { throw new Error("out-of-bounds field read"); } });
    for (const [index, toolInput] of [{ url: "https://example.test", options }, fields, { options: fields }].entries()) {
      recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "codex-cli", stage: "start", toolName: "mcp__example__request", toolInput });
      assert.equal(evidence.externalObservationRevision, index + 1, "each incomplete generic observation invalidates prior review scope");
    }
    await review(root, workspace, before, evidence, { genericOmissions: true });
  });
});

test("generic JSON capture bounds depth and a shared node budget before redaction", async () => {
  await fixture(async (_root, workspace) => {
    const state = createEvidenceState();
    const cycle: Record<string, unknown> = { retained: "visible" };
    cycle.self = cycle;
    const leaf = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`leaf${index}`, "visible"]));
    const branch = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`branch${index}`, leaf]));
    const tree = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`tree${index}`, branch]));
    for (const toolInput of [{ cycle }, { tree }]) {
      recordObservedToolEventEvidence({ state, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName: "unknown", toolInput });
    }
    assert.equal(state.toolObservationsTruncated, true);
    assert.equal(state.requiresReview, true);
    assert.equal(state.externalObservationRevision, 2);
    assert.equal(state.candidates.size, 0);
    assert.ok(state.events.every(event => event.detail!.includes("visible")));
    assert.ok(state.events.every(event => event.detail!.includes("[... truncated ...]")));
    assert.ok(state.events.every(event => event.detail!.length <= 20_024));
  });
});

test("serialized generic detail overflow is explicitly incomplete even within field and node limits", async () => {
  await fixture(async (_root, workspace) => {
    const state = createEvidenceState();
    const record = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "v".repeat(500)]));
    recordObservedToolEventEvidence({ state, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName: "unknown", toolInput: { first: record, second: record } });
    assert.equal(state.requiresReview, true);
    assert.equal(state.toolObservationsTruncated, true);
    assert.equal(state.externalObservationRevision, 1);
    assert.equal(state.candidates.size, 0);
    assert.match(state.events[0]!.detail!, /\[\.\.\. truncated \.\.\.\]$/);
    assert.ok(state.events[0]!.detail!.length <= 20_024);
    assert.ok(state.toolObservabilityNotes?.some(note => /tool input evidence is incomplete/i.test(note)));
  });
});

test("unsupported values and failing reflection never execute accessors or lose safe identity", async () => {
  await fixture(async (root, workspace) => {
    const safe = join(root, "safe.txt");
    await writeFile(safe, "SAFE-EXTERNAL");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwingArray = new Proxy(["unused"], { getOwnPropertyDescriptor(): never { throw new Error("array reflection unavailable"); } });
    const cases: Record<string, unknown>[] = [
      { path: safe, metadata: revoked.proxy }, { path: safe, metadata: throwingArray }, { path: safe, metadata: () => "unsupported" },
      { path: safe, metadata: 1n }, { path: safe, metadata: new Date(0) },
      new Proxy({ path: safe }, { getOwnPropertyDescriptor(target, key) { if (key !== "path") throw new Error("reflection unavailable"); return Object.getOwnPropertyDescriptor(target, key); } }),
    ];
    const accessorInput = { path: safe, cmd: `touch '${join(root, "alias-decoy")}'` };
    Object.defineProperty(accessorInput, "command", { enumerable: true, get(): never { throw new Error("identity getter invoked"); } });
    cases.push(accessorInput);
    for (const toolInput of cases) {
      const state = createEvidenceState();
      recordObservedToolEventEvidence({ state, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName: "write", toolInput });
      assert.equal(state.requiresReview, true);
      assert.equal(state.toolObservationsTruncated, true);
      assert.equal(state.externalObservationRevision, 1);
      assert.deepEqual(state.events[0]?.candidatePaths, [safe]);
      assert.equal(state.candidates.size, 1);
      await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
      assert.equal(state.candidates.get(safe)?.afterSnapshot?.content, "SAFE-EXTERNAL");
    }
    const shellState = createEvidenceState();
    recordObservedToolEventEvidence({ state: shellState, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName: "bash", toolInput: accessorInput });
    assert.deepEqual(shellState.events[0]?.candidatePaths, [], "an unreadable command cannot select its cmd alias instead");
    assert.equal(shellState.candidates.size, 0);
    assert.equal(shellState.requiresReview, true);
    assert.equal(shellState.toolObservationsTruncated, true);
    assert.equal(shellState.externalObservationRevision, 1);
  });
});

test("late incomplete generic observations advance revisions even with a full event window", async () => {
  await fixture(async (_root, workspace) => {
    const state = createEvidenceState();
    const observation = { state, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start" as const, toolName: "mcp__example__request" };
    for (let index = 0; index < 200; index++) recordObservedToolEventEvidence({ ...observation, toolInput: { url: "https://example.test" } });
    assert.equal(state.externalObservationRevision, 0);
    for (let index = 0; index < 2; index++) {
      recordObservedToolEventEvidence({ ...observation, toolInput: { options: { large: "x".repeat(501) } } });
      assert.equal(state.events.length, 200);
      assert.equal(state.externalObservationRevision, index + 1);
      assert.equal(state.requiresReview, true);
      assert.equal(state.toolObservationsTruncated, true);
    }
  });
});

test("fully retained 20k raw commands and patches still supply exact safe addresses", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const safe = join(root, "safe.txt");
    await writeFile(safe, "SAFE-EXTERNAL");
    const commandTail = `printf '%s' 'token=unused' > '${safe}'`;
    const patchHead = `*** Begin Patch\n*** Add File: ${safe}\n+`;
    const patchTail = "\n*** End Patch";
    for (const [toolName, toolInput] of [
      ["bash", { command: `${" ".repeat(20_000 - commandTail.length)}${commandTail}` }],
      ["ApplyPatch", { patch: `${patchHead}${"x".repeat(20_000 - patchHead.length - patchTail.length)}${patchTail}` }],
    ] as Array<[string, Record<string, unknown>]>) {
      recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start", toolName, toolInput });
    }
    assert.equal(evidence.externalObservationRevision, 2);
    await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
    await review(root, workspace, before, evidence, { exactIdentity: safe });
  });
});

test("distinct late identity-unavailable observations advance canonical revisions even with a full event window", async () => {
  await fixture(async (_root, workspace) => {
    const evidence = createEvidenceState();
    const observation = { state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "start" as const };
    for (let index = 0; index < 200; index++) {
      recordObservedToolEventEvidence({ ...observation, toolName: "other", toolInput: {} });
    }
    assert.equal(evidence.externalObservationRevision, 0);
    for (const [index, target] of ["late-first", "late-second"].entries()) {
      recordObservedToolEventEvidence({ ...observation, toolName: "bash", toolInput: { command: `${" ".repeat(20_000)}touch ../${target}` } });
      assert.equal(evidence.events.length, 200);
      assert.equal(evidence.candidates.size, 0);
      assert.equal(evidence.requiresReview, true);
      assert.equal(evidence.toolObservationsTruncated, true);
      assert.equal(serializeEvidenceState(evidence).externalObservationRevision, index + 1,
        "a new unavailable call cannot reuse a prior pass/no-progress revision");
    }
  });
});

test("external after-state retains later same-path bytes without claiming tool authorship or a verified diff", async () => {
  await fixture(async (root, workspace) => {
    const before = await createWorkspaceSnapshot(workspace, snapshotOptions);
    const evidence = createEvidenceState();
    const path = join(root, "timing.txt");
    await writeFile(path, "OBSERVED-WRITER");
    recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "end", toolName: "write", toolInput: { path }, result: "written" });
    await execute(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'LATER-INDEPENDENT-WRITER')", path], { cwd: workspace, timeout: 10_000 });
    await captureObservedToolPathAfterStates(evidence, workspace, snapshotOptions);
    await review(root, workspace, before, evidence, { timing: path });
  });
});
