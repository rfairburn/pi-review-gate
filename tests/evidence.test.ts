import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureObservedToolPathAfterStates,
  collectEvidenceChanges,
  buildEvidenceBundle,
  createEvidenceState,
  extractCandidatePaths,
  recordAcceptedReviewerQuestion,
  recordObservedToolEventEvidence,
  recordToolCallEvidence,
  recordToolEventObservability,
  restoreEvidenceState,
  serializeEvidenceState,
  rememberFinalAssistantSummary,
  rememberFinalAssistantSummaryText,
  shouldRecordToolCallEvidence,
  shouldRecordToolResultEvidence,
} from "../src/evidence";

const snapshotOptions = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
};

test("post-hoc outside-root tool observations are separate evidence with an unverified pre-state", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-gate-inplace-observed-"));
  const workspace = join(scratch, "selected-root");
  const external = join(scratch, "outside.txt");
  await mkdir(workspace, { recursive: true });
  const state = createEvidenceState();
  try {
    await writeFile(external, "written before the parent event was delivered\n", "utf8");
    // Deliberately observe after mutation to exercise the race: no pre-event
    // snapshot is invented from the stream callback.
    for (const stage of ["start", "end"] as const) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "pi-model",
        stage,
        toolName: "write",
        toolInput: { path: external },
        ...(stage === "end" ? { result: "wrote file" } : {}),
      });
    }
    await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
    const bundle = buildEvidenceBundle(state, [], undefined, { selectedCwd: workspace, workspaceRoot: workspace });
    assert.equal(state.requiresReview, true);
    assert.equal(state.externalObservationRevision, 2, "each external tool observation advances the bounded revision");
    assert.equal(bundle.changedCandidatePaths.length, 0, "external observations are not in-root delta entries");
    assert.equal(bundle.candidates.length, 1);
    assert.equal(bundle.candidates[0]?.baseline, "unverified");
    assert.equal(bundle.candidates[0]?.externalSideEffect, true);
    assert.equal(bundle.candidates[0]?.afterSnapshot?.content, "written before the parent event was delivered\n");
    assert.match(bundle.markdown, /outside the selected workspace/);
    assert.match(bundle.markdown, /prior state is unverified/);
    assert.match(bundle.markdown, /not a diff/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("observed external evidence persists across continuations and stays bounded to the selected-root choice", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-gate-inplace-observed-restore-"));
  const workspace = join(scratch, "root");
  const narrowerRoot = join(workspace, "selected-subdir");
  const external = join(scratch, "external.txt");
  await mkdir(narrowerRoot, { recursive: true });
  const original = createEvidenceState();
  const restored = createEvidenceState();
  try {
    await writeFile(external, "current\n", "utf8");
    recordObservedToolEventEvidence({
      state: original,
      cwd: workspace,
      selectedRoot: workspace,
      adapter: "codex-cli",
      stage: "start",
      toolName: "write",
      toolInput: { files: [external] },
    });
    await captureObservedToolPathAfterStates(original, workspace, snapshotOptions);
    restoreEvidenceState(restored, JSON.parse(JSON.stringify(serializeEvidenceState(original))) as unknown, workspace);
    assert.equal(restored.requiresReview, true);
    assert.equal(restored.events.length, 1);
    assert.equal(original.externalObservationRevision, 1);
    assert.equal(restored.externalObservationRevision, 1, "the observation revision survives evidence restoration");
    await writeFile(external, "changed after continuation\n", "utf8");
    await captureObservedToolPathAfterStates(restored, workspace, snapshotOptions);
    assert.equal([...restored.candidates.values()][0]?.prestateUnverified, true);
    assert.equal([...restored.candidates.values()][0]?.afterSnapshot?.content, "changed after continuation\n");

    const narrower = createEvidenceState();
    recordObservedToolEventEvidence({
      state: narrower,
      cwd: workspace,
      selectedRoot: narrowerRoot,
      adapter: "codex-cli",
      stage: "start",
      toolName: "write",
      toolInput: { path: external },
    });
    assert.equal(narrower.requiresReview, true, "the explicitly selected narrower root is the comparison boundary");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an unavailable event stream is disclosed without inventing a tool observation", () => {
  const state = createEvidenceState();
  recordToolEventObservability(state, "run-as-binary", {
    mode: "unavailable",
    description: "No structured tool calls are forwarded.",
  });
  const bundle = buildEvidenceBundle(state, []);
  assert.equal(bundle.requiresReview, false);
  assert.deepEqual(bundle.events, []);
  assert.match(bundle.markdown, /No structured tool calls are forwarded/);
  assert.match(bundle.markdown, /Missing events do not prove/);
});

test("tool path and event limits stay bounded and force review when evidence is truncated", async () => {
  const scratch = await mkdtemp(join(process.cwd(), ".pi-review-gate-inplace-bounds-"));
  const workspace = join(scratch, "root");
  await mkdir(workspace, { recursive: true });
  const state = createEvidenceState();
  try {
    const paths = Array.from({ length: 30 }, (_, index) => join(scratch, `outside-${index}.txt`));
    recordObservedToolEventEvidence({
      state,
      cwd: workspace,
      selectedRoot: workspace,
      adapter: "codex-cli",
      stage: "start",
      toolName: "write",
      toolInput: { files: paths },
    });
    assert.equal(state.events[0]?.candidatePaths.length, 25);
    assert.equal(state.candidates.size, 25);
    assert.equal(state.toolObservationsTruncated, true);
    assert.equal(state.requiresReview, true);

    for (let index = 1; index < 205; index += 1) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "codex-cli",
        stage: "end",
        toolName: "write",
        toolInput: { path: paths[0] },
        result: "observed",
      });
    }
    assert.equal(state.events.length, 200);
    assert.equal(state.toolObservationsTruncated, true);
    assert.equal(state.requiresReview, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("extractCandidatePaths finds shell redirection and tee targets", () => {
  const result = extractCandidatePaths("bash", {
    command: "cat > /tmp/review-gate-a.txt <<EOF\nhello\nEOF\nprintf x | tee -a logs/out.txt",
  });

  assert.deepEqual(result.paths.map((item) => item.path), [
    "/tmp/review-gate-a.txt",
    "logs/out.txt",
  ]);
  assert.ok(result.riskSignals.includes("shell_redirection"));
  assert.ok(result.riskSignals.includes("tee_write"));
  assert.ok(result.riskSignals.includes("heredoc"));
});

test("/dev/null discard-write extraction omits sink writes while destructive device edits stay evidenced", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const sinkWrites = [
    "ls hello.txt 2>/dev/null || echo fallback",
    "grep pattern in.txt 2> /dev/null",
    "build-tool >/dev/null",
    "long-runner >> /dev/null",
    "runner &> /dev/null",
    "runner 1>/dev/null 2>&1",
    "runner > /dev/null 2>&1",
    "runner >> /dev/null 2>&1",
    "runner 2> /dev/null 2>&1",
    "runner >>/dev/null",
    "printf x | tee -a /dev/null",
    "runner 2> //dev/null",
    "runner > /dev/./null",
    "runner > /dev/../dev/null",
  ];
  for (const command of sinkWrites) {
    const result = extractCandidatePaths("bash", { command });
    assert.deepEqual(result.paths, [], `no discard-write candidate for: ${command}`);
    assert.ok(result.riskSignals.length > 0, `non-null risk signals stay attached: ${command}`);
  }

  // Deleting, renaming, replacing, creating, or altering metadata of the
  // device is not an output drop: every such operation stays a candidate.
  const retainedDeviceOperations: Array<{ command: string; paths: string[]; signal: string }> = [
    { command: "touch /dev/null", paths: ["/dev/null"], signal: "shell_touch" },
    { command: "rm -f /dev/null", paths: ["/dev/null"], signal: "shell_rm" },
    { command: "mkdir /dev/null", paths: ["/dev/null"], signal: "shell_mkdir" },
    { command: "cp keep.txt /dev/null", paths: ["/dev/null"], signal: "shell_cp" },
    { command: "mv keep.txt /dev/null", paths: ["keep.txt", "/dev/null"], signal: "shell_mv" },
  ];
  for (const { command, paths, signal } of retainedDeviceOperations) {
    const result = extractCandidatePaths("bash", { command });
    assert.deepEqual(result.paths.map((item) => item.path), paths, `destructive device operation stays evidenced: ${command}`);
    assert.ok(result.riskSignals.includes(signal), `operation signal stays attached: ${command}`);
  }

  const retained: Array<[string, string]> = [
    ["build-tool > dev/null", "dev/null"],
    ["build-tool > ./dev/null", "./dev/null"],
    ["build-tool > ./dev/../null", "./dev/../null"],
    ["build-tool > /dev/nul", "/dev/nul"],
    ["build-tool > /dev/null2", "/dev/null2"],
    ["build-tool > /dev/null.txt", "/dev/null.txt"],
    ["build-tool > /dev/null/foo", "/dev/null/foo"],
    ["build-tool > '/dev/null '", "/dev/null "],
    ["build-tool > /dev/zero", "/dev/zero"],
    ["build-tool > /dev/stdout", "/dev/stdout"],
    ["build-tool > /DEV/NULL", "/DEV/NULL"],
    ["build-tool > devnull", "devnull"],
  ];
  for (const [command, path] of retained) {
    const result = extractCandidatePaths("bash", { command });
    assert.deepEqual(result.paths, [{ path, source: "bash:command" }], `real path stays evidenced: ${command}`);
  }

  // The full-overwrite write tool targeting the sink is a direct discard
  // write; the in-place edit tool keeps the device as a candidate instead.
  assert.deepEqual(extractCandidatePaths("write", { path: "/dev/null" }).paths, []);
  const files = extractCandidatePaths("write", { files: ["/dev/null", "/tmp/keep.txt"] });
  assert.deepEqual(files.paths, [{ path: "/tmp/keep.txt", source: "write:files" }]);
  const homeLookalike = extractCandidatePaths("write", { path: "~/dev/null" });
  assert.deepEqual(homeLookalike.paths, [{ path: "~/dev/null", source: "write:path" }]);
  assert.deepEqual(extractCandidatePaths("edit", { file_path: "/dev/null" }).paths, [
    { path: "/dev/null", source: "edit:file_path" },
  ], "an in-place edit of the device stays an evidenced candidate");

  applyPatchDeviceCandidates();
});

function applyPatchDeviceCandidates(): void {
  // The envelope deletion targets the device node itself, not a discarded
  // output stream, so it stays a pre-captured mutation candidate.
  const sinkPatch = [
    "*** Begin Patch",
    "*** Delete File: /dev/null",
    "*** End Patch",
  ].join("\n");
  const deletion = extractCandidatePaths("applypatch", { patch: sinkPatch });
  assert.deepEqual(deletion.paths, [{ path: "/dev/null", source: "applypatch:patch" }], "the envelope deletion of the device stays a mutation candidate");
  assert.ok(deletion.riskSignals.includes("apply_patch_mutation"), "non-null risk signals stay attached");
  // Control: the same operation shape on a real path stays pre-captured.
  const realPatch = [
    "*** Begin Patch",
    "*** Delete File: gone.txt",
    "*** End Patch",
  ].join("\n");
  const retained = extractCandidatePaths("applypatch", { patch: realPatch });
  assert.deepEqual(retained.paths, [{ path: "gone.txt", source: "applypatch:patch" }]);
}

test("a dev/null file inside the task root remains a real evidenced candidate", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-relative-null-"));
  const state = createEvidenceState();
  try {
    await recordToolCallEvidence({
      state,
      cwd: workspace,
      toolName: "write",
      toolInput: { path: "dev/null" },
      snapshotOptions,
    });
    assert.equal(state.candidates.size, 1, "the relative lookalike is a normal in-root candidate");
    const candidate = [...state.candidates.values()][0]!;
    assert.equal(candidate.path, "dev/null");
    assert.equal(candidate.absolutePath, join(workspace, "dev", "null"));
    assert.equal(candidate.baseline?.exists, false);
    assert.ok(!candidate.externalSideEffect);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("null-only observed shell writes do not create candidates, review, or revision churn", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-null-"));
  const workspace = join(scratch, "selected-root");
  await mkdir(workspace, { recursive: true });
  const state = createEvidenceState();
  try {
    const command = "ls hello.txt 2>/dev/null || echo fallback";
    for (const stage of ["start", "end"] as const) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "codex-cli",
        stage,
        toolName: "bash",
        toolInput: { command },
        ...(stage === "end" ? { result: "stdout" } : {}),
      });
    }
    assert.equal(state.candidates.size, 0, "the discard sink is not an external side-effect candidate");
    assert.equal(state.externalObservationRevision, 0, "review revision is not advanced by the null sink");
    assert.equal(state.requiresReview, false, "review is not required solely due the null sink");
    assert.equal(state.toolObservationsTruncated, false);
    assert.equal(state.events.length, 2, "the observed command remains normal tool history");
    for (const event of state.events) {
      assert.deepEqual(event.candidatePaths, []);
      assert.ok(event.riskSignals.includes("shell_redirection"), "non-null risk signals stay attached");
    }
    const startEvent = state.events[0]!;
    assert.match(startEvent.summary, /ls hello\.txt 2>\/dev\/null \|\| echo fallback/);
    assert.ok(startEvent.detail?.includes(command), "the raw command text is preserved verbatim in detail");

    // Ordinary (non-observed) evidence likewise captures no baseline snapshot for the sink.
    await recordToolCallEvidence({
      state,
      cwd: workspace,
      toolName: "bash",
      toolInput: { command },
      snapshotOptions,
    });
    assert.equal(state.candidates.size, 0);
    assert.equal(state.events.length, 3);

    await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
    const bundle = buildEvidenceBundle(state, [], undefined, { selectedCwd: workspace, workspaceRoot: workspace });
    assert.equal(bundle.candidates.length, 0);
    assert.equal(bundle.requiresReview, false);
    assert.equal(bundle.changedCandidatePaths.length, 0);
    assert.match(bundle.markdown, /2>\/dev\/null \|\| echo fallback/, "the original command stays in the tool event digest");
    assert.doesNotMatch(bundle.markdown, /Tool-observed external side-effect candidates/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a mixed command keeps the real external write under review while omitting only the null sink", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const scratch = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-mixed-"));
  const workspace = join(scratch, "selected-root");
  await mkdir(workspace, { recursive: true });
  const realOutside = join(scratch, "outside-real.txt");
  const state = createEvidenceState();
  try {
    const command = `ls hello.txt 2>/dev/null; printf after > ${realOutside}`;
    for (const stage of ["start", "end"] as const) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "codex-cli",
        stage,
        toolName: "bash",
        toolInput: { command },
        ...(stage === "end" ? { result: "stdout" } : {}),
      });
    }
    assert.equal(state.candidates.size, 1, "only the real outside write becomes a candidate");
    assert.equal(state.externalObservationRevision, 2, "the real external write still advances the bounded revision (once per observed stage)");
    assert.equal(state.requiresReview, true, "the real outside-only write still requires review");
    const observed = [...state.candidates.values()][0]!;
    assert.equal(observed.externalSideEffect, true);
    assert.equal(observed.absolutePath, realOutside);
    assert.deepEqual(state.events[0]?.candidatePaths, [realOutside]);
    assert.ok(state.events[0]?.riskSignals.includes("shell_redirection"));

    await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
    const bundle = buildEvidenceBundle(state, [], undefined, { selectedCwd: workspace, workspaceRoot: workspace });
    assert.equal(bundle.candidates.length, 1);
    assert.equal(bundle.candidates[0]?.externalSideEffect, true);
    assert.equal(bundle.candidates[0]?.baseline, "unverified");
    assert.ok(bundle.markdown.includes(realOutside), "the real outside path stays visible for review");
    assert.match(bundle.markdown, /2>\/dev\/null/, "the original command history is preserved");
    assert.doesNotMatch(bundle.markdown, /candidate.*\/dev\/null/, "the sink is not itself listed as a candidate");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a direct observed overwrite of the null sink creates no candidate, review, or revision", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-null-write-"));
  const state = createEvidenceState();
  try {
    for (const stage of ["start", "end"] as const) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "codex-cli",
        stage,
        toolName: "write",
        toolInput: { path: "/dev/null" },
        ...(stage === "end" ? { result: "wrote /dev/null" } : {}),
      });
    }
    assert.equal(state.candidates.size, 0, "the direct sink overwrite is not a side-effect candidate");
    assert.equal(state.externalObservationRevision, 0, "review revision is not advanced by the direct sink write");
    assert.equal(state.requiresReview, false);
    assert.equal(state.events.length, 2, "the observed write remains normal tool history");
    for (const event of state.events) {
      assert.deepEqual(event.candidatePaths, []);
    }
    assert.ok(state.events[1]!.detail?.includes("/dev/null"), "the observed write input stays in the raw history");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a compound null redirect and destructive sink command keeps the deletion candidate and review", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX /dev/null extraction comparisons require a POSIX resolver");
  }
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-null-destructive-"));
  const state = createEvidenceState();
  try {
    const command = "ls 2>/dev/null; rm /dev/null";
    for (const stage of ["start", "end"] as const) {
      recordObservedToolEventEvidence({
        state,
        cwd: workspace,
        selectedRoot: workspace,
        adapter: "codex-cli",
        stage,
        toolName: "bash",
        toolInput: { command },
        ...(stage === "end" ? { result: "stdout" } : {}),
      });
    }
    const candidate = [...state.candidates.values()][0];
    assert.ok(candidate, "the device deletion stays an external candidate even with the benign redirect in the same command");
    assert.equal(candidate!.externalSideEffect, true);
    assert.equal(candidate!.absolutePath, "/dev/null");
    assert.equal(state.externalObservationRevision, 2, "the destructive observation advances the bounded revision (once per observed stage)");
    assert.equal(state.requiresReview, true, "the device deletion still triggers review");
    for (const event of state.events) {
      assert.deepEqual(event.candidatePaths, ["/dev/null"]);
      assert.ok(event.riskSignals.includes("shell_redirection"), "the null redirect stays a recorded risk signal");
      assert.ok(event.riskSignals.includes("shell_rm"), "the device deletion stays a risk signal");
    }
    assert.ok(state.events[0]!.detail?.includes(command), "the raw compound command stays verbatim in history");

    await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
    const bundle = buildEvidenceBundle(state, [], undefined, { selectedCwd: workspace, workspaceRoot: workspace });
    assert.equal(bundle.candidates.length, 1);
    assert.equal(bundle.candidates[0]?.externalSideEffect, true);
    assert.equal(bundle.candidates[0]?.baseline, "unverified");
    assert.equal(bundle.requiresReview, true);
    assert.match(bundle.markdown, /external side-effect candidates/);
    assert.match(bundle.markdown, /\/dev\/null/, "the sink deletion stays visible for review");
    assert.match(bundle.markdown, /ls 2>\/dev\/null; rm \/dev\/null/, "the original compound command history is preserved");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("successful discovery tools are transient while their failures remain review evidence", () => {
  for (const toolName of ["read", "grep", "glob", "find", "ls", "Read", "GREP", "BrowserScreenshot"]) {
    assert.equal(shouldRecordToolCallEvidence(toolName), false, toolName);
    assert.equal(shouldRecordToolResultEvidence(toolName, false), false, toolName);
    assert.equal(shouldRecordToolResultEvidence(toolName, true), true, toolName);
  }
  assert.equal(shouldRecordToolCallEvidence("write"), true);
  assert.equal(shouldRecordToolResultEvidence("bash", false), true);
});

test("browser form tool-call evidence structurally removes exact values and selections", async () => {
  const state = createEvidenceState();
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["BrowserFill", { session: "s", tab: "t", ref: "r", value: "ordinary private prose" }, ["ordinary private prose"]],
    ["BrowserType", { session: "s", tab: "t", ref: "r", text: "password=hunter2" }, ["hunter2"]],
    ["BrowserSelect", { session: "s", tab: "t", ref: "r", values: ["private-a", "private-b"] }, ["private-a", "private-b"]],
  ];
  for (const [toolName, toolInput, secrets] of cases) {
    await recordToolCallEvidence({ state, cwd: process.cwd(), toolName, toolInput, snapshotOptions });
    const event = state.events.at(-1)!;
    const rendered = `${event.summary}\n${event.detail}`;
    for (const secret of secrets) assert.equal(rendered.includes(secret), false);
    assert.match(rendered, /\[REDACTED\]/);
  }
});

