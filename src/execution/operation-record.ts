import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExecutorSession } from "./types";
import type { TerminalSafetyCode } from "./terminal-safety";
import type { ExecutorSelection } from "../config";

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
  terminalCode?: TerminalSafetyCode;
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

export interface ExecutorAssignmentRecord {
  entryId: string;
  priority: number;
  selection: ExecutorSelection;
  generation: number;
  reason: "initial" | "failover" | "continuation";
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "superseded";
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

export interface OperationOwnerLease {
  version: 1;
  instanceId: string;
  hostPid: number;
  acquiredAt: string;
  heartbeatAt: string;
  status: "active" | "released";
  childPid?: number;
  childProcessGroupId?: number;
  childStartedAt?: string;
  childExitedAt?: string;
  releasedAt?: string;
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
  executorEntryId?: string;
  executorPriority?: number;
  executorSelection?: ExecutorSelection;
  session?: ExecutorSession;
  generation: number;
  retryBudget: number;
  assignments: ExecutorAssignmentRecord[];
  attempts: ExecutionAttemptRecord[];
  incidents: ExecutionIncident[];
  checkpoint?: RecoveryCheckpoint;
  instructions: OperationInstruction[];
  nextInstructionSequence: number;
  owner?: OperationOwnerLease;
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
  executor: {
    adapter?: string;
    model?: string;
    entryId?: string;
    priority?: number;
    selection?: ExecutorSelection;
    processAlive: boolean;
  };
  session: { id?: string; generation: number; resumable: boolean };
  workspace: {
    worktree: string;
    effectiveCwd: string;
    recoverable: boolean;
    changedPaths: string[];
  };
  checkpoint?: RecoveryCheckpoint;
  attempts: ExecutionAttemptRecord[];
  assignments: ExecutorAssignmentRecord[];
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

const PROCESS_INSTANCE_ID = randomUUID();

export function acquireOperationOwner(record: OperationRecord): OperationOwnerLease {
  const now = new Date().toISOString();
  const owner: OperationOwnerLease = {
    version: 1,
    instanceId: PROCESS_INSTANCE_ID,
    hostPid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
    status: "active",
  };
  record.owner = owner;
  return owner;
}

export function recordOperationChildProcess(record: OperationRecord, childPid: number, childProcessGroupId?: number): void {
  if (!record.owner || record.owner.status !== "active") acquireOperationOwner(record);
  const now = new Date().toISOString();
  record.owner!.childPid = childPid;
  record.owner!.childProcessGroupId = childProcessGroupId;
  record.owner!.childStartedAt = now;
  record.owner!.childExitedAt = undefined;
  record.owner!.heartbeatAt = now;
}

export function recordOperationChildExit(record: OperationRecord): void {
  if (!record.owner) return;
  const now = new Date().toISOString();
  record.owner.childExitedAt = now;
  record.owner.heartbeatAt = now;
}

export function touchOperationOwner(record: OperationRecord): void {
  if (record.owner?.status === "active") record.owner.heartbeatAt = new Date().toISOString();
}

export function releaseOperationOwner(record: OperationRecord): void {
  if (!record.owner) return;
  const now = new Date().toISOString();
  record.owner.status = "released";
  record.owner.releasedAt = now;
  record.owner.heartbeatAt = now;
}

export interface OperationOwnershipStatus {
  status: "released" | "live" | "dead" | "uncertain";
  processAlive: boolean;
  hostAlive: boolean;
  childAlive: boolean;
  message: string;
}

export function operationOwnershipStatus(record: OperationRecord): OperationOwnershipStatus {
  const owner = record.owner;
  if (!owner || owner.status === "released") {
    return {
      status: "released",
      processAlive: false,
      hostAlive: false,
      childAlive: false,
      message: owner ? "The prior writer released its durable ownership lease." : "No durable writer lease is recorded.",
    };
  }
  const host = pidStatus(owner.hostPid);
  const child = owner.childExitedAt
    ? "dead"
    : owner.childProcessGroupId && process.platform !== "win32"
      ? processGroupStatus(owner.childProcessGroupId)
      : owner.childPid ? pidStatus(owner.childPid) : "dead";
  if (host === "live" || child === "live") {
    return {
      status: "live",
      processAlive: true,
      hostAlive: host === "live",
      childAlive: child === "live",
      message: child === "live"
        ? `Executor process ${owner.childPid} may still own the worktree.`
        : `Application process ${owner.hostPid} may still own the operation.`,
    };
  }
  if (host === "uncertain" || child === "uncertain") {
    return {
      status: "uncertain",
      processAlive: true,
      hostAlive: host !== "dead",
      childAlive: child !== "dead",
      message: "Writer liveness could not be proven; mutation remains blocked.",
    };
  }
  return {
    status: "dead",
    processAlive: false,
    hostAlive: false,
    childAlive: false,
    message: "The recorded application and executor processes are no longer alive.",
  };
}

function pidStatus(pid: number): "live" | "dead" | "uncertain" {
  if (!Number.isInteger(pid) || pid <= 0) return "uncertain";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "live";
    return "uncertain";
  }
}

function processGroupStatus(processGroupId: number): "live" | "dead" | "uncertain" {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return "uncertain";
  try {
    process.kill(-processGroupId, 0);
    return "live";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "live";
    return "uncertain";
  }
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
    assignments: [],
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

const operationWriteTails = new Map<string, Promise<void>>();

export async function writeOperationRecord(record: OperationRecord): Promise<void> {
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
  const path = operationRecordPath(record.artifactDir);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const previous = operationWriteTails.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const temporary = `${path}.tmp.${randomUUID()}`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, path);
  });
  operationWriteTails.set(path, operation);
  try {
    await operation;
  } finally {
    if (operationWriteTails.get(path) === operation) operationWriteTails.delete(path);
  }
}

