// #301: every raw (non-Git) parent-review checkpoint lives in the live Pi
// session's external namespace under Pi's agent-data directory:
//   <agentDir>/sessions/pi-review-gate/<sessionId>/checkpoints/<workspace>/<window>-<owner>/record.json
// for persisted and in-memory sessions alike; never inside a workspace.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  advanceRawReviewCheckpoint, captureReviewCheckpoint, changedRawCheckpointPaths, compareReviewCheckpoints,
  isSafeCheckpointSessionId, loadReviewCheckpoint, rawReviewCheckpointRecordPath, releaseReviewCheckpoint,
  RAW_CHECKPOINT_DAMAGE_PREFIX, reviewCheckpointScopeFromContext, reviewCheckpointSessionDirectory,
  type ReviewCheckpointDescriptor, type ReviewCheckpointScope,
} from "../src/review-checkpoint";
import { captureWaveBase } from "../src/execution/wave-repository";

const exec = promisify(execFile);
type Raw = Extract<ReviewCheckpointDescriptor, { kind: "raw" }>;

interface Fixture { base: string; root: string; agentDir: string; scope: ReviewCheckpointScope }
async function fixture(run: (f: Fixture) => Promise<void>, sessionId = "session-a"): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "prg-session-storage-")));
  const root = join(base, "workspace");
  const agentDir = join(base, "agent");
  await mkdir(root);
  await mkdir(agentDir);
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = base;
  try { await run({ base, root, agentDir, scope: { agentDir, sessionId } }); }
  finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    await rm(base, { recursive: true, force: true });
  }
}
async function raw(root: string, id: string, scope: ReviewCheckpointScope | undefined): Promise<Raw> {
  const captured = await captureReviewCheckpoint(root, id, { scope });
  assert.equal(captured.status, "ok", JSON.stringify(captured));
  if (captured.status !== "ok" || captured.value.kind !== "raw") throw new Error("expected raw checkpoint");
  return captured.value;
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}
async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if ((await lstat(join(dir, name))).isDirectory()) out.push(...await walkFiles(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}
const posixOnly = { skip: process.platform === "win32" };

test("raw records use the universal session layout outside the workspace with private modes", async () => fixture(async ({ root, agentDir, scope }) => {
  await writeFile(join(root, "file.txt"), "baseline\n");
  const before = await raw(root, "window-1-layout", scope);
  assert.equal(before.format, "prg-parent-raw/v2");
  assert.equal(before.sessionId, "session-a");
  assert.equal(before.root, root);
  const record = rawReviewCheckpointRecordPath(scope, root, before);
  const namespace = join(agentDir, "sessions", "pi-review-gate", "session-a", "checkpoints");
  assert.equal(reviewCheckpointSessionDirectory(scope), namespace);
  assert.ok(record.startsWith(`${namespace}${sep}`), record);
  assert.ok((await stat(record)).isFile());
  // No checkpoint folder (or anything else) is ever created in the workspace.
  assert.deepEqual(await readdir(root), ["file.txt"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(record)).mode & 0o777, 0o600);
    for (let dir = dirname(record); dir !== join(agentDir, "sessions"); dir = dirname(dir)) {
      assert.equal((await stat(dir)).mode & 0o077, 0, `${dir} is private`);
    }
  }
  // The record binds the trusted live session, canonical workspace, window and owner.
  const parsed = JSON.parse(await readFile(record, "utf8"));
  assert.deepEqual(Object.keys(parsed).sort(), ["entries", "format", "owner", "root", "sessionId", "windowId"]);
  assert.equal(parsed.sessionId, "session-a");
  assert.equal(parsed.root, root);
  assert.equal(parsed.windowId, "window-1-layout");
  assert.equal(parsed.owner, before.owner);
  assert.equal((await releaseReviewCheckpoint(root, before, { scope })).status, "ok");
}));