test("candidate extraction follows mutation semantics instead of generic path arguments", () => {
  for (const toolName of ["read", "grep", "glob", "find", "ls", "SubtasksInspect"]) {
    assert.deepEqual(extractCandidatePaths(toolName, { path: "server/hosts.go" }).paths, [], toolName);
  }

  assert.deepEqual(extractCandidatePaths("write", { path: "server/hosts.go" }).paths, [{
    path: "server/hosts.go",
    source: "write:path",
  }]);
  assert.deepEqual(extractCandidatePaths("edit", { file_path: "server/hosts.go" }).paths, [{
    path: "server/hosts.go",
    source: "edit:file_path",
  }]);

  const copied = extractCandidatePaths("bash", { command: "cp source.txt generated/dest.txt" });
  assert.deepEqual(copied.paths.map((entry) => entry.path), ["generated/dest.txt"]);
  const moved = extractCandidatePaths("bash", { command: "mv source.txt generated/dest.txt" });
  assert.deepEqual(moved.paths.map((entry) => entry.path), ["source.txt", "generated/dest.txt"]);
});

test("evidence pre-captures a missing outside-worktree file before creation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
    });
    await writeFile(outside, "created\n", "utf8");

    const changes = await collectEvidenceChanges(state, cwd, snapshotOptions);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.path, outside);
    assert.equal(changes[0]?.status, "added");
    assert.equal(changes[0]?.newContent, undefined);
    assert.equal(changes[0]?.diffOmittedReason, "outside_workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("evidence pre-captures an existing outside-worktree file before modification", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-existing-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await writeFile(outside, "before\n", "utf8");
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "bash",
      toolInput: { command: `printf after > ${outside}` },
      snapshotOptions,
    });
    await writeFile(outside, "after\n", "utf8");

    const changes = await collectEvidenceChanges(state, cwd, snapshotOptions);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.path, outside);
    assert.equal(changes[0]?.status, "modified");
    assert.equal(changes[0]?.oldContent, undefined);
    assert.equal(changes[0]?.newContent, undefined);
    assert.equal(changes[0]?.diffOmittedReason, "outside_workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("outside-worktree evidence keeps an independent baseline for each exchange", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-gate-evidence-exchanges-cwd-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-exchanges-${Date.now()}.txt`);
  const state = createEvidenceState();
  try {
    await writeFile(outside, "original\n", "utf8");
    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
      exchangeSequence: 1,
    });
    await writeFile(outside, "incorrect\n", "utf8");

    await recordToolCallEvidence({
      state,
      cwd,
      toolName: "write",
      toolInput: { path: outside },
      snapshotOptions,
      exchangeSequence: 2,
    });
    await writeFile(outside, "original\n", "utf8");

    const cumulative = await collectEvidenceChanges(state, cwd, snapshotOptions);
    const correction = await collectEvidenceChanges(state, cwd, snapshotOptions, 2);

    assert.equal(cumulative.length, 0);
    assert.equal(correction.length, 1);
    assert.equal(correction[0]?.oldContent, undefined);
    assert.equal(correction[0]?.newContent, undefined);
    assert.equal(state.events[0]?.exchangeSequence, 1);
    assert.equal(state.events[1]?.exchangeSequence, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("rememberFinalAssistantSummary extracts the last assistant text", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummary(state, [
    {
      messages: [
        { role: "assistant", content: "older" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: [{ type: "text", text: "final summary" }] },
      ],
    },
  ]);

  assert.equal(state.finalAssistantSummaries.at(-1), "final summary");
});

