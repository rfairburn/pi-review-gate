/**
 * #682: the stable Review Gate MCP server name persisted per sidebar host.
 *
 * Everything runs against owned scratch agent directories; nothing reads or
 * writes live user settings or state. The module is exercised standalone — it
 * is not wired into host startup.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test, { after } from "node:test";

import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import { createSessionHostStateDirectory } from "../src/session-host/roster-store";
import type {
  WindowsAclAceEvidence,
  WindowsAclEvidence,
} from "../src/session-host/network/peer-state-windows-permissions";

import {
  MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES,
  NATIVE_MCP_SERVER_NAME_FILENAME,
  NATIVE_MCP_SERVER_NAME_LENGTH,
  NATIVE_MCP_SERVER_NAME_PREFIX,
  __test,
  isNativeMcpServerName,
  nativeMcpServerNamePath,
  parseNativeMcpServerName,
  readNativeMcpServerName,
  readOrCreateNativeMcpServerName,
  type NativeMcpServerNameResult,
} from "../src/session-host/native-mcp-server-name";

const POSIX = typeof process.getuid === "function";
const ROOT_USER = POSIX && process.getuid?.() === 0;
const SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "native-mcp-server-name-tests");
const NAME = /^pi_review_gate_[0-9a-f]{32}$/;

mkdirSync(SCRATCH_ROOT, { recursive: true });
const RUN_ROOT = mkdtempSync(join(SCRATCH_ROOT, "run-"));
after(() => rmSync(RUN_ROOT, { recursive: true, force: true }));

/** A fresh owned scratch root containing one synthetic native agent directory. */
function scratch(label: string): { root: string; agentDir: string; stateDir: string; path: string } {
  const root = realpathSync(mkdtempSync(join(RUN_ROOT, `${label}-`)));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  return {
    root,
    agentDir,
    stateDir: join(agentDir, "session-host"),
    path: nativeMcpServerNamePath(agentDir),
  };
}

/** The real production platform policy for this host. */
function posixPolicy() {
  return createPeerStatePermissionPolicy();
}

/**
 * The storage-proof policy for cases that assert this module's parsing, byte
 * limit, or publication state rather than the platform's protection proof.
 *
 * POSIX proofs are a handful of syscalls, so those cases keep the real
 * production policy here and change nothing. On Windows every proof is a fresh
 * trusted-helper process, so a repeated fixture would pay a DACL round trip
 * just to reach one parser branch; those cases run the same checks against the
 * existing injected-helper seam (`windowsPolicy`, defined with the `Windows:`
 * cases below).
 *
 * Where each kind of evidence lives: the cases that use this helper on Windows,
 * like the `Windows:` cases below, run the real permission policy against
 * synthetic helper receipts and claim no real DACL. Real Windows DACL evidence
 * stays with the cases that assert it — the real create/reopen, separate-host,
 * publication-race, and competing-process tests, and the two `realProof`
 * fixtures in the stored-state table. Injected evidence never reaches a
 * production call.
 */
function stateProofPolicy(agentDir: string): PeerStatePermissionPolicy {
  return process.platform === "win32"
    ? windowsPolicy(stateDirOf(agentDir)).permissions
    : posixPolicy();
}

function prepareStateDir(stateDir: string): void {
  mkdirSync(stateDir, { mode: 0o700 });
}

/** The protected state directory the production API expects on this platform. */
function prepareProductionStateDir(stateDir: string): void {
  if (process.platform === "win32") {
    assert.equal(createSessionHostStateDirectory(stateDir).outcome, "created-protected");
  } else {
    prepareStateDir(stateDir);
  }
}

/** The stored document, created exclusively with the platform's private mode. */
function writeStoredState(path: string, body: string): void {
  writeFileSync(path, body, { flag: "wx", mode: 0o600 });
}

/** A private fixture file: only the exclusively created empty file is protected. */
function writePrivateFixture(path: string, body: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, "", { flag: "wx" });
    createPeerStatePermissionPolicy().protectCreatedFile(path);
    writeFileSync(path, body);
  } else {
    writeStoredState(path, body);
  }
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out.push(relative(root, full).split(sep).join("/"));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

function fixedBytes(fill: number): (size: number) => Buffer {
  return (size) => Buffer.alloc(size, fill);
}

