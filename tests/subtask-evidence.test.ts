import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubtaskEvidence,
  EvidenceCursorError,
  readSubtaskEvidence,
  type SubtaskEvidenceBundle,
  type SubtaskEvidenceEntryView,
} from "../src/execution/subtask-evidence";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "subtask-evidence-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Creates <root>/<name>/artifacts/<taskId> with the standard subdirectories. */
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

async function buildFixture(name: string, taskId = "task-1"): Promise<{ bundle: SubtaskEvidenceBundle; waveRoot: string; artifactDir: string }> {
  const { waveRoot, artifactDir } = await makeTaskArtifacts(name, taskId);
  const bundle = await buildSubtaskEvidence({ taskId, waveRoot, artifactDir });
  return { bundle, waveRoot, artifactDir };
}

function retainedText(bundle: SubtaskEvidenceBundle): string {
  return [...bundle.snapshot.contentByEntryId.values()].join("\n");
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

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
        content: [
          { type: "thinking", thinking: "PRIVATE-THINKING-MARKER secret plan details" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test && echo API_TOKEN=supersecretvalue123" } },
        ],
      },
    },
    {
      type: "message", id: "m-res-1", parentId: "m-asst-1", timestamp: "2025-06-01T10:00:03.000Z",
      message: {
        role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, details: {}, usage: null,
        timestamp: "2025-06-01T10:00:03.000Z",
        content: [{ type: "text", text: "test output ghp_ABCDEFGHIJKLMNOPQRSTUVWX failure detail" }],
      },
    },
    { type: "compaction", id: "c-1", parentId: "m-res-1", timestamp: "2025-06-01T10:00:04.000Z", tokensBefore: 12345 },
  ];
}

test("pi session: paired call/result, privacy exclusion, redaction, find, range", async () => {
  const { artifactDir } = await makeTaskArtifacts("pi-basic");
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: join(root, "pi-basic"), artifactDir });

  assert.equal(bundle.snapshot.totalEntries, 4);
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(call && result);
  assert.equal(call.callId, "call-1");
  assert.equal(call.status, "returned");
  assert.equal(call.pairedWith, result.entryId);
  assert.equal(result.pairedWith, call.entryId);
  assert.equal(result.status, "failed");

  // Private reasoning is excluded from every retained view.
  const allText = `${retainedText(bundle)}\n${bundle.snapshot.entries.map((entry) => entry.preview).join("\n")}`;
  assert.ok(!allText.includes("PRIVATE-THINKING-MARKER"), "thinking content must never be indexed");

  // Redaction applied before retention/search/display.
  const callContent = bundle.snapshot.contentByEntryId.get(call.entryId)!;
  assert.ok(callContent.includes("[REDACTED]"));
  assert.ok(!callContent.includes("supersecretvalue123"));
  const resultContent = bundle.snapshot.contentByEntryId.get(result.entryId)!;
  assert.ok(!resultContent.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWX"));

  // Find is case-insensitive over redacted content.
  const found = readSubtaskEvidence(bundle, { find: "TEST OUTPUT" });
  assert.equal(found.mode, "find");
  assert.equal(found.matchSummary?.totalMatches, 1);
  assert.equal(found.matches?.[0]?.kind, "tool_result");

  // Ranged read with limit and nextIndex.
  const page = readSubtaskEvidence(bundle, { index: 0, limit: 2 });
  assert.equal(page.mode, "range");
  assert.equal(page.entries?.length, 2);
  assert.equal(page.nextIndex, 2);
  assert.ok(page.cursor, "unfiltered ranged reads issue a cursor");

  // Filtered read exposes no cursor (watermark would be ambiguous).
  const filtered = readSubtaskEvidence(bundle, { filter: "tool_result", limit: 10 });
  assert.equal(filtered.entries?.length, 1);
  assert.equal(filtered.cursor, undefined);
});

test("cursor: incremental continuation across appends without duplicates", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-cursor");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  await writeFile(sessionPath, jsonlLines(...piSessionEntries()));

  const bundle1 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const first = readSubtaskEvidence(bundle1, { index: 0, limit: 2 });
  assert.ok(first.cursor);
  const firstIds = (first.entries ?? []).map((entry) => entry.entryId);

  // Append new records to the session file (simulating a live executor).
  await writeFile(sessionPath, jsonlLines(
    ...piSessionEntries(),
    {
      type: "message", id: "m-asst-2", parentId: "c-1", timestamp: "2025-06-01T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp/x" } }] },
    },
    {
      type: "message", id: "m-res-2", parentId: "m-asst-2", timestamp: "2025-06-01T10:00:06.000Z",
      message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: false, details: {}, usage: null, timestamp: "2025-06-01T10:00:06.000Z", content: [{ type: "text", text: "appended result" }] },
    },
  ));

  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle2.snapshot.totalEntries, 6);
  const continued = readSubtaskEvidence(bundle2, { cursor: first.cursor! });
  assert.equal(continued.mode, "cursor");
  const continuedIds = (continued.entries ?? []).map((entry) => entry.entryId);
  assert.deepEqual(continuedIds, [
    bundle2.snapshot.entries[2].entryId,
    bundle2.snapshot.entries[3].entryId,
    bundle2.snapshot.entries[4].entryId,
    bundle2.snapshot.entries[5].entryId,
  ]);
  // No duplicates of the first page.
  assert.deepEqual(continuedIds.filter((id) => firstIds.includes(id)), []);
  assert.ok(continued.cursor, "cursor reads issue a fresh cursor");

  // Continuing again returns nothing new but still advances the cursor.
  const idle = readSubtaskEvidence(bundle2, { cursor: continued.cursor! });
  assert.equal(idle.entries?.length ?? 0, 0);
});

test("cursor: expired sources and replaced records are rejected explicitly", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-cursor-expired");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  await writeFile(sessionPath, jsonlLines(...piSessionEntries()));
  const bundle1 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const cursor = readSubtaskEvidence(bundle1, { index: 0, limit: 2 }).cursor!;

  // Replaced artifact: the covered record's raw line changed.
  await writeFile(sessionPath, jsonlLines(
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-user-1", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "rewritten user message" }] },
    },
  ));
  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.throws(
    () => readSubtaskEvidence(bundle2, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && ["cursor_record_missing", "cursor_content_changed"].includes(error.reason),
  );

  // Expired source: the session file is gone entirely.
  await rm(sessionPath);
  const bundle3 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.throws(
    () => readSubtaskEvidence(bundle3, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && error.reason === "cursor_source_missing",
  );

  // Task mismatch is rejected too.
  const other = await buildFixture("pi-other-task", "task-2");
  assert.throws(
    () => readSubtaskEvidence(other.bundle, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && error.reason === "cursor_task_mismatch",
  );
});

// ---------------------------------------------------------------------------
// Per-turn streams: pi fallback, no double-counting, claude, codex, binary
// ---------------------------------------------------------------------------

async function writeTurn(artifactDir: string, turnName: string, adapter: string, streamLines: unknown[], extra?: Record<string, unknown>): Promise<void> {
  const dir = join(artifactDir, "executor", turnName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "process-result.json"), JSON.stringify({ adapter, code: 0, ...extra }));
  if (streamLines) await writeFile(join(dir, "raw-stream.txt"), jsonlLines(...streamLines));
}

test("pi turn with missing session file falls back to stdout stream explicitly", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-fallback");
  await writeTurn(artifactDir, "0001", "pi-model", [
    { type: "turn_start", timestamp: "2025-06-01T11:00:00.000Z" },
    { type: "tool_execution_start", toolCallId: "sc-1", toolName: "bash", args: { command: "npm test" }, timestamp: "2025-06-01T11:00:01.000Z" },
    { type: "tool_execution_end", toolCallId: "sc-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "all tests passed (observed)" }] }, timestamp: "2025-06-01T11:00:05.000Z" },
    { type: "turn_end", timestamp: "2025-06-01T11:00:06.000Z" },
  ], { sessionId: "99999999-8888-7777-6666-555555555555" });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(call && result);
  assert.equal(call.callId, "sc-1");
  assert.equal(call.status, "returned");
  assert.equal(result.status, "succeeded");
  const fallbackNote = bundle.snapshot.unavailable.find((item) => item.reason === "missing_stream");
  assert.ok(fallbackNote, "fallback must be explicit");

  // Process outcome is observed evidence, not a claim.
  const process = bundle.snapshot.entries.find((entry) => entry.kind === "process")!;
  assert.ok(process);
  assert.match(process.preview, /exit code: 0/);
});

test("pi turn with session file is never double-counted from stdout", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-nodup");
  const sessionId = "99999999-8888-7777-6666-555555555555";
  await writeFile(join(artifactDir, "executor-sessions", `${sessionId}.jsonl`), jsonlLines(
    { type: "session", version: 3, id: sessionId, timestamp: "2025-06-01T11:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-asst-9", parentId: null, timestamp: "2025-06-01T11:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "dup-1", name: "bash", arguments: { command: "echo once" } }] },
    },
  ));
  // The stdout stream carries the same tool events; it must not be indexed.
  await writeTurn(artifactDir, "0001", "pi-model", [
    { type: "tool_execution_start", toolCallId: "dup-1", toolName: "bash", args: { command: "echo once" }, timestamp: "2025-06-01T11:00:01.000Z" },
    { type: "tool_execution_end", toolCallId: "dup-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "once" }] }, timestamp: "2025-06-01T11:00:02.000Z" },
  ], { sessionId });

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const calls = bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call");
  assert.equal(calls.length, 1, "the same tool call must appear exactly once");
  assert.equal(calls[0]!.source.stream, "session");
  // The turn still contributes its observed process outcome.
  assert.ok(bundle.snapshot.entries.some((entry) => entry.kind === "process"));
});

test("claude stream: paired by id, thinking excluded", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("claude-basic");
  await writeTurn(artifactDir, "0001", "claude-cli", [
    { type: "system", subtype: "init", model: "claude-test" },
    {
      type: "assistant", message: { content: [
        { type: "thinking", thinking: "CLAUDE-PRIVATE-REASONING-MARKER" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls -la" } },
      ]},
    },
    {
      type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "tu-1", is_error: false, content: [{ type: "text", text: "file listing here" }] },
      ]},
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(call && result);
  assert.equal(call.callId, "tu-1");
  assert.equal(call.status, "returned");
  assert.equal(result.status, "succeeded");
  const allText = `${retainedText(bundle)}\n${bundle.snapshot.entries.map((entry) => entry.preview).join("\n")}`;
  assert.ok(!allText.includes("CLAUDE-PRIVATE-REASONING-MARKER"));
});

test("codex stream: positional pairing while unambiguous, reasoning excluded", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("codex-basic");
  await writeTurn(artifactDir, "0001", "codex-cli", [
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "reasoning", summary: ["CODEX-PRIVATE-REASONING-MARKER"] } } },
    { jsonrpc: "2.0", method: "item/started", params: { item: { type: "command_execution", command: "npm run build" } } },
    { jsonrpc: "2.0", id: 7, result: {} },
    { jsonrpc: "2.0", method: "item/completed", params: { item: { type: "command_execution", command: "npm run build", exit_code: 1, aggregated_output: "build failed with a real error" } } },
    { jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-abc", turn: { status: "failed" } } },
  ]);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(call && result);
  assert.equal(call.toolName, "command_execution");
  assert.equal(call.status, "returned");
  assert.equal(result.status, "failed");
  assert.match(result.preview, /exit code: 1/);
  const allText = `${retainedText(bundle)}\n${bundle.snapshot.entries.map((entry) => entry.preview).join("\n")}`;
  assert.ok(!allText.includes("CODEX-PRIVATE-REASONING-MARKER"));

  // The command filter finds command executions.
  const commands = readSubtaskEvidence(bundle, { filter: "command" });
  assert.equal(commands.entries?.length, 2);
});

