import assert from "node:assert/strict";
import childProcess = require("node:child_process");
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { normalizeCandidate } from "../src/execution/wave-commits";
import { integrateWave } from "../src/execution/wave-integration";
import { planWaveLanding } from "../src/execution/wave-landing";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree, pinCommit } from "../src/execution/wave-worktrees";

const execFileAsync = promisify(childProcess.execFile);
type Output = { stdout: Buffer; stderr: Buffer };
let mergeOverride: (() => Promise<Output>) | undefined;
// Capture a test-only merge-file interceptor when this module is loaded. Other
// Git operations (including fixture creation and blob reads) remain real.
const interceptedExecFile = Object.assign(childProcess.execFile.bind(childProcess), {
  [promisify.custom]: async (file: string, args: string[], options: childProcess.ExecFileOptions) => {
    if (file === "git" && args[0] === "merge-file" && mergeOverride) {
      assert.equal(options.encoding, "buffer");
      assert.equal(options.maxBuffer, 128 * 1024 * 1024);
      return mergeOverride();
    }
    return execFileAsync(file, args, options);
  },
});
const execFileDescriptor = Object.getOwnPropertyDescriptor(childProcess, "execFile")!;
let materialization: typeof import("../src/execution/conflict-materialization");
try {
  Object.defineProperty(childProcess, "execFile", { ...execFileDescriptor, value: interceptedExecFile });
  materialization = require("../src/execution/conflict-materialization");
} finally {
  Object.defineProperty(childProcess, "execFile", execFileDescriptor);
}
const { materializeLandingConflicts, unresolvedConflictMarkers } = materialization;

