import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_SESSION_HEADER_BYTES,
  MAX_SAVED_SESSION_CAPTION_CODEPOINTS,
  NO_MESSAGES_CAPTION,
  admitSavedSession,
  canonicalSavedSessionCaption,
  isSavedSessionAdmission,
  isSavedSessionCatalog,
  listSavedSessions,
  SavedSessionCatalog,
  SavedSessionRow,
} from "../src/session-host/saved-sessions";
import { PI_PACKAGE_NAME } from "../src/session-host/native-session-sdk";

interface CatalogFixture {
  /** Real (symlink-resolved) root of the synthetic fixture tree. */
  root: string;
  agentDir: string;
  sessionsRoot: string;
  workspace: string;
}

async function makeCatalogFixture(prefix = "pi-saved-sessions"): Promise<CatalogFixture> {
  const root = await realpath(await mkdtemp(join(process.cwd(), `.${prefix}-`)));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { root, agentDir, sessionsRoot: join(agentDir, "sessions"), workspace };
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
  const lines = [JSON.stringify({ type: "session", id, cwd })];
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const file = await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);

  // Replaced first line (different id): refused as replaced.
  let catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  let row = catalog.rows[0];
  await writeFile(file, `${JSON.stringify({ type: "session", id: "id-other", cwd: fixture.workspace })}\n`, "utf8");
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "replaced-file" });

  // Unparseable header: refused as malformed.
  await writeFile(file, "not json at all\n", "utf8");
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "malformed-header" });

  // Missing file: refused honestly.
  await rm(file);
  assert.deepEqual(admitSavedSession(catalog, row), { status: "refused", reason: "missing-file" });

  // Symlinked file: refused; the target is never touched.
  const outsideTarget = join(fixture.root, "outside-target.jsonl");
  await writeFile(outsideTarget, `${JSON.stringify({ type: "session", id: "id-a1", cwd: fixture.workspace })}\n`, "utf8");
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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

test("listSavedSessions skips symlinked session files and preserves their targets", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  await writeSessionFile(projA, "s1.jsonl", "id-a1", fixture.workspace);
  const outsideTarget = join(fixture.root, "outside-target.jsonl");
  await writeFile(outsideTarget, `${JSON.stringify({ type: "session", id: "id-link", cwd: fixture.workspace })}\n`, "utf8");
  await symlink(outsideTarget, join(projA, "link.jsonl"));

  const catalog = await listSavedSessions({ agentDir: fixture.agentDir, listAll: makeInjectedListAll() });
  assert.deepEqual(catalog.rows.map((row) => row.id), ["id-a1"], "the symlinked file is not a row");
  assert.equal(catalog.issueCount, 1);
  assert.match(catalog.issues[0].reason, /not a regular file/);
  assert.match(await readFile(outsideTarget, "utf8"), /id-link/, "the symlink target is preserved untouched");
});

