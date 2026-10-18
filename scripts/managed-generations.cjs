"use strict";

// Producer-owned disposable caches — not a general application/process manager.
// The cache root's direct child entries ARE the inventory. These trees live only
// under the designated `.pi-review-gate/{build,pi-runtime,node}` caches, so their
// contents are disposable by location: a descendant is reclaimable regardless of
// who created it and regardless of whether any lifetime/metadata record exists.
//
// Cleanup is deliberately best effort. Exceeding the per-type generation target
// (five), an unreadable or stale lock, missing/malformed legacy records, or a
// partial filesystem failure must never stop an application start; those cases
// report a bounded warning and the producer continues. Active sessions are
// guarded by the session host's own exclusive agent-directory ownership record,
// not by cache receipts, so cleanup does not implement a second lifetime gate.
//
// Reuse/validation authority stays with the producers (source-build freshness
// records and Pi package/version validation). This module keeps no registry and
// writes no lifetime receipts. MARKER is a single owner-pid liveness file inside
// a generation for exactly as long as that generation is being filled, so a
// concurrent cleanup skips in-flight setup without retaining it forever: a dead
// owner's marker is reclaimed like a stale lock. RECORD is the retired legacy
// lifetime file name that artifact scans continue to ignore.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const RECORD = ".generation.json";
const MARKER = ".producer-active";
const LOCK = ".admission.lock";
const LIMIT = 5;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const CLEANUP_DEADLINE_MS = 120_000;
const LOCK_WAIT_MS = 2_000;
const MAX_LOCK_BYTES = 64;

function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (s.isSymbolicLink() || !s.isDirectory() || s.ino <= 0n) throw new Error("unsafe generation directory");
  return { dev: String(s.dev), ino: String(s.ino) };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

/** Bounded read of a regular no-follow lock file; undefined when unreadable. */
function readLockOwner(file) {
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_LOCK_BYTES)) {
      return undefined;
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return bytes.subarray(0, Math.min(length, MAX_LOCK_BYTES)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * True while the recorded owner of a generation is still filling it. A marker
 * that stays empty/malformed is observed briefly, then treated as a dead
 * owner's residue and removed; a dead pid or unreadable marker is reclaimable.
 */
function generationIsInProgress(root) {
  // Fence the generation root itself: a direct-child link is not a generation
  // and must never expose an outside marker for inspection or deletion.
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const file = path.join(root, MARKER);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before;
    try {
      before = fs.lstatSync(file, { bigint: true });
    } catch {
      return false;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n) {
      // Invalid metadata shapes (directory, link, oversized) are not liveness
      // evidence. Confined no-follow cleanup removes them or reports a real
      // filesystem failure; they never become a permanent pin.
      return false;
    }
    const text = readLockOwner(file);
    const owner = text === undefined ? undefined : /^(\d{1,10})\n?$/u.exec(text);
    if (owner) {
      const pid = Number(owner[1]);
      if (pid === process.pid || processIsAlive(pid)) return true;
      break;
    }
    sleep(25);
  }
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    // A replaced or unreadable marker remains; the generation is still counted.
  }
  return false;
}

function writeMarker(root) {
  const file = path.join(root, MARKER);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function clearMarker(root) {
  try {
    const file = path.join(root, MARKER);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    // Already settled, replaced, or unreadable: nothing to remove.
  }
}

function acquire(cacheRoot) {
  const file = path.join(cacheRoot, LOCK);
  const deadline = performance.now() + LOCK_WAIT_MS;
  // A just-created lock can be observed between creation and its pid write.
  // Only a record that stays malformed across several observations is treated
  // as a dead owner's lock.
  let malformed = 0;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      let created;
      try {
        fs.writeFileSync(fd, `${process.pid}\n`);
        const stat = fs.fstatSync(fd, { bigint: true });
        created = { dev: stat.dev, ino: stat.ino };
      } finally {
        fs.closeSync(fd);
      }
      return {
        release() {
          try {
            const stat = fs.lstatSync(file, { bigint: true });
            if (stat.dev === created.dev && stat.ino === created.ino) fs.unlinkSync(file);
          } catch {
            // A replaced or already-removed lock is not ours to remove.
          }
        },
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") return undefined;
      const text = readLockOwner(file);
      if (text === undefined) return undefined;
      const owner = /^(\d{1,10})\n?$/u.exec(text);
      if (owner) {
        malformed = 0;
        // Same-process concurrency cannot be waited out (the holder only
        // settles on another turn of this event loop): skip cleanup at once.
        if (Number(owner[1]) === process.pid) return undefined;
        if (!processIsAlive(Number(owner[1]))) {
          try {
            fs.unlinkSync(file);
          } catch {
            return undefined;
          }
          continue;
        }
      } else {
        malformed += 1;
        // Empty/malformed: either a mid-publication lock or a dead owner's
        // residue. Re-observe briefly before reclaiming it.
        if (malformed >= 3) {
          try {
            fs.unlinkSync(file);
          } catch {
            return undefined;
          }
          malformed = 0;
          continue;
        }
      }
      if (performance.now() >= deadline) return undefined;
      sleep(25);
    }
  }
}

