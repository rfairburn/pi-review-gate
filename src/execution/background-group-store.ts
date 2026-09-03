/**
 * Durable background-execution group and task-archive format mechanics
 * (finding 13): manifest/archive serialization, integrity hashing and
 * validation, bounded history normalization on read, and the guarded durable
 * read/write primitives. On-disk compatibility is fixed here:
 * - GROUP_VERSION=3 manifests (bounded inline settled window plus truthful
 *   lifetime/settled aggregate counts), legacy v1/v2 manifests restored in
 *   place without eagerly hydrating every historical archive,
 * - task archives at version 2, bound to their owning execution id (legacy
 *   version-1 archives stay readable and are authenticated through their
 *   manifest reference or the membership index),
 * - an authenticated per-execution archive-membership index for settled tasks
 *   whose manifest references were dropped by compaction,
 * - exact JSON bytes (2-space indent plus trailing newline),
 * - archive reuse keyed by task updatedAt, scoped per execution.
 * Finding 15: the manifest stays bounded independently of lifetime completed
 * tasks — settled tasks beyond the recent inline window are represented only
 * by their independently addressed archive files plus aggregate counts, and
 * exact (executionId, taskId) history is recovered lazily from those archives
 * with full integrity and membership checking.
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

export const GROUP_VERSION = 3;
/** @legacy v1 manifests stored every task inline; they are restored, never written. */
export const LEGACY_GROUP_VERSION = 1;
/** @legacy v2 manifests stored a stub for every settled task; they are restored, never written. */
export const LEGACY_GROUP_VERSION_V2 = 2;
export const TASK_ARCHIVE_VERSION = 2;

/**
 * Finding 15: the manifest keeps at most this many recently settled tasks as
 * inline archived references; older settled tasks are represented only by
 * their per-task archive files plus the persisted settledArchivedCount.
 * Bounded, so manifest size does not grow with lifetime completed top-offs.
 */
export const INLINE_SETTLED_TASK_LIMIT = 32;
/**
 * Finding 15: at most this many unsettled (not landed/reported) tasks may be
 * admitted to one execution at a time. Sequential top-offs after prior tasks
 * settle remain supported without limit; the cap bounds worst-case manifest
 * and in-memory live state.
 */
export const MAX_UNSETTLED_TASKS_PER_EXECUTION = 128;

export interface BackgroundExecutionGroup {
  version: 2 | 3;
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
  /**
   * Lifetime tasks ever admitted to this execution (drives truthful
   * completion totals independently of how many settled tasks are inline).
   */
  totalTaskCount?: number;
  /** Settled tasks represented only by their on-disk archive files. */
  settledArchivedCount?: number;
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
  version: 1 | 2 | 3;
  tasks: Array<BackgroundTaskRecord | ArchivedBackgroundTaskReference>;
}

export interface PersistedBackgroundTaskArchive {
  version: 1 | 2;
  /** Version 2 archives are bound to their owning execution identity. */
  executionId?: string;
  taskId: string;
  archivedAt: string;
  integritySha256: string;
  task: BackgroundTaskRecord;
}

/** One entry of the authenticated archive-membership index. */
export interface PersistedTaskArchiveIndexEntry {
  archiveIntegritySha256: string;
  updatedAt: string;
}

/**
 * Authenticated membership index for settled tasks whose manifest references
 * were dropped by compaction while their archive documents still predate
 * execution binding (legacy version-1 archives). Bound to the execution and
 * workspace, and self-hashed, so a copied or colliding archive can never make
 * an old task handle resolve inside the wrong execution.
 */
export interface PersistedTaskArchiveIndex {
  version: 1;
  executionId: string;
  cwd: string;
  entries: Record<string, PersistedTaskArchiveIndexEntry>;
  integritySha256: string;
}

export interface ReadGroupResult {
  group: BackgroundExecutionGroup;
  /** Archive-reuse handles for the tasks restored inline (bounded window). */
  archives: Map<string, PriorArchiveRecord>;
  /**
   * Manifest-evicted settled stubs from legacy v1/v2 manifests: still
   * archive-only, authenticated by these manifest-covered hashes until the
   * membership index is persisted.
   */
  legacyArchives: Map<string, PersistedTaskArchiveIndexEntry>;
  /** Durable membership index from a prior compaction, if present. */
  archiveIndex?: PersistedTaskArchiveIndex;
  /** True when the manifest predates execution-bound archives (v1/v2). */
  manifestLegacy: boolean;
}

