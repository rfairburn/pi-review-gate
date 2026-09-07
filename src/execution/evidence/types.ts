/**
 * Shared types and budgets for bounded subtask evidence inspection (#33).
 *
 * Evidence is read-only, indexed navigation over a task's durable artifacts.
 * Privacy contract: private model reasoning (Pi/Claude `thinking` blocks,
 * Codex `reasoning` items, stream thinking deltas) is excluded in every path —
 * indexing, search, snippets, and deep reads. All retained content is redacted
 * with redactSensitiveText before it is stored, searched, or displayed.
 * Provenance separates what the executor observed (streams), what the worker
 * claims (final responses — never treated as verification), and what reviewers
 * decided (review reports). Authoritative task state comes from durable
 * records, not from any of these streams.
 */

/** Default entries per evidence read. */
export const EVIDENCE_LIMIT_DEFAULT = 20;
/** Hard cap for one evidence read. */
export const EVIDENCE_LIMIT_MAX = 50;
/** Maximum matches returned by one find; the total is still reported. */
export const EVIDENCE_FIND_MATCHES_MAX = 20;
/** Preview length for every entry view (redacted, whitespace-compacted). */
export const EVIDENCE_PREVIEW_CHARS = 400;
/** Deep-read chunk size in characters. */
export const EVIDENCE_DEEP_CHUNK_CHARS = 8_000;
/** Retained redacted content per entry, in bytes. */
export const EVIDENCE_ENTRY_CONTENT_BYTES = 256 * 1024;
/** Global retained-content budget across one snapshot, in bytes. */
export const EVIDENCE_TOTAL_CONTENT_BYTES = 8 * 1024 * 1024;
/** Maximum indexed sources per task snapshot. */
export const EVIDENCE_MAX_SOURCES = 32;
/** Maximum indexed entries per task snapshot. */
export const EVIDENCE_MAX_ENTRIES = 2_000;
/** Maximum bytes scanned from one source file per read. */
export const EVIDENCE_SCAN_BYTES_PER_SOURCE = 32 * 1024 * 1024;
/** Maximum directory entries enumerated per artifact subdirectory during discovery. */
export const EVIDENCE_MAX_ENUMERATED_ENTRIES = 1_024;
/** Bounded size for the operation record used as evidence context. */
export const EVIDENCE_OPERATION_CONTEXT_BYTES = 1024 * 1024;
/** Total raw (pre-redaction) record content retained while assembling. */
export const EVIDENCE_RAW_SNAPSHOT_BUDGET_BYTES = 16 * 1024 * 1024;
/** Raw record content cap applied before redaction, in bytes. */
export const EVIDENCE_RAW_RECORD_CONTENT_BYTES = 128 * 1024;
/** Bounded size for one durable review cycle record, in bytes (#50). */
export const EVIDENCE_REVIEW_RECORD_BYTES = 256 * 1024;

export type SubtaskEvidenceKind = "tool_call" | "tool_result" | "process" | "claim" | "review" | "lifecycle";
export type SubtaskEvidenceStatus = "in_flight" | "returned" | "succeeded" | "failed" | "unknown";
export type SubtaskEvidenceProvenance = "executor_observed" | "worker_claim" | "reviewer_verdict";
export type SubtaskEvidenceStream = "session" | "stdout" | "artifact" | "result";

/** Navigation filters. `command` matches command-execution tool calls/results. */
export const EVIDENCE_FILTERS = ["tool_call", "tool_result", "command", "lifecycle", "claim", "review"] as const;
export type SubtaskEvidenceFilter = typeof EVIDENCE_FILTERS[number];

/** Tool names treated as command executions by the `command` filter. */
export const EVIDENCE_COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "sh",
  "command_execution",
  "bash_execution",
]);

export type SubtaskEvidenceUnavailableReason =
  | "artifact_dir_missing"
  | "review_unavailable"
  | "unpublished"
  | "unreadable"
  | "unsupported_adapter"
  | "missing_stream"
  | "oversized_records"
  | "torn_tail"
  | "scan_budget"
  | "source_budget"
  | "records_omitted"
  | "retention_budget"
  | "path_escape"
  | "non_regular_file";

