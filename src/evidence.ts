import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  compareFileSnapshots,
  createPathSnapshot,
  type ChangedFile,
  type FileSnapshot,
  type SnapshotOptions,
} from "./capture";
import { extractEnvelopeCandidatePaths } from "./apply-patch/envelope";
import { expandHomePath } from "./apply-patch/paths";
import { normalizeApplyPatchPathMarker } from "./apply-patch/tool";
import { redactBrowserToolInput, redactSensitiveText, redactSensitiveValue } from "./redaction";

export interface EvidenceState {
  nextSequence: number;
  /** Bounded monotonic count of external or identity-unavailable observations; not a verified diff. */
  externalObservationRevision?: number;
  events: EvidenceEvent[];
  candidates: Map<string, EvidenceCandidate>;
  finalAssistantSummaries: string[];
  acceptedReviewerQuestions: AcceptedReviewerQuestion[];
  /** Adapter-specific limits on what tool activity this evidence can observe. */
  toolObservabilityNotes?: string[];
  toolObservationsTruncated?: boolean;
  /** Observed external tool writes must reach a reviewer even without an in-root delta. */
  requiresReview?: boolean;
}

export interface AcceptedReviewerQuestion {
  sequence: number;
  question: string;
  acceptedAnswer: string;
  acceptedAt: string;
}

export interface EvidenceEvent {
  sequence: number;
  exchangeSequence?: number;
  phase: "tool_call" | "tool_result";
  toolName: string;
  adapter?: string;
  observationId?: string;
  summary: string;
  detail?: string;
  candidatePaths: string[];
  riskSignals: string[];
  isError?: boolean;
}

export interface EvidenceCandidate {
  path: string;
  absolutePath: string;
  sources: string[];
  baseline?: FileSnapshot;
  baselineError?: string;
  /** The adapter stream is not a verified pre-execution acknowledgement. */
  prestateUnverified?: true;
  /** This candidate is outside the immutable selected-root snapshot. */
  externalSideEffect?: true;
  /** Bounded current observation only; never compared against a fabricated baseline. */
  afterSnapshot?: FileSnapshot;
  afterContentTruncated?: true;
  afterError?: string;
  exchangeBaselines: Map<number, { snapshot?: FileSnapshot; error?: string }>;
}

export interface EvidencePathRoots {
  selectedCwd: string;
  workspaceRoot: string;
}

export interface EvidenceBundle {
  events: EvidenceEvent[];
  candidates: Array<{
    path: string;
    absolutePath: string;
    sources: string[];
    baseline: "captured" | "missing" | "unreadable" | "error" | "unverified";
    baselineSnapshot?: FileSnapshot;
    externalSideEffect?: true;
    afterSnapshot?: FileSnapshot;
    afterContentTruncated?: true;
    afterError?: string;
  }>;
  finalAssistantSummaries: string[];
  acceptedReviewerQuestions: AcceptedReviewerQuestion[];
  toolObservabilityNotes: string[];
  toolObservationsTruncated: boolean;
  requiresReview: boolean;
  changedCandidatePaths: string[];
  markdown: string;
}

const TRANSIENT_DISCOVERY_TOOLS = new Set([
  "read", "grep", "glob", "find", "ls", "websearch", "webfetch", "browserscreenshot",
]);
const PATH_MUTATION_TOOLS = new Set(["write", "edit"]);
const APPLY_PATCH_TOOL = "applypatch";
/**
 * Native command-execution tools whose command text feeds candidate-path and
 * risk-signal extraction (#94). Pi's native `powershell` tool (Windows-only)
 * carries the same `command` input shape as `bash`, so it receives the
 * identical side-effect evidence treatment. ShellStart stays listed: it is
 * the extension's own background shell tool name.
 */
const SHELL_TOOLS = new Set(["bash", "powershell", "shellstart"]);

export function shouldRecordToolCallEvidence(toolName: string): boolean {
  return !TRANSIENT_DISCOVERY_TOOLS.has(normalizedToolName(toolName));
}

export function shouldRecordToolResultEvidence(toolName: string, isError: boolean | undefined): boolean {
  return Boolean(isError) || shouldRecordToolCallEvidence(toolName);
}

export function createEvidenceState(): EvidenceState {
  return {
    nextSequence: 1,
    externalObservationRevision: 0,
    events: [],
    candidates: new Map(),
    finalAssistantSummaries: [],
    acceptedReviewerQuestions: [],
    toolObservabilityNotes: [],
    toolObservationsTruncated: false,
    requiresReview: false,
  };
}

export interface PersistedEvidenceState {
  version: 1;
  nextSequence: number;
  externalObservationRevision?: number;
  events: EvidenceEvent[];
  candidates: Array<Omit<EvidenceCandidate, "exchangeBaselines">>;
  finalAssistantSummaries: string[];
  acceptedReviewerQuestions: AcceptedReviewerQuestion[];
  toolObservabilityNotes: string[];
  toolObservationsTruncated: boolean;
  requiresReview: boolean;
}

/** JSON-safe evidence checkpoint for durable in-place continuations. */
export function serializeEvidenceState(state: EvidenceState): PersistedEvidenceState {
  return {
    version: 1,
    nextSequence: state.nextSequence,
    externalObservationRevision: state.externalObservationRevision ?? 0,
    events: state.events.slice(-MAX_OBSERVED_TOOL_EVENTS),
    candidates: [...state.candidates.values()].map((candidate) => {
      const { exchangeBaselines, ...serialized } = candidate;
      void exchangeBaselines;
      return serialized;
    }),
    finalAssistantSummaries: state.finalAssistantSummaries.slice(-10),
    acceptedReviewerQuestions: state.acceptedReviewerQuestions.slice(-20),
    toolObservabilityNotes: state.toolObservabilityNotes ?? [],
    toolObservationsTruncated: state.toolObservationsTruncated === true,
    requiresReview: state.requiresReview === true,
  };
}