/** Integrity handle the caller keeps for settled tasks so archive writes can be reused. */
export interface PriorArchiveRecord {
  updatedAt: string;
  integritySha256: string;
  /** Optional caller-owned group ownership marker (controller bookkeeping only). */
  executionId?: string;
  /**
   * True when the archive on disk predates execution binding (version 1) and
   * must be rewritten (migrated) instead of reused.
   */
  legacy?: boolean;
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
  /**
   * Finding 15: settled tasks that this serialization dropped from the inline
   * window (their archive files exist or are part of archiveWrites). The
   * caller must remove them from the live group only after the durable write
   * succeeds, and bump the live settledArchivedCount by the number actually
   * spliced out.
   */
  evictedTaskIds: string[];
  /**
   * Authenticated membership index write for legacy evicted stubs, emitted
   * before the manifest so the association is durable before the manifest
   * drops their references. Present only when the caller supplied pending
   * legacy handles.
   */
  archiveIndexWrite?: ArchivedGroupWrite;
}

function isArchivedTaskReference(task: BackgroundTaskRecord | ArchivedBackgroundTaskReference): task is ArchivedBackgroundTaskReference {
  return "archived" in task && task.archived === true;
}

function taskArchivePath(taskId: string): string {
  return join("tasks", `${taskId}.json`);
}

function taskArchiveIndexPath(): string {
  return join("tasks", "index.json");
}

