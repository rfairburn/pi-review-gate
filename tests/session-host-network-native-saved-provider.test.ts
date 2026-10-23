import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { CreateInstanceOptions, NativeInstanceView } from "../src/session-host/instances";
import type { NativeSessionSdkInfo } from "../src/session-host/native-session-sdk";
import {
  createNativeSavedCatalogView,
  type NativeSavedCatalogHost,
  type NativeSavedCatalogReadOptions,
  type NativeSavedCatalogViewOptions,
  type NativeSavedDeletionAnswer,
  type NativeSavedResumeAnswer,
} from "../src/session-host/network/native-saved-provider";
import {
  OWNER_SAVED_ENTRY_KEYS,
  isOwnerSavedCatalogView,
  isOwnerSavedDeleteFacts,
  isOwnerSavedIdentifier,
  isOwnerSavedResumeFacts,
  isOwnerSavedWindowFacts,
  type OwnerSavedAuthorizationGuard,
  type OwnerSavedCatalogView,
  type OwnerSavedEntry,
  type OwnerSavedWindowFacts,
} from "../src/session-host/network/peer-saved";
import type { OwningHostInventorySnapshot } from "../src/session-host/owning-host-service";
import { deleteSavedSessionFile } from "../src/session-host/saved-deletion";
import {
  admitSavedSession,
  createSavedCatalogFreshnessScope,
  isSavedSessionAdmission,
  listSavedSessions,
  searchSavedSessions,
  validateSavedSessionDeletion,
  type ListSavedSessionsOptions,
  type OwnedLiveSession,
  type SavedSessionCatalog,
  type SavedSessionDeletionRefusalReason,
  type SavedSessionRow,
} from "../src/session-host/saved-sessions";

const RUN = "run-1";
const allow: OwnerSavedAuthorizationGuard = () => true;

type ListAll = NonNullable<ListSavedSessionsOptions["listAll"]>;
type SavedWindow = Extract<OwnerSavedWindowFacts, { readonly kind: "window" }>;

// ---------------------------------------------------------------- fixtures

interface Fixture {
  readonly root: string;
  readonly agentDir: string;
  readonly projectDir: string;
  readonly workspace: string;
}

