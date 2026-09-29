/**
 * #220: the in-place subtask worker kind.
 *
 * An in-place task runs a write-capable executor directly in the group's
 * launch-selected workspace — any existing directory, Git or not, including
 * the primary workspace, an empty folder, or a checkout prepared for a
 * ticket. Unlike the execute kind there is no wave capture, no managed
 * worker worktree, no candidate commit, and no landing: writes happen where
 * the worker performs them. Unlike the research kind it may write and take
 * external actions, and it does not run in a read-only sandbox.
 *
 * Attribution is content-anchored, not writer-proven: at dispatch the module
 * captures a bounded workspace snapshot (plus the Git HEAD when the root is
 * inside a repository). Its own reviewer reviews the recorded workspace delta
 * since launch — the same workspace-snapshot review scope direct orchestrator
 * work receives — and separately receives bounded tool-observed absolute write
 * paths outside that root as external side-effect evidence. Neither the delta
 * nor racy tool events prove which post-launch changes the worker made versus
 * any concurrent writer, so reviews carry that caveat and never represent a
 * pre-write gate or an undo of already-performed writes.
 *
 * The executor tool catalog the task carries is produced by the launch path
 * with every Subtasks*-prefixed delegation tool removed: an in-place worker
 * cannot launch recursive subtasks.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  compareSnapshots,
  createWorkspaceSnapshot,
  type ChangedFile,
  type FileSnapshot,
  type WorkspaceSnapshot,
} from "../capture";
import { executorAgentFingerprint, resolveReviewers, DEFAULT_EXECUTION_RETRY_POLICY, type ExecutorSelection, type ReviewGateConfig } from "../config";
import type { ExecutorAdapter, ExecutorLiveControl, ExecutorSession, ExecutorTurn, SubtaskDispatchRecord, SubtaskProgressUpdate } from "./types";
import type { WaveWorkerTask } from "./wave-worker";
import { createExecutorAdapter } from "./adapters/factory";
import type { ExecutorPoolAssignment } from "./executor-pool";
import {
  acquireOperationOwner,
  createIncident,
  createOperationRecord,
  readOperationRecord,
  recordOperationChildExit,
  recordOperationChildProcess,
  releaseOperationOwner,
  touchOperationOwner,
  writeOperationRecord,
  buildOperationDiagnostics,
  type ExecutionAttemptRecord,
  type ExecutionIncident,
  type ExecutorAssignmentRecord,
  type OperationRecord,
} from "./operation-record";
import {
  normalizeExecutorToolCatalog,
  resolveExecutorToolCatalog,
} from "./tool-catalog";
import { buildEvidenceBundle } from "../evidence";
import { redactSensitiveText } from "../redaction";
import { runReview, type ReviewRunOutput } from "../review";
import {
  buildReviewReportFromOutputs,
  hasPartialReviewerFailure,
  type SubtaskReviewReport,
} from "../review-report";
import {
  captureObservedToolPathAfterStates,
  rememberFinalAssistantSummaryText,
  recordObservedToolEventEvidence,
  recordToolEventObservability,
  restoreEvidenceState,
  serializeEvidenceState,
  type EvidenceState,
} from "../evidence";
import { atomicWrite, atomicWriteExclusive } from "./durable-write";
import {
  createWorkerReviewState,
  freezeReviewers,
  buildReviewTransmission,
  reviewerProgressLabel,
  runCandidateReviewWithRecovery,
} from "./wave-worker-lifecycle";

// ── launch-time baseline and attribution ─────────────────────────────────────

/**
 * The durable attribution basis captured at dispatch time. `git` mode records
 * the observed HEAD; `non_git` mode declares that no repository anchor exists.
 * The content snapshot is the only cross-mode change basis. Everything here is
 * observed state at launch — never reconstructed later.
 */
export interface InPlaceBaseline {
  workspaceRoot: string;
  mode: "git" | "non_git";
  capturedAt: string;
  /** Git only: HEAD commit observed at launch (undefined for an unborn HEAD). */
  gitHead?: string;
  /** Git only: repository top level, which may contain the workspace root as a subdirectory. */
  gitRepositoryRoot?: string;
  snapshot: WorkspaceSnapshot;
}

async function inPlaceGit(root: string, args: string[]): Promise<string | undefined> {
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.toString().trim();
  } catch {
    return undefined;
  }
}

/**
 * Capture the launch-time attribution basis for an in-place task: whether the
 * workspace root sits inside a Git repository (HEAD and top level observed),
 * plus a bounded content snapshot. Snapshot omissions are retained on the
 * snapshot and disclosed wherever its comparisons are surfaced.
 */
export async function createInPlaceBaseline(
  workspaceRoot: string,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<InPlaceBaseline> {
  const root = resolve(workspaceRoot);
  const gitTop = await inPlaceGit(root, ["rev-parse", "--show-toplevel"]);
  const snapshot = await createWorkspaceSnapshot(root, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    signal,
  });
  if (gitTop === undefined) {
    return { workspaceRoot: root, mode: "non_git", capturedAt: new Date().toISOString(), snapshot };
  }
  const head = await inPlaceGit(root, ["rev-parse", "HEAD"]);
  return {
    workspaceRoot: root,
    mode: "git",
    capturedAt: new Date().toISOString(),
    ...(head !== undefined && head !== "" ? { gitHead: head } : {}),
    gitRepositoryRoot: gitTop,
    snapshot,
  };
}

export interface InPlaceAttribution {
  baseline: InPlaceBaseline;
  /** Content delta between the launch snapshot and the current workspace. */
  changes: ChangedFile[];
  /** Git only: true when HEAD moved after launch (for example the worker created a commit). */
  gitHeadMoved?: boolean;
  gitCurrentHead?: string;
  snapshotAfter: WorkspaceSnapshot;
}

/**
 * Compute the current workspace delta against the launch baseline. The delta
 * records what changed since launch — never proof of who changed it: a
 * concurrent writer's changes appear here exactly like the worker's own.
 */
export async function computeInPlaceAttribution(
  baseline: InPlaceBaseline,
  config: ReviewGateConfig,
  signal?: AbortSignal,
): Promise<InPlaceAttribution> {
  const snapshotAfter = await createWorkspaceSnapshot(baseline.workspaceRoot, {
    maxFileBytes: config.maxFileBytes,
    maxSnapshotBytes: config.maxSnapshotBytes,
    reuseUnchangedFrom: baseline.snapshot,
    signal,
  });
  const changes = compareSnapshots(baseline.snapshot, snapshotAfter);
  if (baseline.mode !== "git" || baseline.gitHead === undefined) {
    return { baseline, changes, snapshotAfter };
  }
  const currentHead = await inPlaceGit(baseline.workspaceRoot, ["rev-parse", "HEAD"]);
  return {
    baseline,
    changes,
    gitHeadMoved: currentHead !== baseline.gitHead,
    gitCurrentHead: currentHead ?? undefined,
    snapshotAfter,
  };
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

/**
 * Content-anchored identity of one snapshot entry. Mirrors the captured
 * snapshot's own equivalence fields (hash, entry type, mode, link target,
 * Git object id, and the omission class when content was not retained) so a
 * later turn that changes an already-changed path's CONTENT always produces a
 * different identity, and a byte-identical workspace never does.
 */
function snapshotEntryId(entry: FileSnapshot | undefined): string {
  if (!entry || entry.exists === false) return "absent";
  return [
    entry.sha256 ?? "nohash",
    entry.entryType ?? "file",
    entry.mode ?? "-",
    entry.gitObjectId ?? "-",
    entry.linkTarget ? createHash("sha256").update(entry.linkTarget).digest("hex").slice(0, 16) : "-",
    entry.omittedReason ?? "-",
    entry.isBinary ? "binary" : "text",
  ].join("/");
}

/**
 * Content-anchored identity of a recorded workspace delta: per changed path,
 * both the launch-state and current-state content identities. Status and path
 * alone are NOT sufficient identity: a correction that rewrites a
 * already-changed file must be observable, and a pass confirmation that
 * changes what was reviewed must never settle the task as reviewed.
 */
export function inPlaceDeltaIdentity(attribution: InPlaceAttribution): string {
  const identity = attribution.changes.map((change) => {
    const beforeId = snapshotEntryId(attribution.baseline.snapshot.files.get(change.path));
    const afterId = snapshotEntryId(attribution.snapshotAfter.files.get(change.path));
    return `${change.status}:${change.path}:${beforeId}=>${afterId}`;
  }).sort();
  return identity.join("|");
}

// ── durable launch baseline (#220 review pass 1) ───────────────────────────

/**
 * The durable launch baseline document. Captured ONCE, before the executor's
 * first dispatch, and restored (verified) for every continuation: writes made
 * before a pause are part of the original attribution basis and must never
 * silently become part of a RE-baselined continuation. File content is
 * retained up to the launch snapshot's existing maxSnapshotBytes bound; mount
 * metadata (inode/dev, absolute paths, timestamps) is intentionally dropped —
 * it is not part of either the snapshot's content equivalence or the
 * attribution identity, and stale device/inode values would block legitimate
 * snapshot reuse on the restored session's filesystem.
 */
interface PersistedInPlaceBaselineDoc {
  version: 1;
  taskId: string;
  workspaceRoot: string;
  mode: "git" | "non_git";
  capturedAt: string;
  gitHead?: string;
  gitRepositoryRoot?: string;
  omissions: Array<{ path: string; kind: string; reason: string }>;
  omissionsTruncated: boolean;
  files: Array<PersistedFileSnapshot>;
  integritySha256: string;
}

interface PersistedFileSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mode?: number;
  entryType?: FileSnapshot["entryType"];
  linkTarget?: string;
  gitObjectId?: string;
  sha256: string | null;
  isBinary: boolean;
  content?: string;
  omittedReason?: string;
}