function nameOf(result: NativeMcpServerNameResult): string {
  assert.ok(result.status === "loaded" || result.status === "created", JSON.stringify(result));
  return result.serverName;
}

function assertRefused(
  result: NativeMcpServerNameResult | ReturnType<typeof readNativeMcpServerName>,
  reason: string,
): void {
  assert.equal(result.status, "refused", JSON.stringify(result));
  if (result.status !== "refused") return;
  assert.equal(result.reason, reason);
  assert.match(result.message, /^Session host refused: /);
  assert.doesNotMatch(result.message, /pi_review_gate_[0-9a-f]/);
  assert.doesNotMatch(result.message, new RegExp(RUN_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

test("grammar accepts only the fixed prefix plus 32 lowercase hex digits", () => {
  const valid = `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0123456789abcdef".repeat(2)}`;
  assert.equal(NATIVE_MCP_SERVER_NAME_PREFIX, "pi_review_gate_");
  assert.equal(NATIVE_MCP_SERVER_NAME_LENGTH, 47);
  assert.equal(isNativeMcpServerName(valid), true);
  assert.equal(parseNativeMcpServerName(valid), valid);
  const invalid: unknown[] = [
    undefined,
    null,
    47,
    {},
    "",
    "pi_review_gate",
    "pi_review_gate_",
    `${valid.slice(0, -1)}`,
    `${valid}0`,
    `${valid}\n`,
    ` ${valid}`,
    valid.toUpperCase(),
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0123456789ABCDEF".repeat(2)}`,
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"g".repeat(32)}`,
    `pi-review-gate_${"a".repeat(32)}`,
    `Pi_review_gate_${"a".repeat(32)}`,
    `xpi_review_gate_${"a".repeat(31)}`,
  ];
  for (const value of invalid) {
    assert.equal(isNativeMcpServerName(value), false, JSON.stringify(value));
    assert.equal(parseNativeMcpServerName(value), undefined);
  }
});

test("minting uses exactly 16 random bytes and refuses a short or failing source", () => {
  const requested: number[] = [];
  const minted = __test.mintServerName((size) => {
    requested.push(size);
    return Buffer.alloc(size, 0xab);
  });
  assert.deepEqual(requested, [16]);
  assert.equal(minted, `pi_review_gate_${"ab".repeat(16)}`);
  assert.equal(__test.mintServerName(() => Buffer.alloc(15)), undefined);
  assert.equal(__test.mintServerName(() => Buffer.alloc(17)), undefined);
  assert.equal(__test.mintServerName(() => { throw new Error("no entropy"); }), undefined);
});

test("new host state gets one valid private name that is stable across reopen", () => {
  const { root, agentDir, stateDir, path } = scratch("fresh");
  assert.deepEqual(readNativeMcpServerName(agentDir), { status: "absent" });
  assert.equal(existsSync(path), false, "a read never creates the name");

  const first = readOrCreateNativeMcpServerName(agentDir);
  assert.equal(first.status, "created");
  const name = nameOf(first);
  assert.match(name, NAME);

  const stored = readFileSync(path, "utf8");
  assert.equal(stored, `${JSON.stringify({ version: 1, serverName: name })}\n`);
  const stats = lstatSync(path);
  assert.ok(stats.isFile());
  assert.equal(stats.nlink, 1, "the private temporary link was removed");
  if (POSIX) {
    assert.equal(stats.mode & 0o777, 0o600);
    assert.equal(stats.uid, process.getuid?.());
  }

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(readOrCreateNativeMcpServerName(agentDir), { status: "loaded", serverName: name });
    assert.deepEqual(readNativeMcpServerName(agentDir), { status: "loaded", serverName: name });
  }
  assert.equal(readFileSync(path, "utf8"), stored, "reopen never rewrites the file");

  // Only the owned state root was touched: no temporaries, nothing beside the agent dir.
  assert.deepEqual(listTree(root), [
    "agent",
    "agent/session-host",
    `agent/session-host/${NATIVE_MCP_SERVER_NAME_FILENAME}`,
  ]);
  assert.ok(statSync(stateDir).isDirectory());
});

test("separate hosts mint independent names", () => {
  const a = nameOf(readOrCreateNativeMcpServerName(scratch("host-a").agentDir));
  const b = nameOf(readOrCreateNativeMcpServerName(scratch("host-b").agentDir));
  assert.match(a, NAME);
  assert.match(b, NAME);
  assert.notEqual(a, b);
});

test("a creator that loses the publication race adopts the winner without rotation", () => {
  const { root, agentDir, path } = scratch("race");
  let inner: NativeMcpServerNameResult | undefined;
  const outer = __test.readOrCreateWith(agentDir, {
    randomBytes: fixedBytes(0x11),
    permissions: posixPolicy(),
    beforePublish: () => {
      inner = __test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x22), permissions: posixPolicy() });
    },
  });
  const winner = `pi_review_gate_${"22".repeat(16)}`;
  assert.deepEqual(inner, { status: "created", serverName: winner });
  assert.deepEqual(outer, { status: "loaded", serverName: winner });
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ version: 1, serverName: winner })}\n`);
  assert.deepEqual(readOrCreateNativeMcpServerName(agentDir), { status: "loaded", serverName: winner });
  assert.deepEqual(listTree(root), [
    "agent",
    "agent/session-host",
    `agent/session-host/${NATIVE_MCP_SERVER_NAME_FILENAME}`,
  ], "the losing temporary was removed");
});

test("a losing creator refuses when the winner's entry is not valid", () => {
  const { agentDir, stateDir, path } = scratch("race-bad");
  prepareStateDir(stateDir);
  // What this case asserts is the winner's malformed document, not the DACL: the
  // exclusive link, the losing creator's own temporary, and the adopted refusal
  // all stay real, while the storage proof comes from the seam's policy.
  const permissions = stateProofPolicy(agentDir);
  const outer = __test.readOrCreateWith(agentDir, {
    randomBytes: fixedBytes(0x11),
    permissions,
    beforePublish: () => writeStoredState(path, "{broken"),
  });
  assertRefused(outer, "malformed");
  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("competing host processes converge on one name", async () => {
  const { agentDir, path } = scratch("processes");
  const modulePath = join(__dirname, "..", "src", "session-host", "native-mcp-server-name.js");
  const script = [
    "const m = require(process.argv[1]);",
    "const r = m.readOrCreateNativeMcpServerName(process.argv[2]);",
    "process.stdout.write(JSON.stringify(r));",
  ].join("\n");
  const runs = Array.from({ length: 8 }, () => new Promise<NativeMcpServerNameResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, modulePath, agentDir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
      else resolve(JSON.parse(out) as NativeMcpServerNameResult);
    });
  }));
  const results = await Promise.all(runs);
  const names = new Set(results.map(nameOf));
  assert.equal(names.size, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.status === "created").length, 1, JSON.stringify(results));
  const [name] = names;
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ version: 1, serverName: name })}\n`);
  assert.deepEqual(readdirSync(join(agentDir, "session-host")), [NATIVE_MCP_SERVER_NAME_FILENAME]);

  // A later "restart" in a fresh process still sees the same name.
  const restarted = JSON.parse(execFileSync(process.execPath, ["-e", script, modulePath, agentDir], { encoding: "utf8" })) as NativeMcpServerNameResult;
  assert.deepEqual(restarted, { status: "loaded", serverName: name });
});

test("an interrupted first publication reloads only its own publication alias", { skip: !POSIX && "POSIX link proof" }, () => {
  const { root, agentDir, stateDir, path } = scratch("interrupted-link");
  prepareStateDir(stateDir);
  const serverName = `pi_review_gate_${"a1".repeat(16)}`;
  const body = `${JSON.stringify({ version: 1, serverName })}\n`;
  const temporary = join(stateDir, `.${NATIVE_MCP_SERVER_NAME_FILENAME}.tmp.${serverName}`);
  // Exactly the state a creator leaves if it stops between link and retirement.
  writeFileSync(temporary, body, { mode: 0o600 });
  linkSync(temporary, path);
  assert.deepEqual(readNativeMcpServerName(agentDir), { status: "loaded", serverName });
  assert.deepEqual(readOrCreateNativeMcpServerName(agentDir), { status: "loaded", serverName });
  assert.equal(readFileSync(temporary, "utf8"), body, "a read does not retire another creator's alias");

  // An alias named for a different server name is not this protocol's alias.
  const foreignAlias = join(stateDir, `.${NATIVE_MCP_SERVER_NAME_FILENAME}.tmp.pi_review_gate_${"b2".repeat(16)}`);
  linkSync(path, foreignAlias);
  unlinkSync(temporary);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  unlinkSync(foreignAlias);

  // Any unrelated hard link refuses and nothing is changed.
  const unrelated = join(root, "unrelated");
  linkSync(path, unrelated);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  assertRefused(readNativeMcpServerName(agentDir), "unsafe-entry");
  assert.equal(readFileSync(path, "utf8"), body);
  assert.equal(readFileSync(unrelated, "utf8"), body);
  assert.equal(lstatSync(path).nlink, 2);

  // Three links refuse even when one is the protocol's own alias.
  linkSync(path, temporary);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  unlinkSync(unrelated);
  assert.deepEqual(readOrCreateNativeMcpServerName(agentDir), { status: "loaded", serverName });
});

test("a two-link alias still needs the exact private mode", { skip: !POSIX && "POSIX mode bits" }, () => {
  const { agentDir, stateDir, path } = scratch("alias-mode");
  prepareStateDir(stateDir);
  const serverName = `pi_review_gate_${"c3".repeat(16)}`;
  const temporary = join(stateDir, `.${NATIVE_MCP_SERVER_NAME_FILENAME}.tmp.${serverName}`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, serverName })}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o640);
  linkSync(temporary, path);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("malformed, unsupported, or oversized stored state refuses and is never overwritten", () => {
  const valid = `pi_review_gate_${"ab".repeat(16)}`;
  // Two proof tiers on purpose. A `realProof` case runs the whole production
  // path: a fixture whose real DACL the platform policy established and
  // verified, read by the production API. One per refusal reason keeps real
  // Windows receipts reaching this parser branch — the malformed case also
  // proves the real directory and private-file DACLs on the read path, while
  // the oversized case proves the real directory DACL and then refuses at the
  // byte-size guard ahead of the read-path file proof. The rest are the same
  // parser and byte-limit assertions repeated over every malformed shape, so
  // their storage proof comes from `stateProofPolicy` (synthetic helper
  // receipts) instead of a fresh trusted-helper process per case.
  const cases: Array<{ label: string; body: string; reason: string; realProof?: boolean }> = [
    { label: "empty", body: "", reason: "malformed" },
    { label: "json", body: "{not json", reason: "malformed", realProof: true },
    { label: "array", body: "[]", reason: "malformed" },
    { label: "bare-string", body: JSON.stringify(valid), reason: "malformed" },
    { label: "version", body: JSON.stringify({ version: 2, serverName: valid }), reason: "malformed" },
    { label: "duplicate-version", body: `{"version":2,"version":1,"serverName":"${valid}"}\n`, reason: "malformed" },
    { label: "duplicate-name", body: `{"version":1,"serverName":"pi_review_gate_${"cd".repeat(16)}","serverName":"${valid}"}\n`, reason: "malformed" },
    { label: "escaped-duplicate", body: `{"version":1,"serverName":"pi_review_gate_${"cd".repeat(16)}","server\\u004eame":"${valid}"}\n`, reason: "malformed" },
    { label: "non-canonical-spacing", body: `{ "version": 1, "serverName": "${valid}" }\n`, reason: "malformed" },
    { label: "missing-newline", body: JSON.stringify({ version: 1, serverName: valid }), reason: "malformed" },
    { label: "missing", body: JSON.stringify({ version: 1 }), reason: "malformed" },
    { label: "extra", body: JSON.stringify({ version: 1, serverName: valid, token: "x" }), reason: "malformed" },
    { label: "legacy-fixed", body: JSON.stringify({ version: 1, serverName: "pi_review_gate" }), reason: "malformed" },
    { label: "uppercase", body: JSON.stringify({ version: 1, serverName: valid.toUpperCase() }), reason: "malformed" },
    { label: "short", body: JSON.stringify({ version: 1, serverName: valid.slice(0, -2) }), reason: "malformed" },
    { label: "oversized", body: " ".repeat(MAX_NATIVE_MCP_SERVER_NAME_FILE_BYTES + 1), reason: "oversized", realProof: true },
  ];
  for (const { label, body, reason, realProof } of cases) {
    const { agentDir, stateDir, path } = scratch(`corrupt-${label}`);
    if (realProof === true) {
      prepareProductionStateDir(stateDir);
      writePrivateFixture(path, body);
      assertRefused(readOrCreateNativeMcpServerName(agentDir), reason);
      assertRefused(readNativeMcpServerName(agentDir), reason);
    } else {
      prepareStateDir(stateDir);
      writeStoredState(path, body);
      const permissions = stateProofPolicy(agentDir);
      assertRefused(__test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x33), permissions }), reason);
      assertRefused(__test.readWith(agentDir, { permissions }), reason);
    }
    assert.equal(readFileSync(path, "utf8"), body, `${label}: stored bytes untouched`);
    assert.deepEqual(readdirSync(stateDir), [NATIVE_MCP_SERVER_NAME_FILENAME], `${label}: no temporaries`);
  }
});

test("non-regular or symlinked entries refuse without following or replacing them", { skip: !POSIX && "POSIX symlink/FIFO semantics" }, () => {
  const { root, agentDir, stateDir, path } = scratch("symlink");
  prepareStateDir(stateDir);
  const target = join(root, "elsewhere.json");
  const targetBody = JSON.stringify({ version: 1, serverName: `pi_review_gate_${"cd".repeat(16)}` });
  writeFileSync(target, targetBody, { mode: 0o600 });
  symlinkSync(target, path);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  assert.ok(lstatSync(path).isSymbolicLink());
  assert.equal(readFileSync(target, "utf8"), targetBody);

  const dir = scratch("directory");
  prepareStateDir(dir.stateDir);
  mkdirSync(dir.path);
  assertRefused(readOrCreateNativeMcpServerName(dir.agentDir), "unsafe-entry");
  assert.ok(lstatSync(dir.path).isDirectory());

  const fifo = scratch("fifo");
  prepareStateDir(fifo.stateDir);
  execFileSync("mkfifo", [fifo.path]);
  assertRefused(readOrCreateNativeMcpServerName(fifo.agentDir), "unsafe-entry");
  assert.ok(lstatSync(fifo.path).isFIFO());
});

test("shared-writable entries or state directories refuse", { skip: !POSIX && "POSIX mode bits" }, () => {
  const { agentDir, stateDir, path } = scratch("shared-file");
  prepareStateDir(stateDir);
  const body = `${JSON.stringify({ version: 1, serverName: `pi_review_gate_${"ef".repeat(16)}` })}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o666);
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
  assert.equal(readFileSync(path, "utf8"), body);
  assert.equal(statSync(path).mode & 0o777, 0o666, "permissions are not repaired");

  const shared = scratch("shared-dir");
  prepareStateDir(shared.stateDir);
  chmodSync(shared.stateDir, 0o777);
  assertRefused(readOrCreateNativeMcpServerName(shared.agentDir), "unsafe-storage");
  assertRefused(readNativeMcpServerName(shared.agentDir), "unsafe-storage");
  assert.deepEqual(readdirSync(shared.stateDir), [], "no name is minted into shared storage");
  assert.equal(statSync(shared.stateDir).mode & 0o777, 0o777);
});