export interface SubtaskEvidenceUnavailable {
  source?: string;
  reason: SubtaskEvidenceUnavailableReason;
  detail: string;
}

/** Navigation selector for one evidence read (mutually exclusive with legacy activity offset/lines). */
export interface SubtaskEvidenceSelector {
  /** Case-insensitive search across indexed redacted content. No cursor is issued for find reads. */
  find?: string;
  /** Start position for a ranged read (within the filtered sequence when filter is set). */
  index?: number;
  /** Entries per read (1..EVIDENCE_LIMIT_MAX, default EVIDENCE_LIMIT_DEFAULT). */
  limit?: number;
  /** Opaque cursor from a prior unfiltered evidence read; returns only newer entries. */
  cursor?: string;
  /** Read one tool call and its linked result by pairing id. */
  callId?: string;
  /** Restrict navigation to one evidence category. */
  filter?: SubtaskEvidenceFilter;
  /** Deep-read one entry's retained content in bounded chunks. */
  entryId?: string;
  /** Chunk number for an entryId deep read (continuation). */
  chunkIndex?: number;
}

export interface SubtaskEvidenceSourceRef {
  sourceId: string;
  adapter: string;
  stream: SubtaskEvidenceStream;
  /** Path relative to the task artifact directory. */
  file?: string;
  recordKey?: string;
}

export interface SubtaskEvidenceEntryView {
  index: number;
  entryId: string;
  at?: string;
  kind: SubtaskEvidenceKind;
  callId?: string;
  toolName?: string;
  status?: SubtaskEvidenceStatus;
  provenance: SubtaskEvidenceProvenance;
  preview: string;
  /** Retained redacted bytes available for a deep read. */
  contentBytes: number;
  /** True when the source record exceeded a retention cap. */
  truncatedContent?: boolean;
  pairedWith?: string;
  source: SubtaskEvidenceSourceRef;
}

export interface SubtaskEvidenceSourceSummary {
  sourceId: string;
  adapter: string;
  stream: SubtaskEvidenceStream;
  file?: string;
  records: number;
  firstAt?: string;
  lastAt?: string;
}

export interface SubtaskEvidenceCapability {
  toolEvidence: "available" | "unavailable";
  reason?: string;
}

export interface SubtaskEvidenceDiagnostics {
  recordsScanned: number;
  oversizedRecords: number;
  skippedRecords: number;
  /** Records omitted by per-source rolling windows or the shared raw retention budget. */
  recordsOmitted?: number;
  entryCapReached?: boolean;
  contentRetentionExhausted?: boolean;
  /** The shared pre-redaction raw retention budget was exhausted during discovery. */
  rawRetentionExhausted?: boolean;
}

/**
 * One assembled task snapshot. `contentByEntryId` and `digestByEntryId` are
 * internal retention maps (never serialized into reads).
 */
export interface SubtaskEvidenceSnapshot {
  taskId: string;
  totalEntries: number;
  sources: SubtaskEvidenceSourceSummary[];
  unavailable: SubtaskEvidenceUnavailable[];
  capability: SubtaskEvidenceCapability;
  diagnostics: SubtaskEvidenceDiagnostics;
  contentByEntryId: Map<string, string>;
  digestByEntryId: Map<string, string>;
  /** Ordered entry views for navigation. */
  entries: SubtaskEvidenceEntryView[];
}

export interface SubtaskEvidenceAssignmentRecord {
  at: string;
  reason: "initial" | "failover" | "continuation";
  adapter?: string;
  model?: string;
  entryId?: string;
  outcome?: string;
}

export interface SubtaskEvidenceAttemptRecord {
  attempt: number;
  turn: number;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  sessionId?: string;
}