/** Restore bounded evidence without accepting paths inside the selected root. */
export function restoreEvidenceState(state: EvidenceState, value: unknown, selectedRoot: string): void {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.candidates)) {
    state.requiresReview = true;
    state.toolObservabilityNotes ??= [];
    state.toolObservabilityNotes.push("Persisted tool evidence was unreadable; prior observations are incomplete.");
    return;
  }
  const root = resolve(selectedRoot);
  const events = value.events.filter((event): event is EvidenceEvent => isRecord(event)
    && typeof event.sequence === "number"
    && Number.isSafeInteger(event.sequence)
    && (event.phase === "tool_call" || event.phase === "tool_result")
    && typeof event.toolName === "string"
    && (event.adapter === undefined || typeof event.adapter === "string")
    && (event.observationId === undefined || typeof event.observationId === "string")
    && typeof event.summary === "string"
    && (event.detail === undefined || typeof event.detail === "string")
    && Array.isArray(event.candidatePaths)
    && event.candidatePaths.every((path) => typeof path === "string")
    && Array.isArray(event.riskSignals)
    && event.riskSignals.every((signal) => typeof signal === "string")
    && (event.isError === undefined || typeof event.isError === "boolean"));
  state.events.push(...events.slice(0, MAX_OBSERVED_TOOL_EVENTS));
  if (events.length > MAX_OBSERVED_TOOL_EVENTS || events.length !== value.events.length) state.toolObservationsTruncated = true;
  state.nextSequence = Math.max(state.nextSequence, typeof value.nextSequence === "number" && Number.isSafeInteger(value.nextSequence) ? value.nextSequence : 1);
  if (value.externalObservationRevision !== undefined) {
    if (typeof value.externalObservationRevision === "number"
      && Number.isSafeInteger(value.externalObservationRevision)
      && value.externalObservationRevision >= 0) {
      state.externalObservationRevision = Math.max(state.externalObservationRevision ?? 0, value.externalObservationRevision);
    } else {
      state.toolObservationsTruncated = true;
      state.requiresReview = true;
    }
  }
  for (const candidate of value.candidates) {
    if (state.candidates.size >= MAX_OBSERVED_TOOL_EVENTS / 2) {
      state.toolObservationsTruncated = true;
      state.requiresReview = true;
      break;
    }
    if (!isRecord(candidate) || candidate.externalSideEffect !== true || typeof candidate.path !== "string" || typeof candidate.absolutePath !== "string") continue;
    if (candidate.absolutePath.length > MAX_OBSERVED_PATH_LENGTH) {
      state.toolObservationsTruncated = true;
      state.requiresReview = true;
      continue;
    }
    const absolutePath = resolve(candidate.absolutePath);
    if (!isAbsolute(candidate.absolutePath) || !isOutsidePath(absolutePath, root)) continue;
    const path = truncate(redactSensitiveText(candidate.path), MAX_OBSERVED_PATH_LENGTH);
    const existing = state.candidates.get(absolutePath);
    if (existing) {
      if (Array.isArray(candidate.sources)) existing.sources = unique([...existing.sources, ...candidate.sources.filter((source): source is string => typeof source === "string").slice(0, 20)]);
      existing.afterSnapshot ??= isRecord(candidate.afterSnapshot) ? candidate.afterSnapshot as unknown as FileSnapshot : undefined;
      if (candidate.afterContentTruncated === true) existing.afterContentTruncated = true;
      existing.afterError ??= typeof candidate.afterError === "string" ? truncate(redactSensitiveText(candidate.afterError), 500) : undefined;
      continue;
    }
    state.candidates.set(absolutePath, {
      path,
      absolutePath,
      sources: Array.isArray(candidate.sources) ? candidate.sources.filter((source): source is string => typeof source === "string").slice(0, 20) : ["persisted tool observation"],
      prestateUnverified: true,
      externalSideEffect: true,
      ...(isRecord(candidate.afterSnapshot) ? { afterSnapshot: candidate.afterSnapshot as unknown as FileSnapshot } : {}),
      ...(candidate.afterContentTruncated === true ? { afterContentTruncated: true as const } : {}),
      ...(typeof candidate.afterError === "string" ? { afterError: truncate(redactSensitiveText(candidate.afterError), 500) } : {}),
      exchangeBaselines: new Map(),
    });
  }
  if (Array.isArray(value.finalAssistantSummaries)) {
    state.finalAssistantSummaries.push(...value.finalAssistantSummaries.filter((item): item is string => typeof item === "string").slice(0, 10));
  }
  if (Array.isArray(value.acceptedReviewerQuestions)) {
    state.acceptedReviewerQuestions.push(...value.acceptedReviewerQuestions.filter((item): item is AcceptedReviewerQuestion => isRecord(item)
      && typeof item.sequence === "number"
      && Number.isSafeInteger(item.sequence)
      && typeof item.question === "string"
      && typeof item.acceptedAnswer === "string"
      && typeof item.acceptedAt === "string").slice(0, 20));
  }
  state.toolObservabilityNotes ??= [];
  if (Array.isArray(value.toolObservabilityNotes)) {
    state.toolObservabilityNotes = unique([...state.toolObservabilityNotes, ...value.toolObservabilityNotes.filter((item): item is string => typeof item === "string")])
      .slice(0, MAX_OBSERVABILITY_NOTES)
      .map((note) => truncate(redactSensitiveText(note), 1000));
  }
  state.toolObservationsTruncated ||= value.toolObservationsTruncated === true;
  state.requiresReview ||= value.requiresReview === true || state.candidates.size > 0 || state.toolObservationsTruncated;
}

const MAX_OBSERVED_TOOL_EVENTS = 200;
const MAX_OBSERVED_PATHS_PER_EVENT = 25;
const MAX_CANDIDATE_SOURCES = 20;
const MAX_OBSERVABILITY_NOTES = 20;
const MAX_OBSERVED_PATH_LENGTH = 2000;
const MAX_OBSERVED_CONTENT_CHARS = 20_000;
const MAX_EXTERNAL_OBSERVATION_REVISION = Number.MAX_SAFE_INTEGER;

/** Record an adapter's declared tool-event coverage without implying completeness. */
export function recordToolEventObservability(
  state: EvidenceState,
  adapter: string,
  input: { mode: "structured" | "unavailable"; description: string },
): void {
  const note = truncate(redactSensitiveText(`${adapter}: ${input.description}`), 1000);
  state.toolObservabilityNotes ??= [];
  if (!state.toolObservabilityNotes.includes(note) && state.toolObservabilityNotes.length < MAX_OBSERVABILITY_NOTES) {
    state.toolObservabilityNotes.push(note);
  }
}

/**
 * Record structured executor observations without taking a pre-event snapshot.
 * Parent-side stream delivery is not a reliable pre-write acknowledgement, so
 * candidate paths outside the selected-root snapshot retain an explicitly
 * unverified prior state and receive only a later, bounded after observation.
 */