test("a protected session-host directory mints and reuses the name under a 0775 agent directory", { skip: !POSIX && "POSIX mode bits" }, () => {
  const { agentDir, stateDir, path } = scratch("shared-agent");
  prepareStateDir(stateDir);
  chmodSync(agentDir, 0o775);
  try {
    let mintCalls = 0;
    const created = __test.readOrCreateWith(agentDir, {
      permissions: posixPolicy(),
      randomBytes: (size) => {
        mintCalls += 1;
        return Buffer.alloc(size, 0x42);
      },
    });
    const serverName = `pi_review_gate_${"42".repeat(16)}`;
    assert.deepEqual(created, { status: "created", serverName });
    assert.equal(mintCalls, 1);
    const body = readFileSync(path, "utf8");
    assert.deepEqual(readNativeMcpServerName(agentDir), { status: "loaded", serverName });
    assert.deepEqual(readOrCreateNativeMcpServerName(agentDir), { status: "loaded", serverName });
    assert.equal(readFileSync(path, "utf8"), body);
    assert.deepEqual(readdirSync(agentDir), ["session-host"]);
    assert.equal(statSync(agentDir).mode & 0o777, 0o775, "the agent directory is not repaired");
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    chmodSync(agentDir, 0o700);
  }
});

test("a symlinked agent directory refuses without being followed", { skip: !POSIX && "POSIX symlinks" }, () => {
  const { root, agentDir } = scratch("agent-symlink");
  const alias = join(root, "agent-alias");
  symlinkSync(agentDir, alias);
  assertRefused(readOrCreateNativeMcpServerName(alias), "state-unavailable");
  assert.deepEqual(readdirSync(agentDir), []);
});