export const INPLACE_BASELINE_FILE = "baseline.json";

/** Serialize the launch baseline for durable retention (exact, self-hashed doc). */
function serializeInPlaceBaseline(baseline: InPlaceBaseline, taskId: string): PersistedInPlaceBaselineDoc {
  const unsigned = {
    version: 1 as const,
    taskId,
    workspaceRoot: baseline.workspaceRoot,
    mode: baseline.mode,
    capturedAt: baseline.capturedAt,
    ...(baseline.gitHead ? { gitHead: baseline.gitHead } : {}),
    ...(baseline.gitRepositoryRoot ? { gitRepositoryRoot: baseline.gitRepositoryRoot } : {}),
    omissions: baseline.snapshot.omissions.map((omission) => ({
      path: omission.path,
      kind: omission.kind,
      reason: omission.reason,
    })),
    omissionsTruncated: baseline.snapshot.omissionsTruncated,
    files: [...baseline.snapshot.files.entries()].map(([path, entry]) => ({
      path,
      exists: entry.exists,
      size: entry.size,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      ...(entry.entryType ? { entryType: entry.entryType } : {}),
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
      ...(entry.gitObjectId !== undefined ? { gitObjectId: entry.gitObjectId } : {}),
      sha256: entry.sha256,
      isBinary: entry.isBinary,
      ...(entry.content !== undefined ? { content: entry.content } : {}),
      ...(entry.omittedReason !== undefined ? { omittedReason: entry.omittedReason } : {}),
    })),
  };
  return {
    ...unsigned,
    integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
}

/**
 * Persist the launch baseline durably BEFORE the executor dispatches, at the
 * task's artifact directory (which always lives outside the workspace). One
 * document per task; a later dispatch overwrites only via an explicit,
 * verified re-persist — continuations must load and verify instead.
 */
export async function persistInPlaceBaseline(baseline: InPlaceBaseline, taskId: string, artifactDir: string): Promise<string> {
  const doc = serializeInPlaceBaseline(baseline, taskId);
  const path = join(artifactDir, INPLACE_BASELINE_FILE);
  await atomicWriteExclusive(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}

/**
 * Restore the original launch baseline for a continuation and verify it: the
 * integrity hash, the task identity, and the workspace root's canonical path
 * must all match. A missing, tampered, or mis-rooted document fails closed
 * with an actionable refusal — never a silently re-baselined continuation.
 */
export async function loadInPlaceBaseline(taskId: string, artifactDir: string, workspaceRoot: string): Promise<InPlaceBaseline> {
  const path = join(artifactDir, INPLACE_BASELINE_FILE);
  let doc: PersistedInPlaceBaselineDoc;
  try {
    doc = JSON.parse(await readFile(path, "utf8")) as PersistedInPlaceBaselineDoc;
  } catch (error) {
    throw new Error(
      `In-place continuation refused: the launch baseline document ${path} could not be read (${error instanceof Error ? error.message : String(error)}). The original launch state cannot be verified, so the task is not continued; inspect the workspace and its artifacts manually.`,
    );
  }
  const { integritySha256, ...unsigned } = doc;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (doc.version !== 1 || !integritySha256 || integritySha256 !== actual || doc.taskId !== taskId) {
    throw new Error(
      `In-place continuation refused: the persisted launch baseline for task ${taskId} is malformed or tampered; the original launch state cannot be verified, so the task is not continued.`,
    );
  }
  if (resolve(doc.workspaceRoot) !== resolve(workspaceRoot)) {
    throw new Error(
      `In-place continuation refused: the persisted launch baseline names workspace ${doc.workspaceRoot}, not ${workspaceRoot}; continuing would review the wrong basis.`,
    );
  }
  const files = new Map<string, FileSnapshot>();
  for (const entry of doc.files) {
    const rebuilt: FileSnapshot = {
      relativePath: entry.path,
      absolutePath: resolve(workspaceRoot, entry.path),
      exists: entry.exists,
      // Restored records never carry live mount identity: they exist to
      // anchor attribution identity and review diffs. Stale mtime/absent
      // stat fields simply make snapshot REUSE ineligible (fresh re-inspection
      // with identical hashing) rather than untrusted.
      size: entry.size,
      mtimeMs: 0,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      ...(entry.entryType ? { entryType: entry.entryType } : {}),
      ...(entry.linkTarget !== undefined ? { linkTarget: entry.linkTarget } : {}),
      ...(entry.gitObjectId !== undefined ? { gitObjectId: entry.gitObjectId } : {}),
      sha256: entry.sha256,
      isBinary: entry.isBinary,
      ...(entry.content !== undefined ? { content: entry.content } : {}),
      ...(entry.omittedReason !== undefined ? { omittedReason: entry.omittedReason as FileSnapshot["omittedReason"] } : {}),
    };
    files.set(entry.path, rebuilt);
  }
  const snapshot: WorkspaceSnapshot = {
    cwd: resolve(workspaceRoot),
    capturedAt: doc.capturedAt,
    files,
    omissions: doc.omissions.map((omission) => ({
      kind: omission.kind,
      path: omission.path,
      reason: omission.reason,
    })) as WorkspaceSnapshot["omissions"],
    omissionsTruncated: doc.omissionsTruncated,
  };
  return {
    workspaceRoot: resolve(doc.workspaceRoot),
    mode: doc.mode,
    capturedAt: doc.capturedAt,
    ...(doc.gitHead ? { gitHead: doc.gitHead } : {}),
    ...(doc.gitRepositoryRoot ? { gitRepositoryRoot: doc.gitRepositoryRoot } : {}),
    snapshot,
  };
}

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

// ── artifact-path containment ────────────────────────────────────────────────

/**
 * #220 artifact containment: the task's artifact directory must live OUTSIDE
 * the workspace (task/review artifacts must never be written into the
 * user-selected workspace). Lexical check plus nearest-existing-ancestor
 * realpath, mirroring the worktree-artifact preflight.
 */
export async function assertInPlaceArtifactOutsideWorkspace(artifactDir: string, workspaceRoot: string): Promise<void> {
  const root = await fs.realpath(workspaceRoot);
  const lexical = relative(resolve(workspaceRoot), resolve(artifactDir));
  const outside = (): boolean => isAbsolute(lexical) || lexical === ".." || lexical.startsWith(`..${sep}`);
  if (!outside()) {
    throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
  }
  // Preflight: resolve the nearest existing ancestor and forbid it from being
  // inside the workspace, so mkdir cannot be tricked into creating directories
  // inside the workspace through a symlink.
  let existing = resolve(artifactDir);
  for (;;) {
    let resolved: string;
    try {
      resolved = await fs.realpath(existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
      continue;
    }
    const rel = relative(root, resolved);
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
      throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
    }
    return;
  }
}

async function ensureArtifactDir(artifactDir: string, workspaceRoot: string): Promise<string> {
  const resolved = resolve(artifactDir);
  await assertInPlaceArtifactOutsideWorkspace(resolved, workspaceRoot);
  await mkdir(resolved, { recursive: true });
  const real = await fs.realpath(resolved);
  const root = await fs.realpath(workspaceRoot);
  const rel = relative(root, real);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
  }
  return real;
}

// ── executor turn loop (no checkpoints, fail closed) ─────────────────────────

interface RecoveredInPlaceRun {
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

function inPlaceChildSettlementIsVerified(
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

function beginInPlaceAssignment(
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

async function inPlaceRetryDelay(
  base: number,
  max: number,
  jitter: boolean,
  retry: number,
  signal?: AbortSignal,
): Promise<void> {
  if (base === 0) return;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, retry - 1));
  const wait = jitter ? Math.floor(ceiling * (0.5 + Math.random() * 0.5)) : ceiling;
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
async function runInplaceTurnLoop(input: {
  adapter: ExecutorAdapter;
  evidence: EvidenceState;
  baseline: InPlaceBaseline;
  workspaceRoot: string;
  artifactDir: string;
  config: ReviewGateConfig;
  task: WaveWorkerTask;
  taskId: string;
  prompt: string;
  startingTurn: number;
  session?: ExecutorSession;
  signal?: AbortSignal;
  operation: OperationRecord;
  assignment: ExecutorPoolAssignment;
  onUpdate?: (update: SubtaskProgressUpdate) => void;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
}): Promise<RecoveredInPlaceRun> {
  const retryPolicy = input.config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY;
  const incidents: ExecutionIncident[] = [];
  const repeated = new Map<string, number>();
  let genericRetries = 0;
  let compactionRecoveries = 0;
  let prompt = input.prompt;
  let session = input.session;
  let recovery: Parameters<ExecutorAdapter["run"]>[0]["recovery"];
  let lastDispatchedPrompt: string | undefined;
  // The operation owner slot tracks only the latest child. Retain the full
  // assignment history across same-adapter retries so failover cannot hide one.
  const childProcesses: InPlaceChildProcessSettlement[] = [];
  let unmatchedChildExit = false;
  const firstAttemptIndex = input.operation.attempts.length;

  acquireOperationOwner(input.operation);
  await writeOperationRecord(input.operation).catch(() => undefined);
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

      let turn: ExecutorTurn | undefined;
      let thrown: unknown;
      try {
        turn = await input.adapter.run({
          cwd: input.workspaceRoot,
          prompt,
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
          onToolObservation: (event) => recordObservedToolEventEvidence({
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
          }),
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
            childProcesses.push({
              pid: process.pid,
              processGroupId: process.processGroupId,
            });
            recordOperationChildProcess(input.operation, process.pid, process.processGroupId);
            await writeOperationRecord(input.operation);
          },
          onProcessExit: async (process) => {
            let matched: InPlaceChildProcessSettlement | undefined;
            for (let index = childProcesses.length - 1; index >= 0; index -= 1) {
              const child = childProcesses[index]!;
              if (child.pid !== process.pid || child.exitedAt !== undefined) continue;
              if (process.processGroupId !== undefined && child.processGroupId !== process.processGroupId) continue;
              matched = child;
              break;
            }
            if (matched) matched.exitedAt = new Date().toISOString();
            else unmatchedChildExit = true;
            recordOperationChildExit(input.operation);
            await writeOperationRecord(input.operation);
          },
        });
      } catch (error) {
        thrown = error;
      } finally {
        input.onLiveControl?.(undefined);
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
      recovery = {
        kind: compactionIncident ? "compaction" : "retry",
        compactBeforePrompt: compactionIncident,
      };
    }
  } finally {
    clearInterval(ownerHeartbeat);
    releaseOperationOwner(input.operation);
    await writeOperationRecord(input.operation).catch(() => undefined);
  }
}
// ── turn runner shared by fresh and continued in-place tasks ─────────────────

export interface InPlaceRunInput {
  taskId: string;
  task: WaveWorkerTask;
  /** Launch-selected workspace root the worker runs and writes in. */
  workspaceRoot: string;
  /** Durable artifact directory for this task; must be OUTSIDE the workspace. */
  artifactDir: string;
  config: ReviewGateConfig;
  scopedModels?: string[];
  signal?: AbortSignal;
  onUpdate?: (update: SubtaskProgressUpdate) => void;
  onLiveControl?: (control: ExecutorLiveControl | undefined) => void;
  /** Atomically claim steering that could not reach the completed live turn. */
  takeDeferredSteering?: () => Promise<Array<{ instruction: string; instructionId: string }>>;
  /** Capacity lease selected by the group scheduler. */
  executorAssignment?: ExecutorPoolAssignment;
  /** Acquire the next eligible configured executor after retry recovery is exhausted. */
  acquireFailover?: (current: ExecutorPoolAssignment) => Promise<ExecutorPoolAssignment | undefined>;
  /** Optional adapter factory for embedding/tests; normal dispatch uses the configured factory. */
  adapterFactory?: (config: ReviewGateConfig, selection: ExecutorSelection) => ExecutorAdapter;
}

export interface InPlaceWorkerResult {
  status: "completed" | "executor_error" | "timeout" | "cancelled";
  taskId: string;
  title: string;
  summary: string;
  session?: ExecutorSession;
  turn?: ExecutorTurn;
  adapter: string;
  model?: string;
  usage?: ExecutorTurn["usage"];
  error?: string;
  operationRecord: string;
  incidents: ExecutionIncident[];
  attempts: number;
  lastExecutorTurn?: number;
  effectiveAssignment?: ExecutorPoolAssignment;
  /** A failover route was attempted but had no successor lease; do not retry on the released assignment. */
  failoverExhausted?: boolean;
}

const IN_PLACE_OBSERVED_EVIDENCE_FILE = "observed-tool-evidence.json";

async function persistInPlaceObservedEvidence(state: EvidenceState, artifactDir: string): Promise<void> {
  await atomicWrite(
    join(artifactDir, IN_PLACE_OBSERVED_EVIDENCE_FILE),
    `${JSON.stringify(serializeEvidenceState(state), null, 2)}\n`,
  );
}

async function restoreInPlaceObservedEvidence(state: EvidenceState, artifactDir: string, workspaceRoot: string): Promise<void> {
  try {
    const raw = await readFile(join(artifactDir, IN_PLACE_OBSERVED_EVIDENCE_FILE), "utf8");
    restoreEvidenceState(state, JSON.parse(raw) as unknown, workspaceRoot);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    state.requiresReview = true;
    state.toolObservabilityNotes ??= [];
    state.toolObservabilityNotes.push("Persisted tool evidence could not be restored; prior observations may be incomplete.");
  }
}

async function loadOrCreateInPlaceOperation(input: {
  taskId: string;
  task: WaveWorkerTask;
  workspaceRoot: string;
  artifactDir: string;
  config: ReviewGateConfig;
}): Promise<OperationRecord> {
  const existing = await readOperationRecord(join(input.artifactDir, "operation.json")).catch(() => undefined);
  if (existing) {
    if (existing.taskId !== input.taskId || resolve(existing.artifactDir) !== resolve(input.artifactDir)) {
      throw new Error("Retained in-place operation record does not match this task.");
    }
    if (existing.state === "failed_critical") {
      throw new Error("Retained in-place operation is fail-closed after an unverified process settlement; automatic continuation is refused.");
    }
    return existing;
  }
  // Deliberate in-place identity: the retained record names the in-place
  // execution window (`inplace`), not a wave. Nothing here fabricates a base
  // commit or capture: in-place work has neither.
  const record = createOperationRecord({
    waveId: "inplace",
    taskId: input.taskId,
    title: input.task.title,
    worktreeRoot: input.workspaceRoot,
    effectiveCwd: input.workspaceRoot,
    artifactDir: input.artifactDir,
    retryBudget: input.config.execution?.retryPolicy?.maxRetries ?? DEFAULT_EXECUTION_RETRY_POLICY.maxRetries,
    executorToolCatalog: normalizeExecutorToolCatalog(input.task),
  });
  await writeOperationRecord(record);
  return record;
}

/**
 * Run one in-place executor turn: initial (fresh dispatch) or resumed
 * (continuation feedback delivered to the retained session and workspace).
 */
async function runInplaceTurnWorker(input: InPlaceRunInput & {
  mode: "initial" | "continuation";
  startingTurn: number;
  feedback?: string;
  priorSession?: ExecutorSession;
  evidence: EvidenceState;
  baseline: InPlaceBaseline;
}): Promise<InPlaceWorkerResult> {
  const { taskId, task, config } = input;
  normalizeExecutorToolCatalog(task);
  const artifactDir = await ensureArtifactDir(input.artifactDir, input.workspaceRoot);
  const operation = await loadOrCreateInPlaceOperation({
    taskId,
    task,
    workspaceRoot: input.workspaceRoot,
    artifactDir,
    config,
  });

  const initialAssignment = input.executorAssignment;
  if (!initialAssignment) {
    return {
      status: "executor_error",
      taskId,
      title: task.title,
      summary: "No executor capacity was assigned for this in-place task.",
      adapter: "none",
      error: "No executor capacity was assigned for this in-place task.",
      operationRecord: join(artifactDir, "operation.json"),
      incidents: [...operation.incidents],
      attempts: operation.attempts.length,
    };
  }

  let prompt = input.mode === "continuation" && input.feedback
    ? (input.priorSession
      ? [
        buildInPlaceContinuationDisclosure(true),
        "",
        "Current continuation instructions:",
        input.feedback,
      ].join("\n")
      : [
        buildInPlacePrompt(task, input.workspaceRoot),
        "",
        buildInPlaceContinuationDisclosure(false),
        "",
        "Current continuation instructions:",
        input.feedback,
      ].join("\n"))
    : buildInPlacePrompt(task, input.workspaceRoot);

  let assignment = initialAssignment;
  let session = input.priorSession;
  let startingTurn = input.startingTurn;
  let failoverExhausted = false;
  let reason: ExecutorAssignmentRecord["reason"] = input.mode === "continuation" ? "continuation" : "initial";
  for (;;) {
    const assignmentRecord = beginInPlaceAssignment(operation, assignment, reason, config);
    input.onUpdate?.({
      phase: input.mode === "continuation" ? "correcting" : "starting",
      message: reason === "failover"
        ? `starting replacement executor ${assignment.entry.entryId} in the same in-place workspace`
        : input.mode === "continuation"
          ? `resuming in-place executor turn ${startingTurn} in ${input.workspaceRoot}`
          : "in-place worker starting executor",
      artifactDir,
      executorEntryId: assignment.entry.entryId,
      executorSelection: { ...assignment.entry.selection },
    });

    let adapter: ReturnType<typeof createExecutorAdapter>;
    try {
      adapter = (input.adapterFactory ?? createExecutorAdapter)(config, assignment.entry.selection);
      operation.adapter = adapter.kind;
      operation.model = adapter.model;
      recordToolEventObservability(input.evidence, adapter.kind, adapter.toolEventObservability ?? {
        mode: "unavailable",
        description: "This executor adapter does not expose a structured tool-event stream; tool-level write paths are not observed.",
      });
      await writeOperationRecord(operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create executor adapter.";
      const incident = createIncident({
        attempt: operation.attempts.length,
        generation: operation.generation,
        cause: "provider_error",
        stage: "adapter_initialization",
        message,
        retryable: true,
      });
      operation.incidents.push(incident);
      assignmentRecord.endedAt = new Date().toISOString();
      assignmentRecord.outcome = "failed";
      const next = await input.acquireFailover?.(assignment);
      if (!next || input.signal?.aborted) {
        failoverExhausted = Boolean(input.acquireFailover) && !input.signal?.aborted;
        operation.state = input.signal?.aborted ? "cancelled" : "paused_recoverable";
        await writeOperationRecord(operation);
        input.onLiveControl?.(undefined);
        return {
          status: input.signal?.aborted ? "cancelled" : "executor_error",
          taskId,
          title: task.title,
          summary: input.signal?.aborted ? "In-place executor was cancelled." : message,
          adapter: "none",
          error: message,
          operationRecord: join(artifactDir, "operation.json"),
          incidents: [...operation.incidents],
          attempts: operation.attempts.length,
          effectiveAssignment: assignment,
          failoverExhausted,
        };
      }
      incident.resolvedAt = new Date().toISOString();
      incident.resolution = "executor_pool_failover";
      operation.generation += 1;
      operation.session = undefined;
      assignment = next;
      session = undefined;
      startingTurn = Math.max(startingTurn, operation.attempts.length + 1);
      prompt = inPlaceFailoverPrompt(task, input.workspaceRoot, input.mode, input.feedback, message);
      reason = "failover";
      await writeOperationRecord(operation);
      continue;
    }

    input.onUpdate?.({
      phase: "executing",
      message: `executor turn ${startingTurn} running in place`,
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
      executorEntryId: assignment.entry.entryId,
      executorSelection: { ...assignment.entry.selection },
    });

    let run: RecoveredInPlaceRun;
    try {
      run = await runInplaceTurnLoop({
        adapter,
        evidence: input.evidence,
        baseline: input.baseline,
        workspaceRoot: input.workspaceRoot,
        artifactDir,
        config,
        task,
        taskId,
        prompt,
        startingTurn,
        session,
        signal: input.signal,
        operation,
        assignment,
        onUpdate: input.onUpdate,
        onLiveControl: input.onLiveControl,
      });
    } finally {
      assignmentRecord.endedAt = new Date().toISOString();
      assignmentRecord.outcome = operation.state === "running" || operation.state === "completed" || operation.state === "cancelled"
        ? "completed"
        : "failed";
      await writeOperationRecord(operation);
    }
    await captureObservedToolPathAfterStates(input.evidence, input.workspaceRoot, {
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
    });

    if (run.status === "failed" && !input.signal?.aborted && run.incidents.at(-1)?.retryable === true) {
      if (!inPlaceChildSettlementIsVerified(run.childProcesses, run.unmatchedChildExit)) {
        const message = "In-place executor failure is not eligible for failover because child-process settlement was not verified.";
        const incident = createIncident({
          attempt: operation.attempts.length,
          generation: operation.generation,
          cause: "process_exit",
          stage: "failover_settlement",
          message,
          retryable: false,
          terminalCode: "recovery_state_corrupt_or_unverifiable",
        });
        operation.incidents.push(incident);
        operation.state = "failed_critical";
        await writeOperationRecord(operation);
        run = { ...run, status: "failed", error: message };
      } else {
        const next = await input.acquireFailover?.(assignment);
        if (next) {
          for (const incident of run.incidents) {
            if (!incident.resolvedAt && incident.retryable) {
              incident.resolvedAt = new Date().toISOString();
              incident.resolution = "executor_pool_failover";
            }
          }
          input.onUpdate?.({
            phase: "executing",
            message: `executor failover: ${assignment.entry.entryId} -> ${next.entry.entryId} after configured recovery attempts; continuing in the same in-place workspace with no reset or rollback`,
            artifactDir,
            executorEntryId: next.entry.entryId,
            executorSelection: { ...next.entry.selection },
          });
          operation.generation += 1;
          operation.session = undefined;
          assignment = next;
          session = undefined;
          startingTurn = run.lastTurnNumber + 1;
          prompt = inPlaceFailoverPrompt(task, input.workspaceRoot, input.mode, input.feedback, run.error ?? "executor failure");
          reason = "failover";
          await writeOperationRecord(operation);
          continue;
        }
        failoverExhausted = Boolean(input.acquireFailover);
      }
    }

    const operationRecord = join(artifactDir, "operation.json");
    const common = {
      taskId,
      title: task.title,
      usage: run.turn?.usage,
      turn: run.turn,
      adapter: adapter.kind,
      model: adapter.model,
      session: run.turn?.session ?? session ?? operation.session ?? undefined,
      operationRecord,
      incidents: [...operation.incidents],
      attempts: operation.attempts.length,
      lastExecutorTurn: run.lastTurnNumber,
      effectiveAssignment: assignment,
      failoverExhausted,
    };
    if (run.status === "cancelled" || input.signal?.aborted) {
      input.onUpdate?.({
        phase: "completing",
        message: "in-place executor was cancelled; writes it already performed were not rolled back",
        artifactDir,
        adapter: adapter.kind,
        model: adapter.model,
      });
      return { ...common, status: "cancelled", summary: run.turn?.text ?? "In-place executor was cancelled.", error: run.error };
    }
    if (run.status !== "completed" || !run.turn) {
      const timedOut = run.error?.includes("timed out") ?? false;
      input.onUpdate?.({
        phase: "completing",
        message: timedOut ? "in-place executor timed out" : "in-place executor failed",
        artifactDir,
        adapter: adapter.kind,
        model: adapter.model,
      });
      return {
        ...common,
        status: timedOut ? "timeout" : "executor_error",
        summary: run.error ?? "In-place executor failed.",
        error: run.error ?? "In-place executor failed.",
      };
    }
    input.onUpdate?.({
      phase: "completing",
      message: "in-place executor turn completed; its writes remain in the workspace",
      artifactDir,
      adapter: adapter.kind,
      model: adapter.model,
    });
    return { ...common, status: "completed", summary: run.turn.text, session: run.turn.session };
  }
}

function inPlaceFailoverPrompt(
  task: WaveWorkerTask,
  workspaceRoot: string,
  mode: "initial" | "continuation",
  feedback: string | undefined,
  failure: string,
): string {
  return [
    "In-place executor failover (authoritative):",
    "A prior executor assignment failed or exhausted the configured same-adapter recovery attempts. Continue this same task directly in the existing launch-selected workspace.",
    `Selected workspace: ${workspaceRoot}. No wave capture, new launch baseline, workspace reset, checkpoint, rollback, or landing occurred. The original launch baseline remains authoritative.`,
    "Prior direct workspace writes, writes outside this workspace, and other external effects may already have occurred. Inspect the current workspace and relevant state before continuing; avoid repeating completed actions.",
    "The prior executor session/conversation is not transferred to this replacement. This is a fresh session; rely on the task, current workspace and state, and the incident below.",
    `Prior executor failure: ${failure}`,
    "",
    buildInPlacePrompt(task, workspaceRoot),
    ...(mode === "continuation" && feedback ? ["", "Current continuation instructions:", feedback] : []),
  ].join("\n");
}

// ── lifecycle types ──────────────────────────────────────────────────────────

/** Status of a complete in-place worker lifecycle (#220). No landing states exist. */
export type InPlaceLifecycleStatus =
  | "reviewed"
  | "unreviewed"
  | "no_changes"
  | "review_error"
  | "correction_cap"
  | "executor_error"
  | "timeout"
  | "cancelled"
  | "reviewer_blocked";

/** One in-place review cycle; the recorded workspace delta is the reviewed identity. */
export interface InPlaceReviewCycle {
  cycle: number;
  /** External-path evidence revision reviewed in this cycle; not a content identity. */
  externalObservationRevision?: number;
  verdict: import("../schema").ReviewResult["verdict"];
  reviewOutput: ReviewRunOutput;
  /** Workspace delta that was under review in this cycle. */
  changedSinceLaunch: ChangedFile[];
  /**
   * Content-anchored identity of the delta under review (#220 pass-1):
   * per-path launch/current content identities, not path names. A pass is
   * bound to THIS identity; any later content change re-enters review.
   */
  identity: string;
}

export interface InPlaceLifecycleResult {
  status: InPlaceLifecycleStatus;
  taskId: string;
  title: string;
  summary: string;
  adapter: string;
  model?: string;
  usage?: ExecutorTurn["usage"];
  error?: string;
  /** The workspace the worker ran and wrote in. */
  workspaceRoot: string;
  /** Launch-time attribution basis, retained for inspection and continuation flows. */
  baseline: InPlaceBaseline;
  /** Final recorded delta at lifecycle settlement. */
  changedSinceLaunch: Array<{ status: ChangedFile["status"]; path: string }>;
  /** Absolute tool-observed external path candidates, separate from the selected-root delta. */
  observedExternalPaths?: string[];
  /** Adapter/stream limitations; absence of an event is not evidence of no external action. */
  toolObservabilityNotes?: string[];
  toolObservationsTruncated?: boolean;
  /**
   * Set when the stop-time attribution could not be inspected against the
   * launch baseline: the workspace delta is then UNKNOWN, never zero, and
   * durable summaries/notices disclose the failure instead of claiming no
   * changes.
   */
  attributionError?: string;
  reviewCycles: InPlaceReviewCycle[];
  reviewReport?: SubtaskReviewReport;
  artifactDir: string;
  operationRecord: string;
  incidents?: ExecutionIncident[];
  attempts?: number;
  diagnostics?: import("./operation-record").OperationDiagnostics;
  lastExecutorTurn?: number;
  session?: ExecutorSession;
}

export interface InPlaceLifecycleInput extends InPlaceRunInput {
  /** Maximum correction cycles before settling. Defaults to config.maxCorrectionCycles. */
  maxCorrectionCycles?: number;
  /**
   * Pre-existing executor result: PRIOR-TURN CONTEXT ONLY (#220 pass-1). It
   * never satisfies a newly admitted continuation by itself — the requested
   * continuation is always dispatched; a non-completed prior result is
   * retained turn/session context, not this run's outcome.
   */
  initialResult?: InPlaceWorkerResult;
  /**
   * The verified launch-time attribution basis. A continuation must supply
   * the restored original basis; an omitted value means the lifecycle captures
   * and persists one (fresh dispatch or direct lifecycle use).
   */
  baseline?: InPlaceBaseline;
  /**
   * Authoritative continuation instructions for this dispatch (an admitted
   * in-place continuation, or a restored auto-resume). With a prior durable
   * result they resume the retained executor session before review; without
   * one they are folded into the initial dispatch prompt.
   */
  continuation?: { instructions: string };
}

function reportLifecycleProgress(input: InPlaceLifecycleInput, update: Omit<SubtaskProgressUpdate, "subtaskId">): void {
  input.onUpdate?.({ subtaskId: input.taskId, ...update });
}

// ── durable in-place review cycle records ────────────────────────────────────

/** Shape of the per-reviewer record inside a durable in-place review cycle. */
export interface InPlaceReviewCycleRecord {
  version: 1;
  taskId: string;
  waveId: "inplace";
  cycle: number;
  reviewSequence: number;
  completedAt: string;
  /** Identity marker: distinguishes in-place records from wave candidate records. */
  inPlace: true;
  attribution: {
    workspaceRoot: string;
    baseline: {
      mode: "git" | "non_git";
      gitHead?: string;
      capturedAt: string;
    };
    changedSinceLaunch: Array<{ status: string; path: string }>;
    /** SHA-256 of the content-anchored delta identity that was under review. */
    deltaIdentitySha256: string;
  };
  aggregate: import("../review-report").ReviewAggregateDisposition;
  summary: string;
  reviewers: import("../review-report").ReviewCycleRecord["reviewers"];
}

function buildInPlaceReviewCycleRecord(input: {
  taskId: string;
  cycle: number;
  reviewSequence: number;
  attribution: InPlaceAttribution;
  deltaIdentitySha256: string;
  reviewOutput: ReviewRunOutput;
}): InPlaceReviewCycleRecord {
  const gate = input.reviewOutput.result;
  const reviewers = (input.reviewOutput.reviewerResults ?? (gate ? [gate] : [])).map((reviewer) => ({
    reviewerId: reviewer.reviewerId,
    ...(reviewer.displayLabel !== undefined ? { displayLabel: reviewer.displayLabel } : {}),
    verdict: reviewer.verdict,
    summary: reviewer.summary,
    ...(reviewer.guidance !== undefined ? { guidance: reviewer.guidance } : {}),
    ...(reviewer.verdict === "error" && reviewer.error !== undefined ? { error: reviewer.error } : {}),
    findings: reviewer.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      issue: finding.issue,
      recommendation: finding.recommendation,
    })),
  }));
  return {
    version: 1,
    taskId: input.taskId,
    waveId: "inplace",
    cycle: input.cycle,
    reviewSequence: input.reviewSequence ?? input.cycle,
    completedAt: new Date().toISOString(),
    inPlace: true,
    attribution: {
      workspaceRoot: input.attribution.baseline.workspaceRoot,
      baseline: {
        mode: input.attribution.baseline.mode,
        ...(input.attribution.baseline.gitHead ? { gitHead: input.attribution.baseline.gitHead } : {}),
        capturedAt: input.attribution.baseline.capturedAt,
      },
      changedSinceLaunch: input.attribution.changes.map((change) => ({ status: change.status, path: change.path })),
      deltaIdentitySha256: input.deltaIdentitySha256,
    },
    aggregate: gate?.verdict === "pass" || gate?.verdict === "needs_changes" || gate?.verdict === "error"
      ? gate.verdict
      : "error",
    summary: gate?.summary ?? "Review completed without a gate result.",
    reviewers,
  };
}

