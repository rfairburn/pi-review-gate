/**
 * #682: dormant Darwin inbox endpoint proof.
 *
 * Portable legs drive the proof through injected filesystem and ACL-listing
 * seams (a fake Darwin namespace with the fixed `/tmp`/`/var` aliases), through
 * the real local filesystem (real sockets, real dev/ino, real replacement)
 * with a listing fake, and through the real bounded listing executor using
 * the Node binary as a stand-in child. Darwin-only legs use the real
 * `/bin/ls -ilde` and real `chmod +a` ACLs and are skipped elsewhere. Nothing
 * here starts Claude, contacts a provider, or activates the module.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import test, { after } from "node:test";

import {
  CLAUDE_DARWIN_ACL_ENV,
  CLAUDE_DARWIN_ACL_TOOL,
  CLAUDE_DARWIN_PROOF_MAX_AGE_MS,
  claudeDarwinAclListingExecutor,
  classifyClaudeDarwinAclListing,
  proveClaudeDarwinInboxEndpoint,
  readClaudeDarwinInboxEndpointProof,
  type ClaudeDarwinAclExecOptions,
  type ClaudeDarwinAclExecResult,
  type ClaudeDarwinFsProbe,
  type ClaudeDarwinInboxEndpointProof,
  type ClaudeDarwinInboxProofOptions,
  type ClaudeDarwinInboxProofRequest,
  type ClaudeDarwinInboxProofResult,
  type ClaudeDarwinLstat,
} from "../src/session-host/native-claude-darwin-inbox-endpoint";

const DARWIN_SKIP = process.platform === "darwin" ? false : "real /bin/ls -ilde ACL listings and chmod +a require macOS";
const POSIX_SKIP = process.platform === "win32" ? "Unix domain sockets and POSIX ownership are not available on Windows" : false;

const UID = 501;
const TYPE = { dir: 0o040000n, link: 0o120000n, sock: 0o140000n, file: 0o100000n } as const;
type Kind = keyof typeof TYPE;
let inoSeq = 1000n;

function node(kind: Kind, uid: number, perm: number): ClaudeDarwinLstat {
  inoSeq += 1n;
  return { dev: 16777220n, ino: inoSeq, uid: BigInt(uid), mode: TYPE[kind] | BigInt(perm), ctimeNs: 1_700_000_000_000_000_000n + inoSeq };
}

/** Independent strmode for the fake listing generator. */
function perms(mode: bigint): string {
  const m = Number(mode & 0o7777n);
  const t = (r: number, w: number, x: number, s: number, on: string, off: string): string =>
    `${m & r ? "r" : "-"}${m & w ? "w" : "-"}${m & s ? (m & x ? on : off) : (m & x ? "x" : "-")}`;
  return t(0o400, 0o200, 0o100, 0o4000, "s", "S") + t(0o040, 0o020, 0o010, 0o2000, "s", "S") + t(0o004, 0o002, 0o001, 0o1000, "t", "T");
}

function typeChar(mode: bigint): string {
  const type = mode & 0o170000n;
  return type === TYPE.dir ? "d" : type === TYPE.link ? "l" : type === TYPE.sock ? "s" : "-";
}

const FAKE_INO = 1234n;

/** A complete `ls -ilde` listing in the C locale, as the fake child prints it. */
function listing(path: string, mode: bigint, entries: readonly string[] = [], marker?: string, ino: bigint = FAKE_INO, target?: string): Buffer {
  const mark = marker ?? (entries.length > 0 ? "+" : "");
  const name = target === undefined ? path : `${path} -> ${target}`;
  const lines = [`${ino} ${typeChar(mode)}${perms(mode)}${mark} 1 someone  staff  0 Jan  1 00:00 ${name}`];
  entries.forEach((entry, index) => lines.push(` ${index}: ${entry}`));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

interface AclCall {
  readonly tool: string;
  readonly args: readonly string[];
  readonly options: ClaudeDarwinAclExecOptions;
}

class World {
  readonly stats = new Map<string, ClaudeDarwinLstat>();
  readonly links = new Map<string, string>();
  readonly acl = new Map<string, string[]>();
  readonly aclCalls: AclCall[] = [];
  readonly lstatCalls: string[] = [];
  lstatHook?: (path: string) => Promise<void> | void;
  /** One-shot per-path lstat answers, consumed before the stored state. */
  readonly lstatOnce = new Map<string, ClaudeDarwinLstat>();
  aclHook?: (path: string, options: ClaudeDarwinAclExecOptions) => Promise<ClaudeDarwinAclExecResult | undefined> | ClaudeDarwinAclExecResult | undefined;

  readonly fs: ClaudeDarwinFsProbe = {
    lstat: async (path) => {
      this.lstatCalls.push(path);
      await this.lstatHook?.(path);
      const once = this.lstatOnce.get(path);
      if (once !== undefined) {
        this.lstatOnce.delete(path);
        return once;
      }
      const stats = this.stats.get(path);
      if (stats === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return stats;
    },
    readlink: async (path) => {
      const target = this.links.get(path);
      if (target === undefined) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
      return target;
    },
  };

  readonly executor = async (tool: string, args: readonly string[], options: ClaudeDarwinAclExecOptions): Promise<ClaudeDarwinAclExecResult> => {
    this.aclCalls.push({ tool, args: [...args], options });
    const path = args[args.length - 1] as string;
    const hooked = await this.aclHook?.(path, options);
    if (hooked !== undefined) return hooked;
    const stats = this.stats.get(path);
    if (stats === undefined) return { status: "exited", exitCode: 1, stdout: Buffer.alloc(0) };
    return { status: "exited", exitCode: 0, stdout: this.listingFor(path) };
  };

  /** The listing the real child would print for the current fake state. */
  listingFor(path: string): Buffer {
    const stats = this.stats.get(path) as ClaudeDarwinLstat;
    const target = (stats.mode & 0o170000n) === TYPE.link ? this.links.get(path) : undefined;
    return listing(path, stats.mode, this.acl.get(path), undefined, stats.ino, target);
  }

  set(path: string, kind: Kind, uid: number, perm: number): ClaudeDarwinLstat {
    const stats = node(kind, uid, perm);
    this.stats.set(path, stats);
    return stats;
  }

  /** Create owned 0700 directories and an owned socket at a canonical path. */
  addSocket(canonical: string): ClaudeDarwinLstat {
    const parts = canonical.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const dir = `/${parts.slice(0, index).join("/")}`;
      if (!this.stats.has(dir)) this.set(dir, "dir", UID, 0o700);
    }
    return this.set(canonical, "sock", UID, 0o600);
  }

  options(extra: Partial<ClaudeDarwinInboxProofOptions> = {}): ClaudeDarwinInboxProofOptions {
    return { platform: "darwin", getuid: () => UID, fs: this.fs, aclExecutor: this.executor, ...extra };
  }
}

const VAR_SOCKET = "/var/folders/zz/abc123/T/claude-1/inbox.sock";
const VAR_CANONICAL = `/private${VAR_SOCKET}`;
const TMP_SOCKET = "/tmp/claude-2/i.sock";
const TMP_CANONICAL = `/private${TMP_SOCKET}`;

function darwinWorld(): World {
  const w = new World();
  w.set("/", "dir", 0, 0o755);
  w.set("/bin/ls", "file", 0, 0o755);
  w.set("/tmp", "link", 0, 0o755);
  w.links.set("/tmp", "private/tmp");
  w.set("/var", "link", 0, 0o755);
  w.links.set("/var", "private/var");
  w.set("/etc", "link", 0, 0o755);
  w.links.set("/etc", "private/etc");
  w.set("/private", "dir", 0, 0o755);
  w.set("/private/tmp", "dir", 0, 0o1777);
  w.set("/private/var", "dir", 0, 0o755);
  w.set("/private/etc", "dir", 0, 0o755);
  w.set("/private/var/folders", "dir", 0, 0o755);
  w.set("/private/var/folders/zz", "dir", 0, 0o755);
  w.set("/private/var/folders/zz/abc123", "dir", UID, 0o755);
  w.addSocket(VAR_CANONICAL);
  w.addSocket(TMP_CANONICAL);
  w.set("/Users", "dir", 0, 0o755);
  w.acl.set("/Users", ["group:everyone deny delete"]);
  return w;
}

function request(socketPath: string, extra: Partial<ClaudeDarwinInboxProofRequest> = {}): ClaudeDarwinInboxProofRequest {
  return { socketPath, isCurrent: () => true, ...extra };
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function expectRefusal(label: string, run: Promise<ClaudeDarwinInboxProofResult>, reason: string): Promise<void> {
  const result = await within(run, 5000, label);
  assert.deepEqual(result, { ok: false, reason }, label);
  assert.ok(Object.isFrozen(result), `${label}: refusal is frozen`);
}

async function expectProof(label: string, run: Promise<ClaudeDarwinInboxProofResult>): Promise<ClaudeDarwinInboxEndpointProof> {
  const result = await within(run, 5000, label);
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
  return (result as { proof: ClaudeDarwinInboxEndpointProof }).proof;
}

test("importing the module is inert and non-Darwin platforms are refused before any probe", async () => {
  const w = darwinWorld();
  for (const platform of ["linux", "win32", "freebsd", "aix"] as NodeJS.Platform[]) {
    await expectRefusal(platform, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options({ platform })), "unsupported_platform");
  }
  await expectRefusal("no uid", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options({ getuid: () => undefined })), "unsupported_platform");
  assert.equal(w.lstatCalls.length, 0);
  assert.equal(w.aclCalls.length, 0);
});