/**
 * An existing session-host ownership record means a host currently owns this
 * agent directory. That existing guard keeps its authority: cleanup is skipped
 * so a live host's cache generations are left alone, while creation still
 * proceeds and cache capacity still never refuses a start. This is presence
 * only; it does not read, steal, or reimplement the ownership record.
 */
function activeHostOwnsAgentDirectory(cacheRoot) {
  const cache = path.resolve(cacheRoot);
  if (path.basename(path.dirname(cache)) !== ".pi-review-gate") return false;
  const ownership = path.join(path.dirname(path.dirname(cache)), "session-host", "host-ownership.json");
  try {
    fs.lstatSync(ownership);
    return true;
  } catch {
    return false;
  }
}

/** Freshness pointers are not generations and never consume a slot. */
function control(name) {
  return /^(?:source-[a-f0-9]{64}\.json|\.source-build-[a-f0-9]{64}\.lock)$/u.test(name);
}

function inventory(cacheRoot) {
  const entries = [];
  const dir = fs.opendirSync(cacheRoot);
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (entry.name === LOCK || control(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      entries.push({ name: entry.name, file: path.join(cacheRoot, entry.name) });
      if (entries.length > MAX_ENTRIES) throw new Error("cache inventory exceeded its bound");
    }
  } finally {
    dir.closeSync();
  }
  // Deterministic directory-name order: no age, size, or lifetime policy is
  // applied, and every excess generation is equally disposable.
  return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Bounded, no-follow removal of one designated cache generation. Links are
 * unlinked themselves and never traversed, so data outside the generation is
 * untouched; a hardlinked file only loses this name. Returns true only when the
 * whole entry (including its root directory) is gone.
 */
function remove(root) {
  const deadline = performance.now() + CLEANUP_DEADLINE_MS;
  let visited = 0;
  try {
    const visit = (file, depth) => {
      visited += 1;
      if (visited > MAX_ENTRIES) throw new Error("removal entry bound exceeded");
      if (depth > MAX_DEPTH) throw new Error("removal depth exceeded");
      if (performance.now() >= deadline) throw new Error("removal deadline exceeded");
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(file);
        return;
      }
      if (stat.isDirectory()) {
        let names;
        const dir = fs.opendirSync(file);
        try {
          names = [];
          let entry;
          while ((entry = dir.readSync())) names.push(entry.name);
        } finally {
          dir.closeSync();
        }
        for (const name of names) {
          // Cleanup-specific traversal: this whole generation is a designated
          // disposable cache, so even an initialized `.terraform` subtree inside
          // it is removed (still no-follow and confined to this generation).
          visit(path.join(file, name), depth + 1);
        }
        fs.rmdirSync(file);
        return;
      }
      if (!stat.isFile()) throw new Error("unsupported entry");
      fs.unlinkSync(file);
    };
    visit(path.resolve(root), 0);
    return true;
  } catch {
    // A partial removal leaves the remaining entry counted; a later cleanup
    // retries it. Report nothing as reclaimed.
    return false;
  }
}

/**
 * Reclaim excess generations down to the per-type target. Runs under one short
 * exclusive admission lock so concurrent producers do not duplicate work.
 */
