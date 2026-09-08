/**
 * Per-adapter evidence record parsers (#33).
 *
 * Each parser turns bounded JSONL lines from one artifact stream into raw
 * evidence records. Privacy contract enforced here: private model reasoning
 * (Pi/Claude `thinking` blocks, Codex `reasoning` items, stream thinking
 * deltas) is never indexed in any path. Content is capped but not yet
 * redacted; redaction happens once during snapshot assembly so every view,
 * snippet, and deep read is served from the same retained text.
 */
import { capRawContent } from "./artifacts";
import type { RawEvidenceRecord, SubtaskEvidenceStatus } from "./types";

export interface ParsedLines {
  records: RawEvidenceRecord[];
  skippedRecords: number;
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Date.parse(value) === Number.NaN ? undefined : value;
}

export function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function singleLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function formatToolCall(name: string | undefined, args: unknown): string {
  const label = name ?? "tool";
  if (args === undefined) return label;
  if (typeof args === "string") return `${label} ${args}`;
  return `${label} ${compactJson(args)}`;
}

/** Joins text content blocks; images and other block types are named, never dumped. */
function formatContentBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : compactJson(content);
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image omitted]";
      return `[${String(block.type ?? "unknown")} block omitted]`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Caps source content and records whether the source exceeded the raw cap. */
function capped(content: string): { content: string; truncatedSource?: boolean } {
  const text = capRawContent(content);
  return Buffer.byteLength(text) < Buffer.byteLength(content)
    ? { content: text, truncatedSource: true }
    : { content: text };
}

// ---------------------------------------------------------------------------
// Pi session file (session format v1–v3)
// ---------------------------------------------------------------------------

/**
 * Assistant `toolCall` blocks and `toolResult`/`bashExecution` messages are
 * indexed. `thinking` blocks, user messages, custom extension entries, labels,
 * branch summaries, and compaction summaries are never indexed (summaries may
 * quote private reasoning).
 */
export function parsePiSessionLines(lines: Array<{ text: string }>): ParsedLines {
  const records: RawEvidenceRecord[] = [];
  let skipped = 0;
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) {
      skipped += 1;
      return;
    }
    const entryId = str(parsed.id) ?? `L${ordinal + 1}`;
    const at = isoString(parsed.timestamp);
    switch (parsed.type) {
      case "session":
        records.push({
          recordKey: entryId,
          at,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `executor session ${str(parsed.id) ?? "unknown"} started (v${num(parsed.version) ?? "?"})`,
        });
        break;
      case "message": {
        const message = isRecord(parsed.message) ? parsed.message : undefined;
        if (!message) {
          skipped += 1;
          return;
        }
        const role = str(message.role);
        if (role === "assistant") {
          const content = Array.isArray(message.content) ? message.content : [];
          let callOrdinal = 0;
          for (const block of content) {
            if (!isRecord(block)) continue;
            // `thinking` blocks are private reasoning: never indexed.
            if (block.type !== "toolCall") continue;
            records.push({
              recordKey: `${entryId}#c${callOrdinal++}`,
              at,
              kind: "tool_call",
              callId: str(block.id),
              toolName: str(block.name),
              provenance: "executor_observed",
              ...capped(formatToolCall(str(block.name), block.arguments)),
            });
          }
        } else if (role === "toolResult") {
          records.push({
            recordKey: entryId,
            at,
            kind: "tool_result",
            callId: str(message.toolCallId),
            toolName: str(message.toolName),
            status: message.isError === true ? "failed" : message.isError === false ? "succeeded" : "unknown",
            provenance: "executor_observed",
            ...capped(formatContentBlocks(message.content)),
          });
        } else if (role === "bashExecution") {
          const exitCode = num(message.exitCode);
          records.push({
            recordKey: entryId,
            at,
            kind: "tool_result",
            toolName: "bash_execution",
            status: exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
            provenance: "executor_observed",
            ...capped(
              [str(message.command) ?? "command unknown", `exit code: ${exitCode ?? "unobserved"}`, formatContentBlocks(message.output)]
                .filter(Boolean)
                .join("\n"),
            ),
          });
        } else {
          skipped += 1; // user, custom, branchSummary, compactionSummary: not tool/process evidence
        }
        break;
      }
      case "compaction": {
        const tokens = num(parsed.tokensBefore);
        records.push({
          recordKey: entryId,
          at,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `context compaction${tokens !== undefined ? ` (${tokens} tokens summarized)` : ""}`,
        });
        break;
      }
      case "model_change":
        records.push({
          recordKey: entryId,
          at,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `model changed to ${str(parsed.provider) ?? "unknown"}/${str(parsed.modelId) ?? "unknown"}`,
        });
        break;
      case "thinking_level_change":
        records.push({
          recordKey: entryId,
          at,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `thinking level set to ${str(parsed.thinkingLevel) ?? "unknown"}`,
        });
        break;
      default:
        skipped += 1; // custom, label, session_info, branch_summary: not tool/process evidence
    }
  });
  return { records, skippedRecords: skipped };
}

