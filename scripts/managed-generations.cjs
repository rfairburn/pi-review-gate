"use strict";

// Producer-owned disposable caches, not a general application/process manager.
// The directory entries ARE the inventory. Only this one in-generation record
// describes lifetime; build freshness/version validation remains with producers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { performance } = require("node:perf_hooks");
const RECORD = ".generation.json";
const LOCK = ".admission.lock";
const LIMIT = 5;
const MAX_ENTRIES = 100_000;
const MAX_RECORD = 16 * 1024;

function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (s.isSymbolicLink() || !s.isDirectory() || s.ino <= 0n) throw new Error("unsafe generation directory");
  return { dev: String(s.dev), ino: String(s.ino) };
}
function same(file, expected) {
  try { const s = identity(file); return s.dev === expected.dev && s.ino === expected.ino; } catch { return false; }
}
function snapshot(file) { return fs.lstatSync(file, { bigint: true }); }
function equal(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink; }
function regular(s) { return s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.ino > 0n; }
function fence(root) {
  const resolved = path.resolve(root);
  const chain = [];
  let current = path.parse(resolved).root;
  chain.push([current, identity(current)]);
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    chain.push([current, identity(current)]);
  }
  return () => chain.every(([file, id]) => same(file, id));
}
function read(root, expected) {
  if (!same(root, expected)) throw new Error("generation identity changed");
  const file = path.join(root, RECORD);
  const before = snapshot(file);
  if (!regular(before) || before.size > BigInt(MAX_RECORD)
    || (process.platform !== "win32" && (before.mode & 0o077n) !== 0n)) throw new Error("unsafe generation lifetime record");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  let value;
  try {
    if (!equal(before, fs.fstatSync(fd, { bigint: true }))) throw new Error("generation lifetime record changed");
    const bytes = Buffer.alloc(MAX_RECORD + 1);
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
      if (length > MAX_RECORD) throw new Error("oversized generation lifetime record");
    }
    value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!equal(before, fs.fstatSync(fd, { bigint: true })) || !equal(before, snapshot(file))) throw new Error("generation lifetime record changed");
  } finally { fs.closeSync(fd); }
  if (!value || Object.keys(value).sort().join() !== "holders,root,schema" || value.schema !== 1
    || !value.root || Object.keys(value.root).sort().join() !== "dev,ino"
    || value.root.dev !== expected.dev || value.root.ino !== expected.ino
    || !Array.isArray(value.holders) || value.holders.length > 128
    || value.holders.some((h) => typeof h !== "string" || !/^[a-f0-9]{32}$/u.test(h))
    || new Set(value.holders).size !== value.holders.length) throw new Error("uncertain generation lifetime");
  return { value, stat: before };
}
function write(root, expected, value, previous) {
  if (!same(root, expected)) throw new Error("generation identity changed");
  const file = path.join(root, RECORD);
  if (previous && !equal(previous, snapshot(file))) throw new Error("generation lifetime changed");
  const temp = path.join(root, `.lifetime-${crypto.randomBytes(16).toString("hex")}`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // A failed publication leaves residue INSIDE the counted generation.
  if (!same(root, expected) || (previous && !equal(previous, snapshot(file)))) throw new Error("generation lifetime changed");
  if (previous) fs.renameSync(temp, file);
  else { fs.linkSync(temp, file); fs.unlinkSync(temp); }
}
function locked(root, action) {
  const check = fence(root);
  const file = path.join(root, LOCK);
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch { throw new Error("generation capacity admission is busy or uncertain; retry after the producer settles"); }
  const id = fs.fstatSync(fd, { bigint: true });
  try {
    if (!check() || !equal(id, snapshot(file))) throw new Error("generation cache identity changed");
    return action(check);
  } finally {
    fs.closeSync(fd);
    try { if (check() && equal(id, snapshot(file))) fs.unlinkSync(file); } catch { /* Retain uncertain admission ownership. */ }
  }
}
function control(root, name) {
  // Existing #375 freshness records are NOT lifetime or capacity indexes.
  if (!/^(?:source-[a-f0-9]{64}\.json|\.source-build-[a-f0-9]{64}\.lock)$/u.test(name)) return false;
  return regular(snapshot(path.join(root, name)));
}
function entries(root) {
  const names = [];
  const dir = fs.opendirSync(root);
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (entry.name === LOCK || control(root, entry.name)) continue;
      names.push(entry.name);
      if (names.length > MAX_ENTRIES) throw new Error("generation capacity inventory exceeded its bound");
    }
  } finally { dir.closeSync(); }
  return names.sort();
}
// Fixed native metadata queries only: never consult PATH, cache files, or
// caller-selected commands. A listing is not a recursive filesystem inventory.
const MAX_MOUNTS = 4 * 1024 * 1024;
function nativeMounts(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error("cleanup deadline exceeded");
  let command, args;
  if (process.platform === "linux") { command = "/bin/cat"; args = ["/proc/self/mountinfo"]; }
  else if (process.platform === "darwin") { command = "/sbin/mount"; args = []; }
  else throw new Error("native mount evidence unsupported");
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8", env: { LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(1000, remaining), killSignal: "SIGKILL", maxBuffer: MAX_MOUNTS,
  });
  if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== "string"
    || !result.stdout.endsWith("\n") || Buffer.byteLength(result.stdout) > MAX_MOUNTS
    || performance.now() >= deadline) throw new Error("native mount evidence unavailable or exceeded its bound");
  return result.stdout;
}
function linuxMountedPath(value) {
  // Linux mountinfo escapes whitespace and backslashes.
  if (/\\(?!040|011|012|134)/u.test(value) || /[\0\r]/u.test(value)) throw new Error("ambiguous mount path");
  const decoded = value.replace(/\\(040|011|012|134)/gu, (_, code) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code]);
  if (!decoded.startsWith("/") || path.posix.normalize(decoded) !== decoded) throw new Error("noncanonical mount path");
  return decoded;
}
function mountFence(root, deadline) {
  // Darwin's literal, line-oriented listing cannot disambiguate a cache prefix
  // containing its own record/field delimiters. Do not interpret it as safe.
  if (process.platform === "darwin" && (/[\0\r\n]/u.test(root) || root.includes(" on ") || root.includes(" ("))) throw new Error("ambiguous native cache path");
  const evidence = nativeMounts(deadline);
  const lines = evidence.slice(0, -1).split("\n");
  if (lines.length > MAX_ENTRIES) throw new Error("mount metadata exceeded its bound");
  for (const line of lines) {
    let mounted;
    if (process.platform === "linux") {
      const fields = line.split(" ");
      const separator = fields.indexOf("-", 6);
      if (separator < 6 || fields.length !== separator + 4 || fields.some((field) => !field)
        || !/^\d+$/u.test(fields[0]) || !/^\d+$/u.test(fields[1]) || !/^\d+:\d+$/u.test(fields[2])) throw new Error("ambiguous mountinfo");
      linuxMountedPath(fields[3]);
      mounted = linuxMountedPath(fields[4]);
    } else {
      const parts = line.split(" on ");
      if (parts.length !== 2 || !parts[0]) throw new Error("ambiguous native mount listing");
      const match = /^(\/.*?) \([^()\n]+\)$/u.exec(parts[1]);
      if (!match || match[1].includes(" (")) throw new Error("ambiguous native mount listing");
      // Darwin mount(8) prints paths literally, including sequences such as
      // \\040. Linux octal decoding here can hide a mounted descendant.
      mounted = match[1];
      if (/[\0\r]/u.test(mounted) || path.posix.normalize(mounted) !== mounted) throw new Error("ambiguous native mount path");
    }
    if (mounted === root || mounted.startsWith(root + path.sep)) throw new Error("mounted generation subtree");
  }
  // Even unrelated changes invalidate cached evidence. Requery before opening
  // each directory and before EVERY deletion, then recheck path identities;
  // non-following leaf metadata reads need no native subprocess.
  return () => nativeMounts(deadline) === evidence;
}
function remove(root, expected, check) {
  // Public Node cannot exclude every native reparse type or prove Windows
  // descendants settled. Never translate direct-child close into reclamation.
  if (process.platform === "win32") return false;
  try {
    root = path.resolve(root);
    // Include native-query cost in a bounded dependency-sized cleanup budget.
    const deadline = performance.now() + 180_000;
    const mountsUnchanged = mountFence(root, deadline);
    if (!check() || !same(root, expected) || read(root, expected).value.holders.length !== 0) return false;
    const nodes = [];
    function visit(file, depth, ancestors = []) {
      if (performance.now() >= deadline || !check() || !same(root, expected) || depth > 64 || nodes.length >= MAX_ENTRIES) throw new Error("cleanup bound or identity changed");
      const stat = snapshot(file);
      const node = { file, stat, ancestors };
      nodes.push(node);
      if (stat.ino <= 0n || String(stat.dev) !== expected.dev) throw new Error("cleanup identity unavailable or crossed device");
      if (stat.isSymbolicLink()) {
        if (stat.nlink !== 1n) throw new Error("hardlinked cleanup symlink");
        const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
        if (!target.startsWith(root + path.sep)) throw new Error("out-of-generation link");
        // Unlink only; never descend through a link (including .bin shims).
      } else if (stat.isDirectory()) {
        if (!mountsUnchanged() || !check() || !same(root, expected)
          || !ancestors.every(([ancestor, id]) => same(ancestor, id))
          || !equal(stat, snapshot(file))) throw new Error("cleanup mount or directory identity changed");
        const dir = fs.opendirSync(file);
        try {
          let child;
          while ((child = dir.readSync())) {
            // No traversal or recursive ancestor deletion of Terraform trees.
            if (child.name === ".terraform") throw new Error("excluded subtree");
            visit(path.join(file, child.name), depth + 1, [...ancestors, [file, { dev: String(stat.dev), ino: String(stat.ino) }]]);
          }
        } finally { dir.closeSync(); }
      } else if (!regular(stat)) throw new Error("unsafe cleanup entry");
    }
    visit(root, 0);
    // Check the complete tree before the first deletion. No fs.rm on an
    // unverified ancestor; partial failure keeps the root and counts it.
    for (const node of nodes) if (!equal(node.stat, snapshot(node.file))) return false;
    // Keep the lifetime record until last so partial cleanup remains accountable.
    const record = nodes.find((n) => n.file === path.join(root, RECORD));
    const deletion = nodes.filter((n) => n.file !== root && n !== record).reverse();
    for (const node of [...deletion, record]) {
      if (!node || !mountsUnchanged() || !check() || !same(root, expected) || !node.ancestors.every(([file, id]) => same(file, id))) return false;
      // Directory timestamps change during our own child removal; identity
      // and type still must match. Files/links require the full snapshot.
      const now = snapshot(node.file);
      if (node.stat.isDirectory()) {
        if (!same(node.file, { dev: String(node.stat.dev), ino: String(node.stat.ino) })) return false;
        fs.rmdirSync(node.file);
      } else {
        if (!equal(node.stat, now)) return false;
        fs.unlinkSync(node.file);
      }
    }
    if (!mountsUnchanged() || !check() || !same(root, expected)) return false;
    fs.rmdirSync(root);
    return true;
  } catch { return false; }
}
function handle(cacheRoot, root, expected, token) {
  let released = false;
  const check = fence(root);
  return {
    root,
    // Explicit positive settlement only; no PID-age, time, missing-pin, or
    // checkpoint-existence heuristics. Crash/uncertainty leaves the pin durable.
    release() {
      if (released) return true;
      try {
        return locked(cacheRoot, (parentCheck) => {
          if (!parentCheck() || !check()) return false;
          const { value, stat } = read(root, expected);
          if (!value.holders.includes(token)) return false;
          value.holders = value.holders.filter((h) => h !== token);
          write(root, expected, value, stat);
          released = true;
          return true;
        });
      } catch { return false; }
    },
  };
}
function admit(cacheRoot, create, beforeReclaim = () => undefined, replacement) {
  return locked(cacheRoot, (check) => {
    let inventory = entries(cacheRoot);
    if (replacement) {
      // A producer may retry one incomplete generation without waiting for
      // capacity pressure. Identity, zero holders, eligibility, removal and
      // the replacement reservation all share this SAME admission lock.
      const root = path.resolve(replacement.root);
      const expected = { dev: String(replacement.identity.dev), ino: String(replacement.identity.ino) };
      if (path.dirname(root) !== path.resolve(cacheRoot) || path.basename(root) === ".terraform"
        || !inventory.includes(path.basename(root)) || !same(root, expected)
        || read(root, expected).value.holders.length !== 0 || replacement.eligible() !== true
        || !remove(root, expected, check)) {
        throw new Error("generation replacement refused: active, uncertain, changed or unsafe generation retained");
      }
      inventory = inventory.filter((name) => name !== path.basename(root));
    }
    for (const name of inventory) {
      if (inventory.length < LIMIT) break;
      if (name === ".terraform") continue; // Count, but never enter the excluded subtree.
      const root = path.join(cacheRoot, name);
      try {
        const id = identity(root);
        if (read(root, id).value.holders.length !== 0) continue;
        const retire = beforeReclaim(root);
        if (remove(root, id, check)) {
          inventory = inventory.filter((entry) => entry !== name);
          // Retire a producer's existing freshness pointer only AFTER its
          // generation is gone. This is not another capacity/lifetime index.
          try { retire?.(); } catch { /* Stale pointer remains non-reusable. */ }
        }
      } catch { /* Legacy/malformed/replaced entries count and remain uncertain. */ }
    }
    if (inventory.length >= LIMIT) throw new Error(`generation capacity exhausted: maximum ${LIMIT}; active, uncertain or unsafe generations retained`);
    if (!check()) throw new Error("generation cache identity changed");
    // Creation + lifetime reservation are under the same exclusive admission.
    const stage = create();
    try {
      if (path.dirname(stage.root) !== path.resolve(cacheRoot) || !check()) throw new Error("generation escaped cache");
      const expected = identity(stage.root);
      const token = crypto.randomBytes(16).toString("hex");
      write(stage.root, expected, { schema: 1, root: expected, holders: [token] });
      stage.generation = handle(cacheRoot, stage.root, expected, token);
      return stage;
    } catch (error) {
      error.retainedStage = true; // Failed metadata/setup remains a counted root.
      throw error;
    }
  });
}
function pin(cacheRoot, select) {
  return locked(cacheRoot, (check) => {
    const selected = select();
    if (!selected) return undefined;
    const root = selected.root;
    if (path.dirname(root) !== path.resolve(cacheRoot) || !check()) throw new Error("generation escaped cache");
    const expected = identity(root);
    let lifetime;
    try { lifetime = read(root, expected); }
    catch (error) {
      // Legacy selection stays protected forever; absence is NOT inactivity.
      // Do not synthesize metadata or invalidate independently validated reuse.
      if (error.code === "ENOENT") return { selected, generation: undefined };
      throw error;
    }
    const { value, stat } = lifetime;
    if (value.holders.length >= 128) throw new Error("generation consumer capacity exhausted");
    const token = crypto.randomBytes(16).toString("hex");
    value.holders.push(token);
    write(root, expected, value, stat);
    return { selected, generation: handle(cacheRoot, root, expected, token) };
  });
}
module.exports = { RECORD, LIMIT, admit, pin };
