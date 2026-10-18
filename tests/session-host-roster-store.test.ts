import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync as appendFileSyncImpl, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piAgentDir } from "../src/config-path";
import {
  HOST_COORDINATION_FILENAME,
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

function appendFileSync(path: string, text: string): void {
  appendFileSyncImpl(path, text);
}

async function waitForLog(log: string, needle: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, "utf8").includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${needle} in ${log}`);
}

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

test("empty-identity and same-pid-wrong-birth coordination records are never honored", async () => {
  const identityOf = (pid: number): string => (require(join(process.cwd(), "scripts", "managed-generations.cjs")) as {
    coordinationInternals: { ownerStartIdentity(pid: number): string };
  }).coordinationInternals.ownerStartIdentity(pid);
  const ownIdentity = identityOf(process.pid);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    // (a) A live foreign pid with no birth identity is stale metadata.
    const first = makeRoot("coordination-empty-identity");
    const firstAgent = join(first, "agent");
    mkdirSync(join(firstAgent, HOST_STATE_DIRNAME), { recursive: true });
    try {
      writeFileSync(join(firstAgent, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME), `${holder.pid}\n\n`);
      const started = Date.now();
      const opened = openHostState({ agentDir: firstAgent, hostId: "empty-identity-host" });
      assert.equal(opened.status, "opened", "an empty-identity record never gates ownership");
      assert.ok(Date.now() - started < 10_000, "the stale record was reclaimed instead of waited for");
      if (opened.status === "opened") assert.equal(opened.state.release(), true);
    } finally {
      rmSync(first, { recursive: true, force: true });
    }

    // (b) A record naming this very pid with a wrong birth identity is not self-adoption.
    const second = makeRoot("coordination-wrong-birth");
    const secondAgent = join(second, "agent");
    mkdirSync(join(secondAgent, HOST_STATE_DIRNAME), { recursive: true });
    try {
      const path = join(secondAgent, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
      writeFileSync(path, `${process.pid}\nlinux:stale-birth:1\n`);
      const opened = openHostState({ agentDir: secondAgent, hostId: "wrong-birth-host" });
      assert.equal(opened.status, "opened", "a same-pid wrong-birth record never blocks ownership");
      assert.equal(existsSync(hostOwnershipPath(secondAgent)), true);
      if (opened.status === "opened") assert.equal(opened.state.release(), true);
      assert.equal(existsSync(path), false, "no coordination entry is left behind");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
    assert.ok(ownIdentity.length > 0, "this platform reports a birth identity");
  } finally {
    holder.kill("SIGKILL");
  }
});

test("a launcher-held coordination entry is taken over and handed back when ownership is claimed", () => {
  const root = makeRoot("coordination-handoff");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
  try {
    const path = join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
    // The launcher's coordinated selection/preparation handoff: this same process
    // holds the entry when the host claims ownership.
    const ownIdentity = (require(join(process.cwd(), "scripts", "managed-generations.cjs")) as {
      coordinationInternals: { ownerStartIdentity(pid: number): string };
    }).coordinationInternals.ownerStartIdentity(process.pid);
    writeFileSync(path, `${process.pid}\n${ownIdentity}\n`);
    const opened = openHostState({ agentDir, hostId: "handoff-host" });
    assert.equal(opened.status, "opened", "ownership is claimed inside the existing hold");
    assert.equal(existsSync(hostOwnershipPath(agentDir)), true);
    assert.equal(existsSync(path), false,
      "the launcher-held coordination entry is handed back once ownership exists");
    if (opened.status === "opened") assert.equal(opened.state.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reused pid with a mismatched start identity is stale metadata, not a permanent ownership gate", () => {
  const root = makeRoot("coordination-reused-pid");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
  try {
    const path = join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
    // A live but unrelated process recorded with a start identity that is not its
    // own is exactly the abandoned-record-with-reused-pid case.
    writeFileSync(path, `${process.pid}\nSat Jan  1 00:00:00 2000\n`);
    const started = Date.now();
    const opened = openHostState({ agentDir, hostId: "reused-pid-host" });
    assert.equal(opened.status, "opened", "reused pid metadata never gates ownership");
    assert.ok(Date.now() - started < 10_000, "the stale record was reclaimed instead of being waited for");
    assert.equal(existsSync(hostOwnershipPath(agentDir)), true);
    if (opened.status === "opened") assert.equal(opened.state.release(), true);
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

/**
 * #385 coordination boundary: ownership acquisition and destructive cache
 * reclamation take one canonical per-agent entry
 * (`session-host/host-coordination.lock`). A stale/malformed entry is reclaimed
 * like a stale admission lock, a busy live owner never permanently gates
 * startup, and ownership is claimed only when the launcher's prepared artifacts
 * still exist. These are the host half of the deterministic race regressions;
 * the producer half lives in managed-generations.test.ts and
 * session-host-entrypoints.test.ts.
 */
test("the coordination entry is reclaimed when stale or malformed and never gates ownership", () => {
  const coordinate = (agentDir: string) => join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
  for (const shape of ["dead-pid", "empty", "malformed", "directory", "oversized"] as const) {
    const root = makeRoot(`coordination-${shape}`);
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
    try {
      const path = coordinate(agentDir);
      if (shape === "dead-pid") writeFileSync(path, "999999999\n");
      else if (shape === "empty") writeFileSync(path, "");
      else if (shape === "malformed") writeFileSync(path, "not-a-pid\n");
      else if (shape === "directory") mkdirSync(path);
      else writeFileSync(path, `${"x".repeat(200)}`);
      const opened = openHostState({ agentDir, hostId: `host-${shape}` });
      assert.equal(opened.status, "opened", `${shape}: stale coordination metadata never refuses a start`);
      if (opened.status !== "opened") continue;
      assert.equal(existsSync(path), false, `${shape}: the stale artifact itself is gone, not left as a permanent gate`);
      assert.equal(opened.state.release(), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("ownership is not claimed while a live coordination holder is inside its destructive pass", async () => {
  const root = makeRoot("coordination-live-hold");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
  const log = join(root, "order.log");
  writeFileSync(log, "");
  const releaseFile = join(root, "release");
  const lockPath = join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
  const rosterStorePath = join(process.cwd(), "dist-test", "src", "session-host", "roster-store.js");
  const append = (line: string) => appendFileSync(log, `${line}\n`);
  // A real live holder owns the coordination entry for longer than the previous
  // short acquisition bypass, exactly like a producer inside a destructive pass.
  const holderScript = join(root, "holder.cjs");
  writeFileSync(holderScript, [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const agentDir = process.argv[2];`,
    `const log = process.argv[3];`,
    `const releaseFile = process.argv[4];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `const stateDir = path.join(agentDir, "session-host");`,
    `const lock = path.join(stateDir, "host-coordination.lock");`,
    // A genuine holder publishes its complete record with its own targeted
    // single-pid start identity.
    `const identity = require(${JSON.stringify(join(process.cwd(), "scripts", "managed-generations.cjs"))}).coordinationInternals.ownerStartIdentity(process.pid);`,
    `fs.writeFileSync(lock, String(process.pid) + "\\n" + identity + "\\n", { mode: 0o600 });`,
    `append("HOLDING");`,
    `const holdUntil = Date.now() + 3000;`,
    `while (Date.now() < holdUntil) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `append("HOLDER-CHECKED:ownership=" + fs.existsSync(path.join(stateDir, "host-ownership.json")));`,
    `const deadline = Date.now() + 60000;`,
    `while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `fs.unlinkSync(lock);`,
    `append("HOLDER-RELEASED");`,
    ``,
  ].join("\n"), "utf8");
  const hostScript = join(root, "host.cjs");
  writeFileSync(hostScript, [
    `const fs = require("node:fs");`,
    `const { openHostState } = require(${JSON.stringify(rosterStorePath)});`,
    `const agentDir = process.argv[2];`,
    `const log = process.argv[3];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `append("ACQUIRE-START");`,
    `const opened = openHostState({ agentDir, hostId: "live-hold-host" });`,
    `append("ACQUIRED:" + opened.status);`,
    `if (opened.status !== "opened") process.exit(2);`,
    `append("RELEASE:" + opened.state.release());`,
    ``,
  ].join("\n"), "utf8");
  try {
    const holder = spawn(process.execPath, [holderScript, agentDir, log, releaseFile], { stdio: ["ignore", "ignore", "inherit"] });
    await waitForLog(log, "HOLDING");
    assert.equal(existsSync(lockPath), true, "the live holder owns the coordination entry");
    const host = spawn(process.execPath, [hostScript, agentDir, log], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      await waitForLog(log, "ACQUIRE-START");
      // The host has reached acquisition and the holder is still inside its
      // bounded hold: ownership is not claimed behind the holder's back.
      await waitForLog(log, "HOLDER-CHECKED");
      const ordered = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(ordered.includes("HOLDER-CHECKED:ownership=false"),
        `ownership was not claimed while a live destructive holder was active: ${ordered.join(" | ")}`);
      assert.equal(ordered.includes("ACQUIRED:opened"), false, "acquisition waits for the live holder");
      assert.equal(existsSync(join(agentDir, HOST_STATE_DIRNAME, HOST_OWNERSHIP_FILENAME)), false);
      writeFileSync(releaseFile, "release");
      await waitForLog(log, "HOLDER-RELEASED");
      await waitForLog(log, "ACQUIRED:opened");
      await waitForLog(log, "RELEASE:");
      const final = readFileSync(log, "utf8").trim().split("\n");
      assert.ok(final.indexOf("ACQUIRE-START") < final.indexOf("HOLDER-RELEASED"), "the host waited for the holder");
      assert.ok(final.indexOf("HOLDER-RELEASED") < final.indexOf("ACQUIRED:opened"),
        `ownership is only claimed after the destructive section settles: ${final.join(" | ")}`);
      assert.ok(final.includes("RELEASE:true"), "the host releases only its own record");
      assert.equal(existsSync(lockPath), false, "no coordination entry is left behind");
      assert.equal(existsSync(join(agentDir, HOST_STATE_DIRNAME, HOST_OWNERSHIP_FILENAME)), false);
    } finally {
      writeFileSync(releaseFile, "release");
      host.kill("SIGKILL");
      holder.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed coordination shape is reclaimed and never becomes an ownership gate", () => {
  const root = makeRoot("coordination-malformed-owner");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
  try {
    const path = join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
    const target = join(root, "foreign-target");
    writeFileSync(target, "foreign content");
    try {
      symlinkSync(target, path);
    } catch {
      return; // platforms without symlink support are covered elsewhere
    }
    const opened = openHostState({ agentDir, hostId: "malformed-owner-host" });
    assert.equal(opened.status, "opened", "malformed metadata never gates ownership");
    assert.equal(readFileSync(target, "utf8"), "foreign content", "the link target is never read, followed, or removed");
    assert.equal(existsSync(path), false, "the malformed entry itself was reclaimed, not left behind");
    if (opened.status === "opened") assert.equal(opened.state.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dead coordination owner is reclaimed so ownership is never gated by stale metadata", () => {
  const root = makeRoot("coordination-dead-owner");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, HOST_STATE_DIRNAME), { recursive: true });
  try {
    const path = join(agentDir, HOST_STATE_DIRNAME, HOST_COORDINATION_FILENAME);
    writeFileSync(path, "999999999\n");
    const opened = openHostState({ agentDir, hostId: "dead-owner-host" });
    assert.equal(opened.status, "opened", "a dead owner never blocks ownership");
    assert.equal(existsSync(path), false, "the dead owner's entry is reclaimed");
    if (opened.status === "opened") assert.equal(opened.state.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
