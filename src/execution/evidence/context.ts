/**
 * Authoritative supervisory context for evidence reads (#33).
 *
 * Rendered alongside every evidence read so the orchestrator never has to
 * infer authority from streams: durable task state, assignment history (from
 * the rewritten operation record — always shown as current), attempts,
 * steering command acknowledgments, changed files with honest landing status,
 * reviewer verdicts, and the currently in-flight command (explicitly not yet
 * observed). Worker claims and stream observations never upgrade any of this.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { redactSensitiveText } from "../../redaction";
import type { ExecutorSelection } from "../../config";
import type { OperationRecord } from "../operation-record";
import type { WaveResult } from "../wave-controller";
import type { BackgroundCommandRecord, BackgroundTaskState } from "../task-state";
import type { SubtaskEvidenceChangedFiles, SubtaskEvidenceContext, SubtaskEvidenceSnapshot } from "./types";

const execFileAsync = promisify(execFile);

const MAX_HISTORY_ITEMS = 50;
const MAX_PATHS = 100;
/** Free-text context strings are redacted and bounded before rendering. */
const MAX_CONTEXT_STRING_CHARS = 1_000;

function redactedText(value: string): string {
  const redacted = redactSensitiveText(value);
  return redacted.length > MAX_CONTEXT_STRING_CHARS ? `${redacted.slice(0, MAX_CONTEXT_STRING_CHARS - 1)}…` : redacted;
}

export interface SubtaskEvidenceContextInput {
  taskId: string;
  state?: BackgroundTaskState;
  operation?: OperationRecord;
  result?: WaveResult;
  commands?: BackgroundCommandRecord[];
  executorSelection?: ExecutorSelection;
  /** Live isolated worktree, when it still exists (untracked enumeration). */
  worktreeRoot?: string;
  /** Authorized task root the worktree must resolve inside for untracked enumeration. */
  waveRoot?: string;
  /**
   * Latest completed durable review cycle, summarized from the task's
   * persisted cycle records (#50): present while a worker is still
   * correcting, before any final task result exists.
   */
  durableReview?: {
    aggregate: string;
    cycles: number;
    latestSequence: number;
    reviewers: Array<{ reviewerId: string; verdict: string; summary: string }>;
    caveat?: string;
  };
}

function selectionParts(selection: ExecutorSelection | undefined): { adapter?: string; model?: string } {
  if (!selection) return {};
  if (selection.source === "pi") return { adapter: "pi-model", model: selection.model };
  return { adapter: selection.id };
}

/**
 * Fail-closed confinement for untracked enumeration: the recorded worktree must
 * resolve inside the task's wave root. A record pointing elsewhere (tampered or
 * stale) is never used as a git -C target.
 */
async function worktreeConfinement(worktreeRoot: string, waveRoot: string | undefined): Promise<"inside" | "outside" | "gone"> {
  if (!waveRoot) return "outside";
  try {
    const wt = await realpath(resolve(worktreeRoot));
    const wr = await realpath(resolve(waveRoot));
    return wt === wr || wt.startsWith(wr + sep) ? "inside" : "outside";
  } catch {
    return "gone"; // worktree already removed: enumeration is optional
  }
}

/** Untracked files in the isolated worktree (task-created; land with the candidate). */
async function listWorktreeUntracked(worktreeRoot: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktreeRoot, "status", "--porcelain=v1", "-z"], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3))
      .slice(0, MAX_PATHS);
  } catch {
    return undefined; // worktree gone or git unavailable: enumeration is optional
  }
}