test("binary protocol: claims only, tool evidence explicitly unavailable", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("binary-basic");
  await writeTurn(artifactDir, "0001", "run-as-binary", [
    { type: "session", sessionId: "bin-1" },
    { type: "assistant", text: "I ran the tests and they all passed." },
    { type: "usage", inputTokens: 10, outputTokens: 20 },
  ]);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.capability.toolEvidence, "unavailable");
  assert.match(bundle.snapshot.capability.reason ?? "", /no tool events/);
  const claim = bundle.snapshot.entries.find((entry) => entry.kind === "claim")!;
  assert.ok(claim);
  assert.equal(claim.provenance, "worker_claim");
  // The claim is never upgraded to verification: no tool entries exist.
  assert.equal(bundle.snapshot.entries.filter((entry) => entry.kind === "tool_call" || entry.kind === "tool_result").length, 0);
});

test("torn tail and oversized records are reported, not indexed", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-torn");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  // Valid line followed by an unterminated (torn) final line.
  const goodLine = JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" });
  const tornLine = '{"type":"message","id":"m-torn","parentId":null,"timestamp":"2025-06-01T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"torn-call","name":"bash","arguments":{"command":"never complete"}}]}}';
  await writeFile(sessionPath, `${goodLine}\n${tornLine}`);
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.totalEntries, 1, "the torn line must not be indexed as a record");
  assert.ok(bundle.snapshot.unavailable.some((item) => item.reason === "torn_tail"));

  // Oversized record beyond the 16 MiB decoder limit.
  const { waveRoot: w2, artifactDir: a2 } = await makeTaskArtifacts("pi-oversized");
  const bigLine = JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "x".repeat(17 * 1024 * 1024) });
  const okLine = JSON.stringify({ type: "compaction", id: "c-ok", parentId: null, timestamp: "2025-06-01T10:00:01.000Z", tokensBefore: 1 });
  await writeFile(join(a2, "executor-sessions", `${SESSION_ID}.jsonl`), `${bigLine}\n${okLine}\n`);
  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: w2, artifactDir: a2 });
  assert.equal(bundle2.snapshot.totalEntries, 1);
  assert.ok(bundle2.snapshot.unavailable.some((item) => item.reason === "oversized_records"));
});

// ---------------------------------------------------------------------------
// Deep reads, confinement, missing sources, authoritative context
// ---------------------------------------------------------------------------

test("deep read: bounded chunks with honest continuation for large records", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-deep");
  const bigOutput = `OUTPUT-MARKER-${"A".repeat(300 * 1024)}`; // 300 KiB result content
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-asst-d", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-d", name: "bash", arguments: { command: "generate" } }] },
    },
    {
      type: "message", id: "m-res-d", parentId: "m-asst-d", timestamp: "2025-06-01T10:00:02.000Z",
      message: { role: "toolResult", toolCallId: "call-d", toolName: "bash", isError: false, details: {}, usage: null, timestamp: "2025-06-01T10:00:02.000Z", content: [{ type: "text", text: bigOutput }] },
    },
  ));
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const result = bundle.snapshot.entries.find((entry) => entry.kind === "tool_result")!;
  assert.ok(result);

  // The record exceeds the per-entry retention cap and says so honestly.
  assert.equal(result.truncatedContent, true);
  assert.ok(result.contentBytes <= 256 * 1024);

  // Deep-read chunks cover exactly the retained content, once each.
  let collected = "";
  let chunkIndex = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const deep = readSubtaskEvidence(bundle, { entryId: result.entryId, chunkIndex });
    assert.equal(deep.mode, "entry");
    collected += deep.deepContent!.content;
    if (!deep.deepContent!.hasMore) break;
    chunkIndex = deep.deepContent!.nextChunk!;
  }
  // Content is ASCII here, so character count equals the retained byte count.
  assert.equal(Buffer.byteLength(collected), result.contentBytes);
  assert.ok(collected.includes("OUTPUT-MARKER"));
  // Out-of-range chunks are explicit, not silent.
  const beyond = readSubtaskEvidence(bundle, { entryId: result.entryId, chunkIndex: 99 });
  assert.equal(beyond.deepContent!.hasMore, false);

  // Find still locates the marker inside retained content.
  const found = readSubtaskEvidence(bundle, { find: "output-marker" });
  assert.ok((found.matchSummary?.totalMatches ?? 0) >= 1);
});

test("confinement: symlinks and escaping artifact roots are refused", async () => {
  const outside = join(root, "outside-secret");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "leak.jsonl"), jsonlLines({ type: "session", version: 3, id: "evil", timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/x" }));

  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-symlink");
  await symlink(join(outside, "leak.jsonl"), join(artifactDir, "executor-sessions", "evil.jsonl"));
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.totalEntries, 0, "symlinked session files must not be read");
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "non_regular_file" || item.reason === "path_escape"),
    "the refusal must be explicit",
  );

  // An artifact directory outside the wave root fails closed.
  const rogue = join(root, "rogue-artifacts");
  await mkdir(rogue, { recursive: true });
  await assert.rejects(
    buildSubtaskEvidence({ taskId: "task-1", waveRoot: join(root, "pi-symlink"), artifactDir: rogue }),
    /escapes its wave root/,
  );
});

test("missing sources and unsupported adapters are explicit, never invented", async () => {
  // No artifact directory at all.
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: join(root, "nowhere"), artifactDir: join(root, "nowhere", "artifacts", "task-1") });
  assert.equal(bundle.snapshot.totalEntries, 0);
  assert.ok(bundle.snapshot.unavailable.some((item) => item.reason === "artifact_dir_missing"));
  assert.equal(bundle.snapshot.capability.toolEvidence, "unavailable");

  // Unknown adapter: the raw stream is not dumped or guessed at.
  const { waveRoot, artifactDir } = await makeTaskArtifacts("unknown-adapter");
  await writeTurn(artifactDir, "0001", "mystery-cli", [
    { type: "something", payload: "MYSTERY-RAW-PAYLOAD-MARKER" },
  ]);
  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.ok(bundle2.snapshot.unavailable.some((item) => item.reason === "unsupported_adapter"));
  assert.ok(!retainedText(bundle2).includes("MYSTERY-RAW-PAYLOAD-MARKER"));

  // Missing process-result.json: adapter unknown, stream not indexed.
  const { waveRoot: w3, artifactDir: a3 } = await makeTaskArtifacts("no-procres");
  await mkdir(join(a3, "executor", "0002"), { recursive: true });
  await writeFile(join(a3, "executor", "0002", "raw-stream.txt"), jsonlLines({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} }));
  const bundle3 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: w3, artifactDir: a3 });
  assert.ok(bundle3.snapshot.unavailable.some((item) => item.reason === "unsupported_adapter" || item.reason === "unreadable"));
});

test("unpaired calls stay in_flight; unattributed results stay standalone", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("pi-unpaired");
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-a", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "open-call", name: "bash", arguments: { command: "long-running" } }] },
    },
  ));
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const call = bundle.snapshot.entries.find((entry) => entry.kind === "tool_call")!;
  assert.equal(call.status, "in_flight");

  // The call-pair read reports the honest state.
  const pair = readSubtaskEvidence(bundle, { callId: "open-call" });
  assert.equal(pair.callPair?.status, "in_flight");
  assert.ok(pair.callPair?.call);
  assert.equal(pair.callPair?.result, undefined);

  // Unknown call ids are explicit errors.
  assert.throws(() => readSubtaskEvidence(bundle, { callId: "nope" }), /No tool call or result/);
});

test("context: assignments, attempts, steering, changed files, review", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("ctx");
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()));
  const operation = {
    version: 1, revision: 3, operationId: "op-1", waveId: "wave-1", taskId: "task-1", title: "t",
    state: "reviewing" as const, worktreeRoot: "/tmp/wt", effectiveCwd: "/tmp/wt", artifactDir,
    generation: 2, retryBudget: 2,
    assignments: [
      { entryId: "e-1", priority: 0, selection: { source: "pi" as const, model: "model-a" }, generation: 1, reason: "initial" as const, startedAt: "2025-06-01T09:00:00.000Z", endedAt: "2025-06-01T09:30:00.000Z", outcome: "failed" as const },
      { entryId: "e-2", priority: 0, selection: { source: "external" as const, id: "claude-cli" }, generation: 2, reason: "failover" as const, startedAt: "2025-06-01T09:31:00.000Z" },
    ],
    attempts: [
      { attempt: 1, generation: 1, turn: 1, startedAt: "2025-06-01T09:00:01.000Z", endedAt: "2025-06-01T09:30:00.000Z", outcome: "failed" as const, sessionId: SESSION_ID },
      { attempt: 2, generation: 2, turn: 1, startedAt: "2025-06-01T09:31:01.000Z" },
    ],
    incidents: [],
    checkpoint: {
      checkpointId: "cp-1", commitSha: "abc123", treeSha: "def456", ref: "refs/candidates/task-1",
      differsFromBase: true, createdAt: "2025-06-01T09:40:00.000Z", verified: true,
      changedPaths: ["src/a.ts", "src/b.ts"],
    },
    instructions: [
      { instructionId: "i-1", sequence: 1, action: "steer" as const, text: "focus on tests", status: "acknowledged" as const, createdAt: "2025-06-01T09:32:00.000Z", acknowledgedAt: "2025-06-01T09:32:05.000Z" },
    ],
    nextInstructionSequence: 2, createdAt: "2025-06-01T09:00:00.000Z", updatedAt: "2025-06-01T09:40:00.000Z",
  };
  const result = {
    waveId: "wave-1", waveRoot, sourceRoot: "/tmp/src", phase: "completed" as const,
    taskResults: [{
      taskId: "task-1", title: "t", status: "accepted" as const, summary: "ok",
      reviewReport: {
        aggregate: "needs_changes" as const, summary: "issues found", reviewCycles: 2, latestReviewSequence: 2,
        reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "needs_changes" as const, summary: "bug in a.ts", findings: [] }],
        history: [
          { reviewSequence: 1, aggregate: "pass" as const, summary: "ok", reviewers: [] },
          { reviewSequence: 2, aggregate: "needs_changes" as const, summary: "issues found", reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "needs_changes" as const, summary: "bug in a.ts", findings: [] }] },
        ],
      },
    }],
  };
  const bundle = await buildSubtaskEvidence({
    taskId: "task-1", waveRoot, artifactDir,
    operation: operation as never,
    result: result as never,
    state: "reviewing",
    commands: [{ instructionId: "i-1", action: "steer", actor: "model", status: "acknowledged", createdAt: "2025-06-01T09:32:00.000Z", acknowledgedAt: "2025-06-01T09:32:05.000Z" }],
    executorSelection: { source: "external", id: "claude-cli" },
    updatedAt: "2025-06-01T09:40:00.000Z",
  });

  const context = bundle.context!;
  assert.ok(context);
  assert.equal(context.state, "reviewing");
  assert.equal(context.assignment?.history.length, 2);
  assert.equal(context.assignment?.history[1]?.reason, "failover");
  assert.equal(context.assignment?.current?.adapter, "claude-cli");
  assert.equal(context.attempts?.length, 2);
  assert.equal(context.steering?.[0]?.status, "acknowledged");
  assert.equal(context.changedFiles?.landingStatus, "unlanded");
  assert.deepEqual(context.changedFiles?.trackedPaths, ["src/a.ts", "src/b.ts"]);
  assert.match(context.changedFiles?.note ?? "", /Unlanded/);
  assert.equal(context.review?.aggregate, "needs_changes");
  assert.equal(context.review?.cycles, 2);

  // Reviewer findings are findable as reviewer_verdict entries.
  const reviewEntries = bundle.snapshot.entries.filter((entry) => entry.kind === "review");
  assert.equal(reviewEntries.length, 1);
  assert.equal(reviewEntries[0]!.provenance, "reviewer_verdict");
  const found = readSubtaskEvidence(bundle, { find: "bug in a.ts" });
  assert.ok((found.matchSummary?.totalMatches ?? 0) >= 1);
});