async function makeFixture(t: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-native-saved-provider-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const projectDir = join(agentDir, "sessions", "project-a");
  const workspace = join(root, "workspace");
  await mkdir(projectDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { root, agentDir, projectDir, workspace };
}

interface SessionMeta {
  readonly name?: string;
  readonly text?: string;
  readonly modified?: string;
}

/** One synthetic saved conversation: the PUBLIC header line plus a fixture meta line. */
async function writeSession(dir: string, id: string, cwd: string, meta: SessionMeta = {}): Promise<string> {
  const file = join(dir, `${id}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd });
  await writeFile(file, `${header}\n${JSON.stringify({ type: "meta", ...meta })}\n`, "utf8");
  return file;
}

/**
 * The existing public-SDK injection seam: an explicit flat-directory listAll
 * over the fixture's `.jsonl` files (no recursion), honoring the signal.
 */
function fixtureListAll(): ListAll {
  return async (sessionDir, _onProgress, signal) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    const infos: NativeSessionSdkInfo[] = [];
    for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, entry.name);
      const [headerLine, metaLine] = (await readFile(path, "utf8")).split("\n");
      const header = JSON.parse(headerLine ?? "{}") as { id: string; cwd: string };
      const meta = (metaLine ? JSON.parse(metaLine) : {}) as SessionMeta;
      infos.push({
        path,
        id: header.id,
        cwd: header.cwd,
        ...(meta.name !== undefined ? { name: meta.name } : {}),
        ...(meta.text !== undefined ? { allMessagesText: meta.text } : {}),
        ...(meta.modified !== undefined ? { modified: new Date(meta.modified) } : {}),
      });
    }
    return infos;
  };
}

/** Three ordinary saved conversations, newest first: a, b, c. */
async function seedThree(fixture: Fixture): Promise<void> {
  await writeSession(fixture.projectDir, "id-a", fixture.workspace, {
    name: "Alpha plan with spaces",
    text: "alpha discussion about the plan",
    modified: "2025-03-03T00:00:00.000Z",
  });
  await writeSession(fixture.projectDir, "id-b", fixture.workspace, {
    name: "Beta ünïcødé 🚀",
    text: "beta notes",
    modified: "2025-03-02T00:00:00.000Z",
  });
  await writeSession(fixture.projectDir, "id-c", fixture.workspace, {
    text: "gamma first message",
    modified: "2025-03-01T00:00:00.000Z",
  });
}

/** Replace a file with byte-identical content under a NEW inode. */
function replaceWithSameContent(file: string): void {
  const content = readFileSync(file);
  writeFileSync(`${file}.replacement`, content);
  renameSync(`${file}.replacement`, file);
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((settle) => setImmediate(settle));
  }
  assert.fail("condition was not reached");
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function aliveRow(id: string, workspace: string): NativeInstanceView {
  return Object.freeze({
    id,
    label: "",
    workspace,
    agentDir: "",
    lifecycle: "alive" as const,
    busy: false,
    pendingInput: false,
    inputSurface: true,
    nativeSession: null,
    hasLiveProcess: true,
    activity: Object.freeze([]),
  });
}

/** The trash and unlink stages of the fake guarded Delete (only these are faked). */
interface DeletePlan {
  trash: (file: string) => number | null;
  unlink: (file: string) => void;
  readonly trashCalls: string[];
  readonly unlinkCalls: string[];
  /** Invocations of the guarded Delete primitive. */
  deleteCalls: number;
}

function newDeletePlan(): DeletePlan {
  return {
    trash: (file) => {
      unlinkSync(file);
      return 0;
    },
    unlink: (file) => unlinkSync(file),
    trashCalls: [],
    unlinkCalls: [],
    deleteCalls: 0,
  };
}

/** Which guarded primitive (and which delete stage) is about to authorize. */
type BoundaryProbe = (operation: "resume" | "delete", stage: number) => void;

/**
 * A faithful test double of the owning-host service's Saved surface.
 *
 * The guarded primitives follow the landed service contract exactly: arbitrary
 * code may run only BEFORE the final caller authorization (`beforeAuthorize`,
 * a reentrancy probe), then the caller's `authorize` must answer exactly
 * `true`, and then ONLY the real native checks (`admitSavedSession` /
 * `validateSavedSessionDeletion` over this host's own owned-live data) and the
 * handoff or mutation follow. Delete runs that boundary before trash AND before
 * the unlink fallback, through the real `deleteSavedSessionFile` with only its
 * trash/unlink stages faked. No injected callback runs after `authorize`.
 */
class FakeHost implements NativeSavedCatalogHost {
  runId = RUN;
  inventoryAvailable = true;
  rows: NativeInstanceView[] = [];
  owned: OwnedLiveSession[] = [];
  /** Handoffs the guarded Resume actually performed (what it handed the manager). */
  readonly starts: CreateInstanceOptions[] = [];
  readonly plan: DeletePlan = newDeletePlan();
  inventoryReads = 0;
  validateCalls = 0;
  resumeCalls = 0;
  /** Runs inside the preparation preflight only (it is never a mutation boundary). */
  onValidate: (() => void) | undefined;
  validateThrows = false;
  deleteThrows = false;
  beforeAuthorize: BoundaryProbe | undefined;
  /** The handoff itself and its post-handoff classification. */
  startImpl: (options: CreateInstanceOptions) => Promise<NativeSavedResumeAnswer> = async (options) => {
    const id = `row-${this.starts.length}`;
    this.rows.push(aliveRow(id, options.workspace));
    return { status: "started", id };
  };
  #revision = 0;

  readInventorySnapshot(): OwningHostInventorySnapshot | undefined {
    this.inventoryReads += 1;
    if (!this.inventoryAvailable) return undefined;
    this.#revision += 1;
    return Object.freeze({ hostRunId: this.runId, revision: this.#revision, rows: Object.freeze([...this.rows]) });
  }

  validateSavedConversationDeletion(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
  ): SavedSessionDeletionRefusalReason | undefined {
    this.validateCalls += 1;
    this.onValidate?.();
    if (this.validateThrows) throw new Error("secret validation failure /private/owner/path");
    return validateSavedSessionDeletion(catalog, row, { ownedLiveSessions: this.owned });
  }

  async startSavedConversation(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
    authorize: () => boolean,
  ): Promise<NativeSavedResumeAnswer> {
    this.resumeCalls += 1;
    this.beforeAuthorize?.("resume", 1);
    if (authorize() !== true) return { status: "refused", reason: "not-authorized" };
    // Only native checks and the handoff follow the final caller authorization.
    const admitted = admitSavedSession(catalog, row, { ownedLiveSessions: this.owned });
    if (admitted.status === "refused") return { status: "refused", reason: admitted.reason };
    const options: CreateInstanceOptions = { workspace: admitted.admission.workspace, savedSession: admitted.admission };
    this.starts.push(options);
    return this.startImpl(options);
  }

  deleteSavedConversation(
    catalog: SavedSessionCatalog,
    row: SavedSessionRow,
    authorize: () => boolean,
  ): NativeSavedDeletionAnswer {
    const plan = this.plan;
    plan.deleteCalls += 1;
    if (this.deleteThrows) throw new Error("secret /private/owner/delete");
    const state: {
      stage: number;
      trashInvoked: boolean;
      unlinkInvoked: boolean;
      firstRefusal: string | undefined;
      lastRefusal: string | undefined;
    } = { stage: 0, trashInvoked: false, unlinkInvoked: false, firstRefusal: undefined, lastRefusal: undefined };
    const result = deleteSavedSessionFile(row.file, {
      validate: () => {
        state.stage += 1;
        this.beforeAuthorize?.("delete", state.stage);
        // Only native checks and this stage's mutation follow the authorization.
        const refusal: string | undefined = authorize() !== true
          ? "not-authorized"
          : validateSavedSessionDeletion(catalog, row, { ownedLiveSessions: this.owned });
        if (state.stage === 1) state.firstRefusal = refusal;
        state.lastRefusal = refusal;
        return refusal;
      },
      spawnSync: ((_command: string, args: readonly string[]) => {
        const target = args[0] ?? "";
        state.trashInvoked = true;
        plan.trashCalls.push(target);
        return { pid: 0, output: [], stdout: "", stderr: "", status: plan.trash(target), signal: null };
      }) as unknown as typeof spawnSync,
      unlink: (path: string) => {
        state.unlinkInvoked = true;
        plan.unlinkCalls.push(path);
        plan.unlink(path);
      },
    });
    if (result.ok) return { status: "deleted", method: result.method };
    if (state.stage === 1 && state.firstRefusal !== undefined && !state.trashInvoked) {
      return { status: "refused", reason: state.firstRefusal };
    }
    return {
      status: "unconfirmed",
      trashInvoked: state.trashInvoked,
      unlinkInvoked: state.unlinkInvoked,
      ...(state.stage > 1 && state.lastRefusal !== undefined ? { fallbackRefusal: state.lastRefusal } : {}),
    };
  }
}

function makeView(
  host: FakeHost,
  fixture: Fixture,
  overrides: Partial<NativeSavedCatalogViewOptions> = {},
): OwnerSavedCatalogView {
  return createNativeSavedCatalogView({
    host,
    readCatalogOptions: () => ({ agentDir: fixture.agentDir, listAll: fixtureListAll() }),
    ...overrides,
  });
}

function asWindow(facts: OwnerSavedWindowFacts): SavedWindow {
  assert.equal(facts.kind, "window");
  assert.ok(isOwnerSavedWindowFacts(facts), "a window is one coherent wire-valid fact set");
  return facts as SavedWindow;
}

async function listWindow(view: OwnerSavedCatalogView, query = "", offset = 0, count = 64): Promise<SavedWindow> {
  return asWindow(await view.list({ hostRunId: RUN, query, offset, count }, freshSignal(), allow));
}

function entryOf(window: SavedWindow, sessionId: string): OwnerSavedEntry {
  const entry = window.entries.find((candidate) => candidate.sessionId === sessionId);
  assert.ok(entry, `entry ${sessionId} is in the window`);
  return entry;
}

function handlesOf(window: SavedWindow, entry: OwnerSavedEntry): {
  hostRunId: string;
  catalogId: string;
  resultId: string;
  entryId: string;
} {
  return { hostRunId: window.hostRunId, catalogId: window.catalogId, resultId: window.resultId, entryId: entry.entryId };
}

async function referenceCatalog(fixture: Fixture, listAll: ListAll = fixtureListAll()): Promise<SavedSessionCatalog> {
  // Default local freshness domain, exactly like the owner's local picker.
  return listSavedSessions({ agentDir: fixture.agentDir, listAll });
}

// ---------------------------------------------------------------- lifetime

test("creating and disposing a view reads, lists, starts, and deletes nothing", () => {
  const host = new FakeHost();
  let optionReads = 0;
  let listings = 0;
  const view = createNativeSavedCatalogView({
    host,
    readCatalogOptions: () => {
      optionReads += 1;
      return undefined;
    },
    listCatalog: async (options) => {
      listings += 1;
      return listSavedSessions(options);
    },
  });
  assert.ok(isOwnerSavedCatalogView(view));
  assert.deepEqual(Object.keys(view).sort(), ["dispose", "list", "remove", "resume", "search", "window"]);
  view.dispose();
  view.dispose();
  assert.deepEqual(
    {
      inventory: host.inventoryReads,
      optionReads,
      listings,
      validations: host.validateCalls,
      resumes: host.resumeCalls,
      deletions: host.plan.deleteCalls,
    },
    { inventory: 0, optionReads: 0, listings: 0, validations: 0, resumes: 0, deletions: 0 },
  );
});

// ---------------------------------------------------------------- listing

test("a window carries the owner's exact native Saved display strings and nothing else", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  // A long, spaced, Unicode cwd beyond the native current-file validator's 4096
  // bound: the Saved listing applies no such bound and no clipping.
  const longCwd = `/srv/owner projects/ünï cødé/${"deep segment/".repeat(400)}end`;
  await writeSession(fixture.projectDir, "id-long", longCwd, {
    name: `Long caption ${"word ".repeat(30)}`,
    modified: "2025-02-01T00:00:00.000Z",
  });
  // One unsafe entry in another project: a bounded issue, counted as a scalar.
  const unsafeProject = join(fixture.agentDir, "sessions", "project-unsafe");
  await mkdir(unsafeProject, { recursive: true });
  await symlink(join(fixture.projectDir, "id-a.jsonl"), join(unsafeProject, "linked.jsonl"));

  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const reference = await referenceCatalog(fixture);

  assert.deepEqual(Object.keys(window).sort(),
    ["catalogId", "entries", "hostRunId", "issueCount", "kind", "offset", "resultId", "total"]);
  assert.equal(window.hostRunId, RUN);
  assert.equal(window.total, 4);
  assert.equal(window.offset, 0);
  assert.equal(window.issueCount, reference.issueCount);
  assert.equal(window.issueCount, 1);
  assert.deepEqual(window.entries.map((entry) => entry.sessionId), reference.rows.map((row) => row.id));
  for (const [index, entry] of window.entries.entries()) {
    const row = reference.rows[index]!;
    assert.deepEqual(Object.keys(entry), [...OWNER_SAVED_ENTRY_KEYS], "exactly the closed entry key set");
    assert.deepEqual(entry, {
      entryId: entry.entryId,
      sessionId: row.id,
      file: row.file,
      caption: row.caption,
      cwd: row.cwd,
    }, "the same native row values as the owner's local Saved row, unchanged");
    assert.ok(isOwnerSavedIdentifier(entry.entryId));
    assert.ok(!entry.entryId.includes(row.id) && !row.file.includes(entry.entryId), "ids are not file- or row-derived");
  }
  assert.equal(entryOf(window, "id-long").cwd, longCwd, "the full cwd crosses unclipped");
  assert.equal(entryOf(window, "id-a").file, join(fixture.projectDir, "id-a.jsonl"), "the full owner file path crosses");
  assert.equal(new Set(window.entries.map((entry) => entry.entryId)).size, 4);
  for (const id of [window.catalogId, window.resultId]) assert.ok(isOwnerSavedIdentifier(id));
  assert.equal(host.starts.length, 0);
  assert.deepEqual(host.rows, [], "a rowless owner lists Saved conversations without any row or focus");
});

test("a full result larger than 4096 rows is browsed in honest contiguous windows with stable ids", async (t) => {
  const fixture = await makeFixture(t);
  const bulkFile = await writeSession(fixture.projectDir, "bulk", fixture.workspace);
  const base = Date.parse("2025-06-01T00:00:00.000Z");
  const bulkListAll: ListAll = async (sessionDir) => sessionDir !== fixture.projectDir
    ? []
    : Array.from({ length: 4200 }, (_unused, index): NativeSessionSdkInfo => ({
      path: bulkFile,
      id: `bulk-${String(index).padStart(4, "0")}`,
      cwd: fixture.workspace,
      name: `Bulk conversation ${index}`,
      modified: new Date(base - index * 1000),
    }));
  const host = new FakeHost();
  const view = makeView(host, fixture, {
    readCatalogOptions: () => ({ agentDir: fixture.agentDir, listAll: bulkListAll }),
  });
  const expected = (await referenceCatalog(fixture, bulkListAll)).rows.map((row) => row.id);
  assert.equal(expected.length, 4200);

  const first = await listWindow(view, "", 0, 4096);
  assert.equal(first.total, 4200, "the full total is stated, beyond any per-window bound");
  assert.equal(first.entries.length, 4096);
  const handles = { hostRunId: RUN, catalogId: first.catalogId, resultId: first.resultId };
  const second = asWindow(await view.window({ ...handles, offset: 4096, count: 4096 }, freshSignal(), allow));
  assert.equal(second.total, 4200);
  assert.equal(second.offset, 4096);
  assert.equal(second.entries.length, 104, "exactly the rows that remain, no holes");
  assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.sessionId), expected);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.entryId)).size, 4200);

  const again = asWindow(await view.window({ ...handles, offset: 0, count: 3 }, freshSignal(), allow));
  assert.deepEqual(again.entries, first.entries.slice(0, 3), "the same result is sliced; ids are never reminted");
  assert.equal(again.catalogId, first.catalogId);
  assert.equal(again.resultId, first.resultId);

  const end = asWindow(await view.window({ ...handles, offset: 4200, count: 10 }, freshSignal(), allow));
  assert.deepEqual(end.entries, [], "an empty window only at the legitimate end");
  assert.deepEqual(
    await view.window({ ...handles, offset: 4201, count: 10 }, freshSignal(), allow),
    { kind: "refused", reason: "range" },
  );
  assert.deepEqual(
    await view.window({ ...handles, offset: 0, count: 0 }, freshSignal(), allow),
    { kind: "refused", reason: "range" },
  );

  // Native search over the same catalog: exact matcher, full result, windowed.
  const reference = await referenceCatalog(fixture, bulkListAll);
  const query = "re:^bulk-41";
  const searched = asWindow(await view.search(
    { hostRunId: RUN, catalogId: first.catalogId, query, offset: 0, count: 4096 }, freshSignal(), allow));
  assert.deepEqual(searched.entries.map((entry) => entry.sessionId),
    searchSavedSessions(reference, query).map((row) => row.id));
  assert.equal(searched.total, 100);
  assert.equal(searched.catalogId, first.catalogId, "search keeps the catalog");
  assert.notEqual(searched.resultId, first.resultId, "search replaces the result");
});

test("list and search forward the exact query to the native matcher", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const reference = await referenceCatalog(fixture);
  const listed = await listWindow(view);
  const queries = [
    "",
    "   ",
    "alpha",
    "  alpha  ",
    "alpha plan",
    "\"plan with\"",
    "\"unbalanced quote",
    "re:^id-(a|c)",
    "re:(",
    "ünïcødé",
    "🚀",
    "beta 🚀",
    `nomatch-${"x".repeat(20_000)}`,
  ];
  const resultIds = new Set<string>([listed.resultId]);
  let catalogId = listed.catalogId;
  for (const query of queries) {
    const label = JSON.stringify(query.slice(0, 40));
    const expected = searchSavedSessions(reference, query).map((row) => row.id);
    const searched = asWindow(await view.search(
      { hostRunId: RUN, catalogId, query, offset: 0, count: 64 }, freshSignal(), allow));
    assert.deepEqual(searched.entries.map((entry) => entry.sessionId), expected, `search ${label}`);
    assert.equal(searched.total, expected.length);
    assert.equal(searched.catalogId, catalogId, "search keeps the exact current catalog");
    resultIds.add(searched.resultId);
    const relisted = await listWindow(view, query);
    assert.deepEqual(relisted.entries.map((entry) => entry.sessionId), expected, `list ${label}`);
    assert.notEqual(relisted.catalogId, catalogId, "a list replaces the catalog");
    resultIds.add(relisted.resultId);
    // Keep searching within the newest catalog.
    catalogId = relisted.catalogId;
  }
  assert.equal(resultIds.size, queries.length * 2 + 1, "every search and list mints a new result");
  assert.deepEqual(
    await view.list({ hostRunId: RUN, query: "\ud800", offset: 0, count: 1 }, freshSignal(), allow),
    { kind: "refused", reason: "unrepresentable" },
  );
});

test("a row whose native strings cannot cross the wire refuses its window instead of being dropped", async (t) => {
  const fixture = await makeFixture(t);
  await writeSession(fixture.projectDir, "id-a", fixture.workspace, { name: "fine", modified: "2025-03-03T00:00:00.000Z" });
  await writeSession(fixture.projectDir, "id-bad", fixture.workspace, { name: "\ud800 lone", modified: "2025-03-02T00:00:00.000Z" });
  await writeSession(fixture.projectDir, "id-c", fixture.workspace, { name: "also fine", modified: "2025-03-01T00:00:00.000Z" });
  const view = makeView(new FakeHost(), fixture);
  const head = await listWindow(view, "", 0, 1);
  assert.equal(head.total, 3);
  const handles = { hostRunId: RUN, catalogId: head.catalogId, resultId: head.resultId };
  assert.deepEqual(await view.window({ ...handles, offset: 0, count: 3 }, freshSignal(), allow),
    { kind: "refused", reason: "unrepresentable" });
  assert.deepEqual(await view.window({ ...handles, offset: 1, count: 1 }, freshSignal(), allow),
    { kind: "refused", reason: "unrepresentable" });
  const tail = asWindow(await view.window({ ...handles, offset: 2, count: 1 }, freshSignal(), allow));
  assert.deepEqual(tail.entries.map((entry) => entry.sessionId), ["id-c"]);
});

// ---------------------------------------------------------------- freshness and handles

test("each view lists in its own freshness scope and always overrides scope and signal", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const recorded: ListSavedSessionsOptions[] = [];
  const foreignScope = createSavedCatalogFreshnessScope();
  const foreignSignal = new AbortController().signal;
  const overrides: Partial<NativeSavedCatalogViewOptions> = {
    readCatalogOptions: () => ({
      agentDir: fixture.agentDir,
      listAll: fixtureListAll(),
      freshnessScope: foreignScope,
      signal: foreignSignal,
    } as NativeSavedCatalogReadOptions),
    listCatalog: async (options) => {
      recorded.push(options);
      return listSavedSessions(options);
    },
  };
  const host = new FakeHost();
  const viewA = makeView(host, fixture, overrides);
  const viewB = makeView(host, fixture, overrides);
  const a1 = await listWindow(viewA);
  const b1 = await listWindow(viewB);
  const local = await referenceCatalog(fixture);
  const a2 = await listWindow(viewA);
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every((options) => options.freshnessScope !== undefined && options.freshnessScope !== foreignScope));
  assert.ok(recorded.every((options) => options.signal !== undefined && options.signal !== foreignSignal));
  assert.equal(recorded[0]!.freshnessScope, recorded[2]!.freshnessScope, "one scope per view");
  assert.notEqual(recorded[0]!.freshnessScope, recorded[1]!.freshnessScope, "views never share a scope");

  // viewA relisting stales viewA's previous catalog only.
  assert.deepEqual(await viewA.resume(handlesOf(a1, entryOf(a1, "id-a")), allow), { kind: "refused", reason: "stale" });
  const startedA = await viewA.resume(handlesOf(a2, entryOf(a2, "id-a")), allow);
  assert.equal(startedA.kind, "started");
  const startedB = await viewB.resume(handlesOf(b1, entryOf(b1, "id-b")), allow);
  assert.equal(startedB.kind, "started", "another view's listings never supersede this view");
  const localRow = local.rows.find((row) => row.id === "id-c")!;
  assert.equal(admitSavedSession(local, localRow).status, "admitted", "the default local catalog stays current");
  assert.equal(host.starts.length, 2);
  for (const start of host.starts) {
    assert.ok(isSavedSessionAdmission(start.savedSession), "the exact branded native admission is handed over");
    assert.equal(start.workspace, start.savedSession!.workspace);
  }
});

test("forged, cross-view, cross-result, cross-run, and replayed handles are refused as stale", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const viewA = makeView(host, fixture);
  const viewB = makeView(host, fixture);
  const wA = await listWindow(viewA);
  const wB = await listWindow(viewB);
  const stale = { kind: "refused", reason: "stale" };

  assert.deepEqual(await viewA.window(
    { hostRunId: RUN, catalogId: wB.catalogId, resultId: wB.resultId, offset: 0, count: 1 }, freshSignal(), allow), stale);
  assert.deepEqual(await viewA.resume(handlesOf(wA, entryOf(wB, "id-a")), allow), stale);
  assert.deepEqual(await viewA.resume({ ...handlesOf(wA, entryOf(wA, "id-a")), catalogId: wB.catalogId }, allow), stale);
  assert.deepEqual(await viewA.remove({ ...handlesOf(wA, entryOf(wB, "id-a")), confirmed: false }, allow), stale);
  const entryA = entryOf(wA, "id-a");
  for (const forged of ["../etc/passwd", entryA.file, "", "x".repeat(65), entryA.sessionId]) {
    assert.deepEqual(await viewA.resume({ ...handlesOf(wA, entryA), entryId: forged }, allow), stale);
    assert.deepEqual(await viewA.remove({ ...handlesOf(wA, entryA), entryId: forged, confirmed: false }, allow), stale);
  }
  assert.deepEqual(await viewA.resume({ ...handlesOf(wA, entryA), hostRunId: "run-2" }, allow), stale);
  assert.deepEqual(await viewA.window(
    { hostRunId: "run-2", catalogId: wA.catalogId, resultId: wA.resultId, offset: 0, count: 1 }, freshSignal(), allow), stale);

  // Search replaces the result: the old result and its entries are gone.
  const searched = asWindow(await viewA.search(
    { hostRunId: RUN, catalogId: wA.catalogId, query: "alpha", offset: 0, count: 8 }, freshSignal(), allow));
  assert.deepEqual(await viewA.window(
    { hostRunId: RUN, catalogId: wA.catalogId, resultId: wA.resultId, offset: 0, count: 1 }, freshSignal(), allow), stale);
  assert.deepEqual(await viewA.resume({ ...handlesOf(searched, entryA) }, allow), stale);

  // A relist replaces the catalog: old catalog, search, and entries are gone.
  const relisted = await listWindow(viewA);
  assert.deepEqual(await viewA.search(
    { hostRunId: RUN, catalogId: wA.catalogId, query: "", offset: 0, count: 1 }, freshSignal(), allow), stale);
  assert.deepEqual(await viewA.resume(handlesOf(searched, entryOf(searched, "id-a")), allow), stale);

  // The owner run this view captured is gone: everything it minted is stale.
  host.runId = "run-2";
  assert.deepEqual(await viewA.window(
    { hostRunId: RUN, catalogId: relisted.catalogId, resultId: relisted.resultId, offset: 0, count: 1 },
    freshSignal(), allow), stale);
  assert.deepEqual(await viewA.list({ hostRunId: "run-2", query: "", offset: 0, count: 1 }, freshSignal(), allow), stale);
  assert.equal(host.resumeCalls, 0, "no forged handle reached the guarded Resume primitive");
  assert.equal(plan.deleteCalls, 0, "no forged handle reached the guarded Delete primitive");
});

test("a superseded late listing never commits or resurrects authority (A -> B -> A)", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const gate = deferred<void>();
  let calls = 0;
  const base = fixtureListAll();
  const gatedListAll: ListAll = async (dir, progress, signal) => {
    calls += 1;
    if (calls === 1) await gate.promise;
    return base(dir, progress, signal);
  };
  const host = new FakeHost();
  const view = makeView(host, fixture, { readCatalogOptions: () => ({ agentDir: fixture.agentDir, listAll: gatedListAll }) });

  // The caller never aborts A: the view's own read slot retires it.
  const pendingA = view.list({ hostRunId: RUN, query: "", offset: 0, count: 8 }, freshSignal(), allow);
  await waitFor(() => calls === 1);
  const wB = await listWindow(view, "", 0, 8);
  gate.resolve();
  assert.deepEqual(await pendingA, { kind: "refused", reason: "stale" });
  const started = await view.resume(handlesOf(wB, entryOf(wB, "id-a")), allow);
  assert.equal(started.kind, "started", "the late A listing did not stale B's native catalog");

  const wA2 = await listWindow(view, "", 0, 8);
  assert.notEqual(wA2.catalogId, wB.catalogId);
  assert.deepEqual(await view.resume(handlesOf(wB, entryOf(wB, "id-b")), allow), { kind: "refused", reason: "stale" });
});

test("an aborted read retires only that read and passes the abort to the native listing", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const gate = deferred<void>();
  let calls = 0;
  const base = fixtureListAll();
  const recorded: ListSavedSessionsOptions[] = [];
  const host = new FakeHost();
  const view = makeView(host, fixture, {
    readCatalogOptions: () => ({
      agentDir: fixture.agentDir,
      listAll: async (dir, progress, signal) => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return base(dir, progress, signal);
      },
    }),
    listCatalog: (options) => {
      recorded.push(options);
      return listSavedSessions(options);
    },
  });
  const controller = new AbortController();
  const pending = view.list({ hostRunId: RUN, query: "", offset: 0, count: 8 }, controller.signal, allow);
  await waitFor(() => calls === 1);
  controller.abort();
  assert.equal(recorded[0]!.signal?.aborted, true);
  gate.resolve();
  assert.deepEqual(await pending, { kind: "refused", reason: "stale" });
  const window = await listWindow(view);
  assert.equal(window.total, 3, "the view keeps working after an aborted read");
});

test("unavailable inputs and throwing callbacks produce fixed facts only", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  let listings = 0;
  const counting: Partial<NativeSavedCatalogViewOptions> = {
    listCatalog: async (options) => {
      listings += 1;
      return listSavedSessions(options);
    },
  };
  const request = { hostRunId: RUN, query: "", offset: 0, count: 8 };

  const noConfig = makeView(host, fixture, { ...counting, readCatalogOptions: () => undefined });
  assert.deepEqual(await noConfig.list(request, freshSignal(), allow), { kind: "unavailable" });
  assert.equal(listings, 0, "no listing, repair, or default when the owner has no native inputs");

  const throwingConfig = makeView(host, fixture, {
    ...counting,
    readCatalogOptions: () => {
      throw new Error("secret-token /private/owner/config");
    },
  });
  const configFacts = await throwingConfig.list(request, freshSignal(), allow);
  assert.deepEqual(configFacts, { kind: "unavailable" });
  assert.ok(!JSON.stringify(configFacts).includes("secret"));

  const throwingList = makeView(host, fixture, {
    listCatalog: async () => {
      throw new Error("secret-token /private/owner/sessions");
    },
  });
  assert.deepEqual(await throwingList.list(request, freshSignal(), allow), { kind: "unavailable" });

  const forgedCatalog = makeView(host, fixture, {
    listCatalog: async () => ({ agentDir: "/x", sessionsRoot: "/x/sessions", revision: 1, rows: [], issues: [], issueCount: 0 }),
  });
  assert.deepEqual(await forgedCatalog.list(request, freshSignal(), allow), { kind: "unavailable" },
    "a plain unbranded catalog is never accepted");

  const view = makeView(host, fixture, counting);
  assert.deepEqual(await view.list(request, freshSignal(), () => false), { kind: "refused", reason: "admission" });
  assert.deepEqual(await view.list(request, freshSignal(), () => {
    throw new Error("secret");
  }), { kind: "refused", reason: "admission" });
  assert.deepEqual(await view.list(request, freshSignal(), () => {
    view.dispose();
    return true;
  }), { kind: "refused", reason: "stale" }, "a guard that retires the view stops the read");
  assert.equal(listings, 0);
  assert.deepEqual(await view.list(request, freshSignal(), allow), { kind: "unavailable" }, "a disposed view reads nothing");

  const unobservable = makeView(host, fixture, counting);
  host.inventoryAvailable = false;
  assert.deepEqual(await unobservable.list(request, freshSignal(), allow), { kind: "unavailable" });
  host.inventoryAvailable = true;

  const reentrant = makeView(host, fixture, {
    ...counting,
    readCatalogOptions: () => {
      reentrant.dispose();
      return { agentDir: fixture.agentDir, listAll: fixtureListAll() };
    },
  });
  assert.deepEqual(await reentrant.list(request, freshSignal(), allow), { kind: "refused", reason: "stale" });
  assert.equal(listings, 0, "a callback that retired the view prevents the listing");
});

// ---------------------------------------------------------------- resume

test("resume admits the exact native row and starts it through the one owner service", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const entry = entryOf(window, "id-b");

  const facts = await view.resume(handlesOf(window, entry), allow);
  assert.deepEqual(facts, { kind: "started", hostRunId: RUN, rowId: "row-1" });
  assert.ok(isOwnerSavedResumeFacts(facts));
  assert.equal(host.starts.length, 1);
  const start = host.starts[0]!;
  assert.ok(isSavedSessionAdmission(start.savedSession));
  assert.equal(start.savedSession!.file, entry.file);
  assert.equal(start.savedSession!.sessionId, "id-b");
  assert.equal(start.workspace, fixture.workspace, "the owner's own admitted workspace, never a requester value");
  assert.deepEqual(Object.keys(start).sort(), ["savedSession", "workspace"]);
});

test("resume keeps every native admission and duplicate fence and refuses only before handoff", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const gone = join(fixture.root, "gone-workspace");
  await mkdir(gone);
  await writeSession(fixture.projectDir, "id-gone", gone, { modified: "2025-01-01T00:00:00.000Z" });
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);

  host.owned = [{ kind: "current", id: "id-a", file: join(fixture.root, "elsewhere.jsonl") }];
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-a")), allow),
    { kind: "refused", reason: "duplicate" });
  host.owned = [];

  replaceWithSameContent(entryOf(window, "id-b").file);
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-b")), allow),
    { kind: "refused", reason: "admission" }, "a replaced file (new inode) is refused");

  await rm(gone, { recursive: true });
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-gone")), allow),
    { kind: "refused", reason: "admission" }, "a missing workspace is never substituted");

  const entryC = entryOf(window, "id-c");
  const resumesBefore = host.resumeCalls;
  assert.deepEqual(await view.resume(handlesOf(window, entryC), () => false), { kind: "refused", reason: "admission" });
  assert.equal(host.resumeCalls, resumesBefore, "a refused initial proof never reaches the primitive");
  let guardCalls = 0;
  assert.deepEqual(await view.resume(handlesOf(window, entryC), () => {
    guardCalls += 1;
    return guardCalls === 1;
  }), { kind: "refused", reason: "admission" }, "the primitive's final authorization fences the handoff");
  assert.equal(guardCalls, 2, "one initial proof, then exactly one guard call inside the authorization");
  assert.equal(host.resumeCalls, resumesBefore + 1);

  // A reentrant callback before the final authorization retires the view: the
  // authorization's in-memory checks refuse, so nothing is handed off.
  host.beforeAuthorize = () => view.dispose();
  assert.deepEqual(await view.resume(handlesOf(window, entryC), allow), { kind: "refused", reason: "stale" });
  host.beforeAuthorize = undefined;
  assert.equal(host.starts.length, 0, "no refusal path reached the native start");
});

test("after the native handoff an unusable or unobservable start is never a refusal or a retry", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  const cases: Array<{
    readonly name: string;
    readonly start: () => Promise<NativeSavedResumeAnswer>;
    readonly expected: unknown;
  }> = [
    { name: "throw", start: async () => { throw new Error("secret /private/owner/pty"); }, expected: { kind: "unknown" } },
    { name: "not-ready", start: async () => ({ status: "not-ready" }), expected: { kind: "unconfirmed" } },
    { name: "failed", start: async () => ({ status: "failed" }), expected: { kind: "unconfirmed" } },
    { name: "duplicate", start: async () => ({ status: "duplicate" }), expected: { kind: "unconfirmed" } },
    { name: "unknown", start: async () => ({ status: "unknown" }), expected: { kind: "unknown" } },
    {
      name: "started-unrepresentable-id",
      start: async () => ({ status: "started", id: "not a wire id" }),
      expected: { kind: "unknown" },
    },
    { name: "started", start: async () => ({ status: "started", id: "row-actual" }), expected: { kind: "started", hostRunId: RUN, rowId: "row-actual" } },
  ];
  for (const [index, entry] of cases.entries()) {
    host.startImpl = entry.start;
    const facts = await view.resume(handles, allow);
    assert.deepEqual(facts, entry.expected, entry.name);
    assert.ok(!JSON.stringify(facts).includes("secret"));
    assert.equal(host.starts.length, index + 1, `${entry.name}: exactly one native handoff, no retry`);
  }
});

test("a resume started before a later revocation is still reported as started", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  let authorized = true;
  host.startImpl = async (options) => {
    // The handoff happened; the grant and policy turn off before classification.
    authorized = false;
    host.rows.push(aliveRow("row-revoked-later", options.workspace));
    return { status: "started", id: "row-revoked-later" };
  };
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-a")), () => authorized),
    { kind: "started", hostRunId: RUN, rowId: "row-revoked-later" });
  assert.equal(host.starts.length, 1);
});

test("an accepted resume completes truthfully after the view is disposed", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const release = deferred<void>();
  host.startImpl = async (options) => {
    await release.promise;
    host.rows.push(aliveRow("row-late", options.workspace));
    return { status: "started", id: "row-late" };
  };
  let authorized = true;
  const pending = view.resume(handlesOf(window, entryOf(window, "id-a")), () => authorized);
  assert.equal(host.starts.length, 1, "the handoff happened");
  view.dispose();
  authorized = false;
  release.resolve();
  assert.deepEqual(await pending, { kind: "started", hostRunId: RUN, rowId: "row-late" },
    "accepted work is neither cancelled nor hidden by a later retirement");
  assert.equal(host.starts.length, 1);
});

// ---------------------------------------------------------------- delete

test("prepare is native validation only and a confirmation spends exactly that preparation", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const entryA = entryOf(window, "id-a");
  const entryB = entryOf(window, "id-b");

  assert.deepEqual(await view.remove({ ...handlesOf(window, entryA), confirmed: true }, allow),
    { kind: "refused", reason: "stale" }, "no confirmation without a prior preparation");
  const prepared = await view.remove({ ...handlesOf(window, entryA), confirmed: false }, allow);
  assert.deepEqual(prepared, { kind: "confirmation-required" });
  assert.ok(isOwnerSavedDeleteFacts(prepared));
  assert.equal(plan.deleteCalls, 0, "preparation never reaches the deletion path");
  assert.equal(readFileSync(entryA.file, "utf8").length > 0, true);

  assert.deepEqual(await view.remove({ ...handlesOf(window, entryB), confirmed: true }, allow),
    { kind: "refused", reason: "stale" }, "a confirmation must name the prepared entry");
  assert.deepEqual(await view.remove({ ...handlesOf(window, entryA), confirmed: true }, allow),
    { kind: "refused", reason: "stale" }, "the mismatched confirmation consumed the preparation");
  assert.equal(plan.deleteCalls, 0);

  await view.remove({ ...handlesOf(window, entryA), confirmed: false }, allow);
  const deleted = await view.remove({ ...handlesOf(window, entryA), confirmed: true }, allow);
  assert.deepEqual(deleted, { kind: "deleted", method: "trash" });
  assert.deepEqual(plan.trashCalls, [entryA.file], "the native trash-first path received the owner's own file");
  assert.deepEqual(plan.unlinkCalls, []);
  assert.deepEqual(await view.remove({ ...handlesOf(window, entryA), confirmed: true }, allow),
    { kind: "refused", reason: "stale" }, "no replay");
  assert.deepEqual(await view.window(
    { hostRunId: RUN, catalogId: window.catalogId, resultId: window.resultId, offset: 0, count: 1 }, freshSignal(), allow),
  { kind: "refused", reason: "stale" }, "a completed delete retires the old operation authority");
  assert.equal(plan.deleteCalls, 1);
  const refreshed = await listWindow(view);
  assert.deepEqual(refreshed.entries.map((entry) => entry.sessionId), ["id-b", "id-c"]);
});

test("the live server policy is re-proved before preparation and before every mutation stage", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const policy = { on: false };
  const deleteGuard: OwnerSavedAuthorizationGuard = () => policy.on;
  let window = await listWindow(view);
  let handles = handlesOf(window, entryOf(window, "id-a"));

  assert.deepEqual(await view.remove({ ...handles, confirmed: false }, deleteGuard), { kind: "refused", reason: "policy" });
  policy.on = true;
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, deleteGuard), { kind: "refused", reason: "stale" },
    "a refused preparation stored nothing");

  assert.deepEqual(await view.remove({ ...handles, confirmed: false }, deleteGuard), { kind: "confirmation-required" });
  policy.on = false;
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, deleteGuard), { kind: "refused", reason: "policy" });
  policy.on = true;

  // Policy turns off by the primitive's final authorization: refused before trash.
  window = await listWindow(view);
  handles = handlesOf(window, entryOf(window, "id-a"));
  await view.remove({ ...handles, confirmed: false }, allow);
  let calls = 0;
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, () => {
    calls += 1;
    return calls === 1;
  }), { kind: "refused", reason: "policy" });
  assert.equal(calls, 2, "one initial proof, then exactly one guard call inside the authorization");
  assert.equal(plan.deleteCalls, 1, "the guarded primitive was entered");
  assert.deepEqual(plan.trashCalls, [], "and its first-stage authorization refused before trash");

  // Policy turns off after trash failed: the fallback is refused, never reported as no change.
  window = await listWindow(view);
  handles = handlesOf(window, entryOf(window, "id-a"));
  await view.remove({ ...handles, confirmed: false }, deleteGuard);
  plan.trash = () => {
    policy.on = false;
    return 1;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, deleteGuard), { kind: "unconfirmed" });
  assert.deepEqual(plan.unlinkCalls, [], "no unlink after the policy turned off");
  assert.ok(readFileSync(join(fixture.projectDir, "id-a.jsonl"), "utf8").includes("id-a"));
  policy.on = true;

  // Policy turns off only after the trash succeeded: the actual outcome is reported.
  window = await listWindow(view);
  handles = handlesOf(window, entryOf(window, "id-a"));
  await view.remove({ ...handles, confirmed: false }, deleteGuard);
  plan.trash = (file) => {
    unlinkSync(file);
    policy.on = false;
    return 0;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, deleteGuard), { kind: "deleted", method: "trash" });
});

test("the unlink fallback keeps the existing replacement guard and failure truth", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const prepareAndConfirm = async (sessionId: string): Promise<unknown> => {
    const window = await listWindow(view);
    const handles = handlesOf(window, entryOf(window, sessionId));
    assert.deepEqual(await view.remove({ ...handles, confirmed: false }, allow), { kind: "confirmation-required" });
    return view.remove({ ...handles, confirmed: true }, allow);
  };

  // The file is replaced after the trash attempt: the fallback must not unlink it.
  plan.trash = (file) => {
    replaceWithSameContent(file);
    return 1;
  };
  assert.deepEqual(await prepareAndConfirm("id-a"), { kind: "unconfirmed" });
  assert.deepEqual(plan.unlinkCalls, []);
  assert.ok(readFileSync(join(fixture.projectDir, "id-a.jsonl"), "utf8").includes("id-a"), "the replacement survives");

  // Trash failed but the file is still the exact owner file: the existing unlink fallback.
  plan.trash = () => 1;
  assert.deepEqual(await prepareAndConfirm("id-b"), { kind: "deleted", method: "unlink" });
  assert.deepEqual(plan.unlinkCalls, [join(fixture.projectDir, "id-b.jsonl")]);

  // The fallback unlink itself failed after trash: unconfirmed, never refused.
  plan.unlink = () => {
    throw new Error("secret /private/owner/unlink");
  };
  const unlinkFailed = await prepareAndConfirm("id-c");
  assert.deepEqual(unlinkFailed, { kind: "unconfirmed" });
  assert.ok(!JSON.stringify(unlinkFailed).includes("secret"));

  // The guarded primitive itself throws: unknown, and the old authority is retired.
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  await view.remove({ ...handles, confirmed: false }, allow);
  host.deleteThrows = true;
  const thrown = await view.remove({ ...handles, confirmed: true }, allow);
  host.deleteThrows = false;
  assert.deepEqual(thrown, { kind: "unknown" });
  assert.ok(!JSON.stringify(thrown).includes("secret"));
  assert.deepEqual(await view.window(
    { hostRunId: RUN, catalogId: window.catalogId, resultId: window.resultId, offset: 0, count: 1 }, freshSignal(), allow),
  { kind: "refused", reason: "stale" });
});

test("delete keeps the owned-live, unknown-binding, and file guards but not the workspace requirement", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const gone = join(fixture.root, "gone-workspace");
  await mkdir(gone);
  await writeSession(fixture.projectDir, "id-gone", gone, { modified: "2025-01-01T00:00:00.000Z" });
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const prepare = (sessionId: string): Promise<unknown> =>
    view.remove({ ...handlesOf(window, entryOf(window, sessionId)), confirmed: false }, allow);

  host.owned = [{}];
  assert.deepEqual(await prepare("id-a"), { kind: "refused", reason: "active" }, "an UNKNOWN live binding refuses");
  host.owned = [{ kind: "current", id: "other-session", file: entryOf(window, "id-a").file }];
  assert.deepEqual(await prepare("id-a"), { kind: "refused", reason: "active" }, "an owned current file refuses");
  host.owned = [];
  host.validateThrows = true;
  const thrown = await prepare("id-a");
  assert.deepEqual(thrown, { kind: "refused", reason: "active" });
  assert.ok(!JSON.stringify(thrown).includes("secret"));
  host.validateThrows = false;

  replaceWithSameContent(entryOf(window, "id-b").file);
  assert.deepEqual(await prepare("id-b"), { kind: "refused", reason: "admission" }, "a replaced file refuses");

  host.onValidate = () => view.dispose();
  assert.deepEqual(await prepare("id-c"), { kind: "refused", reason: "stale" });
  host.onValidate = undefined;
  assert.equal(plan.deleteCalls, 0, "no preparation path reached the deletion seam");

  // A missing workspace blocks Resume but not Delete, exactly like local validation.
  const second = makeView(host, fixture);
  const listed = await listWindow(second);
  const goneHandles = handlesOf(listed, entryOf(listed, "id-gone"));
  await rm(gone, { recursive: true });
  assert.deepEqual(await second.resume(goneHandles, allow), { kind: "refused", reason: "admission" });
  assert.deepEqual(await second.remove({ ...goneHandles, confirmed: false }, allow), { kind: "confirmation-required" });
  assert.deepEqual(await second.remove({ ...goneHandles, confirmed: true }, allow), { kind: "deleted", method: "trash" });
  assert.equal(host.starts.length, 0);
});

test("dispose clears read and prepared state idempotently", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  assert.deepEqual(await view.remove({ ...handles, confirmed: false }, allow), { kind: "confirmation-required" });
  view.dispose();
  view.dispose();
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, allow), { kind: "refused", reason: "stale" });
  assert.deepEqual(await view.resume(handles, allow), { kind: "refused", reason: "stale" });
  assert.deepEqual(await view.window(
    { hostRunId: RUN, catalogId: window.catalogId, resultId: window.resultId, offset: 0, count: 1 }, freshSignal(), allow),
  { kind: "unavailable" });
  assert.equal(plan.deleteCalls, 0);
  assert.equal(host.starts.length, 0);
});

// ---------------------------------------------------------------- reentrant guards

test("the guarded resume boundary: the final authorization is followed only by native checks and the handoff", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);

  // The guard inside the final authorization replaces the file and answers
  // true: the primitive's native admission after it refuses the replacement.
  const entryB = entryOf(window, "id-b");
  let calls = 0;
  assert.deepEqual(await view.resume(handlesOf(window, entryB), () => {
    calls += 1;
    if (calls === 2) replaceWithSameContent(entryB.file);
    return true;
  }), { kind: "refused", reason: "admission" });
  assert.equal(calls, 2);

  // The guard inside the final authorization establishes an owned live
  // session and answers true: the native duplicate fence after it refuses.
  calls = 0;
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-a")), () => {
    calls += 1;
    if (calls === 2) host.owned = [{ kind: "current", id: "id-a", file: join(fixture.root, "elsewhere.jsonl") }];
    return true;
  }), { kind: "refused", reason: "duplicate" });
  host.owned = [];

  // Code before the final authorization changes the owner run; the bridge's
  // guard re-proves the exact run, so the authorization refuses.
  let probes = 0;
  host.beforeAuthorize = () => {
    probes += 1;
    host.runId = "run-2";
  };
  assert.deepEqual(await view.resume(handlesOf(window, entryOf(window, "id-c")), () => host.runId === RUN),
    { kind: "refused", reason: "admission" });
  host.beforeAuthorize = undefined;
  host.runId = RUN;
  assert.equal(probes, 1);
  assert.equal(host.resumeCalls, 3);
  assert.equal(host.starts.length, 0, "no reentrant change reached the native handoff");
});

test("the guarded delete boundary: each stage's final authorization is followed only by native checks and that stage", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const fileA = join(fixture.projectDir, "id-a.jsonl");
  const fileB = join(fixture.projectDir, "id-b.jsonl");
  const fileC = join(fixture.projectDir, "id-c.jsonl");
  const prepareFor = async (target: OwnerSavedCatalogView, sessionId: string): Promise<ReturnType<typeof handlesOf>> => {
    const window = await listWindow(target);
    const handles = handlesOf(window, entryOf(window, sessionId));
    assert.deepEqual(await target.remove({ ...handles, confirmed: false }, allow), { kind: "confirmation-required" });
    return handles;
  };

  // Trash fails; the fallback stage's guard replaces the file and still answers
  // true. The native validation after that guard keeps the replacement alive.
  let handles = await prepareFor(view, "id-a");
  let armed = false;
  plan.trash = () => {
    armed = true;
    return 1;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, () => {
    if (armed) {
      armed = false;
      replaceWithSameContent(fileA);
    }
    return true;
  }), { kind: "unconfirmed" });
  assert.deepEqual(plan.trashCalls, [fileA]);
  assert.deepEqual(plan.unlinkCalls, [], "the replacement is never unlinked");
  assert.ok(readFileSync(fileA, "utf8").includes("id-a"), "the replacement survives");

  // The first stage's guard establishes an owned live binding and answers true.
  handles = await prepareFor(view, "id-b");
  let guardCalls = 0;
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, () => {
    guardCalls += 1;
    if (guardCalls === 2) host.owned = [{ kind: "current", id: "other-session", file: fileB }];
    return true;
  }), { kind: "refused", reason: "active" });
  host.owned = [];
  assert.equal(plan.trashCalls.length, 1, "refused before trash");

  // Code before the first stage's final authorization changes the owner run;
  // the bridge's guard re-proves the exact run, so the authorization refuses.
  handles = await prepareFor(view, "id-b");
  let probes = 0;
  host.beforeAuthorize = () => {
    probes += 1;
    host.runId = "run-2";
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, () => host.runId === RUN),
    { kind: "refused", reason: "policy" });
  host.beforeAuthorize = undefined;
  host.runId = RUN;
  assert.equal(probes, 1);
  assert.equal(plan.trashCalls.length, 1, "refused before trash");

  // Code before the first stage's final authorization retires the view: the
  // authorization's in-memory checks refuse.
  const second = makeView(host, fixture);
  const secondHandles = await prepareFor(second, "id-c");
  host.beforeAuthorize = () => second.dispose();
  assert.deepEqual(await second.remove({ ...secondHandles, confirmed: true }, allow), { kind: "refused", reason: "stale" });
  host.beforeAuthorize = undefined;
  assert.equal(plan.trashCalls.length, 1, "refused before trash");

  // A preparation whose re-proof guard replaces the file is refused.
  const third = makeView(host, fixture);
  const listed = await listWindow(third);
  guardCalls = 0;
  assert.deepEqual(await third.remove({ ...handlesOf(listed, entryOf(listed, "id-c")), confirmed: false }, () => {
    guardCalls += 1;
    if (guardCalls === 2) replaceWithSameContent(fileC);
    return true;
  }), { kind: "refused", reason: "admission" });
  assert.deepEqual(plan.unlinkCalls, []);
  assert.ok(readFileSync(fileB, "utf8").includes("id-b"));
  assert.ok(readFileSync(fileC, "utf8").includes("id-c"));
});

test("a delete accepted before a later retirement is reported truthfully", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  let window = await listWindow(view);
  let handles = handlesOf(window, entryOf(window, "id-a"));
  await view.remove({ ...handles, confirmed: false }, allow);
  // The view is retired DURING a trash that succeeds: the completed deletion stands.
  plan.trash = (file) => {
    view.dispose();
    unlinkSync(file);
    return 0;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, allow), { kind: "deleted", method: "trash" });

  // The view is retired DURING a trash that fails: the fallback's authorization
  // refuses, so trash was invoked and the outcome is unconfirmed, never refused.
  const second = makeView(host, fixture);
  window = await listWindow(second);
  handles = handlesOf(window, entryOf(window, "id-b"));
  await second.remove({ ...handles, confirmed: false }, allow);
  plan.trash = () => {
    second.dispose();
    return 1;
  };
  assert.deepEqual(await second.remove({ ...handles, confirmed: true }, allow), { kind: "unconfirmed" });
  assert.deepEqual(plan.unlinkCalls, [], "no unlink after the retirement");
  assert.ok(readFileSync(join(fixture.projectDir, "id-b.jsonl"), "utf8").includes("id-b"));
});

// Mutation-boundary regressions (review pass 2). A reentrant callback that runs
// BEFORE the primitive's final authorization revokes the authority; the
// authorization then refuses, and nothing is trashed, unlinked, or started.

test("policy revoked by the final native validation prevents trash", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  let authorized = true;
  const guard: OwnerSavedAuthorizationGuard = () => authorized;
  assert.deepEqual(await view.remove({ ...handles, confirmed: false }, guard),
    { kind: "confirmation-required" });
  let fired = 0;
  host.beforeAuthorize = (operation, stage) => {
    assert.equal(operation, "delete");
    assert.equal(stage, 1);
    fired += 1;
    authorized = false;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, guard),
    { kind: "refused", reason: "policy" });
  host.beforeAuthorize = undefined;
  assert.equal(fired, 1, "the reentrant callback fired exactly once");
  assert.equal(plan.deleteCalls, 1);
  assert.deepEqual(plan.trashCalls, []);
  assert.deepEqual(plan.unlinkCalls, []);
  assert.ok(readFileSync(join(fixture.projectDir, "id-a.jsonl"), "utf8").includes("id-a"));
});

test("authorization revoked by the final native admission prevents the native start", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  let authorized = true;
  const guard: OwnerSavedAuthorizationGuard = () => authorized;
  let fired = 0;
  host.beforeAuthorize = (operation) => {
    assert.equal(operation, "resume");
    fired += 1;
    authorized = false;
  };
  assert.deepEqual(await view.resume(handles, guard), { kind: "refused", reason: "admission" });
  host.beforeAuthorize = undefined;
  assert.equal(fired, 1, "the reentrant callback fired exactly once");
  assert.equal(host.resumeCalls, 1);
  assert.equal(host.starts.length, 0);
});

test("policy revoked by the final preparation validator stores no preparation", async (t) => {
  const fixture = await makeFixture(t);
  await seedThree(fixture);
  const host = new FakeHost();
  const plan = host.plan;
  const view = makeView(host, fixture);
  const window = await listWindow(view);
  const handles = handlesOf(window, entryOf(window, "id-a"));
  let authorized = true;
  const guard: OwnerSavedAuthorizationGuard = () => authorized;
  // The preparation's LAST native validation revokes authority and still
  // reports a passing validation.
  let validations = 0;
  host.onValidate = () => {
    validations += 1;
    if (validations === 2) authorized = false;
  };
  assert.deepEqual(await view.remove({ ...handles, confirmed: false }, guard), { kind: "refused", reason: "policy" });
  host.onValidate = undefined;
  assert.equal(validations, 2, "both preparation validations ran, the second one revoking");
  assert.equal(plan.deleteCalls, 0, "preparation never mutates");

  // Policy back on: nothing was prepared, so a confirmation stays stale until a
  // fresh, fully authorized preparation.
  authorized = true;
  assert.deepEqual(await view.remove({ ...handles, confirmed: true }, guard), { kind: "refused", reason: "stale" });
  assert.equal(plan.deleteCalls, 0);
  assert.deepEqual(plan.trashCalls, []);
  assert.deepEqual(plan.unlinkCalls, []);
  assert.ok(readFileSync(join(fixture.projectDir, "id-a.jsonl"), "utf8").includes("id-a"));
});
