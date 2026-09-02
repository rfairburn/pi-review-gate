import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GROUP_VERSION,
  LEGACY_GROUP_VERSION,
  readGroup,
  removeOwnedExecutionRoot,
  removeOwnedWaveRoot,
  serializeGroupSnapshot,
  writeGroupSnapshot,
  type BackgroundExecutionGroup,
} from "../src/execution/background-group-store";
import { newTask, type BackgroundTaskDefinition } from "../src/execution/task-state";

const definition: BackgroundTaskDefinition = {
  title: "Fixture task",
  instructions: "Do the fixture work.",
  acceptanceCriteria: ["Fixture criteria"],
} as unknown as BackgroundTaskDefinition;

function makeGroup(): BackgroundExecutionGroup {
  const now = new Date().toISOString();
  const root = join(tmpdir(), `pi-review-execution-fixture-${Math.random().toString(36).slice(2)}`);
  return {
    version: GROUP_VERSION,
    revision: 3,
    integritySha256: "",
    executionId: "exec-fixture",
    kind: "execute",
    root,
    cwd: "/tmp/workspace",
    createdAt: now,
    updatedAt: now,
    peakConcurrency: 2,
    tasks: [newTask(definition)],
  };
}

function settledTask(group: BackgroundExecutionGroup): void {
  const task = group.tasks[0]!;
  task.state = "landed";
  task.summary = "  landed\n with   whitespace  ";
  task.error = "x".repeat(600);
  task.updatedAt = new Date().toISOString();
}

function manifestIntegrity(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ ...snapshot, integritySha256: undefined })).digest("hex");
}

test("serializeGroupSnapshot keeps active tasks inline and archives settled tasks with bounded references", () => {
  const group = makeGroup();
  const active = serializeGroupSnapshot(group, new Map());
  assert.equal(active.snapshot.version, GROUP_VERSION);
  assert.equal(active.archiveWrites.length, 0);
  assert.equal(active.snapshot.tasks.length, 1);
  assert.equal("archived" in active.snapshot.tasks[0], false);
  assert.equal(group.integritySha256, active.snapshot.integritySha256);

  settledTask(group);
  const serialized = serializeGroupSnapshot(group, new Map());
  assert.equal(serialized.archiveWrites.length, 1);
  const write = serialized.archiveWrites[0]!;
  assert.match(write.path, /tasks[\\/]task-[0-9a-f-]+\.json$/);
  assert.equal(write.body.endsWith("\n"), true);
  const archive = JSON.parse(write.body);
  assert.equal(archive.version, 1);
  assert.equal(archive.taskId, group.tasks[0]!.taskId);
  assert.equal(archive.task.state, "landed");
  assert.equal(archive.integritySha256, createHash("sha256").update(JSON.stringify({ ...archive, integritySha256: undefined })).digest("hex"));

  const reference = serialized.snapshot.tasks[0] as unknown as Record<string, unknown>;
  assert.equal(reference.archived, true);
  assert.equal(reference.summary, "landed with whitespace");
  assert.equal((reference.error as string).length, 500);
  assert.equal((reference.error as string).endsWith("…"), true);
  assert.equal(reference.archiveIntegritySha256, archive.integritySha256);
  assert.ok(reference.timing);
});

test("serializeGroupSnapshot computes the manifest integrity over the exact persisted shape", () => {
  const group = makeGroup();
  const { snapshot } = serializeGroupSnapshot(group, new Map());
  const expected = manifestIntegrity(snapshot as unknown as Record<string, unknown>);
  assert.equal(snapshot.integritySha256, expected);
  assert.equal(group.integritySha256, expected);
  assert.equal(/^[0-9a-f]{64}$/.test(expected), true);
});