test("unavailable host state refuses without minting", () => {
  assertRefused(readOrCreateNativeMcpServerName("relative/agent"), "state-unavailable");
  const missing = join(RUN_ROOT, "does-not-exist");
  assertRefused(readOrCreateNativeMcpServerName(missing), "state-unavailable");
  assert.equal(existsSync(missing), false);

  if (POSIX) {
    const { root, agentDir, stateDir } = scratch("state-symlink");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, stateDir);
    assertRefused(readOrCreateNativeMcpServerName(agentDir), "state-unavailable");
    assert.deepEqual(readdirSync(elsewhere), [], "a symlinked state directory is never followed");

    const fileState = scratch("state-file");
    writeFileSync(fileState.stateDir, "not a directory");
    assertRefused(readOrCreateNativeMcpServerName(fileState.agentDir), "state-unavailable");
    assert.equal(readFileSync(fileState.stateDir, "utf8"), "not a directory");
  }
});

test("an inaccessible or non-private stored name refuses and is left in place", { skip: (!POSIX || ROOT_USER) && "needs non-root POSIX permissions" }, () => {
  const body = `${JSON.stringify({ version: 1, serverName: `pi_review_gate_${"01".repeat(16)}` })}\n`;
  for (const mode of [0o000, 0o200, 0o400, 0o644, 0o700]) {
    const { agentDir, stateDir, path } = scratch(`mode-${mode.toString(8)}`);
    prepareStateDir(stateDir);
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, mode);
    try {
      assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-entry");
      assertRefused(readNativeMcpServerName(agentDir), "unsafe-entry");
      assert.deepEqual(readdirSync(stateDir), [NATIVE_MCP_SERVER_NAME_FILENAME]);
      assert.equal(statSync(path).mode & 0o777, mode, "permissions are not repaired");
    } finally {
      chmodSync(path, 0o600);
    }
    assert.equal(readFileSync(path, "utf8"), body);
  }
});

