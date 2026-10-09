import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piAgentDir } from "../src/config-path";
import {
  HOST_OWNERSHIP_FILENAME,
  HOST_STATE_DIRNAME,
  MAX_ROSTER_ENTRIES,
  ROSTER_FILENAME,
  ROSTER_STORE_VERSION,
  hostOwnershipPath,
  isValidRosterName,
  openHostState,
  parseStoredRoster,
  readRosterStore,
  rosterStorePath,
  sessionHostStateDir,
  writeRosterStore,
  type StoredRoster,
} from "../src/session-host/roster-store";

/**
 * Focused hermetic tests for the global session-host roster store (#331). Every
 * fixture root is created fresh under node_modules/.cache and verified before
 * removal; nothing here touches a real user Pi agent directory.
 */

const SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-roster-store-tests");

function makeRoot(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
}

function rosterOf(entries: { slotId: string; sessionId: string; workspace: string; name?: string }[]): StoredRoster {
  return {
    version: ROSTER_STORE_VERSION,
    entries: entries.map((entry) => ({
      slotId: entry.slotId,
      sessionId: entry.sessionId,
      workspace: entry.workspace,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
    })),
  };
}

test("the store lives under the canonical Pi agent directory resolved from PI_CODING_AGENT_DIR, not the launch cwd", () => {
  const override = join(tmpdir(), "prg-agent-override");
  const agentDir = piAgentDir({ PI_CODING_AGENT_DIR: override });
  assert.equal(agentDir, override);
  assert.equal(sessionHostStateDir(agentDir), join(override, HOST_STATE_DIRNAME));
  assert.equal(rosterStorePath(agentDir), join(override, HOST_STATE_DIRNAME, ROSTER_FILENAME));
  assert.equal(hostOwnershipPath(agentDir), join(override, HOST_STATE_DIRNAME, HOST_OWNERSHIP_FILENAME));
  // The default (no override) is Pi's ordinary agent directory, never the cwd.
  const fallback = piAgentDir({ HOME: "/synthetic-home" }, { homeDir: "/synthetic-home", platform: "linux" });
  assert.equal(fallback, join("/synthetic-home", ".pi", "agent"));
  assert.notEqual(rosterStorePath(fallback).startsWith(process.cwd()), true);
});

test("parseStoredRoster accepts a bounded ordered roster and refuses every malformed variant", () => {
  const valid = {
    version: ROSTER_STORE_VERSION,
    entries: [
      { slotId: "slot-a", sessionId: "conv-a", workspace: "/ws/a", name: "Alpha", persistence: "saved" },
      { slotId: "slot-b", sessionId: "conv-b", workspace: "/ws/b" },
    ],
    activeSlotId: "slot-b",
  };
  assert.deepEqual(parseStoredRoster(valid), valid);

  const rejected: unknown[] = [
    null,
    [],
    { ...valid, version: 999 },
    { ...valid, entries: "not-an-array" },
    { ...valid, entries: [{ slotId: "slot-a", sessionId: "", workspace: "/ws/a" }] },
    { ...valid, entries: [{ slotId: "slot-a", sessionId: "conv-a", workspace: "" }] },
    { ...valid, entries: [{ slotId: "slot-a", sessionId: "conv-a", workspace: "/ws/a", persistence: "maybe" }] },
    { ...valid, entries: [{ slotId: "slot-a", sessionId: "conv-a", workspace: "/ws/a" }, { slotId: "slot-a", sessionId: "conv-b", workspace: "/ws/b" }] },
    { ...valid, activeSlotId: "slot-missing" },
    { ...valid, entries: Array.from({ length: MAX_ROSTER_ENTRIES + 1 }, (_unused, index) => ({ slotId: `slot-${index}`, sessionId: `conv-${index}`, workspace: "/ws" })) },
  ];
  for (const value of rejected) {
    assert.equal(parseStoredRoster(value), undefined, JSON.stringify(value)?.slice(0, 120));
  }
});