test("raw lifecycle: capture, load, frozen compare, guard, advance and verified-owner release", async () => fixture(async ({ root, agentDir, scope }) => {
  await writeFile(join(root, "a.txt"), "a0\n");
  await writeFile(join(root, "b.txt"), "b0\n");
  const before = await raw(root, "window-1-before", scope);
  await writeFile(join(root, "a.txt"), "a1\n");
  const after = await raw(root, "window-1-after", scope);
  await writeFile(join(root, "a.txt"), "live bytes are never compared\n");
  await writeFile(join(root, "b.txt"), "b1\n");
  const compared = await compareReviewCheckpoints(root, before, after, { scope });
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  if (compared.status === "ok") {
    assert.deepEqual(compared.value.changes.map((c) => [c.path, c.old?.bytes?.toString(), c.new?.bytes?.toString()]),
      [["a.txt", "a0\n", "a1\n"]]);
  }
  const guard = await changedRawCheckpointPaths(root, before, { scope });
  assert.equal(guard.status, "ok", JSON.stringify(guard));
  if (guard.status === "ok") assert.deepEqual([...guard.value].sort(), ["a.txt", "b.txt"]);
  const advanced = await advanceRawReviewCheckpoint(root, before, ["b.txt"], "parent-landed-1", { scope });
  assert.equal(advanced.status, "ok", JSON.stringify(advanced));
  if (advanced.status !== "ok") return;
  const loaded = await loadReviewCheckpoint(root, advanced.value, { scope });
  assert.equal(loaded.status, "ok");
  if (loaded.status === "ok" && loaded.value.kind === "raw") {
    assert.deepEqual(loaded.value.entries.map((e) => [e.path, Buffer.from(e.contentB64!, "base64").toString()]),
      [["a.txt", "a0\n"], ["b.txt", "b1\n"]], "only the selected path advanced");
  }
  // Unrelated content in the session namespace is never touched by release.
  const sessionRoot = join(agentDir, "sessions", "pi-review-gate", "session-a");
  await writeFile(join(sessionRoot, "unrelated.txt"), "keep");
  const workspaceStore = dirname(dirname(rawReviewCheckpointRecordPath(scope, root, before)));
  await mkdir(join(workspaceStore, "unverified-content"));
  for (const descriptor of [before, after, advanced.value]) {
    assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope })).status, "ok");
    assert.equal(await exists(dirname(rawReviewCheckpointRecordPath(scope, root, descriptor))), false);
  }
  assert.equal(await readFile(join(sessionRoot, "unrelated.txt"), "utf8"), "keep");
  assert.deepEqual(await readdir(workspaceStore), ["unverified-content"], "session root, store and unverified content remain");
  assert.equal((await loadReviewCheckpoint(root, before, { scope })).status, "failed");
}));