test("accepts the fixed /var alias after root-owned symlink proof and lists ACLs with the exact fixed argv and env", async () => {
  const w = darwinWorld();
  const proof = await expectProof("var alias", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()));
  const values = readClaudeDarwinInboxEndpointProof(proof);
  assert.ok(values);
  const socket = w.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat;
  assert.deepEqual(values, { canonicalPath: VAR_CANONICAL, endpoint: { dev: socket.dev, ino: socket.ino, uid: UID }, aclEvidence: "absent" });
  assert.deepEqual(w.aclCalls.map((call) => call.args[2]), [
    "/", "/var", "/private", "/private/var", "/private/var/folders", "/private/var/folders/zz",
    "/private/var/folders/zz/abc123", "/private/var/folders/zz/abc123/T", "/private/var/folders/zz/abc123/T/claude-1", VAR_CANONICAL,
  ], "every canonical ancestor, the alias symlink, and the socket are listed");
  for (const call of w.aclCalls) {
    assert.equal(call.tool, "/bin/ls");
    assert.equal(call.args.length, 3);
    assert.deepEqual(call.args.slice(0, 2), ["-ilde", "--"]);
    assert.deepEqual({ ...call.options.env }, { LC_ALL: "C", LANG: "C" }, "only the pinned locale reaches the child");
    assert.ok(call.options.maxOutputBytes > 0 && call.options.timeoutMs > 0);
  }
  assert.equal(CLAUDE_DARWIN_ACL_TOOL, "/bin/ls");
  assert.deepEqual({ ...CLAUDE_DARWIN_ACL_ENV }, { LC_ALL: "C", LANG: "C" });
});

test("accepts the /tmp alias under sticky /private/tmp and an already canonical spelling without alias listing", async () => {
  const w = darwinWorld();
  const proof = await expectProof("tmp alias", proveClaudeDarwinInboxEndpoint(request(TMP_SOCKET), w.options()));
  assert.equal(readClaudeDarwinInboxEndpointProof(proof)?.canonicalPath, TMP_CANONICAL);

  const direct = darwinWorld();
  const canonical = await expectProof("canonical", proveClaudeDarwinInboxEndpoint(request(TMP_CANONICAL), direct.options()));
  assert.equal(readClaudeDarwinInboxEndpointProof(canonical)?.canonicalPath, TMP_CANONICAL);
  assert.ok(!direct.aclCalls.some((call) => call.args[2] === "/tmp"), "no alias was used, so none is listed");
});

test("refuses every alias that is not the exact root-owned stock Darwin symlink, and any other symlink", async () => {
  const cases: Array<[string, (w: World) => void, string, string]> = [
    ["absolute target", (w) => w.links.set("/tmp", "/private/tmp"), TMP_SOCKET, "alias_refused"],
    ["foreign target", (w) => w.links.set("/tmp", "private/tmp2"), TMP_SOCKET, "alias_refused"],
    ["dotted target", (w) => w.links.set("/var", "./private/var"), VAR_SOCKET, "alias_refused"],
    ["user-owned alias", (w) => w.set("/tmp", "link", UID, 0o755), TMP_SOCKET, "alias_refused"],
    ["alias is a directory", (w) => w.set("/tmp", "dir", 0, 0o1777), TMP_SOCKET, "alias_refused"],
    ["alias missing", (w) => { w.stats.delete("/var"); }, VAR_SOCKET, "alias_refused"],
    ["readlink fails", (w) => { w.links.delete("/var"); }, VAR_SOCKET, "alias_refused"],
    ["writable root", (w) => w.set("/", "dir", 0, 0o777), TMP_SOCKET, "endpoint_unprotected"],
  ];
  for (const [label, mutate, path, reason] of cases) {
    const w = darwinWorld();
    mutate(w);
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(path), w.options()), reason);
  }
  // /etc -> private/etc is a real Darwin alias but not a fixed accepted one.
  const etc = darwinWorld();
  etc.addSocket("/private/etc/x/s.sock");
  await expectRefusal("unfixed alias", proveClaudeDarwinInboxEndpoint(request("/etc/x/s.sock"), etc.options()), "endpoint_unprotected");
  // An arbitrary symlink anywhere deeper is never followed.
  const deep = darwinWorld();
  deep.set("/private/tmp/claude-2", "link", UID, 0o755);
  deep.links.set("/private/tmp/claude-2", "/private/var/folders/zz/abc123/T/claude-1");
  await expectRefusal("deep symlink", proveClaudeDarwinInboxEndpoint(request(TMP_SOCKET), deep.options()), "endpoint_unprotected");
  // The symlinked spelling of an alias ancestor is not accepted as canonical.
  const canonicalLink = darwinWorld();
  canonicalLink.set("/private/var", "link", 0, 0o755);
  canonicalLink.links.set("/private/var", "var");
  await expectRefusal("symlinked canonical ancestor", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), canonicalLink.options()), "endpoint_unprotected");
});