test("roster publication is atomic and a missing roster is honestly absent", () => {
  const root = makeRoot("round-trip");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    assert.deepEqual(readRosterStore(agentDir), { status: "absent" });
    const roster = rosterOf([
      { slotId: "slot-a", sessionId: "conv-a", workspace: join(root, "ws-a"), name: "Alpha" },
    ]);
    writeRosterStore(agentDir, roster);
    const read = readRosterStore(agentDir);
    assert.equal(read.status, "loaded");
    assert.deepEqual(read.status === "loaded" ? read.roster : undefined, roster);
    const written = readFileSync(rosterStorePath(agentDir), "utf8");
    assert.ok(written.endsWith("\n"));
    assert.equal(written, `${JSON.stringify(roster)}\n`);
    // Atomic publication leaves no owned temporary files behind.
    const stateFiles = readdirSync(sessionHostStateDir(agentDir));
    assert.deepEqual(stateFiles.sort(), [ROSTER_FILENAME]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, oversized, unsafe, and non-regular rosters are reported truthfully and never overwritten", () => {
  const root = makeRoot("unsafe");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const stateDir = join(agentDir, HOST_STATE_DIRNAME);
  mkdirSync(stateDir);
  const path = rosterStorePath(agentDir);
  try {
    writeFileSync(path, "{not json", "utf8");
    const malformed = readRosterStore(agentDir);
    assert.equal(malformed.status, "unavailable");
    assert.match(malformed.status === "unavailable" ? malformed.reason : "", /left untouched/);

    const opened = openHostState({ agentDir, hostId: "host-1" });
    assert.equal(opened.status, "opened");
    if (opened.status !== "opened") return;
    // A damaged store disables persistence: the bytes are never overwritten.
    assert.ok(opened.state.problem);
    assert.equal(opened.state.roster, undefined);
    assert.equal(opened.state.persist(rosterOf([{ slotId: "slot-a", sessionId: "conv-a", workspace: root }])), false);
    assert.equal(readFileSync(path, "utf8"), "{not json");
    assert.equal(opened.state.release(), true);

    writeFileSync(path, JSON.stringify({ version: ROSTER_STORE_VERSION, entries: [], padding: "x".repeat(70 * 1024) }), "utf8");
    const oversized = readRosterStore(agentDir);
    assert.equal(oversized.status, "unavailable");
    assert.match(oversized.status === "unavailable" ? oversized.reason : "", /exceeds/);

    rmSync(path, { force: true });
    try {
      symlinkSync(join(root, "elsewhere.json"), path);
    } catch {
      return; // platforms without symlink support are covered by the other cases
    }
    const symlinked = readRosterStore(agentDir);
    assert.equal(symlinked.status, "unavailable");
    assert.equal(lstatSync(path).isSymbolicLink(), true, "the symlinked entry is preserved, never followed or removed");
    // Publication never silently replaces a foreign/special entry either.
    assert.throws(() => writeRosterStore(agentDir, rosterOf([{ slotId: "slot-a", sessionId: "conv-a", workspace: root }])));
    assert.equal(lstatSync(path).isSymbolicLink(), true, "a refused publication leaves the foreign entry untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive ownership refuses a second host, never steals a foreign record, and is released only by its own holder", () => {
  const root = makeRoot("ownership");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    const first = openHostState({ agentDir, hostId: "host-1" });
    assert.equal(first.status, "opened");
    if (first.status !== "opened") return;

    const second = openHostState({ agentDir, hostId: "host-2" });
    assert.equal(second.status, "refused");
    assert.match(second.status === "refused" ? second.message : "", /another session host already owns/);
    assert.match(second.status === "refused" ? second.message : "", new RegExp(HOST_OWNERSHIP_FILENAME));

    // A foreign record is never removed by a different host id.
    const foreign = { version: 1, hostId: "host-foreign", pid: 1, agentDir, startedAt: "2025-01-01T00:00:00.000Z" };
    writeFileSync(hostOwnershipPath(agentDir), `${JSON.stringify(foreign)}\n`, "utf8");
    assert.equal(first.state.release(), false);
    assert.equal(JSON.parse(readFileSync(hostOwnershipPath(agentDir), "utf8")).hostId, "host-foreign");

    // Restore our own record and release it; the next host may then acquire it.
    writeFileSync(hostOwnershipPath(agentDir), `${JSON.stringify({ version: 1, hostId: "host-1" })}\n`, "utf8");
    assert.equal(first.state.release(), true);
    assert.equal(first.state.release(), true, "release is idempotent for this holder");
    assert.equal(existsSync(hostOwnershipPath(agentDir)), false);
    const third = openHostState({ agentDir, hostId: "host-3" });
    assert.equal(third.status, "opened");
    if (third.status === "opened") assert.equal(third.state.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership refuses a non-existent, non-directory, or symlinked agent/state directory", () => {
  const root = makeRoot("refusal");
  try {
    const missing = openHostState({ agentDir: join(root, "missing"), hostId: "host-1" });
    assert.equal(missing.status, "refused");

    const fileAgent = join(root, "not-a-directory");
    writeFileSync(fileAgent, "not a directory", "utf8");
    const fileRefusal = openHostState({ agentDir: fileAgent, hostId: "host-1" });
    assert.equal(fileRefusal.status, "refused");

    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    try {
      symlinkSync(join(root, "elsewhere"), join(agentDir, HOST_STATE_DIRNAME));
    } catch {
      return;
    }
    const symlinkedState = openHostState({ agentDir, hostId: "host-1" });
    assert.equal(symlinkedState.status, "refused");
    assert.match(symlinkedState.status === "refused" ? symlinkedState.message : "", /not a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run one bounded child process; a blocking regression trips the timeout instead of hanging the suite. */
function runBoundedChild(script: string): { timedOut: boolean; stdout: string } {
  const modulePath = join(process.cwd(), "dist-test", "src", "session-host", "roster-store.js");
  const result = spawnSync(process.execPath, ["-e", script.replaceAll("__STORE__", JSON.stringify(modulePath))], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    stdout: result.stdout ?? "",
  };
}

/** Create a named pipe; platforms without mkfifo are covered by the other unsafe-entry cases. */
function makeFifo(path: string): boolean {
  return spawnSync("mkfifo", [path], { encoding: "utf8", timeout: 10_000 }).status === 0;
}

test("a FIFO roster or ownership record is refused promptly instead of blocking the host", async (t) => {
  const root = makeRoot("fifo");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(sessionHostStateDir(agentDir), { recursive: true });
  try {
    if (!makeFifo(rosterStorePath(agentDir))) {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }
    assert.equal(lstatSync(rosterStorePath(agentDir)).isFIFO(), true);
    const roster = runBoundedChild(`
      const { readRosterStore } = require(__STORE__);
      process.stdout.write(JSON.stringify(readRosterStore(${JSON.stringify(agentDir)})));
    `);
    assert.equal(roster.timedOut, false, "reading a FIFO roster must never block startup");
    const result = JSON.parse(roster.stdout) as { status: string; reason?: string };
    assert.equal(result.status, "unavailable");
    assert.match(result.reason ?? "", /not a regular file/);
    assert.equal(lstatSync(rosterStorePath(agentDir)).isFIFO(), true, "the FIFO is preserved, never opened or removed");

    // The ownership record is read with the same never-blocking rule: a host
    // whose own record was replaced by a FIFO reports an unconfirmed release.
    const ownershipRoot = join(root, "ownership-agent");
    mkdirSync(ownershipRoot);
    const released = runBoundedChild(`
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      const store = require(__STORE__);
      const agentDir = ${JSON.stringify(ownershipRoot)};
      const opened = store.openHostState({ agentDir, hostId: "host-fifo" });
      if (opened.status !== "opened") { process.stdout.write("open-refused"); process.exit(0); }
      const path = store.hostOwnershipPath(agentDir);
      fs.unlinkSync(path);
      spawnSync("mkfifo", [path]);
      process.stdout.write(JSON.stringify({ released: opened.state.release() }));
    `);
    assert.equal(released.timedOut, false, "releasing ownership must never block on a replaced record");
    assert.deepEqual(JSON.parse(released.stdout), { released: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ownership refusal never advises deleting the record from liveness alone", () => {
  const root = makeRoot("advice");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    const first = openHostState({ agentDir, hostId: "host-1" });
    assert.equal(first.status, "opened");
    const second = openHostState({ agentDir, hostId: "host-2" });
    assert.equal(second.status, "refused");
    const message = second.status === "refused" ? second.message : "";
    assert.doesNotMatch(message, /no longer running/, "liveness alone never authorizes deleting the record");
    assert.match(message, /established that none of its owned sessions are still running/);
    assert.match(message, new RegExp(HOST_OWNERSHIP_FILENAME));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid supplementary-Unicode native name never blocks roster publication or later removals", () => {
  const root = makeRoot("unicode");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    const emojiName = "\u{1F600}".repeat(200);
    assert.equal(isValidRosterName(emojiName), true, "200 emoji are a valid 200-codepoint native display name");
    assert.equal(isValidRosterName("\u{1F600}".repeat(300)), false, "beyond the native codepoint bound is refused");
    const roster: StoredRoster = {
      version: ROSTER_STORE_VERSION,
      entries: [{ slotId: "slot-a", sessionId: "conv-a", workspace: join(root, "ws"), name: emojiName }],
      activeSlotId: "slot-a",
    };
    writeRosterStore(agentDir, roster);
    const read = readRosterStore(agentDir);
    assert.equal(read.status, "loaded");
    assert.deepEqual(read.status === "loaded" ? read.roster : undefined, roster);
    // A later explicit removal is still publishable after a Unicode name.
    writeRosterStore(agentDir, { version: ROSTER_STORE_VERSION, entries: [] });
    const removed = readRosterStore(agentDir);
    assert.equal(removed.status, "loaded");
    assert.deepEqual(removed.status === "loaded" ? removed.roster.entries : undefined, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an identity-unavailable slot round-trips without inventing a session id or workspace", () => {
  const root = makeRoot("identity-unavailable");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  try {
    const roster: StoredRoster = {
      version: ROSTER_STORE_VERSION,
      entries: [
        { slotId: "slot-a" },
        { slotId: "slot-b", workspace: join(root, "ws-b") },
      ],
    };
    writeRosterStore(agentDir, roster);
    const read = readRosterStore(agentDir);
    assert.equal(read.status, "loaded");
    assert.deepEqual(read.status === "loaded" ? read.roster : undefined, roster);
    assert.equal(parseStoredRoster({ ...roster, entries: [{ slotId: "slot-a", sessionId: "" }] }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