export function recordObservedToolEventEvidence(input: {
  state: EvidenceState;
  cwd: string;
  selectedRoot: string;
  adapter: string;
  stage: "start" | "end";
  toolName: string;
  observationId?: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}): void {
  const boundedInput = boundObservedInput(input.toolInput);
  const inputDetail = detailedToolInput(input.toolName, boundedInput.displayInput, boundedInput.hasGenericData);
  // Generic fields can still overflow the serialized detail cap. Preserve the
  // existing display caps for fully retained raw commands/patches: clipping
  // their formatted display alone does not mean the exact identity was lost.
  if (boundedInput.hasGenericData && inputDetail?.endsWith("\n[... truncated ...]")) boundedInput.incomplete = true;
  if (boundedInput.incomplete) {
    input.state.toolObservationsTruncated = true;
    input.state.requiresReview = true;
    recordToolEventObservability(input.state, input.adapter, {
      mode: "structured",
      description: "Observed tool input evidence is incomplete: bounded fields, values, or nested data were omitted, or unsupported data/reflection was unavailable. Retained arguments are not a complete account of external scope.",
    });
  }
  // Parse only transient, bounded raw identities, never display-redacted text
  // or a clipped command/patch whose last token could name a different file.
  const extracted = extractCandidatePaths(input.toolName, boundedInput.input);
  if (boundedInput.identitiesUnavailable) {
    input.state.toolObservationsTruncated = true;
    input.state.requiresReview = true;
    recordToolEventObservability(input.state, input.adapter, {
      mode: "structured",
      description: "Observed path after-state unavailable: tool input exceeded bounded identity retention. Omitted command, patch, path, or collection entries cannot identify original files. No substitute address was read.",
    });
  }
  const root = resolve(input.selectedRoot);
  const observedExternal = extracted.paths.some(({ path }) => {
    const expanded = expandHomePath(path);
    const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(input.cwd, expanded);
    return isOutsidePath(absolutePath, root);
  });
  // Omitted identities may be external. Every such observation must invalidate
  // a prior pass/no-progress comparison, even after the event window fills.
  if (observedExternal || boundedInput.identitiesUnavailable || boundedInput.incomplete) {
    const revision = input.state.externalObservationRevision ?? 0;
    if (revision < MAX_EXTERNAL_OBSERVATION_REVISION) input.state.externalObservationRevision = revision + 1;
    else input.state.toolObservationsTruncated = true;
  }
  if (input.state.events.filter((event) => event.adapter !== undefined).length >= MAX_OBSERVED_TOOL_EVENTS) {
    input.state.toolObservationsTruncated = true;
    input.state.requiresReview = true;
    return;
  }

  const boundedResult = redactLargeValues(redactSensitiveValue(input.result));
  const observedPaths = extracted.paths.slice(0, MAX_OBSERVED_PATHS_PER_EVENT);
  if (extracted.paths.length > observedPaths.length) {
    input.state.toolObservationsTruncated = true;
    input.state.requiresReview = true;
  }
  const candidatePaths = unique(observedPaths.map(({ path }) => truncate(redactSensitiveText(path), MAX_OBSERVED_PATH_LENGTH)));
  const event: EvidenceEvent = {
    sequence: input.state.nextSequence++,
    phase: input.stage === "start" ? "tool_call" : "tool_result",
    toolName: truncate(redactSensitiveText(input.toolName || "unknown"), 200),
    adapter: truncate(redactSensitiveText(input.adapter), 100),
    ...(input.observationId ? { observationId: truncate(redactSensitiveText(input.observationId), 200) } : {}),
    summary: input.stage === "start"
      ? summarizeToolInput(input.toolName, boundedInput.displayInput, boundedInput.hasGenericData)
      : summarizeToolResult(boundedResult, input.isError),
    detail: input.stage === "start"
      ? inputDetail
      : detailedToolResult(boundedResult),
    candidatePaths,
    riskSignals: unique([...extracted.riskSignals, ...(input.isError && input.stage === "end" ? ["tool_result_error"] : [])]),
    ...(input.stage === "end" ? { isError: input.isError } : {}),
  };
  input.state.events.push(event);

  for (const candidate of observedPaths) {
    const expanded = expandHomePath(candidate.path);
    const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(input.cwd, expanded);
    if (!isObservablePathAddress(candidate.path) || !isObservablePathAddress(absolutePath)) {
      input.state.toolObservationsTruncated = true;
      input.state.requiresReview = true;
      recordToolEventObservability(input.state, input.adapter, {
        mode: "structured",
        description: "Observed path after-state unavailable: a redacted, truncated, or marker-bearing address cannot identify the original file. No substitute address was read.",
      });
      continue;
    }
    const rootRelative = relative(root, absolutePath);
    const isOutside = !isWithinRoot(rootRelative) || rootRelative === "";
    if (!isOutside) continue;

    const key = absolutePath;
    const existing = input.state.candidates.get(key);
    if (!existing && [...input.state.candidates.values()].filter((candidatePath) => candidatePath.externalSideEffect).length >= MAX_OBSERVED_TOOL_EVENTS / 2) {
      input.state.toolObservationsTruncated = true;
      input.state.requiresReview = true;
      continue;
    }
    const evidence = existing ?? {
      path: candidate.path,
      absolutePath,
      sources: [],
      prestateUnverified: true as const,
      externalSideEffect: true as const,
      exchangeBaselines: new Map<number, { snapshot?: FileSnapshot; error?: string }>(),
    };
    const source = truncate(redactSensitiveText(candidate.source), 300);
    if (!evidence.sources.includes(source) && evidence.sources.length < MAX_CANDIDATE_SOURCES) evidence.sources.push(source);
    else if (!evidence.sources.includes(source)) input.state.toolObservationsTruncated = true;
    input.state.candidates.set(key, evidence);
    input.state.requiresReview = true;
  }
}

/** Capture exact candidate paths only after the executor turn; never infer a diff from this snapshot. */
export async function captureObservedToolPathAfterStates(
  state: EvidenceState,
  selectedRoot: string,
  snapshotOptions: SnapshotOptions,
): Promise<void> {
  let remainingBytes = snapshotOptions.maxSnapshotBytes;
  for (const evidence of state.candidates.values()) {
    if (!evidence.externalSideEffect) continue;
    // Also fence restored observations: old retained marker strings are not
    // filesystem identities, even when a same-named decoy happens to exist.
    if (!isObservablePathAddress(evidence.path) || !isObservablePathAddress(evidence.absolutePath)) {
      evidence.afterError = "Observed path after-state unavailable: original address was not retained unchanged.";
      delete evidence.afterSnapshot;
      delete evidence.afterContentTruncated;
      state.toolObservationsTruncated = true;
      state.requiresReview = true;
      continue;
    }
    try {
      const snapshot = await createPathSnapshot(selectedRoot, evidence.absolutePath, {
        ...snapshotOptions,
        maxFileBytes: Math.min(snapshotOptions.maxFileBytes, Math.max(0, remainingBytes)),
        maxSnapshotBytes: Math.max(0, remainingBytes),
        captureOutsideWorkspaceContent: true,
      });
      let content = snapshot.content === undefined ? undefined : redactSensitiveText(snapshot.content);
      const contentTruncated = content !== undefined && content.length > MAX_OBSERVED_CONTENT_CHARS;
      if (contentTruncated) content = `${content!.slice(0, MAX_OBSERVED_CONTENT_CHARS)}\n[... truncated ...]`;
      if (snapshot.content !== undefined) remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(snapshot.content, "utf8"));
      evidence.afterSnapshot = {
        ...snapshot,
        ...(snapshot.linkTarget !== undefined ? { linkTarget: truncate(redactSensitiveText(snapshot.linkTarget), MAX_OBSERVED_CONTENT_CHARS) } : {}),
        ...(content !== undefined ? { content } : {}),
      };
      if (contentTruncated) evidence.afterContentTruncated = true;
      else delete evidence.afterContentTruncated;
      delete evidence.afterError;
    } catch (error) {
      evidence.afterError = truncate(redactSensitiveText(error instanceof Error ? error.message : String(error)), 500);
      delete evidence.afterSnapshot;
      delete evidence.afterContentTruncated;
    }
  }
}