test("failed verification deletes nothing: wrong session, wrong workspace, tampered digest and corrupt record", async () => fixture(async ({ base, root, agentDir, scope }) => {
  await writeFile(join(root, "file.txt"), "baseline\n");
  const descriptor = await raw(root, "window-1-keep", scope);
  const record = rawReviewCheckpointRecordPath(scope, root, descriptor);
  const other = join(base, "other-workspace");
  await mkdir(other);
  const attempts: Array<[string, Promise<{ status: string; detail?: string }>]> = [
    ["wrong session", releaseReviewCheckpoint(root, descriptor, { scope: { agentDir, sessionId: "session-b" } })],
    ["wrong session", releaseReviewCheckpoint(root, { ...descriptor, sessionId: "session-b" }, { scope })],
    ["wrong root", releaseReviewCheckpoint(other, descriptor, { scope })],
    ["digest", releaseReviewCheckpoint(root, { ...descriptor, digest: "0".repeat(64) }, { scope })],
    ["live Pi session scope", releaseReviewCheckpoint(root, descriptor, {})],
    ["malformed raw descriptor", releaseReviewCheckpoint(root, { ...descriptor, extra: "x" } as unknown as Raw, { scope })],
  ];
  for (const [pattern, attempt] of attempts) {
    const result = await attempt;
    assert.equal(result.status, "failed", pattern);
    assert.match(result.detail ?? "", new RegExp(pattern));
    assert.ok((await stat(record)).isFile(), `${pattern}: the verified record survives`);
  }
  // Identity/scope failures never carry the recoverable-damage marker.
  const wrong = await loadReviewCheckpoint(root, descriptor, { scope: { agentDir, sessionId: "session-b" } });
  assert.ok(wrong.status === "failed" && !(wrong.detail ?? "").startsWith(RAW_CHECKPOINT_DAMAGE_PREFIX));
  await writeFile(record, "corrupt");
  const corrupt = await loadReviewCheckpoint(root, descriptor, { scope });
  assert.ok(corrupt.status === "failed" && (corrupt.detail ?? "").startsWith(RAW_CHECKPOINT_DAMAGE_PREFIX), JSON.stringify(corrupt));
  assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope })).status, "failed");
  assert.equal(await readFile(record, "utf8"), "corrupt", "a failed verification deletes nothing");
  await rm(record);
  const missing = await loadReviewCheckpoint(root, descriptor, { scope });
  assert.ok(missing.status === "failed" && (missing.detail ?? "").startsWith(RAW_CHECKPOINT_DAMAGE_PREFIX));
}));

test("a record whose bound session/workspace disagrees is an identity mismatch, never damage", async () => fixture(async ({ root, scope }) => {
  await writeFile(join(root, "file.txt"), "baseline\n");
  const descriptor = await raw(root, "window-1-bound", scope);
  const record = rawReviewCheckpointRecordPath(scope, root, descriptor);
  const parsed = JSON.parse(await readFile(record, "utf8"));
  parsed.sessionId = "session-b";
  const bytes = Buffer.from(JSON.stringify(parsed));
  await rm(record);
  await writeFile(record, bytes, { mode: 0o600 });
  const { createHash } = await import("node:crypto");
  const forged = { ...descriptor, digest: createHash("sha256").update(bytes).digest("hex") };
  const loaded = await loadReviewCheckpoint(root, forged, { scope });
  assert.equal(loaded.status, "failed");
  if (loaded.status === "failed") {
    assert.match(loaded.detail ?? "", /record binding mismatch/);
    assert.ok(!(loaded.detail ?? "").startsWith(RAW_CHECKPOINT_DAMAGE_PREFIX));
  }
}));

test("raw capture without a live session id fails closed and creates nothing; Git is unchanged", async () => fixture(async ({ base, root, agentDir }) => {
  await writeFile(join(root, "file.txt"), "baseline\n");
  const failed = await captureReviewCheckpoint(root, "window-1-noscope");
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(failed.detail ?? "", /live Pi session scope/);
  assert.deepEqual(await readdir(root), ["file.txt"]);
  assert.deepEqual(await readdir(agentDir), [], "no fallback destination is invented");
  for (const sessionId of ["../escape", "a/b", "CON", "nul.txt", ".hidden", "trailing.", ""]) {
    assert.equal(isSafeCheckpointSessionId(sessionId), false, sessionId);
    const unsafe = await captureReviewCheckpoint(root, "window-1-unsafe", { scope: { agentDir, sessionId } });
    assert.equal(unsafe.status, "failed", sessionId);
  }
  assert.deepEqual(await readdir(agentDir), []);
  // A Git repository keeps using the Git backend with or without a session scope.
  const repo = join(base, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "untracked.txt"), "x");
  const git = await captureReviewCheckpoint(repo, "window-1-git");
  assert.equal(git.status, "ok", JSON.stringify(git));
  if (git.status === "ok") {
    assert.equal(git.value.kind, "git");
    assert.equal((await releaseReviewCheckpoint(repo, git.value)).status, "ok");
  }
  assert.deepEqual(await readdir(agentDir), []);
}));

