import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodeTest, { type TestContext } from "node:test";
import {
  MAX_CATALOG_ISSUES,
  MAX_SESSION_HEADER_BYTES,
  MAX_SESSION_HEADER_FIELD_LENGTH,
  MAX_SAVED_SESSION_CAPTION_CODEPOINTS,
  NO_MESSAGES_CAPTION,
  admitSavedSession,
  canonicalSavedSessionCaption,
  isSavedSessionAdmission,
  isSavedSessionCatalog,
  listSavedSessions,
  readSavedSessionHeader,
  SavedSessionCatalog,
  SavedSessionRow,
} from "../src/session-host/saved-sessions";
import { MAX_SDK_ANCESTOR_STEPS, PI_PACKAGE_NAME } from "../src/session-host/native-session-sdk";

/**
 * Owned private fixture subtree: all synthetic fixture trees live inside the
 * ignored node_modules directory (never directly under the worktree root), so
 * test artifacts can never surface as untracked worktree files.
 */
const PRIVATE_FIXTURE_ROOT = join(process.cwd(), "node_modules", ".worker-private-saved", "fixtures");

/** Per-test completion state: only a successfully completed body may clean up. */
interface FixtureRun {
  succeeded: boolean;
}

const fixtureRunStorage = new AsyncLocalStorage<FixtureRun>();
const fixtureOwners = new Map<string, { run: FixtureRun; dev: bigint; ino: bigint }>();

/**
 * Test wrapper that tracks successful completion of the test body. Teardown
 * hooks (t.after) run after failed tests too, so cleanup consults this state:
 * a failed body preserves its fixtures as witnesses instead of deleting them.
 */
function test(name: string, body: (t: TestContext) => unknown): Promise<void> {
  return nodeTest(name, async (t) => {
    const run: FixtureRun = { succeeded: false };
    await fixtureRunStorage.run(run, () => body(t));
    run.succeeded = true;
  });
}

async function makePrivateRoot(prefix: string): Promise<string> {
  const run = fixtureRunStorage.getStore();
  if (run === undefined) throw new Error("fixture creation requires an owned test context");
  await mkdir(PRIVATE_FIXTURE_ROOT, { recursive: true });
  const root = await realpath(await mkdtemp(join(PRIVATE_FIXTURE_ROOT, `.${prefix}-`)));
  await chmod(root, 0o700);
  // Owned-root identity: cleanup later verifies it is still the SAME directory.
  const stats = lstatSync(root, { bigint: true });
  fixtureOwners.set(root, { run, dev: stats.dev, ino: stats.ino });
  return root;
}

/**
 * Preserve failed-test witnesses at 0700. Only successfully completed tests
 * may remove their positively identified roots (dev/ino verified against the
 * creation-time observation); `.terraform` is pruned before any descent. On a
 * cleanup failure the tree is retained with 0700 permissions.
 */
async function removeFixtureTree(root: string): Promise<void> {
  const owner = fixtureOwners.get(root);
  if (owner === undefined) throw new Error("refusing cleanup of an unknown fixture root");
  let stats;
  try {
    stats = lstatSync(root, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
    throw error;
  }
  // Identity guard: a replaced root is never touched.
  if (stats.isSymbolicLink() || !stats.isDirectory()
    || stats.dev !== owner.dev || stats.ino !== owner.ino) return;
  if (!owner.run.succeeded) {
    await chmod(root, 0o700); // failed witness: preserved, never deleted
    return;
  }
  try {
    await pruneAndRemove(root);
  } catch {
    try {
      await chmod(root, 0o700);
    } catch {
      // Already gone: nothing to retain.
    }
  }
}

async function pruneAndRemove(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (entry.name === ".terraform") continue; // pruned before any descent: preserved
      await pruneAndRemove(full);
    } else {
      await rm(full);
    }
  }
  await rmdir(dir);
}

interface CatalogFixture {
  /** Real (symlink-resolved) root of the synthetic fixture tree. */
  root: string;
  agentDir: string;
  sessionsRoot: string;
  workspace: string;
}

async function makeCatalogFixture(prefix = "pi-saved-sessions"): Promise<CatalogFixture> {
  const root = await makePrivateRoot(prefix);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { root, agentDir, sessionsRoot: join(agentDir, "sessions"), workspace };
}

/** Fixed timestamp for synthetic public session headers (the actual declared shape). */
const SESSION_HEADER_TIMESTAMP = "2025-01-01T00:00:00.000Z";

/** One synthetic PUBLIC SessionHeader line (the actual declared shape). */
function sessionHeaderLine(id: string, cwd: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: SESSION_HEADER_TIMESTAMP, cwd });
}

/** Write one synthetic saved-conversation JSONL (header line plus optional meta line). */
async function writeSessionFile(
  dir: string,
  name: string,
  id: string,
  cwd: string,
  meta?: { name?: string; firstMessage?: string },
): Promise<string> {
  const file = join(dir, name);
  const lines = [sessionHeaderLine(id, cwd)];
  if (meta) lines.push(JSON.stringify({ type: "meta", ...meta }));
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

interface InjectedListAllOptions {
  /** Records every explicit directory the catalog lists. */
  calls?: string[];
  /** Per-directory behavior override (rows or thrown error); receives the signal like the real SDK. */
  behavior?: (sessionDir: string, signal?: AbortSignal) => NativeSessionSdkInfoLike[] | Promise<NativeSessionSdkInfoLike[]>;
}

interface NativeSessionSdkInfoLike {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
}

/**
 * Synthetic public-API injection mimicking the SDK's explicit flat-directory
 * listAll: only `.jsonl` files in the given directory, no recursion. This is
 * a component-test seam, never a production stub of the real SDK.
 */
function makeInjectedListAll(options: InjectedListAllOptions = {}) {
  const calls = options.calls ?? [];
  return async (
    sessionDir: string,
    _onProgress?: (progress: Readonly<Record<string, unknown>>) => void,
    signal?: AbortSignal,
  ): Promise<NativeSessionSdkInfoLike[]> => {
    calls.push(sessionDir);
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (options.behavior) return options.behavior(sessionDir, signal);
    const entries = await readdir(sessionDir, { withFileTypes: true });
    const rows: NativeSessionSdkInfoLike[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue; // flat list filters .jsonl only
      const file = join(sessionDir, entry.name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      let header: Record<string, unknown> | undefined;
      let meta: Record<string, unknown> | undefined;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") continue;
        const record = parsed as Record<string, unknown>;
        if (!header && typeof record.id === "string") header = record;
        if (record.type === "meta") meta = record;
      }
      if (!header) continue;
      rows.push({
        path: file,
        id: header.id as string,
        cwd: typeof header.cwd === "string" ? header.cwd : "",
        ...(typeof meta?.name === "string" ? { name: meta.name } : {}),
        ...(typeof meta?.firstMessage === "string" ? { firstMessage: meta.firstMessage } : {}),
      });
    }
    return rows;
  };
}

/** Snapshot the fixture's sessions tree (names + bytes) for read-only assertions. */
async function snapshotSessionsTree(sessionsRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
      else snapshot.set(full, entry.isSymbolicLink() ? "symlink" : (await readFile(full)).toString("utf8"));
    }
  };
  await walk(sessionsRoot);
  return snapshot;
}

test("listSavedSessions uses the public explicit flat-directory listAll only: prunes .terraform before descent and skips directory symlinks", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  const terraform = join(fixture.sessionsRoot, ".terraform", "module");
  const outside = join(fixture.root, "outside-proj");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true }), mkdir(terraform, { recursive: true }), mkdir(outside, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);
  const terraformFile = await writeSessionFile(terraform, "tf.jsonl", "id-tf", fixture.workspace);
  const outsideFile = await writeSessionFile(outside, "o1.jsonl", "id-out", fixture.workspace);
  await symlink(outside, join(fixture.sessionsRoot, "link-proj"));

  const calls: string[] = [];
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll({ calls }) });

  assert.deepEqual(
    [...calls].sort(),
    [projA, projB].sort(),
    "only the approved real project directories are listed, each with its EXPLICIT path (no no-arg scan)",
  );
  assert.ok(!calls.some((dir) => dir.includes(".terraform")), ".terraform is pruned before any descent");
  assert.ok(!calls.some((dir) => dir === join(fixture.sessionsRoot, "link-proj")), "directory symlinks are never followed");
  assert.deepEqual(
    catalog.rows.map((row) => row.id).sort(),
    ["id-a1", "id-b1"],
    "rows come only from the approved project directories",
  );
  const rowA = catalog.rows.find((row) => row.id === "id-a1");
  assert.ok(rowA);
  assert.equal(rowA.file, join(projA, "s1.jsonl"));
  assert.equal(rowA.cwd, fixture.workspace);
  assert.equal(rowA.projectDir, projA);
  assert.equal(catalog.agentDir, fixture.agentDir);
  assert.equal(catalog.sessionsRoot, fixture.sessionsRoot);
  assert.equal(catalog.issueCount, 0);

  // Read-only: the pruned and skipped trees keep their exact bytes.
  assert.match(await readFile(terraformFile, "utf8"), /id-tf/, ".terraform content is untouched");
  assert.match(await readFile(outsideFile, "utf8"), /id-out/, "the symlinked external tree is untouched");
});