function createTaskArchive(task: BackgroundTaskRecord, executionId: string): { snapshot: PersistedBackgroundTaskArchive } {
  const unsigned = {
    version: TASK_ARCHIVE_VERSION as 2,
    executionId,
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

function createTaskArchiveIndex(
  executionId: string,
  cwd: string,
  entries: ReadonlyMap<string, { integritySha256: string; updatedAt: string }>,
): { snapshot: PersistedTaskArchiveIndex } {
  const unsigned = {
    version: 1 as const,
    executionId,
    cwd,
    entries: Object.fromEntries(
      [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([taskId, entry]) => [taskId, { archiveIntegritySha256: entry.integritySha256, updatedAt: entry.updatedAt }]),
    ),
  } as {
    version: 1;
    executionId: string;
    cwd: string;
    entries: Record<string, PersistedTaskArchiveIndexEntry>;
  };
  const snapshot: PersistedTaskArchiveIndex = {
    ...unsigned,
    integritySha256: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
  return { snapshot };
}

/**
 * Serialize a group for durable storage without writing: unsettled tasks stay
 * inline (deep-cloned; bounded by the per-execution admission cap), settled
 * tasks become bounded archived references (backed by versioned archive
 * documents), only the most recent INLINE_SETTLED_TASK_LIMIT settled stubs
 * stay in the manifest, older settled tasks are evicted to their archive
 * files, task history is normalized in place, and the manifest integrity hash
 * is computed over the exact persisted shape. Aggregate lifetime/settled
 * counts are carried so completion notifications stay truthful without
 * traversing lifetime history. The live group's integritySha256 is
 * synchronized with the snapshot. Pure aside from that in-place normalization;
 * no I/O happens here.
 */
export function serializeGroupSnapshot(
  group: BackgroundExecutionGroup,
  priorArchives: ReadonlyMap<string, PriorArchiveRecord>,
  /**
   * Pending legacy evicted stubs awaiting their authenticated membership
   * index write; empty/undefined emits no index write.
   */
  pendingLegacyArchiveHandles?: ReadonlyMap<string, { integritySha256: string; updatedAt: string }>,
): SerializedGroupSnapshot {
  const archiveWrites: ArchivedGroupWrite[] = [];
  const entries: Array<{ task?: BackgroundTaskRecord; stub?: ArchivedBackgroundTaskReference; updatedAt?: string }> = [];
  const settledStubs: Array<{ stub: ArchivedBackgroundTaskReference; updatedAt: string }> = [];
  for (const task of group.tasks) {
    normalizeTaskHistory(task);
    if (!isArchivableTaskState(task.state)) {
      entries.push({ task: cloneTask(task) });
      continue;
    }
    const priorArchive = priorArchives.get(task.taskId);
    // Version-1 archives carry no execution binding: they are rewritten (one
    // bounded migration write per task) instead of reused, so every archive
    // this code produces is bound to its owning execution.
    let archiveIntegritySha256 = priorArchive && !priorArchive.legacy && priorArchive.updatedAt === task.updatedAt
      ? priorArchive.integritySha256
      : undefined;
    if (!archiveIntegritySha256) {
      const archive = createTaskArchive(task, group.executionId);
      archiveIntegritySha256 = archive.snapshot.integritySha256;
      archiveWrites.push({
        taskId: task.taskId,
        updatedAt: task.updatedAt,
        integritySha256: archiveIntegritySha256,
        path: join(group.root, taskArchivePath(task.taskId)),
        body: `${JSON.stringify(archive.snapshot, null, 2)}\n`,
      });
    }
    settledStubs.push({
      updatedAt: task.updatedAt,
      stub: {
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
      },
    });
    entries.push({ stub: settledStubs.at(-1)!.stub, updatedAt: task.updatedAt });
  }
  // Newest settled tasks stay inline; older ones are evicted from the manifest
  // (their archive documents remain independently addressable on disk). The
  // original task order is preserved for every task that stays inline.
  settledStubs.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.stub.taskId.localeCompare(right.stub.taskId));
  const evictedTaskIds = settledStubs.slice(INLINE_SETTLED_TASK_LIMIT).map((entry) => entry.stub.taskId);
  const evicted = new Set(evictedTaskIds);
  const persistedTasks: Array<BackgroundTaskRecord | ArchivedBackgroundTaskReference> = [];
  for (const entry of entries) {
    if (entry.stub) {
      if (!evicted.has(entry.stub.taskId)) persistedTasks.push(entry.stub);
    } else if (entry.task) {
      persistedTasks.push(entry.task);
    }
  }
  // Direct construction instead of a whole-group JSON round trip (finding 15):
  // every value is already JSON-safe, so routine save work is proportional to
  // the bounded inline state rather than lifetime task count.
  const snapshot = {
    ...group,
    version: GROUP_VERSION,
    totalTaskCount: Math.max(group.totalTaskCount ?? 0, group.tasks.length),
    settledArchivedCount: (group.settledArchivedCount ?? 0) + evictedTaskIds.length,
    tasks: persistedTasks,
  } as PersistedBackgroundExecutionGroup;
  const unsigned = { ...snapshot, integritySha256: undefined };
  snapshot.integritySha256 = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  group.integritySha256 = snapshot.integritySha256;
  let archiveIndexWrite: ArchivedGroupWrite | undefined;
  // A supplied (even empty) pending set means the durable index is stale and
  // must be rewritten; undefined means no legacy membership exists.
  if (pendingLegacyArchiveHandles) {
    const index = createTaskArchiveIndex(group.executionId, group.cwd, pendingLegacyArchiveHandles);
    archiveIndexWrite = {
      taskId: "__archive_index__",
      updatedAt: group.updatedAt,
      integritySha256: index.snapshot.integritySha256,
      path: join(group.root, taskArchiveIndexPath()),
      body: `${JSON.stringify(index.snapshot, null, 2)}\n`,
    };
  }
  return { snapshot, archiveWrites, evictedTaskIds, archiveIndexWrite };
}

/**
 * Durable write primitive: task archives first, then the authenticated
 * membership index (so it is durable before the manifest drops the legacy
 * references it covers), then the group manifest, each as exact JSON bytes
 * via atomic write. Callers own ordering across groups.
 */
export async function writeGroupSnapshot(root: string, serialized: SerializedGroupSnapshot): Promise<void> {
  for (const archive of serialized.archiveWrites) await atomicWrite(archive.path, archive.body);
  if (serialized.archiveIndexWrite) await atomicWrite(serialized.archiveIndexWrite.path, serialized.archiveIndexWrite.body);
  await atomicWrite(join(root, "execution.json"), `${JSON.stringify(serialized.snapshot, null, 2)}\n`);
}

export async function readGroup(root: string): Promise<ReadGroupResult> {
  const resolved = await realpath(resolve(root));
  if (!basename(resolved).startsWith("pi-review-execution-")) throw new Error("Invalid background execution root.");
  const parsed = JSON.parse(await readFile(join(resolved, "execution.json"), "utf8")) as PersistedBackgroundExecutionGroup;
  if (
    (parsed.version !== GROUP_VERSION && parsed.version !== LEGACY_GROUP_VERSION && parsed.version !== LEGACY_GROUP_VERSION_V2)
    || parsed.root !== resolved
    || !parsed.executionId
    || !Array.isArray(parsed.tasks)
  ) {
    throw new Error("Invalid background execution manifest.");
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify({ ...unsigned, integritySha256: undefined })).digest("hex");
  if (!integritySha256 || integritySha256 !== actual) throw new Error("Background execution manifest failed its integrity check.");
  const manifestLegacy = parsed.version !== GROUP_VERSION;
  // Finding 15: restore must not eagerly hydrate every historical archive.
  // Inline full records (unsettled tasks, plus legacy v1 inline settled tasks)
  // are kept; archived references are hydrated only for the bounded recent
  // settled window, while older references become archive-only handles backed
  // by the aggregate settledArchivedCount and are re-read lazily per exact
  // task handle.
  const references: ArchivedBackgroundTaskReference[] = [];
  for (const persistedTask of parsed.tasks) {
    if (isArchivedTaskReference(persistedTask)) references.push(persistedTask);
  }
  references.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId));
  const windowIds = new Set(references.slice(0, INLINE_SETTLED_TASK_LIMIT).map((reference) => reference.taskId));
  const archives = new Map<string, PriorArchiveRecord>();
  const legacyArchives = new Map<string, PersistedTaskArchiveIndexEntry>();
  const tasks: BackgroundTaskRecord[] = [];
  // Preserve the manifest's task order; hydrate only the bounded recent
  // settled window and keep older references archive-only.
  for (const persistedTask of parsed.tasks) {
    if (isArchivedTaskReference(persistedTask)) {
      if (windowIds.has(persistedTask.taskId)) {
        const task = await readTaskArchive(resolved, persistedTask, parsed.executionId);
        normalizeRestoredTask(task);
        tasks.push(task);
        archives.set(persistedTask.taskId, {
          updatedAt: persistedTask.updatedAt,
          integritySha256: persistedTask.archiveIntegritySha256,
          legacy: manifestLegacy,
        });
      } else {
        // Evicted settled tasks stay archive-only: counted via the aggregate,
        // not hydrated, and still recoverable by exact (executionId, taskId)
        // lookup through their authenticated membership hash.
        legacyArchives.set(persistedTask.taskId, {
          archiveIntegritySha256: persistedTask.archiveIntegritySha256,
          updatedAt: persistedTask.updatedAt,
        });
      }
    } else {
      normalizeRestoredTask(persistedTask);
      tasks.push(persistedTask);
    }
  }
  const archiveIndex = await readTaskArchiveIndex(resolved, parsed.executionId, parsed.cwd);
  if (archiveIndex) {
    for (const [taskId, entry] of Object.entries(archiveIndex.entries)) {
      if (!legacyArchives.has(taskId)) legacyArchives.set(taskId, entry);
    }
  }
  const group = {
    ...parsed,
    version: GROUP_VERSION,
    tasks,
    kind: parsed.kind ?? (tasks.some((task) => task.definition.backgroundKind === "research") ? "research" : "execute"),
    peakConcurrency: parsed.peakConcurrency ?? 0,
    // v1/v2 manifests stored every task ever admitted inline, so their exact
    // lifetime totals are derived from the persisted task list; v3 carries the
    // explicit aggregates. Settled references beyond the recent window are
    // archive-only here and counted truthfully via settledArchivedCount.
    totalTaskCount: Math.max(parsed.totalTaskCount ?? 0, parsed.tasks.length),
    settledArchivedCount: (parsed.settledArchivedCount ?? 0) + Math.max(0, references.length - INLINE_SETTLED_TASK_LIMIT),
  } as BackgroundExecutionGroup;
  return { group, archives, legacyArchives, archiveIndex, manifestLegacy };
}