test("listSavedSessions and admitSavedSession are strictly read-only on user storage", async (t) => {
  const fixture = await makeCatalogFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const projA = join(fixture.sessionsRoot, "proj-a");
  await mkdir(projA, { recursive: true });
  const headerLine = JSON.stringify({ id: "id-bounded", cwd: fixture.workspace });
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

// ---------------------------------------------------------------------------
// Public SDK loader (native-session-sdk.ts)
// ---------------------------------------------------------------------------

interface SdkFixture {
  root: string;
  packageDir: string;
  piFile: string;
}

async function makeSdkFixture(
  prefix: string,
  manifest: Record<string, unknown>,
  entryFiles: Record<string, string>,
): Promise<SdkFixture> {
  const root = await realpath(await mkdtemp(join(process.cwd(), `.${prefix}-`)));
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
function probeSdkLoader(
  fixture: SdkFixture,
  extraEnv: NodeJS.ProcessEnv = {},
): { ok: boolean; entry?: string; packageDir?: string; version?: string; error?: string } {
  const compiledSdk = join(process.cwd(), "dist-test", "src", "session-host", "native-session-sdk.js");
  assert.ok(existsSync(compiledSdk), "the compiled SDK loader module must exist");
  const script = [
    "const loader = require(process.argv[1]);",
    "try {",
    "  const view = loader.resolveNativeSessionSdk(process.argv[2]);",
    "  process.stdout.write(JSON.stringify({ ok: true, entry: view.entry, packageDir: view.packageDir, version: view.version }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));",
    "}",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script, compiledSdk, fixture.piFile], {
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) throw new Error(`the sdk loader probe did not run: ${result.stderr ?? ""}`);
  return JSON.parse(result.stdout) as { ok: boolean; entry?: string; packageDir?: string; version?: string; error?: string };
}

test("resolveNativeSessionSdk resolves the public SDK entry of the own official package by bounded ancestor metadata", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-main", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, {
    "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n",
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
    main: "./dist/sdk.js",
  }, {
    // A class is a function at runtime; the production SDK shape must load.
    "dist/sdk.js": "class SessionManager { static async listAll() { return []; } }\nmodule.exports = { SessionManager };\n",
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const probe = probeSdkLoader(fixture);
  assert.equal(probe.ok, true, `a class-based SessionManager must load: ${probe.error ?? ""}`);
  assert.equal(probe.entry, join(fixture.packageDir, "dist", "sdk.js"));
});

test("resolveNativeSessionSdk refuses a public entry that escapes through an intermediate directory symlink", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-dirlink", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, {});
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

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
    exports: { ".": { require: "./dist/cjs.js", import: "./dist/mjs.js" } },
  }, {
    "dist/cjs.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n",
    "dist/mjs.js": "export {};\n",
  });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
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
  t.after(() => rm(unrelated.root, { recursive: true, force: true }));
  const unrelatedProbe = probeSdkLoader(unrelated);
  assert.equal(unrelatedProbe.ok, false);
  assert.ok(unrelatedProbe.error?.includes(PI_PACKAGE_NAME) && /unavailable/.test(unrelatedProbe.error ?? ""), `unexpected diagnostic: ${unrelatedProbe.error}`);

  const escaping = await makeSdkFixture("pi-saved-sdk-escape", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "../outside-sdk.js",
  }, { "dist/sdk.js": "module.exports = {};\n" });
  t.after(() => rm(escaping.root, { recursive: true, force: true }));
  const escapingProbe = probeSdkLoader(escaping);
  assert.equal(escapingProbe.ok, false);
  assert.match(escapingProbe.error ?? "", /no usable public SDK entry|escapes the package directory/);

  const noRuntime = await makeSdkFixture("pi-saved-sdk-noruntime", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { notTheManager: {} };\n" });
  t.after(() => rm(noRuntime.root, { recursive: true, force: true }));
  const noRuntimeProbe = probeSdkLoader(noRuntime);
  assert.equal(noRuntimeProbe.ok, false);
  assert.match(noRuntimeProbe.error ?? "", /does not export a SessionManager runtime/);

  const missingEntry = await makeSdkFixture("pi-saved-sdk-missing", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/absent.js",
  }, {});
  t.after(() => rm(missingEntry.root, { recursive: true, force: true }));
  const missingProbe = probeSdkLoader(missingEntry);
  assert.equal(missingProbe.ok, false);
  assert.match(missingProbe.error ?? "", /public SDK entry is missing/);
});

test("resolveNativeSessionSdk refuses runtime-role and settlement contexts without stripping env", async (t) => {
  const fixture = await makeSdkFixture("pi-saved-sdk-guard", {
    name: PI_PACKAGE_NAME,
    version: "1.0.4",
    main: "./dist/sdk.js",
  }, { "dist/sdk.js": "module.exports = { SessionManager: { listAll: async () => [] } };\n" });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

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
