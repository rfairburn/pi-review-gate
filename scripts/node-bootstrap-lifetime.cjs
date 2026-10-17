"use strict";

// One native-friendly Node lifetime, shared with the pre-Node wrappers. This
// is NOT a CJS generation inventory/index. CJS can only publish quiescence;
// the still-pinned wrapper alone publishes inactivity after exact process exit.
const fs = require("node:fs");
const path = require("node:path");
const ROOT_ENV = "PI_REVIEW_GATE_NODE_GENERATION";
const TOKEN_ENV = "PI_REVIEW_GATE_NODE_HOLDER";
const RECORD = ".node-lifetime";
function consume(env) {
  const root = env[ROOT_ENV];
  const token = env[TOKEN_ENV];
  for (const name of Object.keys(env)) {
    if ([ROOT_ENV, TOKEN_ENV].includes(name.toUpperCase())) delete env[name];
  }
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof token !== "string"
    || !/^bootstrap[.-][a-zA-Z0-9.-]+$/u.test(token) || path.basename(root) !== token
    || path.basename(path.dirname(root)) !== "node" || path.basename(path.dirname(path.dirname(root))) !== ".pi-review-gate") return () => false;
  // Windows native identities/reparse protection are the wrapper's concern.
  // Until native reclamation is proven, CJS never grants Windows quiescence.
  if (process.platform === "win32") return () => false;
  let chain;
  const identity = (file) => {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.ino <= 0n) throw new Error("unsafe Node lifetime directory");
    return `${s.dev}:${s.ino}`;
  };
  try {
    chain = [];
    let current = path.parse(root).root;
    chain.push([current, identity(current)]);
    for (const part of root.slice(current.length).split(path.sep)) {
      if (!part || part === "." || part === "..") throw new Error("noncanonical Node lifetime path");
      current = path.join(current, part);
      chain.push([current, identity(current)]);
    }
  } catch { return () => false; }
  return () => {
    const cache = path.dirname(root);
    const lock = path.join(cache, ".admission.lock");
    let lockFd;
    let lockStat;
    const check = () => chain.every(([file, id]) => identity(file) === id);
    const equal = (a, b) => ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);
    try {
      if (!check()) return false;
      lockFd = fs.openSync(lock, "wx", 0o600);
      lockStat = fs.fstatSync(lockFd, { bigint: true });
      if (lockStat.ino <= 0n || !check()) return false;
      const file = path.join(root, RECORD);
      const before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.ino <= 0n || before.nlink !== 1n || before.size > 4096n || (before.mode & 0o077n) !== 0n) return false;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let text;
      try {
        if (!equal(before, fs.fstatSync(fd, { bigint: true }))) return false;
        const bytes = Buffer.alloc(4097);
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (length > 4096 || !equal(before, fs.fstatSync(fd, { bigint: true }))) return false;
        text = bytes.subarray(0, length).toString("utf8");
      } finally { fs.closeSync(fd); }
      const expected = `pi-review-gate-node-v1\n${chain[chain.length - 1][1]}\n${token}\nprotected\n`;
      if (text !== expected || !check() || !equal(before, fs.lstatSync(file, { bigint: true }))) return false;
      const next = path.join(root, ".node-lifetime-next");
      const out = fs.openSync(next, "wx", 0o600);
      try { fs.writeFileSync(out, expected.replace(/protected\n$/u, "quiescent\n")); fs.fsyncSync(out); }
      finally { fs.closeSync(out); }
      if (!check() || !equal(before, fs.lstatSync(file, { bigint: true }))) return false;
      fs.renameSync(next, file);
      return true;
    } catch { return false; }
    finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        try { if (check() && equal(lockStat, fs.lstatSync(lock, { bigint: true }))) fs.unlinkSync(lock); } catch { /* Retain uncertain lock. */ }
      }
    }
  };
}
module.exports = { consume, ROOT_ENV, TOKEN_ENV, RECORD };