// ---------------------------------------------------------------------------
// RecordKey -> source line ordinal maps (for cursor digests)
// ---------------------------------------------------------------------------

/** Maps Pi session recordKeys back to their source line ordinals. */
export function piSessionRecordOrdinals(lines: Array<{ text: string }>): Map<string, number> {
  const ordinals = new Map<string, number>();
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) return;
    const entryId = str(parsed.id) ?? `L${ordinal + 1}`;
    if (parsed.type === "message" && isRecord(parsed.message) && parsed.message.role === "assistant") {
      const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
      let callOrdinal = 0;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        ordinals.set(`${entryId}#c${callOrdinal++}`, ordinal);
      }
    } else if (
      ["session", "compaction", "model_change", "thinking_level_change"].includes(String(parsed.type)) ||
      (parsed.type === "message" && isRecord(parsed.message) && ["toolResult", "bashExecution"].includes(String(parsed.message.role)))
    ) {
      ordinals.set(entryId, ordinal);
    }
  });
  return ordinals;
}

/** Maps stream recordKeys (`L<n>` or `L<n>#suffix`) back to line ordinals. */
export function streamRecordOrdinals(records: RawEvidenceRecord[], lineCount: number): Map<string, number> {
  const ordinals = new Map<string, number>();
  for (const record of records) {
    const match = /^L(\d+)(?:#|$)/.exec(record.recordKey);
    if (!match) continue;
    const ordinal = Number(match[1]!) - 1;
    if (ordinal >= 0 && ordinal < lineCount) ordinals.set(record.recordKey, ordinal);
  }
  return ordinals;
}

// ---------------------------------------------------------------------------
// Pi RPC stdout fallback (only when the turn's session file is missing)
// ---------------------------------------------------------------------------

/**
 * `tool_execution_start/end` carry `toolCallId` in real streams; events are
 * paired by id when present and positionally only while unambiguous.
 * `agent_end`/message events duplicate session records and are not indexed.
 */
export function parsePiStdoutLines(lines: Array<{ text: string }>): ParsedLines {
  const records: RawEvidenceRecord[] = [];
  let skipped = 0;
  const inFlightCalls: RawEvidenceRecord[] = [];
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) {
      skipped += 1;
      return;
    }
    const at = isoString(parsed.timestamp);
    switch (parsed.type) {
      case "tool_execution_start": {
        const record: RawEvidenceRecord = {
          recordKey: `L${ordinal + 1}`,
          at,
          kind: "tool_call",
          callId: str(parsed.toolCallId),
          toolName: str(parsed.toolName),
          provenance: "executor_observed",
          ...capped(formatToolCall(str(parsed.toolName), parsed.args)),
        };
        records.push(record);
        if (!record.callId) inFlightCalls.push(record);
        break;
      }
      case "tool_execution_end": {
        const result = isRecord(parsed.result) ? parsed.result : undefined;
        // #54: a plain-string result is already faithful text; rendering it
        // through JSON.stringify would quote and escape its newlines.
        const resultText = typeof parsed.result === "string" ? parsed.result : undefined;
        const record: RawEvidenceRecord = {
          recordKey: `L${ordinal + 1}`,
          at,
          kind: "tool_result",
          callId: str(parsed.toolCallId),
          toolName: str(parsed.toolName),
          status: parsed.isError === true ? "failed" : result !== undefined || parsed.isError === false ? "succeeded" : "unknown",
          provenance: "executor_observed",
          ...capped(result ? formatContentBlocks(result.content) : resultText ?? compactJson(parsed.result ?? null)),
        };
        if (!record.callId && inFlightCalls.length === 1) {
          const call = inFlightCalls.shift()!;
          record.callId = `pos:${ordinal + 1}`;
          record.pairedWith = call.recordKey;
          call.pairedWith = record.recordKey;
        }
        records.push(record);
        break;
      }
      case "turn_start":
        records.push({ recordKey: `L${ordinal + 1}`, at, kind: "lifecycle", provenance: "executor_observed", content: "model turn started" });
        break;
      case "turn_end":
        records.push({ recordKey: `L${ordinal + 1}`, at, kind: "lifecycle", provenance: "executor_observed", content: "model turn completed" });
        break;
      case "auto_retry_start": {
        const attempt = num(parsed.attempt);
        const maxAttempts = num(parsed.maxAttempts);
        const errorMessage = str(parsed.errorMessage);
        records.push({
          recordKey: `L${ordinal + 1}`,
          at,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `model retry${attempt !== undefined && maxAttempts !== undefined ? ` ${attempt}/${maxAttempts}` : ""}${errorMessage ? ` · ${singleLine(errorMessage)}` : ""}`,
        });
        break;
      }
      case "auto_retry_end":
        records.push({ recordKey: `L${ordinal + 1}`, at, kind: "lifecycle", provenance: "executor_observed", content: `model retry ${parsed.success === true ? "completed" : "failed"}` });
        break;
      case "compaction_start":
        records.push({ recordKey: `L${ordinal + 1}`, at, kind: "lifecycle", provenance: "executor_observed", content: "context compaction started" });
        break;
      case "compaction_end":
        records.push({ recordKey: `L${ordinal + 1}`, at, kind: "lifecycle", provenance: "executor_observed", content: `context compaction ${parsed.aborted === true ? "aborted" : parsed.result ? "completed" : "failed"}` });
        break;
      default:
        // agent_end/message_* duplicate session records; tool_execution_update
        // carries partial results. Neither is indexed.
        skipped += 1;
    }
  });
  return { records, skippedRecords: skipped };
}