test("a restrictive umask still publishes a name the next host process can read", { skip: !POSIX && "POSIX umask" }, () => {
  const { agentDir, stateDir, path } = scratch("umask");
  prepareStateDir(stateDir);
  chmodSync(stateDir, 0o700);
  const modulePath = join(__dirname, "..", "src", "session-host", "native-mcp-server-name.js");
  const run = (umask: number | null): NativeMcpServerNameResult => JSON.parse(execFileSync(process.execPath, ["-e", [
    "if (process.argv[3] !== 'none') process.umask(Number(process.argv[3]));",
    "const m = require(process.argv[1]);",
    "process.stdout.write(JSON.stringify(m.readOrCreateNativeMcpServerName(process.argv[2])));",
  ].join("\n"), modulePath, agentDir, umask === null ? "none" : String(umask)], { encoding: "utf8" })) as NativeMcpServerNameResult;

  const created = run(0o400);
  assert.equal(created.status, "created", JSON.stringify(created));
  const name = nameOf(created);
  assert.equal(statSync(path).mode & 0o777, 0o600, "the umask did not strip owner read");
  assert.deepEqual(readdirSync(stateDir), [NATIVE_MCP_SERVER_NAME_FILENAME]);
  assert.deepEqual(run(null), { status: "loaded", serverName: name });
  assert.deepEqual(run(0o400), { status: "loaded", serverName: name });
});