const label = "subtask task-one";
const separator = Array.from({ length: 10 }, (_, i) => `unchanged ${i}\n`).join("");
const regions = (side: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${side} ${i}\n`).join(separator);
const markers = (current: string, base: string, result: string): string =>
  `<<<<<<< current workspace\n${current}||||||| subtask base\n${base}=======\n${result}>>>>>>> ${label}\n`;

async function fixture(t: TestContext, base: string, current: string, result: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-review-conflict-outcomes-"));
  t.after(async () => {
    mergeOverride = undefined;
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  await execFileAsync("git", ["init", "-q", source]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: source });
  await writeFile(join(source, "z-conflict.txt"), base);
  await writeFile(join(source, "a-clean.txt"), "clean base\n");
  await writeFile(join(source, "b-delete.txt"), "keep until prepared\n");
  await execFileAsync("git", ["add", "."], { cwd: source });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: source });
  await mkdir(join(root, "artifacts"));
  const capture = await captureWaveBase({ cwd: source, maxSnapshotBytes: 1_000_000, artifactDir: join(root, "artifacts"), waveId: "conflict-outcomes" });
  const worker = await createWorkerWorktree(capture, "task-one");
  await writeFile(join(worker.worktreeRoot, "z-conflict.txt"), result);
  await writeFile(join(worker.worktreeRoot, "a-clean.txt"), "clean worker\n");
  await rm(join(worker.worktreeRoot, "b-delete.txt"));
  const candidate = await normalizeCandidate(capture, worker.worktreeRoot, "task-one", "worker result");
  await pinCommit(capture, candidate.commitSha, { type: "worker", taskId: "task-one" });
  const integration = await integrateWave(capture, [{ taskId: "task-one", commitSha: candidate.commitSha }]);
  assert.equal(integration.status, "integrated");
  if (integration.status !== "integrated") throw new Error("Fixture integration failed");
  await writeFile(join(source, "z-conflict.txt"), current);
  const plan = await planWaveLanding(capture, integration.finalCommitSha, source);
  assert.deepEqual(plan.paths.map(({ path, action }) => [path, action]), [
    ["a-clean.txt", "apply"], ["b-delete.txt", "apply"], ["z-conflict.txt", "conflict"],
  ]);
  const inputs = ["current", "base", "result"].map((name) => join(root, name));
  await Promise.all([current, base, result].map((text, i) => writeFile(inputs[i], text)));
  const merge = () => execFileAsync("git", ["merge-file", "-p", "--diff3",
    "-L", "current workspace", "-L", "subtask base", "-L", label, ...inputs,
  ], { encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
  return { root, source, capture, plan, merge };
}

for (const [count, eol] of [[3, "\n"], [128, "\n"], [3, "\r\n"]] as const) {
  test(`materializes ${count} separate ${eol === "\n" ? "LF" : "CRLF"} conflict regions (Git exit ${Math.min(count, 127)})`, async (t) => {
    const content = (side: string) => regions(side, count).replaceAll("\n", eol);
    const { source, capture, plan, merge } = await fixture(t, content("base"), content("user"), content("worker"));
    const expected = Array.from({ length: count }, (_, i) => markers(`user ${i}\n`, `base ${i}\n`, `worker ${i}\n`)).join(separator).replaceAll("\n", eol);
    // Verify the real Git exit count and exact diff3 output, not a mocked code.
    await assert.rejects(merge(), (error: unknown) => {
      const failure = error as { code: number; stdout: Buffer };
      assert.equal(failure.code, Math.min(count, 127));
      assert.ok(Buffer.isBuffer(failure.stdout));
      assert.equal(failure.stdout.toString(), expected);
      return true;
    });
    const materialized = await materializeLandingConflicts(capture, plan, label);
    assert.deepEqual(materialized.paths, ["z-conflict.txt"]);
    assert.deepEqual(materialized.appliedPaths, ["a-clean.txt", "b-delete.txt"]);
    assert.equal(await readFile(join(source, "z-conflict.txt"), "utf8"), expected);
    assert.equal(await readFile(join(source, "a-clean.txt"), "utf8"), "clean worker\n");
    await assert.rejects(access(join(source, "b-delete.txt")));
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), ["z-conflict.txt"]);
    await writeFile(join(source, "z-conflict.txt"), "resolved\n");
    assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), []);
  });
}

test("a clean merge still materializes an explicitly conflicted landing path", async (t) => {
  const base = `base start\n${separator}base end\n`;
  const current = `user start\n${separator}base end\n`;
  const result = `base start\n${separator}worker end\n`;
  const { source, capture, plan, merge } = await fixture(t, base, current, result);
  assert.equal((await merge()).stdout.toString(), `user start\n${separator}worker end\n`);
  const materialized = await materializeLandingConflicts(capture, plan, label);
  assert.equal(await readFile(join(source, "z-conflict.txt"), "utf8"), markers(current, base, result));
  assert.deepEqual(await unresolvedConflictMarkers(source, materialized.paths), ["z-conflict.txt"]);
});

test("merge-file execution failures and invalid output fail before any source mutation", async (t) => {
  const { root, source, capture, plan } = await fixture(t, "base\n", "user\n", "worker\n");
  const valid = Buffer.from(markers("user\n", "base\n", "worker\n"));
  const failure = (fields: object) => Object.assign(new Error("injected merge failure"), { code: 3, stdout: valid }, fields);
  const cases: [string, () => Promise<Output>][] = [
    ["real Git error (missing input)", () => execFileAsync("git", ["merge-file", "-p", join(root, "missing"), join(root, "base"), join(root, "result")], { encoding: "buffer" })],
    ["real signal kill", () => execFileAsync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "buffer" })],
    ["real spawn failure", () => execFileAsync(join(root, "missing-executable"), [], { encoding: "buffer" })],
    ["real maxBuffer failure with partial stdout", () => execFileAsync(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { encoding: "buffer", maxBuffer: 1024 })],
    ...[0, -1, 128, 255, 1.5, "3", "ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].map((code): [string, () => Promise<Output>] =>
      [`invalid exit code ${JSON.stringify(code)}`, async () => { throw failure({ code }); }]),
    ["conflict count with killed flag", async () => { throw failure({ killed: true }); }],
    ["conflict count with signal", async () => { throw failure({ signal: "SIGTERM" }); }],
    ["non-Buffer stdout", async () => { throw failure({ stdout: valid.toString() }); }],
    ["missing stdout", async () => { throw failure({ stdout: undefined }); }],
    ["oversized stdout", async () => { throw failure({ stdout: Buffer.alloc(128 * 1024 * 1024 + 1, 120) }); }],
    ["binary stdout", async () => { throw failure({ stdout: Buffer.concat([valid, Buffer.from([0])]) }); }],
    ["empty conflict stdout", async () => { throw failure({ stdout: Buffer.alloc(0) }); }],
    ["truncated conflict markers", async () => { throw failure({ stdout: Buffer.from("<<<<<<< current workspace\nuser\n") }); }],
    ["invalid clean stdout", async () => ({ stdout: Buffer.from([0]), stderr: Buffer.alloc(0) })],
  ];
  const beforeNames = await readdir(source);
  const beforeStatus = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout;
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      let called = false;
      mergeOverride = async () => { called = true; return override(); };
      try {
        await assert.rejects(materializeLandingConflicts(capture, plan, label));
      } finally {
        mergeOverride = undefined;
      }
      assert.ok(called, "failure must occur in merge-file, after earlier clean paths were prepared");
      assert.equal(await readFile(join(source, "a-clean.txt"), "utf8"), "clean base\n");
      assert.equal(await readFile(join(source, "b-delete.txt"), "utf8"), "keep until prepared\n");
      assert.equal(await readFile(join(source, "z-conflict.txt"), "utf8"), "user\n");
      assert.deepEqual(await readdir(source), beforeNames);
      assert.equal((await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: source })).stdout, beforeStatus);
    });
  }
});
