import assert from "node:assert/strict";
import childProcess = require("node:child_process");
import fsPromises = require("node:fs/promises");
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { normalizeConfig } from "../src/config";
import type { WaveSourceDiscovery } from "../src/execution/wave-repository";

const execFileAsync = promisify(childProcess.execFile);
type Output = { stdout: string; stderr: string };
let inventoryOverride: (() => Promise<Output>) | undefined;
let inventoryRoots: string[] = [];
let expectedSource: string | undefined;

// Capture a command-only seam at module load; discovery, temp Git init/config,
// staging and cleanup still run normally. No large filesystem inventory needed.
const interceptedExecFile = Object.assign(childProcess.execFile.bind(childProcess), {
  [promisify.custom]: async (file: string, args: string[], options: childProcess.ExecFileOptions) => {
    if (file === "git" && args.join(" ") === "ls-files --others --exclude-standard -z"
      && options.env?.GIT_DIR?.includes("pi-wave-enum-")) {
      assert.equal(options.cwd, expectedSource);
      assert.equal(options.env.GIT_WORK_TREE, expectedSource);
      assert.equal(options.maxBuffer, 64 * 1024 * 1024);
      assert.equal(options.timeout, 15_000);
      inventoryRoots.push(dirname(options.env.GIT_DIR));
      if (inventoryOverride) return inventoryOverride();
    }
    return execFileAsync(file, args, options);
  },
});
const descriptor = Object.getOwnPropertyDescriptor(childProcess, "execFile")!;
let repository: typeof import("../src/execution/wave-repository");
let controller: typeof import("../src/execution/wave-controller");
try {
  Object.defineProperty(childProcess, "execFile", { ...descriptor, value: interceptedExecFile });
  repository = require("../src/execution/wave-repository");
  controller = require("../src/execution/wave-controller");
} finally {
  Object.defineProperty(childProcess, "execFile", descriptor);
}
const worktrees: typeof import("../src/execution/wave-worktrees") = require("../src/execution/wave-worktrees");
const lifecycle: typeof import("../src/execution/wave-worker-lifecycle") = require("../src/execution/wave-worker-lifecycle");

const PRIVATE_INVENTORY = "private-inventory-secret.txt\0";
const PRIVATE_STDERR = "private-stderr-secret";
const PRIVATE_PROPERTY = "private-arbitrary-property-secret";

async function fixture(t: TestContext, name = "source") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-inventory-test-")));
  const source = join(root, name);
  const artifacts = join(root, "artifacts");
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  // Keep fixtures genuinely non-Git even when the task sandbox requires TMPDIR
  // inside a checkout: ceiling bounds Git discovery, and this filesystem seam
  // hides only enclosing .git markers from the malformed-metadata fallback
  // check. All fixture-local metadata checks and inventory commands stay real.
  process.env.GIT_CEILING_DIRECTORIES = root;
  const realLstat = fsPromises.lstat;
  t.mock.method(fsPromises, "lstat", ((...args: Parameters<typeof realLstat>) => {
    const path = String(args[0]);
    if (basename(path) === ".git" && !path.startsWith(root + sep)) {
      return Promise.reject(Object.assign(new Error("No enclosing fixture metadata"), { code: "ENOENT" }));
    }
    return realLstat(...args);
  }) as typeof realLstat);
  inventoryOverride = undefined;
  inventoryRoots = [];
  expectedSource = source;
  t.after(async () => {
    inventoryOverride = undefined;
    expectedSource = undefined;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(source);
  await mkdir(artifacts);
  await writeFile(join(source, "data.txt"), "unchanged data\n");
  const discovery = await repository.discoverWaveSource(source);
  assert.equal(discovery.sourceType, "non-git");
  return { root, source, artifacts, discovery };
}

// Obtain Node's real execFile overflow error with a tiny synthetic output and
// buffer. The production inventory seam still asserts the actual 64MiB/15s.
async function realOverflow(stream: "stdout" | "stderr"): Promise<Error> {
  try {
    await execFileAsync(process.execPath, ["-e", stream === "stdout"
      ? `process.stderr.write(${JSON.stringify(PRIVATE_STDERR)}); process.stdout.write(${JSON.stringify(PRIVATE_INVENTORY)}.repeat(100));`
      : `process.stdout.write(${JSON.stringify(PRIVATE_INVENTORY)}); process.stderr.write(${JSON.stringify(PRIVATE_STDERR)}.repeat(100));`,
    ], { maxBuffer: 128, timeout: 5_000 });
    throw new Error("Expected synthetic output to overflow");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(error.message, `${stream} maxBuffer length exceeded`);
    return Object.assign(error, { privateProperty: PRIVATE_PROPERTY, cause: new Error(PRIVATE_PROPERTY) });
  }
}

function assertDiagnostic(error: unknown, workspace: string, stream?: "stdout" | "stderr") {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Non-Git source inventory command `git ls-files --others --exclude-standard -z`/);
  assert.ok(error.message.includes(`selected workspace ${workspace}`));
  assert.match(error.message, /64 MiB \(67108864 bytes\) maxBuffer limit/);
  assert.match(error.message, /Original failure: ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);
  if (stream) assert.ok(error.message.includes(`${stream} maxBuffer length exceeded`));
  else assert.match(error.message, /overflowing stream not identified/);
  assert.match(error.message, /Choose a narrower workspace \(the intended project directory\) and retry/);
  // Check the whole exposed error, not just its message, for accidental copying.
  const exposed = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of [PRIVATE_INVENTORY.slice(0, -1), PRIVATE_STDERR, PRIVATE_PROPERTY]) {
    assert.ok(!exposed.includes(secret), "inventory, stderr and arbitrary properties must not be exposed");
  }
  assert.equal("stdout" in error, false);
  assert.equal("stderr" in error, false);
  assert.equal("cause" in error, false);
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message));
  return true;
}