test("a private state directory is required before a new name is created", { skip: !POSIX && "POSIX mode bits" }, () => {
  const { agentDir, stateDir } = scratch("readable-dir");
  prepareStateDir(stateDir);
  chmodSync(stateDir, 0o755);
  let mintCalls = 0;
  assertRefused(__test.readOrCreateWith(agentDir, {
    permissions: posixPolicy(),
    randomBytes: (size) => {
      mintCalls += 1;
      return Buffer.alloc(size, 0x42);
    },
  }), "unsafe-storage");
  assert.equal(mintCalls, 0, "refusal precedes minting and temporary creation");
  assertRefused(readOrCreateNativeMcpServerName(agentDir), "unsafe-storage");
  assert.deepEqual(readdirSync(stateDir), [], "no temporary or name is left behind");
  assert.equal(statSync(stateDir).mode & 0o777, 0o755, "the directory is not repaired");
});

/* Windows protection, driven through the real policy with a fake trusted helper. */
const WIN_CURRENT = "S-1-5-21-1111-2222-3333-1001";
const WIN_SYSTEM = "S-1-5-18";
const WIN_ADMINISTRATORS = "S-1-5-32-544";
const WIN_EVERYONE = "S-1-1-0";
const WIN_FULL_CONTROL = 0x1000_0000;