// ---------------------------------------------------------------------------
// Claude SDK stream-json events (claude-cli adapter raw stream)
// ---------------------------------------------------------------------------

export function parseClaudeStreamLines(lines: Array<{ text: string }>): ParsedLines {
  const records: RawEvidenceRecord[] = [];
  let skipped = 0;
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) {
      skipped += 1;
      return;
    }
    switch (parsed.type) {
      case "system":
        if (parsed.subtype === "init") {
          records.push({ recordKey: `L${ordinal + 1}`, kind: "lifecycle", provenance: "executor_observed", content: `claude session started${str(parsed.model) ? ` (${str(parsed.model)})` : ""}` });
        } else if (parsed.subtype === "api_retry") {
          const attempt = num(parsed.attempt);
          const maxRetries = num(parsed.max_retries);
          const error = str(parsed.error);
          records.push({
            recordKey: `L${ordinal + 1}`,
            kind: "lifecycle",
            provenance: "executor_observed",
            content: `model retry${attempt !== undefined && maxRetries !== undefined ? ` ${attempt}/${maxRetries}` : ""}${error ? ` · ${singleLine(error)}` : ""}`,
          });
        } else {
          skipped += 1;
        }
        break;
      case "assistant": {
        const message = isRecord(parsed.message) ? parsed.message : undefined;
        const content = message && Array.isArray(message.content) ? message.content : [];
        let blockOrdinal = 0;
        for (const block of content) {
          if (!isRecord(block)) continue;
          // `thinking` blocks are private reasoning: never indexed.
          if (block.type !== "tool_use") continue;
          records.push({
            recordKey: `L${ordinal + 1}#t${blockOrdinal++}`,
            kind: "tool_call",
            callId: str(block.id), // missing ids stay unpaired rather than guessed
            toolName: str(block.name),
            provenance: "executor_observed",
            ...capped(formatToolCall(str(block.name), block.input)),
          });
        }
        break;
      }
      case "user": {
        const message = isRecord(parsed.message) ? parsed.message : undefined;
        const content = message && Array.isArray(message.content) ? message.content : [];
        let blockOrdinal = 0;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type !== "tool_result") continue;
          records.push({
            recordKey: `L${ordinal + 1}#r${blockOrdinal++}`,
            kind: "tool_result",
            callId: str(block.tool_use_id),
            status: block.is_error === true ? "failed" : block.is_error === false ? "succeeded" : "unknown",
            provenance: "executor_observed",
            ...capped(formatContentBlocks(block.content)),
          });
        }
        break;
      }
      case "result": {
        const resultText = str(parsed.result);
        records.push({
          recordKey: `L${ordinal + 1}`,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: parsed.is_error === true ? `model turn failed${resultText ? ` · ${singleLine(resultText)}` : ""}` : "model turn completed",
        });
        break;
      }
      default:
        // stream_event deltas (including thinking deltas) and unknown shapes
        // are never indexed.
        skipped += 1;
    }
  });
  return { records, skippedRecords: skipped };
}

