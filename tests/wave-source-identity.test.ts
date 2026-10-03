import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { encodeSourceIdentityComponent, isSourceIdentity, isSourceIdentityComponent } from "../src/execution/source-identity";
import { captureWaveBase, readSourceRootIdentity, readWaveCaptureRecord } from "../src/execution/wave-repository";
import { createWorkerWorktree, pinCommit } from "../src/execution/wave-worktrees";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { integrateWave } from "../src/execution/wave-integration";
import { executeWaveLanding, planWaveLanding, recoverLandingManifest, createTestSignedManifest, inspectLandingRecoveryManifests } from "../src/execution/wave-landing";

const LARGE = 9007199254740992n;
const exec = promisify(execFile);
async function git(args: string[], cwd: string) {
  return exec("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
}

// Simulate only the root's native Windows stats. All capture/Git/file writes,
// JSON persistence, durable manifest writes and HMAC verification remain real.
async function windowsRoot(root: string, run: (state: { ino: bigint; dev: bigint; pathDev: bigint; afterIno?: bigint; secondDev?: bigint; secondIno?: bigint; symlink?: boolean; directory?: boolean }) => Promise<void>) {
  const state = { ino: LARGE, dev: LARGE + 7n, pathDev: 0n } as Parameters<typeof run>[0];
  const resolvedRoot = resolve(root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = fs.lstat;
  const open = fs.open;
  let pathReads = 0;
  let handles = 0;
  const fake = (dev: bigint, ino: bigint) => ({ dev, ino, isDirectory: () => state.directory !== false, isSymbolicLink: () => state.symlink ?? false });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  fs.lstat = (async (path: unknown, options?: { bigint?: boolean }) => {
    if (resolve(String(path)) !== resolvedRoot || !options?.bigint) return lstat(path as string, options as { bigint: true });
    assert.equal(options.bigint, true);
    return fake(state.pathDev, ++pathReads % 2 === 0 ? state.afterIno ?? state.ino : state.ino);
  }) as typeof fs.lstat;
  fs.open = (async (path: unknown, ...args: unknown[]) => {
    if (resolve(String(path)) !== resolvedRoot) return open(path as string, args[0] as string);
    const second = ++handles % 2 === 0;
    return {
      stat: async (options: { bigint?: boolean }) => {
        assert.equal(options?.bigint, true, "opened root stats must never use Number");
        return fake(second ? state.secondDev ?? state.dev : state.dev, second ? state.secondIno ?? state.ino : state.ino);
      },
      close: async () => {},
    };
  }) as typeof fs.open;
  try { await run(state); }
  finally { fs.lstat = lstat; fs.open = open; Object.defineProperty(process, "platform", platform); }
}

test("identity codec preserves numeric history and bounds canonical unsigned64 strings", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER, "9007199254740992", "9007199254740993", "18446744073709551615"]) assert.ok(isSourceIdentityComponent(value));
  for (const value of [0, -1, 1.5, NaN, Infinity, Number(LARGE), Number(LARGE + 1n), "1", "0", "-1", "+9007199254740992", "09007199254740992", "9007199254740992.0", "9e16", " 9007199254740992", "9007199254740992\n", "18446744073709551616", "9".repeat(100000), 1n, null]) assert.equal(isSourceIdentityComponent(value), false);
  assert.equal(encodeSourceIdentityComponent(42n), 42);
  assert.equal(encodeSourceIdentityComponent(LARGE), "9007199254740992");
  assert.notEqual(encodeSourceIdentityComponent(LARGE), encodeSourceIdentityComponent(LARGE + 1n));
  assert.equal(Number(LARGE), Number(LARGE + 1n), "representative Number collision");
  for (const value of [0n, -1n, 18446744073709551616n]) assert.throws(() => encodeSourceIdentityComponent(value));
  assert.equal(isSourceIdentity({ dev: 1, ino: Number(LARGE) }), false);
});

test("Windows root exact stats reject adjacent inode, path and second-handle volume retargets", async () => {
  await windowsRoot("mock-root", async (state) => {
    assert.deepEqual(await readSourceRootIdentity("mock-root"), { dev: String(state.dev), ino: String(LARGE) });
    state.secondIno = LARGE + 1n;
    await assert.rejects(readSourceRootIdentity("mock-root"), /changed or is incomplete/);
    delete state.secondIno;
    state.secondDev = state.dev + 1n;
    await assert.rejects(readSourceRootIdentity("mock-root"), /changed or is incomplete/);
    delete state.secondDev;
    state.afterIno = LARGE + 1n;
    await assert.rejects(readSourceRootIdentity("mock-root"), /changed or is incomplete/);
    delete state.afterIno;
    state.pathDev = state.dev + 1n;
    await assert.rejects(readSourceRootIdentity("mock-root"), /changed or is incomplete/);
    state.pathDev = state.dev;
    assert.equal((await readSourceRootIdentity("mock-root")).dev, String(state.dev));
    state.symlink = true;
    await assert.rejects(readSourceRootIdentity("mock-root"), /non-symlink/);
    state.symlink = false;
    state.directory = false;
    await assert.rejects(readSourceRootIdentity("mock-root"), /non-symlink/);
  });
});