export function recordAcceptedReviewerQuestion(
  state: EvidenceState,
  input: { question: string; acceptedAnswer: string; acceptedAt?: string },
): AcceptedReviewerQuestion {
  const entry: AcceptedReviewerQuestion = {
    sequence: state.acceptedReviewerQuestions.length + 1,
    question: input.question.trim(),
    acceptedAnswer: input.acceptedAnswer.trim(),
    acceptedAt: input.acceptedAt ?? new Date().toISOString(),
  };
  state.acceptedReviewerQuestions.push(entry);
  return entry;
}

export async function recordToolCallEvidence(input: {
  state: EvidenceState;
  cwd: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  snapshotOptions: SnapshotOptions;
  exchangeSequence?: number;
}): Promise<void> {
  const extracted = extractCandidatePaths(input.toolName, input.toolInput);
  const candidatePaths: string[] = [];

  for (const candidate of extracted.paths) {
    candidatePaths.push(candidate.path);
    await addCandidate(
      input.state,
      input.cwd,
      candidate.path,
      candidate.source,
      input.snapshotOptions,
      input.exchangeSequence,
    );
  }

  input.state.events.push({
    sequence: input.state.nextSequence++,
    exchangeSequence: input.exchangeSequence,
    phase: "tool_call",
    toolName: input.toolName || "unknown",
    summary: summarizeToolInput(input.toolName, input.toolInput),
    detail: detailedToolInput(input.toolName, input.toolInput),
    candidatePaths: unique(candidatePaths),
    riskSignals: extracted.riskSignals,
  });
}

export function recordToolResultEvidence(input: {
  state: EvidenceState;
  toolName: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  exchangeSequence?: number;
}): void {
  const extracted = extractCandidatePaths(input.toolName, input.toolInput);
  input.state.events.push({
    sequence: input.state.nextSequence++,
    exchangeSequence: input.exchangeSequence,
    phase: "tool_result",
    toolName: input.toolName || "unknown",
    summary: summarizeToolResult(input.result, input.isError),
    detail: detailedToolResult(input.result),
    candidatePaths: unique(extracted.paths.map((candidate) => candidate.path)),
    riskSignals: input.isError ? ["tool_result_error"] : [],
    isError: input.isError,
  });
}

export async function collectEvidenceChanges(
  state: EvidenceState,
  cwd: string,
  snapshotOptions: SnapshotOptions,
  exchangeSequence?: number,
): Promise<ChangedFile[]> {
  const changes: ChangedFile[] = [];
  for (const candidate of state.candidates.values()) {
    const baseline = exchangeSequence === undefined
      ? candidate.baseline
      : candidate.exchangeBaselines.get(exchangeSequence)?.snapshot;
    if (!baseline) {
      continue;
    }
    const after = await createPathSnapshot(cwd, candidate.absolutePath, snapshotOptions).catch(() => undefined);
    if (!after) {
      continue;
    }
    const change = compareFileSnapshots(baseline, after);
    if (change) {
      changes.push(change);
    }
  }
  return changes;
}

export function buildEvidenceBundle(
  state: EvidenceState,
  changedCandidatePaths: string[],
  focus?: { events?: EvidenceEvent[]; finalAssistantSummaries?: string[] },
  pathRoots?: EvidencePathRoots,
): EvidenceBundle {
  const candidates = [...state.candidates.values()].map((candidate) => {
    const path = evidenceCandidatePath(candidate, pathRoots);
    const baselineSnapshot = candidate.baseline && path !== candidate.path
      ? { ...candidate.baseline, relativePath: path }
      : candidate.baseline;
    return {
      path: candidate.externalSideEffect ? redactSensitiveText(path) : path,
      absolutePath: candidate.externalSideEffect ? redactSensitiveText(candidate.absolutePath) : candidate.absolutePath,
      sources: candidate.sources,
      baseline: candidate.prestateUnverified
        ? "unverified" as const
        : candidate.baselineError
        ? "error" as const
        : candidate.baseline?.exists
          ? candidate.baseline.omittedReason === "unreadable"
            ? "unreadable" as const
            : "captured" as const
          : candidate.baseline?.omittedReason === "unreadable"
            ? "unreadable" as const
            : "missing" as const,
      baselineSnapshot,
      ...(candidate.externalSideEffect ? { externalSideEffect: true as const } : {}),
      ...(candidate.afterSnapshot ? {
        afterSnapshot: {
          ...candidate.afterSnapshot,
          absolutePath: redactSensitiveText(candidate.absolutePath),
          relativePath: redactSensitiveText(path),
          ...(candidate.afterSnapshot.content !== undefined ? { content: redactSensitiveText(candidate.afterSnapshot.content) } : {}),
          ...(candidate.afterSnapshot.linkTarget !== undefined ? { linkTarget: redactSensitiveText(candidate.afterSnapshot.linkTarget) } : {}),
        },
      } : {}),
      ...(candidate.afterContentTruncated ? { afterContentTruncated: true as const } : {}),
      ...(candidate.afterError ? { afterError: redactSensitiveText(candidate.afterError) } : {}),
    };
  });

  const bundle: Omit<EvidenceBundle, "markdown"> = {
    events: normalizeEvidenceEventPaths(focus?.events ?? state.events, pathRoots),
    candidates,
    finalAssistantSummaries: focus?.finalAssistantSummaries ?? state.finalAssistantSummaries,
    acceptedReviewerQuestions: state.acceptedReviewerQuestions,
    toolObservabilityNotes: [...(state.toolObservabilityNotes ?? [])],
    toolObservationsTruncated: state.toolObservationsTruncated === true,
    requiresReview: state.requiresReview === true,
    changedCandidatePaths,
  };

  return {
    ...bundle,
    markdown: renderEvidenceMarkdown(bundle),
  };
}

export function normalizeEvidenceEventPaths(events: readonly EvidenceEvent[], roots?: EvidencePathRoots): EvidenceEvent[] {
  if (!roots) return events.map((event) => ({ ...event, candidatePaths: [...event.candidatePaths] }));
  return events.map((event) => ({
    ...event,
    candidatePaths: event.candidatePaths.map((path) => evidenceEventPath(path, roots)),
  }));
}