async function assertEnumeratorCleanup() {
  assert.ok(inventoryRoots.length > 0, "must reach the real temporary enumerator");
  for (const root of inventoryRoots) await assert.rejects(access(root), { code: "ENOENT" });
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`non-Git ${stream} overflow gives sanitized actionable diagnostics and cleans the enumerator`, async (t) => {
    const { discovery, source } = await fixture(t);
    const original = await realOverflow(stream);
    inventoryOverride = async () => { throw original; };
    await assert.rejects(repository.enumerateWaveSourcePaths(discovery),
      (error) => assertDiagnostic(error, JSON.stringify(source), stream));
    await assertEnumeratorCleanup();
    assert.equal(await readFile(join(source, "data.txt"), "utf8"), "unchanged data\n");
  });
}

test("workspace identity encodes control characters without exposing inventory", async (t) => {
  const { discovery } = await fixture(t);
  // No such directory is scanned: only inventory is intercepted. Init/config
  // still operate in the real temp enumerator. This also covers Windows where
  // these characters cannot be used in directory names.
  const workspace = `${discovery.captureRoot}/line\n\t\r\u001b\u007f\u0085\u200b\u2028\u2029\u202e\u2060\u{e0001}\\quoted\"`;
  const selected: WaveSourceDiscovery = { ...discovery, captureRoot: workspace };
  expectedSource = workspace;
  const original = await realOverflow("stdout");
  inventoryOverride = async () => { throw original; };
  const encoded = JSON.stringify(discovery.captureRoot).slice(0, -1)
    + '/line\\n\\t\\r\\u001b\\u007f\\u0085\\u200b\\u2028\\u2029\\u202e\\u2060\\udb40\\udc01\\\\quoted\\\""';
  await assert.rejects(repository.enumerateWaveSourcePaths(selected),
    (error) => assertDiagnostic(error, encoded, "stdout"));
  await assertEnumeratorCleanup();
});

test("unknown overflow message does not infer stdout or copy secret-bearing context", async (t) => {
  const { discovery, source } = await fixture(t);
  inventoryOverride = async () => {
    throw Object.assign(new Error(`${PRIVATE_PROPERTY}: stdout maxBuffer length exceeded`), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: PRIVATE_INVENTORY, stderr: PRIVATE_STDERR,
    });
  };
  await assert.rejects(repository.enumerateWaveSourcePaths(discovery),
    (error) => assertDiagnostic(error, JSON.stringify(source)));
  await assertEnumeratorCleanup();
});

test("non-overflow and cancellation errors are rethrown unchanged, with enumerator cleanup", async (t) => {
  const { discovery } = await fixture(t);
  const errors = [
    Object.assign(new Error("stdout maxBuffer length exceeded"), { code: 128 }),
    Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("command timed out"), { killed: true, signal: "SIGTERM" }),
    Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }),
    // Abort identity wins even when a supplied error also has the overflow code.
    Object.assign(new Error("stdout maxBuffer length exceeded"), { name: "AbortError", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
  ];
  for (const original of errors) {
    inventoryOverride = async () => { throw original; };
    await assert.rejects(repository.enumerateWaveSourcePaths(discovery), (error) => error === original);
  }
  const abort = new AbortController();
  const overflow = await realOverflow("stdout");
  inventoryOverride = async () => { abort.abort(); throw overflow; };
  await assert.rejects(repository.enumerateWaveSourcePaths(discovery, abort.signal), (error) => error === overflow);
  await assertEnumeratorCleanup();
});

test("capture overflow fails closed before artifacts or a snapshot are created", async (t) => {
  const { source, artifacts } = await fixture(t);
  const original = await realOverflow("stdout");
  inventoryOverride = async () => { throw original; };
  await assert.rejects(repository.captureWaveBase({
    cwd: source, maxSnapshotBytes: 1_000_000, waveId: "inventory-overflow", artifactDir: artifacts,
  }), (error) => assertDiagnostic(error, JSON.stringify(source), "stdout"));
  await assertEnumeratorCleanup();
  assert.deepEqual(await readdir(artifacts), []);
  assert.deepEqual(await readdir(source), ["data.txt"]);
});

