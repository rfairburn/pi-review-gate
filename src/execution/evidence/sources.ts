/**
 * Evidence source discovery and indexing (#33).
 *
 * Sources are derived exclusively from the task's durable artifact directory
 * (never from caller-supplied paths): Pi session files under
 * `executor-sessions/`, per-turn directories under `executor/NNNN/`, durable
 * completed review cycle records and publication-failure markers (see
 * `./review-cycles.ts`), and the durable review report. Pi turns are indexed
 * from their session file as the
 * single source of truth; a pi turn whose session file is missing falls back
 * to its RPC stdout stream explicitly (never both, so no evidence is
 * double-counted). Unknown adapter shapes are reported unavailable — never
 * dumped raw.
 */
import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OperationRecord } from "../operation-record";
import { EvidenceRefusalError, capped, evidenceErrorMessage, finalizeSource, omittedNote, readBoundedJson, resolveReadableArtifact, resolveReadableDirectory, sha256HexOf, streamJsonlBounded } from "./artifacts";
import { REVIEW_CYCLE_MARKER_NAME, REVIEW_CYCLE_RECORD_NAME, indexReviewCycleSource, indexReviewCycleUnpublishedSource } from "./review-cycles";
import { readBoundedTextFile } from "../../bounded-file";
import { utf8Prefix } from "../../jsonl";
import { redactSensitiveText } from "../../redaction";
import { compactJson, isRecord, parseBinaryStreamLines, parseClaudeStreamLines, parseCodexStreamLines, parsePiSessionLines, parsePiStdoutLines, piSessionRecordOrdinals, streamRecordOrdinals } from "./parsers";
import {
  EVIDENCE_ENTRY_CONTENT_BYTES,
  EVIDENCE_MAX_ENTRIES,
  EVIDENCE_MAX_ENUMERATED_ENTRIES,
  EVIDENCE_MAX_SOURCES,
  EVIDENCE_OPERATION_CONTEXT_BYTES,
  EVIDENCE_PREVIEW_CHARS,
  EVIDENCE_RAW_RECORD_CONTENT_BYTES,
  EVIDENCE_TOTAL_CONTENT_BYTES,
  type IndexedSource,
  type RawEvidenceRecord,
  type RawRetentionBudget,
  type SubtaskEvidenceCapability,
  type SubtaskEvidenceDiagnostics,
  type SubtaskEvidenceEntryView,
  type SubtaskEvidenceKind,
  type SubtaskEvidenceSnapshot,
  type SubtaskEvidenceSourceSummary,
  type SubtaskEvidenceUnavailable,
} from "./types";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstAtOf(records: RawEvidenceRecord[]): string | undefined {
  for (const record of records) if (record.at) return record.at;
  return undefined;
}

function lastAtOf(records: RawEvidenceRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) if (records[i]!.at) return records[i]!.at;
  return undefined;
}

export function sourceUnavailable(sourceId: string, streamed: { tornTail: boolean; oversizedRecords: number; scanBudgetReached: boolean }): SubtaskEvidenceUnavailable[] {
  const out: SubtaskEvidenceUnavailable[] = [];
  if (streamed.tornTail) out.push({ source: sourceId, reason: "torn_tail", detail: "Final line is unterminated (concurrent append or partial write); it was not indexed as a record." });
  if (streamed.oversizedRecords > 0) out.push({ source: sourceId, reason: "oversized_records", detail: `${streamed.oversizedRecords} record(s) exceeded the per-record size limit and were dropped.` });
  if (streamed.scanBudgetReached) out.push({ source: sourceId, reason: "scan_budget", detail: "Only the bounded tail byte window was scanned; earlier bytes and the initial boundary record are unavailable in this snapshot." });
  return out;
}

async function indexSessionSource(artifactRoot: string, fileName: string, mtimeMs: number, budget: RawRetentionBudget): Promise<IndexedSource | undefined> {
  const sourceId = `session:${fileName}`;
  const file = join("executor-sessions", fileName);
  const path = await resolveReadableArtifact(artifactRoot, join(artifactRoot, file));
  if (!path) return undefined;
  const streamed = await streamJsonlBounded(path, EVIDENCE_MAX_ENTRIES, { budget });
  const parsed = parsePiSessionLines(streamed.lines);
  const digests = new Map<string, string>();
  for (const [recordKey, ordinal] of piSessionRecordOrdinals(streamed.lines)) {
    digests.set(recordKey, streamed.lines[ordinal]?.digest ?? "");
  }
  return finalizeSource({
    sourceId,
    adapter: "pi-model",
    stream: "session",
    file,
    orderKey: firstAtOf(parsed.records) ?? new Date(mtimeMs).toISOString(),
    records: parsed.records,
    digests,
    unavailable: [...sourceUnavailable(sourceId, streamed), ...omittedNote(sourceId, streamed.recordsOmitted)],
    stats: { recordsScanned: streamed.lines.length, oversizedRecords: streamed.oversizedRecords, skippedRecords: parsed.skippedRecords, ...(streamed.recordsOmitted > 0 ? { recordsOmitted: streamed.recordsOmitted } : {}), ...(streamed.budgetOmitted > 0 ? { budgetOmitted: streamed.budgetOmitted } : {}) },
  });
}