function evidenceEventPath(path: string, roots: EvidencePathRoots): string {
  const expanded = expandHomePath(path);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(roots.selectedCwd, expanded);
  return workspaceRelativePath(absolute, roots.workspaceRoot) ?? path;
}

function evidenceCandidatePath(
  candidate: EvidenceCandidate,
  roots?: EvidencePathRoots,
): string {
  if (!roots) return candidate.path;
  if (candidate.externalSideEffect) return redactSensitiveText(candidate.absolutePath);
  return workspaceRelativePath(resolve(candidate.absolutePath), roots.workspaceRoot) ?? candidate.path;
}

function workspaceRelativePath(absolute: string, workspaceRoot: string): string | undefined {
  const workspaceRelative = relative(resolve(workspaceRoot), absolute);
  return isWithinRoot(workspaceRelative) && workspaceRelative !== ""
    ? workspaceRelative.split(sep).join("/")
    : undefined;
}

function isWithinRoot(path: string): boolean {
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function isOutsidePath(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || !isWithinRoot(relativePath);
}

export function rememberFinalAssistantSummary(state: EvidenceState, args: unknown[]): void {
  const summary = extractFinalAssistantText(args);
  rememberFinalAssistantSummaryText(state, summary);
}

/** Record a final response already extracted by an executor adapter. */
export function rememberFinalAssistantSummaryText(state: EvidenceState, summary: string): void {
  const normalized = summary.trim();
  if (!normalized) return;
  state.finalAssistantSummaries.push(truncate(redactSensitiveText(normalized), 4000));
}

export function extractCandidatePaths(
  toolName: string,
  input?: Record<string, unknown>,
): { paths: Array<{ path: string; source: string }>; riskSignals: string[] } {
  const paths: Array<{ path: string; source: string }> = [];
  const riskSignals: string[] = [];
  if (!input) {
    return { paths, riskSignals };
  }

  const normalizedName = normalizedToolName(toolName);

  if (PATH_MUTATION_TOOLS.has(normalizedName)) {
    // Writing directly to /dev/null drops output. Other mutation tools keep
    // the device path as a candidate rather than assuming a discard write.
    const omitSinkTarget = normalizedName === "write";
    for (const key of ["path", "file_path", "filePath", "target", "dest", "destination"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim() && !(omitSinkTarget && isNullSinkCandidatePath(value.trim()))) {
        paths.push({ path: value.trim(), source: `${toolName}:${key}` });
      }
    }

    for (const key of ["paths", "files"]) {
      const value = input[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim() && !(omitSinkTarget && isNullSinkCandidatePath(item.trim()))) {
            paths.push({ path: item.trim(), source: `${toolName}:${key}` });
          }
        }
      }
    }
  }

  if (normalizedName === APPLY_PATCH_TOOL) {
    // The canonical envelope carries every mutation target in its operation
    // headers; they are pre-captured as mutation candidates.
    const addCandidate = (value: string, source: string): void => {
      // Normalize the leading '@' convention marker exactly like the tool
      // does, so candidates point at the files ApplyPatch actually mutates.
      const normalized = normalizeApplyPatchPathMarker(value);
      if (normalized) {
        paths.push({ path: normalized, source });
        riskSignals.push("apply_patch_mutation");
      }
    };
    if (typeof input.patch === "string") {
      // Best-effort header scan so review evidence stays accurate even when
      // the request later fails validation.
      for (const candidate of extractEnvelopeCandidatePaths(input.patch)) {
        addCandidate(candidate.path, `${toolName}:patch`);
      }
    }
  }

  const command = commandText(input);
  if (command && SHELL_TOOLS.has(normalizedName)) {
    const shellPaths = extractShellCandidatePaths(command, normalizedName === "powershell"
      || (normalizedName === "shellstart" && process.platform === "win32"));
    paths.push(...shellPaths.paths.map((path) => ({ path, source: `${toolName}:command` })));
    riskSignals.push(...shellPaths.riskSignals);
  }

  return {
    paths: dedupePathSources(paths),
    riskSignals: unique(riskSignals),
  };
}

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

async function addCandidate(
  state: EvidenceState,
  cwd: string,
  path: string,
  source: string,
  snapshotOptions: SnapshotOptions,
  exchangeSequence?: number,
): Promise<void> {
  // Resolve candidates with the tool's own home-expansion rule so a `~/...`
  // envelope path pre-captures the file ApplyPatch actually mutates.
  const expanded = expandHomePath(path);
  const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const key = absolutePath;
  const existing = state.candidates.get(key);
  if (existing) {
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    await captureExchangeBaseline(existing, inputSnapshotArgs(cwd, absolutePath, snapshotOptions, exchangeSequence));
    return;
  }

  const candidate: EvidenceCandidate = {
    path,
    absolutePath,
    sources: [source],
    exchangeBaselines: new Map(),
  };
  try {
    candidate.baseline = await createPathSnapshot(cwd, absolutePath, snapshotOptions);
  } catch (error) {
    candidate.baselineError = error instanceof Error ? error.message : "snapshot_failed";
  }
  state.candidates.set(key, candidate);
  await captureExchangeBaseline(candidate, inputSnapshotArgs(cwd, absolutePath, snapshotOptions, exchangeSequence));
}

function inputSnapshotArgs(
  cwd: string,
  absolutePath: string,
  snapshotOptions: SnapshotOptions,
  exchangeSequence: number | undefined,
): { cwd: string; absolutePath: string; snapshotOptions: SnapshotOptions; exchangeSequence: number } | undefined {
  return exchangeSequence === undefined ? undefined : { cwd, absolutePath, snapshotOptions, exchangeSequence };
}

async function captureExchangeBaseline(
  candidate: EvidenceCandidate,
  input: { cwd: string; absolutePath: string; snapshotOptions: SnapshotOptions; exchangeSequence: number } | undefined,
): Promise<void> {
  if (!input || candidate.exchangeBaselines.has(input.exchangeSequence)) {
    return;
  }
  try {
    candidate.exchangeBaselines.set(input.exchangeSequence, {
      snapshot: await createPathSnapshot(input.cwd, input.absolutePath, input.snapshotOptions),
    });
  } catch (error) {
    candidate.exchangeBaselines.set(input.exchangeSequence, {
      error: error instanceof Error ? error.message : "snapshot_failed",
    });
  }
}

