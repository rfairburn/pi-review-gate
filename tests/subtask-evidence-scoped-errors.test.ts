/**
 * Issue #61: evidence-navigation selector failures on a valid, authorized
 * executionId/taskId must be concise and task-scoped. A mistyped entryId, an
 * unknown callId, a malformed/expired cursor, or an out-of-range index must not
 * leak unrelated historical executions' inventory, IDs, titles, artifact paths,
 * diagnostic markers, or recovery history into the model-visible response, the
 * human-rendered output, or the details payload. Genuine failures (unknown
 * task/execution) keep their full group diagnostic packet.
 */
import assert from "node:assert/strict";
import { type Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import { serializeGroupSnapshot, writeGroupSnapshot, type BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { newTask, type BackgroundTaskState } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

type ToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function jsonlLines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** A pi session with a real tool call + failed result so evidence entries exist. */
function piSessionEntries(): unknown[] {
  return [
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-user-1", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    },
    {
      type: "message", id: "m-asst-1", parentId: "m-user-1", timestamp: "2025-06-01T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }],
      },
    },
    {
      type: "message", id: "m-res-1", parentId: "m-asst-1", timestamp: "2025-06-01T10:00:03.000Z",
      message: {
        role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, details: {}, usage: null,
        timestamp: "2025-06-01T10:00:03.000Z",
        content: [{ type: "text", text: "TARGET-TASK-FAILURE-MARKER" }],
      },
    },
  ];
}

interface FixtureTask {
  taskId: string;
  state: BackgroundTaskState;
  title: string;
  waveRoot?: string;
}

interface GroupSpec {
  executionId: string;
  tasks: FixtureTask[];
}

/**
 * Restores several durable v3 groups through the real controller, exercised only
 * through the registered SubtasksInspect tool. No live executors, configs, or
 * credentials are used (zero-capacity external agent guarantees no dispatch).
 */
async function managerWithGroups(
  base: string,
  sourceRoot: string,
  specs: GroupSpec[],
): Promise<{ manager: ExecutionToolManager; execute: ToolExecute; inspectTool: Record<string, any>; controller: BackgroundExecutionController; base: string }> {
  const now = new Date().toISOString();
  const groupRoots: string[] = [];
  for (const spec of specs) {
    const groupRoot = join(base, `pi-review-execution-${spec.executionId}`);
    await mkdir(groupRoot, { recursive: true });
    const records = spec.tasks.map((task) => {
      const record = newTask({ title: task.title, instructions: "do bounded work", acceptanceCriteria: ["done"] });
      record.taskId = task.taskId;
      record.state = task.state;
      if (task.waveRoot) record.waveRoot = task.waveRoot;
      return record;
    });
    const group: BackgroundExecutionGroup = {
      version: 3, revision: 1, integritySha256: "", executionId: spec.executionId, kind: "execute",
      root: await realpath(groupRoot), cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: records,
    };
    await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
    groupRoots.push(group.root);
  }
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "unstarted",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    }],
    execution: {
workerResources: [{ resourceId: "default", selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 }],
    },
  });
  // Nothing may ever dispatch in these fixtures: settlement is never needed.
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots });
  const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  return { manager, execute: inspectTool.execute as ToolExecute, inspectTool, controller, base };
}

/** Recursively snapshots every file under `root` as a sorted relativePath -> hex-bytes
 * map, so durable state can be compared for exact equality. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out[relative(root, full)] = Buffer.from(await readFile(full)).toString("hex");
    }
  }
  let info; try { info = await stat(root); } catch { return out; }
  if (info.isDirectory()) await walk(root);
  return out;
}

/** Minimal theme so the registered human renderer can run without a TUI. */
const THEME = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

/** Renders a tool result through the registered renderResult and returns its lines. */
function renderedLines(inspectTool: Record<string, any>, value: unknown): string[] {
  const component = inspectTool.renderResult(value, {}, THEME);
  assert.ok(component && typeof component.render === "function", "renderResult must return a text component");
  return component.render(400) as string[];
}

/** Markers that identify only the unrelated groups; none may leak on a scoped error. */
const UNRELATED_MARKERS = [
  "UNRELATED-INTERRUPTED-TITLE-A",
  "UNRELATED-RECOVERABLE-TITLE-A",
  "UNRELATED-INTERRUPTED-TITLE-B",
  "task-interrupted-a1",
  "task-recoverable-a1",
  "task-interrupted-b1",
  "exec-unrelated-a61",
  "exec-unrelated-b61",
];

function assertNoUnrelatedLeaks(label: string, ...haystacks: string[]): void {
  for (const haystack of haystacks) {
    for (const marker of UNRELATED_MARKERS) {
      assert.ok(!haystack.includes(marker), `${label} must not leak unrelated data: ${marker}`);
    }
    // The full-group dump header is the tell-tale of the old behavior.
    assert.ok(!haystack.includes("Task handles"), `${label} must not carry the full group dump header`);
  }
}