function reclaim(cacheRoot, options, warnings) {
  let entries;
  try {
    entries = inventory(cacheRoot);
  } catch (error) {
    warnings.push(`cache inventory was unavailable (${error.message}); continuing without reclamation`);
    return;
  }
  let count = entries.length;
  for (const entry of entries) {
    if (count < LIMIT) break;
    // A live producer's generation is off limits; its marker disappears when
    // that producer settles (or is reclaimed once its owner is gone).
    if (generationIsInProgress(entry.file)) continue;
    let retire;
    try {
      // Producer pointer retirement only inspects an ordinary generation
      // directory; a link is unlinked without ever being read through.
      const stat = fs.lstatSync(entry.file, { bigint: true });
      retire = !stat.isSymbolicLink() && typeof options.beforeReclaim === "function"
        ? options.beforeReclaim(entry.file)
        : undefined;
    } catch {
      retire = undefined;
    }
    if (!remove(entry.file)) {
      warnings.push(`could not reclaim cache generation ${entry.name}; it remains and startup continues`);
      continue;
    }
    count -= 1;
    // Retire a producer's existing freshness pointer only AFTER its generation
    // is gone. This is not another capacity or lifetime index.
    try {
      retire?.();
    } catch {
      // A stale pointer simply remains non-reusable.
    }
  }
  if (count >= LIMIT) {
    warnings.push(`cache retains ${count} generations (target ${LIMIT}); startup continues`);
  }
}

/**
 * The handle settles this producer's admission. Nothing is pinned any more: a
 * generation is disposable by location and the next cleanup reclaims excess.
 * `release()` only ends the setup mutual exclusion (idempotent, truthful).
 */
function handle(root, settle) {
  let settled = false;
  return {
    root,
    release() {
      if (settled) return true;
      settled = true;
      if (typeof settle === "function") settle();
      return true;
    },
  };
}

/**
 * Create one generation, reclaiming excess generations first. Capacity never
 * refuses creation: when cleanup cannot complete, the caller is warned and the
 * generation is created anyway.
 *
 * options.beforeReclaim(root) prepares a producer-specific pointer retirement
 * for one candidate; options.replacement { root, identity, eligible } lets a Pi
 * producer retry its own settled incomplete version root; options.warn receives
 * bounded cleanup warnings.
 */
function admit(cacheRoot, create, options = {}) {
  const cache = path.resolve(cacheRoot);
  const warnings = [];
  const lock = activeHostOwnsAgentDirectory(cache) ? undefined : acquire(cache);
  if (activeHostOwnsAgentDirectory(cache)) {
    warnings.push("a session host currently owns the agent directory; leaving cache generations untouched");
  } else if (!lock) {
    warnings.push("cache cleanup lock was busy or unreadable; continuing without reclaiming older generations");
  } else {
    try {
      if (options.replacement) {
        const target = path.resolve(options.replacement.root);
        const eligible = typeof options.replacement.eligible === "function" && options.replacement.eligible() === true;
        // The same live-owner protection as ordinary reclamation: a producer
        // still filling this exact generation must never be deleted.
        if (path.dirname(target) === cache && eligible && !generationIsInProgress(target)) {
          if (!remove(target)) warnings.push(`could not reclaim the incomplete generation ${path.basename(target)}; continuing`);
        }
      }
      reclaim(cache, options, warnings);
    } catch (error) {
      // A preparation failure ends this admission; creation is never blocked by
      // cleanup trouble, which `reclaim` itself reports as warnings.
      lock.release();
      throw error;
    }
  }
  for (const warning of warnings) {
    if (typeof options.warn === "function") options.warn(warning);
  }
  // Creation runs under the same admission, and the lock stays held until the
  // producer settles its setup. Another producer therefore skips cleanup while
  // a generation is still being filled instead of deleting it mid-setup.
  let stage;
  try {
    stage = create();
  } catch (error) {
    lock?.release();
    throw error;
  }
  if (path.dirname(path.resolve(stage.root)) !== cache) {
    lock?.release();
    throw new Error("generation escaped its cache");
  }
  try {
    identity(stage.root);
    writeMarker(stage.root);
  } catch (error) {
    lock?.release();
    throw error;
  }
  return {
    ...stage,
    generation: handle(stage.root, () => {
      clearMarker(stage.root);
      lock?.release();
    }),
  };
}

/**
 * Confirm that a reuse selection is a direct child of its managed cache. No
 * record, receipt, or pin is read or written; producer validation remains the
 * authority for compatibility and the generation stays disposable.
 */
function pin(cacheRoot, select) {
  const selected = select();
  if (!selected) return undefined;
  const root = path.resolve(selected.root);
  if (path.dirname(root) !== path.resolve(cacheRoot)) throw new Error("generation escaped cache");
  identity(root);
  return { selected, generation: handle(root, undefined) };
}

module.exports = { RECORD, MARKER, LIMIT, admit, pin };