/**
 * Establishes one turn's adapter kind from canonical durable evidence only.
 *
 * The record's top-level `adapter` field is CURRENT assignment identity: it is
 * rewritten whenever a new executor assignment starts, so it describes only the
 * latest assignment — never an earlier one. This resolver therefore walks the
 * per-turn chain instead: the attempts list names the generation that ran each
 * turn number, and the assignments list records which selection served each
 * window. An adapter kind is returned only when that chain identifies this
 * turn's own executor:
 * - a pi selection deterministically resolves to `pi-model`;
 * - an external agent id is a mutable catalog handle and cannot be resolved
 *   without reading the current (mutable) agent catalog, so it establishes a
 *   kind only while its assignment is still the record's latest one — then the
 *   producer-written top-level `adapter` (set when that assignment started,
 *   before any of its turns ran) still describes it.
 * Everything else stays explicitly unavailable rather than guessed (#69).
 */
function resolveTurnAdapter(operation: OperationRecord | undefined, turnName: string): { adapter?: string; detail: string } {
  const turnNumber = Number(turnName);
  if (!operation || !Number.isInteger(turnNumber) || turnNumber <= 0) return { detail: "" };

  // Canonical per-turn record: the attempt that ran this exact turn number.
  const attempt = (operation.attempts ?? []).find(
    (candidate) => candidate.turn === turnNumber && typeof candidate.startedAt === "string",
  );
  if (!attempt) {
    return { detail: "the durable operation record has no attempt for this turn, so its adapter cannot be established from canonical evidence." };
  }

  // The assignment whose recorded window covers the attempt's start.
  const assignments = (Array.isArray(operation.assignments) ? operation.assignments : []).filter(
    (candidate) => typeof candidate.startedAt === "string",
  );
  let candidates = assignments.filter(
    (candidate) =>
      candidate.startedAt <= attempt.startedAt!
      && (candidate.endedAt === undefined || candidate.endedAt >= attempt.startedAt!),
  );
  if (candidates.length > 1) {
    // Same-millisecond boundaries: narrow by the attempt's recorded generation
    // (compaction recovery can advance generations inside one assignment, so
    // this is a tie-breaker, not a primary key).
    const byGeneration = candidates.filter((candidate) => candidate.generation === attempt.generation);
    if (byGeneration.length === 1) candidates = byGeneration;
  }
  if (candidates.length !== 1) {
    return { detail: candidates.length === 0
      ? "the durable operation record has no assignment covering this turn's attempt, so its adapter cannot be established."
      : "multiple executor assignments overlap this turn's recorded start, so its adapter cannot be established unambiguously." };
  }
  const assignment = candidates[0]!;

  const selection = isRecord(assignment.selection) ? assignment.selection : undefined;
  if (selection?.source === "pi") {
    // Established, but not indexable by this raw-stream fallback: pi turns are
    // indexed from their session file (or its explicit stdout fallback), never
    // parsed as an external agent stream.
    return { adapter: "pi-model", detail: "the durable operation record's assignment for this turn was a pi executor, and this fallback indexes only claude-cli/codex-cli raw streams" };
  }
  // External selections record only a mutable catalog id. The top-level
  // producer-written adapter still describes the latest assignment (it is set
  // when that assignment starts, before any of its turns run), so it may be
  // used only for turns of that latest assignment.
  const currentAdapter = typeof operation.adapter === "string" ? operation.adapter : undefined;
  if (selection?.source === "external"
    && assignments[assignments.length - 1] === assignment
    && (currentAdapter === "claude-cli" || currentAdapter === "codex-cli")) {
    return { adapter: currentAdapter, detail: `the durable operation record's latest assignment ran this turn and recorded adapter "${currentAdapter}"` };
  }
  return { detail: selection?.source === "external"
    ? "this turn's recorded assignment used an external agent id (a mutable catalog handle) that cannot be resolved to an adapter kind from durable evidence alone."
    : "this turn's recorded assignment has no readable executor selection." };
}

