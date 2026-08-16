import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExecutorSession } from "./types";

export type OperationState =
  | "running"
  | "compacting"
  | "retrying"
  | "reviewing"
  | "paused_recoverable"
  | "failed_critical"
  | "cancelled"
  | "completed"
  | "landed";

export type IncidentCause =
  | "interruption"
  | "compaction_error"
  | "exception"
  | "process_exit"
  | "provider_error"
  | "protocol_error"
  | "timeout"
  | "workspace_error"
  | "review_error"
  | "integration_error"
  | "landing_error";

export interface ExecutionIncident {
  incidentId: string;
  attempt: number;
  generation: number;
  cause: IncidentCause;
  stage: string;
  message: string;
  retryable: boolean;
  terminalCode?: string;
  occurredAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface ExecutionAttemptRecord {
  attempt: number;
  generation: number;
  turn: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "retry" | "cancelled" | "failed";
  incidentId?: string;
  sessionId?: string;
}

export interface RecoveryCheckpoint {
  checkpointId: string;
  commitSha: string;
  treeSha: string;
  ref: string;
  differsFromBase: boolean;
  createdAt: string;
  verified: boolean;
  changedPaths: string[];
}

export interface OperationInstruction {
  instructionId: string;
  sequence: number;
  action: "continue" | "steer";
  text: string;
  status: "queued" | "delivered" | "acknowledged" | "failed";
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  error?: string;
}

export interface ReattachmentBundle {
  version: 1;
  operationId: string;
  waveId: string;
  taskId: string;
  waveRoot: string;
  expectedRevision: number;
}

export interface OperationRecord {
  version: 1;
  revision: number;
  operationId: string;
  waveId: string;
  taskId: string;
  title: string;
  state: OperationState;
  worktreeRoot: string;
  effectiveCwd: string;
  artifactDir: string;
  adapter?: string;
  model?: string;
  session?: ExecutorSession;
  generation: number;
  retryBudget: number;
  attempts: ExecutionAttemptRecord[];
  incidents: ExecutionIncident[];
  checkpoint?: RecoveryCheckpoint;
  instructions: OperationInstruction[];
  nextInstructionSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperationDiagnostics {
  version: 1;
  operationId: string;
  waveId: string;
  taskId: string;
  title: string;
  state: OperationState;
  disposition: "completed" | "resume_session" | "pause_recoverable" | "cancel" | "fail_critical";
  critical: boolean;
  retryable: boolean;
  retriesUsed: number;
  retriesRemaining: number;
  executor: { adapter?: string; model?: string; processAlive: false };
  session: { id?: string; generation: number; resumable: boolean };
  workspace: {
    worktree: string;
    effectiveCwd: string;
    recoverable: boolean;
    changedPaths: string[];
  };
  checkpoint?: RecoveryCheckpoint;
  attempts: ExecutionAttemptRecord[];
  incidents: ExecutionIncident[];
  instructions: OperationInstruction[];
  artifacts: Array<{ path: string; sizeBytes: number; sha256?: string; hashOmitted?: string }>;
  recovery: {
    bundle: ReattachmentBundle;
    safeActions: string[];
    blockedActions: Array<{ action: string; reason: string }>;
    recommendedAction: string;
  };
  disclosure: {
    rawStreamsInlined: false;
    secretsRedactedFromToolResponse: true;
    artifactInventoryLimit: number;
    artifactInventoryTruncated: boolean;
    artifactHashLimitBytes: number;
  };
}

export function operationRecordPath(artifactDir: string): string {
  return join(artifactDir, "operation.json");
}

export function createOperationRecord(input: {
  waveId: string;
  taskId: string;
  title: string;
  worktreeRoot: string;
  effectiveCwd: string;
  artifactDir: string;
  retryBudget: number;
}): OperationRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    revision: 0,
    operationId: `${input.waveId}/${input.taskId}`,
    waveId: input.waveId,
    taskId: input.taskId,
    title: input.title,
    state: "running",
    worktreeRoot: input.worktreeRoot,
    effectiveCwd: input.effectiveCwd,
    artifactDir: input.artifactDir,
    generation: 0,
    retryBudget: input.retryBudget,
    attempts: [],
    incidents: [],
    instructions: [],
    nextInstructionSequence: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function createIncident(input: Omit<ExecutionIncident, "incidentId" | "occurredAt">): ExecutionIncident {
  return {
    ...input,
    incidentId: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
}

export async function writeOperationRecord(record: OperationRecord): Promise<void> {
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
  const path = operationRecordPath(record.artifactDir);
  const temporary = `${path}.tmp.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function readOperationRecord(path: string): Promise<OperationRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isOperationRecord(parsed)) throw new Error(`Invalid operation record: ${path}`);
  const record = parsed as OperationRecord;
  record.instructions ??= [];
  record.nextInstructionSequence ??= record.instructions.length + 1;
  return record;
}

export function createReattachmentBundle(record: OperationRecord, waveRoot: string): ReattachmentBundle {
  return {
    version: 1,
    operationId: record.operationId,
    waveId: record.waveId,
    taskId: record.taskId,
    waveRoot,
    expectedRevision: record.revision,
  };
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.revision === "number"
    && typeof record.operationId === "string"
    && typeof record.waveId === "string"
    && typeof record.taskId === "string"
    && typeof record.artifactDir === "string"
    && Array.isArray(record.attempts)
    && Array.isArray(record.incidents)
    && (record.instructions === undefined || Array.isArray(record.instructions));
}

export async function buildOperationDiagnostics(record: OperationRecord, waveRoot: string): Promise<OperationDiagnostics> {
  const critical = record.state === "failed_critical";
  const cancelled = record.state === "cancelled";
  const completed = record.state === "completed" || record.state === "landed";
  const recoverable = Boolean(record.checkpoint?.verified) && !critical && !cancelled;
  const inventory = await artifactInventory(record.artifactDir);
  return {
    version: 1,
    operationId: record.operationId,
    waveId: record.waveId,
    taskId: record.taskId,
    title: record.title,
    state: record.state,
    disposition: completed ? "completed" : critical ? "fail_critical" : cancelled ? "cancel" : recoverable ? "resume_session" : "pause_recoverable",
    critical,
    retryable: recoverable,
    retriesUsed: Math.max(0, record.attempts.length - 1),
    retriesRemaining: Math.max(0, record.retryBudget - Math.max(0, record.attempts.length - 1)),
    executor: { adapter: record.adapter, model: record.model, processAlive: false },
    session: { id: record.session?.id, generation: record.generation, resumable: Boolean(record.session) && !critical },
    workspace: {
      worktree: record.worktreeRoot,
      effectiveCwd: record.effectiveCwd,
      recoverable,
      changedPaths: record.checkpoint?.changedPaths ?? [],
    },
    checkpoint: record.checkpoint,
    attempts: record.attempts,
    incidents: record.incidents,
    instructions: record.instructions,
    artifacts: inventory.artifacts,
    recovery: {
      bundle: createReattachmentBundle(record, waveRoot),
      safeActions: recoverable ? ["inspect", "continue"] : ["inspect"],
      blockedActions: [
        { action: "steer", reason: "No live executor process owns this foreground operation." },
        ...(!recoverable && !completed ? [{ action: "continue", reason: "A verified checkpoint and safe resumable state are required." }] : []),
      ],
      recommendedAction: completed ? "No recovery is required." : recoverable ? "Call inspect, then continue with the current bundle." : "Inspect the retained artifacts before choosing a manual recovery path.",
    },
    disclosure: {
      rawStreamsInlined: false,
      secretsRedactedFromToolResponse: true,
      artifactInventoryLimit: inventory.limit,
      artifactInventoryTruncated: inventory.truncated,
      artifactHashLimitBytes: inventory.hashLimitBytes,
    },
  };
}

async function artifactInventory(root: string): Promise<{
  artifacts: OperationDiagnostics["artifacts"];
  limit: number;
  truncated: boolean;
  hashLimitBytes: number;
}> {
  const limit = 256;
  const hashLimitBytes = 8 * 1024 * 1024;
  const discovered = await listFiles(root, limit + 1);
  const paths = discovered.slice(0, limit);
  const artifacts = await Promise.all(paths.map(async (path) => {
    const info = await stat(path);
    if (info.size > hashLimitBytes) {
      return { path, sizeBytes: info.size, hashOmitted: "artifact exceeds 8 MiB diagnostic hashing limit" };
    }
    const content = await readFile(path);
    return { path, sizeBytes: info.size, sha256: createHash("sha256").update(content).digest("hex") };
  }));
  return { artifacts, limit, truncated: discovered.length > limit, hashLimitBytes };
}

async function listFiles(root: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (result.length >= limit) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result;
}