/**
 * Write-once publication of one in-place cycle record, mirroring the #50
 * wave policy: an existing record is never overwritten, and a failed
 * publication leaves an explicit `.unpublished` marker instead of a silent
 * gap that would present an older readable cycle as current.
 */
/**
 * Allocate the next in-place review cycle number from the task's DURABLE
 * review artifacts (#220 pass-2, finding 2): both cycle records and their
 * unpublished markers count, so a resumed lifecycle never restarts at 1 and
 * never collides with a settled cycle's write-once record.
 */
export async function nextInPlaceReviewCycle(artifactDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(join(artifactDir, "reviews", "inplace"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 1;
    throw error;
  }
  return 1 + names.reduce((highest, name) => {
    const match = /^cycle-(\d{6})\.json(?:\.unpublished)?$/.exec(name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

async function persistInPlaceReviewCycleRecord(artifactDir: string, record: InPlaceReviewCycleRecord): Promise<void> {
  const path = join(artifactDir, "reviews", record.waveId, `cycle-${String(record.cycle).padStart(6, "0")}.json`);
  try {
    await atomicWriteExclusive(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    // #220 pass-2 (finding 2): an existing cycle file is a NUMBERING
    // collision for a NEW cycle — never successful publication. The caller
    // fails closed; the write-once semantics are enforced by the caller being
    // unable to skip or overwrite the prior record. Publication failures for
    // a genuinely-new cycle still leave the bounded unpublished marker.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") throw error;
    try {
      await atomicWriteExclusive(
        `${path}.unpublished`,
        `${JSON.stringify({
          version: 1,
          taskId: record.taskId,
          waveId: record.waveId,
          cycle: record.cycle,
          reviewSequence: record.reviewSequence,
          completedAt: record.completedAt,
          inPlace: true,
          aggregate: record.aggregate,
          summary: record.summary,
          reason: error instanceof Error ? `${error.message}`.slice(0, 200) : "publication failed",
        }, null, 2)}\n`,
      );
    } catch {
      // Both writes failed: readers report the newest readable cycle as latest
      // available with unknown completeness, never definitively current.
    }
  }
}

async function writeInPlaceResult(artifactDir: string, result: InPlaceLifecycleResult): Promise<void> {
  await writeFile(
    join(artifactDir, "result.json"),
    JSON.stringify({
      version: 1,
      inPlace: true,
      workspaceRoot: result.workspaceRoot,
      baseline: {
        mode: result.baseline.mode,
        ...(result.baseline.gitHead ? { gitHead: result.baseline.gitHead } : {}),
        capturedAt: result.baseline.capturedAt,
        omissions: result.baseline.snapshot.omissions.length,
        omissionsTruncated: result.baseline.snapshot.omissionsTruncated,
      },
      changedSinceLaunch: result.changedSinceLaunch,
      observedExternalPaths: result.observedExternalPaths ?? [],
      toolObservabilityNotes: result.toolObservabilityNotes ?? [],
      toolObservationsTruncated: result.toolObservationsTruncated === true,
      ...(result.attributionError ? { attributionError: result.attributionError } : {}),
      status: result.status,
      taskId: result.taskId,
      title: result.title,
      summary: result.summary,
      adapter: result.adapter,
      model: result.model,
      reviewCycles: result.reviewCycles.map((cycle) => ({
        cycle: cycle.cycle,
        verdict: cycle.verdict,
        changedSinceLaunchCount: cycle.changedSinceLaunch.length,
      })),
      reviewReport: result.reviewReport,
      operationRecord: result.operationRecord,
      incidents: result.incidents,
      attempts: result.attempts,
      diagnostics: result.diagnostics,
      error: result.error,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
}

async function operationStateFor(input: Pick<InPlaceLifecycleInput, "taskId" | "workspaceRoot" | "artifactDir" | "config" | "task">, result: InPlaceLifecycleResult): Promise<void> {
  const state = result.status === "reviewed" || result.status === "unreviewed" || result.status === "no_changes"
    ? "completed"
    : result.status === "cancelled"
      ? "cancelled"
      : "paused_recoverable";
  try {
    const operation = await readOperationRecord(join(input.artifactDir, "operation.json"));
    if (operation.state !== "failed_critical") operation.state = state;
    result.diagnostics = await buildOperationDiagnostics(operation, resolve(input.workspaceRoot));
    await writeOperationRecord(operation);
  } catch {
    // Best-effort diagnostics; the lifecycle result stays authoritative.
  }
}

/** Single settlement path: operation state, result.json, review report. */
async function settleInPlace(input: InPlaceLifecycleInput, result: InPlaceLifecycleResult): Promise<InPlaceLifecycleResult> {
  try {
    const evidence = JSON.parse(await readFile(join(result.artifactDir, IN_PLACE_OBSERVED_EVIDENCE_FILE), "utf8")) as {
      candidates?: Array<{ externalSideEffect?: unknown; absolutePath?: unknown }>;
      toolObservabilityNotes?: unknown;
      toolObservationsTruncated?: unknown;
    };
    result.observedExternalPaths = (evidence.candidates ?? [])
      .filter((candidate) => candidate.externalSideEffect === true && typeof candidate.absolutePath === "string")
      .map((candidate) => redactSensitiveText(candidate.absolutePath as string));
    result.toolObservabilityNotes = Array.isArray(evidence.toolObservabilityNotes)
      ? evidence.toolObservabilityNotes.filter((note): note is string => typeof note === "string")
      : [];
    result.toolObservationsTruncated = evidence.toolObservationsTruncated === true;
  } catch {
    result.observedExternalPaths ??= [];
    result.toolObservabilityNotes ??= [];
  }
  if (result.status === "no_changes") {
    const notes = result.toolObservabilityNotes ?? [];
    const snapshotLimits = ` Snapshot policy excludes ignored directories (including .git, node_modules, and dist) and may omit content for oversized or unreadable files; ${result.baseline.snapshot.omissions.length} omission(s) were recorded${result.baseline.snapshot.omissionsTruncated ? " and the omission list was truncated" : ""}.`;
    result.summary = `No workspace paths changed within the recorded bounded snapshot since launch. This does not establish that no external side effects occurred.${snapshotLimits}${notes.length > 0 ? ` Tool-event observability limits: ${notes.join("; ")}` : ""}${result.toolObservationsTruncated ? " The bounded tool-event evidence limit was reached; additional observations were omitted." : ""}`;
  }
  result.reviewReport ??= buildReviewReportFromOutputs({
    outputs: result.reviewCycles.map((cycle) => ({ reviewOutput: cycle.reviewOutput })),
    artifactDir: result.artifactDir,
  });
  // #220 pass-2 (finding 1): a failed, timed-out, interrupted, or otherwise
  // stopped lifecycle can leave writes the worker already performed. The
  // settle-time result must carry the REAL recorded workspace delta against
  // the launch baseline — never a fabricated empty delta; when inspection
  // fails the delta is reported as UNKNOWN via attributionError instead of
  // zero. Reviewed/unreviewed/no_changes already carry a settled delta.
  if (!["reviewed", "unreviewed", "no_changes"].includes(result.status)) {
    try {
      // Pass 3 (finding 1): the turn may have been cancelled, and its abort
      // signal aborts any dependent operation. Settlement runs AFTER the turn
      // has stopped, so inspect the writes left in place WITHOUT that
      // signal; genuine inspection failures still land in attributionError.
      const latest = await computeInPlaceAttribution(result.baseline, input.config);
      result.changedSinceLaunch = latest.changes.map(({ status, path }) => ({ status, path }));
    } catch (error) {
      result.attributionError = error instanceof Error ? error.message : String(error);
    }
  } else {
    delete result.attributionError;
  }
  await operationStateFor(input, result);
  await writeInPlaceResult(result.artifactDir, result);
  return result;
}

// ── main in-place lifecycle ──────────────────────────────────────────────────

/**
 * Run one complete in-place worker review/correction lifecycle (#220).
 *
 * 1. Freezes/validates the subtask reviewer selection (no-op unreviewed path
 *    when the automatic subtask-review toggle is off — issue #175).
 * 2. Captures the launch-time workspace baseline (bounded content snapshot
 *    plus the observed Git HEAD when the root is inside a repository).
 * 3. Runs the initial executor turn directly in the workspace.
 * 4. Computes the recorded workspace delta since launch; an empty in-root
 *    delta settles as no_changes only when no external tool-observed write
 *    evidence requires the own reviewer.
 * 5. Reviews that delta (snapshot scope, truthful attribution) and resumes
 *    the same executor session in the same workspace for correction on
 *    needs_changes, honoring maxCorrectionCycles and no-progress detection.
 * 6. On pass, transmits the pass for observation and resumes once; only an
 *    unchanged delta versus the passed cycle settles as reviewed; any new
 *    workspace change re-enters review.
 * 7. Writes result.json with the truthful status and attribution data.
 *
 * A verdict never represents a pre-write gate or a rollback: writes already
 * happened where performed, and concurrent third-party changes are never
 * attributed to the worker — reviewers are instructed to disclose uncertain
 * attribution instead.
 */
export async function runInplaceLifecycle(input: InPlaceLifecycleInput): Promise<InPlaceLifecycleResult> {
  const { taskId, task, workspaceRoot, config, scopedModels, signal } = input;
  const resolvedArtifactDir = await ensureArtifactDir(input.artifactDir, workspaceRoot);

  // Fail fast on an invalid subtask selection before any baseline is captured.
  try {
    freezeReviewers(config, scopedModels ?? []);
  } catch (error) {
    const blockedBaseline = await createInPlaceBaseline(workspaceRoot, config, signal);
    await persistInPlaceBaseline(blockedBaseline, taskId, resolvedArtifactDir);
    return await settleInPlace(input, {
      status: "reviewer_blocked",
      taskId,
      title: task.title,
      summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
      adapter: "none",
      error: error instanceof Error ? error.message : "Reviewer selection blocked.",
      workspaceRoot,
      baseline: blockedBaseline,
      changedSinceLaunch: [],
      reviewCycles: [],
      artifactDir: resolvedArtifactDir,
      operationRecord: join(resolvedArtifactDir, "operation.json"),
    });
  }

  reportLifecycleProgress(input, {
    phase: "starting",
    message: "in-place worker lifecycle starting",
    artifactDir: resolvedArtifactDir,
  });

  // #220 pass-1 correction: the launch baseline is durable and restored, never
  // re-captured per lifecycle invocation. A fresh dispatch (or a direct
  // lifecycle use) captures and persists the basis before the executor runs;
  // a continuation with a prior turn must load and verify the original basis
  // and fails closed when that is impossible — writes made before a pause
  // remain part of the original attribution window instead of silently
  // becoming the new baseline. A continuation without any prior turn is the
  // task's first effective dispatch and captures the basis now.
  const restoredBaseline = input.baseline ?? (
    input.continuation
      ? (input.initialResult
        ? await loadInPlaceBaseline(taskId, resolvedArtifactDir, workspaceRoot)
        : await (async () => {
          const captured = await createInPlaceBaseline(workspaceRoot, config, signal);
          await persistInPlaceBaseline(captured, taskId, resolvedArtifactDir);
          return captured;
        })())
      : await (async () => {
        const captured = await createInPlaceBaseline(workspaceRoot, config, signal);
        await persistInPlaceBaseline(captured, taskId, resolvedArtifactDir);
        return captured;
      })()
  );
  const baseline = restoredBaseline;
  // The review window exists from the very first turn so corrections, steering
  // evidence, and pass observation share one serial state like execute runs.
  const { window } = createWorkerReviewState();
  await restoreInPlaceObservedEvidence(window.evidence, resolvedArtifactDir, workspaceRoot);
  let effectiveAssignment = input.executorAssignment;
  type InPlaceTurnInput = Omit<Parameters<typeof runInplaceTurnWorker>[0], "executorAssignment" | "evidence" | "baseline">;
  const runTurn = async (turnInput: InPlaceTurnInput): Promise<InPlaceWorkerResult> => {
    try {
      const result = await runInplaceTurnWorker({
        ...turnInput,
        executorAssignment: effectiveAssignment,
        evidence: window.evidence,
        baseline,
      });
      effectiveAssignment = result.effectiveAssignment ?? effectiveAssignment;
      return result;
    } finally {
      await persistInPlaceObservedEvidence(window.evidence, resolvedArtifactDir);
    }
  };

  let currentResult: InPlaceWorkerResult;
  let lastExecutorTurn: number;
  // #220 pass-1 correction (finding 3): an admitted continuation is the
  // AUTHORITATIVE turn for its dispatch. Any retained prior result is
  // prior-turn context only — even a failed, timed-out, or cancelled one —
  // and is never treated as the continuation's outcome.
  if (input.continuation) {
    const prior = input.initialResult;
    const priorSession = prior?.session;
    const priorTurn = prior?.lastExecutorTurn ?? 0;
    if (!priorSession) {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "no resumable executor session survived the prior run; dispatching the admitted continuation with a fresh session disclosure",
        artifactDir: resolvedArtifactDir,
      });
    } else if (prior && prior.status !== "completed") {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: `the retained prior turn ended in ${prior.status}; it is prior-turn context only, and the requested continuation is dispatched now`,
        artifactDir: resolvedArtifactDir,
      });
    }
    let resumed: InPlaceWorkerResult;
    try {
      resumed = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: priorTurn + 1,
        feedback: input.continuation.instructions,
        ...(priorSession ? { priorSession } : {}),
      });
      lastExecutorTurn = resumed.lastExecutorTurn ?? priorTurn + 1;
    } catch (error) {
      return await settleInPlace(input, {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Continued executor failed.",
        adapter: "none",
        error: error instanceof Error ? error.message : "Continued executor failed.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: join(resolvedArtifactDir, "operation.json"),
        lastExecutorTurn: priorTurn,
        session: priorSession,
      });
    }
    if (resumed.status === "executor_error" && priorSession && !signal?.aborted && !resumed.failoverExhausted) {
      // One bounded fresh-session handoff: the retained session could not be
      // resumed, so the continuation re-runs in the same workspace with the
      // explicit fresh-session disclosure instead of staying bricked on a
      // dead session. Never retried further; failures settle paused.
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "the retained executor session could not be resumed; retrying once with a fresh session in the same workspace",
        artifactDir: resolvedArtifactDir,
      });
      try {
        const retried = await runTurn({
          ...input,
          mode: "continuation",
          startingTurn: priorTurn + 2,
          feedback: input.continuation.instructions,
          priorSession: undefined,
        });
        if (retried.status !== "completed") {
          if (retried.status === "cancelled" || signal?.aborted) {
            return await settleInPlace(input, {
              status: "cancelled",
              taskId,
              title: task.title,
              summary: retried.summary ?? "Continued in-place worker was cancelled.",
              adapter: retried.adapter,
              model: retried.model,
              usage: retried.usage,
              error: retried.error,
              workspaceRoot,
              baseline,
              changedSinceLaunch: [],
              reviewCycles: [],
              artifactDir: resolvedArtifactDir,
              operationRecord: retried.operationRecord,
              lastExecutorTurn: retried.lastExecutorTurn ?? priorTurn + 2,
              session: retried.session,
            });
          }
          return await settleInPlace(input, {
            status: retried.status === "timeout" ? "timeout" : "executor_error",
            taskId,
            title: task.title,
            summary: retried.summary ?? "Continued in-place worker stopped.",
            adapter: retried.adapter,
            model: retried.model,
            usage: retried.usage,
            error: retried.error,
            workspaceRoot,
            baseline,
            changedSinceLaunch: [],
            reviewCycles: [],
            artifactDir: resolvedArtifactDir,
            operationRecord: retried.operationRecord,
            lastExecutorTurn: retried.lastExecutorTurn ?? priorTurn + 2,
            session: retried.session,
          });
        }
        resumed = retried;
        lastExecutorTurn = retried.lastExecutorTurn ?? priorTurn + 2;
      } catch (error) {
        return await settleInPlace(input, {
          status: "executor_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Fresh-session continuation failed.",
          adapter: "none",
          error: error instanceof Error ? error.message : "Fresh-session continuation failed.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: join(resolvedArtifactDir, "operation.json"),
          lastExecutorTurn: priorTurn + 2,
          session: priorSession,
        });
      }
    }
    if (resumed.status !== "completed") {
      if (resumed.status === "cancelled" || signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: resumed.summary ?? "Continued in-place worker was cancelled.",
          adapter: resumed.adapter,
          model: resumed.model,
          usage: resumed.usage,
          error: resumed.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: resumed.operationRecord,
          lastExecutorTurn,
          session: resumed.session,
        });
      }
      return await settleInPlace(input, {
        status: resumed.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: resumed.summary ?? "Continued in-place worker stopped.",
        adapter: resumed.adapter,
        model: resumed.model,
        usage: resumed.usage,
        error: resumed.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: resumed.operationRecord,
        lastExecutorTurn,
        session: resumed.session,
      });
    }
    rememberFinalAssistantSummaryText(window.evidence, resumed.summary);
    currentResult = resumed;
  } else {
    if (input.initialResult) {
      // A retained result without continuation instructions has no
      // authoritative turn to run: admitting it as an outcome would
      // misattribute prior work as this run's result (fail closed).
      throw new Error(
        `An initialResult without continuation instructions has no authoritative turn; refusing to relabel prior context as a lifecycle outcome.`,
      );
    }
    try {
      currentResult = await runTurn({ ...input, mode: "initial", startingTurn: 1 });
    } catch (error) {
      return await settleInPlace(input, {
        status: "executor_error",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Executor failed.",
        adapter: "none",
        error: error instanceof Error ? error.message : "Executor failed.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: join(resolvedArtifactDir, "operation.json"),
      });
    }
    lastExecutorTurn = currentResult.lastExecutorTurn ?? 1;
    // Non-completed initial turn: nothing is attributed or reviewed. Writes
    // the worker already performed were NOT rolled back and are disclosed.
    if (currentResult.status !== "completed") {
      if (currentResult.status === "cancelled" || signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: currentResult.summary ?? "In-place worker was cancelled.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          usage: currentResult.usage,
          error: currentResult.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: [],
          reviewCycles: [],
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      return await settleInPlace(input, {
        status: currentResult.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: currentResult.summary ?? "In-place worker stopped.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        error: currentResult.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles: [],
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }
  }

  // ── review loop over recorded workspace deltas ──
  const reviewCycles: InPlaceReviewCycle[] = [];
  let nextReviewCycle = await nextInPlaceReviewCycle(resolvedArtifactDir);
  let correctionCount = 0;
  const baselineFor = async (): Promise<InPlaceAttribution> => await computeInPlaceAttribution(baseline, config, signal);

  // Attribution so far; refreshed after every executor turn.
  let attribution = await baselineFor();

  for (;;) {
    // Claim deferred steering that could not reach the completed live turn,
    // exactly like the execute lifecycle: each claimed instruction resumes
    // the executor before review.
    if (input.takeDeferredSteering) {
      const deferred = await input.takeDeferredSteering();
      for (const item of deferred) {
        reportLifecycleProgress(input, {
          phase: "correcting",
          message: `applying deferred steering before review: ${item.instructionId}`,
          artifactDir: resolvedArtifactDir,
        });
        const resumed = await runTurn({
          ...input,
          mode: "continuation",
          startingTurn: lastExecutorTurn + 1,
          feedback: [
            "The prior executor turn could not accept these newer steering instructions live.",
            "Apply them now before this task is reviewed; later instructions take precedence:",
            `- [${item.instructionId}] ${item.instruction}`,
            "Finish the revised work and report the replacement result.",
          ].join("\n"),
          priorSession: currentResult.session,
        });
        lastExecutorTurn = resumed.lastExecutorTurn ?? lastExecutorTurn + 1;
        if (resumed.status !== "completed") {
          const status: InPlaceLifecycleStatus =
            resumed.status === "cancelled" || signal?.aborted ? "cancelled"
              : resumed.status === "timeout" ? "timeout" : "executor_error";
          return await settleInPlace(input, {
            status,
            taskId,
            title: task.title,
            summary: resumed.summary ?? "Deferred-steering executor failed.",
            adapter: resumed.adapter,
            model: resumed.model,
            usage: resumed.usage,
            error: resumed.error,
            workspaceRoot,
            baseline,
            changedSinceLaunch: attribution.changes.map((change) => ({ status: change.status, path: change.path })),
            reviewCycles,
            artifactDir: resolvedArtifactDir,
            operationRecord: resumed.operationRecord,
            lastExecutorTurn,
            session: resumed.session,
          });
        }
        rememberFinalAssistantSummaryText(window.evidence, resumed.summary);
        currentResult = resumed;
        attribution = await baselineFor();
      }
    }

    const changedPaths = attribution.changes.map((change) => ({ status: change.status, path: change.path }));
    const currentDeltaIdentity = inPlaceDeltaIdentity(attribution);
    if (changedPaths.length === 0 && !window.evidence.requiresReview) {
      return await settleInPlace(input, {
        status: "no_changes",
        taskId,
        title: task.title,
        summary: currentResult.summary,
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: [],
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    let frozen: { frozenConfig: ReviewGateConfig; enabled: boolean };
    try {
      frozen = freezeReviewers(config, scopedModels ?? []);
    } catch (error) {
      return await settleInPlace(input, {
        status: "reviewer_blocked",
        taskId,
        title: task.title,
        summary: error instanceof Error ? error.message : "Reviewer selection blocked.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : "Reviewer selection blocked.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (!frozen.enabled) {
      // Automatic subtask review is off: the writes remain in place with no
      // verdict. Settled as reviewed by nobody, never as "accepted".
      return await settleInPlace(input, {
        status: "unreviewed",
        taskId,
        title: task.title,
        summary: currentResult.summary,
        adapter: currentResult.adapter,
        model: currentResult.model,
        usage: currentResult.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "In-place lifecycle cancelled.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    const reviewCycle = nextReviewCycle++;
    const reviewerLabels = resolveReviewers(frozen.frozenConfig).reviewers.map(reviewerProgressLabel);
    reportLifecycleProgress(input, {
      phase: "reviewing",
      message: `review cycle ${reviewCycle} over the recorded workspace delta`,
      artifactDir: resolvedArtifactDir,
      reviewCycle,
      reviewers: reviewerLabels,
    });

    // Review-interruption steers behave exactly like the execute lifecycle:
    // the in-flight review aborts, the executor resumes with the changed
    // request, and the replacement delta is freshly attributed and reviewed.
    const reviewAbort = new AbortController();
    const reviewSteering: Array<{ instruction: string; instructionId: string }> = [];
    const reviewSignal = signal ? AbortSignal.any([signal, reviewAbort.signal]) : reviewAbort.signal;
    input.onLiveControl?.({
      adapter: "review-gate",
      generation: Math.max(1, lastExecutorTurn),
      protocol: "review-to-executor-handoff-v1",
      capabilities: { steer: true, interrupt: false },
      steer: async (instruction: string, instructionId: string) => {
        reviewSteering.push({ instruction, instructionId });
        if (!reviewAbort.signal.aborted) reviewAbort.abort(new Error("review_interrupted_for_steering"));
        return {
          status: "acknowledged" as const,
          message: "Review interruption requested; steering will be applied in the next executor turn before review restarts.",
        };
      },
      interrupt: async () => ({
        status: "blocked" as const,
        message: "Use the task interrupt action to stop the complete task, including its active review.",
      }),
    });

    let reviewOutput: ReviewRunOutput;
    try {
      reviewOutput = await runCandidateReviewWithRecovery(
        () => runReview({
          cwd: workspaceRoot,
          request: buildInPlaceReviewRequest(task, attribution, window.evidence),
          before: baseline.snapshot,
          config: frozen.frozenConfig,
          evidence: window.evidence,
          window,
          correctionAttemptCount: correctionCount,
          signal: reviewSignal,
          onUpdate: (message: string) => {
            if (message) {
              reportLifecycleProgress(input, {
                phase: "reviewing",
                message,
                artifactDir: resolvedArtifactDir,
                reviewCycle,
                reviewers: reviewerLabels,
              });
            }
          },
        }),
        resolvedArtifactDir,
        config,
        reviewSignal,
      );
    } catch (error) {
      if (reviewSteering.length > 0 && !signal?.aborted) {
        reviewOutput = {
          changed: true,
          changes: [],
          result: { reviewerId: "gate", verdict: "error", summary: "Review interrupted for steering.", findings: [], error: "aborted" },
        };
      } else {
        return await settleInPlace(input, {
          status: "review_error",
          taskId,
          title: task.title,
          summary: error instanceof Error ? error.message : "Review infrastructure failed.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: error instanceof Error ? error.message : "review_error",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
    } finally {
      input.onLiveControl?.(undefined);
    }

    if (reviewSteering.length > 0 && !signal?.aborted) {
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: "review interrupted — applying higher-priority steering",
        artifactDir: resolvedArtifactDir,
      });
      if (signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: "In-place lifecycle cancelled before applying review-interrupting steering.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "Cancelled.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const steered = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: lastExecutorTurn + 1,
        feedback: [
          "The active review was interrupted because the user or orchestrator changed the requested work.",
          "Apply these newer instructions now; they take precedence over the workspace state that was being reviewed:",
          ...reviewSteering.map((item) => `- [${item.instructionId}] ${item.instruction}`),
          "Finish the revised work in place and report it for a fresh review.",
        ].join("\n"),
        priorSession: currentResult.session,
      });
      lastExecutorTurn = steered.lastExecutorTurn ?? lastExecutorTurn + 1;
      if (steered.status !== "completed") {
        const status: InPlaceLifecycleStatus =
          steered.status === "cancelled" || signal?.aborted ? "cancelled"
            : steered.status === "timeout" ? "timeout" : "executor_error";
        return await settleInPlace(input, {
          status,
          taskId,
          title: task.title,
          summary: steered.summary ?? "Steered executor failed.",
          adapter: steered.adapter,
          model: steered.model,
          usage: steered.usage,
          error: steered.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: steered.operationRecord,
          lastExecutorTurn,
          session: steered.session,
        });
      }
      rememberFinalAssistantSummaryText(window.evidence, steered.summary);
      currentResult = steered;
      attribution = await baselineFor();
      continue;
    }

    if (reviewOutput.result?.error === "aborted" || signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "Review was aborted.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "aborted",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    const verdict = reviewOutput.result?.verdict ?? "error";
    const cycle: InPlaceReviewCycle = {
      cycle: reviewCycle,
      externalObservationRevision: window.evidence.externalObservationRevision ?? 0,
      verdict,
      reviewOutput,
      changedSinceLaunch: attribution.changes,
      identity: currentDeltaIdentity,
    };
    reviewCycles.push(cycle);

    try {
      await persistInPlaceReviewCycleRecord(resolvedArtifactDir, buildInPlaceReviewCycleRecord({
        taskId,
        cycle: reviewCycle,
        reviewSequence: reviewOutput.reviewSequence ?? reviewCycle,
        attribution,
        deltaIdentitySha256: createHash("sha256").update(currentDeltaIdentity).digest("hex"),
        reviewOutput,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await settleInPlace(input, {
        status: "review_error",
        taskId,
        title: task.title,
        summary: `Persisting the durable in-place review cycle record failed (review cycle ${reviewCycle}); the review verdict is not trusted for a new cycle. ${message}`,
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: error instanceof Error ? error.message : message,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (verdict === "error") {
      return await settleInPlace(input, {
        status: "review_error",
        taskId,
        title: task.title,
        summary: reviewOutput.result?.summary ?? "Review errored.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: reviewOutput.result?.error ?? reviewOutput.error ?? "review_error",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }

    if (verdict === "needs_changes") {
      const maxCorrectionCycles = input.maxCorrectionCycles ?? config.maxCorrectionCycles;
      if (correctionCount >= maxCorrectionCycles) {
        return await settleInPlace(input, {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: `Correction cap reached after ${maxCorrectionCycles} cycle(s); the workspace keeps the current state with no passing review.`,
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: `Correction cap reached: ${maxCorrectionCycles}`,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const priorCycle = reviewCycles[reviewCycles.length - 2];
      if (priorCycle?.identity === currentDeltaIdentity
        && (priorCycle.externalObservationRevision ?? 0) === (window.evidence.externalObservationRevision ?? 0)) {
        return await settleInPlace(input, {
          status: "correction_cap",
          taskId,
          title: task.title,
          summary: "No progress: the recorded workspace delta is unchanged after correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "No progress detected.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }

      correctionCount += 1;
      reportLifecycleProgress(input, {
        phase: "correcting",
        message: `correction ${correctionCount}/${maxCorrectionCycles}`,
        artifactDir: resolvedArtifactDir,
      });
      if (signal?.aborted) {
        return await settleInPlace(input, {
          status: "cancelled",
          taskId,
          title: task.title,
          summary: "In-place lifecycle cancelled during correction.",
          adapter: currentResult.adapter,
          model: currentResult.model,
          error: "Cancelled.",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: currentResult.operationRecord,
          lastExecutorTurn,
          session: currentResult.session,
        });
      }
      const feedback = await buildReviewTransmission(
        reviewOutput,
        reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations"),
        reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles"),
        window.nextReviewSequence - 1,
        "correction_required",
      );
      const corrected = await runTurn({
        ...input,
        mode: "continuation",
        startingTurn: lastExecutorTurn + 1,
        feedback,
        priorSession: currentResult.session,
      });
      lastExecutorTurn = corrected.lastExecutorTurn ?? lastExecutorTurn + 1;
      if (corrected.status !== "completed") {
        const status: InPlaceLifecycleStatus =
          corrected.status === "cancelled" || signal?.aborted ? "cancelled"
            : corrected.status === "timeout" ? "timeout" : "executor_error";
        return await settleInPlace(input, {
          status,
          taskId,
          title: task.title,
          summary: corrected.summary ?? "Correction executor failed.",
          adapter: corrected.adapter,
          model: corrected.model,
          usage: corrected.usage,
          error: corrected.error,
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: corrected.operationRecord,
          lastExecutorTurn,
          session: corrected.session,
        });
      }
      rememberFinalAssistantSummaryText(window.evidence, corrected.summary);
      currentResult = corrected;
      attribution = await baselineFor();
      continue;
    }

    // ── pass: transmit for observation, resume once (mirrors execute) ──
    reportLifecycleProgress(input, {
      phase: "confirming",
      message: "review passed — confirming the workspace delta is unchanged",
      artifactDir: resolvedArtifactDir,
    });
    if (signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: "In-place lifecycle cancelled during pass confirmation.",
        adapter: currentResult.adapter,
        model: currentResult.model,
        error: "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: currentResult.operationRecord,
        lastExecutorTurn,
        session: currentResult.session,
      });
    }
    const passedDeltaIdentity = currentDeltaIdentity;
    const passedExternalRevision = window.evidence.externalObservationRevision ?? 0;
    const passedObservationsTruncated = window.evidence.toolObservationsTruncated === true;
    const passFeedback = await buildReviewTransmission(
      reviewOutput,
      reviewOutput.invocationDir ?? join(resolvedArtifactDir, "invocations"),
      reviewOutput.bundleDir ?? join(resolvedArtifactDir, "review-bundles"),
      window.nextReviewSequence - 1,
      "passed",
    );
    const confirmed = await runTurn({
      ...input,
      mode: "continuation",
      startingTurn: lastExecutorTurn + 1,
      feedback: passFeedback,
      priorSession: currentResult.session,
    });
    lastExecutorTurn = confirmed.lastExecutorTurn ?? lastExecutorTurn + 1;
    if (confirmed.status === "cancelled" || signal?.aborted) {
      return await settleInPlace(input, {
        status: "cancelled",
        taskId,
        title: task.title,
        summary: confirmed.summary ?? "In-place lifecycle cancelled during pass confirmation.",
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        error: confirmed.error ?? "Cancelled.",
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    if (confirmed.status !== "completed") {
      return await settleInPlace(input, {
        status: confirmed.status === "timeout" ? "timeout" : "executor_error",
        taskId,
        title: task.title,
        summary: confirmed.summary ?? "Confirmation executor failed.",
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        error: confirmed.error,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    const confirmAttribution = await baselineFor();
    if (inPlaceDeltaIdentity(confirmAttribution) === passedDeltaIdentity
      && (window.evidence.externalObservationRevision ?? 0) === passedExternalRevision
      && (window.evidence.toolObservationsTruncated === true) === passedObservationsTruncated) {
      // The pass is tied to the exact reviewed workspace delta and the same
      // bounded external-observation state; neither new root changes nor new
      // external observations appeared during confirmation.
      const passedCycle = reviewCycles[reviewCycles.length - 1];
      if (!passedCycle || passedCycle.cycle !== reviewCycle) {
        return await settleInPlace(input, {
          status: "review_error",
          taskId,
          title: task.title,
          summary: "The passing review cycle could not be identified for settlement.",
          adapter: confirmed.adapter,
          model: confirmed.model,
          error: "pass cycle identity missing",
          workspaceRoot,
          baseline,
          changedSinceLaunch: changedPaths,
          reviewCycles,
          artifactDir: resolvedArtifactDir,
          operationRecord: confirmed.operationRecord,
          lastExecutorTurn,
          session: confirmed.session,
        });
      }
      const withWarnings = hasPartialReviewerFailure(reviewOutput.reviewerResults);
      return await settleInPlace(input, {
        status: "reviewed",
        taskId,
        title: task.title,
        summary: withWarnings
          ? `${confirmed.summary}\n\nReview passed with reviewer infrastructure warnings. The reviewed workspace delta is unchanged since the passed review; the changes remain in place.`
          : `${confirmed.summary}\n\nReview passed and the reviewed workspace delta is unchanged since the passed review; the changes remain in place.`,
        adapter: confirmed.adapter,
        model: confirmed.model,
        usage: confirmed.usage,
        workspaceRoot,
        baseline,
        changedSinceLaunch: changedPaths,
        reviewCycles,
        artifactDir: resolvedArtifactDir,
        operationRecord: confirmed.operationRecord,
        lastExecutorTurn,
        session: confirmed.session,
      });
    }
    // The workspace changed after the pass: the old pass is invalid and the
    // new delta must be reviewed (the review verdict is post-hoc; the writes
    // that produced this new delta were already performed either way).
    rememberFinalAssistantSummaryText(window.evidence, confirmed.summary);
    currentResult = confirmed;
    attribution = confirmAttribution;
    continue;
  }
}
