import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { listSavedSessions, searchSavedSessions } from "../src/session-host/saved-sessions";
import { resolveNativeSessionSdk, type NativeSessionSdkInfo } from "../src/session-host/native-session-sdk";
import { skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

interface SearchSession extends NativeSessionSdkInfo {
  allMessagesText: string;
  modified: Date;
}
interface NativeSearch {
  filterAndSortSessions(sessions: SearchSession[], query: string, sortMode: "relevance"): SearchSession[];
}

test("native saved search reads synthetic global files through the public SDK and matches /resume", async (t) => {
  const agentPackage = findInstalledAgentDirs().find((path) => {
    try {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      return manifest.name === "@earendil-works/pi-coding-agent" && manifest.version === "1.1.0";
    } catch { return false; }
  });
  if (!agentPackage) {
    skipOrFail(t, "no installed Pi 1.1.0 for global saved search parity");
    return;
  }
  // Private imports are reference-only in tests; production resolves only the
  // official CLI's public SDK entry and the pinned public TUI fuzzy matcher.
  const nativeSearch = createRequire(join(agentPackage, "package.json"))(
    join(agentPackage, "dist", "modes", "interactive", "components", "session-selector-search.js"),
  ) as NativeSearch;
  const piExecutable = join(agentPackage, "dist", "cli.js");
  const sdk = resolveNativeSessionSdk(piExecutable, { expectedPiVersion: "1.1.0" });

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
  const entries = [
    { id: "id-hit-older", name: "node CVE triage", text: "repair dependency warnings", workspace: 0, age: 1 },
    { id: "message-only", name: "Rollout", text: "Investigate NODE\n   cve; another deployment token", workspace: 1, age: 4 },
    { id: "quoted-literal", name: "Search", text: 'The literal "node cve is unbalanced in this example', workspace: 0, age: 3 },
    { id: "name-tail", name: `${"Long name ".repeat(40)}FullNameTail`, text: "assistant-marker", workspace: 1, age: 2 },
    { id: "tie-newer", name: "Rollout", text: "repair dependency warnings", workspace: 1, age: 5 },
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
  const nativeInfos = (await Promise.all(projects.map((project) => sdk.SessionManager.listAll(project)))).flat() as SearchSession[];
  const catalog = await listSavedSessions({ agentDir, piExecutable, expectedPiVersion: "1.1.0" });
  assert.equal(catalog.issueCount, 0);
  assert.equal(catalog.rows.length, entries.length);
  assert.equal(new Set(catalog.rows.map((row) => row.cwd)).size, 2, "production catalog is global across recorded workspaces");
  const infosByFile = new Map(nativeInfos.map((info) => [realpathSync(info.path), info]));
  const nativeInput = catalog.rows.map((row) => infosByFile.get(row.file)!);
  const queries = [
    "", " \t ", "d", "node", "nd cv", "  NoDe\tCvE  ", '"node cve"', '"NODE   CVE"',
    'node "deployment token"', '""', 'node"cve"', '"node cve', 'node "',
    "re:node.*cve", "re:NODE[\\s\\S]*CVE", "re:^id-hit", "re:workspace-beta$",
    "re:FullNameTail", "FullNameTail", "assistant-marker", "workspace-alpha", "repair warnings",
    "re:", "re:   ", "re:[", "re:(", "RE:node", "re:.*",
  ];
  for (const query of queries) {
    const actual = searchSavedSessions(catalog, query);
    const expected = nativeSearch.filterAndSortSessions(nativeInput, query, "relevance");
    assert.deepEqual(actual.map((row) => row.file), expected.map((info) => realpathSync(info.path)), `query ${JSON.stringify(query)}`);
    for (const row of actual) assert.ok(catalog.rows.includes(row), "matching retains exact admitted row references");
  }
  assert.equal(searchSavedSessions(catalog, "FullNameTail").length, 1, "full native name remains searchable beyond caption limit");
  assert.equal(searchSavedSessions(catalog, "assistant-marker").length, 1, "native assistant text is indexed through the real public SDK");
  assert.equal(JSON.stringify(catalog).includes("assistant-marker"), false, "message-only match text never becomes a public row field");
});
