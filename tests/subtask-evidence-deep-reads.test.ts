/**
 * Regression #54: faithful subtask evidence deep-read formatting.
 *
 * Synthetic isolated fixtures — multiline indented YAML, source code, unified
 * diffs, multiline tool/command output, tabs/blank lines/trailing whitespace,
 * and chunk boundaries — are exercised only through the registered
 * SubtasksInspect tool. The model-visible text (content[0].text) is asserted
 * directly: deep reads must preserve the retained original indentation,
 * newlines, tabs, and blank lines (deliberate redaction and disclosed
 * retention limits excepted); continued chunks must reconstruct the retained
 * redacted text without silent whitespace loss, normalization, or duplication;
 * compact previews stay compact and distinct from deep content. No live
 * executors, configs, or credentials are used; nothing is ever dispatched
 * (zero-capacity pool).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import { serializeGroupSnapshot, writeGroupSnapshot, type BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { EVIDENCE_DEEP_CHUNK_CHARS } from "../src/execution/subtask-evidence";
import { EVIDENCE_PREVIEW_CHARS } from "../src/execution/evidence/types";
import { newTask } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

type ToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

interface DeepReadFixture {
  base: string;
  manager: ExecutionToolManager;
  execute: ToolExecute;
}

const SESSION_ID = "aaaa5400-1111-2222-3333-444455556666";

function jsonlLines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Multiline indented YAML with a blank line, trailing whitespace, and a tab. */
const YAML_FIXTURE = [
  "deploy:",
  "  replicas: 3",
  "  strategy:",
  "    type: RollingUpdate",
  "    rollingUpdate:",
  "      maxSurge: 1",
  "      maxUnavailable: 0",
  "",
  "resources:",
  "  limits:",
  "    cpu: \"500m\"   ",
  "    memory: 256Mi",
  "  tabbed:",
  "\tindented_with_tab: true",
].join("\n");

const CODE_FIXTURE = [
  "function format(value) {",
  "\tconst lines = String(value).trim().split(NEWLINE);",
  "",
  "    return lines.map((line, index) => {",
  "        if (index === 0) {",
  "            return line;",
  "        }",
  "\t\treturn '  ' + line;",
  "    }).join(NEWLINE);",
  "}",
].join("\n");

const DIFF_FIXTURE = [
  "--- a/deploy.yaml",
  "+++ b/deploy.yaml",
  "@@ -1,3 +1,4 @@",
  " deploy:",
  "-  replicas: 1",
  "+  replicas: 3",
  "+  strategy:",
  "+    type: RollingUpdate",
].join("\n");

/** Multiline command output with trailing whitespace, a CRLF line, and a tab. */
const OUTPUT_FIXTURE = [
  "step 1: compiling   ",
  "step 2: linking\r\n",
  "",
  "\twarning: unused variable x",
  "done (2 steps)",
].join("\n");

function sessionHeader() {
  return { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" };
}

function toolCallMessage(id: string, parentId: string | null, callId: string, name: string, command: string) {
  return {
    type: "message", id, parentId, timestamp: "2025-06-01T10:00:02.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: { command } }] },
  };
}

function toolResultMessage(id: string, parentId: string, callId: string, text: string) {
  return {
    type: "message", id, parentId, timestamp: "2025-06-01T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: callId, toolName: "bash", isError: false, details: {}, usage: null, content: [{ type: "text", text }] },
  };
}

/**
 * Durable v3 execution group with one queued task bound to a synthetic wave
 * root whose artifact directory carries the given Pi session lines. The tools
 * are exercised only through the registered SubtasksInspect surface; the
 * zero-capacity pool guarantees nothing is ever dispatched.
 */
async function managerWithEvidenceTask(executionId: string, taskId: string, sessionLines: unknown[]): Promise<DeepReadFixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-deepread54-"));
  const sourceRoot = join(base, "source");
  const waveRoot = join(base, "wave");
  const artifactDir = join(waveRoot, "artifacts", taskId);
  const groupRoot = join(base, `pi-review-execution-${executionId}`);
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await mkdir(groupRoot, { recursive: true });
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...sessionLines));

  const now = new Date().toISOString();
  const record = newTask({ title: "deep read fixture", instructions: "do bounded work", acceptanceCriteria: ["done"] });
  record.taskId = taskId;
  record.state = "queued";
  record.waveRoot = waveRoot;
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId, kind: "execute",
    root: await realpath(groupRoot), cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [record],
  };
  await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));

  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  // A resolvable but zero-capacity external agent registers the tools while
  // guaranteeing nothing is ever dispatched (no live providers or processes).
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: [{
      id: "unstarted",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] },
    }],
    execution: { activeExecutor: { source: "external", id: "unstarted" } },
  });
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [group.root] });
  const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  return { base, manager, execute: inspectTool.execute as ToolExecute };
}