test("evidence selector failures are concise and task-scoped; no unrelated executions leak", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-evidence-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });

  // Target group: one task with real evidence artifacts.
  const waveRoot = join(base, "wave-target");
  const artifactDir = join(waveRoot, "artifacts", "task-target61");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));

  const specs: GroupSpec[] = [
    {
      executionId: "exec-target61",
      tasks: [{ taskId: "task-target61", state: "failed", title: "target task with evidence", waveRoot }],
    },
    {
      executionId: "exec-unrelated-a61",
      tasks: [
        { taskId: "task-interrupted-a1", state: "interrupted", title: "UNRELATED-INTERRUPTED-TITLE-A" },
        { taskId: "task-recoverable-a1", state: "paused_recoverable", title: "UNRELATED-RECOVERABLE-TITLE-A" },
      ],
    },
    {
      executionId: "exec-unrelated-b61",
      tasks: [
        { taskId: "task-interrupted-b1", state: "interrupted", title: "UNRELATED-INTERRUPTED-TITLE-B" },
      ],
    },
  ];

  const { manager, execute, inspectTool } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Baseline: a valid ranged read succeeds and yields real entry IDs.
    const page = await execute("scope-page", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 0, limit: 50 } });
    assert.equal(page.isError, false);
    const entryIds: string[] = (page.details.evidence.entries ?? []).map((entry: { entryId: string }) => entry.entryId);
    assert.ok(entryIds.length > 0, "the target task must have indexed evidence entries");

    // The mistyped entryId: a valid authorized handle plus an unknown selector.
    const response = await execute("scope-entry", {
      executionId: "exec-target61",
      taskId: "task-target61",
      evidence: { entryId: "turn:0001/line:999" },
    });
    assert.equal(response.isError, true);
    const text = String(response.content[0].text);
    // Concise, task-scoped unknown-selector error with a bounded navigation hint.
    assert.match(text, /No evidence entry "turn:0001\/line:999" exists in this task's current snapshot/);
    assert.match(text, /task-target61/, "the scoped error must name the authorized task");
    // No unrelated execution inventory, IDs, titles, artifact paths, or history —
    // in the model-visible response, the human-rendered output, and details.
    const rendered = renderedLines(inspectTool, response).join("\n");
    assertNoUnrelatedLeaks("model-visible response", text);
    assertNoUnrelatedLeaks("human-rendered output", rendered);
    assertNoUnrelatedLeaks("details payload", JSON.stringify(response.details));
    // The details payload is scoped: no full execution inventory, no recovery list.
    assert.equal(response.details.executions, undefined, "details must not carry the full execution inventory");
    assert.equal(response.details.recovery, undefined, "details must not carry generic recovery guidance for a selector error");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("adjacent selector failures (callId, cursor, range) are scoped the same way", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-evidence-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const waveRoot = join(base, "wave-target");
  const artifactDir = join(waveRoot, "artifacts", "task-target61");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));
  const specs: GroupSpec[] = [
    { executionId: "exec-target61", tasks: [{ taskId: "task-target61", state: "failed", title: "target task with evidence", waveRoot }] },
    { executionId: "exec-unrelated-a61", tasks: [{ taskId: "task-interrupted-a1", state: "interrupted", title: "UNRELATED-INTERRUPTED-TITLE-A" }] },
  ];
  const { manager, execute } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Unknown callId.
    const badCall = await execute("scope-call", { executionId: "exec-target61", taskId: "task-target61", evidence: { callId: "no-such-call-61" } });
    assert.equal(badCall.isError, true);
    assert.match(String(badCall.content[0].text), /No tool call or result with pairing id "no-such-call-61"/);
    assertNoUnrelatedLeaks("unknown callId response", String(badCall.content[0].text), JSON.stringify(badCall.details));

    // Malformed cursor.
    const badCursor = await execute("scope-cursor", { executionId: "exec-target61", taskId: "task-target61", evidence: { cursor: "ev1.not-a-real-cursor" } });
    assert.equal(badCursor.isError, true);
    assert.match(String(badCursor.content[0].text), /cursor/i);
    assertNoUnrelatedLeaks("malformed cursor response", String(badCursor.content[0].text), JSON.stringify(badCursor.details));

    // Out-of-range index.
    const badRange = await execute("scope-range", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 10_000, limit: 10 } });
    assert.equal(badRange.isError, true);
    assert.match(String(badRange.content[0].text), /index 10000 is beyond the end/);
    assertNoUnrelatedLeaks("out-of-range response", String(badRange.content[0].text), JSON.stringify(badRange.details));

    // Intentional non-error semantics are preserved: an in-range index with a
    // limit beyond the remaining entries clamps to what exists (no error), and a
    // filtered read with no matches is a valid empty result (no error).
    const clamped = await execute("scope-clamp", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 0, limit: 50 } });
    assert.equal(clamped.isError, false, "limit beyond the sequence must clamp, not fail");
    assert.ok((clamped.details.evidence.entries ?? []).length > 0, "the clamped read returns the available entries");
    const emptyFilter = await execute("scope-emptyfilter", { executionId: "exec-target61", taskId: "task-target61", evidence: { filter: "review" } });
    assert.equal(emptyFilter.isError, false, "a filtered read with no matches is a valid empty result");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("a correct entryId deep read still succeeds and an invalid read does not mutate state", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-evidence-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const waveRoot = join(base, "wave-target");
  const artifactDir = join(waveRoot, "artifacts", "task-target61");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));
  const specs: GroupSpec[] = [
    { executionId: "exec-target61", tasks: [{ taskId: "task-target61", state: "failed", title: "target task with evidence", waveRoot }] },
    { executionId: "exec-unrelated-a61", tasks: [{ taskId: "task-interrupted-a1", state: "interrupted", title: "UNRELATED-INTERRUPTED-TITLE-A" }] },
  ];
  const { manager, execute, controller, base: fixtureBase } = await managerWithGroups(base, sourceRoot, specs);
  try {
    const groupRoot = join(fixtureBase, "pi-review-execution-exec-target61");

    // The correct entryId deep-reads successfully with its retained content.
    const page = await execute("scope-page2", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 0, limit: 50 } });
    assert.equal(page.isError, false);
    const entries: Array<{ entryId: string; kind: string }> = page.details.evidence.entries ?? [];
    const resultEntry = entries.find((entry) => entry.kind === "tool_result")!;
    assert.ok(resultEntry, "a tool_result entry must exist for the deep read");
    const deep = await execute("scope-deep", { executionId: "exec-target61", taskId: "task-target61", evidence: { entryId: resultEntry.entryId } });
    assert.equal(deep.isError, false);
    assert.match(String(deep.details.evidence.deepContent?.content), /TARGET-TASK-FAILURE-MARKER/);

    // Snapshot the COMPLETE task record (via the pure synchronous inspect — which
    // does NOT run the recovery/save path) and every durable byte BEFORE the
    // invalid read, so the comparison cannot itself execute the mutation path.
    const recordBefore = controller.inspect("exec-target61", "task-target61").tasks[0];
    const groupBytesBefore = await snapshotDir(groupRoot);
    const waveBytesBefore = await snapshotDir(waveRoot);

    // An invalid entryId read through the registered tool is a scoped error and
    // must not perform recovery mutations or saves.
    const invalid = await execute("scope-invalid", { executionId: "exec-target61", taskId: "task-target61", evidence: { entryId: "does-not-exist-61" } });
    assert.equal(invalid.isError, true);
    assert.match(String(invalid.content[0].text), /No evidence entry "does-not-exist-61"/);

    // Exact equality: the invalid read must not mutate the task record or disk.
    const recordAfter = controller.inspect("exec-target61", "task-target61").tasks[0];
    assert.deepEqual(recordAfter, recordBefore, "an invalid evidence read must not mutate the task record");
    assert.deepEqual(await snapshotDir(groupRoot), groupBytesBefore, "an invalid evidence read must not rewrite durable group bytes");
    assert.deepEqual(await snapshotDir(waveRoot), waveBytesBefore, "an invalid evidence read must not touch task artifacts");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("genuine failures (unknown task/execution) keep their full group diagnostic packet", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-evidence-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const waveRoot = join(base, "wave-target");
  const artifactDir = join(waveRoot, "artifacts", "task-target61");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));
  const specs: GroupSpec[] = [
    { executionId: "exec-target61", tasks: [{ taskId: "task-target61", state: "failed", title: "target task with evidence", waveRoot }] },
    { executionId: "exec-unrelated-a61", tasks: [{ taskId: "task-interrupted-a1", state: "interrupted", title: "UNRELATED-INTERRUPTED-TITLE-A" }] },
  ];
  const { manager, execute } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Unknown task: a genuine failure that must keep the full group packet.
    const unknownTask = await execute("scope-unknowntask", { executionId: "exec-target61", taskId: "task-missing-61" });
    assert.equal(unknownTask.isError, true);
    assert.match(String(unknownTask.content[0].text), /Unknown task task-missing-61/);
    // The full group diagnostic packet is preserved for genuine failures.
    assert.ok(String(unknownTask.content[0].text).includes("Task handles"), "genuine failures keep the full group packet");
    assert.ok(Array.isArray(unknownTask.details.executions), "genuine failures keep the execution inventory in details");

    // Unknown execution: likewise a genuine failure with the full packet.
    const unknownExec = await execute("scope-unknownexec", { executionId: "exec-missing-61", taskId: "task-target61" });
    assert.equal(unknownExec.isError, true);
    assert.match(String(unknownExec.content[0].text), /Unknown execution group exec-missing-61/);
    assert.ok(Array.isArray(unknownExec.details.executions), "genuine failures keep the execution inventory in details");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("a source change around recovery cannot surface a selector error after the recovery write", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-evidence-scope-"));
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const waveRoot = join(base, "wave-target");
  const artifactDir = join(waveRoot, "artifacts", "task-target61");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  const sessionFile = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  await writeFile(sessionFile, jsonlLines(...piSessionEntries()));
  // `failed` + waveRoot with no operation record: every inspection runs the
  // checkpoint-backfill recovery path (refused here) and durably saves the
  // group — a genuine mutation between the evidence preflight and any later
  // read. This is what makes the two-read window observable.
  const specs: GroupSpec[] = [
    { executionId: "exec-target61", tasks: [{ taskId: "task-target61", state: "failed", title: "target task with evidence", waveRoot }] },
  ];
  const { manager, execute, controller } = await managerWithGroups(base, sourceRoot, specs);
  try {
    // Obtain a valid cursor from an unfiltered ranged read over all entries.
    const page = await execute("window-page", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 0, limit: 50 } });
    assert.equal(page.isError, false);
    const cursor = page.details.evidence.cursor;
    assert.ok(typeof cursor === "string" && cursor.length > 0, "the unfiltered ranged read must issue a cursor");

    // Narrow instrumentation at the real buildEvidenceRead boundary: after the
    // next evidence build returns (the preflight), replace the source file with
    // different records — the controlled interleaving an external writer
    // (append/rotation, retention GC) would cause between two separate reads of
    // the same task. In the old two-read path the second build then ran after
    // the recovery save and failed with a stale-cursor selector error.
    const seam = controller as unknown as {
      buildEvidenceRead: (task: unknown, selector: unknown) => Promise<unknown>;
    };
    const originalBuild = seam.buildEvidenceRead.bind(controller);
    let builds = 0;
    let replacementArmed = true;
    seam.buildEvidenceRead = async (task: unknown, selector: unknown) => {
      builds += 1;
      const read = await originalBuild(task, selector);
      if (replacementArmed) {
        replacementArmed = false;
        // Same source id, different records: the cursor's covered last record
        // no longer exists and its covered-prefix digests changed.
        await writeFile(sessionFile, jsonlLines(
          { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T11:00:00.000Z", cwd: "/tmp/wt" },
          { type: "message", id: "m-user-late", parentId: null, timestamp: "2025-06-01T11:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "replaced source" }] } },
        ));
      }
      return read;
    };

    const buildsBefore = builds;
    // The cursor continuation must succeed from the single coherent pre-recovery
    // read even though the source is replaced between that read and the recovery
    // write: a selector failure may never surface after the recovery mutation.
    const continued = await execute("window-cursor", { executionId: "exec-target61", taskId: "task-target61", evidence: { cursor } });
    assert.equal(continued.isError, false, "a source change after the validated read must not become a post-recovery selector error");
    assert.ok(!replacementArmed, "the controlled replacement must have fired between preflight and recovery");

    // The returned read is exactly the validated one: it still carries the
    // pre-replacement snapshot (3 entries), not the replaced source's 1 entry.
    const summary = continued.details.evidence.snapshot;
    assert.equal(summary.totalEntries, 3, "the returned read must be the validated pre-replacement snapshot");
    const sessionSource = summary.sources.find((source: { sourceId: string }) => source.sourceId.startsWith("session:"));
    assert.ok(sessionSource && sessionSource.records === 3, "the validated snapshot's session source is unchanged in the response");

    // One bounded evidence build per inspection: no duplicate artifact
    // reconstruction on the normal read path.
    assert.equal(builds - buildsBefore, 1, "one evidence inspection must build the bundle exactly once");

    // Genuine lifecycle recovery is preserved for successful reads: the
    // backfill attempt still ran and its refusal is recorded durably.
    const record = controller.inspect("exec-target61", "task-target61").tasks[0];
    assert.ok(
      record.activity.some((entry) => entry.phase === "recovery" && entry.message.startsWith("Checkpoint backfill refused")),
      "recovery still runs and records its refusal on successful evidence reads",
    );

    // Nothing is cached or hidden: the follow-up read observes the replaced source.
    const after = await execute("window-after", { executionId: "exec-target61", taskId: "task-target61", evidence: { index: 0, limit: 50 } });
    assert.equal(after.isError, false);
    assert.equal(after.details.evidence.snapshot.totalEntries, 1, "the follow-up read reflects the replaced source");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});
