/**
 * Durable background-execution group and task-archive format mechanics
 * (finding 13): manifest/archive serialization, integrity hashing and
 * validation, bounded history normalization on read, and the guarded durable
 * read/write primitives. On-disk compatibility is fixed here:
 * - GROUP_VERSION=2 manifests, legacy v1 manifests restored in place,
 * - task archives at version 1 with their own integrity hash,
 * - exact JSON bytes (2-space indent plus trailing newline),
 * - archive reuse keyed by task updatedAt.
 * Save-tail ordering and the archived-task cache remain caller-owned (the
 * controller), so L9 quiescence semantics do not move with this module.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite } from "./durable-write";
import {
  clipActivity,
  cloneTask,
  isArchivableTaskState,
  normalizeTaskHistory,
  taskTiming,
  type BackgroundTaskDefinition,
  type BackgroundTaskKind,
  type BackgroundTaskRecord,
  type BackgroundTaskTimingSummary,
} from "./task-state";

export const GROUP_VERSION = 2;
/** @legacy v1 manifests stored every task inline; they are restored, never written. */
export const LEGACY_GROUP_VERSION = 1;
export const TASK_ARCHIVE_VERSION = 1;

export interface BackgroundExecutionGroup {
  version: 2;
  revision: number;
  integritySha256: string;
  executionId: string;
  kind: BackgroundTaskKind;
  root: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  peakConcurrency?: number;
  tasks: BackgroundTaskRecord[];
}

export interface ArchivedBackgroundTaskReference {
  archived: true;
  taskId: string;
  title: string;
  state: "landed" | "reported";
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
  timing: BackgroundTaskTimingSummary;
  archivePath: string;
  archiveIntegritySha256: string;
}

export interface PersistedBackgroundExecutionGroup extends Omit<BackgroundExecutionGroup, "tasks" | "version"> {
  version: 1 | 2;
  tasks: Array<BackgroundTaskRecord | ArchivedBackgroundTaskReference>;
}

export interface PersistedBackgroundTaskArchive {
  version: 1;
  taskId: string;
  archivedAt: string;
  integritySha256: string;
  task: BackgroundTaskRecord;
}

export interface ReadGroupResult {
  group: BackgroundExecutionGroup;
  archives: Map<string, { updatedAt: string; integritySha256: string }>;
}

/** Integrity handle the caller keeps for settled tasks so archive writes can be reused. */
export interface PriorArchiveRecord {
  updatedAt: string;
  integritySha256: string;
}

/** One durable task-archive write derived from serialization (body is exact JSON bytes). */
export interface ArchivedGroupWrite {
  taskId: string;
  updatedAt: string;
  integritySha256: string;
  path: string;
  body: string;
}

export interface SerializedGroupSnapshot {
  snapshot: PersistedBackgroundExecutionGroup;
  archiveWrites: ArchivedGroupWrite[];
}

function isArchivedTaskReference(task: BackgroundTaskRecord | ArchivedBackgroundTaskReference): task is ArchivedBackgroundTaskReference {
  return "archived" in task && task.archived === true;
}

function taskArchivePath(taskId: string): string {
  return join("tasks", `${taskId}.json`);
}