function visibleText(response: Record<string, any>): string {
  return String(response.content[0].text);
}

/**
 * The deep-read content lines from the model-visible text: every line after
 * the "deep read" header carrying the uniform 4-space render prefix. Stripping
 * that one uniform prefix must recover the retained text exactly.
 */
function deepBlockLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("  deep read "));
  assert.ok(start >= 0, "the model-visible text must contain the deep read header");
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("    ")) break;
    out.push(line.slice(4));
  }
  return out;
}

function assertFaithfulDeepRead(response: Record<string, any>, expected: string): void {
  const block = deepBlockLines(visibleText(response)).join("\n");
  assert.equal(block, expected, "the model-visible deep read must preserve the retained text exactly (indentation, newlines, tabs, blank lines)");
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : Number.NaN;
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

/**
 * Content whose length places a two-unit emoji exactly on the old fixed
 * chunk grid: UTF-16 units at offsets EVIDENCE_DEEP_CHUNK_CHARS - 1 and
 * EVIDENCE_DEEP_CHUNK_CHARS, so a naive slice splits the surrogate pair.
 */
function contentWithPairAtBoundary(): string {
  const headLines = Array.from({ length: 120 }, (_, i) => `section ${String(i).padStart(3, "0")}:`);
  let head = headLines.join("\n"); // no trailing newline
  const target = EVIDENCE_DEEP_CHUNK_CHARS - 1;
  assert.ok(head.length < target);
  const fillerLabel = "padding-line ";
  const fillerLen = target - head.length - 1 /* \n */ - fillerLabel.length;
  head = `${head}\n${fillerLabel}${"y".repeat(fillerLen)}`;
  assert.equal(head.length, target);
  return `${head}\u{1F642}tail after the surrogate pair\nfinal line`;
}

async function firstResultEntry(fixture: DeepReadFixture, executionId: string, taskId: string): Promise<{ entryId: string; callId?: string }> {
  const list = await fixture.execute("list", { executionId, taskId, evidence: { index: 0 } });
  assert.equal(list.isError, false);
  const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string; callId?: string }>;
  const result = entries.find((entry) => entry.kind === "tool_result");
  assert.ok(result, "the tool result must be indexed");
  return result;
}

