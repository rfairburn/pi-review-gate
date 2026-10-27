import { DEFAULT_EXECUTION_RETRY_POLICY, executorAgentFingerprint, type ReviewGateConfig } from "../../config";
import { compareFileSnapshots, createPathSnapshot, withoutSnapshotContent, type FileSnapshot, type SnapshotOptions } from "../../capture";
import { recordObservedToolEventEvidence, isObservablePathAddress, type EvidenceEvent, type EvidenceState } from "../../evidence";
import { expandHomePath } from "../../apply-patch/paths";
import { resolve } from "node:path";
import { isReviewableToolObservation } from "../../review-evidence";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorSession, ExecutorToolObservation, ExecutorTurn, SubtaskDispatchRecord, SubtaskProgressUpdate } from "../types";
import type { WaveWorkerTask } from "../wave-worker";
import type { ExecutorPoolAssignment } from "../executor-pool";
import {
  acquireOperationOwner,
  createIncident,
  recordOperationChildExit,
  recordOperationChildProcess,
  recordUnverifiedChildShutdown,
  releaseOperationOwner,
  touchOperationOwner,
  writeOperationRecord,
  type ExecutionAttemptRecord,
  type ExecutionIncident,
  type ExecutorAssignmentRecord,
  type OperationChildLifecycleIdentity,
  type OperationRecord,
} from "../operation-record";
import { resolveExecutorToolCatalog } from "../tool-catalog";
import type { InPlaceBasis } from "./basis";
import { computeRetryDelay } from "../retry-delay";

// ── executor turn loop (no checkpoints, fail closed) ─────────────────────────

export interface RecoveredInPlaceRun {
  status: "completed" | "failed" | "cancelled";
  turn?: ExecutorTurn;
  error?: string;
  lastTurnNumber: number;
  incidents: ExecutionIncident[];
  childProcesses: InPlaceChildProcessSettlement[];
  unmatchedChildExit: boolean;
}

interface InPlaceChildProcessSettlement {
  pid: number;
  processGroupId?: number;
  exitedAt?: string;
}

/** One reviewable observation offered to the caller's same-pass eligibility
 * classification. `paths` are the recorder's original usable spellings; they
 * are transient classification input and are never displayed or persisted. */
export interface InPlaceObservationActivity {
  event: EvidenceEvent;
  paths: string[];
  /** Present only when the same candidate identities had a captured boundary
   * change. Boundary delivery may race the child mutation, so this is
   * best-effort effect evidence, not a verified prestate, authorship proof, or
   * a diff. Incomplete or unpaired boundaries are simply not affirmative. */
  capturedEffect?: true;
}

/** Compare candidate observations from one operation's boundaries by normalized
 * absolute identity. Each matching identity is evaluated independently: an
 * unavailable, missing, or unpaired candidate contributes no evidence, but it
 * must not veto a known change to another candidate. Incomplete capture alone
 * still cannot fabricate activity. */
function boundaryChanged(
  pre: Map<string, FileSnapshot | undefined>, post: Map<string, FileSnapshot | undefined>,
): boolean {
  for (const [identity, before] of pre) {
    const after = post.get(identity);
    if (!before || !after || (before.exists && before.sha256 === null) || (after.exists && after.sha256 === null)) continue;
    if (compareFileSnapshots(before, after)) return true;
  }
  return false;
}