test("refuses writable namespaces with Linux mode/owner/sticky rules on canonical ancestors", async () => {
  const cases: Array<[string, (w: World) => void]> = [
    ["foreign-owned ancestor", (w) => w.set("/private/var/folders/zz/abc123/T", "dir", 777, 0o700)],
    ["group-writable non-sticky ancestor", (w) => w.set("/private/var/folders/zz", "dir", 0, 0o775)],
    ["world-writable non-sticky parent", (w) => w.set("/private/var/folders/zz/abc123/T/claude-1", "dir", UID, 0o777)],
    ["sticky parent with foreign child dir", (w) => {
      w.set("/private/var/folders/zz/abc123/T", "dir", UID, 0o1777);
      w.set("/private/var/folders/zz/abc123/T/claude-1", "dir", 777, 0o700);
    }],
    ["ancestor is a file", (w) => w.set("/private/var/folders/zz/abc123/T/claude-1", "file", UID, 0o700)],
  ];
  for (const [label, mutate] of cases) {
    const w = darwinWorld();
    mutate(w);
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "endpoint_unprotected");
  }
  const missing = darwinWorld();
  missing.stats.delete("/private/var/folders/zz");
  await expectRefusal("missing ancestor", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), missing.options()), "endpoint_unavailable");
});

test("checks socket type, current uid, and the captured dev/ino/uid exactly", async () => {
  const typed = darwinWorld();
  typed.set(VAR_CANONICAL, "file", UID, 0o600);
  await expectRefusal("regular file", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), typed.options()), "endpoint_mismatch");
  const foreign = darwinWorld();
  foreign.set(VAR_CANONICAL, "sock", 777, 0o600);
  await expectRefusal("foreign socket", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), foreign.options()), "endpoint_mismatch");
  const rootSock = darwinWorld();
  rootSock.set(VAR_CANONICAL, "sock", 0, 0o600);
  await expectRefusal("root socket is not the current user's", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), rootSock.options()), "endpoint_mismatch");
  const gone = darwinWorld();
  gone.stats.delete(VAR_CANONICAL);
  await expectRefusal("missing socket", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), gone.options()), "endpoint_unavailable");

  const w = darwinWorld();
  const socket = w.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat;
  const expected = { dev: socket.dev, ino: socket.ino, uid: UID };
  await expectProof("matching identity", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { expectedEndpoint: expected }), w.options()));
  for (const [label, identity] of [
    ["ino", { ...expected, ino: socket.ino + 1n }],
    ["dev", { ...expected, dev: socket.dev + 1n }],
  ] as const) {
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { expectedEndpoint: identity }), w.options()), "endpoint_mismatch");
  }
  const otherUid = darwinWorld();
  const s2 = otherUid.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat;
  await expectRefusal("captured uid differs", proveClaudeDarwinInboxEndpoint(
    request(VAR_SOCKET, { expectedEndpoint: { dev: s2.dev, ino: s2.ino, uid: UID + 1 } }), otherUid.options()), "endpoint_mismatch");
  await expectRefusal("malformed identity", proveClaudeDarwinInboxEndpoint(
    request(VAR_SOCKET, { expectedEndpoint: { dev: 1n, ino: 0n, uid: UID } }), w.options()), "invalid_request");
});

test("deny-only ACLs are accepted; any allow entry, on an ancestor, the alias, or the socket, declines", async () => {
  const deny = darwinWorld();
  deny.acl.set("/private/var/folders/zz/abc123", ["group:everyone deny delete"]);
  deny.acl.set(VAR_CANONICAL, ["group:everyone inherited deny delete,writeattr", "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000000 deny readsecurity"]);
  const proof = await expectProof("deny only", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), deny.options()));
  assert.equal(readClaudeDarwinInboxEndpointProof(proof)?.aclEvidence, "deny_only");

  const grants: Array<[string, string, string]> = [
    ["socket delete grant (replacement right)", VAR_CANONICAL, "group:everyone allow delete"],
    ["parent add_file grant", "/private/var/folders/zz/abc123/T/claude-1", "group:everyone allow add_file"],
    ["ancestor delete_child grant", "/private/var/folders", "group:staff allow delete_child"],
    ["root grant", "/", "group:everyone allow add_subdirectory"],
    ["alias symlink delete grant", "/var", "group:everyone allow delete"],
    ["read-only grant is still a grant", "/private", "group:everyone allow list,search"],
    ["owner-looking grant is not guessed", VAR_CANONICAL, "user:someone allow delete"],
    ["unresolved principal grant", VAR_CANONICAL, "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000000 allow write"],
  ];
  for (const [label, path, entry] of grants) {
    const w = darwinWorld();
    w.acl.set(path, ["group:everyone deny delete", entry]);
    const result = await within(proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), 5000, label);
    assert.deepEqual(result, { ok: false, reason: "acl_untrusted" }, label);
    assert.ok(!JSON.stringify(result).includes("someone") && !inspect(result).includes("ABCDEFAB"), `${label}: no principal reflected`);
  }
});