test("registered SubtasksInspect deep read delivers multiline indented YAML as multiline indented YAML", async () => {
  const fixture = await managerWithEvidenceTask("exec-yaml54", "task-yaml-54", [
    sessionHeader(),
    toolCallMessage("m-asst-y", null, "call-y", "bash", "cat deploy.yaml"),
    toolResultMessage("m-res-y", "m-asst-y", "call-y", YAML_FIXTURE),
  ]);
  try {
    const resultEntry = await firstResultEntry(fixture, "exec-yaml54", "task-yaml-54");
    const deep = await fixture.execute("yaml-deep", { executionId: "exec-yaml54", taskId: "task-yaml-54", evidence: { entryId: resultEntry.entryId } });
    assert.equal(deep.isError, false);
    // The structured details carry the faithful chunk; the model-visible text must too.
    assert.equal(String(deep.details.evidence.deepContent.content), YAML_FIXTURE);
    assertFaithfulDeepRead(deep, YAML_FIXTURE);
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("registered SubtasksInspect deep reads preserve source code, diffs, and multiline command output", async () => {
  const fixture = await managerWithEvidenceTask("exec-mixed54", "task-mixed-54", [
    sessionHeader(),
    toolCallMessage("m-asst-c", null, "call-c", "read", "/tmp/format.ts"),
    toolResultMessage("m-res-c", "m-asst-c", "call-c", CODE_FIXTURE),
    toolCallMessage("m-asst-d", "m-res-c", "call-d", "bash", "git diff"),
    toolResultMessage("m-res-d", "m-asst-d", "call-d", DIFF_FIXTURE),
    toolCallMessage("m-asst-o", "m-res-d", "call-o", "bash", "make build"),
    toolResultMessage("m-res-o", "m-asst-o", "call-o", OUTPUT_FIXTURE),
  ]);
  try {
    const list = await fixture.execute("mixed-list", { executionId: "exec-mixed54", taskId: "task-mixed-54", evidence: { index: 0 } });
    assert.equal(list.isError, false);
    const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string; callId?: string }>;
    const byCall = new Map(entries.filter((entry) => entry.kind === "tool_result").map((entry) => [entry.callId, entry.entryId]));
    for (const [callId, expected] of [["call-c", CODE_FIXTURE], ["call-d", DIFF_FIXTURE], ["call-o", OUTPUT_FIXTURE]] as const) {
      const deep = await fixture.execute(`mixed-deep-${callId}`, { executionId: "exec-mixed54", taskId: "task-mixed-54", evidence: { entryId: byCall.get(callId)! } });
      assert.equal(deep.isError, false);
      assertFaithfulDeepRead(deep, expected);
    }
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("continued chunks reconstruct retained text exactly without corruption at chunk boundaries", async () => {
  const content = contentWithPairAtBoundary();
  const fixture = await managerWithEvidenceTask("exec-chunk54", "task-chunk-54", [
    sessionHeader(),
    toolCallMessage("m-asst-k", null, "call-k", "bash", "emit fixture"),
    toolResultMessage("m-res-k", "m-asst-k", "call-k", content),
  ]);
  try {
    const resultEntry = await firstResultEntry(fixture, "exec-chunk54", "task-chunk-54");
    let collected = "";
    let visibleCollected = "";
    let chunkIndex = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const deep = await fixture.execute(`chunk-${chunkIndex}`, { executionId: "exec-chunk54", taskId: "task-chunk-54", evidence: { entryId: resultEntry.entryId, chunkIndex } });
      assert.equal(deep.isError, false);
      const dc = deep.details.evidence.deepContent as { content: string; hasMore: boolean; nextChunk?: number };
      collected += String(dc.content);
      // The model-visible text must carry the same chunk verbatim (the
      // surrogate-pushed chunk is one unit over the grid size and must not be
      // re-clipped on the way to the model).
      const visibleChunk = deepBlockLines(visibleText(deep)).join("\n");
      assert.equal(visibleChunk, String(dc.content), `chunk ${chunkIndex} must reach the model-visible text unclipped`);
      visibleCollected += visibleChunk;
      // No chunk may contain a lone surrogate: the pair straddles the old grid boundary.
      assert.ok(!hasLoneSurrogate(String(dc.content)), `chunk ${chunkIndex} must not split a surrogate pair`);
      assert.ok(!hasLoneSurrogate(visibleChunk), `visible chunk ${chunkIndex} must not contain a lone surrogate`);
      if (chunkIndex === 0) {
        assert.equal(dc.hasMore, true, "continuation must stay explicit");
        assert.equal(dc.nextChunk, 1);
      } else {
        assert.equal(dc.hasMore, false);
      }
      if (!dc.hasMore) break;
      chunkIndex = dc.nextChunk!;
    }
    assert.equal(collected, content, "continued chunks must reconstruct the retained text exactly (no loss, normalization, or duplication)");
    assert.equal(visibleCollected, content, "model-visible continued chunks must reconstruct the retained text exactly");

    // A very large valid chunkIndex must resolve in constant time (not by
    // iterating to the requested index) and report an explicit empty chunk.
    const beyond = await fixture.execute("chunk-beyond", { executionId: "exec-chunk54", taskId: "task-chunk-54", evidence: { entryId: resultEntry.entryId, chunkIndex: 1_000_000_000 } });
    assert.equal(beyond.isError, false);
    const beyondDc = beyond.details.evidence.deepContent as { content: string; hasMore: boolean; note?: string };
    assert.equal(String(beyondDc.content), "");
    assert.equal(beyondDc.hasMore, false);
    assert.match(String(beyondDc.note ?? ""), /No retained content at this chunk/);
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("compact previews stay compact and distinct from faithful deep content", async () => {
  const fixture = await managerWithEvidenceTask("exec-preview54", "task-preview-54", [
    sessionHeader(),
    toolCallMessage("m-asst-p", null, "call-p", "bash", "cat deploy.yaml"),
    toolResultMessage("m-res-p", "m-asst-p", "call-p", YAML_FIXTURE),
  ]);
  try {
    const list = await fixture.execute("preview-list", { executionId: "exec-preview54", taskId: "task-preview-54", evidence: { index: 0 } });
    assert.equal(list.isError, false);
    const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string; preview: string }>;
    const resultEntry = entries.find((entry) => entry.kind === "tool_result")!;
    assert.ok(resultEntry.preview.length > 0 && resultEntry.preview.length <= EVIDENCE_PREVIEW_CHARS, "previews stay bounded");
    assert.ok(!resultEntry.preview.includes("\n"), "previews remain whitespace-compacted");
    assert.notEqual(resultEntry.preview, YAML_FIXTURE, "the compact preview is distinct from the deep content");

    const deep = await fixture.execute("preview-deep", { executionId: "exec-preview54", taskId: "task-preview-54", evidence: { entryId: resultEntry.entryId } });
    assert.equal(deep.isError, false);
    assertFaithfulDeepRead(deep, YAML_FIXTURE);
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("deep reads keep redaction, honest truncation, and private-reasoning exclusion", async () => {
  const secretYaml = [
    "deploy:",
    "  api_key: sk-supersecretvalue123456",
    "  replicas: 3",
  ].join("\n");
  const expectedRedacted = [
    "deploy:",
    "  api_key: [REDACTED]",
    "  replicas: 3",
  ].join("\n");
  const bigText = `BIG-OUTPUT-MARKER-${"A".repeat(300 * 1024)}`; // exceeds the per-entry retention cap
  const fixture = await managerWithEvidenceTask("exec-safe54", "task-safe-54", [
    sessionHeader(),
    {
      type: "message", id: "m-asst-s", parentId: null, timestamp: "2025-06-01T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE-DEEPREAD-MARKER secret plan details" },
          { type: "toolCall", id: "call-s", name: "bash", arguments: { command: "show config" } },
        ],
      },
    },
    toolResultMessage("m-res-s", "m-asst-s", "call-s", secretYaml),
    {
      type: "message", id: "m-asst-b", parentId: "m-res-s", timestamp: "2025-06-01T10:00:04.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-b", name: "bash", arguments: { command: "generate" } }] },
    },
    toolResultMessage("m-res-b", "m-asst-b", "call-b", bigText),
  ]);
  try {
    const list = await fixture.execute("safe-list", { executionId: "exec-safe54", taskId: "task-safe-54", evidence: { index: 0 } });
    assert.equal(list.isError, false);
    const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string; callId?: string; preview: string; contentBytes: number; truncatedContent?: boolean }>;

    // Redaction runs before display and the formatting fix does not weaken it.
    const secretEntry = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "call-s")!;
    assert.ok(secretEntry, "the redacted result must be indexed");
    const deep = await fixture.execute("safe-deep", { executionId: "exec-safe54", taskId: "task-safe-54", evidence: { entryId: secretEntry.entryId } });
    assert.equal(deep.isError, false);
    assertFaithfulDeepRead(deep, expectedRedacted);
    assert.ok(!visibleText(deep).includes("sk-supersecretvalue123456"), "the raw secret must never reach the model-visible text");

    // Truncation stays honest in the model-visible text.
    const bigEntry = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "call-b")!;
    assert.equal(bigEntry.truncatedContent, true);
    const bigDeep = await fixture.execute("safe-deep-big", { executionId: "exec-safe54", taskId: "task-safe-54", evidence: { entryId: bigEntry.entryId } });
    assert.equal(bigDeep.isError, false);
    assert.ok(visibleText(bigDeep).includes("source record truncated at retention cap"), "the retention truncation must stay explicit");
    let collectedBytes = 0;
    let chunkIndex = 0;
    let dc = bigDeep.details.evidence.deepContent as { content: string; hasMore: boolean; nextChunk?: number };
    for (let guard = 0; guard < 40; guard += 1) {
      collectedBytes += Buffer.byteLength(String(dc.content));
      if (!dc.hasMore) break;
      chunkIndex += 1;
      const more = await fixture.execute(`safe-deep-big-${chunkIndex}`, { executionId: "exec-safe54", taskId: "task-safe-54", evidence: { entryId: bigEntry.entryId, chunkIndex } });
      dc = more.details.evidence.deepContent as { content: string; hasMore: boolean; nextChunk?: number };
    }
    assert.equal(collectedBytes, bigEntry.contentBytes, "chunks cover exactly the retained content");

    // Private reasoning is excluded from every view.
    const allText = visibleText(list) + "\n" + entries.map((entry) => entry.preview).join("\n") + "\n" + visibleText(deep);
    assert.ok(!allText.includes("PRIVATE-DEEPREAD-MARKER"), "thinking content must never be indexed");
  } finally {
    await fixture.manager.shutdown();
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("pi stdout fallback retains a string tool result verbatim, not JSON-escaped", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-deepread54-"));
  const sourceRoot = join(base, "source");
  const waveRoot = join(base, "wave");
  const taskId = "task-piout-54";
  const artifactDir = join(waveRoot, "artifacts", taskId);
  const turnDir = join(artifactDir, "executor", "0001");
  const groupRoot = join(base, "pi-review-execution-exec-piout54");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(turnDir, { recursive: true });
  await mkdir(groupRoot, { recursive: true });
  const multiLine = "first line\n  second line indented\n\ttabbed line";
  await writeFile(join(turnDir, "process-result.json"), JSON.stringify({ adapter: "pi-model", code: 0, sessionId: "99999999-8888-7777-6666-555555555555" }));
  await writeFile(join(turnDir, "raw-stream.txt"), jsonlLines(
    { type: "tool_execution_start", toolCallId: "sc-54", toolName: "bash", args: { command: "emit" }, timestamp: "2025-06-01T11:00:01.000Z" },
    { type: "tool_execution_end", toolCallId: "sc-54", toolName: "bash", isError: false, result: multiLine, timestamp: "2025-06-01T11:00:05.000Z" },
  ));

  const now = new Date().toISOString();
  const record = newTask({ title: "deep read fixture", instructions: "do bounded work", acceptanceCriteria: ["done"] });
  record.taskId = taskId;
  record.state = "queued";
  record.waveRoot = waveRoot;
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-piout54", kind: "execute",
    root: await realpath(groupRoot), cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [record],
  };
  await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
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
    execution: { activeExecutor: { source: "external", id: "unstarted" } },
  });
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [group.root] });
  const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  const execute = inspectTool.execute as ToolExecute;
  try {
    const list = await execute("piout-list", { executionId: "exec-piout54", taskId, evidence: { index: 0 } });
    assert.equal(list.isError, false);
    const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string }>;
    const resultEntry = entries.find((entry) => entry.kind === "tool_result");
    assert.ok(resultEntry, "the fallback tool result must be indexed");
    const deep = await execute("piout-deep", { executionId: "exec-piout54", taskId, evidence: { entryId: resultEntry.entryId } });
    assert.equal(deep.isError, false);
    assertFaithfulDeepRead(deep, multiLine);
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});