test("listSavedSessions returns an honest empty catalog for a missing sessions root and refuses a symlinked root", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  // Missing sessions root: honest empty, no error.
  const bareAgent = join(fixture.root, "bare-agent");
  await mkdir(bareAgent, { recursive: true });
  const empty = await listSavedSessions({ agentDir: bareAgent, listAll: makeInjectedListAll() });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.issueCount, 0);
  assert.ok(isSavedSessionCatalog(empty));

  // Symlinked sessions root: never followed; honest empty with a bounded issue.
  const realRoot = join(fixture.root, "real-sessions");
  await mkdir(realRoot, { recursive: true });
  await writeSessionFile(realRoot, "s1.jsonl", "id-x", fixture.workspace);
  const linkedAgent = join(fixture.root, "linked-agent");
  await mkdir(linkedAgent, { recursive: true });
  await symlink(realRoot, join(linkedAgent, "sessions"));
  const refused = await listSavedSessions({ agentDir: linkedAgent, listAll: makeInjectedListAll() });
  assert.deepEqual(refused.rows, []);
  assert.equal(refused.issueCount, 1);
  assert.match(refused.issues[0].reason, /not a real directory/);

  // Both early-return catalogs are frozen minted data exactly like normal
  // results: the brand authenticates immutable contents on every path.
  assert.ok(Object.isFrozen(empty) && Object.isFrozen(empty.rows), "the missing-root catalog is frozen");
  assert.ok(
    Object.isFrozen(refused) && Object.isFrozen(refused.rows) && Object.isFrozen(refused.issues[0]),
    "the unsafe-root catalog, its rows, and its issues are frozen",
  );

  // A stale row from a real catalog cannot be inserted into an early-return
  // catalog, and root/revision cannot be rewritten to look current.
  const staleAgent = join(fixture.root, "stale-agent");
  await mkdir(join(staleAgent, "sessions", "proj"), { recursive: true });
  await writeSessionFile(join(staleAgent, "sessions", "proj"), "s1.jsonl", "id-stale", fixture.workspace);
  const staleCatalog = await listSavedSessions({ agentDir: staleAgent, listAll: makeInjectedListAll() });
  const staleRow = staleCatalog.rows[0];
  assert.throws(() => {
    empty.rows.push(staleRow);
  }, TypeError, "a stale row cannot be inserted into a branded empty catalog");
  assert.throws(() => {
    empty.agentDir = staleAgent;
  }, TypeError, "the agent root cannot be rewritten");
  assert.throws(() => {
    empty.revision = staleCatalog.revision;
  }, TypeError, "the revision cannot be rewritten");
  // And the stale row is refused against the early-return catalog anyway.
  assert.deepEqual(admitSavedSession(empty, staleRow), { status: "refused", reason: "unknown-row" });
});

test("listSavedSessions never mutates process.env and does not consult HOME or PI_CODING_AGENT_DIR", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const sentinel = "pi-saved-sessions-sentinel";
  process.env[sentinel] = "keep-me";
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  try {
    // Point the env at a DIFFERENT location: the explicit agentDir must win.
    process.env.PI_CODING_AGENT_DIR = join(fixture.root, "elsewhere-agent");
    process.env.HOME = join(fixture.root, "elsewhere-home");
    const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
    assert.equal(catalog.agentDir, fixture.agentDir, "the explicit agent directory is used, never the env-resolved one");
    assert.deepEqual(catalog.rows.map((row) => row.id), ["id-a1"]);
  } finally {
    delete process.env[sentinel];
    if (previousAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.equal(process.env[sentinel], undefined);
});

test("listSavedSessions preserves unknown files and reports malformed entries with bounded issues", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  const junk = join(projA, "junk.txt");
  await writeFile(junk, "unknown preserved content\n", "utf8");
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const calls: string[] = [];
  const catalog = await listSavedSessions({
    agentDir: fixture.agentDir,
    listAll: makeInjectedListAll({
      calls,
      behavior: (dir) => {
        if (dir === projB) throw new Error("synthetic per-directory failure");
        const rows: NativeSessionSdkInfoLike[] = [];
        if (dir === projA) {
          rows.push({ path: join(projA, "s1.jsonl"), id: "id-a1", cwd: fixture.workspace });
          rows.push({ path: join(projA, "bad.jsonl"), id: "", cwd: fixture.workspace } as NativeSessionSdkInfoLike);
        }
        return rows;
      },
    }),
  });

  assert.deepEqual(catalog.rows.map((row) => row.id), ["id-a1"], "valid rows are preserved");
  const reasons = catalog.issues.map((issue) => issue.reason).sort();
  assert.deepEqual(reasons, ["malformed session entry", "session listing failed"].sort());
  assert.equal(catalog.issueCount, 2, "the total issue count is truthful");
  assert.equal(await readFile(junk, "utf8"), "unknown preserved content\n", "unknown files are preserved untouched");
});

test("canonicalSavedSessionCaption enforces the 256-codepoint display limit with name/first-message fallback", () => {
  // Persisted name wins; spaces and Unicode are preserved.
  assert.equal(canonicalSavedSessionCaption("my project", "ignored message"), "my project");
  // Control characters become spaces for single-line display.
  assert.equal(canonicalSavedSessionCaption("a\u0001b\nc", undefined), "a b c");
  assert.equal(canonicalSavedSessionCaption("del\u007fchar", undefined), "del char");
  // First-message fallback when the name is absent or blank.
  assert.equal(canonicalSavedSessionCaption(undefined, "first user message"), "first user message");
  assert.equal(canonicalSavedSessionCaption("   ", "fallback msg"), "fallback msg");
  assert.equal(canonicalSavedSessionCaption("", ""), NO_MESSAGES_CAPTION);
  assert.equal(canonicalSavedSessionCaption(undefined, undefined), NO_MESSAGES_CAPTION);

  // Codepoint (not UTF-16 unit) limit: astral-plane characters count once.
  const emoji = "\u{1F600}";
  const exactly256 = emoji.repeat(256);
  assert.equal(canonicalSavedSessionCaption(exactly256, undefined), exactly256, "exactly 256 codepoints is not truncated");
  const over = emoji.repeat(300);
  const truncated = canonicalSavedSessionCaption(over, undefined);
  assert.equal(Array.from(truncated).length, MAX_SAVED_SESSION_CAPTION_CODEPOINTS, "the caption is limited to 256 codepoints");
  assert.ok(truncated.endsWith("\u2026"), "truncation is marked with an ellipsis");
  assert.equal(truncated.slice(0, -1), emoji.repeat(255));
});

test("admitSavedSession mints a branded receipt with exact file identity and header verification", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const file = await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const row = catalog.rows[0];
  const result = admitSavedSession(catalog, row);
  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") throw new Error("unreachable");
  assert.ok(isSavedSessionAdmission(result.admission));
  assert.equal(result.admission.agentDir, fixture.agentDir);
  assert.equal(result.admission.file, file);
  assert.equal(result.admission.sessionId, "id-a1");
  assert.equal(result.admission.cwd, fixture.workspace);
  assert.equal(result.admission.workspace, fixture.workspace, "the canonical workspace is bound to the receipt");
  const stats = lstatSync(file, { bigint: true });
  assert.equal(result.admission.dev, stats.dev, "dev identity is a safe bigint");
  assert.equal(result.admission.ino, stats.ino, "ino identity is a safe bigint");

  // A second admission from the same current catalog mints a fresh receipt.
  const again = admitSavedSession(catalog, row);
  assert.equal(again.status, "admitted");
});

test("admitSavedSession refuses replaced, malformed-header, missing, symlinked, and outside-root rows", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const file = await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  // Replaced first line (different id): refused as replaced.
  let catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  let row = catalog.rows[0];
  await writeFile(file, `${sessionHeaderLine("id-other", fixture.workspace)}\n`, "utf8");
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "replaced-file" });

  // Unparseable header: refused as malformed.
  await writeFile(file, "not json at all\n", "utf8");
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "malformed-header" });

  // Missing file: refused honestly.
  await rm(file);
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "missing-file" });

  // Symlinked file: refused; the target is never touched.
  const outsideTarget = join(fixture.root, "outside-target.jsonl");
  await writeFile(outsideTarget, `${sessionHeaderLine("id-a1", fixture.workspace)}\n`, "utf8");
  await symlink(outsideTarget, file);
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "symlink-file" });
  assert.match(await readFile(outsideTarget, "utf8"), /id-a1/);

  // A copied (non-member) row pointing outside the sessions root: refused.
  await rm(file);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  row = catalog.rows[0];
  const tampered: SavedSessionRow = { ...row, file: outsideTarget };
  assert.deepEqual(admitSavedSession(catalog, tampered), { status: "refused", reason: "unknown-row" }, "a copied row is not a member of the catalog");

  // Project directory moved outside the sessions root and replaced with a
  // symlink: the file's inode and header identity are preserved, but the
  // canonical location now escapes the root; the structural check refuses.
  const moved = join(fixture.root, "moved-proj");
  await rename(projA, moved);
  await symlink(moved, projA);
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "outside-sessions-root" });
});

