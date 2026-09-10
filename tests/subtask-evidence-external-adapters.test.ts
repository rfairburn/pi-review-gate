/**
 * #69: retained Claude/Codex evidence inspection parity.
 *
 * Every case drives the real production pipeline (buildSubtaskEvidence +
 * readSubtaskEvidence) against synthetic RETAINED external stream artifacts on
 * disk — realistic Claude Agent SDK stream-json lines and Codex app-server
 * JSON-RPC notifications, shaped like what the executor adapters retain in
 * executor/NNNN/raw-stream.txt. No pipeline reimplementation in fixtures.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubtaskEvidence, readConfinedOperationRecord, readSubtaskEvidence, type SubtaskEvidenceBundle } from "../src/execution/subtask-evidence";
import { EvidenceNavigationError } from "../src/execution/evidence/navigation";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "subtask-evidence-external-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeTaskArtifacts(name: string, taskId = "task-1"): Promise<{ waveRoot: string; artifactDir: string }> {
  const waveRoot = join(root, name);
  const artifactDir = join(waveRoot, "artifacts", taskId);
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await mkdir(join(artifactDir, "executor", "0001"), { recursive: true });
  return { waveRoot, artifactDir };
}

function jsonlLines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function writeTurn(artifactDir: string, turnName: string, adapter: string | undefined, streamLines: unknown[], extra?: Record<string, unknown>): Promise<void> {
  const dir = join(artifactDir, "executor", turnName);
  await mkdir(dir, { recursive: true });
  if (adapter !== undefined) await writeFile(join(dir, "process-result.json"), JSON.stringify({ adapter, code: 0, ...extra }));
  await writeFile(join(dir, "raw-stream.txt"), jsonlLines(...streamLines));
}

function retainedText(bundle: SubtaskEvidenceBundle): string {
  return [...bundle.snapshot.contentByEntryId.values()].join("\n");
}

/** Shared timeline for the durable operation record fixtures below. */
const OP = {
  a0Start: "2025-06-01T08:00:00.000Z",
  t1Start: "2025-06-01T08:00:05.000Z",
  t1End: "2025-06-01T08:05:00.000Z",
  a0End: "2025-06-01T08:06:00.000Z",
  a1Start: "2025-06-01T08:07:00.000Z",
  t2Start: "2025-06-01T08:07:05.000Z",
  t2End: "2025-06-01T08:12:00.000Z",
  a1End: "2025-06-01T08:13:00.000Z",
  a2Start: "2025-06-01T08:14:00.000Z",
  t3Start: "2025-06-01T08:14:05.000Z",
};

interface OperationFixture {
  /** The record's CURRENT (latest assignment) resolved adapter, as wave-worker.ts rewrites it at each assignment start. */
  adapter?: string;
  generation?: number;
  assignments: Array<{
    entryId?: string;
    selection: unknown;
    generation: number;
    reason?: "initial" | "failover" | "continuation";
    startedAt: string;
    endedAt?: string;
    outcome?: string;
  }>;
  attempts: Array<{
    turn: number;
    generation: number;
    startedAt: string;
    endedAt?: string;
    outcome?: string;
  }>;
}

/**
 * The durable operation record as the producer writes it (wave-worker.ts /
 * executor-recovery.ts): per-turn attempt records (turn -> generation),
 * per-assignment records (generation -> selection window), and the mutable
 * top-level `adapter` that always describes only the LATEST assignment.
 */
async function writeOperation(artifactDir: string, spec: OperationFixture): Promise<void> {
  await writeFile(join(artifactDir, "operation.json"), JSON.stringify({
    version: 1,
    revision: spec.assignments.length + spec.attempts.length,
    operationId: "wave-1/task-1",
    waveId: "wave-1",
    taskId: "task-1",
    title: "fixture task",
    state: "running",
    worktreeRoot: "/wt",
    effectiveCwd: "/wt",
    artifactDir,
    ...(spec.adapter !== undefined ? { adapter: spec.adapter } : {}),
    generation: spec.generation ?? 0,
    retryBudget: 3,
    assignments: spec.assignments.map((assignment) => ({
      entryId: assignment.entryId ?? "entry-1",
      priority: 0,
      selection: assignment.selection,
      generation: assignment.generation,
      reason: assignment.reason ?? "initial",
      startedAt: assignment.startedAt,
      ...(assignment.endedAt !== undefined ? { endedAt: assignment.endedAt } : {}),
      ...(assignment.outcome !== undefined ? { outcome: assignment.outcome } : {}),
    })),
    attempts: spec.attempts.map((attempt, index) => ({
      attempt: index + 1,
      generation: attempt.generation,
      turn: attempt.turn,
      startedAt: attempt.startedAt,
      ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}),
      ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
    })),
    incidents: [],
    instructions: [],
    nextInstructionSequence: 1,
    createdAt: OP.a0Start,
    updatedAt: OP.t3Start,
  }));
}

/** Loads the record through the real confined reader (the production inspect path). */
async function loadOperation(artifactDir: string): Promise<NonNullable<Awaited<ReturnType<typeof readConfinedOperationRecord>>["record"]>> {
  const loaded = await readConfinedOperationRecord(artifactDir, "task-1");
  assert.equal(loaded.unavailable, undefined, "the confined reader must accept the record");
  assert.ok(loaded.record);
  return loaded.record;
}