export async function buildSubtaskEvidenceContext(
  input: SubtaskEvidenceContextInput,
  snapshot: SubtaskEvidenceSnapshot,
): Promise<SubtaskEvidenceContext | undefined> {
  const context: SubtaskEvidenceContext = {};

  if (input.state) context.state = input.state;

  // Assignment history from the durable operation record. The record is
  // rewritten in place on failover/continuation, so it is always rendered as
  // the current state — never cursor-gated.
  const assignments = input.operation?.assignments ?? [];
  if (assignments.length > 0 || input.executorSelection) {
    context.assignment = {
      ...(input.operation?.executorSelection || input.executorSelection
        ? { current: selectionParts(input.operation?.executorSelection ?? input.executorSelection) }
        : {}),
      history: assignments.slice(-MAX_HISTORY_ITEMS).map((assignment) => ({
        at: assignment.startedAt,
        reason: assignment.reason,
        ...selectionParts(assignment.selection),
        entryId: assignment.entryId,
        ...(assignment.outcome ? { outcome: assignment.outcome } : {}),
      })),
    };
  }

  const attempts = input.operation?.attempts ?? [];
  if (attempts.length > 0) {
    context.attempts = attempts.slice(-MAX_HISTORY_ITEMS).map((attempt) => ({
      attempt: attempt.attempt,
      turn: attempt.turn,
      startedAt: attempt.startedAt,
      ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    }));
  }

  const commands = input.commands ?? [];
  if (commands.length > 0) {
    context.steering = commands.slice(-20).map((command) => ({
      instructionId: command.instructionId,
      action: command.action,
      actor: command.actor,
      status: command.status,
      createdAt: command.createdAt,
      ...(command.acknowledgedAt ? { acknowledgedAt: command.acknowledgedAt } : {}),
    }));
  }

  const taskResult = input.result?.taskResults?.[0];
  const checkpoint = input.operation?.checkpoint ?? taskResult?.checkpoint;
  const landing = input.result?.landing;
  if (checkpoint || input.worktreeRoot) {
    const landingStatus: SubtaskEvidenceChangedFiles["landingStatus"] =
      landing?.status === "landed" ? "landed"
        : landing?.status === "conflicted" || landing?.status === "recovery_required" ? "conflicted"
          : "unlanded";
    const noteParts: string[] = [];
    if (checkpoint) {
      noteParts.push("Candidate diff against the base commit (tracked and task-created untracked paths).");
    }
    if (landing?.status && landing.status !== "landed") {
      noteParts.push(`Landing record: ${landing.status}.`);
    }
    if (landingStatus === "unlanded" && checkpoint) {
      noteParts.push("Unlanded until the candidate is landed; paths below are not yet in the source tree.");
    }
    let untracked: string[] | undefined;
    if (input.worktreeRoot) {
      const confinement = await worktreeConfinement(input.worktreeRoot, input.waveRoot);
      if (confinement === "inside") untracked = await listWorktreeUntracked(input.worktreeRoot);
      else if (confinement === "outside") noteParts.push("Untracked enumeration skipped: the recorded worktree does not resolve inside the task's wave root.");
    }
    context.changedFiles = {
      landingStatus,
      trackedPaths: (checkpoint?.changedPaths ?? []).slice(0, MAX_PATHS).map((path) => redactedText(path)),
      ...(untracked && untracked.length > 0 ? { untrackedPaths: untracked.map((path) => redactedText(path)) } : {}),
      note: redactedText(noteParts.join(" ")),
    };
  }

  const reviewReport = taskResult?.reviewReport;
  if (reviewReport) {
    // Free-text review strings are redacted and bounded here, exactly as in
    // the indexed review entries: a secret in a reviewer summary must not
    // leak through the context view of an evidence read.
    context.review = {
      aggregate: redactedText(reviewReport.aggregate),
      cycles: reviewReport.reviewCycles,
      latestSequence: reviewReport.latestReviewSequence,
      reviewers: reviewReport.reviewers.map((reviewer) => ({
        reviewerId: redactedText(reviewer.reviewerId),
        verdict: redactedText(reviewer.verdict),
        summary: redactedText(reviewer.summary),
      })),
    };
  } else if (input.durableReview) {
    // Completed review evidence persisted before final settlement (#50):
    // the same redaction and bounding apply to the durable cycle records.
    context.review = {
      aggregate: redactedText(input.durableReview.aggregate),
      cycles: input.durableReview.cycles,
      latestSequence: input.durableReview.latestSequence,
      reviewers: input.durableReview.reviewers.map((reviewer) => ({
        reviewerId: redactedText(reviewer.reviewerId),
        verdict: redactedText(reviewer.verdict),
        summary: redactedText(reviewer.summary),
      })),
      ...(input.durableReview.caveat !== undefined ? { caveat: input.durableReview.caveat } : {}),
    };
  }

  // The currently in-flight command, explicitly not yet observed.
  let currentCommand: SubtaskEvidenceSnapshot["entries"][number] | undefined;
  for (let i = snapshot.entries.length - 1; i >= 0; i -= 1) {
    const entry = snapshot.entries[i]!;
    if (entry.status === "in_flight" && entry.kind === "tool_call") {
      currentCommand = entry;
      break;
    }
  }
  if (currentCommand) {
    const startedMs = currentCommand.at ? Date.parse(currentCommand.at) : Number.NaN;
    context.currentCommand = {
      entryId: currentCommand.entryId,
      preview: currentCommand.preview,
      ...(currentCommand.callId ? { callId: currentCommand.callId } : {}),
      ...(currentCommand.toolName ? { toolName: currentCommand.toolName } : {}),
      ...(currentCommand.at ? { startedAt: currentCommand.at } : {}),
      ...(!Number.isNaN(startedMs) ? { elapsedMs: Math.max(0, Date.now() - startedMs) } : {}),
      resultObserved: false,
    };
  }

  const hasContent = Object.keys(context).length > 0;
  return hasContent ? context : undefined;
}