test("admitSavedSession refuses a file replaced with identical header bytes (new inode after cataloging)", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const file = await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const row = catalog.rows[0];

  // Replace the file with byte-identical content under a NEW inode (the
  // original is retained so the filesystem cannot reuse its identity):
  // header content alone must never re-admit a replaced file.
  const originalBytes = await readFile(file);
  await rename(file, `${file}.orig`);
  await writeFile(file, originalBytes);
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "replaced-file" });
});

test("catalog and admission identity data are immutable: fabricated membership and retargeting cannot pass", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const row = catalog.rows[0];
  const result = admitSavedSession(catalog, row);
  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") throw new Error("unreachable");
  const admission = result.admission;

  // The minted identity data is deeply frozen: the brand authenticates
  // immutable contents, not just object identity.
  assert.ok(Object.isFrozen(catalog), "the catalog is frozen");
  assert.ok(Object.isFrozen(catalog.rows), "the rows array is frozen");
  assert.ok(Object.isFrozen(row), "each row is frozen");
  assert.ok(Object.isFrozen(admission), "the admission receipt is frozen");

  // Mutation attempts fail closed instead of silently retargeting data.
  assert.throws(() => {
    catalog.rows.push({ ...row, id: "fabricated" });
  }, TypeError, "fabricated membership cannot be pushed into a published catalog");
  assert.throws(() => {
    catalog.revision = 999;
  }, TypeError, "the revision cannot be rewritten to look current");
  assert.throws(() => {
    row.file = join(fixture.root, "elsewhere.jsonl");
  }, TypeError, "a member row cannot be retargeted");
  assert.throws(() => {
    admission.file = join(fixture.root, "elsewhere.jsonl");
  }, TypeError, "an admitted receipt cannot be retargeted");

  // The data is intact after the failed mutations.
  assert.equal(admission.file, row.file);
  assert.ok(catalog.rows.includes(row));
});

test("admitSavedSession refuses stale catalogs, foreign rows, and fabricated receipts", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  const first = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const second = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  assert.notEqual(first.revision, second.revision, "each list is a new query revision");
  assert.deepEqual(admitSavedSession(first, first.rows[0]), { status: "refused", reason: "stale-catalog" }, "a superseded catalog cannot mint an admission");
  assert.equal(admitSavedSession(second, second.rows[0]).status, "admitted", "the current catalog admits");
  assert.deepEqual(admitSavedSession(second, first.rows[0]), { status: "refused", reason: "unknown-row" }, "rows are bound to their own catalog");

  // Fabricated catalog and receipt objects never pass the brand checks.
  const fabricatedCatalog = {
    agentDir: fixture.agentDir,
    sessionsRoot: fixture.sessionsRoot,
    revision: second.revision,
    rows: [second.rows[0]],
    issues: [],
    issueCount: 0,
  };
  assert.equal(isSavedSessionCatalog(fabricatedCatalog), false);
  assert.deepEqual(admitSavedSession(fabricatedCatalog as unknown as SavedSessionCatalog, second.rows[0]), { status: "refused", reason: "unknown-row" });
  const fabricatedAdmission = {
    agentDir: fixture.agentDir,
    file: join(projA, "s1.jsonl"),
    sessionId: "id-a1",
    cwd: fixture.workspace,
    workspace: fixture.workspace,
    dev: 0n,
    ino: 0n,
  };
  assert.equal(isSavedSessionAdmission(fabricatedAdmission), false);
});

test("admitSavedSession disables unavailable workspaces and refuses caller-reported known-owned duplicates", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const missingWorkspace = join(fixture.root, "no-such-workspace");
  const file = await writeSessionFile(projA, "s1.jsonl", "id-a1", missingWorkspace);

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const row = catalog.rows[0];
  assert.equal(row.cwd, missingWorkspace, "the unavailable workspace is honest row metadata");
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "workspace-unavailable" }, "no cwd is invented for an unavailable workspace");

  // Relative header cwd: never canonicalized into an invented workspace.
  const relFile = await writeSessionFile(projA, "s-rel.jsonl", "id-rel", "relative/path");
  const relCatalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const relRow = relCatalog.rows.find((candidate) => candidate.id === "id-rel");
  assert.ok(relRow);
  assert.deepEqual(admitSavedSession(relCatalog, relRow), { status: "refused", reason: "workspace-unavailable" }, "a relative header cwd is refused, never resolved against an assumed root");

  // Known-owned duplicate guard: caller-supplied data only.
  const liveWorkspace = join(fixture.root, "live-workspace");
  await mkdir(liveWorkspace, { recursive: true });
  const file2 = await writeSessionFile(projA, "s2.jsonl", "id-a2", liveWorkspace);
  const catalog2 = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const row2 = catalog2.rows.find((candidate) => candidate.id === "id-a2");
  assert.ok(row2);
  assert.deepEqual(admitSavedSession(catalog2, row2, { ownedLiveSessions: [{ id: "id-a2" }] }), { status: "refused", reason: "known-owned-duplicate" });
  assert.deepEqual(admitSavedSession(catalog2, row2, { ownedLiveSessions: [{ file: file2 }] }), { status: "refused", reason: "known-owned-duplicate" }, "the canonical file identity matches");
  assert.equal(admitSavedSession(catalog2, row2, { ownedLiveSessions: [{ id: "id-other" }, { file: join(fixture.root, "other.jsonl") }] }).status, "admitted", "unrelated owned entries do not refuse");
});

test("listSavedSessions honors abort: pre-aborted rejects, mid-flight abort settles once, and late completions cannot mint admissions", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);

  // Pre-aborted: rejects immediately.
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll(), signal: preAborted.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  // Mid-flight abort: the query rejects (the injected listAll honors the
  // signal like the real SDK); the late completion is ignored.
  let resolveSlow: () => void = () => {};
  const slow = new Promise<void>((resolvePromise) => { resolveSlow = resolvePromise; });
  const controller = new AbortController();
  const pending = listSavedSessions({
    agentDir: fixture.agentDir,
    signal: controller.signal,
    listAll: makeInjectedListAll({
      behavior: (dir, signal) => {
        if (dir !== projB) return Promise.resolve([{ path: join(projA, "s1.jsonl"), id: "id-a1", cwd: fixture.workspace }]);
        return new Promise<NativeSessionSdkInfoLike[]>((resolveList, rejectList) => {
          const onAbort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            rejectList(error);
          };
          if (signal?.aborted) { onAbort(); return; }
          signal?.addEventListener("abort", onAbort, { once: true });
          slow.then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolveList([{ path: join(projB, "s2.jsonl"), id: "id-b1", cwd: fixture.workspace }]);
          });
        });
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  resolveSlow(); // late completion after the abort: ignored, no crash
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A query that completes AFTER a newer query started is stale on admission.
  let resolveLate: () => void = () => {};
  const late = new Promise<void>((resolvePromise) => { resolveLate = resolvePromise; });
  const slowQuery = listSavedSessions({
    agentDir: fixture.agentDir,
    listAll: makeInjectedListAll({
      behavior: (dir) => (dir === projA ? late.then(() => [{ path: join(projA, "s1.jsonl"), id: "id-a1", cwd: fixture.workspace }]) : Promise.resolve([{ path: join(projB, "s2.jsonl"), id: "id-b1", cwd: fixture.workspace }])),
    }),
  });
  const current = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  resolveLate();
  const lateCatalog = await slowQuery;
  assert.notEqual(lateCatalog.revision, current.revision);
  const lateRow = lateCatalog.rows.find((row) => row.id === "id-a1");
  assert.ok(lateRow);
  assert.deepEqual(admitSavedSession(lateCatalog, lateRow), { status: "refused", reason: "stale-catalog" }, "an old completion cannot mint a current selection");
});