test("verification inventory overflow removes both the enumerator and partial capture without retry", async (t) => {
  const { source, artifacts } = await fixture(t);
  const original = await realOverflow("stdout");
  let observations = 0;
  inventoryOverride = async () => {
    observations += 1;
    if (observations === 1) return { stdout: "data.txt\0", stderr: "" };
    throw original;
  };
  await assert.rejects(repository.captureWaveBase({
    cwd: source, maxSnapshotBytes: 1_000_000, waveId: "verification-overflow", artifactDir: artifacts,
  }), (error) => assertDiagnostic(error, JSON.stringify(source), "stdout"));
  assert.equal(observations, 2, "an inventory failure must not become a consistency retry");
  await assertEnumeratorCleanup();
  assert.deepEqual(await readdir(artifacts), []);
  assert.deepEqual(await readdir(source), ["data.txt"]);
});

test("controller preserves actionable capture failure and cancellation, starting no worker", async (t) => {
  const { source, artifacts } = await fixture(t);
  const original = await realOverflow("stdout");
  inventoryOverride = async () => { throw original; };
  const createWorker = t.mock.method(worktrees, "createWorkerWorktree");
  const startWorker = t.mock.method(lifecycle, "runWaveWorkerLifecycle");
  const phases: string[] = [];
  const config = normalizeConfig({
    enabled: false,
    execution: {
      workerResources: { default: { selection: { source: "external", id: "never-start" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    externalAgents: {
      "never-start": { adapter: "run-as-binary", command: process.execPath, execution: {
        args: ["-e", "throw new Error('worker must not start')"], protocol: "pi-review-executor-jsonl-v1",
      } },
    },
  });
  await assert.rejects(controller.executeWave({
    cwd: source, tasks: [{ title: "No startup", instructions: "noop", acceptanceCriteria: [] }],
    config, artifactDir: artifacts, waveId: "inventory-overflow", onProgress: (event) => { phases.push(event.phase); },
  }), (error) => {
    assert.ok(error instanceof repository.WaveCaptureError);
    assert.equal(error.code, "capture_failed");
    assert.equal(error.waveId, "inventory-overflow");
    assert.equal(error.phase, "capturing");
    return assertDiagnostic(error, JSON.stringify(source), "stdout");
  });
  const abort = new AbortController();
  inventoryOverride = async () => { abort.abort(); throw original; };
  await assert.rejects(controller.executeWave({
    cwd: source, tasks: [{ title: "Cancelled", instructions: "noop", acceptanceCriteria: [] }],
    config, artifactDir: artifacts, waveId: "inventory-cancel", signal: abort.signal,
  }), (error) => {
    assert.ok(error instanceof repository.WaveCaptureError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.waveId, "inventory-cancel");
    assert.equal(error.phase, "capturing");
    assert.doesNotMatch(error.message, /overflow|narrower|maxBuffer/);
    return true;
  });
  assert.equal(createWorker.mock.calls.length, 0);
  assert.equal(startWorker.mock.calls.length, 0);
  assert.deepEqual(phases, ["capturing"]);
  assert.deepEqual(await readdir(artifacts), []);
  assert.deepEqual(await readdir(source), ["data.txt"]);
  await assertEnumeratorCleanup();
});

test("successful non-Git capture retains nested ignores and confined symlinks", async (t) => {
  const { source, artifacts, discovery } = await fixture(t);
  await mkdir(join(source, "nested"));
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await writeFile(join(source, "ignored.txt"), "not captured\n");
  await writeFile(join(source, "nested", ".gitignore"), "private.txt\n");
  await writeFile(join(source, "nested", "private.txt"), "not captured\n");
  await writeFile(join(source, "nested", "keep.txt"), "captured\n");
  if (process.platform !== "win32") await symlink("data.txt", join(source, "link.txt"));
  const expected = [".gitignore", "data.txt", ...(process.platform !== "win32" ? ["link.txt"] : []),
    "nested/.gitignore", "nested/keep.txt"];
  assert.deepEqual(await repository.enumerateWaveSourcePaths(discovery), expected);
  const capture = await repository.captureWaveBase({
    cwd: source, maxSnapshotBytes: 1_000_000, waveId: "inventory-success", artifactDir: artifacts,
  });
  assert.deepEqual(capture.paths, expected);
  if (process.platform !== "win32") {
    assert.equal(capture.entries.find((entry) => entry.path === "link.txt")?.mode, "120000");
    await symlink("../outside.txt", join(source, "escape.txt"));
    await writeFile(join(dirname(source), "outside.txt"), "must not be read\n");
    await assert.rejects(repository.captureWaveBase({
      cwd: source, maxSnapshotBytes: 1_000_000, waveId: "inventory-escape", artifactDir: artifacts,
    }), /Symlink target escapes capture root/);
    assert.equal((await readdir(artifacts)).length, 1, "failed capture must remove its private wave root");
  }
  await assertEnumeratorCleanup();
});