test("sessions and workspaces are isolated, including concurrent captures", async () => fixture(async ({ base, root, agentDir, scope }) => {
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "ignored");
  await writeFile(join(root, "file.txt"), "shared\n");
  const second = join(base, "workspace-2");
  await mkdir(second);
  await writeFile(join(second, "other.txt"), "other\n");
  const scopeB = { agentDir, sessionId: "session-b" };
  const captured = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => raw(root, `window-1-a${i}`, scope)),
    ...Array.from({ length: 4 }, (_, i) => raw(root, `window-1-b${i}`, scopeB)),
    ...Array.from({ length: 2 }, (_, i) => raw(second, `window-1-c${i}`, scope)),
  ]);
  assert.equal(new Set(captured.map((d) => d.owner)).size, captured.length);
  for (const descriptor of captured) {
    const owning = descriptor.sessionId === "session-a" ? scope : scopeB;
    const workspace = descriptor.root;
    const loaded = await loadReviewCheckpoint(workspace, descriptor, { scope: owning });
    assert.equal(loaded.status, "ok", JSON.stringify(loaded));
    if (loaded.status === "ok" && loaded.value.kind === "raw" && workspace === root) {
      assert.deepEqual(loaded.value.entries.map((e) => e.path), [".gitignore", "file.txt"]);
    }
    // Another live session cannot see or release it.
    const foreign = descriptor.sessionId === "session-a" ? scopeB : scope;
    assert.equal((await loadReviewCheckpoint(workspace, descriptor, { scope: foreign })).status, "failed");
  }
  const sessionA = rawReviewCheckpointRecordPath(scope, root, captured[0]!);
  const sessionB = rawReviewCheckpointRecordPath(scopeB, root, captured[4]!);
  const otherWorkspace = rawReviewCheckpointRecordPath(scope, second, captured[8]!);
  assert.notEqual(dirname(dirname(sessionA)), dirname(dirname(sessionB)));
  assert.notEqual(dirname(dirname(sessionA)), dirname(dirname(otherWorkspace)));
  // Ignore-matcher scratch is external and removed: only owned generations remain.
  for (const store of [dirname(dirname(sessionA)), dirname(dirname(sessionB))]) {
    for (const name of await readdir(store)) assert.match(name, /^window-1-[abc]\d-[0-9a-f]{32}$/);
  }
  assert.deepEqual((await readdir(root)).sort(), [".gitignore", "file.txt", "ignored.txt"]);
  for (const descriptor of captured) {
    const owning = descriptor.sessionId === "session-a" ? scope : scopeB;
    assert.equal((await releaseReviewCheckpoint(descriptor.root, descriptor, { scope: owning })).status, "ok");
  }
}));

test("ordinary project .pi-review-gate content, top-level and nested, stays eligible", async () => fixture(async ({ root, scope }) => {
  await mkdir(join(root, ".pi-review-gate", "checkpoints"), { recursive: true });
  await writeFile(join(root, ".pi-review-gate", "notes.md"), "project notes\n");
  await writeFile(join(root, ".pi-review-gate", "checkpoints", "user-file"), "user data\n");
  await mkdir(join(root, "nested", ".pi-review-gate"), { recursive: true });
  await writeFile(join(root, "nested", ".pi-review-gate", "config.json"), "{}\n");
  const before = await raw(root, "window-1-eligible", scope);
  await writeFile(join(root, ".pi-review-gate", "notes.md"), "edited notes\n");
  const after = await raw(root, "window-1-eligible-after", scope);
  const loaded = await loadReviewCheckpoint(root, before, { scope });
  assert.equal(loaded.status, "ok");
  if (loaded.status === "ok" && loaded.value.kind === "raw") {
    assert.deepEqual(loaded.value.entries.map((e) => e.path), [
      ".pi-review-gate/checkpoints/user-file", ".pi-review-gate/notes.md", "nested/.pi-review-gate/config.json",
    ]);
  }
  const compared = await compareReviewCheckpoints(root, before, after, { scope });
  assert.ok(compared.status === "ok");
  if (compared.status === "ok") assert.deepEqual(compared.value.changes.map((c) => c.path), [".pi-review-gate/notes.md"]);
  for (const descriptor of [before, after]) assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope })).status, "ok");
  assert.equal(await readFile(join(root, ".pi-review-gate", "checkpoints", "user-file"), "utf8"), "user data\n");
}));