test("codex web search completions retain the query text and previously retained metadata faithfully", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-deepread54-"));
  const sourceRoot = join(base, "source");
  const waveRoot = join(base, "wave");
  const taskId = "task-codex-54";
  const artifactDir = join(waveRoot, "artifacts", taskId);
  const turnDir = join(artifactDir, "executor", "0001");
  const groupRoot = join(base, "pi-review-execution-exec-codex54");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(turnDir, { recursive: true });
  await mkdir(groupRoot, { recursive: true });
  const query = "how do I indent\n  yaml correctly";
  const failedQuery = "example\n  indented";
  await writeFile(join(turnDir, "process-result.json"), JSON.stringify({ adapter: "codex-cli", code: 0 }));
  await writeFile(join(turnDir, "raw-stream.txt"), jsonlLines(
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "web_search", query } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { type: "web_search", query, status: "completed" } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "web_search", query: failedQuery } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { type: "web_search", query: failedQuery, status: "failed", error: { message: "SYNTHETIC_NETWORK_FAILURE" }, id: "search-1" } } },
  ));

  const now = new Date().toISOString();
  const record = newTask({ title: "deep read fixture", instructions: "do bounded work", acceptanceCriteria: ["done"] });
  record.taskId = taskId;
  record.state = "queued";
  record.waveRoot = waveRoot;
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-codex54", kind: "execute",
    root: await realpath(groupRoot), cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [record],
  };
  await writeGroupSnapshot(group.root, serializeGroupSnapshot(group, new Map()));
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
    execution: { activeExecutor: { source: "external", id: "unstarted" } },
  });
  config.execution!.maxWorkers = 0;
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [group.root] });
  const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect");
  assert.ok(inspectTool, "SubtasksInspect must be registered");
  const execute = inspectTool.execute as ToolExecute;
  try {
    const list = await execute("codex-list", { executionId: "exec-codex54", taskId, evidence: { index: 0 } });
    assert.equal(list.isError, false);
    const entries = (list.details.evidence.entries ?? []) as Array<{ entryId: string; kind: string; status?: string; preview: string }>;
    const results = entries.filter((entry) => entry.kind === "tool_result");
    assert.equal(results.length, 2, "both web search completions must be indexed");
    const okEntry = results.find((entry) => !entry.preview.includes("web search failed"));
    const failedEntry = results.find((entry) => entry.preview.includes("web search failed"));
    assert.ok(okEntry, "the successful web search completion must be indexed");
    assert.ok(failedEntry, "the failed web search completion must be indexed");

    // The query is the item's safe text field: retained verbatim, not
    // JSON-escaped. Remaining fields keep their previously retained compact
    // JSON representation (truthful lossless rendering of the completed item).
    const okExpected = `${query}\nweb search completed\n{"status":"completed"}`;
    const okDeep = await execute("codex-deep", { executionId: "exec-codex54", taskId, evidence: { entryId: okEntry.entryId } });
    assert.equal(okDeep.isError, false);
    assert.equal(okEntry.status, "succeeded");
    assert.equal(String(okDeep.details.evidence.deepContent.content), okExpected);
    assertFaithfulDeepRead(okDeep, okExpected);

    // Regression: a failed search keeps its diagnostic and previously retained
    // metadata (error detail, id) instead of silently dropping every field but
    // the query — in both the structured deep content and the model-visible text.
    const failedExpected = `${failedQuery}\nweb search failed\n{"status":"failed","error":{"message":"SYNTHETIC_NETWORK_FAILURE"},"id":"search-1"}`;
    const failedDeep = await execute("codex-deep-failed", { executionId: "exec-codex54", taskId, evidence: { entryId: failedEntry.entryId } });
    assert.equal(failedDeep.isError, false);
    assert.equal(failedEntry.status, "failed", "the failed search must stay failed, never reported as success");
    assert.equal(String(failedDeep.details.evidence.deepContent.content), failedExpected);
    // Model-visible assertions: reconstructing the deep-read block from the
    // model text (stripping the uniform render prefix) must recover the
    // multiline query and the error diagnostic exactly.
    assertFaithfulDeepRead(failedDeep, failedExpected);
    const visibleBlock = deepBlockLines(visibleText(failedDeep)).join("\n");
    assert.ok(visibleBlock.includes("example\n  indented"), "the multiline query must reach the model verbatim");
    assert.ok(visibleBlock.includes("SYNTHETIC_NETWORK_FAILURE"), "the failed search's error detail must reach the model");
    assert.ok(visibleBlock.includes('"id":"search-1"'), "the previously retained item id must survive to the model-visible text");
  } finally {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  }
});