test("listSavedSessions rejects when listings resolve valid rows AFTER abort: no catalog is published", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  // A listing implementation that RESOLVES valid rows after cancellation
  // (instead of rejecting) must not publish a branded catalog.
  const controller = new AbortController();
  const pending = listSavedSessions({
    agentDir: fixture.agentDir,
    signal: controller.signal,
    listAll: makeInjectedListAll({
      behavior: (_dir, signal) => new Promise<NativeSessionSdkInfoLike[]>((resolveList) => {
        const rows = [{ path: join(projA, "s1.jsonl"), id: "id-a1", cwd: fixture.workspace }];
        if (signal?.aborted) { resolveList(rows); return; }
        signal?.addEventListener("abort", () => resolveList(rows), { once: true });
      }),
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError", "a canceled query rejects even when the listing resolves late with valid rows");
});

test("listSavedSessions refuses a project directory with an unsafe .jsonl entry before any SDK call and preserves its bytes", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const goodFile = await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  const outsideTarget = join(fixture.root, "outside-target.jsonl");
  await writeFile(outsideTarget, `${sessionHeaderLine("id-link", fixture.workspace)}\n`, "utf8");
  await symlink(outsideTarget, join(projA, "link.jsonl"));

  const calls: string[] = [];
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll({ calls }) });
  assert.deepEqual(calls, [], "the unsafe project directory is never passed to the SDK");
  assert.deepEqual(catalog.rows, [], "no rows are claimed for a refused project listing");
  assert.equal(catalog.issueCount, 1);
  assert.match(catalog.issues[0].reason, /session entry is a symlink/);
  assert.match(await readFile(goodFile, "utf8"), /id-a1/, "the clean file is preserved untouched");
  assert.match(await readFile(outsideTarget, "utf8"), /id-link/, "the symlink target is preserved untouched");
});

test("listSavedSessions refuses FIFO and special .jsonl entries before any SDK call", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projFifo = join(fixture.sessionsRoot, "proj-fifo");
  const projSpecial = join(fixture.sessionsRoot, "proj-special");
  await Promise.all([mkdir(projFifo, { recursive: true }), mkdir(projSpecial, { recursive: true })]);
  const fifoPath = join(projFifo, "s.jsonl");
  const mkfifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  assert.equal(mkfifo.status, 0, `the synthetic FIFO fixture must be created: ${mkfifo.stderr ?? ""}`);
  await mkdir(join(projSpecial, "s.jsonl"), { recursive: true }); // a directory named .jsonl

  const calls: string[] = [];
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll({ calls }) });
  assert.deepEqual(calls, [], "no project with an unsafe .jsonl entry is passed to the SDK");
  assert.equal(catalog.issueCount, 2);
  for (const issue of catalog.issues) {
    assert.match(issue.reason, /session entry is not a regular file/);
  }
  // The FIFO was never opened (lstat only) and both entries are preserved.
  assert.ok(lstatSync(join(projFifo, "s.jsonl")).isFIFO(), "the FIFO entry is preserved");
  assert.ok(lstatSync(join(projSpecial, "s.jsonl")).isDirectory(), "the special entry is preserved");
});

test("listSavedSessions refuses a project directory swapped for a symlink before the SDK call", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  const moved = join(fixture.root, "moved-proj");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);

  const calls: string[] = [];
  const catalog = await listSavedSessions({
    agentDir: fixture.agentDir,
    listAll: makeInjectedListAll({
      calls,
      behavior: (dir) => {
        // The first directory listed swaps the OTHER one for a symlink before
        // its preflight runs (deterministic single-threaded ordering).
        const other = dir === projA ? projB : projA;
        if (existsSync(other) && !lstatSync(other).isSymbolicLink()) {
          renameSync(other, moved);
          symlinkSync(moved, other);
        }
        return [];
      },
    }),
  });

  assert.equal(calls.length, 1, "only the first directory is listed");
  assert.deepEqual(catalog.rows, []);
  assert.equal(catalog.issueCount, 1);
  const issue = catalog.issues[0];
  assert.ok(issue.projectDir === projA || issue.projectDir === projB, "the swapped directory is the refused one");
  assert.match(issue.reason, /not a real directory/);
  // The swapped tree keeps its exact bytes at the moved location.
  const movedFile = join(moved, calls[0] === projA ? "s2.jsonl" : "s1.jsonl");
  assert.match(await readFile(movedFile, "utf8"), /id-/);
});

test("listSavedSessions refuses a sessions root swapped for a symlink between listings", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);

  // An external tree the swapped root would point at (with a tempting row).
  const external = join(fixture.root, "external");
  await mkdir(join(external, "proj-x"), { recursive: true });
  await writeSessionFile(join(external, "proj-x"), "x.jsonl", "id-x1", fixture.workspace);

  let swapped = false;
  const calls: string[] = [];
  const catalog = await listSavedSessions({
    agentDir: fixture.agentDir,
    listAll: makeInjectedListAll({
      calls,
      behavior: (dir) => {
        if (!swapped) {
          swapped = true;
          // Between the first and second listing: replace the sessions root
          // with a symlink to another tree (deterministic ordering: the swap
          // lands inside the first listAll call, before the second preflight).
          renameSync(fixture.sessionsRoot, join(fixture.root, "sessions-moved"));
          symlinkSync(external, fixture.sessionsRoot);
        }
        return [];
      },
    }),
  });

  assert.equal(calls.length, 1, "only the first directory is listed; the SDK never reads the foreign tree");
  assert.deepEqual(catalog.rows, []);
  const issue = catalog.issues.find((entry) => entry.projectDir === projB);
  assert.ok(issue, `the second project must be refused after the root swap: ${JSON.stringify(catalog.issues)}`);
  assert.match(issue.reason, /sessions root was replaced after discovery/);
});

test("listSavedSessions refuses a project directory replaced with another real directory", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);

  let swapped = false;
  const calls: string[] = [];
  const catalog = await listSavedSessions({
    agentDir: fixture.agentDir,
    listAll: makeInjectedListAll({
      calls,
      behavior: (dir) => {
        if (!swapped) {
          swapped = true;
          // Replace the OTHER project with a different real directory at the
          // same path: the discovery dev/ino identity must detect the swap.
          renameSync(dir === projA ? projB : projA, join(fixture.root, "proj-moved"));
          mkdirSync(dir === projA ? projB : projA);
        }
        return [];
      },
    }),
  });

  assert.equal(calls.length, 1, "only the first directory is listed");
  assert.deepEqual(catalog.rows, []);
  const issue = catalog.issues.find((entry) => entry.projectDir === (calls[0] === projA ? projB : projA));
  assert.ok(issue, `the replaced project must be refused: ${JSON.stringify(catalog.issues)}`);
  assert.match(issue.reason, /project directory was replaced after discovery/);
});

test("listSavedSessions prunes .terraform inside a project directory before any descent", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const terraformModule = join(projA, ".terraform", "module");
  await mkdir(terraformModule, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  const tfFile = await writeSessionFile(terraformModule, "tf.jsonl", "id-tf", fixture.workspace);

  const calls: string[] = [];
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll({ calls }) });
  assert.deepEqual(calls, [projA], "the project directory is listed with its explicit path");
  assert.ok(!calls.some((dir) => dir.includes(".terraform")), ".terraform is never a listing target");
  assert.deepEqual(catalog.rows.map((row) => row.id), ["id-a1"], ".terraform content is never listed");
  assert.equal(catalog.issueCount, 0);
  assert.match(await readFile(tfFile, "utf8"), /id-tf/, ".terraform bytes are untouched");
});

test("listSavedSessions retains at most MAX_CATALOG_ISSUES issues with an exact total for large faults", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const outsideTarget = join(fixture.root, "outside-target.jsonl");
  await writeFile(outsideTarget, `${sessionHeaderLine("id-out", fixture.workspace)}\n`, "utf8");
  const projectDirs: string[] = [];
  for (let i = 0; i < MAX_CATALOG_ISSUES + 5; i += 1) {
    const dir = join(fixture.sessionsRoot, `proj-${String(i).padStart(2, "0")}`);
    await mkdir(dir, { recursive: true });
    await symlink(outsideTarget, join(dir, "s.jsonl"));
    projectDirs.push(dir);
  }

  const calls: string[] = [];
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll({ calls }) });
  assert.deepEqual(calls, [], "no unsafe project directory is ever passed to the SDK");
  assert.equal(catalog.issueCount, MAX_CATALOG_ISSUES + 5, "the total issue count is exact");
  assert.equal(catalog.issues.length, MAX_CATALOG_ISSUES, "retained issues are bounded at creation");
  for (const issue of catalog.issues) {
    assert.equal(issue.reason, "session entry is a symlink");
    assert.ok(projectDirs.includes(issue.projectDir), "retained issues name real project directories");
  }
  assert.ok(Object.isFrozen(catalog.issues) && Object.isFrozen(catalog.issues[0]), "retained issues are frozen");
});