function winAce(sid: string, rights: number, overrides: Partial<WindowsAclAceEvidence> = {}): WindowsAclAceEvidence {
  return { sid, aceType: "allow", rights, inherit: 3, propagate: 0, inherited: false, ...overrides };
}

function winEvidence(kind: "dir" | "file", extraAces: WindowsAclAceEvidence[] = []): WindowsAclEvidence {
  const aces = [
    winAce(WIN_CURRENT, WIN_FULL_CONTROL),
    winAce(WIN_SYSTEM, WIN_FULL_CONTROL, { inherited: true }),
    winAce(WIN_ADMINISTRATORS, WIN_FULL_CONTROL, { inherited: true }),
    ...extraAces,
  ];
  return {
    isDirectory: kind === "dir",
    isReparsePoint: false,
    entryCount: kind === "dir" ? 0 : -1,
    fileLength: 0,
    ownerSid: WIN_CURRENT,
    daclPresent: true,
    daclProtected: true,
    daclAceCount: aces.length,
    daclAllowCount: aces.length,
    daclDenyCount: 0,
    daclOtherCount: 0,
    aces,
    parentExists: true,
    parentIsReparsePoint: false,
  };
}

const WIN_PERMISSIVE = [winAce(WIN_EVERYONE, WIN_FULL_CONTROL)];

function windowsPolicy(
  stateDir: string,
  options: {
    agent?: WindowsAclAceEvidence[];
    dir?: WindowsAclAceEvidence[];
    file?: WindowsAclAceEvidence[];
    unavailable?: boolean;
  } = {},
) {
  const calls: Array<{ op: string; path: string; kind?: string }> = [];
  const permissions = createPeerStatePermissionPolicy({
    platform: "win32",
    windows: {
      resolveExecutable: () => (options.unavailable ? null : "/opt/fake-system/powershell.exe"),
      execute: (_file, _args, spawnOptions) => {
        const request = JSON.parse(spawnOptions.input) as { op: string; path: string; kind?: string };
        calls.push({ op: request.op, path: request.path, kind: request.kind });
        const evidence = request.path === stateDir
          ? winEvidence("dir", options.dir)
          : request.path === dirname(stateDir) ? winEvidence("dir", options.agent)
          : winEvidence("file", options.file);
        return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: WIN_CURRENT, evidence }) };
      },
    },
  });
  return { permissions, calls };
}

function stateDirOf(agentDir: string): string {
  return join(realpathSync(agentDir), "session-host");
}

test("Windows: a broadly writable state directory refuses without minting or protecting anything", () => {
  const { agentDir } = scratch("win-permissive-dir");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  const { permissions, calls } = windowsPolicy(stateDir, { dir: WIN_PERMISSIVE });
  assertRefused(__test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x33), permissions }), "unsafe-storage");
  assertRefused(__test.readWith(agentDir, { permissions }), "unsafe-storage");
  assert.deepEqual(readdirSync(stateDir), []);
  assert.ok(calls.some((call) => call.path === stateDir));
  assert.ok(calls.every((call) => call.op === "inspect" && (call.path === stateDir || call.path === dirname(stateDir))));
});

test("Windows: an owner-controlled but non-private state directory refuses before minting", () => {
  const { agentDir } = scratch("win-listable-dir");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  // Everyone may list and read (owner-controlled), but the directory is not private.
  const { permissions, calls } = windowsPolicy(stateDir, { dir: [winAce(WIN_EVERYONE, 0x0000_0020 | 0x0000_0001 | 0x0000_0080 | 0x0002_0000 | 0x0010_0000)] });
  let mintCalls = 0;
  assertRefused(__test.readOrCreateWith(agentDir, {
    permissions,
    randomBytes: (size) => {
      mintCalls += 1;
      return Buffer.alloc(size, 0x66);
    },
  }), "unsafe-storage");
  assert.equal(mintCalls, 0);
  assert.deepEqual(readdirSync(stateDir), []);
  assert.ok(calls.every((call) => call.op === "inspect" && (call.path === stateDir || call.path === dirname(stateDir))), "nothing is protected or created");
});