test("listing classifier accepts only complete, consistent, fully understood listings", () => {
  const dir = TYPE.dir | 0o755n;
  const sock = TYPE.sock | 0o600n;
  const raw = (text: string): Buffer => Buffer.from(text, "utf8");
  const subject = (kind: "directory" | "socket" | "symlink", mode: bigint, path = "/x", linkTarget?: string) =>
    ({ kind, mode, ino: FAKE_INO, path, linkTarget });
  const d = subject("directory", dir);
  const s = subject("socket", sock, "/s");
  const head = "1234 drwxr-xr-x  2 root  wheel  64 Jan  1 00:00 /x";
  const headAcl = "1234 drwxr-xr-x+ 2 root  wheel  64 Jan  1 00:00 /x";
  assert.equal(classifyClaudeDarwinAclListing(listing("/x", dir), d), "absent");
  assert.equal(classifyClaudeDarwinAclListing(raw(`${head}\n`), d), "absent");
  assert.equal(classifyClaudeDarwinAclListing(raw("  1234 drwxr-xr-x  2 0 0 64 Nov 23  2025 /x\n"), d), "absent", "padded inode, numeric owner, year form");
  assert.equal(classifyClaudeDarwinAclListing(listing("/x", dir, [], "@"), d), "absent", "@ is extended attributes, not an ACL");
  assert.equal(classifyClaudeDarwinAclListing(listing("/x", dir, ["group:everyone deny delete"], "@"), d), "deny_only");
  assert.equal(classifyClaudeDarwinAclListing(raw(`${headAcl}\n  owner: root\n 0: group:everyone deny delete\n`), d), "deny_only");
  assert.equal(classifyClaudeDarwinAclListing(listing("/s", sock, ["group:everyone deny delete,file_inherit"]), s), "deny_only");
  assert.equal(classifyClaudeDarwinAclListing(listing("/s", sock, ["group:everyone allow delete"]), s), "untrusted");
  assert.equal(classifyClaudeDarwinAclListing(raw("1234 srw-------+ 1 a b 0 Jan 1 00:00 /s\n  0:  group:everyone   inherited deny  delete \n"), s), "deny_only", "whitespace runs are tolerated");
  assert.equal(classifyClaudeDarwinAclListing(raw("1234 srw-------+ 1 a b 0 Jan 1 00:00 /s\n 0: group:everyone\tallow delete\n"), s), "untrusted");
  assert.equal(classifyClaudeDarwinAclListing(raw("1234 srw-------+ 1 a b 0 Jan 1 00:00 /s\n 0: group:everyone deny delete\n 1: group:everyone allow delete\n"), s), "untrusted", "mixed deny/allow");
  const link = TYPE.link | 0o755n;
  assert.equal(classifyClaudeDarwinAclListing(listing("/var", link, [], undefined, FAKE_INO, "private/var"), subject("symlink", link, "/var", "private/var")), "absent");

  const unprovable: Array<[string, Buffer, ReturnType<typeof subject>?]> = [
    ["empty", raw("")],
    ["no trailing newline", raw(head)],
    ["leading blank line", raw(`\n${head}\n`)],
    ["blank line inside", raw(`${headAcl}\n\n 0: group:everyone deny delete\n`)],
    ["CR", raw(`${head}\r\n`)],
    ["NUL", raw(`${head}\0\n`)],
    ["invalid UTF-8", Buffer.concat([raw(head), Buffer.from([0xff, 0x0a])])],
    ["oversize", raw(`${headAcl}\n${" 0: group:everyone deny delete\n".repeat(2000)}`)],
    // Header binding: the line must be the complete header for this exact object.
    ["prefix-only header", raw("drwxr-xr-x junk\n")],
    ["prefix-only header with inode", raw("1234 drwxr-xr-x junk\n")],
    ["missing inode column", raw("drwxr-xr-x  2 root  wheel  64 Jan  1 00:00 /x\n")],
    ["truncated pathname", raw("1234 drwxr-xr-x  2 root  wheel  64 Jan  1 00:00 /\n")],
    ["pathname with suffix", raw(`${head}y\n`)],
    ["truncated header", raw("1234 drwxr-xr-x  2 root  wheel  64 Jan\n")],
    ["same mode, different object", listing("/y", dir)],
    ["same path, different inode", listing("/x", dir, [], undefined, FAKE_INO + 1n)],
    ["symlink without target", listing("/var", link), subject("symlink", link, "/var", "private/var")],
    ["symlink with other target", listing("/var", link, [], undefined, FAKE_INO, "private/tmp"), subject("symlink", link, "/var", "private/var")],
    ["symlink subject without proven target", listing("/var", link, [], undefined, FAKE_INO, "private/var"), subject("symlink", link, "/var")],
    ["target on a non-symlink", listing("/x", dir, [], undefined, FAKE_INO, "private/var")],
    ["wrong type char", listing("/x", TYPE.sock | 0o755n)],
    ["permission mismatch", listing("/x", TYPE.dir | 0o775n)],
    ["sticky mismatch", listing("/x", TYPE.dir | 0o1777n), subject("directory", TYPE.dir | 0o777n)],
    ["plus marker without entries", listing("/x", dir, [], "+")],
    ["owner metadata without entries or marker", raw(`${head}\n owner: root\n`)],
    ["owner metadata without entries under @", raw(`${headAcl.replace("+", "@")}\n owner: root\n`)],
    ["owner metadata without entries under +", raw(`${headAcl}\n owner: root\n`)],
    ["entries without marker", listing("/x", dir, ["group:everyone deny delete"], "")],
    ["index gap", raw(`${headAcl}\n 1: group:everyone deny delete\n`)],
    ["duplicate index", raw(`${headAcl}\n 0: group:a deny delete\n 0: group:b deny delete\n`)],
    ["leading zero index", raw(`${headAcl}\n 00: group:a deny delete\n`)],
    ["unknown right", listing("/x", dir, ["group:everyone deny delete,frobnicate"])],
    ["unknown right on allow is unprovable first", listing("/x", dir, ["group:everyone allow frobnicate"])],
    ["empty right", listing("/x", dir, ["group:everyone deny delete,,write"])],
    ["trailing comma", listing("/x", dir, ["group:everyone deny delete,"])],
    ["extra token", listing("/x", dir, ["group:everyone deny delete extra"])],
    ["missing grant", listing("/x", dir, ["group:everyone delete"])],
    ["unknown grant", listing("/x", dir, ["group:everyone permit delete"])],
    ["principal with space", listing("/x", dir, ["group:every one deny delete"])],
    ["empty group name", listing("/x", dir, ["group: deny delete"])],
    ["empty group name, tab separated", listing("/x", dir, ["group:\tdeny delete"])],
    ["empty user name", listing("/x", dir, ["user: deny delete"])],
    ["bare user prefix", listing("/x", dir, ["user deny delete"])],
    ["unsupported owner@ form", listing("/x", dir, ["owner@ deny delete"])],
    ["unsupported everyone@ form", listing("/x", dir, ["everyone@ deny delete"])],
    ["unknown principal kind", listing("/x", dir, ["role:admin deny delete"])],
    ["malformed UUID", listing("/x", dir, ["ABCDEFAB-CDEF-ABCD-EFAB deny delete"])],
    ["principal name with unsupported character", listing("/x", dir, ["group:a/b deny delete"])],
    ["inherited in grant position", listing("/x", dir, ["group:everyone inherited delete"])],
    ["missing rights", listing("/x", dir, ["group:everyone deny"])],
    ["no space after index colon", raw(`${headAcl}\n 0:group:a deny delete\n`)],
    ["foreign dialect", raw(`${headAcl}\nowner@:rwx:allow\n`)],
    ["truncated entry", raw(`${headAcl}\n 0: group:everyone de\n`)],
    ["owner line not first", raw(`${headAcl}\n 0: group:a deny delete\n owner: root\n`)],
    ["second listing line", raw(`${head}\n${head}\n`)],
  ];
  for (const [label, bytes, subj] of unprovable) {
    assert.equal(classifyClaudeDarwinAclListing(bytes, subj ?? d), "unprovable", label);
  }
  assert.equal(classifyClaudeDarwinAclListing(listing("/x", dir), null as never), "unprovable", "no subject");
});