test("serializeGroupSnapshot reuses prior archive integrity only for an unchanged updatedAt", () => {
  const group = makeGroup();
  settledTask(group);
  const first = serializeGroupSnapshot(group, new Map());
  const prior = new Map([[group.tasks[0]!.taskId, {
    updatedAt: group.tasks[0]!.updatedAt,
    integritySha256: first.archiveWrites[0]!.integritySha256,
  }]]);
  const second = serializeGroupSnapshot(group, prior);
  assert.equal(second.archiveWrites.length, 0);
  const reference = second.snapshot.tasks[0] as unknown as Record<string, unknown>;
  assert.equal(reference.archiveIntegritySha256, first.archiveWrites[0]!.integritySha256);

  const stale = serializeGroupSnapshot(group, new Map([[group.tasks[0]!.taskId, {
    updatedAt: "2000-01-01T00:00:00.000Z",
    integritySha256: first.archiveWrites[0]!.integritySha256,
  }]]));
  assert.equal(stale.archiveWrites.length, 1);
});

test("writeGroupSnapshot writes exact JSON bytes and readGroup restores them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-store-"));
  try {
    const group = makeGroup();
    group.root = await realpath(root);
    const active = serializeGroupSnapshot(group, new Map());
    await writeGroupSnapshot(root, active);

    const manifestRaw = await readFile(join(root, "execution.json"), "utf8");
    assert.equal(manifestRaw, `${JSON.stringify(active.snapshot, null, 2)}\n`);

    settledTask(group);
    const settled = serializeGroupSnapshot(group, new Map());
    await writeGroupSnapshot(root, settled);
    for (const write of settled.archiveWrites) {
      assert.equal(await readFile(write.path, "utf8"), write.body);
    }
    const restored = await readGroup(root);
    assert.equal(restored.group.version, GROUP_VERSION);
    assert.equal(restored.group.executionId, group.executionId);
    assert.equal(restored.group.revision, settled.snapshot.revision);
    assert.equal(restored.group.integritySha256, settled.snapshot.integritySha256);
    assert.equal(restored.group.tasks[0]!.state, "landed");
    assert.equal(restored.archives.size, 1);
    assert.ok(restored.archives.get(group.tasks[0]!.taskId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readGroup restores legacy v1 manifests with inline tasks and normalizes version", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-legacy-"));
  try {
    const group = makeGroup();
    group.root = await realpath(root);
    const legacy: Record<string, unknown> = {
      ...group,
      version: LEGACY_GROUP_VERSION,
      tasks: group.tasks,
    };
    delete (legacy as Record<string, unknown>).kind;
    legacy.integritySha256 = manifestIntegrity(legacy);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const restored = await readGroup(root);
    assert.equal(restored.group.version, GROUP_VERSION);
    assert.equal(restored.group.kind, "execute");
    assert.equal(restored.group.tasks.length, 1);
    assert.equal(restored.archives.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readGroup infers a research kind for legacy manifests lacking one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-legacy2-"));
  try {
    const group = makeGroup();
    group.root = await realpath(root);
    group.tasks[0]!.definition = { ...definition, backgroundKind: "research" } as unknown as BackgroundTaskDefinition;
    const legacy: Record<string, unknown> = { ...group, version: LEGACY_GROUP_VERSION, tasks: group.tasks };
    delete (legacy as Record<string, unknown>).kind;
    legacy.integritySha256 = manifestIntegrity(legacy);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const restored = await readGroup(root);
    assert.equal(restored.group.kind, "research");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readGroup rejects tampered manifests, invalid roots, and unknown versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-tamper-"));
  try {
    const group = makeGroup();
    group.root = await realpath(root);
    const { snapshot } = serializeGroupSnapshot(group, new Map());
    await writeGroupSnapshot(root, { snapshot, archiveWrites: [] });

    const tampered = JSON.parse(await readFile(join(root, "execution.json"), "utf8")) as Record<string, any>;
    tampered.peakConcurrency = 99;
    await writeFile(join(root, "execution.json"), `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    await assert.rejects(readGroup(root), /failed its integrity check/);

    const badVersion = { ...group, version: 3, tasks: [] };
    badVersion.integritySha256 = manifestIntegrity(badVersion as unknown as Record<string, unknown>);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(badVersion, null, 2)}\n`, "utf8");
    await assert.rejects(readGroup(root), /Invalid background execution manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const notOwned = await mkdtemp(join(tmpdir(), "not-an-execution-root-"));
  try {
    await assert.rejects(readGroup(notOwned), /Invalid background execution root/);
  } finally {
    await rm(notOwned, { recursive: true, force: true });
  }
});

test("readGroup rejects an archive whose integrity or state does not match its manifest reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-execution-archv-"));
  try {
    const group = makeGroup();
    group.root = await realpath(root);
    settledTask(group);
    const serialized = serializeGroupSnapshot(group, new Map());
    await writeGroupSnapshot(root, serialized);

    const manifest = JSON.parse(await readFile(join(root, "execution.json"), "utf8")) as Record<string, any>;
    manifest.tasks[0].archiveIntegritySha256 = "0".repeat(64);
    manifest.integritySha256 = manifestIntegrity(manifest);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(readGroup(root), /failed its integrity check/);

    const manifest2 = JSON.parse(await readFile(join(root, "execution.json"), "utf8")) as Record<string, any>;
    delete manifest2.tasks[0].archiveIntegritySha256;
    manifest2.integritySha256 = manifestIntegrity(manifest2);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(manifest2, null, 2)}\n`, "utf8");
    await assert.rejects(readGroup(root), /integrity check/);

    // Restore the valid manifest reference, then tamper only the archive's
    // task state so the archive revalidates against a mismatching state.
    await writeFile(join(root, "execution.json"), `${JSON.stringify(serialized.snapshot, null, 2)}\n`, "utf8");
    // Keep the archive bytes valid and make only the manifest reference claim
    // a different state, so validation reaches the state cross-check.
    const manifest3 = JSON.parse(await readFile(join(root, "execution.json"), "utf8")) as Record<string, any>;
    manifest3.tasks[0].state = "reported";
    manifest3.integritySha256 = manifestIntegrity(manifest3);
    await writeFile(join(root, "execution.json"), `${JSON.stringify(manifest3, null, 2)}\n`, "utf8");
    await assert.rejects(readGroup(root), /state does not match its execution manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeOwnedExecutionRoot removes only owned temporary execution roots", async () => {
  const owned = await mkdtemp(join(tmpdir(), "pi-review-execution-cleanup-"));
  const marker = join(owned, "execution.json");
  await writeFile(marker, "{}", "utf8");
  await removeOwnedExecutionRoot(await realpath(owned));
  await assert.rejects(stat(owned));

  const wrongPrefix = await mkdtemp(join(tmpdir(), "wave-not-execution-"));
  try {
    await assert.rejects(removeOwnedExecutionRoot(wrongPrefix), /Refusing to remove unrecognized execution root/);
  } finally {
    await rm(wrongPrefix, { recursive: true, force: true });
  }

  await assert.rejects(removeOwnedExecutionRoot(join(process.cwd(), "pi-review-execution-outside-tmp")), /Refusing to remove/);
});

test("removeOwnedWaveRoot removes only owned temporary wave roots", async () => {
  const owned = await mkdtemp(join(tmpdir(), "wave-cleanup-"));
  await mkdir(join(owned, "nested"), { recursive: true });
  await writeFile(join(owned, "nested", "file.txt"), "x", "utf8");
  await removeOwnedWaveRoot(await realpath(owned));
  await assert.rejects(access(owned));

  const notWave = await mkdtemp(join(tmpdir(), "pi-review-execution-not-wave-"));
  try {
    await assert.rejects(removeOwnedWaveRoot(notWave), /Refusing to remove unrecognized wave root/);
  } finally {
    await rm(notWave, { recursive: true, force: true });
  }

  await assert.rejects(removeOwnedWaveRoot(join(process.cwd(), "wave-outside-tmp")), /Refusing to remove/);
});