test("wave capture after raw checkpoints sees no internal records and fits an exact budget", async () => fixture(async ({ base, root, scope }) => {
  const files: Record<string, string> = {
    "src.txt": "source bytes\n",
    ".pi-review-gate/notes.md": "ordinary project notes\n",
    "nested/.pi-review-gate/data.txt": "nested ordinary data\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const budget = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  const descriptors = [await raw(root, "window-1-wave", scope), await raw(root, "window-1-wave-2", scope)];
  assert.deepEqual(await walkFiles(root), Object.keys(files).sort());
  await mkdir(join(base, "artifacts"));
  const capture = await captureWaveBase({
    cwd: root, artifactDir: join(base, "artifacts"), maxSnapshotBytes: budget, maxCaptureAttempts: 1, artifactTtlMs: 0,
  });
  assert.deepEqual([...capture.paths].sort(), Object.keys(files).sort());
  assert.equal(capture.totalBytes, budget, "internal records consume no capture budget");
  for (const descriptor of descriptors) assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope })).status, "ok");
}));

test("Pi-owned agent/sessions directories may be symlinked; extension-owned directories may not", async () => fixture(async ({ base, root, scope }) => {
  await writeFile(join(root, "file.txt"), "x");
  const realAgent = join(base, "real-agent");
  await mkdir(realAgent);
  const linkedAgent = join(base, "linked-agent");
  await symlink(realAgent, linkedAgent, "dir");
  const linkedScope = { agentDir: linkedAgent, sessionId: "session-linked" };
  const descriptor = await raw(root, "window-1-linked", linkedScope);
  assert.ok(await exists(join(realAgent, "sessions", "pi-review-gate", "session-linked", "checkpoints")));
  assert.equal((await loadReviewCheckpoint(root, descriptor, { scope: linkedScope })).status, "ok");
  assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope: linkedScope })).status, "ok");
  // A symlinked extension namespace is refused, with nothing written through it.
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(join(scope.agentDir, "sessions"), { recursive: true });
  await symlink(elsewhere, join(scope.agentDir, "sessions", "pi-review-gate"), "dir");
  const refused = await captureReviewCheckpoint(root, "window-1-refused", { scope });
  assert.equal(refused.status, "failed");
  if (refused.status === "failed") assert.match(refused.detail ?? "", /unsafe raw checkpoint directory/);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.deepEqual(await readdir(root), ["file.txt"]);
}));

test("non-private extension directories are refused on POSIX", posixOnly, async () => fixture(async ({ root, scope }) => {
  await writeFile(join(root, "file.txt"), "x");
  const namespace = join(scope.agentDir, "sessions", "pi-review-gate");
  await mkdir(namespace, { recursive: true, mode: 0o755 });
  const { chmod } = await import("node:fs/promises");
  await chmod(namespace, 0o755);
  const refused = await captureReviewCheckpoint(root, "window-1-public", { scope });
  assert.equal(refused.status, "failed");
  if (refused.status === "failed") assert.match(refused.detail ?? "", /not private/);
  assert.deepEqual(await readdir(namespace), []);
}));

