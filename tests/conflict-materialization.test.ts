import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { materializeLandingConflicts, unresolvedConflictMarkers } from "../src/execution/conflict-materialization";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { integrateWave } from "../src/execution/wave-integration";
import { planWaveLanding } from "../src/execution/wave-landing";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree, pinCommit } from "../src/execution/wave-worktrees";

const execFileAsync = promisify(execFile);

async function initRepo(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
}

test("conflict materialization applies clean paths and leaves ordinary markers only on conflicts", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-conflict-source-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-conflict-artifacts-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: source });
    await writeFile(join(source, "common.txt"), "base\n", "utf8");
    await writeFile(join(source, "clean.txt"), "clean base\n", "utf8");
    await writeFile(join(source, "delete.txt"), "delete me\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "conflict-wave" });
    const worker = await createWorkerWorktree(capture, "task-one");
    await writeFile(join(worker.worktreeRoot, "common.txt"), "worker\n", "utf8");
    await writeFile(join(worker.worktreeRoot, "clean.txt"), "clean worker\n", "utf8");
    await rm(join(worker.worktreeRoot, "delete.txt"));
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    await writeFile(join(source, "common.txt"), "user\n", "utf8");
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.conflicts.map((entry) => entry.path), ["common.txt"]);
    const materialized = await materializeLandingConflicts(capture, plan, "subtask task-one");
    assert.deepEqual(materialized.paths, ["common.txt"]);
    const conflict = await readFile(join(source, "common.txt"), "utf8");
    assert.match(conflict, /<<<<<<< current workspace/);
    assert.match(conflict, /user/);
    assert.match(conflict, /worker/);
    assert.equal(await readFile(join(source, "clean.txt"), "utf8"), "clean worker\n");
    await assert.rejects(access(join(source, "delete.txt")));
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), ["common.txt"]);
    await writeFile(join(source, "common.txt"), "resolved\n", "utf8");
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), []);
    assert.equal(JSON.parse(await readFile(materialized.manifestPath, "utf8")).paths.length, 3);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("ordinary reviewed landing refuses a binary conflict before any source mutation", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-binary-refuse-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-binary-refuse-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "bin.dat"), "base\n", "utf8");
    await writeFile(join(source, "clean.txt"), "clean base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "binary-refuse" });
    const worker = await createWorkerWorktree(capture, "task-one");
    await writeFile(join(worker.worktreeRoot, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(join(worker.worktreeRoot, "clean.txt"), "clean worker\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    // The source's own copy diverged to incompatible binary content.
    await writeFile(join(source, "bin.dat"), Buffer.from([0x09, 0x08, 0x07]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.conflicts.map((entry) => entry.path), ["bin.dat"]);

    // No options: the whole transfer is refused before any mutation.
    await assert.rejects(
      materializeLandingConflicts(capture, plan, "subtask task-one"),
      /Cannot represent .* conflict\(s\); nothing was transferred/,
    );
    // The target binary is untouched…
    assert.deepEqual(await readFile(join(source, "bin.dat")), Buffer.from([0x09, 0x08, 0x07]));
    // …and the clean path was NOT applied (whole-transfer refusal, not clean-only).
    assert.equal(await readFile(join(source, "clean.txt"), "utf8"), "clean base\n");
    // No sidecar was written.
    const entries = await readdir(source);
    assert.ok(!entries.some((entry) => /^bin\.dat\.worker-/.test(entry)), "no worker sidecar is written on refusal");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge preserves an oversized worker blob by streaming it alongside", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-oversized-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-oversized-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "big.dat"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "oversized" });
    const worker = await createWorkerWorktree(capture, "task-one");
    // A worker blob above the 32 MiB text-materialization limit (also binary).
    const big = Buffer.alloc(33 * 1024 * 1024);
    big[big.length - 1] = 0xab;
    await writeFile(join(worker.worktreeRoot, "big.dat"), big);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    await writeFile(join(source, "big.dat"), Buffer.from([0x11, 0x22]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.conflicts.map((entry) => entry.path), ["big.dat"]);

    const materialized = await materializeLandingConflicts(capture, plan, "forced subtask task-one", {
      binarySidecars: true,
      preserveUnrepresentable: true,
    });
    // The target is preserved intact…
    assert.deepEqual(await readFile(join(source, "big.dat")), Buffer.from([0x11, 0x22]));
    // …and the oversized worker blob is saved alongside with its exact bytes.
    const sidecar = materialized.sidecars.find((entry) => entry.path === "big.dat");
    assert.ok(sidecar?.sidecarPath, "the oversized worker blob is preserved alongside");
    const sidecarStat = await stat(sidecar!.sidecarPath!);
    assert.equal(sidecarStat.size, big.length, "the streamed sidecar must hold the full oversized blob");
    const sidecarHash = createHash("sha256").update(await readFile(sidecar!.sidecarPath!)).digest("hex");
    assert.equal(sidecarHash, createHash("sha256").update(big).digest("hex"), "streamed sidecar bytes must match the worker blob exactly");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge sidecar never takes the path of an incoming clean file at the same destination", async () => {
  // Canonicalize: plan.sourceRoot is realpath-ed, so gate paths compare only
  // against the canonical source root (macOS /tmp -> /private/tmp).
  const source = await realpath(await mkdtemp(join(tmpdir(), "pi-review-sidecar-incoming-")));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-sidecar-incoming-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "bin.dat"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "sidecar-incoming" });
    const worker = await createWorkerWorktree(capture, "task-one");
    const workerBytes = Buffer.from([0x00, 0xde, 0xad]);
    await writeFile(join(worker.worktreeRoot, "bin.dat"), workerBytes);
    // The worker also creates a clean file whose name is exactly the
    // deterministic sidecar name for its own binary blob. Neither exists in
    // the target yet, so only planner-level reservation can keep them apart.
    const blobId = (await execFileAsync("git", ["hash-object", join(worker.worktreeRoot, "bin.dat")], { cwd: source })).stdout.trim();
    const stemName = `bin.dat.worker-${blobId.slice(0, 12)}`;
    const cleanBytes = Buffer.from("clean incoming bytes\n", "utf8");
    await writeFile(join(worker.worktreeRoot, stemName), cleanBytes);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    // The source's own copy diverged to incompatible binary content.
    await writeFile(join(source, "bin.dat"), Buffer.from([0x09, 0x08, 0x07]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
      ["bin.dat", "conflict"],
      [stemName, "apply"],
    ]);

    const materialized = await materializeLandingConflicts(capture, plan, "forced subtask task-one", {
      binarySidecars: true,
      preserveUnrepresentable: true,
    });
    // The sidecar must not take the planned clean file's destination…
    const sidecar = materialized.sidecars.find((entry) => entry.path === "bin.dat");
    assert.ok(sidecar?.sidecarPath, "a sidecar is written for the binary conflict");
    assert.notEqual(sidecar!.sidecarPath, join(source, stemName), "the sidecar must not reuse the incoming clean file's path");
    assert.match(sidecar!.sidecarPath!, /bin\.dat\.worker-[0-9a-f]{12}-\d+$/, "the collision-safe name is suffixed");
    // …and BOTH incoming bytes and sidecar bytes survive at the gate-named paths.
    assert.deepEqual(await readFile(join(source, stemName)), cleanBytes, "the incoming clean file keeps its exact bytes");
    assert.deepEqual(await readFile(sidecar!.sidecarPath!), workerBytes, "the worker binary survives at the gate-referenced sidecar");
    // The conflicted target itself is preserved intact.
    assert.deepEqual(await readFile(join(source, "bin.dat")), Buffer.from([0x09, 0x08, 0x07]));
    // The gate names the real locations: conflict path plus applied clean path.
    assert.deepEqual(materialized.paths, ["bin.dat"]);
    assert.ok(materialized.appliedPaths.includes(stemName), "the clean file is reported as applied");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge sidecar skips occupied and planned names before installing", async () => {
  // The deterministic base name is occupied on disk by an unrelated existing
  // file, and the worker's clean work includes files at BOTH collision
  // suffixes. The sidecar must land past all of them without overwriting any.
  const source = await realpath(await mkdtemp(join(tmpdir(), "pi-review-sidecar-suffix-")));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-sidecar-suffix-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "bin.dat"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "sidecar-suffix" });
    const worker = await createWorkerWorktree(capture, "task-one");
    const workerBytes = Buffer.from([0x00, 0xde, 0xad]);
    await writeFile(join(worker.worktreeRoot, "bin.dat"), workerBytes);
    const blobId = (await execFileAsync("git", ["hash-object", join(worker.worktreeRoot, "bin.dat")], { cwd: source })).stdout.trim();
    const stemName = `bin.dat.worker-${blobId.slice(0, 12)}`;
    // Both collision suffixes are incoming clean files (planned, absent in the
    // target): only planner-level reservation can keep the sidecar apart from
    // them, since neither exists on disk while the sidecar name is chosen.
    const cleanOne = Buffer.from("clean suffix one\n", "utf8");
    const cleanTwo = Buffer.from("clean suffix two\n", "utf8");
    await writeFile(join(worker.worktreeRoot, `${stemName}-1`), cleanOne);
    await writeFile(join(worker.worktreeRoot, `${stemName}-2`), cleanTwo);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    // Pre-occupy the deterministic base sidecar name with unrelated content.
    await writeFile(join(source, stemName), "pre-existing\n", "utf8");
    await writeFile(join(source, "bin.dat"), Buffer.from([0x09, 0x08, 0x07]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
      ["bin.dat", "conflict"],
      [`${stemName}-1`, "apply"],
      [`${stemName}-2`, "apply"],
    ]);

    const materialized = await materializeLandingConflicts(capture, plan, "forced subtask task-one", {
      binarySidecars: true,
      preserveUnrepresentable: true,
    });
    const sidecar = materialized.sidecars.find((entry) => entry.path === "bin.dat");
    assert.ok(sidecar?.sidecarPath, "a sidecar is written for the binary conflict");
    assert.equal(sidecar!.sidecarPath, join(source, `${stemName}-3`), "the sidecar skips the occupied base name and both planned suffixes");
    // All four files survive with their exact bytes.
    assert.deepEqual(await readFile(join(source, stemName)), Buffer.from("pre-existing\n", "utf8"), "the unowned on-disk occupant is untouched");
    assert.deepEqual(await readFile(join(source, `${stemName}-1`)), cleanOne, "the first incoming clean file keeps its exact bytes");
    assert.deepEqual(await readFile(join(source, `${stemName}-2`)), cleanTwo, "the second incoming clean file keeps its exact bytes");
    assert.deepEqual(await readFile(sidecar!.sidecarPath!), workerBytes, "the worker binary survives at the gate-referenced sidecar");
    assert.deepEqual(await readFile(join(source, "bin.dat")), Buffer.from([0x09, 0x08, 0x07]));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge streams a large clean file alongside an ordinary conflict", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-large-clean-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-large-clean-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "note.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "large-clean" });
    const worker = await createWorkerWorktree(capture, "task-one");
    // A clean (nonconflicting) file above the 32 MiB text-materialization
    // limit: a plain byte copy that carries no conflict markers.
    const big = Buffer.alloc(33 * 1024 * 1024, 0x61);
    big.fill("wave", 0, big.length, "utf8");
    big[big.length - 1] = 0xab;
    await writeFile(join(worker.worktreeRoot, "large.dat"), big);
    await writeFile(join(worker.worktreeRoot, "note.txt"), "worker note\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    // An ordinary text conflict on another path in the same plan.
    await writeFile(join(source, "note.txt"), "user note\n", "utf8");
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
      ["large.dat", "apply"],
      ["note.txt", "conflict"],
    ]);

    // Explicit force-merge transfers the whole identified work: the oversized
    // clean file must not abort the operation via the marker-size limit.
    const materialized = await materializeLandingConflicts(capture, plan, "forced subtask task-one", {
      binarySidecars: true,
      preserveUnrepresentable: true,
    });
    assert.deepEqual(materialized.paths, ["note.txt"]);
    assert.ok(materialized.appliedPaths.includes("large.dat"), "the large clean file is reported as applied");
    const landed = await readFile(join(source, "large.dat"));
    assert.equal(landed.length, big.length, "the full oversized clean file was transferred");
    assert.equal(createHash("sha256").update(landed).digest("hex"), createHash("sha256").update(big).digest("hex"), "clean bytes match the worker blob exactly");
    // The ordinary text conflict still materializes standard markers.
    const conflict = await readFile(join(source, "note.txt"), "utf8");
    assert.match(conflict, /<<<<<<< current workspace/);
    assert.match(conflict, /user note/);
    assert.match(conflict, /worker note/);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("ordinary reviewed landing still refuses a large clean file before any mutation", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-large-clean-ordinary-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-large-clean-ordinary-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "note.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "large-clean-ordinary" });
    const worker = await createWorkerWorktree(capture, "task-one");
    const big = Buffer.alloc(33 * 1024 * 1024, 0x62);
    big[big.length - 1] = 0xcd;
    await writeFile(join(worker.worktreeRoot, "large.dat"), big);
    await writeFile(join(worker.worktreeRoot, "note.txt"), "worker note\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    await writeFile(join(source, "note.txt"), "user note\n", "utf8");
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);

    // No options (ordinary reviewed landing): the pre-#126 fail-closed limit on
    // buffered clean content stays in place and nothing is transferred.
    await assert.rejects(materializeLandingConflicts(capture, plan, "subtask task-one"));
    assert.equal(await readFile(join(source, "note.txt"), "utf8"), "user note\n", "no mutation on refusal");
    await assert.rejects(access(join(source, "large.dat")), "the large clean file must not transfer on refusal");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge uses a collision-safe sidecar name when the base name is taken", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-review-collision-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-collision-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "img.bin"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "collision" });
    const worker = await createWorkerWorktree(capture, "task-one");
    const workerBytes = Buffer.from([0x00, 0xde, 0xad]);
    await writeFile(join(worker.worktreeRoot, "img.bin"), workerBytes);
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    await writeFile(join(source, "img.bin"), Buffer.from([0x00, 0xbe, 0xef]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.conflicts.map((entry) => entry.path), ["img.bin"]);

    // Pre-occupy the deterministic base sidecar name so the collision branch
    // must choose a suffixed name instead of overwriting.
    const blobId = (await execFileAsync("git", ["hash-object", join(worker.worktreeRoot, "img.bin")], { cwd: source })).stdout.trim();
    const baseSidecar = join(source, `img.bin.worker-${blobId.slice(0, 12)}`);
    await writeFile(baseSidecar, "pre-existing\n", "utf8");

    const materialized = await materializeLandingConflicts(capture, plan, "forced subtask task-one", { binarySidecars: true });
    const sidecar = materialized.sidecars.find((entry) => entry.path === "img.bin");
    assert.ok(sidecar?.sidecarPath, "a sidecar is written for the binary conflict");
    assert.notEqual(sidecar!.sidecarPath, baseSidecar, "the occupied base name must not be reused");
    assert.match(sidecar!.sidecarPath!, /img\.bin\.worker-[0-9a-f]{12}-\d+$/, "the collision-safe name is suffixed");
    // The pre-existing occupant is untouched; the new sidecar holds worker bytes.
    assert.equal(await readFile(baseSidecar, "utf8"), "pre-existing\n");
    assert.deepEqual(await readFile(sidecar!.sidecarPath!), workerBytes);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge sidecar install failure keeps an unowned occupant and rolls back earlier installs", async () => {
  // Exercises the install-time no-overwrite guard deterministically through
  // the @internal hook seam: an unowned file appears at the chosen sidecar
  // destination between prepare and install. The call must reject without
  // overwriting it, and rollback must restore earlier installs while leaving
  // the unowned occupant byte-for-byte intact.
  const source = await realpath(await mkdtemp(join(tmpdir(), "pi-review-sidecar-late-")));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-review-sidecar-late-art-"));
  try {
    await initRepo(source);
    await writeFile(join(source, "a-clean.txt"), "clean base\n", "utf8");
    await writeFile(join(source, "z.bin"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: "sidecar-late" });
    const worker = await createWorkerWorktree(capture, "task-one");
    const workerBytes = Buffer.from([0x00, 0xfe, 0xed]);
    await writeFile(join(worker.worktreeRoot, "z.bin"), workerBytes);
    await writeFile(join(worker.worktreeRoot, "a-clean.txt"), "clean worker\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") return;
    // z.bin drifts to incompatible binary content → sidecar conflict; the
    // clean modify sorts first and installs before the sidecar.
    await writeFile(join(source, "z.bin"), Buffer.from([0x09, 0x08]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
      ["a-clean.txt", "apply"],
      ["z.bin", "conflict"],
    ]);

    let destination: string | undefined;
    await assert.rejects(
      materializeLandingConflicts(capture, plan, "forced subtask task-one", { binarySidecars: true }, {
        beforeSidecarInstall: async (sidecarDestination) => {
          destination = sidecarDestination;
          // Exclusive create: fails loudly if the destination is not free.
          await writeFile(sidecarDestination, "unowned occupant\n", { flag: "wx" });
        },
      }),
      /occupied at install time/,
    );
    assert.ok(destination, "the hook observed the chosen sidecar destination");
    // The unowned occupant survives byte-for-byte (rollback never deletes it) …
    assert.equal(await readFile(destination!, "utf8"), "unowned occupant\n", "rollback must not delete an unowned occupant");
    // …the earlier clean install was rolled back …
    assert.equal(await readFile(join(source, "a-clean.txt"), "utf8"), "clean base\n", "earlier installs roll back on a late collision");
    // …the conflicted target is untouched …
    assert.deepEqual(await readFile(join(source, "z.bin")), Buffer.from([0x09, 0x08]));
    // …and no same-directory install temp was left behind in the target tree.
    const entries = await readdir(source);
    assert.ok(!entries.some((entry) => entry.startsWith(".pi-review-conflict-")), "no install temp is leaked on a late collision");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

// Shared setup for the unsupported-atomic-link regressions: one clean apply
// (sorts first, installs before the sidecar) plus one binary conflict that
// force-merge represents as a sidecar.
async function setupSidecarInstallWave(prefix: string) {
  const source = await realpath(await mkdtemp(join(tmpdir(), `pi-review-${prefix}-`)));
  const artifacts = await mkdtemp(join(tmpdir(), `pi-review-${prefix}-art-`));
  try {
    await initRepo(source);
    await writeFile(join(source, "a-clean.txt"), "clean base\n", "utf8");
    await writeFile(join(source, "z.bin"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: source });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
    const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: artifacts, waveId: prefix });
    const worker = await createWorkerWorktree(capture, "task-one");
    const workerBytes = Buffer.from([0x00, 0xfe, 0xed]);
    await writeFile(join(worker.worktreeRoot, "z.bin"), workerBytes);
    await writeFile(join(worker.worktreeRoot, "a-clean.txt"), "clean worker\n", "utf8");
    const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
    await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
    const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
    assert.equal(integration.status, "integrated");
    if (integration.status !== "integrated") throw new Error("setup: expected an integrated wave");
    // z.bin drifts to incompatible binary content → sidecar conflict; the
    // clean modify sorts first and installs before the sidecar.
    await writeFile(join(source, "z.bin"), Buffer.from([0x09, 0x08]));
    const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
    assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
      ["a-clean.txt", "apply"],
      ["z.bin", "conflict"],
    ]);
    return { source, artifacts, capture, plan };
  } catch (error) {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
    throw error;
  }
}