for (const initial of [42n, LARGE]) test(`Windows root ${initial} capture reload worker edit landing and authenticated recovery`, async () => {
  const fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "wave-exact-")));
  const root = join(fixture, "source");
  const artifacts = join(fixture, "artifacts");
  await fs.mkdir(root); await fs.mkdir(artifacts);
  try {
    await git(["init", "--quiet"], root);
    await fs.writeFile(join(root, "file.txt"), "original\n");
    await git(["add", "."], root); await git(["commit", "--quiet", "-m", "initial"], root);
    await windowsRoot(root, async (state) => {
      state.ino = initial;
      state.dev = initial + 7n;
      const capture = await captureWaveBase({ cwd: root, artifactDir: artifacts, maxSnapshotBytes: 1000, maxCaptureAttempts: 1, artifactTtlMs: 0 });
      const reloaded = await readWaveCaptureRecord(capture.waveRoot);
      assert.deepEqual(reloaded.sourceIdentity, { dev: encodeSourceIdentityComponent(state.dev), ino: encodeSourceIdentityComponent(initial) });
      const worker = await createWorkerWorktree(reloaded, "edit");
      await fs.writeFile(join(worker.worktreeRoot, "file.txt"), "edited\n");
      const candidate = await normalizeCandidate(reloaded, worker.worktreeRoot, "edit", "Edit file");
      await pinCommit(reloaded, candidate.commitSha, { type: "worker", taskId: "edit" });
      const integration = await integrateWave(reloaded, [{ taskId: "edit", commitSha: candidate.commitSha }]);
      assert.equal(integration.status, "integrated");
      if (integration.status !== "integrated") throw new Error("Integration failed");
      const plan = await planWaveLanding(reloaded, integration.finalCommitSha, root);
      state.ino = initial + 1n;
      await assert.rejects(planWaveLanding(reloaded, integration.finalCommitSha, root), /identity mismatch/);
      assert.equal((await executeWaveLanding(plan, reloaded)).status, "conflicted");
      state.ino = initial;
      const landed = await executeWaveLanding(plan, reloaded);
      assert.equal(landed.status, "landed");
      if (landed.status !== "landed") throw new Error("Landing failed");
      assert.equal(await fs.readFile(join(root, "file.txt"), "utf8"), "edited\n");
      const manifest = JSON.parse(await fs.readFile(landed.manifestPath, "utf8"));
      assert.deepEqual(manifest.sourceIdentity, reloaded.sourceIdentity);
      assert.equal(manifest.version, 1);
      assert.equal((await inspectLandingRecoveryManifests(capture.waveRoot))[0].verified, true);
      await fs.writeFile(landed.manifestPath, JSON.stringify({ ...manifest, sourceIdentity: { ...manifest.sourceIdentity, ino: encodeSourceIdentityComponent(initial + 1n) } }));
      const tampered = await recoverLandingManifest(landed.manifestPath);
      assert.equal(tampered.status, "rejected");
      if (tampered.status === "rejected") assert.match(tampered.reason, /Authentication tag mismatch/);
      assert.equal((await inspectLandingRecoveryManifests(capture.waveRoot))[0].verified, false);
      await fs.writeFile(landed.manifestPath, JSON.stringify(manifest));
      assert.equal((await recoverLandingManifest(landed.manifestPath)).status, "terminal");
      // Reconstruct a crash immediately after the backup rename, using the
      // real transaction's authenticated durable manifest and artifact names.
      const entry = manifest.paths[0];
      await fs.writeFile(entry.backup, "original\n");
      await fs.rm(entry.destination);
      entry.phase = "backup_created";
      manifest.state = "in_progress";
      const transaction = basename(landed.manifestPath).slice("manifest-".length, -".json".length);
      const signed = await createTestSignedManifest(join(capture.waveRoot, "landing"), manifest, transaction);
      state.ino = initial + 1n;
      assert.equal((await recoverLandingManifest(signed.manifestPath)).status, "rejected");
      await fs.access(entry.backup);
      state.ino = initial;
      const recovered = await recoverLandingManifest(signed.manifestPath);
      assert.equal(recovered.status, "recovered", JSON.stringify(recovered));
      assert.equal(await fs.readFile(entry.destination, "utf8"), "original\n");
      // Invalid authenticated identities still fail structure validation;
      // unsafe historic Numbers are never guessed into decimal strings.
      for (const ino of [Number(LARGE), "01", "1", "18446744073709551616", "9".repeat(100000)]) {
        const invalid = { ...manifest, sourceIdentity: { dev: 1, ino } };
        const bad = await createTestSignedManifest(join(capture.waveRoot, "landing"), invalid, "bad-identity");
        const rejected = await recoverLandingManifest(bad.manifestPath);
        assert.equal(rejected.status, "rejected");
        if (rejected.status === "rejected") assert.match(rejected.reason, /sourceIdentity/);
        await fs.writeFile(join(capture.waveRoot, "capture.json"), JSON.stringify({ ...capture, sourceIdentity: invalid.sourceIdentity }));
        await assert.rejects(readWaveCaptureRecord(capture.waveRoot), /Invalid wave capture record/);
      }
      await assert.rejects(captureWaveBase({
        cwd: root, artifactDir: artifacts, maxSnapshotBytes: 1000,
        maxCaptureAttempts: 1, artifactTtlMs: 0,
        hooks: { mutateSourceBetweenCaptureAndVerify: () => { state.ino = initial + 1n; } },
      }), /Workspace changed during capture/);
    });
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