/** Realistic Claude Agent SDK stream-json lines (as retained by claude-cli.ts). */
const CLAUDE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function claudeStreamLines(): unknown[] {
  return [
    {
      type: "system", subtype: "init", cwd: "/repo", session_id: CLAUDE_SESSION_ID,
      tools: ["Read", "Grep", "Glob"], model: "claude-opus-4-6", permissionMode: "dontAsk", uuid: "sys-1",
    },
    {
      type: "assistant",
      message: {
        id: "msg_01", type: "message", role: "assistant", model: "claude-opus-4-6",
        content: [
          { type: "thinking", thinking: "CLAUDE-PRIVATE-REASONING-MARKER secret plan" },
          { type: "text", text: "I will inspect the repository." },
          { type: "tool_use", id: "toolu_01AAA", name: "Read", input: { file_path: "/repo/README.md" } },
        ],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 34 },
      },
      parent_tool_use_id: null, uuid: "asst-1", session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T09:00:01.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_01AAA", is_error: false, content: [{ type: "text", text: "# Repo\n\nreadable retained evidence with ghp_ABCDEFGHIJKLMNOPQRSTUVWX inside" }] },
      ]},
      parent_tool_use_id: null, uuid: "user-1", session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T09:00:02.000Z",
    },
    {
      type: "result", subtype: "success", duration_ms: 1500, is_error: false, num_turns: 1, result: "done",
      session_id: CLAUDE_SESSION_ID, total_cost_usd: 0.01, usage: { input_tokens: 40, output_tokens: 60 },
    },
  ];
}

test("claude retained raw stream is discoverable and navigable (reported case)", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-reported");
  await writeTurn(artifactDir, "0001", "claude-cli", claudeStreamLines(), { sessionId: CLAUDE_SESSION_ID });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });

  // The readable stream is a discovered source, never "No evidence sources".
  assert.ok(bundle.snapshot.sources.some((source) => source.sourceId === "turn:0001" && source.adapter === "claude-cli"));
  assert.equal(bundle.snapshot.capability.toolEvidence, "available");
  assert.ok(!/no evidence sources/i.test(bundle.snapshot.capability.reason ?? ""));

  // Real call/result pairing by the stream's own tool ids.
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(call && result);
  assert.equal(call.callId, "toolu_01AAA");
  assert.equal(call.toolName, "Read");
  assert.equal(call.status, "returned");
  assert.equal(call.pairedWith, result.entryId);
  assert.equal(result.pairedWith, call.entryId);
  assert.equal(result.status, "succeeded");

  // Stream timestamps surface on entries (display metadata the stream supplies).
  assert.equal(call.at, "2025-06-02T09:00:01.000Z");
  assert.equal(result.at, "2025-06-02T09:00:02.000Z");

  // Private reasoning is excluded from every retained view.
  const allText = `${retainedText(bundle)}\n${bundle.snapshot.entries.map((entry) => entry.preview).join("\n")}`;
  assert.ok(!allText.includes("CLAUDE-PRIVATE-REASONING-MARKER"));

  // Redaction happens before search/display: the token is redacted in content.
  const resultContent = bundle.snapshot.contentByEntryId.get(result.entryId)!;
  assert.ok(resultContent.includes("[REDACTED]"));
  assert.ok(!resultContent.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWX"));

  // Indexed search over the retained stream.
  const found = readSubtaskEvidence(bundle, { find: "READABLE RETAINED EVIDENCE" });
  assert.equal(found.mode, "find");
  assert.equal(found.matchSummary?.totalMatches, 1);
  assert.equal(found.matches?.[0]?.entryId, result.entryId);

  // Pairing read by call id.
  const pair = readSubtaskEvidence(bundle, { callId: "toolu_01AAA" });
  assert.equal(pair.mode, "call");
  assert.equal(pair.callPair?.status, "returned");
  assert.ok(pair.callPair?.call && pair.callPair?.result);

  // Process outcome and worker claim are present as observed/claimed evidence.
  assert.ok(bundle.snapshot.entries.some((entry) => entry.kind === "process" && /exit code: 0/.test(entry.preview)));
  assert.equal(bundle.snapshot.entries.filter((entry) => entry.kind === "claim").length, 0); // no final-response.md written
});

test("claude find distinguishes zero matches from unavailable evidence", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-empty-find");
  await writeTurn(artifactDir, "0001", "claude-cli", claudeStreamLines());

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const miss = readSubtaskEvidence(bundle, { find: "needle-that-appears-nowhere" });
  assert.equal(miss.mode, "find");
  assert.equal(miss.matchSummary?.totalMatches, 0);
  assert.deepEqual(miss.matches, []);
  // The snapshot still reports its real capability and sources: an empty
  // result is not presented as missing evidence.
  assert.equal(miss.snapshot.capability.toolEvidence, "available");
  assert.ok(miss.snapshot.sources.length > 0);

  // A task with no readable artifact directory at all says so explicitly.
  const absent = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir: join(waveRoot, "artifacts", "missing-task") });
  assert.ok(absent.snapshot.unavailable.some((item) => item.reason === "artifact_dir_missing"));
  assert.equal(absent.snapshot.capability.toolEvidence, "unavailable");
  assert.equal(absent.snapshot.capability.reason, "No evidence sources were found for this task.");
});

