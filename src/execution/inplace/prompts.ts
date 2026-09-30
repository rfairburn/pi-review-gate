import { buildEvidenceBundle, type EvidenceState } from "../../evidence";
import type { WaveWorkerTask } from "../wave-worker";
import type { InPlaceAttribution } from "./basis";

/**
 * Build the reviewer request for one in-place review cycle. It mirrors the
 * direct-orchestrator workspace-snapshot review scope and adds the truthful
 * attribution basis: the recorded launch snapshot, the recorded delta since
 * launch, and the explicit statement that the delta cannot prove the writer.
 */
export function buildInPlaceReviewRequest(task: WaveWorkerTask, attribution: InPlaceAttribution, evidence?: EvidenceState): string {
  const lines = [
    "Review the completed in-place subtask work against the following bounded task:",
    "",
    `Subtask: ${task.title}`,
    "",
    "Task instructions:",
    task.instructions,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ];
  if (task.relevantContext) {
    lines.push("", "Relevant context:", task.relevantContext);
  }
  if (task.authoritativeUpdates?.length) {
    lines.push(
      "",
      "Acknowledged task updates (authoritative, in delivery order):",
      "Later updates supersede any conflicting original instruction or acceptance criterion. Review the resulting effective request.",
      ...task.authoritativeUpdates.map((item) => `- [${item.action}:${item.instructionId}] ${item.instruction}`),
    );
  }
  const baseline = attribution.baseline;
  const baselineSummary = baseline.mode === "git"
    ? `Git: the workspace was inside a repository at HEAD ${baseline.gitHead ?? "(unborn HEAD)"} when the task launched.`
    : "The workspace was not inside a Git repository when the task launched; content snapshots are the only attribution basis.";
  const changedEntries = attribution.changes.map((change) => `${change.status}: ${change.path}`);
  const clipped = clipPaths(changedEntries, 200);
  const gitNote = attribution.gitHeadMoved === true
    ? `Git HEAD moved after launch${attribution.gitCurrentHead ? ` to ${attribution.gitCurrentHead}` : ""}; the file delta above describes workspace content, not Git history. Never present commits as the reviewed candidate; review the recorded workspace delta.`
    : baseline.mode === "git"
      ? "Git HEAD has not moved since launch; the recorded delta is the workspace content change since launch."
      : undefined;
  lines.push(
    "",
    "In-place workspace disclosure (authoritative):",
    `The worker ran and wrote directly in the launch-selected workspace ${baseline.workspaceRoot}. No candidate commit, wave capture, or landing exists for this task, and review is not a gate over those writes: they already happened where performed.`,
    baselineSummary,
    `Recorded workspace delta since launch (${changedEntries.length} path(s) changed):`,
    ...(changedEntries.length === 0 ? ["- (none)"] : clipped.lines),
    ...(attribution.baseline.snapshot.omissionsTruncated
      ? ["- The launch baseline snapshot was incomplete (its omission ledger overflowed): some pre-launch entries may be missing from the delta in either direction."]
      : []),
    ...(attribution.baseline.snapshot.omissions.length > 0 || attribution.snapshotAfter.omissions.length > 0
      ? ["- Entries the snapshot policy skips (ignored directories, oversized files) are excluded from this delta; their content is not evidence here."]
      : []),
    ...(gitNote ? [gitNote] : []),
    "",
    "Attribution boundary (authoritative):",
    "The delta above is the recorded workspace change since launch. It may contain this worker's changes and — when other writers acted concurrently — those writers' changes as well; the harness cannot prove which post-launch changes the worker made. Do not credit changes to the worker that you cannot attribute to the task's recorded instructions, and do not silently present unrelated concurrent changes as reviewed worker output. When attribution is uncertain, say so in findings and in your summary instead of guessing either way.",
    "A review verdict here is a post-hoc evaluation only: it never represents a pre-write gate, a rollback, or an undo of external side effects (network or API actions, processes, writes outside the workspace). Your review scope is exactly what direct orchestrator work in this workspace would receive.",
    "",
    "Workspace snapshot disclosure:",
    "The recorded baseline is a bounded content snapshot of the launch workspace; files the snapshot policy skips (ignored directories, oversized files) are excluded from the delta.",
  );
  if (evidence && (evidence.events.length > 0 || (evidence.toolObservabilityNotes?.length ?? 0) > 0 || evidence.candidates.size > 0)) {
    const bundle = buildEvidenceBundle(evidence, [], undefined, {
      selectedCwd: baseline.workspaceRoot,
      workspaceRoot: baseline.workspaceRoot,
    });
    lines.push(
      "",
      "Structured executor tool-observation evidence (post-hoc, bounded, not a pre-write gate):",
      "Absolute paths observed outside the selected workspace are separate external side-effect evidence. Their prior state is unverified; the attached current observation is not a diff and does not prove that this executor caused it.",
      bundle.markdown,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Bounded path disclosure for reviewer prompts: cap with an explicit overflow note. */
function clipPaths(paths: readonly string[], max: number): { lines: string[]; truncated: boolean } {
  if (paths.length <= max) return { lines: paths.map((path) => `- ${path}`), truncated: false };
  const overflow = paths.length - max;
  return {
    lines: [...paths.slice(0, max).map((path) => `- ${path}`), `- … ${overflow} more path(s) omitted from this bounded list`],
    truncated: true,
  };
}

// ── worker prompt ────────────────────────────────────────────────────────────

/**
 * Build the in-place executor prompt. Absolute source paths are deliberately
 * NOT rewritten: the workspace is the launch-selected root itself, and the
 * task text may legitimately reference it or other authorized locations. The
 * prompt makes the write-where-you-stand and no-recursion contracts
 * authoritative. Mirrors the delegated-worker prompt structure of
 * src/execution/wave-worker.ts for the in-place kind (#220).
 */
export function buildInPlacePrompt(task: WaveWorkerTask, workspaceRoot: string): string {
  return [
    `You are the in-place implementation executor for one bounded task. Your current working directory is the designated task workspace: ${workspaceRoot}`,
    "Work directly in this workspace: inspect it, implement the requested change (creating files, repositories, or subdirectories there as the task requires), and run relevant verification.",
    "Do not broaden the task, and do not modify files unrelated to it.",
    "",
    "In-place workspace contract (authoritative):",
    "This workspace may be any directory the launch selected — the primary workspace, an empty folder, or a checkout prepared for this task. Git is not required here.",
    "Everything you write stays exactly where you write it. There is no wave capture, no candidate commit, no review gate before your writes, and no rollback: your writes and any external side effects (network or API actions, installs, processes, writes outside this workspace) happen where performed, immediately.",
    "Never launch child subtasks and never delegate this work: no subtask tools are available here, and simulating or working around that absence is forbidden.",
    "If the workspace is a Git repository, keep your output as ordinary working-tree files and leave history management to the orchestrator: do not commit, push, or alter branch or worktree ownership metadata. Creating a new repository here (git init, or a fresh clone the task genuinely requires) is allowed.",
    "An own reviewer runs after your turn settles: it compares this workspace against a snapshot recorded at launch and reports on the recorded delta. That review is post-hoc — it cannot gate your writes or undo anything you or others did.",
    "",
    "Workspace snapshot disclosure:",
    "Your reviewer compares this workspace against a bounded content snapshot recorded at launch (plus the observed Git HEAD when the root is inside a repository). Files its snapshot policy skips (ignored directories, oversized files) are excluded from that comparison.",
    "",
    renderInPlaceTask(task),
    "",
    "When finished, summarize exactly what you changed in this workspace, the verification you ran, every external side effect you performed (including writes outside the workspace, network or API actions, and processes started), and remaining risks. Do not claim review acceptance: the reviewer reports separately.",
  ].join("\n");
}

function renderInPlaceTask(task: WaveWorkerTask): string {
  const lines = [
    `Subtask: ${task.title}`,
    "",
    task.instructions,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ...(task.relevantContext ? ["", "Relevant context:", task.relevantContext] : []),
  ];
  if (task.authoritativeUpdates?.length) {
    lines.push(
      "",
      "Acknowledged task updates (authoritative, in delivery order):",
      "Later updates supersede any conflicting original instruction or acceptance criterion.",
      ...task.authoritativeUpdates.map((item) => `- [${item.action}:${item.instructionId}] ${item.instruction}`),
    );
  }
  return lines.join("\n");
}

/** Continuation disclosure for an in-place resume (#220). Truthful about what the harness does and does not know. */
export function buildInPlaceContinuationDisclosure(resumedSession: boolean): string {
  return [
    "In-place continuation (explicitly dispatched):",
    "This turn runs in exactly the same launch-selected workspace the previous executor turn used. The harness did not recreate, reset, clean, or checkpoint it: its current contents are as the previous turn left them, including anything other writers changed meanwhile.",
    "The harness holds no checkpoint of this workspace. Prior writes and external side effects were already performed and are not rolled back by this continuation or by review.",
    resumedSession
      ? "Your previous executor session is being resumed."
      : "This is a fresh executor session: the previous executor's conversation, reasoning, and any other hidden session state are not available. Rely on the task text, the continuation instruction, and the current workspace contents.",
    "The continuation instruction below is authoritative. Apply only what is needed; do not repeat completed work or undo it.",
  ].join("\n");
}