test("every listing-child failure and malformed listing declines with a fixed code", async () => {
  const statuses: ClaudeDarwinAclExecResult[] = [
    { status: "spawn_failed" }, { status: "diagnostic" }, { status: "signaled" }, { status: "truncated" }, { status: "timeout" }, { status: "aborted" },
    { status: "exited", exitCode: 1, stdout: Buffer.from("x\n") },
    { status: "exited", exitCode: 0, stdout: "not a buffer" as unknown as Buffer },
    null as unknown as ClaudeDarwinAclExecResult,
  ];
  for (const status of statuses) {
    const w = darwinWorld();
    w.aclHook = (path) => (path === "/private/var/folders" ? status : undefined);
    await expectRefusal(`child ${JSON.stringify(status)}`, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "acl_probe_failed");
  }
  const throwing = darwinWorld();
  throwing.aclHook = () => { throw new Error("SECRET-STDERR spawn exploded"); };
  const thrown = await within(proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), throwing.options()), 5000, "throwing");
  assert.deepEqual(thrown, { ok: false, reason: "acl_probe_failed" });

  // A well-formed listing that describes some other object is not evidence.
  for (const [label, forge] of [
    ["sibling listing", (w: World) => listing(`${VAR_CANONICAL}x`, (w.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat).mode, [], undefined, (w.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat).ino)],
    ["other inode", (w: World) => listing(VAR_CANONICAL, (w.stats.get(VAR_CANONICAL) as ClaudeDarwinLstat).mode, [], undefined, 99n)],
    ["prefix-only header", () => Buffer.from("srw------- junk\n")],
  ] as const) {
    const w = darwinWorld();
    w.aclHook = (path) => (path === VAR_CANONICAL ? { status: "exited", exitCode: 0, stdout: forge(w) } : undefined);
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "acl_unprovable");
  }

  // A deny entry with no principal is not understood deny-only evidence.
  for (const entry of ["group: deny delete", "owner@ deny delete"]) {
    const w = darwinWorld();
    w.acl.set(VAR_CANONICAL, [entry]);
    await expectRefusal(entry, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "acl_unprovable");
  }

  const malformed = darwinWorld();
  malformed.aclHook = (path) => (path === VAR_CANONICAL
    ? { status: "exited", exitCode: 0, stdout: Buffer.from("srw-------+ 1 a b 0 Jan 1 00:00 x\n 0: user:SECRETNAME deny\n") }
    : undefined);
  const result = await within(proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), malformed.options()), 5000, "malformed");
  assert.deepEqual(result, { ok: false, reason: "acl_unprovable" });
  assert.ok(!JSON.stringify(result).includes("SECRETNAME"));
});

test("the listing tool must be a root-owned, non-writable regular file at the fixed path", async () => {
  const cases: Array<[string, (w: World) => void]> = [
    ["missing", (w) => { w.stats.delete("/bin/ls"); }],
    ["user-owned", (w) => w.set("/bin/ls", "file", UID, 0o755)],
    ["group-writable", (w) => w.set("/bin/ls", "file", 0, 0o775)],
    ["symlink", (w) => w.set("/bin/ls", "link", 0, 0o755)],
  ];
  for (const [label, mutate] of cases) {
    const w = darwinWorld();
    mutate(w);
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "acl_tool_untrusted");
    assert.equal(w.aclCalls.length, 0, `${label}: no child started`);
  }
});

test("an object replaced, re-owned, or re-moded while the ACLs were listed declines as endpoint_replaced", async () => {
  const cases: Array<[string, (w: World) => void]> = [
    ["socket inode replaced", (w) => w.set(VAR_CANONICAL, "sock", UID, 0o600)],
    ["socket removed", (w) => { w.stats.delete(VAR_CANONICAL); }],
    ["parent replaced", (w) => w.set("/private/var/folders/zz/abc123/T/claude-1", "dir", UID, 0o700)],
    ["ancestor re-moded", (w) => {
      const old = w.stats.get("/private/var/folders") as ClaudeDarwinLstat;
      w.stats.set("/private/var/folders", { ...old, mode: old.mode | 0o002n });
    }],
    ["alias retargeted in place", (w) => w.links.set("/var", "private/elsewhere")],
    ["alias replaced", (w) => w.set("/var", "link", 0, 0o755)],
  ];
  for (const [label, mutate] of cases) {
    const w = darwinWorld();
    let done = false;
    w.aclHook = (path) => {
      if (path === VAR_CANONICAL && !done) {
        done = true;
        const result: ClaudeDarwinAclExecResult = { status: "exited", exitCode: 0, stdout: w.listingFor(path) };
        mutate(w);
        return result;
      }
      return undefined;
    };
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "endpoint_replaced");
  }
});

test("an ACL rewritten on an already-listed ancestor (same dev/ino/uid/mode, new ctime) declines", async () => {
  const ancestor = "/private/var/folders/zz/abc123";
  for (const [label, trigger, path] of [
    ["ancestor ACL rewritten while the socket is listed", VAR_CANONICAL, ancestor],
    ["root ACL rewritten while a later ancestor is listed", "/private/var/folders", "/"],
    ["alias ACL rewritten while the socket is listed", VAR_CANONICAL, "/var"],
    ["object ACL rewritten during its own listing", ancestor, ancestor],
  ] as const) {
    const w = darwinWorld();
    let done = false;
    w.aclHook = (listed) => {
      if (listed !== trigger || done) return undefined;
      done = true;
      const result: ClaudeDarwinAclExecResult = { status: "exited", exitCode: 0, stdout: w.listingFor(listed) };
      // A chmod +a: only the ACL and ctime change.
      w.acl.set(path, ["group:everyone allow delete_child,add_file"]);
      const old = w.stats.get(path) as ClaudeDarwinLstat;
      w.stats.set(path, { ...old, ctimeNs: old.ctimeNs + 1n });
      return result;
    };
    await expectRefusal(label, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "endpoint_replaced");
    assert.ok(done, `${label}: the mutation ran`);
  }
});

test("an object swapped during its own listing and restored before the final pass still declines", async () => {
  const ancestor = "/private/var/folders/zz/abc123";
  const w = darwinWorld();
  let swapped = false;
  w.aclHook = (path) => {
    // The decoy is visible only until the next listing starts; by pass 2 the
    // path names the original again, so only the per-listing recheck sees it.
    w.lstatOnce.delete(ancestor);
    if (path !== ancestor || swapped) return undefined;
    swapped = true;
    const original = w.stats.get(path) as ClaudeDarwinLstat;
    w.lstatOnce.set(path, { ...original, ino: original.ino + 777n });
    return undefined;
  };
  await expectRefusal("swap and restore", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options()), "endpoint_replaced");
  assert.ok(swapped);
});