test("claude deep read preserves formatting and continues by chunk", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-deep");
  // Multiline indented YAML well over one deep-read chunk (8000 chars).
  const yaml = Array.from({ length: 260 }, (_, i) => `  key_${i}:\n    nested_value: "line ${i}"\n\n`).join("");
  await writeTurn(artifactDir, "0001", "claude-cli", [
    { type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID, model: "claude-opus-4-6" },
    {
      type: "assistant",
      message: { id: "msg_02", role: "assistant", content: [{ type: "tool_use", id: "toolu_02BBB", name: "Read", input: { file_path: "/repo/config.yaml" } }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T10:00:01.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02BBB", content: [{ type: "text", text: yaml }] }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T10:00:02.000Z",
    },
    { type: "result", subtype: "success", is_error: false, result: "done", session_id: CLAUDE_SESSION_ID },
  ]);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(result);
  assert.ok(result.contentBytes > 8_000, "fixture must span multiple deep-read chunks");

  const chunk0 = readSubtaskEvidence(bundle, { entryId: result.entryId, chunkIndex: 0 });
  assert.equal(chunk0.mode, "entry");
  assert.equal(chunk0.deepContent?.chunkIndex, 0);
  assert.ok(chunk0.deepContent?.hasMore);
  assert.equal(chunk0.deepContent?.nextChunk, 1);
  // Formatting preserved in the deep read (the preview is compact by design).
  assert.ok(chunk0.deepContent!.content.includes('\n    nested_value: "line 0"'));
  assert.ok(!result.preview.includes("\n"));

  const chunk1 = readSubtaskEvidence(bundle, { entryId: result.entryId, chunkIndex: 1 });
  assert.equal(chunk1.deepContent?.chunkIndex, 1);
  // Continued chunks reconstruct the retained content exactly (fixture spans
  // exactly two 8000-char grid chunks).
  assert.equal(`${chunk0.deepContent!.content}${chunk1.deepContent!.content}`, yaml);
  assert.equal(chunk1.deepContent?.hasMore, false);

  // A chunk beyond the retained content is an explicit empty note, not silent content.
  const beyond = readSubtaskEvidence(bundle, { entryId: result.entryId, chunkIndex: 99 });
  assert.equal(beyond.deepContent?.content, "");
  assert.match(beyond.deepContent?.note ?? "", /earlier chunkIndex/);
});

test("claude cursor continuation across stream appends without duplicates", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-cursor");
  const streamPath = join(artifactDir, "executor", "0001", "raw-stream.txt");
  await writeTurn(artifactDir, "0001", "claude-cli", claudeStreamLines());

  const bundle1 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  // Consume a stable prefix of the source (the derived process record stays
  // last while the stream grows, so the watermark must not sit on it).
  const first = readSubtaskEvidence(bundle1, { index: 0, limit: 3 });
  assert.ok(first.cursor);
  const firstIds = (first.entries ?? []).map((entry) => entry.entryId);
  assert.equal(firstIds.length, 3);

  // The live turn appends another tool round to the retained stream.
  await appendFile(streamPath, jsonlLines(
    {
      type: "assistant",
      message: { id: "msg_03", role: "assistant", content: [{ type: "tool_use", id: "toolu_04CCC", name: "Grep", input: { pattern: "TODO" } }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T11:00:01.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_04CCC", is_error: false, content: [{ type: "text", text: "appended grep result" }] }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-06-02T11:00:02.000Z",
    },
  ));

  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle2.snapshot.totalEntries, bundle1.snapshot.totalEntries + 2);
  const continued = readSubtaskEvidence(bundle2, { cursor: first.cursor! });
  assert.equal(continued.mode, "cursor");
  // Exactly the unconsumed remainder plus the appended round — no duplicates.
  const continuedIds = (continued.entries ?? []).map((entry) => entry.entryId);
  assert.deepEqual(continuedIds, bundle2.snapshot.entries.slice(3).map((entry) => entry.entryId));
  assert.ok(continuedIds.length >= 2);
  assert.deepEqual(continuedIds.filter((id) => firstIds.includes(id)), []);

  // The appended round is itself paired by its real id.
  const appendedCall = bundle2.snapshot.entries.find((entry) => entry.callId === "toolu_04CCC" && entry.kind === "tool_call")!;
  assert.equal(appendedCall.status, "returned");
});

test("claude in-flight turn without process-result.json is indexed via its own recorded assignment", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-no-process-result");
  // Only the raw stream is retained (in-flight or incomplete turn: the
  // process result has not landed yet): it must still be discoverable. The
  // record's single assignment IS the latest one, so its producer-written
  // current adapter legitimately describes this turn.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(...claudeStreamLines()));
  await writeOperation(artifactDir, {
    adapter: "claude-cli",
    generation: 0,
    assignments: [{ selection: { source: "external", id: "claude-agent" }, generation: 0, startedAt: OP.a0Start }],
    attempts: [{ turn: 1, generation: 0, startedAt: OP.t1Start }],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });

  const source = bundle.snapshot.sources.find((candidate) => candidate.sourceId === "turn:0001");
  assert.ok(source, "the turn must be a discovered source");
  assert.equal(source?.adapter, "claude-cli");
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call");
  assert.ok(call, "the readable stream's tool evidence must be indexed");
  assert.equal(call?.callId, "toolu_01AAA");

  // The provenance is explicit: this turn's own recorded assignment, not a guess.
  const note = bundle.snapshot.unavailable.find((item) => item.reason === "adapter_from_operation_record");
  assert.ok(note, "the operation-record adapter fallback must be disclosed");
  assert.match(note!.detail, /claude-cli/);
  assert.match(note!.detail, /latest assignment ran this turn/);
  assert.ok(bundle.snapshot.unavailable.some((item) => item.reason === "unreadable" && /process-result\.json is missing/.test(item.detail)));

  // Navigation over the source works.
  const found = readSubtaskEvidence(bundle, { find: "readable retained evidence" });
  assert.equal(found.matchSummary?.totalMatches, 1);
});