export async function readOperationRecord(path: string): Promise<OperationRecord> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isOperationRecord(parsed)) throw new Error(`Invalid operation record: ${path}`);
  const record = parsed as OperationRecord;
  record.assignments ??= [];
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
  const recoverable = Boolean(record.checkpoint?.verified) && !critical;
  const ownership = operationOwnershipStatus(record);
  const canContinue = recoverable && !ownership.processAlive;
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
    executor: {
      adapter: record.adapter,
      model: record.model,
      entryId: record.executorEntryId,
      priority: record.executorPriority,
      selection: record.executorSelection,
      processAlive: ownership.processAlive,
    },
    session: { id: record.session?.id, generation: record.generation, resumable: !critical && Boolean(record.checkpoint?.verified) },
    workspace: {
      worktree: record.worktreeRoot,
      effectiveCwd: record.effectiveCwd,
      recoverable,
      changedPaths: record.checkpoint?.changedPaths ?? [],
    },
    checkpoint: record.checkpoint,
    attempts: record.attempts,
    assignments: record.assignments,
    incidents: record.incidents,
    instructions: record.instructions,
    artifacts: inventory.artifacts,
    recovery: {
      bundle: createReattachmentBundle(record, waveRoot),
      safeActions: canContinue ? ["inspect", "continue"] : ["inspect"],
      blockedActions: [
        { action: "steer", reason: ownership.status === "live" ? "The executor is live, but foreground adapters do not yet accept steering." : "No live executor process owns this foreground operation." },
        ...(ownership.processAlive ? [{ action: "continue", reason: ownership.message }] : []),
        ...(!recoverable && !completed ? [{ action: "continue", reason: "A verified checkpoint and safe resumable state are required." }] : []),
      ],
      recommendedAction: completed
        ? "No recovery is required."
        : ownership.processAlive
          ? "Inspect again after the recorded writer exits; do not start another writer."
          : recoverable
            ? "Call inspect, then continue with the current bundle."
            : "Inspect the retained artifacts before choosing a manual recovery path.",
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