// ---------------------------------------------------------------------------
// Codex app-server JSON-RPC notifications (codex-cli adapter raw stream)
// ---------------------------------------------------------------------------

interface CodexNotification {
  lineOrdinal: number;
  method: string;
  params: Record<string, unknown>;
}

/**
 * Items carry no stable ids in the captured stream, so started/completed pairs
 * are linked positionally only while unambiguous; overlapping in-flight items
 * are left unpaired rather than guessed. `reasoning` items are private model
 * reasoning and never indexed.
 */
export function parseCodexStreamLines(lines: Array<{ text: string }>): ParsedLines {
  const notifications: CodexNotification[] = [];
  let skipped = 0;
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) {
      skipped += 1;
      return;
    }
    if (typeof parsed.id === "number") {
      skipped += 1; // JSON-RPC responses are protocol traffic, not evidence
      return;
    }
    if (typeof parsed.method !== "string" || !isRecord(parsed.params)) {
      skipped += 1;
      return;
    }
    notifications.push({ lineOrdinal: ordinal, method: parsed.method, params: parsed.params });
  });

  const records: RawEvidenceRecord[] = [];
  const inFlight = new Map<string, RawEvidenceRecord[]>();
  let commandCounter = 0;
  for (const notification of notifications) {
    if (notification.method === "turn/completed") {
      const turn = isRecord(notification.params.turn) ? notification.params.turn : undefined;
      const threadId = str(notification.params.threadId);
      records.push({
        recordKey: `L${notification.lineOrdinal + 1}`,
        kind: "lifecycle",
        provenance: "executor_observed",
        content: `codex turn ${str(turn?.status) ?? "ended"}${threadId ? ` (thread ${singleLine(threadId)})` : ""}`,
      });
      continue;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      skipped += 1;
      continue;
    }
    const item = isRecord(notification.params.item) ? notification.params.item : undefined;
    if (!item) {
      skipped += 1;
      continue;
    }
    const itemType = str(item.type);
    if (itemType === "reasoning") {
      skipped += 1; // private reasoning: never indexed
      continue;
    }
    if (itemType === "agent_message") {
      skipped += 1; // final-response.md carries the worker claim
      continue;
    }
    const started = notification.method === "item/started";
    if (itemType === "command_execution") {
      if (started) {
        commandCounter += 1;
        const record: RawEvidenceRecord = {
          recordKey: `L${notification.lineOrdinal + 1}`,
          kind: "tool_call",
          callId: `cmd:${commandCounter}`,
          toolName: "command_execution",
          status: "in_flight",
          provenance: "executor_observed",
          ...capped(str(item.command) ?? "command unknown"),
        };
        records.push(record);
        inFlight.set("command_execution", [...(inFlight.get("command_execution") ?? []), record]);
      } else {
        const pending = inFlight.get("command_execution") ?? [];
        const exitCode = num(item.exit_code);
        const status: SubtaskEvidenceStatus = exitCode !== undefined
          ? (exitCode === 0 ? "succeeded" : "failed")
          : item.status === "failed" ? "failed" : "unknown";
        const record: RawEvidenceRecord = {
          recordKey: `L${notification.lineOrdinal + 1}`,
          kind: "tool_result",
          toolName: "command_execution",
          status,
          provenance: "executor_observed",
          ...capped(
            [exitCode !== undefined ? `exit code: ${exitCode}` : undefined, str(item.aggregated_output)].filter(Boolean).join("\n"),
          ),
        };
        if (pending.length === 1) {
          const call = pending[0]!;
          record.callId = call.callId;
          record.pairedWith = call.recordKey;
          call.pairedWith = record.recordKey;
          inFlight.set("command_execution", []);
        }
        // Overlapping in-flight commands: the completion is indexed but left
        // unattributed rather than positionally guessed.
        records.push(record);
      }
    } else if (itemType === "mcp_tool_call" || itemType === "web_search") {
      const name = itemType === "mcp_tool_call"
        ? `${str(item.server) ?? "mcp"}/${str(item.tool) ?? "tool"}`
        : "web_search";
      if (started) {
        records.push({
          recordKey: `L${notification.lineOrdinal + 1}`,
          kind: "tool_call",
          toolName: name,
          provenance: "executor_observed",
          ...capped(itemType === "web_search" ? (str(item.query) ?? "") : compactJson(item)),
        });
        inFlight.set(name, [...(inFlight.get(name) ?? []), records[records.length - 1]!]);
      } else {
        const pending = inFlight.get(name) ?? [];
        const failed = item.status === "failed" || (item.error !== undefined && item.error !== null);
        // #54: the web search query is the item's safe text field; retain it
        // verbatim instead of JSON-escaping its newlines. The remaining fields
        // (status, error, id, results) keep their previously retained compact
        // JSON representation so a failed search still carries its diagnostic
        // and metadata. Structured mcp_tool_call items keep their full compact
        // JSON representation (no established text field to render faithfully).
        const query = itemType === "web_search" ? str(item.query) : undefined;
        let content: string;
        if (query !== undefined) {
          const retained: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(item)) {
            if (key !== "type" && key !== "query") retained[key] = value;
          }
          content = [query, `web search ${failed ? "failed" : "completed"}`, compactJson(retained)].join("\n");
        } else {
          content = compactJson(item);
        }
        const record: RawEvidenceRecord = {
          recordKey: `L${notification.lineOrdinal + 1}`,
          kind: "tool_result",
          toolName: name,
          status: failed ? "failed" : "succeeded",
          provenance: "executor_observed",
          ...capped(content),
        };
        if (pending.length === 1) {
          record.callId = pending[0]!.callId;
          record.pairedWith = pending[0]!.recordKey;
          pending[0]!.pairedWith = record.recordKey;
          inFlight.set(name, []);
        }
        records.push(record);
      }
    } else if (itemType === "file_change") {
      const paths = Array.isArray(item.changes)
        ? item.changes.filter((change): change is Record<string, unknown> => isRecord(change) && typeof change.path === "string").slice(0, 10).map((change) => change.path as string)
        : [];
      records.push({
        recordKey: `L${notification.lineOrdinal + 1}`,
        kind: "lifecycle",
        toolName: "file_change",
        provenance: "executor_observed",
        content: paths.length > 0 ? `file change ${started ? "started" : "completed"}: ${paths.join(", ")}` : `file change ${started ? "started" : "completed"}`,
      });
    } else {
      skipped += 1;
    }
  }
  return { records, skippedRecords: skipped };
}