test("process-result.json without an adapter field falls back to the turn's recorded assignment", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-process-result-no-adapter");
  await writeTurn(artifactDir, "0001", undefined, claudeStreamLines());
  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), JSON.stringify({ code: 0 }));
  await writeOperation(artifactDir, {
    adapter: "claude-cli",
    generation: 0,
    assignments: [{ selection: { source: "external", id: "claude-agent" }, generation: 0, startedAt: OP.a0Start }],
    attempts: [{ turn: 1, generation: 0, startedAt: OP.t1Start }],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });
  assert.ok(bundle.snapshot.entries.some((entry) => entry.kind === "tool_call" && entry.callId === "toolu_01AAA"));
  assert.ok(bundle.snapshot.unavailable.some((item) => item.reason === "adapter_from_operation_record"));
});

test("changed executor history cannot relabel earlier metadata-missing turns with the current adapter", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("adapter-history");
  // Turn 1 ran under the first assignment (an external agent that resolved to
  // codex-cli at the time); its process result never landed. The record's
  // CURRENT adapter is the later claude-cli assignment — it must NOT be used
  // to label turn 1's stream.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(...codexCamelStreamLines()));
  // Turn 2 is in-flight under the current claude-cli assignment (no process
  // result yet): its stream IS labeled by the record's current adapter.
  await writeTurn(artifactDir, "0002", undefined, claudeStreamLines());
  await writeOperation(artifactDir, {
    adapter: "claude-cli",
    generation: 1,
    assignments: [
      { entryId: "entry-codex", selection: { source: "external", id: "codex-agent" }, generation: 0, reason: "initial", startedAt: OP.a0Start, endedAt: OP.a0End, outcome: "completed" },
      { entryId: "entry-claude", selection: { source: "external", id: "claude-agent" }, generation: 1, reason: "failover", startedAt: OP.a1Start },
    ],
    attempts: [
      { turn: 1, generation: 0, startedAt: OP.t1Start, endedAt: OP.t1End, outcome: "completed" },
      { turn: 2, generation: 1, startedAt: OP.t2Start },
    ],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });

  // Turn 1: its own assignment is historical and its external agent id cannot
  // be resolved from durable evidence — the stream stays explicitly unindexed,
  // never relabeled with the current claude-cli adapter.
  const turn1 = bundle.snapshot.sources.find((source) => source.sourceId === "turn:0001");
  assert.ok(turn1, "the historical turn must still be a discovered source");
  assert.equal(turn1!.adapter, "unknown");
  assert.equal(
    bundle.snapshot.entries.filter((entry) => entry.source.sourceId === "turn:0001" && (entry.kind === "tool_call" || entry.kind === "tool_result")).length,
    0,
    "the historical stream must not be parsed under the current adapter",
  );
  assert.ok(bundle.snapshot.unavailable.some((item) => item.source === "turn:0001"
    && item.reason === "unsupported_adapter"
    && /external agent id/.test(item.detail)));

  // Turn 2 (current assignment, in-flight): indexed with the record's current
  // adapter and disclosed.
  const turn2 = bundle.snapshot.sources.find((source) => source.sourceId === "turn:0002");
  assert.equal(turn2?.adapter, "claude-cli");
  assert.ok(bundle.snapshot.entries.some((entry) => entry.source.sourceId === "turn:0002" && entry.kind === "tool_call" && entry.callId === "toolu_01AAA"));
  assert.ok(bundle.snapshot.unavailable.some((item) => item.source === "turn:0002"
    && item.reason === "adapter_from_operation_record"
    && /claude-cli/.test(item.detail)));
});

test("per-turn process results keep their own adapter despite a changed current assignment", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("per-turn-precedence");
  // Both turns have their own producer-recorded process results; the record's
  // current adapter (a later binary assignment) must not override them.
  await writeTurn(artifactDir, "0001", "claude-cli", claudeStreamLines());
  await writeTurn(artifactDir, "0002", "codex-cli", codexCamelStreamLines(), { code: 1 });
  await writeOperation(artifactDir, {
    adapter: "run-as-binary",
    generation: 2,
    assignments: [
      { entryId: "entry-claude", selection: { source: "external", id: "claude-agent" }, generation: 0, reason: "initial", startedAt: OP.a0Start, endedAt: OP.a0End, outcome: "completed" },
      { entryId: "entry-codex", selection: { source: "external", id: "codex-agent" }, generation: 1, reason: "failover", startedAt: OP.a1Start, endedAt: OP.a1End, outcome: "completed" },
      { entryId: "entry-binary", selection: { source: "external", id: "binary-agent" }, generation: 2, reason: "failover", startedAt: OP.a2Start },
    ],
    attempts: [
      { turn: 1, generation: 0, startedAt: OP.t1Start, endedAt: OP.t1End, outcome: "completed" },
      { turn: 2, generation: 1, startedAt: OP.t2Start, endedAt: OP.t2End, outcome: "completed" },
    ],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });

  // Each turn keeps its own producer-recorded adapter (explicit per-turn
  // process-result precedence over the current assignment).
  assert.equal(bundle.snapshot.sources.find((source) => source.sourceId === "turn:0001")?.adapter, "claude-cli");
  assert.equal(bundle.snapshot.sources.find((source) => source.sourceId === "turn:0002")?.adapter, "codex-cli");
  assert.ok(!bundle.snapshot.unavailable.some((item) => item.reason === "adapter_from_operation_record"),
    "no operation-record fallback may be needed or disclosed");

  // Both turns' tool evidence is present and paired under their own adapters.
  assert.ok(bundle.snapshot.entries.some((entry) => entry.source.sourceId === "turn:0001" && entry.kind === "tool_call" && entry.callId === "toolu_01AAA"));
  assert.ok(bundle.snapshot.entries.some((entry) => entry.source.sourceId === "turn:0002" && entry.kind === "tool_result" && entry.toolName === "command_execution"));
});