test("rememberFinalAssistantSummary keeps multiple turn summaries for continued review", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: "first summary" }] }]);
  rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: "second summary" }] }]);

  const bundle = buildEvidenceBundle(state, []);

  assert.deepEqual(state.finalAssistantSummaries, ["first summary", "second summary"]);
  assert.match(bundle.markdown, /Summary 1/);
  assert.match(bundle.markdown, /first summary/);
  assert.match(bundle.markdown, /Summary 2/);
  assert.match(bundle.markdown, /second summary/);
});

test("rememberFinalAssistantSummaryText bounds and redacts adapter-extracted responses", () => {
  const state = createEvidenceState();

  rememberFinalAssistantSummaryText(
    state,
    `  Completion reported with api_key=${"x".repeat(48)}. ${"a".repeat(5000)}  `,
  );

  assert.equal(state.finalAssistantSummaries.length, 1);
  assert.ok(state.finalAssistantSummaries[0]!.length <= 4020);
  assert.match(state.finalAssistantSummaries[0]!, /\[\.\.\. truncated \.\.\.\]$/);
  assert.doesNotMatch(state.finalAssistantSummaries[0]!, /x{48}/);
  assert.match(state.finalAssistantSummaries[0]!, /Completion reported/);
});

test("review-window evidence does not discard older assistant summaries", () => {
  const state = createEvidenceState();
  for (let index = 1; index <= 12; index += 1) {
    rememberFinalAssistantSummary(state, [{ messages: [{ role: "assistant", content: `summary ${index}` }] }]);
  }

  const bundle = buildEvidenceBundle(state, []);

  assert.equal(state.finalAssistantSummaries.length, 12);
  assert.match(bundle.markdown, /Summary 1\n\nsummary 1/);
  assert.match(bundle.markdown, /Summary 12\n\nsummary 12/);
});