test("path syntax and the AF_UNIX byte bound apply to the announced and the proven canonical spelling", async () => {
  const w = darwinWorld();
  for (const bad of ["", "relative/s.sock", "/", "/tmp/x/", "/tmp/../tmp/x", "/tmp//x", "/tmp/./x", "/tmp/x\n0: forged", "/tmp/café", "/tmp/x\0y", "/tmp/\tx"]) {
    await expectRefusal(JSON.stringify(bad), proveClaudeDarwinInboxEndpoint(request(bad), w.options()), "invalid_socket_path");
  }
  await expectRefusal("non-string", proveClaudeDarwinInboxEndpoint(request(42 as unknown as string), w.options()), "invalid_socket_path");

  const nonAlias = `/Users/${"a".repeat(103 - "/Users/".length - "/s".length)}/s`;
  assert.equal(Buffer.byteLength(nonAlias), 103);
  const longOk = darwinWorld();
  longOk.addSocket(nonAlias);
  await expectProof("103-byte canonical path", proveClaudeDarwinInboxEndpoint(request(nonAlias), longOk.options()));
  await expectRefusal("104-byte path", proveClaudeDarwinInboxEndpoint(request(`${nonAlias}x`), longOk.options()), "socket_path_too_long");

  const fits = `/tmp/${"b".repeat(103 - "/private/tmp/".length - "/s".length)}/s`;
  assert.equal(Buffer.byteLength(`/private${fits}`), 103);
  const aliasOk = darwinWorld();
  aliasOk.addSocket(`/private${fits}`);
  await expectProof("alias whose canonical spelling is exactly 103 bytes", proveClaudeDarwinInboxEndpoint(request(fits), aliasOk.options()));
  const overflow = `/tmp/${"b".repeat(103 - "/tmp/".length - "/s".length)}/s`;
  assert.equal(Buffer.byteLength(overflow), 103);
  await expectRefusal("alias canonical spelling over the bound", proveClaudeDarwinInboxEndpoint(request(overflow), aliasOk.options()), "socket_path_too_long");
  assert.ok(!aliasOk.lstatCalls.includes(`/private${overflow}`), "nothing was looked up for an over-long spelling");
});

test("currency: not current, cancellation, and the deadline stop the proof and kill the in-flight child", async () => {
  const w = darwinWorld();
  await expectRefusal("not current at start", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { isCurrent: () => false }), w.options()), "not_current");
  await expectRefusal("throwing predicate", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { isCurrent: () => { throw new Error("x"); } }), w.options()), "not_current");
  await expectRefusal("missing predicate", proveClaudeDarwinInboxEndpoint({ socketPath: VAR_SOCKET } as ClaudeDarwinInboxProofRequest, w.options()), "invalid_request");
  const preAborted = AbortSignal.abort();
  await expectRefusal("pre-aborted", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options({ signal: preAborted })), "cancelled");
  for (const deadlineMs of [0, 49, 30_001, 1.5, Number.NaN]) {
    await expectRefusal(`deadline ${deadlineMs}`, proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), w.options({ deadlineMs })), "invalid_options");
  }

  // Becomes stale mid-proof.
  const stale = darwinWorld();
  let current = true;
  stale.aclHook = (path) => { if (path === "/private") current = false; return undefined; };
  await expectRefusal("stale mid-proof", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { isCurrent: () => current }), stale.options()), "not_current");

  // An abort raised synchronously from inside the predicate is honored.
  const selfAbort = darwinWorld();
  const controller = new AbortController();
  let calls = 0;
  const abortingCurrent = (): boolean => { calls += 1; if (calls === 3) controller.abort(); return true; };
  await expectRefusal("abort from predicate", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { isCurrent: abortingCurrent }), selfAbort.options({ signal: controller.signal })), "cancelled");

  // Cancellation while a listing child is in flight aborts the child's signal.
  const inflight = darwinWorld();
  const cancel = new AbortController();
  let childSignal: AbortSignal | undefined;
  inflight.aclHook = (path, options) => {
    if (path !== "/private/var") return undefined;
    childSignal = options.signal;
    setTimeout(() => cancel.abort(), 10);
    return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "aborted" })));
  };
  await expectRefusal("cancel during listing", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), inflight.options({ signal: cancel.signal })), "cancelled");
  assert.equal(childSignal?.aborted, true, "the in-flight child was told to die");

  // A stalled listing is bounded by the deadline and the child is killed.
  const stalledChild = darwinWorld();
  let stalledSignal: AbortSignal | undefined;
  stalledChild.aclHook = (path, options) => {
    if (path !== VAR_CANONICAL) return undefined;
    stalledSignal = options.signal;
    assert.ok(options.timeoutMs <= 80, "the child timeout never exceeds the remaining budget");
    return new Promise(() => undefined);
  };
  const begun = performance.now();
  await expectRefusal("stalled child", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), stalledChild.options({ deadlineMs: 80 })), "deadline_exceeded");
  assert.ok(performance.now() - begun < 2000);
  assert.equal(stalledSignal?.aborted, true);

  // A stalled lookup is bounded, and the walk never continues once it settles.
  const stalledFs = darwinWorld();
  let release: (() => void) | undefined;
  stalledFs.lstatHook = (path) => (path === "/private/var/folders" ? new Promise<void>((resolve) => { release = resolve; }) : undefined);
  await expectRefusal("stalled lstat", proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET), stalledFs.options({ deadlineMs: 60 })), "deadline_exceeded");
  const lookups = stalledFs.lstatCalls.length;
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stalledFs.lstatCalls.length, lookups, "no lookup started after settlement");
  assert.equal(stalledFs.aclCalls.length, 0);
});

test("a proof is an opaque handle that never serializes values and expires or goes stale", async () => {
  const w = darwinWorld();
  let current = true;
  const result = await proveClaudeDarwinInboxEndpoint(request(VAR_SOCKET, { isCurrent: () => current }), w.options());
  assert.equal(result.ok, true);
  const proof = (result as { proof: ClaudeDarwinInboxEndpointProof }).proof;
  for (const rendered of [JSON.stringify(result), inspect(result, { depth: 10, showHidden: true }), String(proof)]) {
    assert.ok(!rendered.includes("claude-1") && !rendered.includes("inbox.sock") && !rendered.includes("folders"), rendered);
  }
  assert.deepEqual(Object.keys(proof), []);
  assert.ok(readClaudeDarwinInboxEndpointProof(proof));
  assert.equal(readClaudeDarwinInboxEndpointProof(proof, performance.now() + CLAUDE_DARWIN_PROOF_MAX_AGE_MS + 1), undefined, "expired");
  assert.equal(readClaudeDarwinInboxEndpointProof(proof, 0), undefined, "clock before proof");
  current = false;
  assert.equal(readClaudeDarwinInboxEndpointProof(proof), undefined, "no longer current");
  assert.equal(readClaudeDarwinInboxEndpointProof(Object.create(Object.getPrototypeOf(proof)) as ClaudeDarwinInboxEndpointProof), undefined, "look-alike");
  assert.equal(readClaudeDarwinInboxEndpointProof(null as unknown as ClaudeDarwinInboxEndpointProof), undefined);
});