test("metadata-missing turn with a legacy operation record (no per-turn evidence) stays explicitly unavailable", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("legacy-record");
  // A pre-attempt-era record: it names a current adapter but carries no
  // per-turn attempts or assignments, so NO turn's adapter can be established
  // from it — the stream stays unindexed rather than guessed.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(...claudeStreamLines()));
  await writeOperation(artifactDir, { adapter: "claude-cli", generation: 0, assignments: [], attempts: [] });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });

  assert.equal(bundle.snapshot.sources.find((source) => source.sourceId === "turn:0001")?.adapter, "unknown");
  assert.equal(
    bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call" || entry.kind === "tool_result").length,
    0,
  );
  const note = bundle.snapshot.unavailable.find((item) => item.source === "turn:0001" && item.reason === "unsupported_adapter");
  assert.ok(note, "the unindexable stream must be reported explicitly");
  assert.match(note!.detail, /Cannot determine the turn adapter/);
  assert.match(note!.detail, /no attempt for this turn/);
});

test("historical pi turn is not relabeled by a later external assignment", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-history");
  // Turn 1 ran under a pi selection; the record's current (latest) assignment
  // is an external claude agent. The per-turn chain establishes "pi-model" for
  // turn 1 — which this raw-stream fallback does not index — so the stream
  // stays explicitly unindexed instead of being parsed as claude.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "pi-1", toolName: "bash", args: {} },
  ));
  await writeOperation(artifactDir, {
    adapter: "claude-cli",
    generation: 0,
    assignments: [
      { entryId: "entry-pi", selection: { source: "pi", model: "qwen2.5-coder" }, generation: 0, reason: "initial", startedAt: OP.a0Start, endedAt: OP.a0End, outcome: "completed" },
      { entryId: "entry-claude", selection: { source: "external", id: "claude-agent" }, generation: 0, reason: "continuation", startedAt: OP.a1Start },
    ],
    attempts: [
      { turn: 1, generation: 0, startedAt: OP.t1Start, endedAt: OP.t1End, outcome: "completed" },
    ],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });

  assert.equal(bundle.snapshot.sources.find((source) => source.sourceId === "turn:0001")?.adapter, "unknown");
  assert.equal(
    bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call" || entry.kind === "tool_result").length,
    0,
  );
  const note = bundle.snapshot.unavailable.find((item) => item.source === "turn:0001" && item.reason === "unsupported_adapter");
  assert.ok(note);
  assert.match(note!.detail, /pi executor/);
});

test("turn with no recorded adapter anywhere stays explicitly unavailable, never guessed", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-unknown-stream");
  // A readable stream exists, but neither process-result.json nor the
  // operation record names an adapter: it must stay unindexed and explicit.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(
    { foo: 1 }, { bar: { baz: 2 } }, { qux: [1, 2, 3] },
  ));

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call" || entry.kind === "tool_result").length, 0);
  const note = bundle.snapshot.unavailable.find((item) => item.reason === "unsupported_adapter");
  assert.ok(note, "the unindexable stream must be reported explicitly");
  assert.match(note!.detail, /Cannot determine the turn adapter/);
  assert.equal(bundle.snapshot.capability.toolEvidence, "unavailable");
  // Truthful distinction: sources exist but carry no tool records.
  assert.match(bundle.snapshot.capability.reason ?? "", /No tool call\/result records were found/);

  const miss = readSubtaskEvidence(bundle, { find: "foo" });
  assert.equal(miss.matchSummary?.totalMatches, 0);
});

/** Realistic Codex app-server JSON-RPC notifications: camelCase item types AND camelCase item fields (exitCode/aggregatedOutput), as the executor adapter itself recognizes. */
function codexCamelStreamLines(): unknown[] {
  return [
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "reasoning", summary: ["CODEX-PRIVATE-CAMEL-MARKER"] } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", command: "npm test" } } },
    { jsonrpc: "2.0", id: 3, result: {} },
    {
      jsonrpc: "2.0", method: "item/completed",
      params: { item: { type: "commandExecution", command: "npm test", exitCode: 1, aggregatedOutput: "Running tests\n\n  suite A\n    ✗ failing case (expected 1, got 2)\n\n42 passed, 1 failed" } },
    },
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", command: "git status" } } },
    {
      jsonrpc: "2.0", method: "item/completed",
      params: { item: { type: "commandExecution", command: "git status", exitCode: 0, aggregatedOutput: "On branch main\nnothing to commit, working tree clean" } },
    },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: "The build failed." } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "failed" } } },
  ];
}