export interface SubtaskEvidenceCommandRecord {
  instructionId: string;
  action: string;
  actor: string;
  status: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface SubtaskEvidenceChangedFiles {
  landingStatus: "unlanded" | "landed" | "conflicted" | "unknown";
  trackedPaths: string[];
  untrackedPaths?: string[];
  note: string;
}

export interface SubtaskEvidenceReviewSummary {
  aggregate: string;
  cycles: number;
  latestSequence: number;
  reviewers: Array<{ reviewerId: string; verdict: string; summary: string }>;
  /** Set when a review cycle record could not be read or was never published and this summary may no longer be current. */
  caveat?: string;
}

export interface SubtaskEvidenceCurrentCommand {
  entryId: string;
  preview: string;
  callId?: string;
  toolName?: string;
  startedAt?: string;
  elapsedMs?: number;
  resultObserved: false;
}

/** Authoritative context rendered with every evidence read. */
export interface SubtaskEvidenceContext {
  state?: string;
  assignment?: {
    current?: { adapter?: string; model?: string };
    history: SubtaskEvidenceAssignmentRecord[];
  };
  attempts?: SubtaskEvidenceAttemptRecord[];
  steering?: SubtaskEvidenceCommandRecord[];
  changedFiles?: SubtaskEvidenceChangedFiles;
  review?: SubtaskEvidenceReviewSummary;
  currentCommand?: SubtaskEvidenceCurrentCommand;
}

export interface SubtaskEvidenceRead {
  taskId: string;
  mode: "range" | "find" | "call" | "entry" | "cursor";
  snapshot: {
    totalEntries: number;
    sources: SubtaskEvidenceSourceSummary[];
    unavailable: SubtaskEvidenceUnavailable[];
    capability: SubtaskEvidenceCapability;
    diagnostics: SubtaskEvidenceDiagnostics;
  };
  context?: SubtaskEvidenceContext;
  entries?: SubtaskEvidenceEntryView[];
  nextIndex?: number;
  matches?: Array<{ index: number; entryId: string; kind: SubtaskEvidenceKind; snippet: string }>;
  matchSummary?: { query: string; totalMatches: number; matchesTruncated: boolean };
  deepContent?: {
    entryId: string;
    chunkIndex: number;
    content: string;
    hasMore: boolean;
    nextChunk?: number;
    contentBytes: number;
    truncatedContent?: boolean;
    note?: string;
  };
  callPair?: { call?: SubtaskEvidenceEntryView; result?: SubtaskEvidenceEntryView; status: "in_flight" | "returned" };
  /** Cursor positioned after the last entry returned by this read (unfiltered range/cursor reads only). */
  cursor?: string;
}

/** Parsed record produced by adapter parsers, before redaction and pairing. */
export interface RawEvidenceRecord {
  recordKey: string;
  /** True when the source record exceeded the raw retention cap before redaction. */
  truncatedSource?: boolean;
  at?: string;
  kind: SubtaskEvidenceKind;
  callId?: string;
  toolName?: string;
  status?: SubtaskEvidenceStatus;
  provenance: SubtaskEvidenceProvenance;
  content: string;
  pairedWith?: string;
}

/** Shared pre-redaction raw retention budget threaded through discovery. */
export interface RawRetentionBudget {
  remainingBytes: number;
  exhausted: boolean;
}

/** A parsed, bounded source of evidence records. */
export interface IndexedSource {
  sourceId: string;
  adapter: string;
  stream: SubtaskEvidenceStream;
  file?: string;
  orderKey: string;
  records: RawEvidenceRecord[];
  /** sha256 of the raw source line/record, by recordKey (cursor validation). */
  digests: Map<string, string>;
  unavailable: SubtaskEvidenceUnavailable[];
  stats: { recordsScanned: number; oversizedRecords: number; skippedRecords: number; recordsOmitted?: number; budgetOmitted?: number };
}

export interface SubtaskEvidenceBundle {
  snapshot: SubtaskEvidenceSnapshot;
  context?: SubtaskEvidenceContext;
}