test("an agent-data directory overlapping the capture workspace is refused explicitly, creating nothing", async () => fixture(async ({ root }) => {
  await writeFile(join(root, "file.txt"), "x");
  // e.g. PI_CODING_AGENT_DIR inside the workspace, or a session started in an
  // ancestor of the agent directory such as the home directory.
  const inside = { agentDir: join(root, ".pi", "agent"), sessionId: "session-inside" };
  const refused = await captureReviewCheckpoint(root, "window-1-overlap", { scope: inside });
  assert.equal(refused.status, "failed");
  if (refused.status === "failed") assert.match(refused.detail ?? "", /overlaps the capture workspace.*unsupported/);
  assert.deepEqual(await readdir(root), ["file.txt"], "no storage is created inside the workspace");
  const ancestorRoot = dirname(root);
  const nested = { agentDir: join(root, "agent"), sessionId: "session-nested" };
  const ancestor = await captureReviewCheckpoint(ancestorRoot, "window-1-ancestor", { scope: nested });
  assert.equal(ancestor.status, "failed");
  assert.equal(await exists(join(root, "agent")), false);
}));

test("live session scope resolution: session id without a session file, Pi-native agent dir semantics", () => {
  const manager = (sessionId: unknown, sessionFile?: string) => ({
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getCwd: () => "/work" },
  });
  // In-memory (--no-session) sessions have a live id but no session file.
  assert.deepEqual(reviewCheckpointScopeFromContext(manager("ephemeral-id"), {}, { homeDir: "/home/u", platform: "linux" }),
    { agentDir: "/home/u/.pi/agent", sessionId: "ephemeral-id" });
  assert.deepEqual(reviewCheckpointScopeFromContext(manager("id", "/elsewhere/sessions/x.jsonl"), { PI_CODING_AGENT_DIR: "~/custom" }, { homeDir: "/home/u", platform: "linux" }),
    { agentDir: "/home/u/custom", sessionId: "id" }, "the conversation file location never selects checkpoint storage");
  assert.deepEqual(reviewCheckpointScopeFromContext(manager("id"), { PI_CODING_AGENT_DIR: "/c/Users/u/pi" }, { homeDir: "C:\\Users\\u", platform: "win32" }),
    { agentDir: "C:\\Users\\u\\pi", sessionId: "id" });
  assert.deepEqual(reviewCheckpointScopeFromContext(manager("id"), {}, { homeDir: "C:\\Users\\u", platform: "win32" }),
    { agentDir: "C:\\Users\\u\\.pi\\agent", sessionId: "id" });
  assert.equal(reviewCheckpointScopeFromContext(manager(undefined)), undefined);
  assert.equal(reviewCheckpointScopeFromContext(manager("")), undefined);
  assert.equal(reviewCheckpointScopeFromContext({ sessionManager: {} }), undefined);
  assert.equal(reviewCheckpointScopeFromContext(undefined), undefined);
});

test("only the agent directory itself and sessions/ are created above the namespace", async () => fixture(async ({ base, root }) => {
  await writeFile(join(root, "file.txt"), "x");
  // A missing agent directory whose parent exists is created privately.
  const fresh = { agentDir: join(base, "fresh-agent"), sessionId: "session-fresh" };
  const descriptor = await raw(root, "window-1-fresh", fresh);
  assert.ok(await exists(join(base, "fresh-agent", "sessions", "pi-review-gate", "session-fresh", "checkpoints")));
  assert.equal((await releaseReviewCheckpoint(root, descriptor, { scope: fresh })).status, "ok");
  // Deeper missing ancestors are never invented; capture fails explicitly.
  const deep = { agentDir: join(base, "missing-parent", "agent"), sessionId: "session-deep" };
  const refused = await captureReviewCheckpoint(root, "window-1-deep", { scope: deep });
  assert.equal(refused.status, "failed");
  if (refused.status === "failed") assert.match(refused.detail ?? "", /agent-data directory and its parent do not exist/);
  assert.equal(await exists(join(base, "missing-parent")), false);
}));