test("codex app-server stream with camelCase fields pairs, statuses, searches, and deep-reads", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-camel");
  await writeTurn(artifactDir, "0001", "codex-cli", codexCamelStreamLines(), { code: 1 });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });

  // This fixture models an OLDER retained capture whose items carry no stable
  // ids: conservative positional pairing while unambiguous, with real statuses
  // derived from the camelCase exitCode field.
  const calls = bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call");
  const results = bundle.snapshot.entries.filter((entry) => entry.kind === "tool_result");
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  const [call1, call2] = calls;
  const [result1, result2] = results;
  assert.ok(call1 && call2 && result1 && result2);
  assert.equal(call1.toolName, "command_execution");
  assert.equal(call1.status, "returned");
  assert.equal(call1.pairedWith, result1.entryId);
  assert.equal(result1.pairedWith, call1.entryId);
  assert.equal(result1.status, "failed");
  assert.match(result1.preview, /exit code: 1/);
  assert.equal(call2.status, "returned");
  assert.equal(call2.pairedWith, result2.entryId);
  assert.equal(result2.status, "succeeded");
  assert.match(result2.preview, /exit code: 0/);

  // Private reasoning stays excluded in every view.
  const allText = `${retainedText(bundle)}\n${bundle.snapshot.entries.map((entry) => entry.preview).join("\n")}`;
  assert.ok(!allText.includes("CODEX-PRIVATE-CAMEL-MARKER"));

  // The command filter matches both paired executions.
  const commands = readSubtaskEvidence(bundle, { filter: "command" });
  assert.equal(commands.entries?.length, 4);

  // Indexed search reaches the retained camelCase aggregatedOutput.
  const found = readSubtaskEvidence(bundle, { find: "failing case (expected 1, got 2)" });
  assert.equal(found.matchSummary?.totalMatches, 1);
  assert.equal(found.matches?.[0]?.entryId, result1.entryId);

  // Deep read preserves the multiline command output formatting.
  const deep = readSubtaskEvidence(bundle, { entryId: result1.entryId, chunkIndex: 0 });
  assert.ok(deep.deepContent?.content.includes("  suite A\n    ✗ failing case (expected 1, got 2)"));
});

test("codex in-flight turn without process-result.json is indexed via its own recorded assignment", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-no-process-result");
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), jsonlLines(...codexCamelStreamLines()));
  await writeOperation(artifactDir, {
    adapter: "codex-cli",
    generation: 0,
    assignments: [{ selection: { source: "external", id: "codex-agent" }, generation: 0, startedAt: OP.a0Start }],
    attempts: [{ turn: 1, generation: 0, startedAt: OP.t1Start }],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });
  const source = bundle.snapshot.sources.find((candidate) => candidate.sourceId === "turn:0001");
  assert.equal(source?.adapter, "codex-cli");
  assert.ok(bundle.snapshot.entries.some((entry) => entry.kind === "tool_call"));
  assert.ok(bundle.snapshot.unavailable.some((item) => item.reason === "adapter_from_operation_record" && /codex-cli/.test(item.detail)));
});

/** Modern retained app-server stream: items carry stable ids (item.id), including overlapping in-flight calls. */
function codexIdStreamLines(): unknown[] {
  return [
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-a", type: "commandExecution", command: "npm test" } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-b", type: "commandExecution", command: "git status" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-a", type: "commandExecution", command: "npm test", exitCode: 0, aggregatedOutput: "42 passed" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-b", type: "commandExecution", command: "git status", exitCode: 1, aggregatedOutput: "fatal: not a git repository" } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-c", type: "mcpToolCall", server: "ctx", tool: "search" } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-d", type: "mcpToolCall", server: "ctx", tool: "search" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-d", type: "mcpToolCall", server: "ctx", tool: "search", status: "completed" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-c", type: "mcpToolCall", server: "ctx", tool: "search", status: "failed", error: "boom" } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } },
  ];
}

test("codex items with observed ids pair by identity, including overlapping calls", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-ids");
  await writeTurn(artifactDir, "0001", "codex-cli", codexIdStreamLines());

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const entries = bundle.snapshot.entries;

  // Overlapping commands pair by observed id (not position): completions
  // arrive in the opposite order of their starts.
  const callA = entries.find((entry) => entry.kind === "tool_call" && entry.callId === "item-a")!;
  const resultA = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "item-a")!;
  assert.ok(callA && resultA);
  assert.equal(callA.status, "returned");
  assert.equal(callA.pairedWith, resultA.entryId);
  assert.equal(resultA.pairedWith, callA.entryId);
  assert.equal(resultA.status, "succeeded");
  assert.match(resultA.preview, /exit code: 0/);

  const callB = entries.find((entry) => entry.kind === "tool_call" && entry.callId === "item-b")!;
  const resultB = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "item-b")!;
  assert.ok(callB && resultB);
  assert.equal(callB.status, "returned");
  assert.equal(resultB.status, "failed");
  assert.match(resultB.preview, /exit code: 1/);

  // Overlapping same-tool MCP calls (identical tool names) pair by id too.
  const callC = entries.find((entry) => entry.kind === "tool_call" && entry.callId === "item-c")!;
  const resultC = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "item-c")!;
  assert.ok(callC && resultC);
  assert.equal(callC.toolName, "ctx/search");
  assert.equal(resultC.status, "failed");
  const callD = entries.find((entry) => entry.kind === "tool_call" && entry.callId === "item-d")!;
  const resultD = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "item-d")!;
  assert.ok(callD && resultD);
  assert.equal(resultD.status, "succeeded");

  // Pairing navigation by the observed item id.
  const pair = readSubtaskEvidence(bundle, { callId: "item-a" });
  assert.equal(pair.mode, "call");
  assert.equal(pair.callPair?.status, "returned");
  assert.ok(pair.callPair?.call && pair.callPair?.result);
});