test("listSavedSessions and admitSavedSession are strictly read-only on user storage", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  const projB = join(fixture.sessionsRoot, "proj-b");
  await Promise.all([mkdir(projA, { recursive: true }), mkdir(projB, { recursive: true })]);
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace, { name: "kept name" });
  await writeSessionFile(projB, "s2.jsonl", "id-b1", fixture.workspace);
  const before = await snapshotSessionsTree(fixture.sessionsRoot);

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const result = admitSavedSession(catalog, catalog.rows[0]);
  assert.equal(result.status, "admitted");
  const after = await snapshotSessionsTree(fixture.sessionsRoot);
  assert.deepEqual(after, before, "listing and admission never write, rename, or create user storage files");
});

test("readSavedSessionHeader is bounded to the first line and never reads the transcript", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const headerLine = sessionHeaderLine("id-bounded", fixture.workspace);
  const transcript = "transcript-secret".repeat(Math.ceil((MAX_SESSION_HEADER_BYTES * 2) / "transcript-secret".length));
  const file = join(projA, "s1.jsonl");
  await writeFile(file, `${headerLine}\n${JSON.stringify({ type: "message", text: transcript })}\n`, "utf8");

  // The public header reader is exercised through admission: it must verify
  // id/cwd from the first line only.
  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  const result = admitSavedSession(catalog, catalog.rows[0]);
  assert.equal(result.status, "admitted");
  if (result.status === "admitted") {
    assert.equal(result.admission.sessionId, "id-bounded");
    assert.equal(result.admission.cwd, fixture.workspace);
  }
  // The transcript bytes are preserved (never copied or rewritten).
  assert.match(await readFile(file, "utf8"), /transcript-secret/);
});

test("readSavedSessionHeader validates the bounded public SessionHeader and fails closed", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });

  // A correct public header: type "session" with bounded control-free id/cwd.
  const good = join(projA, "good.jsonl");
  await writeFile(good, `${sessionHeaderLine("id-good", fixture.workspace)}\n`, "utf8");
  assert.deepEqual(readSavedSessionHeader(good), { id: "id-good", cwd: fixture.workspace });

  // A different entry kind is never a session header.
  const wrongType = join(projA, "wrong-type.jsonl");
  await writeFile(wrongType, `${JSON.stringify({ type: "message", id: "id-x", cwd: fixture.workspace })}\n`, "utf8");
  assert.equal(readSavedSessionHeader(wrongType), undefined);

  // Control characters in id or cwd refuse.
  const controlId = join(projA, "control-id.jsonl");
  await writeFile(controlId, `${JSON.stringify({ type: "session", id: "bad\u0001id", cwd: fixture.workspace })}\n`, "utf8");
  assert.equal(readSavedSessionHeader(controlId), undefined);
  const controlCwd = join(projA, "control-cwd.jsonl");
  await writeFile(controlCwd, `${JSON.stringify({ type: "session", id: "id-x", cwd: `${fixture.workspace}\u007f` })}\n`, "utf8");
  assert.equal(readSavedSessionHeader(controlCwd), undefined);

  // Oversized fields refuse.
  const longId = join(projA, "long-id.jsonl");
  await writeFile(longId, `${JSON.stringify({ type: "session", id: "x".repeat(MAX_SESSION_HEADER_FIELD_LENGTH + 1), cwd: fixture.workspace })}\n`, "utf8");
  assert.equal(readSavedSessionHeader(longId), undefined);

  // First-line overflow: a valid JSON prefix followed by unread garbage on the
  // same unterminated line is never accepted.
  const overflow = join(projA, "overflow.jsonl");
  await writeFile(overflow, `${sessionHeaderLine("id-ovf", fixture.workspace)}${" ".repeat(MAX_SESSION_HEADER_BYTES)}`, "utf8");
  assert.equal(readSavedSessionHeader(overflow), undefined);

  // A complete short header without a trailing newline (EOF before the bound)
  // is still a bounded, fully-read line.
  const noNewline = join(projA, "no-newline.jsonl");
  await writeFile(noNewline, sessionHeaderLine("id-eof", fixture.workspace), "utf8");
  assert.deepEqual(readSavedSessionHeader(noNewline), { id: "id-eof", cwd: fixture.workspace });

  // Symlinked files are never probed.
  const target = join(fixture.root, "header-target.jsonl");
  await writeFile(target, `${sessionHeaderLine("id-t", fixture.workspace)}\n`, "utf8");
  const link = join(projA, "link.jsonl");
  await symlink(target, link);
  assert.equal(readSavedSessionHeader(link), undefined);
});

test("readSavedSessionHeader refuses a file replaced between lstat and open", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => removeFixtureTree(fixture.root));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const file = join(projA, "swapped.jsonl");
  await writeFile(file, `${sessionHeaderLine("id-swap", fixture.workspace)}\n`, "utf8");
  // A decoy with a DIFFERENT dev/ino identity but a valid-looking header.
  const decoy = join(fixture.root, "decoy.jsonl");
  await writeFile(decoy, `${sessionHeaderLine("id-decoy", fixture.workspace)}\n`, "utf8");

  // Simulate the lstat->open race deterministically: the inspection sees the
  // decoy's identity while open reads the real file. The descriptor identity
  // check must refuse instead of trusting the mismatched header.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsModule = require("node:fs") as {
    lstatSync: (path: string, options?: { bigint?: boolean }) => import("node:fs").Stats | import("node:fs").BigIntStats;
  };
  const originalLstat = fsModule.lstatSync;
  try {
    fsModule.lstatSync = (path: string, options?: { bigint?: boolean }) =>
      path === file ? originalLstat(decoy, options) : originalLstat(path, options);
    assert.equal(readSavedSessionHeader(file), undefined, "a replaced descriptor is never trusted");
  } finally {
    fsModule.lstatSync = originalLstat;
  }
  // Sanity: without the race the same file reads fine.
  assert.deepEqual(readSavedSessionHeader(file), { id: "id-swap", cwd: fixture.workspace });
});

// ---------------------------------------------------------------------------
// Public SDK loader (native-session-sdk.ts)
// ---------------------------------------------------------------------------

interface SdkFixture {
  root: string;
  packageDir: string;
  piFile: string;
}

/** Deep SDK fixture: the CLI sits `depth` empty directories below the package root. */
async function makeDeepSdkFixture(
  prefix: string,
  depth: number,
  manifest: Record<string, unknown>,
): Promise<SdkFixture> {
  const root = await makePrivateRoot(prefix);
  const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  let dir = packageDir;
  for (let i = 0; i < depth; i += 1) dir = join(dir, `d${i}`);
  await mkdir(join(dir, "bin"), { recursive: true });
  // The declared official CLI bin points at the actual (nested) CLI location.
  const binRel = `./${Array.from({ length: depth }, (_, i) => `d${i}`).join("/")}/bin/pi.js`;
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ ...manifest, bin: { pi: binRel } }), "utf8");
  const piFile = join(dir, "bin", "pi.js");
  await writeFile(piFile, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  return { root, packageDir, piFile };
}

async function makeSdkFixture(
  prefix: string,
  manifest: Record<string, unknown>,
  entryFiles: Record<string, string>,
): Promise<SdkFixture> {
  const root = await makePrivateRoot(prefix);
  const packageDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [relativePath, source] of Object.entries(entryFiles)) {
    const file = join(packageDir, relativePath);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, source, "utf8");
  }
  const piFile = join(packageDir, "bin", "pi.js");
  await writeFile(piFile, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  return { root, packageDir, piFile };
}

/**
 * Probe the compiled SDK loader in a CHILD process with a fully controlled
 * environment. The test process may itself carry executor role or settlement
 * markers (a delegated worker context), which the loader must refuse — so
 * every case runs in an explicitly built child env, never by stripping the
 * test process's own environment.
 */
interface SdkProbeResult {
  ok: boolean;
  entry?: string;
  packageDir?: string;
  version?: string;
  error?: string;
  secondError?: string;
  rewriteError?: string;
}