test("Windows: the name store checks session-host and the file, not the agent directory ACL", () => {
  const { agentDir, path } = scratch("win-permissive-agent");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  const serverName = `pi_review_gate_${"77".repeat(16)}`;
  const body = `${JSON.stringify({ version: 1, serverName })}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  const { permissions, calls } = windowsPolicy(stateDir, { agent: WIN_PERMISSIVE });
  assert.deepEqual(__test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x33), permissions }), { status: "loaded", serverName });
  assert.deepEqual(__test.readWith(agentDir, { permissions }), { status: "loaded", serverName });
  assert.equal(readFileSync(path, "utf8"), body);
  assert.ok(calls.length > 0 && calls.every((call) => call.op === "inspect" && (call.path === stateDir || call.path === path)));
});

test("Windows: unverifiable protection (helper unavailable) refuses", () => {
  const { agentDir } = scratch("win-unavailable");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  const { permissions } = windowsPolicy(stateDir, { unavailable: true });
  assertRefused(__test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x33), permissions }), "unsafe-storage");
  assert.deepEqual(readdirSync(stateDir), []);
});

test("Windows: a broadly writable name file refuses and is never rewritten", () => {
  const { agentDir, path } = scratch("win-permissive-file");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  const body = `${JSON.stringify({ version: 1, serverName: `pi_review_gate_${"44".repeat(16)}` })}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  const { permissions, calls } = windowsPolicy(stateDir, { file: WIN_PERMISSIVE });
  assertRefused(__test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x33), permissions }), "unsafe-entry");
  assertRefused(__test.readWith(agentDir, { permissions }), "unsafe-entry");
  assert.equal(readFileSync(path, "utf8"), body);
  assert.deepEqual(readdirSync(stateDir), [NATIVE_MCP_SERVER_NAME_FILENAME]);
  assert.ok(calls.every((call) => call.op === "inspect"), "nothing is re-ACL'd");
});

test("Windows: verified private storage protects the temporary before publishing and reopens", () => {
  const { agentDir, path } = scratch("win-private");
  const stateDir = stateDirOf(agentDir);
  prepareStateDir(stateDir);
  const { permissions, calls } = windowsPolicy(stateDir);
  const created = __test.readOrCreateWith(agentDir, { randomBytes: fixedBytes(0x55), permissions });
  const protectIndex = calls.findIndex((call) => call.op === "protect");
  assert.ok(
    calls.slice(0, protectIndex).filter((call) => call.op === "inspect" && call.path === stateDir).length >= 2,
    "the directory is proven private (not only owner-controlled) before the temporary exists",
  );
  const name = `pi_review_gate_${"55".repeat(16)}`;
  assert.deepEqual(created, { status: "created", serverName: name });
  const protects = calls.filter((call) => call.op === "protect");
  assert.equal(protects.length, 1);
  assert.equal(protects[0].kind, "file");
  assert.notEqual(protects[0].path, path, "only the new temporary is protected");
  assert.ok(calls.some((call) => call.op === "inspect" && call.path === path), "the published file is verified");
  assert.deepEqual(__test.readWith(agentDir, { permissions }), { status: "loaded", serverName: name });
  assert.deepEqual(readdirSync(stateDir), [NATIVE_MCP_SERVER_NAME_FILENAME]);
});

test("a failing randomness source refuses and publishes nothing", () => {
  const { agentDir, stateDir } = scratch("no-entropy");
  prepareStateDir(stateDir);
  // A publication-state assertion: the refusal happens before anything is
  // created, so the storage proof comes from the seam's policy.
  const permissions = stateProofPolicy(agentDir);
  const result = __test.readOrCreateWith(agentDir, { randomBytes: () => Buffer.alloc(8), permissions });
  assertRefused(result, "publish-failed");
  assert.deepEqual(readdirSync(stateDir), []);
  assert.deepEqual(__test.readWith(agentDir, { permissions }), { status: "absent" });
});