function createTaskArchive(task: BackgroundTaskRecord): { snapshot: PersistedBackgroundTaskArchive } {
  const unsigned = {
    version: TASK_ARCHIVE_VERSION as 1,
    taskId: task.taskId,
    archivedAt: new Date().toISOString(),
    task: cloneTask(task),
  };
  const snapshot: PersistedBackgroundTaskArchive = {
    ...unsigned,
    integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
  return { snapshot };
}

/**
 * Serialize a group for durable storage without writing: landed/reported tasks
 * become bounded archived references (backed by versioned archive documents),
 * active tasks are deep-cloned inline, task history is normalized in place,
 * and the manifest integrity hash is computed over the exact persisted shape.
 * The live group's integritySha256 is synchronized with the snapshot. Pure
 * aside from that in-place normalization; no I/O happens here.
 */
export function serializeGroupSnapshot(
  group: BackgroundExecutionGroup,
  priorArchives: ReadonlyMap<string, PriorArchiveRecord>,
): SerializedGroupSnapshot {
  const archiveWrites: ArchivedGroupWrite[] = [];
  const persistedTasks = group.tasks.map((task): BackgroundTaskRecord | ArchivedBackgroundTaskReference => {
    normalizeTaskHistory(task);
    if (!isArchivableTaskState(task.state)) return cloneTask(task);
    const priorArchive = priorArchives.get(task.taskId);
    let archiveIntegritySha256 = priorArchive?.updatedAt === task.updatedAt
      ? priorArchive.integritySha256
      : undefined;
    if (!archiveIntegritySha256) {
      const archive = createTaskArchive(task);
      archiveIntegritySha256 = archive.snapshot.integritySha256;
      archiveWrites.push({
        taskId: task.taskId,
        updatedAt: task.updatedAt,
        integritySha256: archiveIntegritySha256,
        path: join(group.root, taskArchivePath(task.taskId)),
        body: `${JSON.stringify(archive.snapshot, null, 2)}\n`,
      });
    }
    return {
      archived: true,
      taskId: task.taskId,
      title: task.definition.title,
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      summary: task.summary ? clipActivity(task.summary, 500) : undefined,
      error: task.error ? clipActivity(task.error, 500) : undefined,
      timing: taskTiming(task),
      archivePath: taskArchivePath(task.taskId),
      archiveIntegritySha256,
    };
  });
  const snapshot = JSON.parse(JSON.stringify({ ...group, version: GROUP_VERSION, tasks: persistedTasks })) as PersistedBackgroundExecutionGroup;
  const unsigned = { ...snapshot, integritySha256: undefined };
  snapshot.integritySha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  group.integritySha256 = snapshot.integritySha256;
  return { snapshot, archiveWrites };
}

/**
 * Durable write primitive: archives first, then the group manifest, each as
 * exact JSON bytes via atomic write. Callers own ordering across groups.
 */
export async function writeGroupSnapshot(root: string, serialized: SerializedGroupSnapshot): Promise<void> {
  for (const archive of serialized.archiveWrites) await atomicWrite(archive.path, archive.body);
  await atomicWrite(join(root, "execution.json"), `${JSON.stringify(serialized.snapshot, null, 2)}\n`);
}

export async function readGroup(root: string): Promise<ReadGroupResult> {
  const resolved = await realpath(resolve(root));
  if (!basename(resolved).startsWith("pi-review-execution-")) throw new Error("Invalid background execution root.");
  const parsed = JSON.parse(await readFile(join(resolved, "execution.json"), "utf8")) as PersistedBackgroundExecutionGroup;
  if ((parsed.version !== GROUP_VERSION && parsed.version !== LEGACY_GROUP_VERSION) || parsed.root !== resolved || !parsed.executionId || !Array.isArray(parsed.tasks)) {
    throw new Error("Invalid background execution manifest.");
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify({ ...unsigned, integritySha256: undefined })).digest("hex");
  if (!integritySha256 || integritySha256 !== actual) throw new Error("Background execution manifest failed its integrity check.");
  const archives = new Map<string, { updatedAt: string; integritySha256: string }>();
  const tasks: BackgroundTaskRecord[] = [];
  for (const persistedTask of parsed.tasks) {
    const task = isArchivedTaskReference(persistedTask)
      ? await readTaskArchive(resolved, persistedTask)
      : persistedTask;
    delete (task as BackgroundTaskRecord & { matchedWakePatterns?: string[] }).matchedWakePatterns;
    delete (task.definition as BackgroundTaskDefinition & { wakeOn?: unknown }).wakeOn;
    normalizeTaskHistory(task);
    tasks.push(task);
    if (isArchivedTaskReference(persistedTask)) {
      archives.set(task.taskId, { updatedAt: task.updatedAt, integritySha256: persistedTask.archiveIntegritySha256 });
    }
  }
  const group = {
    ...parsed,
    version: GROUP_VERSION,
    tasks,
    kind: parsed.kind ?? (tasks.some((task) => task.definition.backgroundKind === "research") ? "research" : "execute"),
    peakConcurrency: parsed.peakConcurrency ?? 0,
  } as BackgroundExecutionGroup;
  return { group, archives };
}

async function readTaskArchive(root: string, reference: ArchivedBackgroundTaskReference): Promise<BackgroundTaskRecord> {
  const expectedPath = taskArchivePath(reference.taskId);
  if (reference.archivePath !== expectedPath) throw new Error(`Invalid archive path for task ${reference.taskId}.`);
  const parsed = JSON.parse(await readFile(join(root, expectedPath), "utf8")) as PersistedBackgroundTaskArchive;
  if (parsed.version !== TASK_ARCHIVE_VERSION || parsed.taskId !== reference.taskId || parsed.task?.taskId !== reference.taskId) {
    throw new Error(`Invalid background task archive for ${reference.taskId}.`);
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (!integritySha256 || integritySha256 !== actual || integritySha256 !== reference.archiveIntegritySha256) {
    throw new Error(`Background task archive failed its integrity check: ${reference.taskId}.`);
  }
  if (!isArchivableTaskState(parsed.task.state) || parsed.task.state !== reference.state) {
    throw new Error(`Background task archive state does not match its execution manifest: ${reference.taskId}.`);
  }
  return parsed.task;
}

export async function removeOwnedWaveRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  const temporaryRoot = await realpath(resolve(tmpdir()));
  if (!basename(resolved).startsWith("wave-") || dirname(resolved) !== temporaryRoot) {
    throw new Error(`Refusing to remove unrecognized wave root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function removeOwnedExecutionRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  const temporaryRoot = await realpath(resolve(tmpdir()));
  if (!basename(resolved).startsWith("pi-review-execution-") || dirname(resolved) !== temporaryRoot) {
    throw new Error(`Refusing to remove unrecognized execution root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