function probeSdkLoader(
  fixture: SdkFixture,
  extraEnv: NodeJS.ProcessEnv = {},
  expectedPiVersion?: string,
  cacheMismatchExpected?: string,
  rewriteVersion?: string,
  inject?: string,
): SdkProbeResult {
  const compiledSdk = join(process.cwd(), "dist-test", "src", "session-host", "native-session-sdk.js");
  assert.ok(existsSync(compiledSdk), "the compiled SDK loader module must exist");
  const script = [
    "const loader = require(process.argv[1]);",
    // Deterministic error injection for bounded-failure coverage: the loader
    // calls fs through the shared module object, so patching it here affects
    // exactly the compiled loader under test.
    "if (process.argv[6]) {",
    "  const fs = require(\"fs\");",
    "  const sepIdx = process.argv[6].indexOf(\"|\");",
    "  const kind = process.argv[6].slice(0, sepIdx);",
    "  const target = process.argv[6].slice(sepIdx + 1);",
    "  if (kind === \"lstat-eacces\") {",
    "    const origLstat = fs.lstatSync;",
    "    fs.lstatSync = (p, ...rest) => {",
    "      if (p === target) { const e = new Error(\"EACCES: permission denied, lstat '\" + p + \"'\"); e.code = \"EACCES\"; throw e; }",
    "      return origLstat(p, ...rest);",
    "    };",
    "  } else if (kind === \"read-eio\") {",
    "    const origOpen = fs.openSync;",
    "    const origRead = fs.readSync;",
    "    let targetFd = -1;",
    "    fs.openSync = (p, ...rest) => { const fd = origOpen(p, ...rest); if (p === target) targetFd = fd; return fd; };",
    "    fs.readSync = (fd, ...rest) => { if (fd === targetFd) { const e = new Error(\"EIO: i/o error\"); e.code = \"EIO\"; throw e; } return origRead(fd, ...rest); };",
    "  } else { throw new Error(\"unknown injection kind: \" + kind); }",
    "}",
    "try {",
    "  const view = loader.resolveNativeSessionSdk(process.argv[2], process.argv[3] ? { expectedPiVersion: process.argv[3] } : {});",
    "  let secondError;",
    "  if (process.argv[4]) {",
    "    try { loader.resolveNativeSessionSdk(process.argv[2], { expectedPiVersion: process.argv[4] }); } catch (error) { secondError = error instanceof Error ? error.message : String(error); }",
    "  }",
    "  let rewriteError;",
    "  if (process.argv[5]) {",
    "    const fs = require(\"fs\");",
    "    const path = require(\"path\");",
    "    const manifestPath = path.join(view.packageDir, \"package.json\");",
    "    const manifest = JSON.parse(fs.readFileSync(manifestPath, \"utf8\"));",
    "    manifest.version = process.argv[5];",
    "    fs.writeFileSync(manifestPath, JSON.stringify(manifest));",
    "    try { loader.resolveNativeSessionSdk(process.argv[2], { expectedPiVersion: process.argv[5] }); } catch (error) { rewriteError = error instanceof Error ? error.message : String(error); }",
    "  }",
    "  process.stdout.write(JSON.stringify({ ok: true, entry: view.entry, packageDir: view.packageDir, version: view.version, secondError, rewriteError }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));",
    "}",
  ].join("\n");
  // Strictly positional: empty strings are the "absent" sentinel so the
  // child script's argv indexes never shift.
  const args = [
    "-e", script, compiledSdk, fixture.piFile,
    expectedPiVersion ?? "",
    cacheMismatchExpected ?? "",
    rewriteVersion ?? "",
    inject ?? "",
  ];
  const result = spawnSync(process.execPath, args, {
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) throw new Error(`the sdk loader probe did not run: ${result.stderr ?? ""}`);
  return JSON.parse(result.stdout) as SdkProbeResult;
}

test("resolveNativeSessionSdk resolves the public SDK entry of the own official package by bounded ancestor metadata", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-main", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, {
    "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n",
  });
  t.after(() => removeFixtureTree(fixture.root));
  const probe = probeSdkLoader(fixture);
  assert.equal(probe.ok, true, `the loader must resolve in a clean context: ${probe.error ?? ""}`);
  assert.equal(probe.entry, join(fixture.packageDir, "dist", "sdk.js"));
  assert.equal(probe.packageDir, fixture.packageDir);
  assert.equal(probe.version, "1.0.4");
});

test("resolveNativeSessionSdk accepts a class-based SessionManager with a static listAll", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-class", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, {
    // A class is a function at runtime; the production SDK shape must load.
    "dist/sdk.js": "class SessionManager { static async listAll() { return []; } }\nmodule.exports = { SessionManager };\n",
  });
  t.after(() => removeFixtureTree(fixture.root));
  const probe = probeSdkLoader(fixture);
  assert.equal(probe.ok, true, `a class-based SessionManager must load: ${probe.error ?? ""}`);
  assert.equal(probe.entry, join(fixture.packageDir, "dist", "sdk.js"));
});

test("resolveNativeSessionSdk refuses a public entry that escapes through an intermediate directory symlink", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-dirlink", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, {});
  t.after(() => removeFixtureTree(fixture.root));

  // dist/ is a symlink to an external directory whose module writes a marker
  // on load: the loader must refuse BEFORE evaluating anything external.
  const external = join(fixture.root, "external");
  await mkdir(external, { recursive: true });
  const marker = join(fixture.root, "external-module-loaded");
  await writeFile(
    join(external, "sdk.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\nmodule.exports = { SessionManager: { listAll: async () => [] } };\n`,
    "utf8",
  );
  await rm(join(fixture.packageDir, "dist"), { recursive: true });
  await symlink(external, join(fixture.packageDir, "dist"));

  const probe = probeSdkLoader(fixture);
  assert.equal(probe.ok, false, `an entry escaping through a directory symlink must be refused: ${probe.error ?? ""}`);
  assert.match(probe.error ?? "", /escapes the package directory/);
  assert.equal(existsSync(marker), false, "the external module is never evaluated");
});

test("resolveNativeSessionSdk prefers the exports[\".\"] require condition", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-exports", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    exports: { ".": { require: "./dist/cjs.js", import: "./dist/mjs.js" } },
  }, {
    "dist/cjs.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n",
    "dist/mjs.js": "export {};\n",
  });
  t.after(() => removeFixtureTree(fixture.root));
  const probe = probeSdkLoader(fixture);
  assert.equal(probe.ok, true, `the loader must resolve in a clean context: ${probe.error ?? ""}`);
  assert.equal(probe.entry, join(fixture.packageDir, "dist", "cjs.js"));
});

test("resolveNativeSessionSdk fails closed on unrelated packages, escaping entries, and missing runtimes", async (t) => {
  const unrelated = await makeSdkFixture("pi-saved-sdk-unrelated", {
    name: "@other/pi-coding-agent",
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n" });
  t.after(() => removeFixtureTree(unrelated.root));
  const unrelatedProbe = probeSdkLoader(unrelated);
  assert.equal(unrelatedProbe.ok, false);
  assert.ok(unrelatedProbe.error?.includes(PI_PACKAGE_NAME) && /unavailable/.test(unrelatedProbe.error ?? ""), `unexpected diagnostic: ${unrelatedProbe.error}`);

  const escaping = await makeSdkFixture("pi-saved-sdk-escape", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "../outside-sdk.js",
  }, { "dist/sdk.js": "module.exports = {};\n" });
  t.after(() => removeFixtureTree(escaping.root));
  const escapingProbe = probeSdkLoader(escaping);
  assert.equal(escapingProbe.ok, false);
  assert.match(escapingProbe.error ?? "", /no usable public SDK entry|escapes the package directory/);

  const noRuntime = await makeSdkFixture("pi-saved-sdk-noruntime", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { notTheManager: {} };\n" });
  t.after(() => removeFixtureTree(noRuntime.root));
  const noRuntimeProbe = probeSdkLoader(noRuntime);
  assert.equal(noRuntimeProbe.ok, false);
  assert.match(noRuntimeProbe.error ?? "", /does not export a SessionManager runtime/);

  const missingEntry = await makeSdkFixture("pi-saved-sdk-missing", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/absent.js",
  }, {});
  t.after(() => removeFixtureTree(missingEntry.root));
  const missingProbe = probeSdkLoader(missingEntry);
  assert.equal(missingProbe.ok, false);
  assert.match(missingProbe.error ?? "", /public SDK entry is missing/);
});

test("resolveNativeSessionSdk refuses runtime-role and settlement contexts without stripping env", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-guard", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n" });
  t.after(() => removeFixtureTree(fixture.root));

  const roleProbe = probeSdkLoader(fixture, { PI_REVIEW_GATE_RUNTIME_ROLE: "executor" });
  assert.equal(roleProbe.ok, false);
  assert.ok(roleProbe.error?.includes("PI_REVIEW_GATE_RUNTIME_ROLE"), `the executor role context refuses SDK loading: ${roleProbe.error}`);

  const settlementProbe = probeSdkLoader(fixture, { PI_REVIEW_GATE_SETTLEMENT_SECRET: "synthetic" });
  assert.equal(settlementProbe.ok, false);
  assert.match(settlementProbe.error ?? "", /settlement context/);

  // The env is never stripped to prove the SDK loads: a clean child context resolves.
  const cleanProbe = probeSdkLoader(fixture);
  assert.equal(cleanProbe.ok, true, `the loader must resolve in a clean context: ${cleanProbe.error ?? ""}`);
  assert.equal(cleanProbe.entry, join(fixture.packageDir, "dist", "sdk.js"));
});