/**
 * Indexes one executor turn. A turn whose own process-result.json did not
 * record an adapter (in-flight or incomplete turn) is resolved from the
 * durable operation record's canonical per-turn evidence via
 * resolveTurnAdapter — never from the record's current `adapter` field alone,
 * which later reassignments and failovers overwrite. It is producer-recorded
 * identity only; without it the stream stays explicitly unindexed (#69).
 */
async function indexTurnSource(artifactRoot: string, turnName: string, mtimeMs: number, sessionFileNames: ReadonlySet<string>, budget: RawRetentionBudget, operation?: OperationRecord): Promise<IndexedSource> {
  const sourceId = `turn:${turnName}`;
  const dirRel = join("executor", turnName);
  const unavailable: SubtaskEvidenceUnavailable[] = [];
  const digests = new Map<string, string>();
  let records: RawEvidenceRecord[] = [];
  let stats = { recordsScanned: 0, oversizedRecords: 0, skippedRecords: 0, recordsOmitted: 0, budgetOmitted: 0 };

  const processResultPath = join(artifactRoot, dirRel, "process-result.json");
  let processResult: Record<string, unknown> | undefined;
  try {
    const real = await resolveReadableArtifact(artifactRoot, processResultPath);
    if (real) processResult = await readBoundedJson(real, 64 * 1024);
    else unavailable.push({ source: sourceId, reason: "unreadable", detail: `process-result.json is missing under ${dirRel}/.` });
    if (real && processResult === undefined) unavailable.push({ source: sourceId, reason: "unreadable", detail: `process-result.json under ${dirRel}/ is not valid JSON.` });
  } catch (error) {
    if (error instanceof EvidenceRefusalError) unavailable.push({ source: sourceId, reason: error.reason, detail: evidenceErrorMessage(error) });
    else throw error;
  }
  const adapter = str(processResult?.adapter);
  let effectiveAdapter = adapter;

  const streamPath = join(artifactRoot, dirRel, "raw-stream.txt");
  let hasStream = false;
  const indexStream = async (parse: (lines: Array<{ text: string }>) => { records: RawEvidenceRecord[]; skippedRecords: number }): Promise<void> => {
    const real = await resolveReadableArtifact(artifactRoot, streamPath);
    if (!real) return;
    hasStream = true;
    const streamed = await streamJsonlBounded(real, EVIDENCE_MAX_ENTRIES, { budget });
    stats = { recordsScanned: streamed.lines.length, oversizedRecords: streamed.oversizedRecords, skippedRecords: 0, recordsOmitted: streamed.recordsOmitted, budgetOmitted: streamed.budgetOmitted };
    const parsed = parse(streamed.lines);
    records.push(...parsed.records);
    stats.skippedRecords += parsed.skippedRecords;
    for (const [recordKey, ordinal] of streamRecordOrdinals(parsed.records, streamed.lines.length)) {
      digests.set(recordKey, streamed.lines[ordinal]?.digest ?? "");
    }
    for (const item of sourceUnavailable(sourceId, streamed)) unavailable.push(item);
    for (const item of omittedNote(sourceId, streamed.recordsOmitted)) unavailable.push(item);
  };

  if (adapter === "pi-model") {
    // Pi turns are indexed from their session file (single source of truth).
    // When the session file is missing for this turn, fall back to the RPC
    // stdout stream explicitly instead of double-counting both.
    const sessionId = str(processResult?.sessionId);
    const hasSessionFile = sessionId !== undefined
      && [...sessionFileNames].some((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`));
    if (!hasSessionFile) {
      try {
        await indexStream(parsePiStdoutLines);
        if (hasStream) unavailable.push({ source: sourceId, reason: "missing_stream", detail: `Session file for ${sessionId ?? "this turn"} not found; RPC stdout stream indexed as fallback.` });
      } catch (error) {
        if (error instanceof EvidenceRefusalError) unavailable.push({ source: sourceId, reason: error.reason, detail: evidenceErrorMessage(error) });
        else throw error;
      }
    }
  } else {
    try {
      if (adapter === "claude-cli") await indexStream(parseClaudeStreamLines);
      else if (adapter === "codex-cli") await indexStream(parseCodexStreamLines);
      else if (adapter === "run-as-binary") await indexStream(parseBinaryStreamLines);
      else if (adapter) {
        unavailable.push({ source: sourceId, reason: "unsupported_adapter", detail: `No evidence parser exists for adapter "${adapter}"; the raw stream is not indexed.` });
      } else {
        // process-result.json did not record this turn's adapter (in-flight or
        // incomplete turn). Resolve it from the durable operation record's
        // canonical per-turn evidence (attempt -> assignment), never from the
        // record's current adapter field alone — later reassignments overwrite
        // that field, and an earlier turn must keep its own identity (#69).
        const turnAdapter = resolveTurnAdapter(operation, turnName);
        if ((turnAdapter.adapter === "claude-cli" || turnAdapter.adapter === "codex-cli") && (await resolveReadableArtifact(artifactRoot, streamPath))) {
          effectiveAdapter = turnAdapter.adapter;
          unavailable.push({ source: sourceId, reason: "adapter_from_operation_record", detail: `process-result.json did not record the turn adapter; indexed with "${turnAdapter.adapter}" — ${turnAdapter.detail}.` });
          await indexStream(turnAdapter.adapter === "claude-cli" ? parseClaudeStreamLines : parseCodexStreamLines);
        } else {
          unavailable.push({ source: sourceId, reason: "unsupported_adapter", detail: `Cannot determine the turn adapter (process-result.json missing); the raw stream is not indexed.${turnAdapter.detail ? ` ${turnAdapter.detail}` : ""}` });
        }
      }
    } catch (error) {
      if (error instanceof EvidenceRefusalError) unavailable.push({ source: sourceId, reason: error.reason, detail: evidenceErrorMessage(error) });
      else throw error;
    }
  }

  // Observed process outcome (never an inference about test success).
  if (processResult) {
    const code = num(processResult.code);
    const timedOut = processResult.timedOut === true;
    const aborted = processResult.aborted === true;
    const parts: string[] = [];
    if (code !== undefined) parts.push(`exit code: ${code}`);
    if (timedOut) parts.push("timed out");
    if (aborted) parts.push("aborted");
    if (processResult.stdoutTruncated === true) parts.push("stdout capture truncated at the retention limit");
    records.push({
      recordKey: "process",
      kind: "process",
      provenance: "executor_observed",
      status: code === undefined && !timedOut && !aborted ? "unknown" : code === 0 && !timedOut && !aborted ? "succeeded" : "failed",
      content: parts.length > 0 ? `executor process turn ${turnName}: ${parts.join(", ")}` : `executor process turn ${turnName}: no outcome recorded`,
    });
    digests.set("process", sha256HexOf(compactJson(processResult)));
  }

  // Worker claim: the turn's final response text.
  try {
    const real = await resolveReadableArtifact(artifactRoot, join(artifactRoot, dirRel, "final-response.md"));
    if (real) {
      const { text } = await readBoundedTextFile(real, EVIDENCE_RAW_RECORD_CONTENT_BYTES);
      if (text.trim()) {
        records.push({ recordKey: "claim", kind: "claim", provenance: "worker_claim", ...capped(text) });
        digests.set("claim", sha256HexOf(text));
      }
    }
  } catch (error) {
    if (!(error instanceof EvidenceRefusalError)) throw error;
    unavailable.push({ source: sourceId, reason: error.reason, detail: evidenceErrorMessage(error) });
  }

  if (!hasStream && !processResult && records.length === 0) {
    unavailable.push({ source: sourceId, reason: "missing_stream", detail: `Turn ${turnName} has no readable raw stream or process result.` });
  }

  return finalizeSource({
    sourceId,
    adapter: effectiveAdapter ?? "unknown",
    stream: "stdout",
    file: `${dirRel}/`,
    // Claude stream timestamps are display-only (SDK docs): they must not
    // change this source's pre-change ordering basis (artifact mtime), or
    // cross-source ordering and the global retention window would follow a
    // display clock. Every other adapter keeps the existing record-time-then-
    // mtime policy untouched (their records carry no `at`).
    orderKey: effectiveAdapter === "claude-cli"
      ? new Date(mtimeMs).toISOString()
      : firstAtOf(records) ?? new Date(mtimeMs).toISOString(),
    records,
    digests,
    unavailable,
    stats,
  });
}

/**
 * Reads the durable operation record through the same bounded, confined
 * regular-file reader as every other evidence artifact (never an unbounded
 * readFile), and validates ownership before it may inform the context:
 * the record must belong to this task and its recorded artifactDir must
 * canonicalize to this artifact root. Refusals and mismatches are reported
 * as explicit unavailable notes; the record is then simply not used.
 */
export async function readConfinedOperationRecord(
  artifactRoot: string,
  taskId: string,
): Promise<{ record?: OperationRecord; unavailable?: SubtaskEvidenceUnavailable }> {
  const rel = "operation.json";
  let real: string | undefined;
  try {
    real = await resolveReadableArtifact(artifactRoot, join(artifactRoot, rel));
  } catch (error) {
    if (error instanceof EvidenceRefusalError) {
      return { unavailable: { source: rel, reason: error.reason, detail: `operation.json was refused as evidence context: ${evidenceErrorMessage(error)}` } };
    }
    throw error;
  }
  if (!real) return {}; // no durable record yet: a normal state, not an error
  const { text, truncated } = await readBoundedTextFile(real, EVIDENCE_OPERATION_CONTEXT_BYTES);
  if (truncated) {
    return { unavailable: { source: rel, reason: "unreadable", detail: `operation.json exceeds the ${EVIDENCE_OPERATION_CONTEXT_BYTES}-byte bounded evidence context size; it was not used.` } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { unavailable: { source: rel, reason: "unreadable", detail: "operation.json is not valid JSON; it was not used as evidence context." } };
  }
  const record = parsed as Record<string, unknown>;
  const structurallyValid = record && typeof record === "object"
    && record.version === 1
    && typeof record.revision === "number"
    && typeof record.operationId === "string"
    && typeof record.waveId === "string"
    && typeof record.taskId === "string"
    && typeof record.artifactDir === "string"
    && Array.isArray(record.attempts)
    && Array.isArray(record.incidents);
  if (!structurallyValid) {
    return { unavailable: { source: rel, reason: "unreadable", detail: "operation.json is not a valid operation record; it was not used as evidence context." } };
  }
  if (record.taskId !== taskId) {
    return { unavailable: { source: rel, reason: "unreadable", detail: `operation.json belongs to task "${String(record.taskId)}", not "${taskId}"; it was not used as evidence context.` } };
  }
  // Ownership must be verifiable, not merely uncontradicted: an unresolvable
  // recorded artifactDir fails closed instead of passing by absence.
  const recordedArtifactDir = await realpath(String(record.artifactDir)).catch(() => undefined);
  const rootReal = await realpath(artifactRoot).catch(() => resolve(artifactRoot));
  if (!recordedArtifactDir || recordedArtifactDir !== rootReal) {
    return { unavailable: { source: rel, reason: "unreadable", detail: `operation.json records an artifact directory that cannot be verified as this task's (${String(record.artifactDir)}); it was not used as evidence context.` } };
  }
  return { record: parsed as OperationRecord };
}

/**
 * Validate the artifact directory against its wave root (fail closed): the
 * directory must exist, be a directory, and canonicalize inside the wave root.
 */
export async function resolveArtifactRoot(waveRoot: string | undefined, artifactDir: string, unavailable: SubtaskEvidenceUnavailable[]): Promise<string | undefined> {
  const info = await stat(artifactDir).catch(() => undefined);
  if (!info) {
    unavailable.push({ reason: "artifact_dir_missing", detail: `Artifact directory ${artifactDir} does not exist (GC'd, removed on shutdown, or never created).` });
    return undefined;
  }
  if (!info.isDirectory()) {
    unavailable.push({ reason: "non_regular_file", detail: `Artifact path ${artifactDir} is not a directory.` });
    return undefined;
  }
  const real = await realpath(artifactDir).catch(() => resolve(artifactDir));
  if (waveRoot) {
    const waveReal = await realpath(waveRoot).catch(() => undefined);
    if (waveReal) {
      const rel = relative(waveReal, real);
      if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
        throw new EvidenceRefusalError("path_escape", `Artifact directory ${artifactDir} escapes its wave root; refusing to read evidence.`);
      }
    }
  }
  return real;
}

/**
 * Bounded enumeration: the cap applies during iteration, before the whole
 * directory is allocated and sorted; overflow is disclosed explicitly.
 */
async function enumerateNames(dir: string, dirLabel: string, pattern: (name: string) => boolean, unavailable: SubtaskEvidenceUnavailable[]): Promise<string[]> {
  const names: string[] = [];
  try {
    const directory = await opendir(dir);
    let visited = 0;
    for await (const entry of directory) {
      if (visited >= EVIDENCE_MAX_ENUMERATED_ENTRIES) {
        unavailable.push({ source: dirLabel, reason: "source_budget", detail: `${dirLabel} exceeded the directory enumeration budget; remaining names were not inspected.` });
        break;
      }
      visited += 1;
      if (pattern(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    unavailable.push({ source: dirLabel, reason: "unreadable", detail: evidenceErrorMessage(error) });
    return [];
  }
  return names.sort();
}

/** Discovers and indexes every authorized source under the artifact root. */
export async function discoverAndIndexSources(taskId: string, artifactRoot: string, unavailable: SubtaskEvidenceUnavailable[], budget: RawRetentionBudget, operation?: OperationRecord): Promise<IndexedSource[]> {
  const sources: IndexedSource[] = [];

  const sessionsDir = await resolveReadableDirectory(artifactRoot, join(artifactRoot, "executor-sessions"));
  const sessionNames = sessionsDir
    ? await enumerateNames(sessionsDir, "executor-sessions/", (name) => name.endsWith(".jsonl"), unavailable)
    : [];

  const executorDir = await resolveReadableDirectory(artifactRoot, join(artifactRoot, "executor"));
  const turnNames = executorDir
    ? await enumerateNames(executorDir, "executor/", (name) => /^\d{4}$/.test(name), unavailable)
    : [];

  const sessionSet = new Set(sessionNames);
  for (const name of sessionNames) {
    if (sources.length >= EVIDENCE_MAX_SOURCES) {
      unavailable.push({ source: `session:${name}`, reason: "source_budget", detail: `Source limit ${EVIDENCE_MAX_SOURCES} reached; remaining sources are not indexed.` });
      continue;
    }
    try {
      const mtime = (await stat(join(sessionsDir!, name))).mtimeMs;
      const source = await indexSessionSource(artifactRoot, name, mtime, budget);
      if (source) sources.push(source);
      else unavailable.push({ source: `session:${name}`, reason: "unreadable", detail: "Session file disappeared or is unreadable." });
    } catch (error) {
      if (error instanceof EvidenceRefusalError) unavailable.push({ source: `session:${name}`, reason: error.reason, detail: evidenceErrorMessage(error) });
      else throw error;
    }
  }
  for (const name of turnNames) {
    if (sources.length >= EVIDENCE_MAX_SOURCES) {
      unavailable.push({ source: `turn:${name}`, reason: "source_budget", detail: `Source limit ${EVIDENCE_MAX_SOURCES} reached; remaining sources are not indexed.` });
      continue;
    }
    try {
      const mtime = (await stat(join(executorDir!, name))).mtimeMs;
      sources.push(await indexTurnSource(artifactRoot, name, mtime, sessionSet, budget, operation));
    } catch (error) {
      if (error instanceof EvidenceRefusalError) unavailable.push({ source: `turn:${name}`, reason: error.reason, detail: evidenceErrorMessage(error) });
      else throw error;
    }
  }

  // Durable completed review cycles (#50): reviews/<waveId>/cycle-NNNN.json,
  // written by the gate itself when each cycle completes. They carry the
  // official verdict and findings with task/wave/cycle identity, so a
  // completed review is inspectable while the worker is still correcting.
  // A cycle whose record publication failed leaves an explicit marker
  // (cycle-NNNN.json.unpublished) instead of a silent gap.
  const reviewsDir = await resolveReadableDirectory(artifactRoot, join(artifactRoot, "reviews"));
  if (reviewsDir) {
    const waveNames = await enumerateNames(reviewsDir, "reviews/", () => true, unavailable);
    for (const waveName of waveNames) {
      const waveDir = await resolveReadableDirectory(artifactRoot, join(artifactRoot, "reviews", waveName));
      if (!waveDir) continue; // not a directory: no canonical cycle layout here
      const cycleNames = await enumerateNames(waveDir, `reviews/${waveName}/`, (name) => REVIEW_CYCLE_RECORD_NAME.test(name) || REVIEW_CYCLE_MARKER_NAME.test(name), unavailable);
      for (const cycleName of cycleNames) {
        if (sources.length >= EVIDENCE_MAX_SOURCES) {
          unavailable.push({ source: `review:${waveName}:${cycleName}`, reason: "source_budget", detail: `Source limit ${EVIDENCE_MAX_SOURCES} reached; remaining sources are not indexed.` });
          continue;
        }
        try {
          sources.push(REVIEW_CYCLE_MARKER_NAME.test(cycleName)
            ? await indexReviewCycleUnpublishedSource(artifactRoot, waveName, cycleName, taskId, budget)
            : await indexReviewCycleSource(artifactRoot, waveName, cycleName, taskId, budget));
        } catch (error) {
          if (error instanceof EvidenceRefusalError) unavailable.push({ source: `review:${waveName}:${cycleName}`, reason: error.reason, detail: evidenceErrorMessage(error) });
          else throw error;
        }
      }
    }
  }

  return sources;
}


// ---------------------------------------------------------------------------
// Snapshot assembly: global ordering, call/result pairing, redaction, retention
// ---------------------------------------------------------------------------

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > EVIDENCE_PREVIEW_CHARS ? `${compact.slice(0, EVIDENCE_PREVIEW_CHARS - 1)}…` : compact;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Assembles the ordered snapshot from indexed sources. Pairing is by real call
 * ids across all sources (synthetic pos:/cmd: ids were already paired within
 * their own source). Source-scoped observed item identities (e.g. Codex
 * app-server item ids, `pairingScopedToSource`) are excluded from that
 * snapshot-wide pass: their pairing was already decided — or explicitly
 * refused — by their own parser, and re-pairing them here could manufacture
 * links across ambiguous duplicates or different sources. Every
 * view/snippet/deep read is served from redacted retained content under
 * per-entry and global byte budgets.
 */
export function assembleSnapshot(taskId: string, sources: IndexedSource[], unavailable: SubtaskEvidenceUnavailable[], rawBudget?: RawRetentionBudget): SubtaskEvidenceSnapshot {
  const ordered = [...sources].sort((a, b) => (a.orderKey === b.orderKey ? a.sourceId.localeCompare(b.sourceId) : a.orderKey < b.orderKey ? -1 : 1));

  // Pass 1: lightweight metadata (pairing works on ids, not content).
  interface Meta {
    source: IndexedSource;
    record: RawEvidenceRecord;
    entryId: string;
    callId?: string;
    kind: SubtaskEvidenceKind;
  }
  const metas: Meta[] = [];
  let entryCapReached = false;
  // Retain the NEWEST global entries: walk sources and records in reverse
  // chronological order up to the cap, then restore chronological order. This
  // keeps later sources reachable even when earlier ones overflow the window.
  for (const source of [...ordered].reverse()) {
    for (const record of [...source.records].reverse()) {
      if (metas.length >= EVIDENCE_MAX_ENTRIES) {
        entryCapReached = true;
        break;
      }
      metas.push({ source, record, entryId: `${source.sourceId}/${record.recordKey}`, callId: record.callId, kind: record.kind });
    }
    if (entryCapReached) break;
  }
  metas.reverse();
  if (entryCapReached) {
    unavailable.push({ reason: "records_omitted", detail: "Earlier entries were omitted by the global rolling entry window; they are not indexed in this snapshot." });
  }

  // Parser-level pairing (synthetic pos:/cmd: ids) was resolved within its own
  // source; reflect it in the call's status here and resolve the sibling
  // reference from a bare recordKey to a full navigable entryId.
  const entryIdByRecord = new Map<string, string>();
  for (const meta of metas) entryIdByRecord.set(`${meta.source.sourceId}|${meta.record.recordKey}`, meta.entryId);
  for (const meta of metas) {
    if (!meta.record.pairedWith) continue;
    if (meta.kind === "tool_call" && (meta.record.status === undefined || meta.record.status === "in_flight")) {
      meta.record.status = "returned";
    }
    if (!meta.record.pairedWith.includes("/")) {
      const resolved = entryIdByRecord.get(`${meta.source.sourceId}|${meta.record.pairedWith}`);
      if (resolved) meta.record.pairedWith = resolved;
    }
  }

  const isSyntheticCallId = (callId: string): boolean => callId.startsWith("pos:") || callId.startsWith("cmd:");
  const callsById = new Map<string, Meta[]>();
  const resultsById = new Map<string, Meta[]>();
  for (const meta of metas) {
    // Source-scoped observed identities keep their parser's pairing decision
    // (validated link or explicit refusal); this pass must not override it.
    if (!meta.callId || isSyntheticCallId(meta.callId) || meta.record.pairingScopedToSource === true) continue;
    const map = meta.kind === "tool_call" ? callsById : resultsById;
    const list = map.get(meta.callId) ?? [];
    list.push(meta);
    map.set(meta.callId, list);
  }
  for (const [callId, calls] of callsById) {
    const results = resultsById.get(callId) ?? [];
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const result = results[i];
      if (result) {
        call.record.status = "returned";
        call.record.pairedWith ??= result.entryId;
        result.record.pairedWith ??= call.entryId;
      } else if (call.record.status === undefined) {
        call.record.status = "in_flight";
      }
    }
  }

  // Pass 2: redaction + bounded retention, in global order.
  const contentByEntryId = new Map<string, string>();
  const digestByEntryId = new Map<string, string>();
  let remainingBudget = EVIDENCE_TOTAL_CONTENT_BYTES;
  let contentRetentionExhausted = false;
  const entries: SubtaskEvidenceEntryView[] = metas.map((meta, index) => {
    const redacted = redactSensitiveText(meta.record.content);
    let retained = utf8Prefix(redacted, EVIDENCE_ENTRY_CONTENT_BYTES);
    // Honest truncation: the source record exceeded the raw cap at parse time,
    // or retention capped the redacted content.
    let truncatedContent = meta.record.truncatedSource === true || byteLength(retained) < byteLength(redacted);
    const fullBytes = byteLength(retained);
    if (fullBytes > remainingBudget) {
      // Global budget exhausted: keep only a preview-sized prefix, honestly.
      retained = utf8Prefix(compactPreview(retained), EVIDENCE_PREVIEW_CHARS * 2);
      truncatedContent = true;
      contentRetentionExhausted = true;
    }
    remainingBudget -= byteLength(retained);
    contentByEntryId.set(meta.entryId, retained);
    digestByEntryId.set(meta.entryId, meta.source.digests.get(meta.record.recordKey) ?? "");
    return {
      index,
      entryId: meta.entryId,
      at: meta.record.at,
      kind: meta.kind,
      callId: meta.record.callId,
      toolName: meta.record.toolName,
      status: meta.record.status,
      provenance: meta.record.provenance,
      preview: compactPreview(retained),
      contentBytes: byteLength(retained),
      ...(truncatedContent ? { truncatedContent: true } : {}),
      pairedWith: meta.record.pairedWith,
      ...(meta.record.pairingScopedToSource === true ? { pairingScopedToSource: true } : {}),
      source: {
        sourceId: meta.source.sourceId,
        adapter: meta.source.adapter,
        stream: meta.source.stream,
        file: meta.source.file,
        recordKey: meta.record.recordKey,
      },
    };
  });

  const sourcesSummary: SubtaskEvidenceSourceSummary[] = ordered.map((source) => ({
    sourceId: source.sourceId,
    adapter: source.adapter,
    stream: source.stream,
    file: source.file,
    records: source.records.length,
    firstAt: firstAtOf(source.records),
    lastAt: lastAtOf(source.records),
  }));

  const hasToolEvidence = entries.some((entry) => entry.kind === "tool_call" || entry.kind === "tool_result");
  const binaryOnly = ordered.length > 0 && ordered.every((source) => source.adapter === "run-as-binary");
  // Name the adapters actually inspected so an empty tool-evidence result is
  // attributable to a specific retained stream, not to a silent gap.
  const inspectedAdapters = [...new Set(ordered.map((source) => source.adapter).filter((adapter) => adapter !== "unknown"))];
  const capability: SubtaskEvidenceCapability = hasToolEvidence
    ? { toolEvidence: "available" }
    : binaryOnly
      ? { toolEvidence: "unavailable", reason: "The run-as-binary protocol carries no tool events; only process and claim evidence exists." }
      : ordered.length === 0
        ? { toolEvidence: "unavailable", reason: "No evidence sources were found for this task." }
        : { toolEvidence: "unavailable", reason: `No tool call/result records were found in the available sources${inspectedAdapters.length > 0 ? ` (${inspectedAdapters.join(", ")})` : ""}.` };

  const recordsOmitted = ordered.reduce((sum, source) => sum + (source.stats.recordsOmitted ?? 0), 0);
  const diagnostics: SubtaskEvidenceDiagnostics = {
    recordsScanned: ordered.reduce((sum, source) => sum + source.stats.recordsScanned, 0),
    oversizedRecords: ordered.reduce((sum, source) => sum + source.stats.oversizedRecords, 0),
    skippedRecords: ordered.reduce((sum, source) => sum + source.stats.skippedRecords, 0),
    ...(recordsOmitted > 0 ? { recordsOmitted } : {}),
    ...(entryCapReached ? { entryCapReached: true } : {}),
    ...(contentRetentionExhausted ? { contentRetentionExhausted: true } : {}),
    ...(rawBudget?.exhausted ? { rawRetentionExhausted: true } : {}),
  };

  // Merge per-source diagnostics with discovery-level unavailable notes,
  // de-duplicated (the controller pre-validates the artifact root before the
  // facade does, which can produce identical notes).
  const seenNotes = new Set<string>();
  const allUnavailable = [...unavailable, ...ordered.flatMap((source) => source.unavailable)].filter((note) => {
    const key = `${note.source ?? ""}|${note.reason}|${note.detail}`;
    if (seenNotes.has(key)) return false;
    seenNotes.add(key);
    return true;
  });

  return {
    taskId,
    totalEntries: entries.length,
    sources: sourcesSummary,
    unavailable: allUnavailable,
    capability,
    diagnostics,
    contentByEntryId,
    digestByEntryId,
    entries,
  };
}