function extractShellCandidatePaths(command: string, powershell: boolean): { paths: string[]; riskSignals: string[] } {
  const paths: string[] = [];
  const riskSignals: string[] = [];
  const tokens = literalShellTokens(command, powershell);

  // Operators are separate tokens even when attached to a word. Quoted and
  // escaped data never supplies operators or additional executable words.
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.operator && [">", ">>", "&>", "&>>"].includes(token.text)) {
      riskSignals.push("shell_redirection");
      const target = tokens[index + 1];
      if (target?.literal && !target.operator && !isNullSinkCandidatePath(target.text)) paths.push(target.text);
    }
    if (token.operator && ["<<", "<<-"].includes(token.text)) riskSignals.push("heredoc");
  }

  let commandStart = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.operator) {
      if ([";", "\n", "|", "||", "&&", "&", "(", ")"].includes(token.text)) commandStart = true;
      else index++; // A redirection operand is data, not a command name.
      continue;
    }
    if (!commandStart) continue;
    // Literal POSIX assignments and reserved prefixes preserve command position;
    // quoted/escaped executable names do not.
    if (token.assignment || token.commandPrefix) continue;
    commandStart = false;
    if (!token.literal) continue;
    const tool = token.text;
    const args: ShellLiteralToken[] = [];
    for (let next = index + 1; next < tokens.length && !tokens[next]!.operator; next++) args.push(tokens[next]!);
    if (["sed", "perl"].includes(tool) && args.some((arg) => /^-[a-zA-Z]*i\b/.test(arg.text))) {
      riskSignals.push("in_place_shell_edit");
    }
    while (args[0]?.literal && /^-[a-zA-Z]+$/.test(args[0].text)) args.shift();
    const first = args[0];
    const second = args[1];
    if (["tee", "touch", "rm", "mkdir"].includes(tool) && first?.literal) {
      if (tool !== "tee" || !first.text.startsWith("-")) {
        if (tool !== "tee" || !isNullSinkCandidatePath(first.text)) paths.push(first.text);
        riskSignals.push(tool === "tee" ? "tee_write" : `shell_${tool}`);
      }
    }
    if (["cp", "mv"].includes(tool) && first?.literal && second?.literal) {
      if (tool === "mv") paths.push(first.text);
      paths.push(second.text);
      riskSignals.push(`shell_${tool}`);
    }
  }
  return { paths: unique(paths.filter(isUsefulPathToken)), riskSignals: unique(riskSignals) };
}

interface ShellLiteralToken {
  text: string;
  operator?: true;
  literal?: boolean;
  assignment?: true;
  commandPrefix?: true;
}

/** Local lexical handling for easy literal targets, not shell evaluation. No
 * expansion, dynamic cwd tracking, conditional execution, or shell-wrapper
 * interpretation is attempted. PowerShell keeps its literal path backslashes;
 * this small token scan is not a general PowerShell parser either. */
function literalShellTokens(command: string, powershell: boolean): ShellLiteralToken[] {
  const tokens: ShellLiteralToken[] = [];
  const escape = powershell ? "`" : "\\";
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let pendingHeredoc: string | undefined;
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "\n") {
      tokens.push({ text: "\n", operator: true });
      index++;
      // A simple heredoc body is data, even when it contains command-shaped
      // text. Do not run candidate matching over that body.
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (index < command.length) {
          const end = command.indexOf("\n", index);
          const line = command.slice(index, end < 0 ? undefined : end);
          index = end < 0 ? command.length : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
      continue;
    }
    if (/\s/.test(char)) { index++; continue; }
    if (char === "#") {
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end;
      continue;
    }
    // Unquoted digits adjoining a redirection identify its descriptor.
    const descriptor = !powershell && /^[0-9]+(?=[<>])/.exec(command.slice(index))?.[0];
    if (descriptor) {
      index += descriptor.length;
      continue;
    }
    const operator = /^(?:&>>|&>|>>|>&|<<<|<<-|<<|<&|&&|\|\||[<>;|&()])/.exec(command.slice(index))?.[0];
    if (operator) {
      tokens.push({ text: operator, operator: true });
      index += operator.length;
      pendingHeredoc = !powershell && ["<<", "<<-"].includes(operator) ? operator : undefined;
      continue;
    }
    // Check syntax before quote removal so 'NAME=value' and NA\\ME=value
    // cannot be mistaken for an unquoted assignment-name prefix.
    const assignment = !powershell && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(index));
    // Only unquoted, standalone reserved prefixes preserve command position.
    // The extractor checks this flag only while expecting a command name.
    const commandPrefix = !powershell && /^(?:\{|!)(?=$|[\s<>;|&()])/.test(command.slice(index));
    let text = "";
    let literal = true;
    while (index < command.length && !/[\s<>;|&()]/.test(command[index]!)) {
      const next = command[index++]!;
      if (next === "'" || next === '"') {
        const quote = next;
        let closed = false;
        while (index < command.length) {
          const quoted = command[index++]!;
          if (quoted === quote) {
            if (powershell && command[index] === quote) { text += quote; index++; continue; }
            closed = true;
            break;
          }
          if (quote === '"' && quoted === escape && index < command.length
            && (powershell || /[$`"\\\n]/.test(command[index]!))) {
            const escaped = command[index++]!;
            if (escaped !== "\n") text += escaped;
          } else {
            text += quoted;
            if (quote === '"' && (quoted === "$" || (!powershell && quoted === "`"))) literal = false;
          }
        }
        if (!closed) literal = false;
      } else if (next === escape && index < command.length) {
        const escaped = command[index++]!;
        if (escaped !== "\n") text += escaped;
      } else {
        text += next;
        if (/[$*?\[]/.test(next) || (!powershell && next === "`")) literal = false;
      }
    }
    tokens.push({
      text, literal,
      ...(assignment && literal ? { assignment: true as const } : {}),
      ...(commandPrefix && literal ? { commandPrefix: true as const } : {}),
    });
    if (pendingHeredoc) {
      if (literal) heredocs.push({ delimiter: text, stripTabs: pendingHeredoc === "<<-" });
      pendingHeredoc = undefined;
    }
  }
  return tokens;
}

/**
 * Whether a candidate path is the POSIX /dev/null discard sink. Callers apply
 * this only at discard-write extraction sites (shell output redirection, tee
 * writes, and the full-overwrite write tool), where the sink is a common
 * no-op output drop. Destructive or unknown operations — rm, mv, cp, touch,
 * mkdir, edit, and ApplyPatch envelope mutations — must keep the device as
 * an evidenced candidate, including inside mixed commands, because they can
 * delete, rename, replace, or alter it rather than write past it.
 *
 * Only the canonical absolute sink matches; it is compared against the same
 * normalized form the candidate machinery itself uses to key paths, and a
 * relative, task-rooted, or other-spelling lookalike still resolves to some
 * real path and keeps its evidence. On non-POSIX resolvers nothing can equal
 * the literal "/dev/null", so real (drive-qualified) paths and Windows NUL
 * keep their evidence too.
 */
function isNullSinkCandidatePath(path: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  return resolve(expandHomePath(path)) === "/dev/null";
}

function commandText(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "chars"]) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function summarizeToolInput(toolName: string, input?: Record<string, unknown>, includeAllFields = false): string {
  if (!input) {
    return "(no input captured)";
  }
  const command = includeAllFields ? "" : commandText(input);
  if (command) {
    return truncate(redactSensitiveText(command).replace(/\s+/g, " ").trim(), 1000);
  }
  const compact = JSON.stringify(redactLargeValues(redactBrowserToolInput(toolName, input)));
  return truncate(compact, 1000);
}

function summarizeToolResult(result: unknown, isError: boolean | undefined): string {
  const prefix = isError ? "error: " : "";
  if (typeof result === "string") {
    return prefix + truncate(redactSensitiveText(result).replace(/\s+/g, " ").trim(), 1000);
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      if (text) {
        return prefix + truncate(redactSensitiveText(text).replace(/\s+/g, " ").trim(), 1000);
      }
    }
  }
  return prefix + truncate(JSON.stringify(redactLargeValues(redactSensitiveValue(result))), 1000);
}