test("force-merge sidecar install refuses an unsupported atomic link instead of renaming over a free destination", async () => {
  // Deterministic fault-path regression for the removed lstat-then-rename
  // fallback: when the atomic hard-link install fails with an errno meaning
  // the filesystem cannot hard-link (ENOTSUP), the install must fail closed.
  // The destination is free, so the old fallback would have renamed the temp
  // over it; after the refusal it must still not exist, earlier installs must
  // roll back, and no install temp may leak into the target tree.
  const { source, artifacts, capture, plan } = await setupSidecarInstallWave("sidecar-nolink");
  try {
    let destination: string | undefined;
    await assert.rejects(
      materializeLandingConflicts(capture, plan, "forced subtask task-one", { binarySidecars: true }, {
        failSidecarLink: async (sidecarDestination) => {
          destination = sidecarDestination;
          const error = new Error("operation not supported on this filesystem") as NodeJS.ErrnoException;
          error.code = "ENOTSUP";
          throw error;
        },
      }),
      /atomic sidecar install is unsupported on this filesystem/i,
    );
    assert.ok(destination, "the hook observed the chosen sidecar destination");
    // No rename fallback: a free destination must stay free.
    await assert.rejects(access(destination!), "an unsupported atomic link must not be papered over with a rename");
    // The earlier clean install was rolled back …
    assert.equal(await readFile(join(source, "a-clean.txt"), "utf8"), "clean base\n", "earlier installs roll back on an unsupported atomic link");
    // …the conflicted target is untouched …
    assert.deepEqual(await readFile(join(source, "z.bin")), Buffer.from([0x09, 0x08]));
    // …and no same-directory install temp was left behind in the target tree.
    const entries = await readdir(source);
    assert.ok(!entries.some((entry) => entry.startsWith(".pi-review-conflict-")), "no install temp is leaked on an unsupported atomic link");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("force-merge sidecar install failure on an unsupported atomic link preserves an unowned occupant and rolls back", async () => {
  // Same refusal path with a different errno (EPERM) and an unowned file
  // occupying the chosen destination: the occupant must survive byte-for-byte
  // — the refusal happens before any rename could clobber it — while earlier
  // installs roll back and no install temp leaks.
  const { source, artifacts, capture, plan } = await setupSidecarInstallWave("sidecar-nolink-occupied");
  try {
    let destination: string | undefined;
    await assert.rejects(
      materializeLandingConflicts(capture, plan, "forced subtask task-one", { binarySidecars: true }, {
        beforeSidecarInstall: async (sidecarDestination) => {
          // Exclusive create: fails loudly if the destination is not free.
          await writeFile(sidecarDestination, "unowned occupant\n", { flag: "wx" });
        },
        failSidecarLink: async (sidecarDestination) => {
          destination = sidecarDestination;
          const error = new Error("operation not permitted") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      }),
      /atomic sidecar install is unsupported on this filesystem/i,
    );
    assert.ok(destination, "the hook observed the chosen sidecar destination");
    // The unowned occupant survives byte-for-byte (rollback never deletes it) …
    assert.equal(await readFile(destination!, "utf8"), "unowned occupant\n", "an unsupported atomic link must not clobber an unowned occupant");
    // …the earlier clean install was rolled back …
    assert.equal(await readFile(join(source, "a-clean.txt"), "utf8"), "clean base\n", "earlier installs roll back on an unsupported atomic link");
    // …the conflicted target is untouched …
    assert.deepEqual(await readFile(join(source, "z.bin")), Buffer.from([0x09, 0x08]));
    // …and no same-directory install temp was left behind in the target tree.
    const entries = await readdir(source);
    assert.ok(!entries.some((entry) => entry.startsWith(".pi-review-conflict-")), "no install temp is leaked on an unsupported atomic link");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});