test("resolveNativeSessionSdk fails closed on malformed or unsupported exports metadata", async (t) => {
  const nullExports = await makeSdkFixture("pi-saved-sdk-exports-null", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    exports: null,
  }, {});
  t.after(() => removeFixtureTree(nullExports.root));
  const nullProbe = probeSdkLoader(nullExports);
  assert.equal(nullProbe.ok, false, `null exports must be an honest unavailability, not a crash: ${nullProbe.error ?? ""}`);
  assert.match(nullProbe.error ?? "", /no usable public SDK entry/);

  const noRootExport = await makeSdkFixture("pi-saved-sdk-exports-noroot", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    exports: { "./sub": "./dist/sub.js" },
  }, {});
  t.after(() => removeFixtureTree(noRootExport.root));
  const noRootProbe = probeSdkLoader(noRootExport);
  assert.equal(noRootProbe.ok, false);
  assert.match(noRootProbe.error ?? "", /no usable public SDK entry/);

  const typesOnly = await makeSdkFixture("pi-saved-sdk-exports-types", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    exports: { ".": { types: "./dist/index.d.ts" } },
  }, {});
  t.after(() => removeFixtureTree(typesOnly.root));
  const typesProbe = probeSdkLoader(typesOnly);
  assert.equal(typesProbe.ok, false);
  assert.match(typesProbe.error ?? "", /no usable public SDK entry/);
});

test("resolveNativeSessionSdk bounds the ancestor walk and stops at package boundaries", async (t) => {
  // A CLI deeper than MAX_SDK_ANCESTOR_STEPS below any package boundary is an
  // honest unavailability (the walk never guesses beyond the bound).
  const deep = await makeDeepSdkFixture("pi-saved-sdk-deep", MAX_SDK_ANCESTOR_STEPS + 8, {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  });
  t.after(() => removeFixtureTree(deep.root));
  const deepProbe = probeSdkLoader(deep);
  assert.equal(deepProbe.ok, false);
  assert.match(deepProbe.error ?? "", /no package boundary was found within \d+ ancestors/);

  // A CLI within the bound resolves through its own official boundary.
  const shallow = await makeDeepSdkFixture("pi-saved-sdk-shallow", 10, {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  });
  t.after(() => removeFixtureTree(shallow.root));
  await mkdir(join(shallow.packageDir, "dist"), { recursive: true });
  await writeFile(join(shallow.packageDir, "dist", "sdk.js"), "module.exports = { SessionManager: { listAll: async () => [] } };\n", "utf8");
  const shallowProbe = probeSdkLoader(shallow);
  assert.equal(shallowProbe.ok, true, `a within-bound official package must resolve: ${shallowProbe.error ?? ""}`);
  assert.equal(shallowProbe.version, "1.0.4");
});

test("resolveNativeSessionSdk validates a supported stable Pi version and caller-admitted agreement", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  const below = await makeSdkFixture("pi-saved-sdk-ver-below", {
    name: PI_PACKAGE_NAME,
    version: "1.0.3",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(below.root));
  const belowProbe = probeSdkLoader(below);
  assert.equal(belowProbe.ok, false);
  assert.match(belowProbe.error ?? "", /supported stable version/);

  const prerelease = await makeSdkFixture("pi-saved-sdk-ver-pre", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4-beta.1",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(prerelease.root));
  const preProbe = probeSdkLoader(prerelease);
  assert.equal(preProbe.ok, false, "a prerelease version is not a supported stable version");
  assert.match(preProbe.error ?? "", /supported stable version/);

  const missingVersion = await makeSdkFixture("pi-saved-sdk-ver-missing", {
    name: PI_PACKAGE_NAME,
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(missingVersion.root));
  const missingProbe = probeSdkLoader(missingVersion);
  assert.equal(missingProbe.ok, false, "a missing version is never accepted as supported");
  assert.match(missingProbe.error ?? "", /supported stable version/);

  const newer = await makeSdkFixture("pi-saved-sdk-ver-newer", {
    name: PI_PACKAGE_NAME,
    version: "1.1.0",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(newer.root));
  const newerProbe = probeSdkLoader(newer);
  assert.equal(newerProbe.ok, true, `a newer stable version must resolve: ${newerProbe.error ?? ""}`);
  assert.equal(newerProbe.version, "1.1.0");

  // Caller-admitted version agreement (exact), including the cache path: a
  // cached entry is only returned when the gating still agrees.
  const mismatch = await makeSdkFixture("pi-saved-sdk-ver-mismatch", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(mismatch.root));
  const mismatchProbe = probeSdkLoader(mismatch, {}, "1.0.5");
  assert.equal(mismatchProbe.ok, false);
  assert.match(mismatchProbe.error ?? "", /does not agree with the caller-admitted Pi version/);

  const cacheProbe = probeSdkLoader(mismatch, {}, "1.0.4", "9.9.9");
  assert.equal(cacheProbe.ok, true, `the matching admission must resolve: ${cacheProbe.error ?? ""}`);
  assert.match(
    cacheProbe.secondError ?? "",
    /does not agree with the caller-admitted Pi version/,
    "a cached entry is gated by version agreement before return",
  );
});

test("resolveNativeSessionSdk requires the official CLI bin metadata and a Node script CLI", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  const noBin = await makeSdkFixture("pi-saved-sdk-nobin", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(noBin.root));
  const noBinProbe = probeSdkLoader(noBin);
  assert.equal(noBinProbe.ok, false);
  assert.match(noBinProbe.error ?? "", /declares no official pi CLI bin/);

  // A non-Node wrapper at the CLI path is never an accepted SDK provider.
  const wrapper = await makeSdkFixture("pi-saved-sdk-wrapper", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(wrapper.root));
  const wrapperFile = join(wrapper.packageDir, "bin", "wrapper.sh");
  await writeFile(wrapperFile, "#!/bin/sh\nexec pi \"$@\"\n", "utf8");
  const wrapperProbe = probeSdkLoader({ ...wrapper, piFile: wrapperFile });
  assert.equal(wrapperProbe.ok, false);
  assert.match(wrapperProbe.error ?? "", /not the official CLI/);
});

test("resolveNativeSessionSdk binds the CLI to the declared bin or the official unbundled entry", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  // An additional contained JavaScript wrapper is never an accepted provider,
  // even though it sits inside the official package.
  const wrapperJs = await makeSdkFixture("pi-saved-sdk-wrapper-js", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(wrapperJs.root));
  const wrapperFile = join(wrapperJs.packageDir, "wrapper.js");
  await writeFile(wrapperFile, "#!/usr/bin/env node\nrequire('./bin/pi.js');\n", "utf8");
  const wrapperProbe = probeSdkLoader({ ...wrapperJs, piFile: wrapperFile });
  assert.equal(wrapperProbe.ok, false);
  assert.match(wrapperProbe.error ?? "", /not the official CLI/);

  // The specific official unbundled entry (dist/cli.js) is accepted.
  const unbundled = await makeSdkFixture("pi-saved-sdk-unbundled", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource, "dist/cli.js": "#!/usr/bin/env node\n" });
  t.after(() => removeFixtureTree(unbundled.root));
  const unbundledProbe = probeSdkLoader({ ...unbundled, piFile: join(unbundled.packageDir, "dist", "cli.js") });
  assert.equal(unbundledProbe.ok, true, `the official unbundled entry must resolve: ${unbundledProbe.error ?? ""}`);
});

test("resolveNativeSessionSdk stops at an invalid package boundary instead of crossing it", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  // A malformed nested manifest beneath an otherwise valid official package:
  // the walk must stop at the invalid boundary, never attribute the CLI to
  // the outer official package.
  const malformed = await makeSdkFixture("pi-saved-sdk-invalid-boundary", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./inner/bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(malformed.root));
  await mkdir(join(malformed.packageDir, "inner", "bin"), { recursive: true });
  await writeFile(join(malformed.packageDir, "inner", "package.json"), "{ not valid json", "utf8");
  const innerCli = join(malformed.packageDir, "inner", "bin", "pi.js");
  await writeFile(innerCli, `#!${process.execPath}\n`, "utf8");
  const malformedProbe = probeSdkLoader({ ...malformed, piFile: innerCli });
  assert.equal(malformedProbe.ok, false);
  assert.match(malformedProbe.error ?? "", /invalid package boundary/);

  // A symlinked nested manifest is an existing invalid boundary as well.
  const linked = await makeSdkFixture("pi-saved-sdk-link-boundary", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./inner/bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(linked.root));
  const foreignManifest = join(linked.root, "foreign-package.json");
  await writeFile(foreignManifest, JSON.stringify({ name: "other", version: "1.0.4" }), "utf8");
  await mkdir(join(linked.packageDir, "inner", "bin"), { recursive: true });
  await symlink(foreignManifest, join(linked.packageDir, "inner", "package.json"));
  const linkedCli = join(linked.packageDir, "inner", "bin", "pi.js");
  await writeFile(linkedCli, `#!${process.execPath}\n`, "utf8");
  const linkedProbe = probeSdkLoader({ ...linked, piFile: linkedCli });
  assert.equal(linkedProbe.ok, false);
  assert.match(linkedProbe.error ?? "", /invalid package boundary/);
});

