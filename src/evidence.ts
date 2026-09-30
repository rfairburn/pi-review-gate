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
  /** Bounded monotonic count of external-path observations; not a verified diff. */
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
  const extracted = extractCandidatePaths(input.toolName, boundedInput);
  const root = resolve(input.selectedRoot);
  const observedExternal = extracted.paths.some(({ path }) => {
    const expanded = expandHomePath(path);
    const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(input.cwd, expanded);
    return isOutsidePath(absolutePath, root);
  });
  if (observedExternal) {
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
      ? summarizeToolInput(input.toolName, boundedInput)
      : summarizeToolResult(boundedResult, input.isError),
    detail: input.stage === "start"
      ? detailedToolInput(input.toolName, boundedInput)
      : detailedToolResult(boundedResult),
    candidatePaths,
    riskSignals: unique([...extracted.riskSignals, ...(input.isError && input.stage === "end" ? ["tool_result_error"] : [])]),
    ...(input.stage === "end" ? { isError: input.isError } : {}),
  };
  input.state.events.push(event);

  for (const candidate of observedPaths) {
    const expanded = expandHomePath(candidate.path);
    const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(input.cwd, expanded);
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
    const shellPaths = extractShellCandidatePaths(command);
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

function extractShellCandidatePaths(command: string): { paths: string[]; riskSignals: string[] } {
  const paths: string[] = [];
  const riskSignals: string[] = [];

  const redirectionPattern = /(?:^|[\s;])(?:[0-9]?>|>>|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/g;
  for (const match of command.matchAll(redirectionPattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path) {
      // Redirecting output at the null sink is an output drop, not a real
      // write target; the redirection itself stays a recorded risk signal.
      if (!isNullSinkCandidatePath(path)) paths.push(path);
      riskSignals.push("shell_redirection");
    }
  }

  const appendHerePattern = /(?:^|[\s;])tee\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/g;
  for (const match of command.matchAll(appendHerePattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && !path.startsWith("-")) {
      // A tee into the null sink only drops its copy of the stream; the
      // tee write itself stays a recorded risk signal.
      if (!isNullSinkCandidatePath(path)) paths.push(path);
      riskSignals.push("tee_write");
    }
  }

  for (const tool of ["touch", "rm", "mkdir"]) {
    const pattern = new RegExp(`(?:^|[\\s;])${tool}\\s+(?:-[a-zA-Z]+\\s+)*(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))`, "g");
    for (const match of command.matchAll(pattern)) {
      const path = match[1] ?? match[2] ?? match[3];
      if (path) {
        paths.push(path);
        riskSignals.push(`shell_${tool}`);
      }
    }
  }

  for (const tool of ["cp", "mv"]) {
    const pattern = new RegExp(`(?:^|[\\s;])${tool}\\s+(?:-[a-zA-Z]+\\s+)*(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))\\s+(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))`, "g");
    for (const match of command.matchAll(pattern)) {
      const source = match[1] ?? match[2] ?? match[3];
      const dest = match[4] ?? match[5] ?? match[6];
      if (source && tool === "mv") {
        paths.push(source);
      }
      if (dest) {
        paths.push(dest);
      }
      riskSignals.push(`shell_${tool}`);
    }
  }

  if (/\b(?:sed|perl)\b[^|;&]*\s-(?:[a-zA-Z]*i|[a-zA-Z]*p[a-zA-Z]*i)\b/.test(command)) {
    riskSignals.push("in_place_shell_edit");
  }
  if (/<<\s*['"]?[A-Za-z0-9_.-]+['"]?/.test(command)) {
    riskSignals.push("heredoc");
  }

  return {
    paths: unique(paths.filter(isUsefulPathToken)),
    riskSignals: unique(riskSignals),
  };
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

function summarizeToolInput(toolName: string, input?: Record<string, unknown>): string {
  if (!input) {
    return "(no input captured)";
  }
  const command = commandText(input);
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

function detailedToolInput(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) {
    return undefined;
  }
  const command = commandText(input);
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

function boundObservedInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const redacted = redactLargeValues(redactBrowserToolInput("executor", input)) as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "chars", "patch"]) {
    const value = input[key];
    if (typeof value === "string") redacted[key] = truncate(redactSensitiveText(value), 20_000);
  }
  for (const key of ["path", "file_path", "filePath", "target", "dest", "destination"]) {
    const value = input[key];
    if (typeof value === "string") redacted[key] = truncate(redactSensitiveText(value), MAX_OBSERVED_PATH_LENGTH);
  }
  for (const key of ["paths", "files"]) {
    const value = input[key];
    if (Array.isArray(value)) {
      redacted[key] = value.slice(0, MAX_OBSERVED_TOOL_EVENTS / 2).map((item) =>
        typeof item === "string" ? truncate(redactSensitiveText(item), MAX_OBSERVED_PATH_LENGTH) : redactLargeValues(item));
    }
  }
  return redacted;
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