test("evidence markdown preserves every tool event in the review window", () => {
  const state = createEvidenceState();
  for (let index = 1; index <= 200; index += 1) {
    state.events.push({
      sequence: index,
      phase: "tool_call",
      toolName: "bash",
      summary: `event ${index}`,
      candidatePaths: [],
      riskSignals: [],
    });
  }

  const bundle = buildEvidenceBundle(state, []);

  assert.match(bundle.markdown, /#1 tool_call bash: event 1/);
  assert.match(bundle.markdown, /#40 tool_call bash: event 40/);
  assert.match(bundle.markdown, /#41 tool_call bash: event 41/);
  assert.match(bundle.markdown, /#80 tool_call bash: event 80/);
  assert.match(bundle.markdown, /#81 tool_call bash: event 81/);
  assert.match(bundle.markdown, /#200 tool_call bash: event 200/);
  assert.doesNotMatch(bundle.markdown, /events omitted/);
});

test("accepted reviewer questions and edited answers become structured evidence", () => {
  const state = createEvidenceState();

  recordAcceptedReviewerQuestion(state, {
    question: "How should this be fixed?",
    acceptedAnswer: "Use this exact edit:\n\n```diff\n-old\n+new\n```",
    acceptedAt: "2026-07-29T00:00:00.000Z",
  });

  const bundle = buildEvidenceBundle(state, []);

  assert.deepEqual(bundle.acceptedReviewerQuestions, [{
    sequence: 1,
    question: "How should this be fixed?",
    acceptedAnswer: "Use this exact edit:\n\n```diff\n-old\n+new\n```",
    acceptedAt: "2026-07-29T00:00:00.000Z",
  }]);
  assert.match(bundle.markdown, /Accepted reviewer questions and answers/);
  assert.match(bundle.markdown, /```diff\n-old\n\+new\n```/);
});

test("evidence candidate baselines distinguish unreadable existing paths and surface in markdown", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-evidence-unreadable-"));
  try {
    await writeFile(join(dir, "candidate.txt"), "candidate content\n", "utf8");
    await chmod(join(dir, "candidate.txt"), 0o000);
    const state = createEvidenceState();
    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "write",
      toolInput: { path: "candidate.txt" },
      snapshotOptions,
    });
    const bundle = buildEvidenceBundle(state, []);
    const candidate = bundle.candidates.find((entry) => entry.path === "candidate.txt");
    assert.equal(candidate?.baseline, "unreadable");
    assert.equal(candidate?.baselineSnapshot?.omittedReason, "unreadable");
    assert.match(bundle.markdown, /candidate\.txt \(unreadable;/);
  } finally {
    await chmod(join(dir, "candidate.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