test("context: untracked enumeration is confined to the task's wave root", async () => {
  const { execFileSync } = await import("node:child_process");
  const { waveRoot, artifactDir } = await makeTaskArtifacts("confine");
  const checkpoint = {
    checkpointId: "cp-c", commitSha: "abc", treeSha: "def", ref: "refs/candidates/task-1",
    differsFromBase: true, createdAt: "2025-06-01T09:40:00.000Z", verified: true,
    changedPaths: ["src/a.ts"],
  };
  const baseOperation = {
    version: 1, revision: 1, operationId: "op-c", waveId: "wave-1", taskId: "task-1", title: "t",
    state: "failed_critical" as const, effectiveCwd: "/tmp/wt", artifactDir,
    generation: 1, retryBudget: 0, assignments: [], attempts: [], incidents: [],
    checkpoint, instructions: [], nextInstructionSequence: 1,
    createdAt: "2025-06-01T09:00:00.000Z", updatedAt: "2025-06-01T09:40:00.000Z",
  };

  // A recorded worktree outside the wave root must never be used as a git target.
  const outsideWt = join(root, "confine-outside-wt");
  await mkdir(outsideWt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: outsideWt });
  await writeFile(join(outsideWt, "sneaky.txt"), "x\n");
  const outside = await buildSubtaskEvidence({
    taskId: "task-1", waveRoot, artifactDir,
    operation: { ...baseOperation, worktreeRoot: outsideWt } as never,
    worktreeRoot: outsideWt,
    state: "failed",
  });
  assert.equal(outside.context?.changedFiles?.untrackedPaths, undefined);
  assert.match(outside.context!.changedFiles!.note, /does not resolve inside/);

  // A worktree inside the wave root is enumerated (task-created files land with the candidate).
  const insideWt = join(waveRoot, "worktrees", "task-1");
  await mkdir(insideWt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: insideWt });
  await writeFile(join(insideWt, "new-file.txt"), "x\n");
  const inside = await buildSubtaskEvidence({
    taskId: "task-1", waveRoot, artifactDir,
    operation: { ...baseOperation, worktreeRoot: insideWt } as never,
    worktreeRoot: insideWt,
    state: "failed",
  });
  assert.deepEqual(inside.context?.changedFiles?.untrackedPaths, ["new-file.txt"]);
});

// ---------------------------------------------------------------------------
// End-to-end through the registered SubtasksInspect tool and controller
// ---------------------------------------------------------------------------

import { normalizeConfig } from "../src/config";
import type { BackgroundExecutionController } from "../src/execution/background-controller";
import type { BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { serializeGroupSnapshot, writeGroupSnapshot } from "../src/execution/background-group-store";
import { newTask } from "../src/execution/task-state";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

type ToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

test("end-to-end: registered SubtasksInspect serves bounded evidence navigation", async () => {
  const base = join(root, "e2e");
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const groupRoot = join(base, "pi-review-execution-e2e");
  const waveRoot = join(base, "wave-1");
  const artifactDir = join(waveRoot, "artifacts", "task-e2e");
  await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
  await mkdir(join(artifactDir, "executor", "0001"), { recursive: true });

  // Pi session: a failed test command with a distinctive marker; private thinking must stay out.
  const e2eSessionId = "e2e-session-0001";
  await writeFile(join(artifactDir, "executor-sessions", `${e2eSessionId}.jsonl`), jsonlLines(
    { type: "session", version: 3, id: e2eSessionId, timestamp: "2025-06-02T09:00:00.000Z", cwd: "/tmp/wt" },
    {
      type: "message", id: "m-e1", parentId: null, timestamp: "2025-06-02T09:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "E2E-PRIVATE-THINKING-MARKER" },
          { type: "toolCall", id: "e2e-call-1", name: "bash", arguments: { command: "npm test -- e2e-fixture" } },
        ],
      },
    },
    {
      type: "message", id: "m-e2", parentId: "m-e1", timestamp: "2025-06-02T09:00:05.000Z",
      message: {
        role: "toolResult", toolCallId: "e2e-call-1", toolName: "bash", isError: true, details: {}, usage: null,
        timestamp: "2025-06-02T09:00:05.000Z",
        content: [{ type: "text", text: "E2E-FAILURE-MARKER: 3 of 10 tests failed" }],
      },
    },
  ));
  // Turn artifacts: observed process outcome + worker claim (never verification).
  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), JSON.stringify({ adapter: "pi-model", code: 1, sessionId: e2eSessionId }));
  await writeFile(join(artifactDir, "executor", "0001", "final-response.md"), "I fixed the failing tests; all suites pass now.\n");
  // Durable operation record with assignment history and a checkpoint.
  const now = new Date().toISOString();
  await writeFile(join(artifactDir, "operation.json"), JSON.stringify({
    version: 1, revision: 2, operationId: "op-e2e", waveId: "wave-1", taskId: "task-e2e", title: "e2e evidence",
    state: "failed_critical", worktreeRoot: join(base, "worktree"), effectiveCwd: join(base, "worktree"), artifactDir,
    generation: 1, retryBudget: 0,
    assignments: [{ entryId: "e-1", priority: 0, selection: { source: "pi", model: "model-x" }, generation: 1, reason: "initial", startedAt: now }],
    attempts: [{ attempt: 1, generation: 1, turn: 1, startedAt: now, endedAt: now, outcome: "failed", sessionId: e2eSessionId }],
    incidents: [],
    checkpoint: {
      checkpointId: "cp-e2e", commitSha: "abc", treeSha: "def", ref: "refs/candidates/task-e2e",
      differsFromBase: true, createdAt: now, verified: true, changedPaths: ["src/e2e.ts"],
    },
    instructions: [], nextInstructionSequence: 1, createdAt: now, updatedAt: now,
  }));

  const task = newTask({ title: "e2e evidence", instructions: "run the e2e fixture", acceptanceCriteria: ["fixture passes"] });
  task.taskId = "task-e2e";
  task.state = "failed";
  task.waveRoot = waveRoot;
  task.executorSelection = { source: "pi", model: "model-x" };
  task.commands = [{ instructionId: "i-1", action: "steer", actor: "model", status: "acknowledged", createdAt: now, acknowledgedAt: now }];
  // A reviewer summary carrying a secret must be redacted in every context view.
  task.result = {
    waveId: "wave-1", waveRoot, sourceRoot, phase: "completed",
    taskResults: [{
      taskId: "task-e2e", title: "e2e evidence", status: "accepted", summary: "ok",
      reviewReport: {
        aggregate: "pass", summary: "token=supersecretvalue123 leaked in diff", reviewCycles: 1, latestReviewSequence: 1,
        reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "pass", summary: "token=supersecretvalue123 leaked in diff", findings: [] }],
        history: [],
      },
    }],
  } as never;
  await mkdir(groupRoot, { recursive: true });
  const resolvedGroupRoot = await realpath(groupRoot);
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-e2e", kind: "execute",
    root: resolvedGroupRoot, cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [task],
  };
  await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: { source: "pi", model: "model-x" } },
  });
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot] });
  try {
    const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect")!;
    assert.ok(inspectTool, "SubtasksInspect must be registered");
    const execute = inspectTool.execute as ToolExecute;

    // Find mode through the real tool surface.
    const found = await execute("e2e-find", { executionId: "exec-e2e", taskId: "task-e2e", evidence: { find: "E2E-FAILURE-MARKER" } });
    assert.equal(found.isError, false);
    const foundText = String(found.content[0].text);
    assert.match(foundText, /E2E-FAILURE-MARKER/);
    assert.ok(!foundText.includes("E2E-PRIVATE-THINKING-MARKER"), "private reasoning must never reach the model view");

    // Mutual exclusion with legacy activity paging is a hard error.
    const bad = await execute("e2e-bad", { executionId: "exec-e2e", taskId: "task-e2e", offset: 0, evidence: {} });
    assert.equal(bad.isError, true);
    assert.match(String(bad.content[0].text), /mutually exclusive/);

    // Ranged read issues a cursor; continuation returns only newer entries.
    const page = await execute("e2e-page", { executionId: "exec-e2e", taskId: "task-e2e", evidence: { index: 0, limit: 2 } });
    assert.equal(page.isError, false);
    const pageEvidence = page.details.evidence;
    assert.ok(pageEvidence.cursor, "unfiltered ranged reads must issue a cursor");
    const pageIds = (pageEvidence.entries ?? []).map((entry: { entryId: string }) => entry.entryId);
    const continued = await execute("e2e-cont", { executionId: "exec-e2e", taskId: "task-e2e", evidence: { cursor: pageEvidence.cursor } });
    assert.equal(continued.isError, false);
    const continuedIds = (continued.details.evidence.entries ?? []).map((entry: { entryId: string }) => entry.entryId);
    assert.deepEqual(continuedIds.filter((id: string) => pageIds.includes(id)), [], "no duplicates across cursor continuation");

    // The authoritative context accompanies evidence reads.
    const text = String(page.content[0].text);
    assert.match(text, /authoritative state: failed/);
    assert.match(text, /changed files \(unlanded\)/);
    assert.match(text, /src\/e2e\.ts/);

    // A secret in a reviewer summary is redacted in the details payload and the rendered text.
    const reviewers = page.details.evidence.context?.review?.reviewers ?? [];
    assert.equal(reviewers.length, 1, "the latest review cycle must be summarized in context");
    assert.ok(!reviewers[0]!.summary.includes("supersecretvalue123"), "raw secret must not reach the context payload");
    assert.match(reviewers[0]!.summary, /\[REDACTED\]/);
    assert.ok(!text.includes("supersecretvalue123"), "raw secret must not reach the rendered text");

    // Legacy activity inspection remains byte-compatible (no evidence field requested).
    const legacy = await execute("e2e-legacy", { executionId: "exec-e2e", taskId: "task-e2e", offset: 0, lines: 5 });
    assert.equal(legacy.isError, false);
    assert.equal(legacy.details.evidence, undefined);
  } finally {
    await manager.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Review pass 1 regressions: cursor prefix integrity, rolling window + scan
// budget, shared raw retention budget, context redaction, confined operation
// record reads
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";
import { EVIDENCE_MAX_ENTRIES, EVIDENCE_MAX_ENUMERATED_ENTRIES, EVIDENCE_SCAN_BYTES_PER_SOURCE } from "../src/execution/evidence/types";

function piResultLine(id: string, callId: string, text: string, ts: string): string {
  return JSON.stringify({
    type: "message", id, parentId: null, timestamp: ts,
    message: {
      role: "toolResult", toolCallId: callId, toolName: "bash", isError: false, details: {}, usage: null,
      timestamp: ts, content: [{ type: "text", text }],
    },
  });
}

function tsAt(i: number): string {
  return new Date(Date.UTC(2025, 5, 2, 9, 0, 0) + i * 1000).toISOString();
}

test("cursor: covered-prefix integrity rejects rewrites and replacements preserving the watermark", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("cursor-prefix");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  const line1 = piResultLine("m1", "c1", "first result OK", tsAt(1));
  const line2 = piResultLine("m2", "c2", "middle result OK", tsAt(2));
  const line3 = piResultLine("m3", "c3", "last result stays identical", tsAt(3));
  await writeFile(sessionPath, `${line1}\n${line2}\n${line3}\n`);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const read = readSubtaskEvidence(bundle, { index: 0, limit: 50 });
  assert.ok(read.cursor, "unfiltered ranged read must issue a cursor");
  const cursor = read.cursor!;

  // (a) Rewrite an earlier covered record; the watermark record is byte-identical.
  await writeFile(sessionPath, `${piResultLine("m1", "c1", "first result CHANGED by rewrite", tsAt(1))}\n${line2}\n${line3}\n`);
  const afterRewrite = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.throws(
    () => readSubtaskEvidence(afterRewrite, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && error.reason === "cursor_content_changed",
  );

  // (b) Atomic replacement of the whole file preserving only the final record.
  await writeFile(sessionPath, `${piResultLine("m1", "c1", "replacement first line", tsAt(9))}\n${piResultLine("m2", "c2", "replacement middle line", tsAt(10))}\n${line3}\n`);
  const afterReplace = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.throws(
    () => readSubtaskEvidence(afterReplace, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && error.reason === "cursor_content_changed",
  );

  // Honest continuation still works for a pure append against the original file.
  await writeFile(sessionPath, `${line1}\n${line2}\n${line3}\n`);
  const restored = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const continued = readSubtaskEvidence(restored, { cursor });
  assert.deepEqual(continued.entries ?? [], [], "no new evidence yet");
  await writeFile(sessionPath, `${line1}\n${line2}\n${line3}\n${piResultLine("m4", "c4", "appended after cursor", tsAt(4))}\n`);
  const appended = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const next = readSubtaskEvidence(appended, { cursor });
  assert.equal(next.entries?.length, 1, "append is returned exactly once");
});

test("rolling window: records beyond the per-source cap stay reachable from the tail and omissions are disclosed", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("window");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  const total = EVIDENCE_MAX_ENTRIES + 50;
  const lines: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const text = i === 0 ? "WINDOW-HEAD-MARKER early record" : i === total - 1 ? "WINDOW-TAIL-MARKER latest record" : `record ${i}`;
    lines.push(piResultLine(`m${i}`, `c${i}`, text, tsAt(i)));
  }
  await writeFile(sessionPath, `${lines.join("\n")}\n`);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.totalEntries, EVIDENCE_MAX_ENTRIES, "snapshot is bounded to the window");
  assert.equal(bundle.snapshot.diagnostics.recordsOmitted, 50, "omitted head records are counted");
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "records_omitted"),
    "record omission must be disclosed as unavailable",
  );
  const tail = readSubtaskEvidence(bundle, { find: "WINDOW-TAIL-MARKER" });
  assert.ok((tail.matchSummary?.totalMatches ?? 0) >= 1, "newest evidence beyond the old cap must be reachable");
  const head = readSubtaskEvidence(bundle, { find: "WINDOW-HEAD-MARKER" });
  assert.equal(head.matchSummary?.totalMatches, 0, "omitted head records are not silently searched");
});