function normalizeRestoredTask(task: BackgroundTaskRecord): void {
  delete (task as BackgroundTaskRecord & { matchedWakePatterns?: string[] }).matchedWakePatterns;
  delete (task.definition as BackgroundTaskDefinition & { wakeOn?: unknown }).wakeOn;
  normalizeTaskHistory(task);
}

async function readTaskArchive(root: string, reference: ArchivedBackgroundTaskReference, executionId: string): Promise<BackgroundTaskRecord> {
  const expectedPath = taskArchivePath(reference.taskId);
  if (reference.archivePath !== expectedPath) throw new Error(`Invalid archive path for task ${reference.taskId}.`);
  const parsed = JSON.parse(await readFile(join(root, expectedPath), "utf8")) as PersistedBackgroundTaskArchive;
  if ((parsed.version !== TASK_ARCHIVE_VERSION && parsed.version !== 1) || parsed.taskId !== reference.taskId || parsed.task?.taskId !== reference.taskId) {
    throw new Error(`Invalid background task archive for ${reference.taskId}.`);
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (!integritySha256 || integritySha256 !== actual || integritySha256 !== reference.archiveIntegritySha256) {
    throw new Error(`Background task archive failed its integrity check: ${reference.taskId}.`);
  }
  if (parsed.version === TASK_ARCHIVE_VERSION && parsed.executionId !== executionId) {
    throw new Error(`Background task archive ${reference.taskId} does not belong to execution ${executionId}.`);
  }
  if (!isArchivableTaskState(parsed.task.state) || parsed.task.state !== reference.state) {
    throw new Error(`Background task archive state does not match its execution manifest: ${reference.taskId}.`);
  }
  return parsed.task;
}

/**
 * Finding 15: lazily load one settled task archive by exact task handle for
 * inspection or recovery, with full integrity and membership checking. A
 * present `expected.archiveIntegritySha256` cross-checks the archive against
 * its authenticated membership handle (manifest reference or membership
 * index); version-2 archives are additionally bound to their owning execution
 * id, and version-1 archives are refused without an authenticated handle.
 * Returns undefined when no archive exists for the handle (the caller keeps
 * its original unknown-task failure); any malformed, tampered, misplaced, or
 * mismatching archive throws fail-closed.
 */
export async function readOwnedTaskArchive(
  root: string,
  taskId: string,
  expected?: {
    executionId?: string;
    /** Integrity hash of the current execution-bound (version-2) archive. */
    archiveIntegritySha256?: string;
    /** Integrity hash of the superseded legacy (version-1) archive. */
    legacyArchiveIntegritySha256?: string;
  },
): Promise<BackgroundTaskRecord | undefined> {
  if (!/^task-[0-9a-zA-Z-]+$/.test(taskId)) return undefined;
  const resolved = await realpath(resolve(root));
  if (!basename(resolved).startsWith("pi-review-execution-")) throw new Error("Invalid background execution root.");
  const expectedPath = taskArchivePath(taskId);
  let raw: string;
  try {
    raw = await readFile(join(resolved, expectedPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as PersistedBackgroundTaskArchive;
  if ((parsed.version !== TASK_ARCHIVE_VERSION && parsed.version !== 1) || parsed.taskId !== taskId || parsed.task?.taskId !== taskId) {
    throw new Error(`Invalid background task archive for ${taskId}.`);
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (!integritySha256 || integritySha256 !== actual) {
    throw new Error(`Background task archive failed its integrity check: ${taskId}.`);
  }
  if (parsed.version === TASK_ARCHIVE_VERSION) {
    // Current-generation archives are authenticated by their bound reference
    // hash and their owning execution id; a stale legacy membership hash must
    // never be applied to a rewritten archive.
    if (expected?.archiveIntegritySha256 !== undefined && expected.archiveIntegritySha256 !== integritySha256) {
      throw new Error(`Background task archive failed its integrity check: ${taskId}.`);
    }
    if (!parsed.executionId) throw new Error(`Invalid background task archive for ${taskId}.`);
    if (expected?.executionId !== undefined && parsed.executionId !== expected.executionId) {
      throw new Error(`Background task archive ${taskId} does not belong to execution ${expected.executionId}.`);
    }
  } else {
    // Legacy version-1 archives carry no execution binding: they are
    // authenticated only by their membership hash, and never by a bound
    // reference (which belongs to a newer archive generation).
    const legacyIntegritySha256 = expected?.legacyArchiveIntegritySha256 ?? expected?.archiveIntegritySha256;
    if (legacyIntegritySha256 === undefined) {
      throw new Error(`Background task archive ${taskId} has no authenticated membership in this execution.`);
    }
    if (legacyIntegritySha256 !== integritySha256) {
      throw new Error(`Background task archive failed its integrity check: ${taskId}.`);
    }
  }
  if (!isArchivableTaskState(parsed.task.state)) {
    throw new Error(`Background task archive does not hold a settled task: ${taskId}.`);
  }
  normalizeRestoredTask(parsed.task);
  return parsed.task;
}

/**
 * Read and fully validate the authenticated archive-membership index for an
 * execution root. Returns undefined when no index exists; a malformed,
 * tampered, or foreign index fails closed.
 */
export async function readTaskArchiveIndex(
  root: string,
  expectedExecutionId: string,
  expectedCwd?: string,
): Promise<PersistedTaskArchiveIndex | undefined> {
  const resolved = await realpath(resolve(root));
  if (!basename(resolved).startsWith("pi-review-execution-")) throw new Error("Invalid background execution root.");
  let raw: string;
  try {
    raw = await readFile(join(resolved, taskArchiveIndexPath()), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as PersistedTaskArchiveIndex;
  if (parsed.version !== 1 || parsed.executionId !== expectedExecutionId || (expectedCwd !== undefined && resolve(parsed.cwd) !== resolve(expectedCwd))) {
    throw new Error("Invalid background task archive index.");
  }
  const { integritySha256, ...unsigned } = parsed;
  const actual = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if (!integritySha256 || integritySha256 !== actual) {
    throw new Error("Background task archive index failed its integrity check.");
  }
  return parsed;
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