/** Stream mixing unknown, mismatched, and missing item ids (plus one clean legacy id-less pair). */
function codexMismatchedIdStreamLines(): unknown[] {
  return [
    // A clean legacy id-less pair still links positionally while unambiguous.
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", command: "plain" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { type: "commandExecution", command: "plain", exitCode: 0 } } },
    // A single pending start with NO id must not pair with a completion that
    // carries an observed id.
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", command: "legacy" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-r", type: "commandExecution", command: "legacy", exitCode: 0 } } },
    // Started under one observed id, completed under a different one.
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-a", type: "commandExecution", command: "npm test" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-q", type: "commandExecution", command: "npm test", exitCode: 0 } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } },
  ];
}

test("codex unknown, mismatched, or missing ids stay honestly unpaired; legacy positional pairing is preserved", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-mismatched-ids");
  await writeTurn(artifactDir, "0001", "codex-cli", codexMismatchedIdStreamLines());

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const entries = bundle.snapshot.entries;
  const calls = entries.filter((entry) => entry.kind === "tool_call" && entry.toolName === "command_execution");
  const results = entries.filter((entry) => entry.kind === "tool_result" && entry.toolName === "command_execution");
  assert.equal(calls.length, 3);
  assert.equal(results.length, 3);

  // The missing-id start stays unpaired: the observed id item-r does not match it.
  const legacyCall = calls.find((call) => call.callId === "cmd:2")!;
  assert.ok(legacyCall, "the id-less start keeps its synthetic positional id");
  assert.equal(legacyCall.status, "in_flight");
  assert.equal(legacyCall.pairedWith, undefined);

  // The mismatched-id start (item-a completed as item-q) stays in flight.
  const callA = calls.find((call) => call.callId === "item-a")!;
  assert.ok(callA);
  assert.equal(callA.status, "in_flight");
  assert.equal(callA.pairedWith, undefined);

  // Both id-bearing completions are indexed but unattributed (no fabricated pairing).
  const unpairedResults = results.filter((result) => result.pairedWith === undefined);
  assert.deepEqual(
    unpairedResults.map((result) => result.callId).sort(),
    ["item-q", "item-r"],
  );

  // The clean legacy id-less pair still links positionally while unambiguous.
  const plainCall = calls.find((call) => call.callId === "cmd:1")!;
  assert.ok(plainCall);
  assert.equal(plainCall.status, "returned");
  const plainResult = results.find((result) => result.pairedWith === plainCall.entryId)!;
  assert.ok(plainResult);
  assert.equal(plainResult.callId, "cmd:1");
  assert.equal(plainResult.pairedWith, plainCall.entryId);

  // A call read for the never-completed observed id reports in flight.
  const pair = readSubtaskEvidence(bundle, { callId: "item-a" });
  assert.equal(pair.mode, "call");
  assert.equal(pair.callPair?.status, "in_flight");
  assert.equal(pair.callPair?.result, undefined);
});

/** Corrupted stream: two starts share one observed id, and one completion arrives. */
function codexDuplicateIdStreamLines(): unknown[] {
  return [
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-x", type: "commandExecution", command: "npm test" } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-x", type: "commandExecution", command: "npm ci" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-x", type: "commandExecution", command: "npm test", exitCode: 0, aggregatedOutput: "42 passed" } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } },
  ];
}

test("codex call navigation refuses an item id shared by valid pairs in separate sources", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-cross-source-id");
  const stream = [
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "shared-id", type: "commandExecution", command: "ls" } } },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "shared-id", type: "commandExecution", exitCode: 0, aggregatedOutput: "file.txt" } } },
  ];
  await writeTurn(artifactDir, "0001", "codex-cli", stream);
  await writeTurn(artifactDir, "0002", "codex-cli", stream);
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const calls = bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call" && entry.callId === "shared-id");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const result = bundle.snapshot.entries.find((entry) => entry.entryId === call.pairedWith);
    assert.equal(result?.pairedWith, call.entryId);
    assert.equal(result?.source.sourceId, call.source.sourceId);
  }
  assert.throws(
    () => readSubtaskEvidence(bundle, { callId: "shared-id" }),
    (error: unknown) => error instanceof EvidenceNavigationError && error.code === "call_ambiguous",
  );
});

test("codex duplicate same-id starts plus one completion stay unpaired end-to-end (no fabricated pair)", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-duplicate-ids");
  await writeTurn(artifactDir, "0001", "codex-cli", codexDuplicateIdStreamLines());

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const entries = bundle.snapshot.entries;
  const calls = entries.filter((entry) => entry.kind === "tool_call" && entry.callId === "item-x");
  const results = entries.filter((entry) => entry.kind === "tool_result" && entry.callId === "item-x");
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);

  // The parser refused the ambiguous id; the snapshot-wide bare-id pass must
  // not override that refusal by pairing the first start anyway.
  for (const entry of [...calls, ...results]) {
    assert.equal(entry.pairedWith, undefined, `entry ${entry.entryId} must stay unpaired`);
  }
  for (const call of calls) {
    assert.equal(call.status, "in_flight", "no start may be marked returned without a validated link");
  }

  // Navigation respects the refusal: an id shared by unlinked entries is ambiguous.
  assert.throws(
    () => readSubtaskEvidence(bundle, { callId: "item-x" }),
    (error: unknown) => error instanceof EvidenceNavigationError && error.code === "call_ambiguous",
  );
});