test("tail byte window: a failure appended beyond the per-source byte cap stays findable; earlier bytes are disclosed", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("scan-cap");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  let written = 0;
  let n = 0;
  const lineFor = (text: string): string => {
    const line = piResultLine(`m${n}`, `c${n}`, text, tsAt(n % 86_400));
    n += 1;
    return line;
  };
  let buffer: string[] = [];
  const push = (line: string): void => {
    buffer.push(line);
    if (buffer.length >= 500) {
      const chunk = `${buffer.join("\n")}\n`;
      appendFileSync(sessionPath, chunk);
      written += Buffer.byteLength(chunk, "utf8");
      buffer = [];
    }
  };
  // Early marker at ~512 KiB: outside the tail window of a >32 MiB file.
  while (written < 512 * 1024) push(lineFor(`filler ${n}`));
  push(lineFor("SCAN-EARLY-MARKER before the tail window"));
  // Filler past the per-source byte cap, then a newly appended failure.
  while (written < 33 * 1024 * 1024) push(lineFor(`filler ${n}`));
  push(lineFor("SCAN-APPENDED-FAILURE beyond any fixed scan offset"));
  if (buffer.length > 0) {
    const chunk = `${buffer.join("\n")}\n`;
    appendFileSync(sessionPath, chunk);
    written += Buffer.byteLength(chunk, "utf8");
  }

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "scan_budget" && /tail byte window/.test(item.detail)),
    "the tail-window boundary must be disclosed",
  );
  const appended = readSubtaskEvidence(bundle, { find: "SCAN-APPENDED-FAILURE" });
  assert.ok((appended.matchSummary?.totalMatches ?? 0) >= 1, "a failure appended beyond the byte cap must be findable");
  const early = readSubtaskEvidence(bundle, { find: "SCAN-EARLY-MARKER" });
  assert.equal(early.matchSummary?.totalMatches, 0, "bytes before the tail window are not indexed silently");
});

test("shared raw retention budget is enforced across multiple sources before assembly", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("raw-budget");
  const bigText = "x".repeat(16 * 1024); // 16 KiB per record: 2,000 records would be 32 MiB
  for (const [fileIndex, name] of [1, 2, 3].entries()) {
    const lines: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      lines.push(piResultLine(`m${i}`, `c${i}`, bigText, tsAt(i + fileIndex * 10_000)));
    }
    await writeFile(join(artifactDir, "executor-sessions", `s${fileIndex + 1}.jsonl`), `${lines.join("\n")}\n`);
  }

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.diagnostics.rawRetentionExhausted, true, "shared budget exhaustion must be diagnosed");
  const bySource = new Map(bundle.snapshot.sources.map((source) => [source.sourceId, source.records]));
  assert.equal(bySource.get("session:s1.jsonl"), 400, "first source fully retained before exhaustion");
  assert.equal(bySource.get("session:s2.jsonl"), 400, "second source fully retained before exhaustion");
  const third = bySource.get("session:s3.jsonl") ?? 999;
  assert.ok(third < 400, `third source must be truncated by the shared budget (kept ${third})`);
  assert.ok((bundle.snapshot.diagnostics.recordsOmitted ?? 0) > 0, "omitted records are counted");
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "records_omitted" && item.source === "session:s3.jsonl"),
    "the truncated source must disclose its omission",
  );
});

test("controller: operation.json context is confined, bounded, and ownership-validated", async () => {
  const base = join(root, "opctx");
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const groupRoot = join(base, "pi-review-execution-opctx");
  await mkdir(groupRoot, { recursive: true });
  const resolvedGroupRoot = await realpath(groupRoot);
  const now = new Date().toISOString();

  const validRecord = (taskId: string, artifactDir: string) => ({
    version: 1, revision: 1, operationId: `op-${taskId}`, waveId: "wave-1", taskId, title: "t",
    state: "completed" as const, worktreeRoot: "", effectiveCwd: "", artifactDir,
    generation: 1, retryBudget: 0,
    assignments: [{ entryId: "e-1", priority: 0, selection: { source: "pi" as const, model: "model-x" }, generation: 1, reason: "initial" as const, startedAt: now }],
    attempts: [], incidents: [], instructions: [], nextInstructionSequence: 1, createdAt: now, updatedAt: now,
  });

  // Four tasks: valid record, symlinked record, oversized record, wrong-task record.
  const taskIds = ["t-ok", "t-sym", "t-big", "t-wrong"] as const;
  const artifactDirs = new Map<string, string>();
  for (const taskId of taskIds) {
    const waveRoot = join(base, `wave-${taskId}`);
    const artifactDir = join(waveRoot, "artifacts", taskId);
    await mkdir(artifactDir, { recursive: true });
    artifactDirs.set(taskId, artifactDir);
  }
  // t-ok: a valid, owned operation record.
  await writeFile(join(artifactDirs.get("t-ok")!, "operation.json"), JSON.stringify(validRecord("t-ok", artifactDirs.get("t-ok")!)));
  // t-sym: operation.json is a symlink to a record outside the artifact dir.
  const outside = join(base, "outside-operation.json");
  await writeFile(outside, JSON.stringify(validRecord("t-sym", artifactDirs.get("t-sym")!)));
  await symlink(outside, join(artifactDirs.get("t-sym")!, "operation.json"));
  // t-big: a structurally valid record far beyond the bounded context size.
  const big = validRecord("t-big", artifactDirs.get("t-big")!);
  (big as { instructions: unknown[] }).instructions = [{ instructionId: "pad", sequence: 1, action: "steer" as const, text: "x".repeat(1_600_000), status: "acknowledged" as const, createdAt: now }];
  await writeFile(join(artifactDirs.get("t-big")!, "operation.json"), JSON.stringify(big));
  // t-wrong: a valid record belonging to a different task.
  await writeFile(join(artifactDirs.get("t-wrong")!, "operation.json"), JSON.stringify(validRecord("task-other", artifactDirs.get("t-wrong")!)));

  const tasks = taskIds.map((taskId) => {
    const task = newTask({ title: taskId, instructions: "fixture", acceptanceCriteria: ["done"] });
    task.taskId = taskId;
    // Non-settled state so shutdown cleanup leaves the fixture wave roots alone.
    task.state = "failed";
    task.waveRoot = join(base, `wave-${taskId}`);
    return task;
  });
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-opctx", kind: "execute",
    root: resolvedGroupRoot, cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks,
  };
  await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: { source: "pi", model: "model-x" } },
  });
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot] });
  try {
    const inspectEvidence = async (taskId: string) => {
      const inspection = await controller.inspectTask("exec-opctx", taskId, undefined, undefined, { index: 0 });
      assert.ok(inspection.evidence, `${taskId}: evidence mode must return a read`);
      return inspection.evidence!;
    };

    // Valid owned record informs the context.
    const ok = await inspectEvidence("t-ok");
    assert.equal(ok.context?.assignment?.history.length, 1, "valid operation record must inform the context");

    // Symlinked record is refused and reported; never used.
    const sym = await inspectEvidence("t-sym");
    const symNote = sym.snapshot.unavailable.find((item) => item.source === "operation.json");
    assert.ok(symNote, "symlinked operation.json must produce an explicit unavailable note");
    assert.ok(["non_regular_file", "path_escape"].includes(symNote!.reason), `unexpected refusal reason: ${symNote?.reason}`);
    assert.equal(sym.context?.assignment, undefined, "refused record must not inform the context");

    // Oversized record is bounded and reported; never parsed unbounded.
    const bigRead = await inspectEvidence("t-big");
    const bigNote = bigRead.snapshot.unavailable.find((item) => item.source === "operation.json");
    assert.ok(bigNote, "oversized operation.json must produce an explicit unavailable note");
    assert.match(bigNote!.detail, /bounded evidence context size/);
    assert.equal(bigRead.context?.assignment, undefined, "oversized record must not inform the context");

    // Wrong-task record is rejected by ownership validation.
    const wrong = await inspectEvidence("t-wrong");
    const wrongNote = wrong.snapshot.unavailable.find((item) => item.source === "operation.json");
    assert.ok(wrongNote, "wrong-task operation.json must produce an explicit unavailable note");
    assert.match(wrongNote!.detail, /task-other/);
    assert.equal(wrong.context?.assignment, undefined, "wrong-task record must not inform the context");
  } finally {
    await manager.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Review pass 2 regressions: tail byte window, global newest-entry assembly,
// file-generation-bound cursors, artifact-root validation, bounded enumeration
// ---------------------------------------------------------------------------

test("global entry window retains the newest entries across sources", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("global-tail");
  const sessionsDir = join(artifactDir, "executor-sessions");
  // Older source: 1,500 records; its first record carries the old marker.
  const oldLines: string[] = [];
  for (let i = 0; i < 1_500; i += 1) {
    oldLines.push(piResultLine(`o${i}`, `oc${i}`, i === 0 ? "GLOBAL-OLD-MARKER oldest entry" : `old record ${i}`, tsAt(i)));
  }
  await writeFile(join(sessionsDir, "s-old.jsonl"), `${oldLines.join("\n")}\n`);
  // Newer source: 1,200 records (later timestamps); its last record carries the new marker.
  const newLines: string[] = [];
  for (let i = 0; i < 1_200; i += 1) {
    newLines.push(piResultLine(`n${i}`, `nc${i}`, i === 1_199 ? "GLOBAL-NEW-MARKER newest entry" : `new record ${i}`, tsAt(10_000 + i)));
  }
  await writeFile(join(sessionsDir, "s-new.jsonl"), `${newLines.join("\n")}\n`);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.equal(bundle.snapshot.totalEntries, EVIDENCE_MAX_ENTRIES, "the global window is bounded");
  assert.equal(bundle.snapshot.diagnostics.entryCapReached, true, "global cap pressure must be diagnosed");
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "records_omitted" && /global rolling entry window/.test(item.detail)),
    "global entry omission must be disclosed",
  );
  const newer = readSubtaskEvidence(bundle, { find: "GLOBAL-NEW-MARKER" });
  assert.ok((newer.matchSummary?.totalMatches ?? 0) >= 1, "the newer source's result must remain reachable");
  const older = readSubtaskEvidence(bundle, { find: "GLOBAL-OLD-MARKER" });
  assert.equal(older.matchSummary?.totalMatches, 0, "oldest entries overflow the global window and are not indexed silently");
});