function detailedToolInput(toolName: string, input?: Record<string, unknown>, includeAllFields = false): string | undefined {
  if (!input) {
    return undefined;
  }
  const command = includeAllFields ? "" : commandText(input);
  if (command) {
    return truncate(redactSensitiveText(command), 20_000);
  }
  return truncate(JSON.stringify(redactBrowserToolInput(toolName, input), null, 2), 20_000);
}

function detailedToolResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return truncate(redactSensitiveText(result), 50_000);
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      if (text) {
        return truncate(redactSensitiveText(text), 50_000);
      }
    }
  }
  const encoded = JSON.stringify(redactSensitiveValue(result), null, 2);
  return encoded ? truncate(encoded, 50_000) : undefined;
}

function renderEvidenceMarkdown(bundle: Omit<EvidenceBundle, "markdown">): string {
  const lines: string[] = ["## Session Evidence", ""];

  if (bundle.finalAssistantSummaries.length > 0) {
    lines.push("### Agent final summaries", "");
    for (const [index, summary] of bundle.finalAssistantSummaries.entries()) {
      lines.push(`#### Summary ${index + 1}`, "", summary, "");
    }
  }

  if (bundle.acceptedReviewerQuestions.length > 0) {
    lines.push("### Accepted reviewer questions and answers", "");
    for (const entry of bundle.acceptedReviewerQuestions) {
      lines.push(
        `#### Accepted reviewer answer ${entry.sequence}`,
        "",
        `Question: ${entry.question}`,
        "",
        entry.acceptedAnswer,
        "",
      );
    }
  }

  const precapturedCandidates = bundle.candidates.filter((candidate) => !candidate.externalSideEffect);
  if (precapturedCandidates.length > 0) {
    lines.push("### Pre-captured candidate files");
    for (const candidate of precapturedCandidates) {
      lines.push(`- ${candidate.path} (${candidate.baseline}; ${candidate.sources.join(", ")})`);
    }
    lines.push("");
  }

  if (bundle.changedCandidatePaths.length > 0) {
    lines.push("### Evidence candidates changed");
    for (const path of bundle.changedCandidatePaths) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  if (bundle.toolObservabilityNotes.length > 0 || bundle.toolObservationsTruncated) {
    lines.push("### Executor tool-event observability limits");
    for (const note of bundle.toolObservabilityNotes) lines.push(`- ${note}`);
    if (bundle.toolObservationsTruncated) lines.push("- The bounded tool-event/path evidence limit was reached; additional observations were omitted. Review is required.");
    lines.push("- These adapter stream observations are not pre-execution acknowledgements. Missing events do not prove that no external action occurred.", "");
  }

  const externalCandidates = bundle.candidates.filter((candidate) => candidate.externalSideEffect);
  if (externalCandidates.length > 0) {
    lines.push("### Tool-observed external side-effect candidates");
    lines.push("These paths are outside the selected workspace and are evidence of tool-observed side effects, not in-root delta entries. Their prior state is unverified because parent stream delivery may race the child's mutation; no exact diff is claimed.");
    for (const candidate of externalCandidates) {
      lines.push(`- ${candidate.path} (prior state unverified; ${candidate.sources.join(", ")})`);
      if (candidate.afterSnapshot) {
        const after = candidate.afterSnapshot;
        lines.push(`  - Bounded current after-turn observation: ${after.exists ? `${after.entryType ?? "entry"}, ${after.size} byte(s), sha256=${after.sha256 ?? "unavailable"}` : "not present or not readable as a file"}${after.omittedReason ? `; content=${after.omittedReason}` : ""}.`);
        if (after.linkTarget !== undefined) lines.push(`  - Link target: ${after.linkTarget}`);
        if (after.content !== undefined) lines.push("  - Redacted after-content (not a diff):", "```text", after.content, "```");
        if (candidate.afterContentTruncated) lines.push("  - After-content preview truncated.");
      } else if (candidate.afterError) {
        lines.push(`  - After-turn observation unavailable: ${candidate.afterError}`);
      } else {
        lines.push("  - No after-turn snapshot was captured.");
      }
    }
    lines.push("");
  }

  if (bundle.events.length > 0) {
    lines.push("### Tool event digest");
    for (const event of bundle.events) {
      const risks = event.riskSignals.length > 0 ? ` risks=${event.riskSignals.join(",")}` : "";
      const paths = event.candidatePaths.length > 0 ? ` paths=${event.candidatePaths.join(",")}` : "";
      const observationId = event.observationId ? ` id=${event.observationId}` : "";
      lines.push(`- #${event.sequence} ${event.phase} ${event.adapter ? `${event.adapter}/` : ""}${event.toolName}${observationId}${event.isError ? " ERROR" : ""}${paths}${risks}: ${event.summary}`);
    }
  }

  return lines.join("\n");
}

function extractFinalAssistantText(args: unknown[]): string {
  for (const arg of args) {
    if (!isRecord(arg) || !Array.isArray(arg.messages)) {
      continue;
    }
    for (const message of [...arg.messages].reverse()) {
      if (!isRecord(message) || message.role !== "assistant") {
        continue;
      }
      const text = textFromContent(message.content);
      if (text.trim()) {
        return text.trim();
      }
    }
  }
  return "";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function redactLargeValues(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value, 500);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactLargeValues);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      result[key] = redactLargeValues(item);
    }
    return result;
  }
  return value;
}