test("an unmatched codex start and same-id completion in different turns never pair across sources", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-cross-turn-ids");
  // Turn 1: a start that is never completed in its own retained stream.
  await writeTurn(artifactDir, "0001", undefined, [
    { jsonrpc: "2.0", method: "item/started", params: { item: { id: "item-y", type: "commandExecution", command: "npm test" } } },
  ]);
  // Turn 2: a completion whose start was not retained in its own stream.
  await writeTurn(artifactDir, "0002", undefined, [
    { jsonrpc: "2.0", method: "item/completed", params: { item: { id: "item-y", type: "commandExecution", command: "npm test", exitCode: 0 } } },
  ]);
  // Both turns ran under the record's latest external assignment (codex-cli),
  // so both metadata-missing streams are indexed via their own per-turn evidence.
  await writeOperation(artifactDir, {
    adapter: "codex-cli",
    generation: 0,
    assignments: [{ selection: { source: "external", id: "codex-agent" }, generation: 0, startedAt: OP.a0Start }],
    attempts: [
      { turn: 1, generation: 0, startedAt: OP.t1Start, endedAt: OP.t1End },
      { turn: 2, generation: 0, startedAt: OP.t2Start, endedAt: OP.t2End },
    ],
  });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, operation: await loadOperation(artifactDir) });
  const entries = bundle.snapshot.entries;
  const call = entries.find((entry) => entry.kind === "tool_call" && entry.callId === "item-y");
  const result = entries.find((entry) => entry.kind === "tool_result" && entry.callId === "item-y");
  assert.ok(call, "turn 1's start is indexed from its own stream");
  assert.ok(result, "turn 2's completion is indexed from its own stream");

  // Different sources sharing one observed id: no cross-source pairing.
  assert.notEqual(call!.source.sourceId, result!.source.sourceId);
  assert.equal(call!.pairedWith, undefined);
  assert.equal(result!.pairedWith, undefined);
  assert.equal(call!.status, "in_flight");

  // Navigation refuses to present the two unlinked entries as a pair.
  assert.throws(
    () => readSubtaskEvidence(bundle, { callId: "item-y" }),
    (error: unknown) => error instanceof EvidenceNavigationError && error.code === "call_ambiguous",
  );
});

/** Claude stream whose display timestamps are NEWER than another source's artifact mtime. */
function claudeOrderingStreamLines(): unknown[] {
  return [
    { type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID, model: "claude-opus-4-6" },
    {
      type: "assistant",
      message: { id: "msg_09", role: "assistant", content: [{ type: "tool_use", id: "toolu_01AAA", name: "Read", input: { file_path: "/repo/README.md" } }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-08-01T00:00:01.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01AAA", is_error: false, content: [{ type: "text", text: "ordering fixture" }] }] },
      session_id: CLAUDE_SESSION_ID, timestamp: "2025-08-01T00:00:02.000Z",
    },
    { type: "result", subtype: "success", is_error: false, result: "done", session_id: CLAUDE_SESSION_ID },
  ];
}

test("claude display-only timestamps never change source ordering or retention", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("ordering");
  // The two clocks disagree on order: by artifact mtime the claude turn is
  // FIRST (June), but its stream's display timestamps (August) are newer than
  // the codex turn's mtime (July) and would put it LAST if they drove ordering.
  await writeTurn(artifactDir, "0001", "claude-cli", claudeOrderingStreamLines());
  await writeTurn(artifactDir, "0002", "codex-cli", codexCamelStreamLines(), { code: 1 });
  const seconds = (iso: string) => new Date(iso).getTime() / 1000;
  await utimes(join(artifactDir, "executor", "0001"), seconds("2025-06-01T00:00:00Z"), seconds("2025-06-01T00:00:00Z"));
  await utimes(join(artifactDir, "executor", "0002"), seconds("2025-07-01T00:00:00Z"), seconds("2025-07-01T00:00:00Z"));

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });

  // Ordering follows the pre-change artifact-mtime basis, not display clocks.
  assert.deepEqual(
    bundle.snapshot.sources.map((source) => source.sourceId),
    ["turn:0001", "turn:0002"],
  );
  // Both sources stay retained in the global window (nothing reordered out).
  const claudeCall = bundle.snapshot.entries.find((entry) => entry.callId === "toolu_01AAA" && entry.kind === "tool_call");
  const codexCall = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call" && entry.toolName === "command_execution");
  assert.ok(claudeCall, "the claude turn's entries must be retained");
  assert.ok(codexCall, "the codex turn's entries must be retained");
});

test("claude turn with no tool events reports the inspected adapter, not a silent gap", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-no-tools");
  await writeTurn(artifactDir, "0001", "claude-cli", [
    { type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID, model: "claude-opus-4-6" },
    { type: "result", subtype: "success", is_error: false, result: "no tools were used", session_id: CLAUDE_SESSION_ID },
  ]);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.capability.toolEvidence, "unavailable");
  assert.match(bundle.snapshot.capability.reason ?? "", /No tool call\/result records were found in the available sources \(claude-cli\)/);
  // The stream itself is still indexed (lifecycle evidence).
  assert.ok(bundle.snapshot.entries.some((entry) => entry.kind === "lifecycle"));
});