test("resolveNativeSessionSdk treats manifest inspection and read failures as invalid boundaries", async (t) => {
  // An entry that writes a marker on load: refusal must happen BEFORE any
  // SDK module evaluation.
  const makeCase = async (prefix: string): Promise<{ fixture: SdkFixture; innerManifest: string; innerCli: string; marker: string }> => {
    const fixture = await makeSdkFixture(prefix, {
      name: PI_PACKAGE_NAME,
      version: "1.0.4",
      bin: { pi: "./inner/bin/pi.js" },
      main: "./dist/sdk.js",
    }, {});
    t.after(() => removeFixtureTree(fixture.root));
    const marker = join(fixture.root, "sdk-module-loaded");
    await writeFile(
      join(fixture.packageDir, "dist", "sdk.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\nmodule.exports = { SessionManager: { listAll: async () => [] } };\n`,
      "utf8",
    );
    await mkdir(join(fixture.packageDir, "inner", "bin"), { recursive: true });
    const innerCli = join(fixture.packageDir, "inner", "bin", "pi.js");
    await writeFile(innerCli, `#!${process.execPath}\n`, "utf8");
    return { fixture, innerManifest: join(fixture.packageDir, "inner", "package.json"), innerCli, marker };
  };

  // EACCES while inspecting an EXISTING nested manifest: the walk stops at
  // the uninspectable boundary instead of crossing to the outer package.
  const eacces = await makeCase("pi-saved-sdk-eacces");
  await writeFile(eacces.innerManifest, JSON.stringify({ name: "other", version: "1.0.4" }), "utf8");
  const eaccesProbe = probeSdkLoader({ ...eacces.fixture, piFile: eacces.innerCli }, {}, undefined, undefined, undefined, `lstat-eacces|${eacces.innerManifest}`);
  assert.equal(eaccesProbe.ok, false);
  assert.match(eaccesProbe.error ?? "", /invalid package boundary/);
  assert.equal(existsSync(eacces.marker), false, "no SDK module is evaluated across an uninspectable boundary");

  // EIO while reading the descriptor of an existing nested manifest: bounded
  // invalid-boundary result, no unbounded escape.
  const eio = await makeCase("pi-saved-sdk-eio");
  await writeFile(eio.innerManifest, JSON.stringify({ name: "other", version: "1.0.4" }), "utf8");
  const eioProbe = probeSdkLoader({ ...eio.fixture, piFile: eio.innerCli }, {}, undefined, undefined, undefined, `read-eio|${eio.innerManifest}`);
  assert.equal(eioProbe.ok, false);
  assert.match(eioProbe.error ?? "", /invalid package boundary/);
  assert.equal(existsSync(eio.marker), false, "no SDK module is evaluated across an unreadable boundary");

  // ENOENT still establishes an ABSENT manifest: the walk continues to the
  // outer official package and resolves.
  const enoent = await makeCase("pi-saved-sdk-enoent");
  await writeFile(join(enoent.fixture.packageDir, "dist", "sdk.js"), "module.exports = { SessionManager: { listAll: async () => [] } };\n", "utf8");
  const enoentProbe = probeSdkLoader({ ...enoent.fixture, piFile: enoent.innerCli });
  assert.equal(enoentProbe.ok, true, `an absent nested manifest must not stop the walk: ${enoentProbe.error ?? ""}`);
  assert.equal(enoentProbe.packageDir, enoent.fixture.packageDir);
});

test("resolveNativeSessionSdk fails closed when the package version changes after the first load", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-cache-version", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n" });
  t.after(() => removeFixtureTree(fixture.root));
  const probe = probeSdkLoader(fixture, {}, "1.0.4", undefined, "1.0.5");
  assert.equal(probe.ok, true, `the first load must resolve: ${probe.error ?? ""}`);
  assert.equal(probe.version, "1.0.4");
  assert.match(
    probe.rewriteError ?? "",
    /no longer matches the current/,
    "a version change after the first load must not return the cached SDK view",
  );
});

test("resolveNativeSessionSdk rejects malformed numeric version components", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  const leadingZero = await makeSdkFixture("pi-saved-sdk-ver-leadzero", {
    name: PI_PACKAGE_NAME,
    version: "01.0.4",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(leadingZero.root));
  const leadProbe = probeSdkLoader(leadingZero);
  assert.equal(leadProbe.ok, false, "a leading-zero component is malformed semver");
  assert.match(leadProbe.error ?? "", /supported stable version/);

  const huge = await makeSdkFixture("pi-saved-sdk-ver-huge", {
    name: PI_PACKAGE_NAME,
    version: "1.0.99999999999999999999",
    bin: { pi: "./bin/pi.js" },
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": sdkSource });
  t.after(() => removeFixtureTree(huge.root));
  const hugeProbe = probeSdkLoader(huge);
  assert.equal(hugeProbe.ok, false, "an oversized numeric component is not a safe integer");
  assert.match(hugeProbe.error ?? "", /supported stable version/);
});

test("resolveNativeSessionSdk rejects versions with trailing line terminators", async (t) => {
  const sdkSource = "module.exports = { SessionManager: { listAll: async () => [] } };\n";

  for (const [suffix, label] of [["\n", "LF"], ["\r", "CR"], ["\u2028", "Unicode line separator"]] as const) {
    const fixture = await makeSdkFixture(`pi-saved-sdk-ver-term-${label.toLowerCase().replace(/ /g, "-")}`, {
      name: PI_PACKAGE_NAME,
      version: `1.0.4${suffix}`,
      bin: { pi: "./bin/pi.js" },
      main: "./dist/sdk.js",
    }, { "dist/sdk.js": sdkSource });
    t.after(() => removeFixtureTree(fixture.root));
    const probe = probeSdkLoader(fixture);
    assert.equal(probe.ok, false, `a trailing ${label} must not pass the stable-version gate`);
    assert.match(probe.error ?? "", /supported stable version/);
  }
});

test("fixture cleanup preserves failed-run witnesses and cleans successful ones", async () => {
  // Failed run: fixture bytes and 0700 permissions are preserved.
  const failedRun: FixtureRun = { succeeded: false };
  let failedRoot = "";
  await fixtureRunStorage.run(failedRun, async () => {
    failedRoot = await makePrivateRoot("pi-saved-fixture-failed");
    await mkdir(join(failedRoot, "agent", "sessions", "proj"), { recursive: true });
    await writeFile(join(failedRoot, "agent", "sessions", "proj", "s.jsonl"), "witness-bytes\n", "utf8");
  });
  await removeFixtureTree(failedRoot);
  const failedStats = lstatSync(failedRoot);
  assert.equal(failedStats.isDirectory(), true, "the failed witness is preserved");
  assert.equal(failedStats.mode & 0o777, 0o700, "the failed witness is retained at 0700");
  assert.match(
    await readFile(join(failedRoot, "agent", "sessions", "proj", "s.jsonl"), "utf8"),
    /witness-bytes/,
    "the failed witness keeps its exact bytes",
  );

  // Successful run: the fixture is removed.
  const okRun: FixtureRun = { succeeded: true };
  let okRoot = "";
  await fixtureRunStorage.run(okRun, async () => {
    okRoot = await makePrivateRoot("pi-saved-fixture-ok");
    await mkdir(join(okRoot, "data"), { recursive: true });
    await writeFile(join(okRoot, "data", "f.txt"), "x\n", "utf8");
  });
  await removeFixtureTree(okRoot);
  assert.equal(existsSync(okRoot), false, "a successful fixture is removed");

  // Replaced root: cleanup refuses to touch a different directory at the path.
  const replacedRun: FixtureRun = { succeeded: true };
  let replacedRoot = "";
  await fixtureRunStorage.run(replacedRun, async () => {
    replacedRoot = await makePrivateRoot("pi-saved-fixture-replaced");
    await writeFile(join(replacedRoot, "f.txt"), "original\n", "utf8");
  });
  const moved = join(PRIVATE_FIXTURE_ROOT, ".pi-saved-fixture-moved");
  renameSync(replacedRoot, moved);
  mkdirSync(replacedRoot);
  await writeFile(join(replacedRoot, "f.txt"), "impostor\n", "utf8");
  await removeFixtureTree(replacedRoot);
  assert.match(
    await readFile(join(replacedRoot, "f.txt"), "utf8"),
    /impostor/,
    "a replaced root is left untouched",
  );

  // This test succeeded: clean up its own helper trees directly (the failed
  // witness and the moved original are positively identified by this test).
  await pruneAndRemove(failedRoot);
  await pruneAndRemove(replacedRoot);
  await pruneAndRemove(moved);
});