/** Local failure classifier for in-place turns: same taxonomy, no checkpoint stage. */
function classifyInPlaceFailure(
  turn: ExecutorTurn | undefined,
  thrown: unknown,
): { cause: ExecutionIncident["cause"]; stage: string; message: string } | undefined {
  if (turn === undefined && thrown === undefined) {
    return { cause: "protocol_error", stage: "adapter", message: "Executor returned no turn." };
  }
  if (thrown !== undefined) {
    if (thrown instanceof Error && thrown.name === "ExecutorLifecycleError") {
      const category = String((thrown as unknown as { category?: unknown }).category ?? "");
      return {
        cause: category === "compaction" ? "compaction_error" : category === "interruption" ? "interruption" : category === "protocol" ? "protocol_error" : "process_exit",
        stage: category === "compaction" ? "compacting" : "executor",
        message: thrown.message,
      };
    }
    return {
      cause: "exception",
      stage: "executor",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  if (!turn) return { cause: "protocol_error", stage: "adapter", message: "Executor returned no turn." };
  if (turn.timedOut) return { cause: "timeout", stage: "executor", message: "Executor timed out." };
  if (turn.failure) {
    return {
      cause: turn.failure.category === "interruption"
        ? "interruption"
        : turn.failure.category === "compaction"
          ? "compaction_error"
          : turn.failure.category === "provider"
            ? "provider_error"
            : turn.failure.category === "protocol"
              ? "protocol_error"
              : "process_exit",
      stage: turn.failure.category === "compaction" || turn.failure.category === "interruption" ? "compacting" : "executor",
      message: `Executor ${turn.failure.category} error: ${turn.failure.message}`,
    };
  }
  if (turn.aborted) return { cause: "interruption", stage: "executor", message: "Executor turn was interrupted." };
  if (turn.code !== 0) return { cause: "process_exit", stage: "executor", message: `Executor exited with status ${turn.code}.` };
  if (!turn.text.trim()) return { cause: "protocol_error", stage: "adapter", message: "Executor did not produce a usable final response." };
  return undefined;
}

export function inPlaceChildSettlementIsVerified(
  childProcesses: InPlaceChildProcessSettlement[],
  unmatchedChildExit: boolean,
): boolean {
  if (unmatchedChildExit) return false;
  for (const child of childProcesses) {
    if (child.exitedAt === undefined) return false;
    if (process.platform === "win32" || child.processGroupId === undefined) continue;
    try {
      process.kill(-child.processGroupId, 0);
      return false;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "ESRCH") return false;
    }
  }
  return true;
}

export function beginInPlaceAssignment(
  operation: OperationRecord,
  assignment: ExecutorPoolAssignment,
  reason: ExecutorAssignmentRecord["reason"],
  config: ReviewGateConfig,
): ExecutorAssignmentRecord {
  operation.executorEntryId = assignment.entry.entryId;
  operation.executorPriority = assignment.priority;
  operation.executorSelection = assignment.entry.selection;
  operation.executorAgentFingerprint = executorAgentFingerprint(config, assignment.entry.selection);
  const record: ExecutorAssignmentRecord = {
    entryId: assignment.entry.entryId,
    priority: assignment.priority,
    selection: assignment.entry.selection,
    generation: operation.generation,
    reason,
    startedAt: new Date().toISOString(),
  };
  operation.assignments.push(record);
  return record;
}

/**
 * Retry prompt for an in-place executor attempt. Truthful by construction:
 * there is no checkpoint, so prior attempts' workspace changes and external
 * side effects were already performed in place and were never rolled back.
 */
function inPlaceRetryPrompt(failureMessage: string, compaction: boolean): string {
  return [
    ...(compaction
      ? [
        "The previous executor turn was intentionally interrupted for context compaction.",
        "Resume this same task from the durable session summary and the current workspace state.",
        "Do not restart, revert, or repeat completed work. Continue from where the interrupted turn stopped.",
      ]
      : [
        "The previous executor attempt was interrupted by an infrastructure or provider failure.",
        "Continue the same task. The workspace — and any external side effects prior attempts performed — is as they left it: already-performed writes are NOT rolled back, inspected, or verified, so treat their state as unknown beyond what you can observe now.",
      ]),
    `Previous incident: ${failureMessage}`,
    "Do not discard or duplicate work you can already see completed. Finish the requested work, then provide the normal final summary.",
  ].join("\n");
}

/**
 * #533: fresh-session fallback for an in-place retry. When the recorded native
 * session cannot be reopened, the adapter delivers the full-task handoff
 * instead of the resumed retry text, so that handoff must carry exactly what
 * the resumed retry carried: this attempt's current retry instructions and
 * incident, on top of the unchanged caller handoff. In-place execution has no
 * checkpoint (nothing is invented here) and the workspace is the same one, so
 * the retry prose keeps its existing no-checkpoint, no-rollback wording.
 */
function inPlaceRetryHandoff(failureMessage: string, compaction: boolean, handoff: string): string {
  return [inPlaceRetryPrompt(failureMessage, compaction), "", handoff].join("\n");
}

async function inPlaceRetryDelay(
  base: number,
  max: number,
  jitter: boolean,
  retry: number,
  signal?: AbortSignal,
): Promise<void> {
  if (base === 0) return;
  const wait = computeRetryDelay(base, max, jitter, retry);
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("In-place retry cancelled."));
    };
    const timer = setTimeout(finish, wait);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Run one in-place executor turn (initial or continuation) with the existing
 * policy-driven same-adapter retries. There is deliberately no candidate
 * normalization, checkpoint, or landing; after retry recovery is exhausted,
 * the caller may fail over only after every child started during this assignment
 * is verified settled, and the replacement continues in this same workspace without
 * reset or rollback.
 */
