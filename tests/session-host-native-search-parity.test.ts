/**
 * Issue #603: the saved-conversation catalog search follows Pi 1.5's native
 * `/resume` matcher exactly.
 *
 * The native module is loaded here REFERENCE-ONLY (it is a private native
 * path; production resolves only the official package's public SDK entry and
 * its own adapted matcher). Coverage:
 *
 * - The shared query grammar agrees with the native parser for every query
 *   shape, including quoted phrases, unbalanced quotes, `re:` patterns, and
 *   invalid/empty patterns.
 * - The per-field matcher agrees with native `matchSession` match-for-match
 *   and score-for-score on synthetic fields: ids and message text match only
 *   as exact substrings, names and working directories still match fuzzily,
 *   and no token, phrase, or regular expression crosses a field boundary.
 * - Tiers rank an exact name hit above every other exact hit and above every
 *   fuzzy hit; per-token scores sum, and each token takes its best field.
 * - End to end through the REAL public SDK listing, the branded catalog's
 *   match set and relevance order equal native `filterAndSortSessions` in
 *   relevance mode (ties keep modification-time-descending order), while the
 *   full name and complete message text stay private indexed state and every
 *   result is the exact minted row.
 * - The pinned TUI's fuzzy scorer is the scorer of the Pi release being
 *   matched, so the parity is real rather than an approximation.
 */

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fuzzyMatch as pinnedFuzzyMatch } from "pi-session-host-tui";
import { listSavedSessions, searchSavedSessions } from "../src/session-host/saved-sessions";
import {
  matchSavedSessionFields,
  parseSavedSearchQuery,
  type SavedSessionSearchFields,
} from "../src/session-host/saved-search";
import { resolveNativeSessionSdk, type NativeSessionSdkInfo } from "../src/session-host/native-session-sdk";
import { skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/** The exact Pi release whose native session matcher the catalog follows. */
const PI_SEARCH_VERSION = "1.5.1";

/** One native selector session, in the public SDK `SessionInfo` shape. */
interface NativeSearchSession {
  id: string;
  name?: string;
  allMessagesText: string;
  cwd: string;
  modified: Date;
}

/** The private native selector search module (reference-only in tests). */
interface NativeSearchModule {
  parseSearchQuery(query: string): unknown;
  matchSession(session: NativeSearchSession, parsed: unknown): { matches: boolean; score: number };
  filterAndSortSessions<T extends NativeSearchSession>(
    sessions: readonly T[],
    query: string,
    sortMode: "relevance",
  ): T[];
}

/** One public SDK row of a synthetic saved conversation (SessionInfo shape). */
interface SdkSearchRow extends NativeSessionSdkInfo {
  allMessagesText: string;
  modified: Date;
}

/**
 * The installed Pi package used as the native search reference: the pinned
 * runtime when one is requested, otherwise an ambient install declaring
 * exactly {@link PI_SEARCH_VERSION}.
 */
function findReferenceAgentDir(): string | undefined {
  return findInstalledAgentDirs().find((path) => {
    try {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      return manifest.name === "@earendil-works/pi-coding-agent" && manifest.version === PI_SEARCH_VERSION;
    } catch {
      return false;
    }
  });
}

function loadNativeSearch(t: { skip(message?: string): void }): NativeSearchModule | undefined {
  const agentPackage = findReferenceAgentDir();
  if (!agentPackage) {
    skipOrFail(t, `no installed Pi ${PI_SEARCH_VERSION} for saved search parity`);
    return undefined;
  }
  return createRequire(join(agentPackage, "package.json"))(
    join(agentPackage, "dist", "modes", "interactive", "components", "session-selector-search.js"),
  ) as NativeSearchModule;
}

/** The same fields the private catalog index holds for one SDK row. */
function fieldsOf(session: NativeSearchSession): SavedSessionSearchFields {
  return {
    id: session.id,
    name: session.name ?? "",
    messages: session.allMessagesText ?? "",
    cwd: session.cwd,
  };
}

/** Every query shape the grammar has to parse identically to native. */
const GRAMMAR_QUERIES = [
  "", " \t ", "d", "node", "nd cv", "  NoDe\tCvE  ", '"node cve"', '"NODE   CVE"',
  'node "deployment token"', '""', 'node"cve"', '"node cve', 'node "', '"a" "b"',
  "re:node.*cve", "re:NODE[\\s\\S]*CVE", "re:^id-hit", "re:workspace-beta$",
  "re:FullNameTail", "FullNameTail", "assistant-marker", "workspace-alpha", "repair warnings",
  "re:", "re:   ", "re:[", "re:(", "RE:node", "re:.*", "re:(?<x>a)(?<x>b)",
];

test("the saved-catalog matcher matches and scores exactly like Pi 1.5 native matchSession", (t) => {
  const native = loadNativeSearch(t);
  if (!native) return;

  // Grammar parity: identical parse for every query shape.
  for (const query of GRAMMAR_QUERIES) {
    assert.deepEqual(
      parseSavedSearchQuery(query),
      native.parseSearchQuery(query) as ReturnType<typeof parseSavedSearchQuery>,
      `parse ${JSON.stringify(query)}`,
    );
  }

  const messageOnly: NativeSearchSession = {
    id: "a1b2c3",
    name: "",
    allMessagesText: "another deployment token for the rollout",
    cwd: "/srv/app",
    modified: new Date(Date.UTC(2025, 0, 1)),
  };
  const boundaries: NativeSearchSession = {
    id: "idprefix",
    name: "namesuffix",
    allMessagesText: "messagesend",
    cwd: "/cwdstart",
    modified: new Date(Date.UTC(2025, 0, 2)),
  };
  const nameLiteral: NativeSearchSession = {
    id: "zz-1", name: "Rollout plan", allMessagesText: "unrelated", cwd: "/srv/one",
    modified: new Date(Date.UTC(2025, 0, 3)),
  };
  const textLiteral: NativeSearchSession = {
    id: "zz-2", name: "Weekly", allMessagesText: "the rollout notes", cwd: "/srv/two",
    modified: new Date(Date.UTC(2025, 0, 4)),
  };
  const fuzzyOnly: NativeSearchSession = {
    id: "zz-3", name: "royal oil", allMessagesText: "unrelated", cwd: "/srv/three",
    modified: new Date(Date.UTC(2025, 0, 5)),
  };
  const whitespaceName: NativeSearchSession = {
    id: "zz-4", name: "Long   name\n  tail", allMessagesText: "", cwd: "/srv/four",
    modified: new Date(Date.UTC(2025, 0, 6)),
  };
  const sessions = [messageOnly, boundaries, nameLiteral, textLiteral, fuzzyOnly, whitespaceName];

  const semanticQueries = [
    // Message text and ids match only as exact substrings (the Pi 1.5 fix):
    // scattered letters in them are noise, not a match.
    "dpl", "deploy", "abc", "b2c", "depn", "rolout", "a1b2", "token rollout",
    // Names and working directories still match fuzzily.
    "sap", "rlp", "clry", "o e",
    // Tokens may match different fields; one token never crosses a boundary.
    "idprefix namesuffix", "idprefix messagesend", "prefixnames", "endcwd", "prefixname",
    "messagesend cwdstart", "idprefixname",
    // Phrases are exact and whitespace-normalized, per field.
    '"deployment token for"', '"rollout /srv"', '"another deployment"',
    '"LONG   name tail"', '"name tail"', '"messagesend /cwdstart"',
    // Regular expressions never span a field boundary.
    "re:prefix\\s*names", "re:end\\s*/?cwd", "re:^idprefix$", "re:messagesend$",
    "re:DEPLOYMENT", "re:.*", "re:zz-\\d", "re:^/srv/",
    // AND across tiers: each token scores its own best field, and the tiers sum.
    "roll deploy", "rollout token", "clry unrelated", "roll corollary",
  ];

  for (const query of semanticQueries) {
    const parsed = parseSavedSearchQuery(query);
    for (const session of sessions) {
      const actual = matchSavedSessionFields(fieldsOf(session), parsed);
      const expected = native.matchSession(session, native.parseSearchQuery(query));
      assert.deepEqual(actual, expected, `query ${JSON.stringify(query)} on ${session.id}`);
    }
  }

  // The documented behavior change, stated directly rather than only as a
  // diff against native: a message-only word is reachable exactly, not
  // fuzzily, and an id is reachable exactly, not by scattered letters.
  const query = (session: NativeSearchSession, text: string): { matches: boolean; score: number } =>
    matchSavedSessionFields(fieldsOf(session), parseSavedSearchQuery(text));
  assert.deepEqual(query(messageOnly, "dpl"), { matches: false, score: 0 }, "dpl cannot scatter through message text");
  assert.equal(query(messageOnly, "deploy").matches, true, "deploy matches the message word exactly");
  assert.deepEqual(query(messageOnly, "abc"), { matches: false, score: 0 }, "abc cannot scatter through a session id");
  assert.equal(query(messageOnly, "b2c").matches, true, "b2c matches the id as an exact substring");
  assert.deepEqual(query(boundaries, "prefixnames"), { matches: false, score: 0 }, "a token cannot span id→name");
  assert.deepEqual(query(boundaries, "endcwd"), { matches: false, score: 0 }, "a token cannot span messages→cwd");
  assert.deepEqual(query(boundaries, "re:end\\s*/?cwd"), { matches: false, score: 0 }, "a regex cannot span messages→cwd");
  assert.equal(query(boundaries, "idprefix messagesend").matches, true, "different tokens may match different fields");
  assert.deepEqual(query(messageOnly, '"rollout /srv"'), { matches: false, score: 0 }, "a phrase cannot span messages→cwd");

  // Tiers: an exact name hit outranks every other exact hit and every fuzzy
  // hit; an exact non-name hit outranks a scattered name/cwd match.
  const rollScores = sessions.map((session) => ({ id: session.id, ...query(session, "roll") }));
  assert.deepEqual(
    rollScores.filter((entry) => entry.matches).sort((left, right) => left.score - right.score).map((entry) => entry.id),
    ["zz-1", "a1b2c3", "zz-2", "zz-3"],
    "name literal, then exact text/id/cwd, then fuzzy name/cwd",
  );
  assert.ok(
    rollScores.find((entry) => entry.id === "zz-3")!.score > 1_000_000,
    "a fuzzy name match is dominated by its tier, not by its fuzzy score",
  );
  assert.deepEqual(
    ["zz-1", "zz-2", "zz-3"].map((id) => query(sessions.find((s) => s.id === id)!, "roll").score),
    ["zz-1", "zz-2", "zz-3"].map((id) => native.matchSession(sessions.find((s) => s.id === id)!, native.parseSearchQuery("roll")).score),
    "tier scores equal native tier scores",
  );
});

test("native saved search reads synthetic global files through the public SDK and matches Pi 1.5 /resume", async (t) => {
  const native = loadNativeSearch(t);
  if (!native) return;
  const agentPackage = findReferenceAgentDir()!;
  const piExecutable = join(agentPackage, "dist", "cli.js");
  const sdk = resolveNativeSessionSdk(piExecutable, { expectedPiVersion: PI_SEARCH_VERSION });

  // Every file and directory below is created exclusively by this test.
  // Cleanup checks individual creation identities, never recursively scans,
  // and preserves unknown/replaced entries instead of cleaning a temp prefix.
  const root = realpathSync(mkdtempSync(join(process.cwd(), "node_modules", ".native-search-parity-")));
  const files: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  const directories: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  const rememberDirectory = (path: string): string => {
    const stat = lstatSync(path, { bigint: true });
    directories.push({ path, dev: stat.dev, ino: stat.ino });
    return path;
  };
  rememberDirectory(root);
  const directory = (path: string): string => { mkdirSync(path, { mode: 0o700 }); return rememberDirectory(path); };
  const sameIdentity = (entry: { path: string; dev: bigint; ino: bigint }, kind: "file" | "directory"): boolean => {
    try {
      const stat = lstatSync(entry.path, { bigint: true });
      return !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : stat.isDirectory())
        && stat.dev === entry.dev && stat.ino === entry.ino;
    } catch { return false; }
  };
  t.after(() => {
    for (const entry of files) if (sameIdentity(entry, "file")) unlinkSync(entry.path);
    for (const entry of [...directories].reverse()) {
      if (!sameIdentity(entry, "directory")) continue;
      try { rmdirSync(entry.path); } catch { /* Unknown contents remain untouched. */ }
    }
  });
  const agentDir = directory(join(root, "agent"));
  const sessionsRoot = directory(join(agentDir, "sessions"));
  const workspaces = [directory(join(root, "workspace-alpha")), directory(join(root, "workspace-beta"))];
  const projects = [directory(join(sessionsRoot, "--alpha--")), directory(join(sessionsRoot, "--beta--"))];
  // Long literal phrases cannot accidentally match an ambient checkout path.
  // Short unquoted tokens still exercise native fuzzy matches across all fields.
  const fullNativeName = `${"Long name ".repeat(40)}FullNameTail`;
  const assistantText = `${"assistant-marker ".repeat(20)}SdkMessageTail`;
  const fullNameQuery = `"${fullNativeName}"`;
  const assistantQuery = `"${assistantText}"`;
  const entries = [
    { id: "id-hit-older", name: "node CVE triage", text: "repair dependency warnings", workspace: 0, age: 1 },
    { id: "message-only", name: "Rollout", text: "Investigate NODE\n   cve; another deployment token", workspace: 1, age: 4 },
    { id: "quoted-literal", name: "Search", text: 'The literal "node cve is unbalanced in this example', workspace: 0, age: 3 },
    { id: "name-tail", name: fullNativeName, text: assistantText, workspace: 1, age: 2 },
    { id: "tie-newer", name: "Rollout", text: "repair dependency warnings", workspace: 1, age: 5 },
    { id: "a1b2c3d4", name: "Weekly sync", text: "planning the sprint review", workspace: 0, age: 6 },
  ];
  for (const entry of entries) {
    const timestamp = new Date(Date.UTC(2025, 0, entry.age)).toISOString();
    const path = join(projects[entry.workspace]!, `${entry.id}.jsonl`);
    const lines = [
      { type: "session", version: 3, id: entry.id, cwd: workspaces[entry.workspace], timestamp },
      { type: "session_info", id: "name", parentId: null, name: entry.name, timestamp },
      { type: "message", id: "user", parentId: "name", timestamp,
        message: { role: "user", content: "synthetic first prompt", timestamp: Date.parse(timestamp) } },
      { type: "message", id: "assistant", parentId: "user", timestamp,
        message: { role: "assistant", content: [{ type: "text", text: entry.text }], timestamp: Date.parse(timestamp) } },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
    const stat = lstatSync(path, { bigint: true });
    files.push({ path, dev: stat.dev, ino: stat.ino });
  }
  const nativeInfos = (await Promise.all(
    projects.map((project) => sdk.SessionManager.listAll(project) as Promise<SdkSearchRow[]>),
  ));
  const catalog = await listSavedSessions({ agentDir, piExecutable, expectedPiVersion: PI_SEARCH_VERSION });
  assert.equal(catalog.issueCount, 0);
  assert.equal(catalog.rows.length, entries.length);
  assert.equal(new Set(catalog.rows.map((row) => row.cwd)).size, 2, "production catalog is global across recorded workspaces");
  const infosByFile = new Map<string, SdkSearchRow>(
    nativeInfos.flat().map((info) => [realpathSync(info.path), info] as [string, SdkSearchRow]),
  );
  const nativeInput = catalog.rows.map((row) => infosByFile.get(row.file)!);
  assert.equal(nativeInput.length, entries.length, "every catalog row resolves to its public SDK row");

  const queries = [
    ...GRAMMAR_QUERIES,
    fullNameQuery, assistantQuery,
    // Pi 1.5 semantics: exact-only in ids and message text, fuzzy in names and
    // working directories, and never across a field boundary.
    "dpl", "deploy", "abc", "b2c", "b2c3", "a1b2c3d4", "re:a1b2c3d4$",
    "re:triage repair", "re:older node", "re:SdkMessageTail[\\s\\S]*workspace",
    "triage repair", "rollout", "roll deploy", "Weekly review", '"sprint review"',
    '"node cve" triage', "re:Long name", "sync planning",
  ];
  for (const query of queries) {
    const actual = searchSavedSessions(catalog, query);
    const expected: SdkSearchRow[] = native.filterAndSortSessions(nativeInput, query, "relevance");
    assert.deepEqual(actual.map((row) => row.file), expected.map((info) => realpathSync(info.path)), `query ${JSON.stringify(query)}`);
    for (const row of actual) assert.ok(catalog.rows.includes(row), "matching retains exact admitted row references");
    // The same fields must score identically to native, not merely order alike.
    const parsed = parseSavedSearchQuery(query);
    for (const info of expected) {
      assert.deepEqual(
        matchSavedSessionFields(fieldsOf(info), parsed),
        native.matchSession(info, native.parseSearchQuery(query)),
        `score for ${JSON.stringify(query)} on ${info.id}`,
      );
    }
  }

  const fullTextFile = realpathSync(join(projects[1]!, "name-tail.jsonl"));
  assert.deepEqual(searchSavedSessions(catalog, fullNameQuery).map((row) => row.file), [fullTextFile],
    "the full native name, including its tail beyond the caption limit, matches the exact saved file");
  assert.deepEqual(searchSavedSessions(catalog, assistantQuery).map((row) => row.file), [fullTextFile],
    "the complete native assistant text is indexed through the real public SDK and matches the exact saved file");
  assert.equal(JSON.stringify(catalog).includes("assistant-marker"), false, "message-only match text never becomes a public row field");
  assert.equal(JSON.stringify(catalog).includes("FullNameTail"), false, "the full name beyond the caption limit never becomes a public row field");

  // Modification-time ties keep the native relevance tie-break: the two rows
  // named "Rollout" score the same, so the newer one leads. Every row's
  // recorded working directory is an absolute path inside this run's scratch
  // root, and that path can itself fuzzy-match the token, so other rows can
  // legitimately join the result. The full ordered result still has to equal
  // native's, and both named rows must actually be present for their relative
  // order to prove anything (an absent row would index as -1).
  const tieQuery = "Rollout";
  const tied = searchSavedSessions(catalog, tieQuery);
  const expectedTied = native.filterAndSortSessions(nativeInput, tieQuery, "relevance");
  const tieOrder = tied.map((row) => row.id);
  assert.deepEqual(tieOrder, expectedTied.map((info) => info.id), `query ${JSON.stringify(tieQuery)}`);
  const [newerAt, olderAt] = ["tie-newer", "message-only"].map((id) => tieOrder.indexOf(id));
  assert.ok(newerAt >= 0 && olderAt >= 0, "both rows named Rollout are in the results");
  assert.ok(newerAt < olderAt, "ties rank by modified descending, as native does");
  // The two rows genuinely score the same, so their relative order really is
  // the modification-time tie-break and not a score difference.
  const parsedTie = parseSavedSearchQuery(tieQuery);
  const tieScores = ["tie-newer", "message-only"].map((id) =>
    matchSavedSessionFields(fieldsOf(nativeInput.find((info) => info.id === id)!), parsedTie));
  assert.deepEqual(tieScores[0], tieScores[1], "the two rows named Rollout score the same");
});

test("the pinned TUI fuzzy scorer is the scorer of the Pi release being matched", (t) => {
  const agentPackage = findReferenceAgentDir();
  if (!agentPackage) {
    skipOrFail(t, `no installed Pi ${PI_SEARCH_VERSION} for the fuzzy scorer comparison`);
    return;
  }
  const nativeTui = createRequire(join(agentPackage, "package.json"))("@earendil-works/pi-tui") as {
    fuzzyMatch?: (query: string, text: string) => { matches: boolean; score: number };
  };
  assert.equal(typeof nativeTui.fuzzyMatch, "function", "the reference package exposes its own fuzzy matcher");
  const probes: Array<[string, string]> = [
    ["b3", "mcp__beta__read_3"], ["b3", "mcp__beta__read_13"], ["rd", "mcp__gamma__read_2"],
    ["roll", "corollary"], ["roll", "Rollout plan"], ["opus", "openrouter openrouter/anthropic/claude-opus"],
    ["dpl", "another deployment token"], ["sap", "/srv/app"], ["ünïcødé", "Beta ünïcødé 🚀"],
    ["clry", "corollary"], ["", "empty query"], ["exact", "exact"],
  ];
  for (const [query, text] of probes) {
    assert.deepEqual(
      pinnedFuzzyMatch(query, text),
      nativeTui.fuzzyMatch!(query, text),
      `the pinned pi-session-host-tui fuzzy score must equal the ${PI_SEARCH_VERSION} scorer for ${JSON.stringify(query)} in ${JSON.stringify(text)}`,
    );
  }
});