// ---------------------------------------------------------------------------
// run-as-binary protocol (pi-review-executor-jsonl-v1)
// ---------------------------------------------------------------------------

/**
 * session/assistant/usage lines only. There are no tool events in this
 * protocol, so linked call/result evidence is impossible and reported as such.
 */
export function parseBinaryStreamLines(lines: Array<{ text: string }>): ParsedLines {
  const records: RawEvidenceRecord[] = [];
  let skipped = 0;
  let lastClaimIndex = -1;
  lines.forEach((line, ordinal) => {
    const parsed = parseJsonLine(line.text);
    if (!parsed) {
      skipped += 1;
      return;
    }
    switch (parsed.type) {
      case "session":
        records.push({
          recordKey: `L${ordinal + 1}`,
          kind: "lifecycle",
          provenance: "executor_observed",
          content: `executor session ${str(parsed.sessionId) ?? "unknown"} started (binary protocol)`,
        });
        break;
      case "assistant":
        if (lastClaimIndex >= 0) records.splice(lastClaimIndex, 1); // last assistant text wins
        const record: RawEvidenceRecord = {
          recordKey: `L${ordinal + 1}`,
          kind: "claim",
          provenance: "worker_claim",
          ...capped(str(parsed.text) ?? ""),
        };
        lastClaimIndex = records.length;
        records.push(record);
        break;
      default:
        skipped += 1; // usage and unknown shapes
    }
  });
  return { records, skippedRecords: skipped };
}