export async function runInplaceTurnLoop(input: {
  adapter: ExecutorAdapter;
  evidence: EvidenceState;
  baseline: InPlaceBasis;
  workspaceRoot: string;
  artifactDir: string;
  config: ReviewGateConfig;
  task: WaveWorkerTask;
  taskId: string;
  prompt: string;
  /**
   * #533: the caller's full-task handoff for this run. The caller's `prompt`
   * can be continuation- or retry-only text that assumes the previous session's
   * task, acceptance criteria, acknowledged updates, and current instructions
   * are still in the executor's history. An adapter that cannot reopen that
   * native session delivers THIS prompt to its fresh session instead, so an
   * unverifiable session never leaves the worker with correction text and no
   * task. It is constant for the run and never carries prior-transcript replay.
   */
  handoffPrompt?: string;
  startingTurn: number;
  session?: ExecutorSession;
  signal?: AbortSignal;
  operation: OperationRecord;
  assignment: ExecutorPoolAssignment;
  onUpdate?: (update: SubtaskProgressUpdate) => void;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  /** Called once per observation the shared classification counts as reviewable work. */
  onQualifyingObservation?: (observation: InPlaceObservationActivity) => void;
  /** Same-pass confirmation narrows eligibility to reported operation effects,
   * so capture the canonical pre/post candidate observations at the tool-event
   * boundaries. Other windows keep their existing reviewable-call rule. */
  trackObservationEffects?: boolean;
}): Promise<RecoveredInPlaceRun> {
  const retryPolicy = input.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY;
  const incidents: ExecutionIncident[] = [];
  const repeated = new Map<string, number>();
  let genericRetries = 0;
  let compactionRecoveries = 0;
  let prompt = input.prompt;
  const originalHandoffPrompt = input.handoffPrompt;
  let handoffPrompt = input.handoffPrompt;
  let session = input.session;
  let recovery: Parameters<ExecutorAdapter["run"]>[0]["recovery"];
  let lastDispatchedPrompt: string | undefined;
  // The operation owner slot tracks only the latest child. Retain the full
  // assignment history across same-adapter retries so failover cannot hide one.
  const childProcesses: InPlaceChildProcessSettlement[] = [];
  const childLifecycleBySettlement = new WeakMap<InPlaceChildProcessSettlement, OperationChildLifecycleIdentity>();
  let unmatchedChildExit = false;
  const firstAttemptIndex = input.operation.attempts.length;

  acquireOperationOwner(input.operation);
  await writeOperationRecord(input.operation).catch(() => undefined);
  // #310: an unverified child shutdown keeps the owner lease active.
  let retainOwner = false;
  const ownerHeartbeat = setInterval(() => {
    touchOperationOwner(input.operation);
    void writeOperationRecord(input.operation).catch(() => undefined);
  }, 5_000);
  ownerHeartbeat.unref?.();
  try {
    for (;;) {
      const turnNumber = input.startingTurn + input.operation.attempts.length - firstAttemptIndex;
      const attemptRecord: ExecutionAttemptRecord = {
        attempt: input.operation.attempts.length + 1,
        generation: input.operation.generation,
        turn: turnNumber,
        startedAt: new Date().toISOString(),
        sessionId: session?.id,
      };
      input.operation.attempts.push(attemptRecord);
      input.operation.state = "running";
      await writeOperationRecord(input.operation);
      const attemptChildLifecycles = new Map<string, OperationChildLifecycleIdentity>();
      const childKey = (process: { pid: number; processGroupId?: number }) =>
        `${process.pid}:${process.processGroupId === undefined ? "none" : process.processGroupId}`;

      let turn: ExecutorTurn | undefined;
      let thrown: unknown;
      // Per-attempt transient boundary evidence. It is derived from the same
      // bounded candidate snapshots used elsewhere, never persisted, and never
      // a second event or review ledger. Paths that cannot be observed safely
      // (redacted, truncated, marker-bearing) supply no comparison at all, so
      // eligibility stays affirmative rather than guessing.
      const observationStarts = new Map<string, { pre: Map<string, Promise<FileSnapshot | undefined>> }>();
      const pendingObservationEffects: Array<{
        event: EvidenceEvent;
        paths: string[];
        pre?: Map<string, Promise<FileSnapshot | undefined>>;
        post: Map<string, Promise<FileSnapshot | undefined>>;
      }> = [];
      const snapshotOptions: SnapshotOptions = {
        maxFileBytes: input.config.maxFileBytes,
        maxSnapshotBytes: input.config.maxSnapshotBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      // Boundary snapshots are keyed by normalized absolute identity, never by
      // array position: a supported observation may list the same candidates in
      // a different order at each stage, and different files must never be
      // compared as one pair.
      const boundaryObservations = (paths: string[]): Map<string, Promise<FileSnapshot | undefined>> => {
        const snapshots = new Map<string, Promise<FileSnapshot | undefined>>();
        for (const path of paths.filter(isObservablePathAddress)) {
          const identity = resolve(input.workspaceRoot, expandHomePath(path));
          if (!snapshots.has(identity)) {
            snapshots.set(identity, createPathSnapshot(input.workspaceRoot, identity, snapshotOptions)
              .then(withoutSnapshotContent).catch(() => undefined));
          }
        }
        return snapshots;
      };
      const observationKey = (event: ExecutorToolObservation) => event.observationId ?? event.toolName;
      const settleObservationEffects = async (): Promise<void> => {
        while (pendingObservationEffects.length > 0) {
          const batch = pendingObservationEffects.splice(0);
          for (const pending of batch) {
            const pre = pending.pre
              ? new Map(await Promise.all([...pending.pre].map(async ([identity, snapshot]) => [identity, await snapshot] as const)))
              : undefined;
            const post = new Map(await Promise.all([...pending.post].map(async ([identity, snapshot]) => [identity, await snapshot] as const)));
            input.onQualifyingObservation?.({
              event: pending.event,
              paths: pending.paths,
              ...(pre && boundaryChanged(pre, post) ? { capturedEffect: true as const } : {}),
            });
          }
        }
      };
      const warning = input.evidence.reviewEvidenceNotes?.filter((note) => note.startsWith("WARNING: InPlace")).at(-1);
      if (warning && !prompt.includes(warning)) prompt = `${warning}\n\n${prompt}`;
      try {
        turn = await input.adapter.run({
          cwd: input.workspaceRoot,
          prompt,
          ...(handoffPrompt === undefined ? {} : { handoffPrompt }),
          artifactDir: input.artifactDir,
          turn: turnNumber,
          workspaceAccess: "workspace-write",
          executorToolCatalog: resolveExecutorToolCatalog(input.task),
          signal: input.signal,
          session,
          recovery,
          onUpdate: (message) => input.onUpdate?.({
            phase: "executing",
            message,
            artifactDir: input.artifactDir,
            adapter: input.adapter.kind,
            model: input.adapter.model,
          }),
          onLiveControl: input.onLiveControl,
          onToolObservation: (event) => {
            const { event: observation, observedPaths } = recordObservedToolEventEvidence({
              state: input.evidence,
              cwd: input.workspaceRoot,
              selectedRoot: input.baseline.workspaceRoot,
              adapter: input.adapter.kind,
              stage: event.stage,
              toolName: event.toolName,
              observationId: event.observationId,
              toolInput: event.toolInput,
              result: event.result,
              isError: event.isError,
            });
            // Classify every observation, including ones a full bounded ledger
            // no longer retains, from the recorder's canonical projection.
            const reviewable = isReviewableToolObservation(observation);
            const tracking = input.trackObservationEffects === true;
            if (event.stage === "start") {
              const pre = tracking ? boundaryObservations(observedPaths) : undefined;
              if (pre) observationStarts.set(observationKey(event), { pre });
              // A call can still establish observed outside-root scope, but not
              // an effect; call-only in-root activity stays non-qualifying here.
              if (reviewable) input.onQualifyingObservation?.({ event: observation, paths: observedPaths });
              // Returning the pending boundary capture lets a caller that owns
              // the operation (or a test fixture) align its mutation with the
              // observation, while ordinary adapters keep their existing flow.
              return pre ? Promise.all(pre.values()).then(() => undefined) : undefined;
            }
            if (!reviewable) return;
            if (!tracking) {
              input.onQualifyingObservation?.({ event: observation, paths: observedPaths });
              return;
            }
            const startKey = observationKey(event);
            const start = observationStarts.get(startKey);
            observationStarts.delete(startKey);
            const post = boundaryObservations(observedPaths);
            pendingObservationEffects.push({ event: observation, paths: observedPaths, ...(start ? { pre: start.pre } : {}),
              post });
            return Promise.all(post.values()).then(() => undefined);
          },
          // #93: the authoritative dispatch capture fires at the transport
          // delivery boundary. In-place dispatches name the in-place workspace
          // root; baseCommit stays empty (no captured base exists).
          onPromptDelivery: (delivery) => {
            if (delivery.prompt === lastDispatchedPrompt) return;
            lastDispatchedPrompt = delivery.prompt;
            const dispatch: SubtaskDispatchRecord = {
              provenance: "captured_at_dispatch",
              delivery: "written_to_transport",
              dispatchedAt: new Date().toISOString(),
              sentPrompt: delivery.prompt,
              worktreeRoot: input.workspaceRoot,
              baseCommit: "",
              inPlace: true,
              executorTurn: turnNumber,
              adapter: input.adapter.kind,
              model: input.adapter.model,
            };
            input.onUpdate?.({
              phase: "executing",
              message: "executor dispatch delivered: turn "
                + `${dispatch.executorTurn}`
                + `${dispatch.adapter ? ` via ${dispatch.adapter}` : ""}`
                + "; exact sent prompt and in-place workspace recorded at the transport delivery boundary (no captured base commit: writes happen directly in the workspace)",
              artifactDir: input.artifactDir,
              adapter: dispatch.adapter,
              model: dispatch.model,
              executorTurn: dispatch.executorTurn,
              dispatch,
            });
          },
          onProcessStart: async (process) => {
            const lifecycle = recordOperationChildProcess(input.operation, process.pid, process.processGroupId);
            const settlement: InPlaceChildProcessSettlement = {
              pid: process.pid,
              processGroupId: process.processGroupId,
            };
            childProcesses.push(settlement);
            childLifecycleBySettlement.set(settlement, lifecycle);
            attemptChildLifecycles.set(childKey(process), lifecycle);
            await writeOperationRecord(input.operation);
          },
          onProcessExit: async (process) => {
            const key = childKey(process);
            const lifecycle = attemptChildLifecycles.get(key);
            let matched: InPlaceChildProcessSettlement | undefined;
            if (lifecycle) {
              for (let index = childProcesses.length - 1; index >= 0; index -= 1) {
                const child = childProcesses[index]!;
                if (childLifecycleBySettlement.get(child)?.lifecycleId !== lifecycle.lifecycleId) continue;
                if (child.pid !== process.pid || child.exitedAt !== undefined) continue;
                if (process.processGroupId !== undefined && child.processGroupId !== process.processGroupId) continue;
                matched = child;
                break;
              }
            }
            if (matched) matched.exitedAt = new Date().toISOString();
            else unmatchedChildExit = true;
            if (lifecycle && recordOperationChildExit(input.operation, lifecycle)) {
              await writeOperationRecord(input.operation);
            }
            attemptChildLifecycles.delete(key);
          },
        });
      } catch (error) {
        thrown = error;
      } finally {
        await settleObservationEffects();
        input.onLiveControl?.(undefined);
      }

      if (input.signal?.aborted && (unmatchedChildExit || childProcesses.some((child) => child.exitedAt === undefined))) {
        // #310: a started child never reported a verified exit, so the writer
        // may still be live. Fail closed instead of releasing ownership as an
        // ordinary cancellation.
        retainOwner = true;
        attemptRecord.endedAt ??= new Date().toISOString();
        attemptRecord.outcome = "failed";
        const detail = turn?.failure?.message ?? (thrown === undefined ? undefined : thrown instanceof Error ? thrown.message : String(thrown));
        const incident = recordUnverifiedChildShutdown(input.operation, attemptRecord.attempt, detail);
        incidents.push(incident);
        await writeOperationRecord(input.operation);
        return { status: "failed", turn, error: incident.message, lastTurnNumber: turnNumber, incidents, childProcesses, unmatchedChildExit };
      }
      if (input.signal?.aborted) {
        attemptRecord.endedAt ??= new Date().toISOString();
        attemptRecord.outcome = "cancelled";
        input.operation.state = "cancelled";
        await writeOperationRecord(input.operation);
        return { status: "cancelled", turn, error: "Executor was cancelled.", lastTurnNumber: turnNumber, incidents, childProcesses, unmatchedChildExit };
      }

      const failure = classifyInPlaceFailure(turn, thrown);
      if (!failure) {
        attemptRecord.endedAt = new Date().toISOString();
        attemptRecord.outcome = "completed";
        attemptRecord.sessionId = turn?.session.id;
        input.operation.session = turn?.session;
        input.operation.state = "completed";
        await writeOperationRecord(input.operation);
        return { status: "completed", turn, lastTurnNumber: turnNumber, incidents, childProcesses, unmatchedChildExit };
      }

      session = turn?.session ?? session;
      input.operation.session = session;
      const repeatKey = `${failure.cause}:${failure.message}`;
      const repeatCount = (repeated.get(repeatKey) ?? 0) + 1;
      repeated.set(repeatKey, repeatCount);
      const incident = createIncident({
        attempt: attemptRecord.attempt,
        generation: input.operation.generation,
        cause: failure.cause,
        stage: failure.stage,
        message: failure.message,
        retryable: true,
      });
      incidents.push(incident);
      input.operation.incidents.push(incident);
      attemptRecord.endedAt = new Date().toISOString();
      attemptRecord.outcome = "retry";
      attemptRecord.incidentId = incident.incidentId;

      const compactionIncident = failure.cause === "interruption" || failure.cause === "compaction_error";
      const withinRepeatLimit = retryPolicy.maxSameIncidentRepeats > 0 && repeatCount <= retryPolicy.maxSameIncidentRepeats;
      const canRetry = compactionIncident
        ? withinRepeatLimit && compactionRecoveries < retryPolicy.maxSameIncidentRepeats
        : withinRepeatLimit && genericRetries < retryPolicy.maxRetries;
      if (!canRetry) {
        attemptRecord.outcome = "failed";
        input.operation.state = "paused_recoverable";
        await writeOperationRecord(input.operation);
        return { status: "failed", turn, error: failure.message, lastTurnNumber: turnNumber, incidents, childProcesses, unmatchedChildExit };
      }
      if (compactionIncident) compactionRecoveries += 1;
      else genericRetries += 1;
      input.operation.state = compactionIncident ? "compacting" : "retrying";
      await writeOperationRecord(input.operation);
      input.onUpdate?.({
        phase: "executing",
        message: compactionIncident ? "recovering interrupted compaction" : "retrying executor",
        artifactDir: input.artifactDir,
        adapter: input.adapter.kind,
        model: input.adapter.model,
      });
      if (!compactionIncident) {
        try {
          await inPlaceRetryDelay(retryPolicy.baseDelayMs, retryPolicy.maxDelayMs, retryPolicy.jitter, genericRetries, input.signal);
        } catch (delayError) {
          if (input.signal?.aborted) {
            return { status: "cancelled", error: "Executor was cancelled during retry backoff.", lastTurnNumber: turnNumber, incidents, childProcesses, unmatchedChildExit };
          }
          throw delayError;
        }
      }
      prompt = inPlaceRetryPrompt(failure.message, compactionIncident);
      if (originalHandoffPrompt !== undefined) {
        handoffPrompt = inPlaceRetryHandoff(failure.message, compactionIncident, originalHandoffPrompt);
      }
      recovery = {
        kind: compactionIncident ? "compaction" : "retry",
        compactBeforePrompt: compactionIncident,
      };
    }
  } finally {
    clearInterval(ownerHeartbeat);
    if (!retainOwner) releaseOperationOwner(input.operation);
    await writeOperationRecord(input.operation).catch(() => undefined);
  }
}