function boundObservedInput(input: Record<string, unknown> | undefined): {
  input?: Record<string, unknown>;
  displayInput?: Record<string, unknown>;
  identitiesUnavailable: boolean;
  incomplete: boolean;
  hasGenericData: boolean;
} {
  if (!input) return { identitiesUnavailable: false, incomplete: false, hasGenericData: false };
  // Both projections are transient. Only redacted event text and the existing
  // candidate map persist; generic data never feeds filesystem extraction.
  const bounded: Record<string, unknown> = Object.create(null);
  const displayCollections: Record<string, unknown> = Object.create(null);
  const budget: ObservedDisplayBudget = { remaining: 1000, incomplete: false };
  let identitiesUnavailable = false;
  let hasGenericData = false;
  const readIdentity = (record: object, key: string): unknown => {
    const field = observedOwnData(record, key);
    if (field.unavailable) identitiesUnavailable = true;
    return field.value;
  };
  const retainIdentity = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    identitiesUnavailable = true;
    return ""; // Never turn a retained prefix into a filesystem address.
  };
  for (const key of ["command", "cmd", "script", "chars", "patch"]) {
    const field = observedOwnData(input, key);
    if (field.unavailable) {
      identitiesUnavailable = true;
      bounded[key] = ""; // Block fallthrough to an unselected command alias.
    } else if (typeof field.value === "string") {
      bounded[key] = retainIdentity(field.value, MAX_OBSERVED_CONTENT_CHARS);
    }
  }
  for (const key of ["path", "file_path", "filePath", "target", "dest", "destination"]) {
    const value = readIdentity(input, key);
    if (typeof value === "string") bounded[key] = retainIdentity(value, MAX_OBSERVED_PATH_LENGTH);
  }
  for (const key of ["paths", "files"]) {
    const value = readIdentity(input, key);
    try {
      if (!Array.isArray(value)) continue;
      const length = readIdentity(value, "length");
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        identitiesUnavailable = true;
        continue;
      }
      const limit = MAX_OBSERVED_TOOL_EVENTS / 2;
      if (length > limit) identitiesUnavailable = true;
      const retained: unknown[] = [];
      const display: unknown[] = [];
      for (let index = 0; index < Math.min(length, limit); index++) {
        const item = readIdentity(value, String(index));
        // Only exact strings can be identities, but ordinary nested JSON
        // entries still belong in the separate event display projection.
        if (item !== undefined && item !== null && typeof item !== "string") hasGenericData = true;
        const identity = typeof item === "string" ? retainIdentity(item, MAX_OBSERVED_PATH_LENGTH) : null;
        retained.push(identity);
        const projected = item === undefined ? null : typeof item === "string"
          ? identity : boundObservedDisplayValue(item, budget, 2);
        display.push(projected === "[... truncated ...]" ? null : projected);
      }
      bounded[key] = retained;
      displayCollections[key] = display;
    } catch {
      identitiesUnavailable = true; // e.g. a revoked array Proxy
    }
  }
  const projected = boundObservedDisplayValue(input, budget, 0, bounded);
  const displayInput: Record<string, unknown> = isRecord(projected) ? projected : Object.create(null);
  if (!isRecord(projected)) {
    // Reflection refusal must not lose the safely readable known fields (nor
    // invent completeness). No getters or raw iterators are invoked here.
    for (const key of ["content", "text", "edits", "oldText", "newText", "timeout", "timeoutMs", "cwd", "workdir", "label", "description", "metadata"]) {
      const field = observedOwnData(input, key);
      if (field.unavailable) displayInput[key] = omitObservedDisplay(budget);
      else if (field.value !== undefined) displayInput[key] = boundObservedDisplayValue(field.value, budget);
    }
  }
  hasGenericData ||= Object.keys(displayInput).some((key) => !Object.hasOwn(bounded, key));
  Object.assign(displayInput, bounded, displayCollections);
  return { input: bounded, displayInput, identitiesUnavailable, incomplete: budget.incomplete, hasGenericData };
}

interface ObservedDisplayBudget {
  remaining: number;
  incomplete: boolean;
}

/** Read own data only: accessors are unsupported, never executed. */
function observedOwnData(record: object, key: string): { value?: unknown; unavailable?: true } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return {};
    return "value" in descriptor ? { value: descriptor.value } : { unavailable: true };
  } catch {
    return { unavailable: true };
  }
}

function omitObservedDisplay(budget: ObservedDisplayBudget): string {
  budget.incomplete = true;
  return "[... truncated ...]";
}

/** Bound ordinary JSON data BEFORE recursive redaction, sharing a node budget
 * across the entire input. Reflection may allocate the object's key inventory;
 * JS has no streaming own-key API. Only the first 30 keys are inspected. */
function boundObservedDisplayValue(
  value: unknown,
  budget: ObservedDisplayBudget,
  depth = 0,
  identities?: Record<string, unknown>,
): unknown {
  if (budget.remaining-- <= 0) return omitObservedDisplay(budget);
  // Omit rather than expose a secret clipped mid-token.
  if (typeof value === "string") return value.length <= 500 ? value : omitObservedDisplay(budget);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (!isRecord(value) || depth >= 5) return omitObservedDisplay(budget);
  try {
    if (Array.isArray(value)) {
      const length = observedOwnData(value, "length").value;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return omitObservedDisplay(budget);
      if (length > 20) budget.incomplete = true;
      const retained: unknown[] = [];
      for (let index = 0; index < Math.min(length, 20); index++) {
        if (budget.remaining <= 0) { retained.push(omitObservedDisplay(budget)); break; }
        const field = observedOwnData(value, String(index));
        retained.push(field.unavailable || field.value === undefined
          ? omitObservedDisplay(budget)
          : boundObservedDisplayValue(field.value, budget, depth + 1));
      }
      return retained;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return omitObservedDisplay(budget);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 30) budget.incomplete = true;
    const retained: Record<string, unknown> = Object.create(null);
    for (const key of keys.slice(0, 30)) {
      if (budget.remaining <= 0) { budget.incomplete = true; break; }
      if (typeof key !== "string" || key.length > 500) { budget.incomplete = true; continue; }
      // Identity fields have independent exact-string/collection limits. Do
      // not clip them, mark valid 20k commands incomplete, or inspect twice.
      if (identities && Object.hasOwn(identities, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) { budget.incomplete = true; continue; }
      if (!descriptor.enumerable) continue;
      retained[key] = "value" in descriptor
        ? boundObservedDisplayValue(descriptor.value, budget, depth + 1)
        : omitObservedDisplay(budget);
    }
    return retained;
  } catch {
    return omitObservedDisplay(budget);
  }
}

function isObservablePathAddress(path: string): boolean {
  return path.length <= MAX_OBSERVED_PATH_LENGTH
    && redactSensitiveText(path) === path
    && !/\[(?:REDACTED|[^\]]*truncated[^\]]*)\]/i.test(path);
}

function isUsefulPathToken(path: string): boolean {
  if (!path || path === "-" || path.startsWith("$")) {
    return false;
  }
  return !/^[0-9]+$/.test(path);
}

function dedupePathSources(paths: Array<{ path: string; source: string }>): Array<{ path: string; source: string }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; source: string }> = [];
  for (const item of paths) {
    const key = `${item.source}\0${item.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[... truncated ...]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