test("cursor: atomic replacement via rename is rejected even when covered bytes are identical", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("cursor-rename");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  const line1 = piResultLine("m1", "c1", "first result OK", tsAt(1));
  const line2 = piResultLine("m2", "c2", "middle result OK", tsAt(2));
  const line3 = piResultLine("m3", "c3", "last result stays identical", tsAt(3));
  await writeFile(sessionPath, `${line1}\n${line2}\n${line3}\n`);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const read = readSubtaskEvidence(bundle, { index: 0, limit: 50 });
  assert.ok(read.cursor, "unfiltered ranged read must issue a cursor");
  const cursor = read.cursor!;

  // Build a replacement whose covered prefix is byte-identical plus one new record,
  // then atomically rename it over the original path (new inode/generation).
  const replacementPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.replacement.jsonl`);
  await writeFile(replacementPath, `${line1}\n${line2}\n${line3}\n${piResultLine("m4", "c4", "appended in the replacement", tsAt(4))}\n`);
  await rename(replacementPath, sessionPath);

  const after = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.throws(
    () => readSubtaskEvidence(after, { cursor }),
    (error: unknown) => error instanceof EvidenceCursorError && error.reason === "cursor_content_changed",
    "a renamed-over file must be rejected even with an identical covered prefix",
  );
});

test("cursor: appendFile on the original file preserves generation and continues exactly once", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("cursor-append");
  const sessionPath = join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`);
  const line1 = piResultLine("m1", "c1", "first result OK", tsAt(1));
  const line2 = piResultLine("m2", "c2", "second result OK", tsAt(2));
  await writeFile(sessionPath, `${line1}\n${line2}\n`);

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const read = readSubtaskEvidence(bundle, { index: 0, limit: 50 });
  const cursor = read.cursor!;
  assert.ok(cursor, "unfiltered ranged read must issue a cursor");

  await appendFile(sessionPath, `${piResultLine("m3", "c3", "appended after the cursor", tsAt(3))}\n`);
  const after = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const continued = readSubtaskEvidence(after, { cursor });
  assert.equal(continued.entries?.length, 1, "the append is returned exactly once");
  assert.match(continued.entries![0]!.preview, /appended after the cursor/);
});

test("directory enumeration applies its bound during iteration and discloses overflow", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("enum-cap");
  const sessionsDir = join(artifactDir, "executor-sessions");
  const cap = EVIDENCE_MAX_ENUMERATED_ENTRIES;
  const oneLine = `${piResultLine("m1", "c1", "record", tsAt(1))}\n`;
  for (let i = 0; i < cap + 5; i += 1) {
    await writeFile(join(sessionsDir, `s${String(i).padStart(4, "0")}.jsonl`), oneLine);
  }
  // Non-matching names consume enumeration budget too.
  for (let i = 0; i < 3; i += 1) {
    await writeFile(join(sessionsDir, `notes-${i}.txt`), "not evidence");
  }

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.ok(
    bundle.snapshot.unavailable.some((item) => item.reason === "source_budget" && /enumeration budget/.test(item.detail)),
    "enumeration overflow must be disclosed explicitly",
  );
  const sessionSources = bundle.snapshot.sources.filter((source) => source.sourceId.startsWith("session:"));
  assert.ok(sessionSources.length > 0, "matching sources before the bound are still indexed");
  assert.ok(sessionSources.length <= cap, "no more than the enumeration budget is indexed");
});

test("controller: artifact root escaping the wave root is refused before any context read", async () => {
  const base = join(root, "oproot");
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const groupRoot = join(base, "pi-review-execution-oproot");
  await mkdir(groupRoot, { recursive: true });
  const resolvedGroupRoot = await realpath(groupRoot);
  const now = new Date().toISOString();

  // The task's wave root is real; its artifacts directory is a symlink to an
  // outside tree that holds a valid operation record for this task.
  const waveRoot = join(base, "wave-t-symroot");
  await mkdir(waveRoot, { recursive: true });
  const outside = join(base, "outside-arts", "t-symroot");
  await mkdir(outside, { recursive: true });
  const validRecord = {
    version: 1, revision: 1, operationId: "op-t-symroot", waveId: "wave-1", taskId: "t-symroot", title: "t",
    state: "completed" as const, worktreeRoot: "", effectiveCwd: "", artifactDir: outside,
    generation: 1, retryBudget: 0,
    assignments: [{ entryId: "e-1", priority: 0, selection: { source: "pi" as const, model: "model-x" }, generation: 1, reason: "initial" as const, startedAt: now }],
    attempts: [], incidents: [], instructions: [], nextInstructionSequence: 1, createdAt: now, updatedAt: now,
  };
  await writeFile(join(outside, "operation.json"), JSON.stringify(validRecord));
  await symlink(join(base, "outside-arts"), join(waveRoot, "artifacts"));

  const task = newTask({ title: "t-symroot", instructions: "fixture", acceptanceCriteria: ["done"] });
  task.taskId = "t-symroot";
  task.state = "failed";
  task.waveRoot = waveRoot;
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-oproot", kind: "execute",
    root: resolvedGroupRoot, cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [task],
  };
  await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: { source: "pi", model: "model-x" } },
  });
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot] });
  try {
    // The outside operation.json must never inform context: the root validation
    // refuses before any read through the symlinked directory.
    await assert.rejects(
      controller.inspectTask("exec-oproot", "t-symroot", undefined, undefined, { index: 0 }),
      /escapes its wave root/,
    );
  } finally {
    await manager.shutdown();
  }
});

test("controller: an operation record naming an unverifiable artifact directory is rejected", async () => {
  const base = join(root, "opghost");
  const sourceRoot = join(base, "source");
  await mkdir(sourceRoot, { recursive: true });
  const groupRoot = join(base, "pi-review-execution-opghost");
  await mkdir(groupRoot, { recursive: true });
  const resolvedGroupRoot = await realpath(groupRoot);
  const now = new Date().toISOString();

  const waveRoot = join(base, "wave-t-ghost");
  const artifactDir = join(waveRoot, "artifacts", "t-ghost");
  await mkdir(artifactDir, { recursive: true });
  // Structurally valid record, but its recorded artifactDir does not exist.
  const ghostRecord = {
    version: 1, revision: 1, operationId: "op-t-ghost", waveId: "wave-1", taskId: "t-ghost", title: "t",
    state: "completed" as const, worktreeRoot: "", effectiveCwd: "", artifactDir: join(base, "ghost-artifacts", "t-ghost"),
    generation: 1, retryBudget: 0,
    assignments: [{ entryId: "e-1", priority: 0, selection: { source: "pi" as const, model: "model-x" }, generation: 1, reason: "initial" as const, startedAt: now }],
    attempts: [], incidents: [], instructions: [], nextInstructionSequence: 1, createdAt: now, updatedAt: now,
  };
  await writeFile(join(artifactDir, "operation.json"), JSON.stringify(ghostRecord));

  const task = newTask({ title: "t-ghost", instructions: "fixture", acceptanceCriteria: ["done"] });
  task.taskId = "t-ghost";
  task.state = "failed";
  task.waveRoot = waveRoot;
  const group: BackgroundExecutionGroup = {
    version: 3, revision: 1, integritySha256: "", executionId: "exec-opghost", kind: "execute",
    root: resolvedGroupRoot, cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [task],
  };
  await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    execution: { activeExecutor: { source: "pi", model: "model-x" } },
  });
  const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
  manager.sync();
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot] });
  try {
    const inspection = await controller.inspectTask("exec-opghost", "t-ghost", undefined, undefined, { index: 0 });
    assert.ok(inspection.evidence, "evidence mode must return a read");
    const note = inspection.evidence!.snapshot.unavailable.find((item) => item.source === "operation.json");
    assert.ok(note, "unverifiable artifactDir must produce an explicit unavailable note");
    assert.match(note!.detail, /cannot be verified/);
    assert.equal(inspection.evidence!.context?.assignment, undefined, "an unverifiable record must not inform the context");
  } finally {
    await manager.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Active-correction review evidence (#50): durable per-cycle records are
// indexed with provenance and supersession, unavailability is explicit,
// cursors discover newly completed cycles, and a real controller + lifecycle
// regression proves findings are inspectable before any final result exists.
// ---------------------------------------------------------------------------

import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { runWaveWorkerLifecycle, type WaveWorkerLifecycleResult } from "../src/execution/wave-worker-lifecycle";
import { captureWaveBase, type WaveCaptureResult } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree, type WorkerWorktree } from "../src/execution/wave-worktrees";

/** One durable completed review cycle record (reviews/<waveId>/cycle-NNNN.json). */
function reviewCycleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    taskId: "task-1",
    waveId: "wave-1",
    cycle: 1,
    reviewSequence: 1,
    completedAt: "2025-06-03T10:00:00.000Z",
    candidate: {
      baseCommit: "basecommitsha",
      commitSha: "cand1commitsha",
      treeSha: "tree1sha",
      ref: "refs/pi-review-gate/waves/wave-1/review-candidates/task-1/cycle-000001",
    },
    aggregate: "needs_changes",
    summary: "gate: 1 needs_changes",
    reviewers: [{
      reviewerId: "reviewer-1",
      displayLabel: "R1",
      verdict: "needs_changes",
      summary: "blocking issues found in the candidate",
      guidance: "address every blocking finding before re-review",
      findings: [
        { severity: "blocking", file: "src/app.ts", line: 12, issue: "ACTIVE-CORRECTION-FINDING-ALPHA is missing", recommendation: "implement the missing behavior" },
        { severity: "blocking", file: null, line: null, issue: "FINDING-BETA-MARKER coverage gap", recommendation: "add regression tests" },
      ],
    }],
    ...overrides,
  };
}