// ---------------------------------------------------------------------------
// Real local filesystem: real sockets, dev/ino, and replacement.
// ---------------------------------------------------------------------------

const scratch = POSIX_SKIP === false ? realpathSync(mkdtempSync(join(tmpdir(), "pcd-"))) : "";
const servers = new Set<Server>();
after(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(path, () => { servers.add(server); resolve(server); });
  });
}

/** Bind a fresh socket beside `path` and rename it over `path` (old inode stays held). */
async function replaceSocket(path: string): Promise<Server> {
  const staging = `${path}.n`;
  const server = await listen(staging);
  renameSync(staging, path);
  return server;
}

function closeServer(server: Server): Promise<void> {
  servers.delete(server);
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Real lstat/readlink. Off Darwin, `/private/<x>` is mapped to the real
 * `/<x>` and `/tmp`/`/var` present as Darwin's root-owned stock symlinks, so
 * the alias proof runs over real inodes. `/bin/ls` presents as root-owned.
 */
function realFs(): ClaudeDarwinFsProbe {
  const darwin = process.platform === "darwin";
  const map = (path: string): string => (!darwin && path.startsWith("/private/") ? path.slice("/private".length) : !darwin && path === "/private" ? "/" : path);
  return {
    lstat: async (path) => {
      if (path === "/bin/ls") return { dev: 1n, ino: 1n, uid: 0n, mode: TYPE.file | 0o755n, ctimeNs: 1n };
      if (!darwin && (path === "/tmp" || path === "/var")) {
        const real = await lstat(path, { bigint: true });
        return { dev: real.dev, ino: real.ino + 1_000_000n, uid: 0n, mode: TYPE.link | 0o755n, ctimeNs: 1n };
      }
      return lstat(map(path), { bigint: true });
    },
    readlink: async (path) => (!darwin && (path === "/tmp" || path === "/var") ? `private${path}` : readlink(path, { encoding: "utf8" })),
  };
}

function realListingExecutor(fs: ClaudeDarwinFsProbe, onSocket?: () => Promise<void>) {
  return async (_tool: string, args: readonly string[]): Promise<ClaudeDarwinAclExecResult> => {
    const path = args[args.length - 1] as string;
    const stats = await fs.lstat(path);
    const target = (stats.mode & 0o170000n) === TYPE.link ? await fs.readlink(path) : undefined;
    const result: ClaudeDarwinAclExecResult = { status: "exited", exitCode: 0, stdout: listing(path, stats.mode, [], undefined, stats.ino, target) };
    if ((stats.mode & 0o170000n) === TYPE.sock) await onSocket?.();
    return result;
  };
}

/**
 * Real shared temp ancestors see unrelated activity (other test files create
 * entries), which legitimately changes their ctime mid-proof and fails closed
 * as `endpoint_replaced`. Real-filesystem legs re-prove a bounded number of
 * times on exactly that code; any other result is returned as is.
 */
async function proveSettled(run: () => Promise<ClaudeDarwinInboxProofResult>): Promise<ClaudeDarwinInboxProofResult> {
  let result = await run();
  for (let attempt = 1; attempt < 4 && !result.ok && result.reason === "endpoint_replaced"; attempt += 1) result = await run();
  return result;
}

function realOptions(fs: ClaudeDarwinFsProbe, onSocket?: () => Promise<void>): ClaudeDarwinInboxProofOptions {
  const uid = process.getuid?.();
  return { platform: "darwin", getuid: () => uid, fs, aclExecutor: realListingExecutor(fs, onSocket) };
}

test("real filesystem: an owned socket proves with its real dev/ino; replacement and stale identity decline", { skip: POSIX_SKIP }, async () => {
  const dir = mkdtempSync(join(scratch, "r-"));
  const socketPath = join(dir, "i.sock");
  const server = await listen(socketPath);
  const fs = realFs();
  const real = lstatSync(socketPath, { bigint: true });
  const proof = await expectProof("real socket", proveSettled(() => proveClaudeDarwinInboxEndpoint(request(socketPath), realOptions(fs))));
  const values = readClaudeDarwinInboxEndpointProof(proof);
  assert.equal(values?.endpoint.dev, real.dev);
  assert.equal(values?.endpoint.ino, real.ino);
  assert.equal(values?.endpoint.uid, process.getuid?.());
  const firstComponent = socketPath.split("/")[1];
  const expectedCanonical = firstComponent === "tmp" || firstComponent === "var" ? `/private${socketPath}` : socketPath;
  assert.equal(values?.canonicalPath, expectedCanonical);

  // Replaced while the socket ACL is listed: a new socket is renamed over the
  // path while the old one is still held open, so its inode cannot be reused.
  let replacement: Server | undefined;
  const replaced = proveClaudeDarwinInboxEndpoint(request(socketPath), realOptions(fs, async () => {
    if (replacement !== undefined) return;
    replacement = await replaceSocket(socketPath);
  }));
  await expectRefusal("replaced during listing", replaced, "endpoint_replaced");
  assert.notEqual(lstatSync(socketPath, { bigint: true }).ino, real.ino, "the fixture really replaced the inode");

  // The host's captured identity is now stale.
  await expectRefusal("stale captured identity", proveClaudeDarwinInboxEndpoint(
    request(socketPath, { expectedEndpoint: { dev: real.dev, ino: real.ino, uid: Number(real.uid) } }), realOptions(fs)), "endpoint_mismatch");

  // Nothing at the path (closing the original server unlinks its bound path).
  await closeServer(server);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  await expectRefusal("socket gone", proveClaudeDarwinInboxEndpoint(request(socketPath), realOptions(fs)), "endpoint_unavailable");
  if (replacement !== undefined) await closeServer(replacement);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Real bounded listing executor (Node stands in for the child binary).
// ---------------------------------------------------------------------------

function execOptions(extra: Partial<ClaudeDarwinAclExecOptions> = {}): ClaudeDarwinAclExecOptions {
  return { timeoutMs: 5000, maxOutputBytes: 4096, env: CLAUDE_DARWIN_ACL_ENV, signal: new AbortController().signal, ...extra };
}

async function waitGone(pid: number): Promise<void> {
  const until = performance.now() + 5000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (performance.now() > until) assert.fail(`child ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readPid(file: string): Promise<number> {
  const until = performance.now() + 5000;
  while (!existsSync(file) || readFileSync(file, "utf8").length === 0) {
    if (performance.now() > until) assert.fail("child never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Number(readFileSync(file, "utf8"));
}

const HANG = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";

test("bounded executor: exact env, stdout only, nonzero exit, signal, and spawn failure", { skip: POSIX_SKIP }, async () => {
  const node = process.execPath;
  const envResult = await claudeDarwinAclListingExecutor(node, ["-e", "process.stdout.write(Object.keys(process.env).sort().join(','))"], execOptions());
  assert.equal(envResult.status, "exited");
  assert.equal(envResult.exitCode, 0);
  const environmentNames = envResult.stdout.toString();
  // Darwin may add this locale bookkeeping at exec time. The separate spawn
  // options assertion still requires precisely LANG and LC_ALL from our code.
  assert.ok(environmentNames === "LANG,LC_ALL"
    || (process.platform === "darwin" && environmentNames === "LANG,LC_ALL,__CF_USER_TEXT_ENCODING"));
  // Any stderr byte, even with exit 0 and a plausible stdout, is a diagnostic;
  // neither stream is reflected in the fixed result.
  for (const script of [
    "process.stderr.write('SECRET-STDERR'); process.stdout.write('1 srw------- 1 a b 0 Jan 1 00:00 /private/SECRET-STDOUT\\n')",
    "process.stdout.write('ok'); process.stderr.write('x'); process.exitCode = 0",
    "process.stderr.write('SECRET-STDERR'); process.exit(1)",
  ]) {
    const diagnostic = await claudeDarwinAclListingExecutor(node, ["-e", script], execOptions());
    assert.deepEqual(diagnostic, { status: "diagnostic" }, script);
    assert.ok(!inspect(diagnostic).includes("SECRET"));
  }
  assert.deepEqual(await claudeDarwinAclListingExecutor(node, ["-e", "process.exit(3)"], execOptions()), { status: "exited", exitCode: 3, stdout: Buffer.alloc(0) });
  assert.deepEqual(await claudeDarwinAclListingExecutor(node, ["-e", "process.kill(process.pid, 'SIGKILL')"], execOptions()), { status: "signaled" });
  assert.deepEqual(await claudeDarwinAclListingExecutor(join(scratch, "no-such-tool"), [], execOptions()), { status: "spawn_failed" });
  // Arguments are passed verbatim, never through a shell.
  const verbatim = await claudeDarwinAclListingExecutor(node, ["-e", "process.stdout.write(process.argv[1])", "$(touch x); `id`"], execOptions());
  assert.deepEqual(verbatim, { status: "exited", exitCode: 0, stdout: Buffer.from("$(touch x); `id`") });
  assert.deepEqual(await claudeDarwinAclListingExecutor(node, ["-e", "1"], execOptions({ signal: AbortSignal.abort() })), { status: "aborted" });
});

test("bounded executor: truncation, timeout, and abort kill the child and resolve promptly", { skip: POSIX_SKIP }, async () => {
  const node = process.execPath;
  const cases: Array<[string, string, (controller: AbortController) => Partial<ClaudeDarwinAclExecOptions>, string]> = [
    ["truncated", `${HANG.split(";")[0]}; process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000);`, () => ({ maxOutputBytes: 1024 }), "truncated"],
    ["timeout", HANG, () => ({ timeoutMs: 150 }), "timeout"],
    ["abort", HANG, (controller) => { setTimeout(() => controller.abort(), 150); return { signal: controller.signal }; }, "aborted"],
  ];
  for (const [label, script, extra, status] of cases) {
    const pidFile = join(scratch, `pid-${label}`);
    const controller = new AbortController();
    const begun = performance.now();
    const result = await within(claudeDarwinAclListingExecutor(node, ["-e", script, pidFile], execOptions(extra(controller))), 5000, label);
    assert.deepEqual(result, { status }, label);
    assert.ok(performance.now() - begun < 5000, label);
    await waitGone(await readPid(pidFile));
    rmSync(pidFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Darwin only: the real /bin/ls -ilde and real ACLs.
// ---------------------------------------------------------------------------

function realDarwinOptions(): ClaudeDarwinInboxProofOptions {
  return { deadlineMs: 15_000 };
}

test("Darwin: real /bin/ls ACL evidence accepts an owned socket and declines replacement-granting ACLs", { skip: DARWIN_SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcdd-"));
  try {
    const socketPath = join(dir, "i.sock");
    const server = await listen(socketPath);
    const expectedCanonical = /^\/(tmp|var)\//u.test(socketPath) ? `/private${socketPath}` : socketPath;
    const prove = (): Promise<ClaudeDarwinInboxProofResult> =>
      proveSettled(() => proveClaudeDarwinInboxEndpoint(request(socketPath), realDarwinOptions()));
    const proof = await expectProof("real owned socket", prove());
    assert.equal(readClaudeDarwinInboxEndpointProof(proof)?.canonicalPath, expectedCanonical);

    // The change detector relies on an ACL change updating ctime; observe it.
    const before = lstatSync(socketPath, { bigint: true }).ctimeNs;
    execFileSync("/bin/chmod", ["+a", "group:everyone deny delete", socketPath]);
    assert.notEqual(lstatSync(socketPath, { bigint: true }).ctimeNs, before, "chmod +a must update ctime");
    const denied = await expectProof("deny-only socket ACL", prove());
    assert.equal(readClaudeDarwinInboxEndpointProof(denied)?.aclEvidence, "deny_only");
    execFileSync("/bin/chmod", ["-N", socketPath]);

    // Allow-only (no deny for the same principal), so the grant is effective.
    execFileSync("/bin/chmod", ["+a", "group:everyone allow delete", socketPath]);
    await expectRefusal("socket delete grant", prove(), "acl_untrusted");
    execFileSync("/bin/chmod", ["-N", socketPath]);

    execFileSync("/bin/chmod", ["+a", "group:everyone allow add_file,delete_child", dir]);
    await expectRefusal("parent child-replacement grant", prove(), "acl_untrusted");
    execFileSync("/bin/chmod", ["-N", dir]);

    const captured = lstatSync(socketPath, { bigint: true });
    const second = await replaceSocket(socketPath);
    await expectRefusal("replaced real socket", proveClaudeDarwinInboxEndpoint(
      request(socketPath, { expectedEndpoint: { dev: captured.dev, ino: captured.ino, uid: Number(captured.uid) } }), realDarwinOptions()), "endpoint_mismatch");
    await closeServer(server);
    await closeServer(second);
  } finally {
    try {
      execFileSync("/bin/chmod", ["-R", "-N", dir], { stdio: "ignore", timeout: 15_000 });
    } catch {
      // No ACL left to clear.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