async function writeCycleRecord(artifactDir: string, record: Record<string, unknown>): Promise<string> {
  const path = join(artifactDir, "reviews", String(record.waveId), `cycle-${String(record.cycle).padStart(6, "0")}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

function unpublishedMarkerFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    taskId: "task-1",
    waveId: "wave-1",
    cycle: 2,
    reviewSequence: 2,
    completedAt: "2025-06-03T11:00:00.000Z",
    aggregate: "needs_changes",
    summary: "gate: 1 needs_changes",
    reason: "injected publication failure",
    ...overrides,
  };
}

async function writeUnpublishedMarker(artifactDir: string, marker: Record<string, unknown>): Promise<string> {
  const path = join(artifactDir, "reviews", String(marker.waveId), `cycle-${String(marker.cycle).padStart(6, "0")}.json.unpublished`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return path;
}

function statusEntriesBySource(bundle: SubtaskEvidenceBundle): Map<string, string> {
  const lifecycle = readSubtaskEvidence(bundle, { filter: "lifecycle" });
  return new Map(
    (lifecycle.entries ?? [])
      .filter((entry) => entry.source.recordKey === "status")
      .map((entry) => [entry.source.sourceId, entry.preview]),
  );
}

test("active correction: durable review cycles are indexed with provenance, find, deep read, and explicit supersession", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("review-active");
  await writeCycleRecord(artifactDir, reviewCycleFixture());
  await writeCycleRecord(artifactDir, reviewCycleFixture({
    cycle: 2,
    reviewSequence: 2,
    completedAt: "2025-06-03T11:00:00.000Z",
    candidate: {
      baseCommit: "basecommitsha",
      commitSha: "cand2commitsha",
      treeSha: "tree2sha",
      ref: "refs/pi-review-gate/waves/wave-1/review-candidates/task-1/cycle-000002",
    },
    aggregate: "pass",
    summary: "gate: 1 pass",
    reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "pass", summary: "all findings resolved", findings: [] }],
  }));

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  assert.deepEqual(
    bundle.snapshot.sources.filter((source) => source.sourceId.startsWith("review:")).map((source) => source.sourceId).sort(),
    ["review:wave-1:cycle-000001", "review:wave-1:cycle-000002"],
  );

  // Review-filtered reads expose the official findings with reviewer_verdict provenance.
  const filtered = readSubtaskEvidence(bundle, { filter: "review" });
  assert.equal(filtered.entries?.length, 2, "one reviewer entry per completed cycle");
  for (const entry of filtered.entries ?? []) {
    assert.equal(entry.provenance, "reviewer_verdict");
  }

  // find: a generic term matches the findings; a unique marker pins one entry.
  const generic = readSubtaskEvidence(bundle, { find: "finding", filter: "review" });
  assert.ok((generic.matchSummary?.totalMatches ?? 0) >= 2, "find 'finding' must not be a zero-match success");
  const unique = readSubtaskEvidence(bundle, { find: "FINDING-BETA-MARKER" });
  assert.equal(unique.matchSummary?.totalMatches, 1);
  assert.equal(unique.matches?.[0]?.kind, "review");

  // Deep-read the selected entry for bounded detail.
  const deep = readSubtaskEvidence(bundle, { entryId: unique.matches![0]!.entryId });
  assert.equal(deep.mode, "entry");
  assert.match(deep.deepContent!.content, /"severity":"blocking"/);
  assert.match(deep.deepContent!.content, /add regression tests/);

  // Lifecycle entries distinguish the historical blocker from the current verdict.
  const lifecycle = readSubtaskEvidence(bundle, { filter: "lifecycle" });
  const statusEntries = (lifecycle.entries ?? []).filter((entry) => entry.source.recordKey === "status");
  assert.equal(statusEntries.length, 2);
  const bySource = new Map(statusEntries.map((entry) => [entry.source.sourceId, entry.preview]));
  assert.match(bySource.get("review:wave-1:cycle-000001")!, /superseded by review cycle 2/);
  assert.match(bySource.get("review:wave-1:cycle-000002")!, /most recently completed/);

  // The authoritative context reflects the latest durable cycle.
  assert.equal(bundle.context?.review?.aggregate, "pass");
  assert.equal(bundle.context?.review?.cycles, 2);
  assert.equal(bundle.context?.review?.latestSequence, 2);
  assert.equal(bundle.context?.review?.reviewers[0]?.verdict, "pass");

  // Completed review evidence present: no review_unavailable note.
  assert.ok(!bundle.snapshot.unavailable.some((item) => item.reason === "review_unavailable"));
});

test("active correction: missing, invalid, foreign, or refused review records are explicit, never silent", async () => {
  // (a) No completed review evidence at all: an explicit review-specific note.
  const none = await makeTaskArtifacts("review-none");
  const bundleNone = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: none.waveRoot, artifactDir: none.artifactDir });
  assert.equal(bundleNone.snapshot.entries.filter((entry) => entry.kind === "review").length, 0);
  const noteNone = bundleNone.snapshot.unavailable.find((item) => item.reason === "review_unavailable");
  assert.ok(noteNone, "absence of review evidence must be explicit");
  assert.match(noteNone!.detail, /no completed review evidence/i);

  // (b) A record owned by a different task is refused with an ownership note.
  const foreign = await makeTaskArtifacts("review-foreign");
  await writeCycleRecord(foreign.artifactDir, reviewCycleFixture({ taskId: "task-other" }));
  const bundleForeign = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: foreign.waveRoot, artifactDir: foreign.artifactDir });
  assert.equal(bundleForeign.snapshot.entries.filter((entry) => entry.kind === "review").length, 0);
  const noteForeign = bundleForeign.snapshot.unavailable.find((item) => item.source?.includes("cycle-000001") && item.reason === "unreadable");
  assert.ok(noteForeign, "foreign record must produce an explicit unavailable note");
  assert.match(noteForeign!.detail, /belongs to task "task-other"/);

  // (c) Invalid JSON is reported, not silently skipped.
  const invalid = await makeTaskArtifacts("review-invalid");
  await mkdir(join(invalid.artifactDir, "reviews", "wave-1"), { recursive: true });
  await writeFile(join(invalid.artifactDir, "reviews", "wave-1", "cycle-000001.json"), "{not json\n", "utf8");
  const bundleInvalid = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: invalid.waveRoot, artifactDir: invalid.artifactDir });
  assert.equal(bundleInvalid.snapshot.entries.filter((entry) => entry.kind === "review").length, 0);
  const noteInvalid = bundleInvalid.snapshot.unavailable.find((item) => item.source?.includes("cycle-000001") && item.reason === "unreadable");
  assert.ok(noteInvalid, "invalid record must produce an explicit unavailable note");
  assert.match(noteInvalid!.detail, /not valid JSON/);

  // (d) A symlinked record is refused by confinement and reported.
  const symlinked = await makeTaskArtifacts("review-symlink");
  const outside = join(root, "outside-review-record.json");
  await writeFile(outside, `${JSON.stringify(reviewCycleFixture(), null, 2)}\n`, "utf8");
  await mkdir(join(symlinked.artifactDir, "reviews", "wave-1"), { recursive: true });
  await symlink(outside, join(symlinked.artifactDir, "reviews", "wave-1", "cycle-000001.json"));
  const bundleSymlink = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: symlinked.waveRoot, artifactDir: symlinked.artifactDir });
  assert.equal(bundleSymlink.snapshot.entries.filter((entry) => entry.kind === "review").length, 0);
  const noteSymlink = bundleSymlink.snapshot.unavailable.find((item) => item.source?.includes("cycle-000001"));
  assert.ok(noteSymlink, "symlinked record must produce an explicit unavailable note");
  assert.match(String(noteSymlink!.reason), /non_regular_file|path_escape/);

  // (e) An unusable durable file must not suppress the settled-result fallback.
  const fallback = await makeTaskArtifacts("review-fallback");
  await writeCycleRecord(fallback.artifactDir, reviewCycleFixture({ taskId: "task-other" }));
  const resultWithReport = {
    waveId: "wave-1", waveRoot: fallback.waveRoot, sourceRoot: "/tmp/src", phase: "completed" as const,
    taskResults: [{
      taskId: "task-1", title: "t", status: "accepted" as const, summary: "ok",
      reviewReport: {
        aggregate: "pass" as const, summary: "settled", reviewCycles: 3, latestReviewSequence: 3,
        reviewers: [{ reviewerId: "reviewer-9", displayLabel: "R9", verdict: "pass" as const, summary: "settled pass", findings: [] }],
        history: [],
      },
    }],
  };
  const bundleFallback = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: fallback.waveRoot, artifactDir: fallback.artifactDir, result: resultWithReport as never });
  assert.ok(bundleFallback.snapshot.sources.some((source) => source.sourceId === "report:result.json"), "settled-result report must remain available when durable records are unusable");
  const fallbackReview = readSubtaskEvidence(bundleFallback, { filter: "review" });
  assert.equal(fallbackReview.entries?.length, 1);
});

function settledResult(waveRoot: string, latestReviewSequence: number): unknown {
  return {
    waveId: "wave-1", waveRoot, sourceRoot: "/tmp/src", phase: "completed",
    taskResults: [{
      taskId: "task-1", title: "t", status: "accepted", summary: "ok",
      reviewReport: {
        aggregate: "pass", summary: "settled pass", reviewCycles: latestReviewSequence, latestReviewSequence,
        reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "pass", summary: "SETTLED-PASS-MARKER all findings resolved", findings: [] }],
        history: [],
      },
    }],
  };
}

test("active correction: the settled report is reconciled with durable cycles by review identity, never double-counted", async () => {
  // (A) The latest cycle's best-effort record failed to persist: the settled
  // report covers a newer review than every usable durable cycle, so it must
  // be indexed and the historical blocker marked superseded — the official
  // pass must not be hidden behind an older durable needs_changes record.
  const newer = await makeTaskArtifacts("review-newer");
  await writeCycleRecord(newer.artifactDir, reviewCycleFixture()); // cycle 1, seq 1, needs_changes
  const bundleNewer = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: newer.waveRoot, artifactDir: newer.artifactDir, result: settledResult(newer.waveRoot, 2) as never });
  assert.ok(bundleNewer.snapshot.sources.some((source) => source.sourceId === "report:result.json"), "a newer settled report must be indexed alongside older durable cycles");
  const foundNewer = readSubtaskEvidence(bundleNewer, { find: "SETTLED-PASS-MARKER" });
  assert.ok((foundNewer.matchSummary?.totalMatches ?? 0) >= 1, "the later official pass must be searchable");
  const lifecycleNewer = readSubtaskEvidence(bundleNewer, { filter: "lifecycle" });
  const statusNewer = new Map((lifecycleNewer.entries ?? []).filter((entry) => entry.source.recordKey === "status").map((entry) => [entry.source.sourceId, entry.preview]));
  assert.match(statusNewer.get("review:wave-1:cycle-000001")!, /superseded by the final review report/);
  assert.equal(bundleNewer.context?.review?.aggregate, "pass", "context must reflect the later official pass");

  // (B) Every cycle persisted: the settled report covers the same review
  // identity as the newest durable cycle and must not be counted twice.
  const covered = await makeTaskArtifacts("review-covered");
  await writeCycleRecord(covered.artifactDir, reviewCycleFixture()); // cycle 1, seq 1
  await writeCycleRecord(covered.artifactDir, reviewCycleFixture({
    cycle: 2,
    reviewSequence: 2,
    completedAt: "2025-06-03T11:00:00.000Z",
    aggregate: "pass",
    summary: "gate: 1 pass",
    reviewers: [{ reviewerId: "reviewer-1", displayLabel: "R1", verdict: "pass", summary: "all findings resolved", findings: [] }],
  }));
  const bundleCovered = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: covered.waveRoot, artifactDir: covered.artifactDir, result: settledResult(covered.waveRoot, 2) as never });
  assert.ok(!bundleCovered.snapshot.sources.some((source) => source.sourceId === "report:result.json"), "the settled report must not duplicate cycles it does not go beyond");
  assert.equal(bundleCovered.snapshot.entries.filter((entry) => entry.kind === "review").length, 2, "exactly one reviewer entry per completed cycle");

  // (C) Without usable durable records the legacy result-based path still works.
  const plain = await makeTaskArtifacts("review-legacy");
  const bundlePlain = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: plain.waveRoot, artifactDir: plain.artifactDir, result: settledResult(plain.waveRoot, 2) as never });
  assert.ok(bundlePlain.snapshot.sources.some((source) => source.sourceId === "report:result.json"));
});

test("active correction: an unreadable later cycle never hides the settled pass and never asserts a stale current verdict", async () => {
  // Settled: cycle 1 (needs_changes) persisted, cycle 2's record is unreadable,
  // and the final report carries the official pass. The pass must be
  // searchable and the earlier blocker historical.
  const settled = await makeTaskArtifacts("review-unreadable-settled");
  await writeCycleRecord(settled.artifactDir, reviewCycleFixture()); // cycle 1, seq 1, needs_changes
  await mkdir(join(settled.artifactDir, "reviews", "wave-1"), { recursive: true });
  await writeFile(join(settled.artifactDir, "reviews", "wave-1", "cycle-000002.json"), "{corrupt\n", "utf8");
  const bundleSettled = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: settled.waveRoot, artifactDir: settled.artifactDir, result: settledResult(settled.waveRoot, 2) as never });
  assert.ok(bundleSettled.snapshot.sources.some((source) => source.sourceId === "report:result.json"), "the newer settled report must be indexed despite the unreadable cycle file");
  const foundSettled = readSubtaskEvidence(bundleSettled, { find: "SETTLED-PASS-MARKER" });
  assert.ok((foundSettled.matchSummary?.totalMatches ?? 0) >= 1, "the later official pass must be searchable");
  const lifecycleSettled = readSubtaskEvidence(bundleSettled, { filter: "lifecycle" });
  const statusSettled = new Map((lifecycleSettled.entries ?? []).filter((entry) => entry.source.recordKey === "status").map((entry) => [entry.source.sourceId, entry.preview]));
  assert.match(statusSettled.get("review:wave-1:cycle-000001")!, /superseded by the final review report/);
  const noteSettled = bundleSettled.snapshot.unavailable.find((item) => item.source?.includes("cycle-000002"));
  assert.ok(noteSettled, "the unreadable cycle file must keep its explicit unavailable note");

  // Pre-settlement: the same unreadable sibling means the older readable
  // verdict cannot be asserted as definitively current — in entries or context.
  const active = await makeTaskArtifacts("review-unreadable-active");
  await writeCycleRecord(active.artifactDir, reviewCycleFixture()); // cycle 1, seq 1, needs_changes
  await mkdir(join(active.artifactDir, "reviews", "wave-1"), { recursive: true });
  await writeFile(join(active.artifactDir, "reviews", "wave-1", "cycle-000002.json"), "{corrupt\n", "utf8");
  const bundleActive = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: active.waveRoot, artifactDir: active.artifactDir });
  const lifecycleActive = readSubtaskEvidence(bundleActive, { filter: "lifecycle" });
  const statusActive = new Map((lifecycleActive.entries ?? []).filter((entry) => entry.source.recordKey === "status").map((entry) => [entry.source.sourceId, entry.preview]));
  assert.match(statusActive.get("review:wave-1:cycle-000001")!, /cannot be confirmed to be the current review state/);
  assert.ok(!statusActive.get("review:wave-1:cycle-000001")!.includes("is the most recently completed review for this task"), "a stale verdict must not be asserted as current");
  assert.equal(bundleActive.context?.review?.aggregate, "needs_changes", "the readable cycle is still summarized…");
  assert.match(bundleActive.context?.review?.caveat ?? "", /may no longer be the current review state/);
});

test("regression #50: a later cycle whose record never published leaves no false current verdict while correcting", async () => {
  // Cycle 1 persisted normally; cycle 2 completed but its publication failed,
  // leaving only the explicit marker. No final result exists yet (active
  // correction): prior findings must stay readable, must not be presented as
  // the current review state, and the completeness gap must be model-visible.
  const { waveRoot, artifactDir } = await makeTaskArtifacts("review-unpublished-active");
  await writeCycleRecord(artifactDir, reviewCycleFixture()); // cycle 1, seq 1, needs_changes
  await writeUnpublishedMarker(artifactDir, unpublishedMarkerFixture()); // cycle 2: marker only

  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });

  // The marker is explicit evidence of the completed-but-unpublished cycle.
  assert.ok(
    bundle.snapshot.sources.some((source) => source.sourceId === "review:wave-1:cycle-000002-unpublished"),
    "the publication-failure marker must be indexed as its own source",
  );
  const note = bundle.snapshot.unavailable.find((item) => item.reason === "unpublished" && (item.source ?? "").includes("cycle-000002"));
  assert.ok(note, "the unpublished cycle must carry an explicit unavailable note");
  assert.match(note!.detail, /completed but its durable record was never published/);

  // Prior findings remain readable with their official provenance.
  const filtered = readSubtaskEvidence(bundle, { filter: "review" });
  assert.equal(filtered.entries?.length, 1, "cycle 1's reviewer verdict must stay inspectable");
  assert.equal(filtered.entries?.[0]?.provenance, "reviewer_verdict");
  const found = readSubtaskEvidence(bundle, { find: "FINDING-BETA-MARKER" });
  assert.ok((found.matchSummary?.totalMatches ?? 0) >= 1, "cycle 1's findings must stay searchable");

  // …but are not falsely current: the later unpublished cycle supersedes them.
  const status = statusEntriesBySource(bundle);
  assert.match(status.get("review:wave-1:cycle-000001")!, /superseded by review cycle 2/);
  assert.ok(
    !status.get("review:wave-1:cycle-000001")!.includes("is the most recently completed review for this task"),
    "a stale verdict must not be asserted as current",
  );

  // Review completeness uncertainty is model-visible in the authoritative context.
  assert.equal(bundle.context?.review?.aggregate, "needs_changes", "the readable cycle is still summarized…");
  assert.equal(bundle.context?.review?.cycles, 2, "the completed-but-unpublished cycle counts toward completeness");
  assert.match(bundle.context?.review?.caveat ?? "", /cycle 2 .*completed without a persisted record/s);
  assert.match(bundle.context?.review?.caveat ?? "", /may no longer be the current review state/);

  // The official gate verdict of the unpublished cycle stays visible in its lifecycle entry.
  const markerEntry = (readSubtaskEvidence(bundle, { filter: "lifecycle" }).entries ?? [])
    .find((entry) => entry.source.recordKey === "unpublished");
  assert.ok(markerEntry, "the marker's lifecycle entry must be present");
  assert.match(String(markerEntry!.preview), /needs_changes/);
});

test("regression #50: an unpublished later cycle never hides the settled pass", async () => {
  // Settled: cycle 1 (needs_changes) persisted, cycle 2's record was never
  // published (marker only), and the final report carries the official pass.
  // The pass must be indexed and searchable; earlier cycles are historical.
  const { waveRoot, artifactDir } = await makeTaskArtifacts("review-unpublished-settled");
  await writeCycleRecord(artifactDir, reviewCycleFixture()); // cycle 1, seq 1, needs_changes
  await writeUnpublishedMarker(artifactDir, unpublishedMarkerFixture()); // cycle 2: marker only
  const bundle = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir, result: settledResult(waveRoot, 2) as never });

  assert.ok(
    bundle.snapshot.sources.some((source) => source.sourceId === "report:result.json"),
    "the newer settled report must be indexed despite the unpublished cycle",
  );
  const found = readSubtaskEvidence(bundle, { find: "SETTLED-PASS-MARKER" });
  assert.ok((found.matchSummary?.totalMatches ?? 0) >= 1, "the later official pass must be searchable");
  const status = statusEntriesBySource(bundle);
  assert.match(status.get("review:wave-1:cycle-000001")!, /superseded by the final review report/);
  assert.equal(bundle.context?.review?.aggregate, "pass", "context must reflect the later official pass");
});

test("regression #50: malformed or foreign publication-failure markers are explicit, never silent", async () => {
  // (a) An invalid marker file still blocks a false current verdict.
  const invalid = await makeTaskArtifacts("review-unpublished-invalid");
  await writeCycleRecord(invalid.artifactDir, reviewCycleFixture()); // cycle 1, seq 1
  await mkdir(join(invalid.artifactDir, "reviews", "wave-1"), { recursive: true });
  await writeFile(join(invalid.artifactDir, "reviews", "wave-1", "cycle-000002.json.unpublished"), "{not json\n", "utf8");
  const bundleInvalid = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: invalid.waveRoot, artifactDir: invalid.artifactDir });
  const noteInvalid = bundleInvalid.snapshot.unavailable.find((item) => (item.source ?? "").includes("cycle-000002.json.unpublished") && item.reason === "unreadable");
  assert.ok(noteInvalid, "an invalid marker must produce an explicit unavailable note");
  assert.match(noteInvalid!.detail, /not valid JSON/);
  const statusInvalid = statusEntriesBySource(bundleInvalid);
  assert.match(statusInvalid.get("review:wave-1:cycle-000001")!, /cannot be confirmed to be the current review state/);
  assert.ok(
    !statusInvalid.get("review:wave-1:cycle-000001")!.includes("is the most recently completed review for this task"),
    "an unusable marker sibling must prevent a false current verdict",
  );

  // (b) A marker owned by a different task is refused with an ownership note.
  const foreign = await makeTaskArtifacts("review-unpublished-foreign");
  await writeCycleRecord(foreign.artifactDir, reviewCycleFixture()); // cycle 1, seq 1
  await writeUnpublishedMarker(foreign.artifactDir, unpublishedMarkerFixture({ taskId: "task-other" }));
  const bundleForeign = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: foreign.waveRoot, artifactDir: foreign.artifactDir });
  const noteForeign = bundleForeign.snapshot.unavailable.find((item) => (item.source ?? "").includes("cycle-000002.json.unpublished") && item.reason === "unreadable");
  assert.ok(noteForeign, "a foreign marker must produce an explicit unavailable note");
  assert.match(noteForeign!.detail, /belongs to task "task-other"/);
});

test("active correction: a newly completed review cycle is discoverable through an existing cursor", async () => {
  const { waveRoot, artifactDir } = await makeTaskArtifacts("review-cursor");
  await writeFile(join(artifactDir, "executor-sessions", `${SESSION_ID}.jsonl`), jsonlLines(...piSessionEntries()), "utf8");
  const bundle1 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const first = readSubtaskEvidence(bundle1, { index: 0, limit: 50 });
  assert.ok(first.cursor, "unfiltered ranged reads must issue a cursor");
  assert.equal((first.entries ?? []).some((entry) => entry.kind === "review"), false);

  // The review cycle completes while the worker is correcting.
  await writeCycleRecord(artifactDir, reviewCycleFixture());
  const bundle2 = await buildSubtaskEvidence({ taskId: "task-1", waveRoot, artifactDir });
  const continued = readSubtaskEvidence(bundle2, { cursor: first.cursor! });
  assert.equal(continued.mode, "cursor");
  const newIds = (continued.entries ?? []).map((entry) => entry.entryId);
  assert.ok(newIds.some((id) => id.startsWith("review:wave-1:cycle-000001/reviewer:")), "the new cycle's findings must be returned by continuation");
  const firstIds = (first.entries ?? []).map((entry) => entry.entryId);
  assert.deepEqual(newIds.filter((id) => firstIds.includes(id)), [], "no duplicates across cursor continuation");

  // Continuing again yields nothing new.
  const idle = readSubtaskEvidence(bundle2, { cursor: continued.cursor! });
  assert.equal(idle.entries?.length ?? 0, 0);
});

test("regression #50: registered SubtasksInspect exposes completed needs_changes findings while the worker actively corrects", async () => {
  const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  let releasePath: string | undefined;
  let lifecyclePromise: Promise<WaveWorkerLifecycleResult> | undefined;
  let capture: WaveCaptureResult | undefined;
  let worker: WorkerWorktree | undefined;
  let worktreeRemoved = false;
  const settleLifecycle = async (): Promise<void> => {
    if (releasePath) await writeFile(releasePath, "released\n", "utf8").catch(() => {});
    if (lifecyclePromise) await lifecyclePromise.catch(() => {});
    if (worker && capture && !worktreeRemoved) {
      worktreeRemoved = true;
      await removeWorktree(worker.worktreeRoot, capture.repositoryPath).catch(() => {});
    }
  };
  try {
    const base = join(root, "active-review-e2e");
    const sourceRoot = join(base, "source");
    await mkdir(sourceRoot, { recursive: true });

    // Real repository + capture + isolated worker worktree.
    const { execFileSync } = await import("node:child_process");
    const GIT_ENV = {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    };
    execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot, env: { ...process.env, ...GIT_ENV } });
    await writeFile(join(sourceRoot, "readme.md"), "# hello\n", "utf8");
    await writeFile(join(sourceRoot, "app.js"), "console.log('hi');\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: sourceRoot, env: { ...process.env, ...GIT_ENV } });
    execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: sourceRoot, env: { ...process.env, ...GIT_ENV } });

    // Executor: turn 1 implements; correction turns wait for the release file.
    const executorScript = join(base, "active-executor.cjs");
    releasePath = join(base, "release.txt");
    process.env.PI_TEST_RELEASE_PATH = releasePath;
    await writeFile(executorScript, [
      "const fs = require('node:fs');",
      "const turn = Number(process.env.PI_REVIEW_EXECUTOR_TURN || '1');",
      "process.stdin.resume();",
      "process.stdin.on('end', async () => {",
      "  if (turn === 1) {",
      "    fs.writeFileSync('impl.txt', 'implementation\\n');",
      "  } else {",
      "    const start = Date.now();",
      "    while (!fs.existsSync(process.env.PI_TEST_RELEASE_PATH)) {",
      "      if (Date.now() - start > 50000) { console.error('release wait timeout'); process.exit(1); }",
      "      await new Promise((resolveWait) => setTimeout(resolveWait, 25));",
      "    }",
      "    fs.writeFileSync('corrected.txt', 'corrected\\n');",
      "  }",
      "  console.log(JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID || 'active-review-session' }));",
      "  console.log(JSON.stringify({ type: 'assistant', text: 'Turn ' + turn + ' complete.' }));",
      "});",
    ].join("\n"), "utf8");

    const captureResult = await captureWaveBase({
      cwd: sourceRoot,
      maxSnapshotBytes: 1_000_000,
      waveId: "active-review-wave",
      artifactDir: base,
    });
    capture = captureResult;
    const workerWorktree = await createWorkerWorktree(captureResult, "task-active-review");
    worker = workerWorktree;
    const artifactDir = join(capture.waveRoot, "artifacts", "task-active-review");
    await mkdir(artifactDir, { recursive: true });

    // A reviewer that always blocks with a unique finding marker.
    const config = normalizeConfig({
      enabled: true,
      execution: { activeExecutor: { source: "external", id: "active-exec" } },
      externalAgents: [{
        id: "active-exec",
        adapter: "run-as-binary",
        command: process.execPath,
        execution: {
          protocol: "pi-review-executor-jsonl-v1",
          args: [executorScript],
          timeoutMs: 60_000,
        },
      }],
    });
    config.decider = {
      id: "blocking",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'impl.txt',line:null,issue:'ACTIVE-CORRECTION-FINDING-MARKER must be addressed',recommendation:'add the missing behavior'}]})))",
      ],
      timeoutMs: 30_000,
    };
    config.maxCorrectionCycles = 1;

    let resolveCorrecting: () => void = () => {};
    const correctionStarted = new Promise<void>((resolvePromise) => { resolveCorrecting = () => resolvePromise(); });

    const lifecycleCall = runWaveWorkerLifecycle({
      sourceRoot,
      taskId: "task-active-review",
      task: { title: "active review regression", instructions: "implement the feature", acceptanceCriteria: ["feature implemented"] },
      capture,
      worktree: worker,
      artifactDir,
      config,
      onUpdate: (update) => {
        if (update.phase === "correcting") resolveCorrecting();
      },
    });
    lifecyclePromise = lifecycleCall;

    // Wait until the worker is actively correcting (cycle 1 completed).
    await correctionStarted;
    let resultExists = true;
    try { await access(join(artifactDir, "result.json")); } catch { resultExists = false; }
    assert.equal(resultExists, false, "no final result may exist while correcting");

    // A controller restored from durable state (restart simulation) must see
    // the completed review through the registered tool surface.
    const groupRoot = join(base, "pi-review-execution-active");
    await mkdir(groupRoot, { recursive: true });
    const resolvedGroupRoot = await realpath(groupRoot);
    const now = new Date().toISOString();
    const task = newTask({ title: "active review regression", instructions: "implement the feature", acceptanceCriteria: ["feature implemented"] });
    task.taskId = "task-active-review";
    task.state = "running";
    task.waveRoot = capture.waveRoot;
    task.executorSelection = { source: "external", id: "active-exec" };
    const group: BackgroundExecutionGroup = {
      version: 3, revision: 1, integritySha256: "", executionId: "exec-active", kind: "execute",
      root: resolvedGroupRoot, cwd: sourceRoot, createdAt: now, updatedAt: now, peakConcurrency: 1, tasks: [task],
    };
    await writeGroupSnapshot(resolvedGroupRoot, serializeGroupSnapshot(group, new Map()));

    const tools: Array<Record<string, any>> = [];
    const pi: Record<string, any> = {
      registerTool(tool: Record<string, any>) { tools.push(tool); },
      registerCommand() {},
      setToolActive() {},
    };
    const manager = new ExecutionToolManager({ pi, config, state: createState(), cwd: () => sourceRoot });
    manager.sync();
    const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
    await controller.restore({ waveRoots: [], bundles: [], groupRoots: [resolvedGroupRoot] });
    try {
      const inspectTool = tools.find((tool) => tool.name === "SubtasksInspect")!;
      assert.ok(inspectTool, "SubtasksInspect must be registered");
      const execute = inspectTool.execute as ToolExecute;

      // The completed needs_changes review is visible while the worker corrects.
      const filtered = await execute("active-filter", { executionId: "exec-active", taskId: "task-active-review", evidence: { filter: "review" } });
      assert.equal(filtered.isError, false);
      const reviewEntries = (filtered.details.evidence.entries ?? []).filter((entry: { kind: string }) => entry.kind === "review");
      assert.equal(reviewEntries.length, 1, "the completed cycle's reviewer verdict must be inspectable");
      assert.match(String(reviewEntries[0]!.preview), /needs_changes/);

      const found = await execute("active-find", { executionId: "exec-active", taskId: "task-active-review", evidence: { find: "ACTIVE-CORRECTION-FINDING-MARKER" } });
      assert.equal(found.isError, false);
      assert.ok((found.details.evidence.matchSummary?.totalMatches ?? 0) >= 1, "the unique finding marker must be findable");

      const deep = await execute("active-deep", { executionId: "exec-active", taskId: "task-active-review", evidence: { entryId: reviewEntries[0]!.entryId } });
      assert.equal(deep.isError, false);
      assert.match(String(deep.details.evidence.deepContent?.content), /"severity":"blocking"/);
      assert.match(String(deep.details.evidence.deepContent?.content), /add the missing behavior/);

      // The authoritative context reports the current review state. A restored
      // controller with no live runtime honestly reports the active task as
      // paused_recoverable (writer ownership unverified); either way it is an
      // active/recoverable state, never a terminal one.
      assert.equal(filtered.details.evidence.context?.review?.aggregate, "needs_changes");
      assert.ok(["running", "paused_recoverable"].includes(filtered.details.evidence.context?.state), `context state must be active/recoverable, got ${filtered.details.evidence.context?.state}`);
    } finally {
      await manager.shutdown();
    }

    // Release the correction turn and let the lifecycle settle.
    await writeFile(releasePath, "released\n", "utf8");
    const result = await lifecycleCall;
    assert.equal(result.status, "correction_cap", `expected correction_cap, got ${result.status}`);
    assert.ok(await (async () => { try { await access(join(artifactDir, "result.json")); return true; } catch { return false; } })(), "final result settles after correction");

    // Both completed cycles remain durably inspectable after settlement.
    for (const cycle of [1, 2]) {
      const recordPath = join(artifactDir, "reviews", capture.waveId, `cycle-${String(cycle).padStart(6, "0")}.json`);
      await access(recordPath);
    }
  } finally {
    await settleLifecycle();
    delete process.env.PI_TEST_RELEASE_PATH;
    if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
  }
});
