"use strict";

// Producer-owned disposable caches — not a general application/process manager.
// The cache root's direct child entries ARE the inventory. These trees live only
// under the designated `.pi-review-gate/{build,pi-runtime,node}` caches, so their
// contents are disposable by location: a descendant is reclaimable regardless of
// who created it and regardless of whether any lifetime/metadata record exists.
//
// Cleanup is deliberately best effort. Exceeding the per-type generation target
// (five), a busy live lock, an unreclaimable lock artifact, missing/malformed
// legacy records, or a partial filesystem failure must never stop an
// application start; those cases report a bounded warning and the producer
// continues. A stale or malformed non-live lock artifact (directory, link,
// oversized or unreadable) is reclaimed first, confined to that cache metadata
// entry, so it can never become a permanent cleanup skip. Active sessions are
// guarded by the session host's own exclusive agent-directory ownership record,
// not by cache receipts, so cleanup does not implement a second lifetime gate.
// Because a starting host creates that record while a producer may already be
// authorized to reclaim, host ownership acquisition and this module's
// destructive reclamation both take ONE canonical per-agent coordination entry
// (`<agentDir>/session-host/host-coordination.lock`). Cleanup releases it as soon
// as its fresh generation exists, rechecks the ownership record after any
// wait/stale recovery and at every destructive boundary, and skips reclamation
// entirely when that boundary is unavailable. The coordination entry is a mutex,
// not a registry.
//
// Canonical mutex protocol (identical in the CJS, TypeScript host, POSIX, and
// PowerShell paths):
// - The record is published ALREADY COMPLETE: the full `pid` + owner-identity
//   body is written and fsynced in a private candidate, then published with an
//   atomic no-overwrite hard link. A reader therefore never observes a
//   half-written canonical record, and a publisher paused before the link simply
//   loses the link race instead of believing it owns the entry. The link is
//   transiently nlink 2 while the candidate name exists, so a valid record is
//   accepted at nlink 1 or 2; only this exact entry name is ever unlinked, and
//   unlinking one hard link never touches another name's bytes.
// - The owner identity is a targeted single-pid process-start token (`ps`
//   lstart on POSIX, the process start time on Windows PowerShell). A record is
//   honored only while its pid is alive AND that pid still reports the same
//   start token, so an abandoned record whose pid was reused by an unrelated
//   live process is reclaimed instead of becoming a permanent startup gate. No
//   process census, no artifact lifetime catalog, and no elapsed-time release
//   exists here: a genuine current holder is honored for as long as it lives.
//
// Reuse/validation authority stays with the producers (source-build freshness
// records and Pi package/version validation). This module keeps no registry and
// writes no lifetime receipts. MARKER is a single owner liveness file inside a
// generation for exactly as long as that generation is being filled, so a
// concurrent cleanup skips in-flight setup without retaining it forever: a dead
// owner's marker is reclaimed like a stale lock. RECORD is the retired legacy
// lifetime file name that artifact scans continue to ignore.
//
// Cleanup is progressive and bounded by the pass, not by a preflight. One
// bounded pass inventories the type, then removes generations one entry at a
// time with deletion as progress: a pass that reaches its runtime budget keeps
// every entry it already removed and the next preparation continues from what
// remains. There is no entry-count or depth quota that could refuse to delete
// anything, and the budget is shared by the whole pass instead of being reset
// for each generation. Producers that reuse an existing generation run the same
// bounded pass with a target of five and always protect the generation this
// launch selected, so a warm startup advances pending cleanup without creating
// anything new.
//
// Reclamation may stop at its budget but must never be a no-op forever. Only a
// genuinely in-flight producer (its own record names its live owner) or an
// existing session-host ownership record defers a removal. Those per-cache
// records are written already complete as `<pid>` plus the owner's targeted
// single-pid birth token, the same token the coordination entry uses; a legacy
// pid-only record is still honored while its owner is genuinely current, which
// is decided by comparing that pid's OS birth time with the record's own mtime.
// A live pid whose birth is clearly after the record was written cannot be the
// process that wrote it (the number was reused), so it never pins a generation.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const RECORD = ".generation.json";
const MARKER = ".producer-active";
const LOCK = ".admission.lock";
/** Per-agent coordination entry shared with the session host's ownership guard. */
const COORDINATION = "host-coordination.lock";
const LIMIT = 5;
/** One cleanup pass — inventory plus every removal it attempts — shares this. */
const CLEANUP_BUDGET_MS = 120_000;
const LOCK_WAIT_MS = 2_000;
/** Bounded owner record: `<pid>` plus an optional targeted birth identity. */
const MAX_OWNER_BYTES = 192;
/** A reused pid's birth is only "after" a record when clearly later than it. */
const OWNER_BIRTH_MARGIN_MS = 2_000;
/** Bounded canonical coordination record: `<pid>\n<owner identity>\n`. */
const MAX_COORDINATION_BYTES = 192;
const COORDINATION_CANDIDATE = /^host-coordination\.lock\.[1-9][0-9]*\.[0-9a-f]{8}$/u;

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
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_OWNER_BYTES)) {
      return undefined;
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const bytes = Buffer.alloc(MAX_OWNER_BYTES + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return bytes.subarray(0, Math.min(length, MAX_OWNER_BYTES)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** A per-cache owner record is only ever a fresh single-linked small regular file. */
function lockRecordCandidate(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(MAX_OWNER_BYTES);
}

function recordMtimeMs(stat) {
  return typeof stat.mtimeNs === "bigint" ? Number(stat.mtimeNs / 1_000_000n) : Number(stat.mtimeMs);
}

const PS_LSTART_MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse one `ps lstart` token as UTC. The token ("Sun Oct 18 01:29:07 2026")
 * carries no zone of its own, so interpreting it as caller-local time would
 * misplace a legitimate owner's birth by the local offset (and would flip a
 * genuinely live legacy producer to "stale" on any non-UTC host). The query is
 * pinned to UTC, and the parse is explicit UTC to match.
 */
function utcPsLstartMs(token) {
  const match = /^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(String(token).trim());
  if (!match) return undefined;
  const month = PS_LSTART_MONTHS[match[1]];
  if (month === undefined) return undefined;
  const value = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isFinite(value) ? value : undefined;
}

/** Kernel boot time in whole seconds, used for Linux owner-birth arithmetic. */
function linuxBootSeconds() {
  try {
    const stat = fs.readFileSync(LINUX_STAT, "utf8");
    const match = /^btime\s+(\d{1,12})$/mu.exec(stat);
    if (match) return Number(match[1]);
  } catch {
    // No boot time is available.
  }
  return undefined;
}

/**
 * Targeted single-pid OS owner birth time in epoch milliseconds. It exists only
 * to tell a legacy pid-only record written by its actual owner from one left
 * behind by a pid that an unrelated process has since reused. Exactly one pid is
 * queried (never a census, never a registry), and an empty result simply means
 * the record is honored conservatively.
 */
function ownerBirthMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return undefined;
      const starttime = stat.slice(close + 1).trim().split(/\s+/u)[19];
      if (!starttime || !/^[0-9]{1,20}$/u.test(starttime)) return undefined;
      const boot = linuxBootSeconds();
      if (boot === undefined) return undefined;
      // USER_HZ is 100 on Linux by ABI definition, so ticks convert exactly.
      return boot * 1000 + Number(starttime) * 10;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const token = queryOwnerIdentity(pid);
    if (!token) return undefined;
    return utcPsLstartMs(token.slice("darwin:".length));
  }
  if (process.platform === "win32") {
    const token = queryOwnerIdentity(pid);
    if (!token) return undefined;
    // The Windows token is an ISO round-trip that carries its own zone.
    const value = Date.parse(token.slice("win32:".length));
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Parse one per-cache owner record. A current producer publishes
 * `<pid>\n<owner identity>\n` — the same targeted pid plus birth token the
 * canonical coordination entry carries — so liveness never depends on a pid
 * number alone. Records written by an older producer are pid-only and remain
 * readable.
 */
function parseOwnerRecord(text) {
  if (typeof text !== "string") return undefined;
  const newline = text.indexOf("\n");
  const pidText = (newline < 0 ? text : text.slice(0, newline)).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText)) return undefined;
  const identity = newline < 0 ? "" : text.slice(newline + 1).replace(/\n+$/u, "");
  if (identity.length > MAX_OWNER_BYTES - 32) return undefined;
  return { pid: Number(pidText), identity };
}

/** Ephemeral per-cache owner record: `<pid>` plus its targeted birth token. */
function ownerRecordBody(pid, ownerIdentity) {
  return `${pid}\n${ownerIdentity}\n`;
}

/**
 * True only while a record's owner is genuinely current. A record that names its
 * owner's birth identity is honored only while that exact identity still holds.
 * A legacy pid-only record falls back to one targeted birth-time comparison: a
 * live pid whose OS birth is clearly AFTER the record's own mtime cannot be the
 * process that wrote it (its number was reused), while an earlier birth is
 * legitimate in-flight work and stays protected.
 */
function ownerRecordIsCurrent(record, stat) {
  if (!record || !processIsAlive(record.pid)) return false;
  if (record.identity !== "") {
    const observed = queryOwnerIdentity(record.pid);
    // An unverifiable birth is not a proven mismatch: the pid is alive, so this
    // may still be an in-flight producer and is honored. Only a real, different
    // birth identity proves the number was reused.
    if (observed === "") return true;
    return observed === record.identity;
  }
  const birth = ownerBirthMs(record.pid);
  if (birth === undefined) return true;
  return birth <= recordMtimeMs(stat) + OWNER_BIRTH_MARGIN_MS;
}

/**
 * True only while the record's owner is genuinely current, with an unverifiable
 * birth treated as a possible live holder rather than as staleness. Used by the
 * canonical coordination mutex: stealing a live destructive holder's entry would
 * let a second actor claim the agent directory beside an active deletion.
 */
function coordinationRecordIsCurrent(record) {
  if (!record || !processIsAlive(record.pid)) return false;
  if (record.identity === "") return false;
  const observed = queryOwnerIdentity(record.pid);
  if (observed === "") return true;
  return observed === record.identity;
}

/**
 * True while the recorded owner of a generation is still filling it. A marker
 * that stays empty/malformed is observed briefly, then treated as a dead
 * owner's residue and removed; a dead, reused-pid, or unreadable marker is
 * reclaimable.
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
    if (!lockRecordCandidate(before)) {
      // Invalid metadata shapes (directory, link, oversized) are not liveness
      // evidence. Confined no-follow cleanup removes them or reports a real
      // filesystem failure; they never become a permanent pin.
      return false;
    }
    const record = parseOwnerRecord(readLockOwner(file));
    if (record) {
      const pid = record.pid;
      if (ownerRecordIsCurrent(record, before)) return true;
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
    fs.writeFileSync(fd, ownerRecordBody(process.pid, ownOwnerIdentity()));
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

/**
 * Reclaim only the exact lock artifact that was observed. The entry is
 * re-identified first: when another producer replaced it, or the record now
 * names a live owner, it is left in place and acquisition restarts, so a
 * replacement live lock is never deleted. Returns "reclaimed" once the path is
 * gone, "kept" when it is not ours to remove, and "failed" for a real
 * filesystem error. Links are unlinked themselves (never read through),
 * directory content is removed bounded and no-follow, and nothing outside this
 * cache metadata entry is touched.
 */
function reclaimLockArtifact(file, identity) {
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    return error && error.code === "ENOENT" ? "reclaimed" : "failed";
  }
  if (`${stat.dev}:${stat.ino}` !== identity) return "kept";
  if (lockRecordCandidate(stat)) {
    const record = parseOwnerRecord(readLockOwner(file));
    if (record && record.pid === process.pid
      && (record.identity === "" || record.identity === ownOwnerIdentity())
      && ownerRecordIsCurrent(record, stat)) return "kept";
    if (record && ownerRecordIsCurrent(record, stat)) return "kept";
  }
  try {
    if (!stat.isDirectory()) {
      fs.unlinkSync(file);
      return "reclaimed";
    }
    return remove(file, performance.now() + CLEANUP_BUDGET_MS, { removed: 0 }) === "removed" ? "reclaimed" : "failed";
  } catch (error) {
    return error && error.code === "ENOENT" ? "reclaimed" : "failed";
  }
}

/**
 * Bounded exclusive acquisition of one cache-metadata lock entry. Identical
 * semantics for the per-cache admission lock and the per-agent host-ownership
 * coordination lock: a live owner is waited for briefly and then left alone, a
 * dead/malformed/non-live artifact is reclaimed confined to that exact entry,
 * and nothing here can become a permanent stop condition.
 */
function acquireLock(file, warnings, messages, options = {}) {
  const deadline = performance.now() + LOCK_WAIT_MS;
  // A just-created lock can be observed between creation and its pid write.
  // Only the SAME malformed artifact, observed across several inspections, is
  // treated as a dead owner's residue: a different identity restarts the
  // observation, and reclamation is conditional on that identity still being
  // the one present.
  let malformed = 0;
  let malformedIdentity;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      let created;
      try {
        fs.writeFileSync(fd, ownerRecordBody(process.pid, ownOwnerIdentity()));
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
      if (!error || error.code !== "EEXIST") {
        warnings.push(`${messages.create} (${error && error.code})`);
        return undefined;
      }
      let observed;
      try {
        observed = fs.lstatSync(file, { bigint: true });
      } catch (cause) {
        if (cause && cause.code === "ENOENT") {
          // Another producer settled it between attempts; retry creation.
          malformed = 0;
          malformedIdentity = undefined;
          // A handoff hold has no busy deadline: an entry that disappeared just
          // after a live-holder wait is an ordinary release, not a failed
          // acquisition, and continuing uncoordinated would drop protection.
          if (options.waitForLiveOwner !== true && performance.now() >= deadline) {
            warnings.push(messages.busy);
            return undefined;
          }
          sleep(25);
          continue;
        }
        warnings.push(messages.busy);
        return undefined;
      }
      const identity = `${observed.dev}:${observed.ino}`;
      const record = lockRecordCandidate(observed) ? parseOwnerRecord(readLockOwner(file)) : undefined;
      if (record && record.pid === process.pid
        && (record.identity === "" || record.identity === ownOwnerIdentity())
        && ownerRecordIsCurrent(record, observed)) {
        // Same-process concurrency cannot be waited out (the holder only
        // settles on another turn of this event loop): skip cleanup at once. A
        // stale pid-only record that happens to name this pid is not a hold.
        warnings.push(messages.busy);
        return undefined;
      }
      if (record && ownerRecordIsCurrent(record, observed)) {
        // A live owner is never ours: wait, then skip cleanup. A selection
        // handoff waits for the whole bounded destructive pass instead.
        malformed = 0;
        malformedIdentity = undefined;
        if (options.waitForLiveOwner === true) {
          sleep(25);
          continue;
        }
      } else if (record) {
        // A dead or pid-reused owner's record is reclaimed only if it is still
        // that record.
        malformed = 0;
        malformedIdentity = undefined;
        const outcome = reclaimLockArtifact(file, identity);
        if (outcome === "failed") {
          warnings.push(messages.artifact);
          return undefined;
        }
        continue;
      } else {
        // Empty/invalid record or a non-live metadata shape (directory, link,
        // oversized, unreadable): either a mid-publication lock or a dead
        // owner's residue. Re-observe this exact identity, then reclaim it
        // confined to this cache metadata entry so it never becomes a
        // permanent skip.
        if (identity !== malformedIdentity) {
          malformed = 0;
          malformedIdentity = identity;
        }
        malformed += 1;
        if (malformed >= 3) {
          malformed = 0;
          malformedIdentity = undefined;
          const outcome = reclaimLockArtifact(file, identity);
          if (outcome === "failed") {
            warnings.push(messages.artifact);
            return undefined;
          }
          continue;
        }
      }
      if (options.waitForLiveOwner !== true && performance.now() >= deadline) {
        warnings.push(messages.busy);
        return undefined;
      }
      sleep(25);
    }
  }
}

const CACHE_LOCK_MESSAGES = {
  create: "cache cleanup lock could not be created; continuing without reclaiming older generations",
  busy: "cache cleanup lock was busy or unreadable; continuing without reclaiming older generations",
  artifact: "cache cleanup lock artifact could not be removed; continuing without reclaiming older generations",
};

const COORDINATION_MESSAGES = {
  create: "host ownership coordination lock could not be created; leaving cache generations untouched",
  busy: "host ownership coordination was busy or unreadable; leaving cache generations untouched",
  artifact: "host ownership coordination lock artifact could not be removed; leaving cache generations untouched",
};

/** The existing session-host ownership record warns exactly this way. */
const HOST_OWNED_WARNING = "a session host currently owns the agent directory; leaving cache generations untouched";

/** The host took ownership while this producer was waiting on a cleanup lock. */
const HOST_OWNED_DURING_CLEANUP_WARNING = "a session host acquired the agent directory during cleanup; leaving the remaining cache generations untouched";

function acquire(cacheRoot, warnings) {
  return acquireLock(path.join(cacheRoot, LOCK), warnings, CACHE_LOCK_MESSAGES);
}

/**
 * The canonical per-agent host-state paths for one managed cache root. The
 * ownership record and the coordination lock are the host guard's own artifacts,
 * never a second lifetime registry for cache generations.
 */
function hostStatePaths(cacheRoot) {
  const cache = path.resolve(cacheRoot);
  if (path.basename(path.dirname(cache)) !== ".pi-review-gate") return undefined;
  const stateDir = path.join(path.dirname(path.dirname(cache)), "session-host");
  return {
    stateDir,
    ownership: path.join(stateDir, "host-ownership.json"),
    coordination: path.join(stateDir, COORDINATION),
  };
}

/**
 * An existing session-host ownership record means a host currently owns this
 * agent directory. That existing guard keeps its authority: cleanup is skipped
 * so a live host's cache generations are left alone, while creation still
 * proceeds and cache capacity still never refuses a start. This is presence
 * only; it does not read, steal, or reimplement the ownership record.
 */
function activeHostOwnsAgentDirectory(cacheRoot) {
  const paths = hostStatePaths(cacheRoot);
  if (!paths) return false;
  try {
    fs.lstatSync(paths.ownership);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the private host state directory can hold the coordination lock. A
 * symlinked or non-directory `session-host` entry is never written through, and
 * an agent directory this producer cannot prepare simply means cleanup is
 * skipped instead of refusing the start.
 *
 * A genuinely absent `session-host` is created exclusively with private
 * protection by the shared creator (Refs #494); an existing one is never
 * modified. Protection is additive only: when it cannot be established, the
 * plain `mkdir(0700)` below keeps this producer's coordination behaviour exactly
 * as before, and the protected Network stores refuse the unverified directory.
 */
function ensureCoordinationDirectory(stateDir) {
  try {
    require("./session-host-state-directory.cjs").createPrivateStateDirectory(stateDir);
  } catch {
    // Creation protection never changes whether coordination can proceed.
  }
  try {
    fs.mkdirSync(stateDir, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== "EEXIST") return false;
  }
  try {
    const stat = fs.lstatSync(stateDir, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Take the one canonical per-agent coordination boundary that host ownership
 * acquisition also takes, so destructive reclamation and a host becoming the
 * owner of this agent directory are mutually exclusive. Returns undefined when
 * that boundary is unavailable: cleanup is then skipped (with a bounded warning)
 * rather than racing an ownership acquisition it cannot exclude, and creation
 * still proceeds. No count, receipt, or metadata state ever refuses a start.
 */
function coordinate(cacheRoot, warnings) {
  const paths = hostStatePaths(cacheRoot);
  if (!paths) {
    // Not a managed cache root: no per-agent host guard applies here, so cleanup
    // runs exactly as before without a coordination boundary.
    return { release() {} };
  }
  if (!ensureCoordinationDirectory(paths.stateDir)) {
    warnings.push(COORDINATION_MESSAGES.busy);
    return undefined;
  }
  const acquired = acquireCoordinationEntry(paths.stateDir);
  // "self" means this process already holds the canonical boundary (the
  // launcher's ownership handoff): its own bounded destructive pass still runs
  // inside that mutex, and the ownership claim itself still waits for it.
  if (acquired.status === "self") return { release() {} };
  if (acquired.status !== "held") {
    warnings.push(COORDINATION_MESSAGES.busy);
    return undefined;
  }
  // Producers only skip reclamation when they cannot take the mutex; the host
  // handoff waits instead (see holdAgentDirectory).
  return { release: acquired.release };
}

/**
 * Take the canonical per-agent coordination entry for the launcher's coordinated
 * selection/preparation handoff to host ownership. Unlike producer admission it
 * waits for a live holder (a producer inside its bounded destructive pass)
 * instead of skipping, because a skipped cleanup would let another preparation
 * reclaim the selection this launch is about to hand to its host. Stale or
 * malformed metadata is reclaimed as usual; a genuine unremovable-artifact/IO
 * failure returns undefined, and the caller continues truthfully — the ownership
 * record itself still stops producer removals at every destructive boundary.
 */
function holdAgentDirectory(agentDir) {
  const agent = path.resolve(agentDir);
  const stateDir = path.join(agent, "session-host");
  if (!ensureCoordinationDirectory(stateDir)) return undefined;
  const acquired = acquireCoordinationEntry(stateDir, { waitForLiveOwner: true });
  if (acquired.status === "self") return { release() {} };
  if (acquired.status !== "held") return undefined;
  return { release: acquired.release };
}

// ---------------------------------------------------------------------------
// Canonical per-agent coordination mutex (atomically published, identity-bearing)
// ---------------------------------------------------------------------------
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const LINUX_BOOT_ID = "/proc/sys/kernel/random/boot_id";
const LINUX_STAT = "/proc/stat";

/** First existing standard OS location for one required helper binary. */
function standardBinary(paths) {
  for (const candidate of paths) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next standard location.
    }
  }
  return undefined;
}

/** Boot identity for Linux starttime tokens (a reboot invalidates starttimes). */
function linuxBootIdentity() {
  try {
    const id = fs.readFileSync(LINUX_BOOT_ID, "utf8").trim();
    if (/^[0-9a-f-]{8,64}$/u.test(id)) return id;
  } catch {
    // Fall through to the kernel boot time.
  }
  try {
    const stat = fs.readFileSync(LINUX_STAT, "utf8");
    const match = /^btime\s+(\d{1,12})$/mu.exec(stat);
    if (match) return `btime-${match[1]}`;
  } catch {
    // No boot identity is available.
  }
  return "";
}

/** The native hard cap of one targeted darwin `ps` query. */
const DARWIN_QUERY_CAP_MS = 5_000;
/** The native hard cap of one targeted Windows PowerShell query. */
const WIN32_QUERY_CAP_MS = 10_000;
/** The one PowerShell script that renders a `win32:` start token. */
const WIN32_OWNER_QUERY_SCRIPT = "& { param([int]$OwnerPid) try { $p = Get-Process -Id $OwnerPid -ErrorAction Stop; "
  + "[Console]::Out.Write('win32:' + $p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)) } "
  + "catch { exit 2 } }";

/** `linux:<boot identity>:<starttime ticks>` for one pid, read without any child. */
function linuxOwnerIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` may contain spaces and parentheses: parse after the last ")".
    const close = stat.lastIndexOf(")");
    if (close < 0) return "";
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    const starttime = fields[19];
    if (!starttime || !/^[0-9]{1,20}$/u.test(starttime)) return "";
    const boot = linuxBootIdentity();
    if (!boot) return "";
    return `linux:${boot}:${starttime}`;
  } catch {
    return "";
  }
}

/** Render one `ps lstart` output as the exact `darwin:` token, or "" when unusable. */
function darwinOwnerToken(output) {
  const token = String(output).replace(/\s+/gu, " ").trim();
  return token.length > 0 && token.length <= MAX_COORDINATION_BYTES - 48 ? `darwin:${token}` : "";
}

/** Render one PowerShell output as the exact `win32:` token, or "" when unusable. */
function win32OwnerToken(output) {
  const token = String(output).trim();
  return /^win32:.{4,}$/u.test(token) && token.length <= MAX_COORDINATION_BYTES - 48 ? token : "";
}

/** The darwin `ps` PATH lookup, kept out of the bounded helper path on purpose. */
function resolvePsByShell() {
  try {
    return execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8", timeout: DARWIN_QUERY_CAP_MS }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exact per-platform targeted single-pid query for one validated numeric
 * pid: the same argv, environment, native hard cap, and token validator that
 * `ownerStartIdentity` runs, so an asynchronous helper can never invent a
 * different identity format for the same process. `allowShellLookup` keeps the
 * PATH `ps` lookup out of the bounded helper path, where a synchronous fallback
 * fork is not allowed. Returns undefined when the platform has no helper command
 * at all: Linux answers from `/proc` without a child, and an unknown platform
 * has no query.
 */
function ownerIdentityPlan(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "darwin") {
    const ps = standardBinary(["/bin/ps", "/usr/bin/ps"]) || (options.allowShellLookup === true ? resolvePsByShell() : undefined);
    if (!ps) return undefined;
    return {
      command: ps,
      args: ["-p", String(pid), "-o", "lstart="],
      // `ps lstart` renders in the caller's timezone and locale. The token is
      // compared byte for byte across the CJS, TypeScript host, and POSIX
      // paths and is also the owner-birth evidence, so the query itself is
      // pinned to UTC and the C locale instead of relying on the caller's.
      env: { ...process.env, TZ: "UTC0", LC_ALL: "C", LANG: "C" },
      capMs: DARWIN_QUERY_CAP_MS,
      windowsHide: false,
      token: darwinOwnerToken,
    };
  }
  if (process.platform === "win32") {
    // The existing native Windows PowerShell facility queries exactly one known
    // numeric pid; the value is validated digits and passed as a fixed argv entry,
    // so no shell string is ever composed. Bounded and non-interactive.
    const powershell = standardBinary([
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe`,
    ]);
    if (!powershell) return undefined;
    return {
      command: powershell,
      args: [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", WIN32_OWNER_QUERY_SCRIPT, String(pid),
      ],
      env: undefined,
      capMs: WIN32_QUERY_CAP_MS,
      windowsHide: true,
      token: win32OwnerToken,
    };
  }
  return undefined;
}

/**
 * Target single-pid process-start token used as the owner-lifetime identity, in
 * one exact per-platform format so a writer and a reader agree byte for byte:
 * - `linux:<boot identity>:<starttime ticks>` from this single pid's
 *   `/proc/<pid>/stat` (no procps `ps` needed, so minimal/BusyBox distributions
 *   work);
 * - `darwin:<ps lstart token>` from one targeted `ps -p <pid>` query that is
 *   pinned to UTC and the C locale, because `ps lstart` carries no zone of its
 *   own: a caller-local rendering would make the same live process look like a
 *   different owner after a timezone/DST change, and would misplace its birth;
 * - `win32:<StartTime round-trip>` from one targeted native PowerShell query
 *   (the same facility and format the PowerShell producer uses), which keeps
 *   its explicit UTC offset.
 * Always exactly one pid, never a process census, and no third-party package.
 * An empty result means the identity genuinely cannot be established.
 *
 * This call is synchronous and can take hundreds of milliseconds on a busy
 * machine, so a caller with a short bounded wait must not run it inline: use
 * `startOwnerIdentityProbe`, which asks the same query through one owned helper.
 */
function ownerStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") return linuxOwnerIdentity(pid);
  const plan = ownerIdentityPlan(pid, { allowShellLookup: true });
  if (plan === undefined) return "";
  const options = {
    encoding: "utf8",
    timeout: plan.capMs,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: plan.windowsHide === true,
  };
  if (plan.env !== undefined) options.env = plan.env;
  try {
    return plan.token(execFileSync(plan.command, plan.args, options));
  } catch {
    return "";
  }
}

// This process's own owner identity. The token is immutable once established, so
// a positive result is cached forever; a failed query is never cached, because a
// transient `ps`/`/proc` failure at load would otherwise permanently prevent this
// process from publishing or recognizing its own coordination hold.
let ownerIdentityQuery = ownerStartIdentity;
function queryOwnerIdentity(pid) {
  return ownerIdentityQuery(pid);
}
let OWN_OWNER_IDENTITY_CACHE = "";
function ownOwnerIdentity() {
  if (OWN_OWNER_IDENTITY_CACHE === "") {
    // Through the same query the liveness checks use, and retried on every call
    // until it succeeds: a transient failure must never disable publishing or
    // self-adoption for the rest of the process's life.
    const observed = queryOwnerIdentity(process.pid);
    if (observed !== "") OWN_OWNER_IDENTITY_CACHE = observed;
  }
  return OWN_OWNER_IDENTITY_CACHE;
}
// Learn this process's identity once at load; a failure here is retried above.
OWN_OWNER_IDENTITY_CACHE = ownerStartIdentity(process.pid);

// ---------------------------------------------------------------------------
// Bounded owned owner-identity probe (asynchronous, one helper at a time)
// ---------------------------------------------------------------------------

/** Bounded stdout collected from one owned identity helper. */
const OWNER_PROBE_MAX_BYTES = 4 * 1024;
/**
 * Upper bound on the delay between a helper's first signal and the hard kill that
 * escalates it. The actual escalation is also capped by the caller's absolute
 * confirmation deadline, so it never lands outside the caller's own budget.
 */
const OWNER_PROBE_ESCALATE_MS = 250;

/**
 * The ONE owned identity helper alive in this process.
 *
 * This is owned-process resource accounting and nothing else: not a birth
 * cache, not a lock registry, not an authority lease, and it holds no trust for
 * any pid. A busy slot means "make no new allocation" — never "the observed
 * owner is live" and never "the observed owner is stale". Only the helper's own
 * positive `close` clears the slot, so a helper whose close cannot be confirmed
 * stays visible as "unconfirmed" and keeps both new probes and any dependent
 * lock success refused until the real close lands.
 */
let ownerProbeSlot;

/**
 * "free" | "pending" | "unconfirmed" for the one owned helper slot.
 *
 * `unconfirmed` is a reading of the caller's absolute clock, not only of the
 * confirmation timer's callback: a helper still pending once its stored
 * confirmation deadline has passed IS unconfirmed even inside the same turn,
 * before that timer gets dispatched. A busy machine can cross the deadline during
 * synchronous work, and a caller that asks this question in that same turn must not
 * be told "pending" and handed a dependent lock success beside a helper whose
 * confirmation window has closed. The reading is derived and read-only: it clears
 * nothing, signals nothing, and grants no identity, no deletion authority, and no
 * new allocation. Only the helper's own real `close` (through `finish`) leaves
 * this state.
 */
function ownerProbeSlotState() {
  const slot = ownerProbeSlot;
  if (slot === undefined) return "free";
  if (slot.state === "pending" && Date.now() >= slot.confirmDeadline) return "unconfirmed";
  return slot.state;
}

/**
 * Start ONE owned, cancellable owner-identity query for exactly one numeric pid
 * without blocking the caller's wait loop.
 *
 * Options are ABSOLUTE `Date.now()` deadlines, because a relative timer started
 * after the helper spawns cannot enforce a caller's budget: a delayed callback
 * would silently overrun it.
 * - `queryDeadlineMs` is when the helper must be signalled and after which its
 *   answer is rejected even if it arrives. It can only SHORTEN the platform's
 *   native hard cap (5s darwin, 10s win32); no caller deadline expands it, and a
 *   deadline that is already spent — or one that cannot cover the query it offers
 *   alongside a confirmation deadline — allocates nothing and answers unknown
 *   rather than being stretched to make room.
 * - `confirmDeadlineMs` is when the caller stops being able to wait at all. The
 *   helper's SIGKILL escalation and the slot's "unconfirmed" transition both
 *   happen at or before it, so termination, escalation, and confirmation all fit
 *   inside the caller's own budget. Timer expiry is never close evidence: the
 *   slot stays "unconfirmed" until the real `close` event clears it.
 * - A verdict exists ONLY after that positive close. A canceled, late, expired,
 *   oversize, nonzero, or unparseable helper is UNKNOWN (`identity: ""`), never
 *   a stale verdict, because an unverified owner must stay honored.
 * - `cancel()` signals only this probe's own ChildProcess. The queried pid is
 *   never signalled, directly or as a process group.
 *
 * Returns `{ status: "settled", identity }` when the platform answers without
 * allocating a child (Linux reads one `/proc` entry) or has no usable query at
 * all, `{ status: "busy" }` when the single helper slot is already held — make
 * no new allocation and honor the observed owner — and `{ status: "started",
 * probe }` otherwise.
 */
function startOwnerIdentityProbe(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "settled", identity: "" };
  if (ownerProbeSlot !== undefined) return { status: "busy" };
  const plan = ownerIdentityPlan(pid, { allowShellLookup: false });
  if (plan === undefined) {
    // There is no owned helper command for this platform. Linux answers from one
    // `/proc` entry with no child at all; darwin and win32 without their standard
    // binary are an UNKNOWN birth. The synchronous `ownerStartIdentity` is
    // deliberately NOT consulted here: it can fork a shell and a second helper
    // with native caps far past any bounded wait, which is the inline gating this
    // probe exists to remove.
    return { status: "settled", identity: process.platform === "linux" ? linuxOwnerIdentity(pid) : "" };
  }
  const startedAt = Date.now();
  const nativeDeadline = startedAt + plan.capMs;
  const queryDeadline = Number.isFinite(options.queryDeadlineMs)
    ? Math.min(options.queryDeadlineMs, nativeDeadline)
    : nativeDeadline;
  const confirmDeadline = Number.isFinite(options.confirmDeadlineMs)
    ? Math.min(options.confirmDeadlineMs, nativeDeadline)
    : queryDeadline;
  if (queryDeadline <= startedAt || confirmDeadline < queryDeadline) {
    // The budget this caller offered is already spent, or it cannot cover the
    // query it is asking about. No helper is allocated and no deadline is stretched
    // to make room: an expired budget simply supplies no identity authority.
    return { status: "settled", identity: "" };
  }
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      env: plan.env === undefined ? process.env : plan.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: plan.windowsHide === true,
    });
  } catch {
    // No helper could be created at all: that is an unknown birth, not evidence
    // of staleness, and nothing was allocated.
    return { status: "settled", identity: "" };
  }

  // The slot carries the EFFECTIVE confirmation deadline — the same native-capped
  // value the confirmation timer is installed with — so the status reading above
  // and the timer below answer to one absolute clock instead of to dispatch order.
  const slot = { state: "pending", confirmDeadline };
  let verdict;
  let signaled = false;
  let oversize = false;
  let failed = false;
  let capTimer;
  let confirmTimer;
  let escalateTimer;
  let settle;
  const close = new Promise((resolve) => { settle = resolve; });
  const chunks = [];
  let bytes = 0;

  const signalHelper = () => {
    // Only this probe's own helper is ever signalled: never the queried pid, a
    // process group, or any historical pid.
    signaled = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (escalateTimer === undefined) {
      // The hard kill is derived from the caller's absolute confirmation
      // deadline, never from a fixed delay alone: escalation can never land
      // outside the budget the caller already committed.
      const escalateAt = Math.min(Date.now() + OWNER_PROBE_ESCALATE_MS, confirmDeadline);
      escalateTimer = setTimeout(() => {
        escalateTimer = undefined;
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, Math.max(0, escalateAt - Date.now()));
    }
  };
  // The one point at which a verdict exists, and the only thing that frees the slot.
  const finish = (identity, reason) => {
    if (verdict !== undefined) return;
    verdict = { identity, reason };
    if (capTimer !== undefined) clearTimeout(capTimer);
    if (confirmTimer !== undefined) clearTimeout(confirmTimer);
    if (escalateTimer !== undefined) clearTimeout(escalateTimer);
    slot.state = "closed";
    if (ownerProbeSlot === slot) ownerProbeSlot = undefined;
    settle(verdict);
  };
  const handle = {
    get state() { return slot.state; },
    get verdict() { return verdict; },
    close,
    cancel() {
      if (verdict === undefined) signalHelper();
    },
  };
  ownerProbeSlot = slot;
  // Delays are computed against the clock at installation, never against the
  // timestamp captured before `spawn`: setup time must not extend the caller's
  // absolute deadlines.
  capTimer = setTimeout(() => {
    capTimer = undefined;
    signalHelper();
  }, Math.max(0, queryDeadline - Date.now()));
  confirmTimer = setTimeout(() => {
    confirmTimer = undefined;
    // Expiry is not close evidence: the helper is escalated and the slot stays
    // visibly unconfirmed until the real close arrives.
    if (slot.state === "pending") slot.state = "unconfirmed";
    signalHelper();
  }, Math.max(0, confirmDeadline - Date.now()));
  if (child.stdout !== null) {
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > OWNER_PROBE_MAX_BYTES) {
        if (!oversize) {
          oversize = true;
          signalHelper();
        }
        return;
      }
      chunks.push(chunk);
    });
  }
  child.on("error", () => {
    failed = true;
    if (child.pid === undefined) {
      // The helper process was never created, so there is nothing to reap: this
      // is a positive settlement, not an unconfirmed wait.
      finish("", "failed");
      return;
    }
    signalHelper();
  });
  child.on("close", (code, signalName) => {
    if (Date.now() > queryDeadline) {
      // An answer that arrives after the effective query deadline is rejected
      // even when its own timers were delayed: the caller's budget is absolute,
      // and a late token is not evidence about a record still being waited on.
      finish("", "late");
      return;
    }
    if (failed || oversize || signaled || code !== 0 || signalName !== null) {
      finish("", failed ? "failed" : oversize ? "oversize" : signaled ? "canceled" : "exited");
      return;
    }
    let identity = "";
    try {
      identity = plan.token(Buffer.concat(chunks).toString("utf8"));
    } catch {
      identity = "";
    }
    finish(identity, identity === "" ? "unparseable" : "ok");
  });
  return { status: "started", probe: handle };
}

function coordinationRecordBody(pid, identity) {
  return `${pid}\n${identity}\n`;
}

/** Parse a coordination record: pid plus the optional owner identity token. */
function parseCoordinationRecord(text) {
  if (typeof text !== "string") return undefined;
  const newline = text.indexOf("\n");
  if (newline < 0) return undefined;
  const pidText = text.slice(0, newline).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(pidText)) return undefined;
  const identity = text.slice(newline + 1).replace(/\n+$/u, "");
  if (identity.length > MAX_COORDINATION_BYTES - 32) return undefined;
  return { pid: Number(pidText), identity };
}

/**
 * True only while the record's own pid is alive AND still reports the recorded
 * start identity. A reused pid therefore fails this check (its start token
 * differs), which keeps an abandoned record from becoming a permanent gate, and a
 * record without a birth identity is never honored on any platform. A birth query
 * that temporarily fails is treated as a possible live holder, never as staleness.
 */
function coordinationOwnerIsCurrent(record) {
  return coordinationRecordIsCurrent(record);
}

/** Bounded no-follow read of a coordination record (nlink 1 or 2 while publishing). */
function readCoordinationRecord(entryPath) {
  let before;
  try {
    before = fs.lstatSync(entryPath, { bigint: true });
  } catch {
    return undefined;
  }
  if (before.isSymbolicLink() || !before.isFile()) return undefined;
  // 2 is the publisher's transient candidate pairing; anything higher is not the
  // single-link record this protocol publishes.
  if (before.nlink !== 1n && before.nlink !== 2n) return undefined;
  if (before.size > BigInt(MAX_COORDINATION_BYTES)) return undefined;
  let fd;
  try {
    fd = fs.openSync(entryPath, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0));
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(MAX_COORDINATION_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return parseCoordinationRecord(bytes.subarray(0, Math.min(length, MAX_COORDINATION_BYTES)).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The parsed record stands; only the descriptor is lost.
    }
  }
}

/**
 * Prepare this process's coordination record as a private, already-complete
 * candidate. Publication is a separate atomic step so a paused publisher can
 * never expose a half-written canonical entry.
 */
function prepareCoordinationCandidate(stateDir) {
  const candidate = path.join(stateDir, `${COORDINATION}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  // Retried on every preparation: an initially failed own-birth query is never
  // cached, so a transient failure cannot permanently prevent publishing.
  const body = coordinationRecordBody(process.pid, ownOwnerIdentity());
  let fd;
  try {
    fd = fs.openSync(candidate, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // Preserve the failure.
    }
    return undefined;
  }
  return {
    candidate,
    body,
    /**
     * Atomic no-overwrite publish. `link` fails with EEXIST when another holder
     * already published, so an existing entry is never overwritten (no rename or
     * move onto it) and this publisher never adopts it. Returns "published",
     * "lost" when another holder won, or "failed" for a real filesystem error.
     */
    publish(entryPath) {
      try {
        fs.linkSync(candidate, entryPath);
        return "published";
      } catch (error) {
        const code = error && error.code;
        return code === "EEXIST" ? "lost" : "failed";
      } finally {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // A leftover candidate is private residue, never a gate.
        }
      }
    },
  };
}

/**
 * Remove exactly the observed coordination entry name. The entry is not a
 * directory and is never followed; unlinking one hard link leaves any other
 * name's bytes intact. Directory/link shapes are confined to this entry.
 */
function reclaimCoordinationEntry(entryPath, observedIdentity) {
  let stat;
  try {
    stat = fs.lstatSync(entryPath, { bigint: true });
  } catch (error) {
    return error && error.code === "ENOENT" ? "reclaimed" : "failed";
  }
  if (`${stat.dev}:${stat.ino}` !== observedIdentity) return "kept";
  try {
    if (stat.isDirectory()) {
      fs.rmdirSync(entryPath);
      return "reclaimed";
    }
    fs.unlinkSync(entryPath);
    return "reclaimed";
  } catch (error) {
    return error && error.code === "ENOENT" ? "reclaimed" : "failed";
  }
}

/**
 * Bounded exclusive acquisition of the canonical per-agent coordination mutex.
 *
 * A current holder (pid alive with its recorded identity) is honored: `skip`
 * mode waits briefly and then continues without reclaiming anything, while
 * `hold` mode (the ownership handoff) waits for the whole bounded holder pass.
 * Anything else — a dead pid, a reused pid, an empty/malformed/legacy record, or
 * a non-live metadata shape — is reclaimed confined to this exact entry, so stale
 * metadata can never gate a start.
 */
function acquireCoordinationEntry(stateDir, options = {}) {
  const entryPath = path.join(stateDir, COORDINATION);
  const waitForLiveOwner = options.waitForLiveOwner === true;
  const deadline = performance.now() + LOCK_WAIT_MS;
  let malformedIdentity;
  let malformed = 0;
  let unremovableSince;
  for (;;) {
    const ownIdentity = ownOwnerIdentity();
    if (ownIdentity === "") {
      // Honest failure: a pid-only record would pin a later start behind a reused
      // pid forever, so no record is published at all.
      return { status: "unavailable" };
    }
    const candidate = prepareCoordinationCandidate(stateDir);
    if (!candidate) return { status: "unavailable" };
    const outcome = candidate.publish(entryPath);
    if (outcome === "published") {
      let created;
      try {
        created = fs.lstatSync(entryPath, { bigint: true });
      } catch {
        return { status: "unavailable" };
      }
      const createdIdentity = `${created.dev}:${created.ino}`;
      return {
        status: "held",
        identity: ownIdentity,
        /**
         * Remove only this process's own record, and only while that exact entry
         * is still the one this acquisition published.
         */
        release() {
          const record = readCoordinationRecord(entryPath);
          if (!record || record.pid !== process.pid) return;
          let observed;
          try {
            observed = fs.lstatSync(entryPath, { bigint: true });
          } catch {
            return;
          }
          if (`${observed.dev}:${observed.ino}` !== createdIdentity) return;
          try {
            fs.unlinkSync(entryPath);
          } catch {
            // A replaced or already-removed entry is not ours to remove.
          }
        },
      };
    }
    if (outcome === "failed") return { status: "unavailable" };
    // Another holder published first: observe it, never adopt or overwrite it.
    let observed;
    try {
      observed = fs.lstatSync(entryPath, { bigint: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        malformed = 0;
        malformedIdentity = undefined;
        if (!waitForLiveOwner && performance.now() >= deadline) {
          return { status: "unavailable" };
        }
        continue;
      }
      return { status: "unavailable" };
    }
    const observedIdentity = `${observed.dev}:${observed.ino}`;
    const record = readCoordinationRecord(entryPath);
    if (record && record.pid === process.pid) {
      // A record naming this very pid can only be this process's own hold or a
      // predecessor's residue with a reused number; no other live process can
      // hold it. Self-adoption requires a matching birth identity so a pid-only or
      // unverifiable record is never adopted, but it is never waited on either —
      // waiting on ourselves would deadlock the launcher/host handoff forever.
      if (ownIdentity !== "" && record.identity === ownIdentity) {
        // This process already holds it (launcher handoff); single-threaded
        // execution means no destructive pass runs beside it.
        return { status: "self", identity: record.identity };
      }
    } else if (record && coordinationOwnerIsCurrent(record)) {
      malformed = 0;
      malformedIdentity = undefined;
      unremovableSince = undefined;
      if (waitForLiveOwner) {
        sleep(25);
        continue;
      }
      if (performance.now() >= deadline) return { status: "unavailable" };
      sleep(25);
      continue;
    }
    // Dead pid, reused pid, empty/malformed body, or non-live metadata shape.
    if (record === undefined) {
      if (observedIdentity !== malformedIdentity) {
        malformed = 0;
        malformedIdentity = observedIdentity;
      }
      malformed += 1;
      if (malformed < 3) {
        sleep(25);
        continue;
      }
      malformed = 0;
      malformedIdentity = undefined;
    }
    const reclaimed = reclaimCoordinationEntry(entryPath, observedIdentity);
    if (reclaimed === "failed") {
      if (unremovableSince === undefined) unremovableSince = performance.now();
      if (performance.now() - unremovableSince >= CLEANUP_BUDGET_MS) return { status: "unavailable" };
      sleep(25);
      continue;
    }
    unremovableSince = undefined;
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
    }
  } finally {
    dir.closeSync();
  }
  // Deterministic directory-name order: no age, size, or lifetime policy is
  // applied, and every excess generation is equally disposable.
  return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Bounded, no-follow removal of one designated cache generation, with deletion
 * as progress: each visited entry is unlinked immediately, so a pass that stops
 * at the shared runtime budget keeps everything it already removed and the next
 * pass continues from whatever remains. There is no whole-tree preflight and no
 * entry-count or depth quota, so a large or deep generation can never be
 * permanently undeletable. Links are unlinked themselves and never traversed, so
 * data outside the generation is untouched; a hardlinked file only loses this
 * name. Returns "removed" only when the whole entry (including its root
 * directory) is gone, "partial" when the shared budget stopped a pass that had
 * already deleted real content, and "failed" for a real filesystem error.
 */
function remove(root, deadline, pass) {
  // Explicit depth-first stack (no recursion): an arbitrarily deep generation
  // cannot exhaust the call stack. Progress is tracked at PASS scope, so the
  // budget's single initial allowance belongs to the whole pass: after the first
  // deletion anywhere, every later entry and every later candidate is deadline
  // checked. A bound hit that deleted nothing can therefore never repeat forever,
  // and a long run of tiny generations cannot continue past the budget while the
  // canonical mutex is still held.
  const state = pass && typeof pass === "object" ? pass : { removed: 0 };
  const stack = [{ file: path.resolve(root), entries: undefined, index: 0 }];
  const progress = () => { state.removed = (Number.isFinite(state.removed) ? state.removed : 0) + 1; };
  try {
    while (stack.length > 0) {
      if (state.removed > 0 && performance.now() >= deadline) return "partial";
      const frame = stack[stack.length - 1];
      if (frame.entries === undefined) {
        const stat = fs.lstatSync(frame.file, { bigint: true });
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(frame.file);
          progress();
          stack.pop();
          continue;
        }
        if (!stat.isDirectory()) {
          // Every non-directory entry inside this designated disposable
          // generation is only a name here (ordinary file, FIFO, socket, or
          // device): unlinking it never opens or follows it.
          fs.unlinkSync(frame.file);
          progress();
          stack.pop();
          continue;
        }
        frame.entries = fs.readdirSync(frame.file, { withFileTypes: true });
        frame.index = 0;
      }
      if (frame.index < frame.entries.length) {
        if (state.removed > 0 && performance.now() >= deadline) return "partial";
        const entry = frame.entries[frame.index];
        frame.index += 1;
        const child = path.join(frame.file, entry.name);
        if (entry.isSymbolicLink()) {
          fs.unlinkSync(child);
          progress();
          continue;
        }
        if (entry.isDirectory()) {
          // Cleanup-specific traversal: this whole generation is a designated
          // disposable cache, so nested directories inside it are entered and
          // removed by path (still no-follow and confined to this generation).
          stack.push({ file: child, entries: undefined, index: 0 });
          continue;
        }
        fs.unlinkSync(child);
        progress();
        continue;
      }
      fs.rmdirSync(frame.file);
      progress();
      stack.pop();
    }
    return "removed";
  } catch {
    // A partial removal leaves the remaining entry counted; a later cleanup
    // retries it. Report nothing as reclaimed.
    return "failed";
  }
}

/**
 * Reclaim excess generations down to the per-type target within one shared
 * cleanup budget. Runs under one short exclusive admission lock while this
 * producer also holds the per-agent coordination boundary, so a host becoming
 * the owner cannot interleave. `hostOwned` is rechecked at every destructive
 * boundary: even when that boundary could not be taken, a host's ownership
 * record stops further removal instead of being raced by cleanup. `keep` names
 * the generation(s) this launch selected/created, which are never candidates.
 */
function reclaim(cacheRoot, options, warnings, hostOwned, pass) {
  const keep = new Set((Array.isArray(options.keep) ? options.keep : []).map((root) => path.resolve(root)));
  const target = Number.isInteger(options.target) ? options.target : LIMIT - 1;
  let entries;
  try {
    entries = inventory(cacheRoot);
  } catch (error) {
    warnings.push(`cache inventory was unavailable (${error.message}); continuing without reclamation`);
    return { reclaimed: 0, remaining: undefined, stopped: false };
  }
  let count = entries.length;
  let reclaimed = 0;
  let stopped = false;
  for (const entry of entries) {
    if (count <= target) break;
    if (pass.removed > 0 && performance.now() >= pass.deadline) {
      // The pass already deleted something and has now reached its budget: do
      // not start another candidate (each empty directory or link would
      // otherwise be processed past the budget while the mutex is held).
      stopped = true;
      break;
    }
    if (keep.has(path.resolve(entry.file))) continue;
    // A consumer that is running code from this generation keeps it: the
    // preserve predicate is the consumer-lease boundary, separate from this
    // launch's own selection.
    if (typeof options.preserve === "function" && options.preserve(entry.file)) continue;
    if (typeof hostOwned === "function" && hostOwned()) {
      warnings.push(HOST_OWNED_DURING_CLEANUP_WARNING);
      break;
    }
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
    const outcome = remove(entry.file, pass.deadline, pass);
    if (outcome !== "removed") {
      // A budget stop is not a failure: real content was already deleted and the
      // next pass continues. Only a removal that failed is reported as a failure
      // for this generation.
      if (outcome === "partial") {
        stopped = true;
        break;
      }
      warnings.push(`could not reclaim cache generation ${entry.name}; it remains and startup continues`);
      continue;
    }
    count -= 1;
    reclaimed += 1;
    // Retire a producer's existing freshness pointer only AFTER its generation
    // is gone. This is not another capacity or lifetime index.
    try {
      retire?.();
    } catch {
      // A stale pointer simply remains non-reusable.
    }
  }
  if (count > target) {
    if (stopped) {
      warnings.push(`cache cleanup stopped at its runtime budget after reclaiming ${reclaimed} generations; ${count} remain (target ${target}) and the next preparation reclaims more`);
    } else {
      warnings.push(`cache retains ${count} generations (target ${target}); startup continues`);
    }
  }
  return { reclaimed, remaining: count, stopped };
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
 * bounded cleanup warnings; options.cleanupBudgetMs replaces the default
 * one-pass runtime budget (a narrow seam for deterministic regressions, not a
 * public setting).
 */
function admit(cacheRoot, create, options = {}) {
  const cache = path.resolve(cacheRoot);
  const warnings = [];
  const hostOwned = () => activeHostOwnsAgentDirectory(cache);
  const budgetMs = Number.isFinite(options.cleanupBudgetMs) ? options.cleanupBudgetMs : CLEANUP_BUDGET_MS;
  // ONE budget for the whole pass (inventory plus every removal it attempts),
  // not a fresh deadline per generation.
  const pass = { deadline: performance.now() + budgetMs, removed: 0 };
  let lock;
  // The canonical per-agent coordination boundary is taken FIRST and released
  // only after this producer has created (and marked) its own generation. Host
  // ownership acquisition takes the same boundary, so cleanup and acquiring
  // ownership are mutually exclusive in both directions.
  const coordination = coordinate(cache, warnings);
  if (coordination && hostOwned()) {
    warnings.push(HOST_OWNED_WARNING);
  } else if (coordination) {
    // A held or genuinely unremovable lock reports its own truthful warning;
    // creation always proceeds and cleanup trouble never stops a start.
    lock = acquire(cache, warnings);
    // Recheck after any wait or stale/malformed lock recovery, whichever way the
    // acquisition ended: a host may have become the owner while this producer
    // waited, and that is the reason cleanup must not touch this cache.
    if (hostOwned()) {
      warnings.push(HOST_OWNED_WARNING);
      lock?.release();
      lock = undefined;
    }
    if (lock) {
      try {
        if (options.replacement) {
          const target = path.resolve(options.replacement.root);
          const eligible = typeof options.replacement.eligible === "function" && options.replacement.eligible() === true;
          // The same live-owner protection as ordinary reclamation: a producer
          // still filling this exact generation must never be deleted, and a
          // host that appeared meanwhile keeps its generations.
          if (path.dirname(target) === cache && eligible && !hostOwned() && !generationIsInProgress(target)) {
            const outcome = remove(target, pass.deadline, pass);
            if (outcome === "failed") warnings.push(`could not reclaim the incomplete generation ${path.basename(target)}; continuing`);
          }
        }
        // Trim to four so creating this launch's ONE new generation lands at or
        // below the per-type target of five whenever that is possible. A producer
        // that cannot take its destructive boundary at all (for example because
        // its consumer leases are only observable under a separate coordination
        // lock) passes `reclaim: false` and runs its coordinated, lease-aware
        // pass after publication instead.
        if (options.reclaim !== false) {
          reclaim(cache, { ...options, target: LIMIT - 1 }, warnings, hostOwned, pass);
        }
      } catch (error) {
        // A preparation failure ends this admission; creation is never blocked
        // by cleanup trouble, which `reclaim` itself reports as warnings.
        lock.release();
        coordination.release();
        throw error;
      }
    }
  }
  for (const warning of warnings) {
    if (typeof options.warn === "function") options.warn(warning);
  }
  // Creation runs under the same admission, and the lock stays held until the
  // producer settles its setup. Another producer therefore skips cleanup while
  // a generation is still being filled instead of deleting it mid-setup. The
  // coordination boundary is released once the fresh generation exists, so a
  // starting host is never held behind a long build or install.
  let stage;
  try {
    stage = create();
  } catch (error) {
    coordination?.release();
    lock?.release();
    throw error;
  }
  if (path.dirname(path.resolve(stage.root)) !== cache) {
    coordination?.release();
    lock?.release();
    throw new Error("generation escaped its cache");
  }
  try {
    identity(stage.root);
    writeMarker(stage.root);
  } catch (error) {
    coordination?.release();
    lock?.release();
    throw error;
  }
  coordination?.release();
  return {
    ...stage,
    generation: handle(stage.root, () => {
      clearMarker(stage.root);
      lock?.release();
    }),
  };
}

/**
 * Cleanup-only pass for producers that reuse or settle an existing generation.
 * It reclaims excess generations toward the per-type target of five, never
 * creates anything, and never touches the root(s) this launch selected or just
 * created (`options.keep`). A warm startup therefore advances pending cleanup
 * instead of abandoning it until the next fresh build, without a rebuild merely
 * to trigger cleanup. Every lock/host/failure case is reported exactly as an
 * admission reports it; the reuse itself still proceeds.
 */
function cleanup(cacheRoot, options = {}) {
  const cache = path.resolve(cacheRoot);
  const warnings = [];
  const hostOwned = () => activeHostOwnsAgentDirectory(cache);
  const budgetMs = Number.isFinite(options.cleanupBudgetMs) ? options.cleanupBudgetMs : CLEANUP_BUDGET_MS;
  const pass = { deadline: performance.now() + budgetMs, removed: 0 };
  let result = { reclaimed: 0, remaining: undefined, stopped: false, skipped: false };
  const coordination = coordinate(cache, warnings);
  if (coordination) {
    try {
      if (hostOwned()) {
        warnings.push(HOST_OWNED_WARNING);
      } else {
        const lock = acquire(cache, warnings);
        if (lock) {
          try {
            if (hostOwned()) warnings.push(HOST_OWNED_WARNING);
            else result = { ...reclaim(cache, { ...options, target: LIMIT }, warnings, hostOwned, pass), skipped: false };
          } finally {
            lock.release();
          }
        } else {
          result = { ...result, skipped: true };
        }
      }
    } finally {
      coordination.release();
    }
  } else {
    result = { ...result, skipped: true };
  }
  for (const warning of warnings) {
    if (typeof options.warn === "function") options.warn(warning);
  }
  return result;
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

module.exports = {
  RECORD,
  MARKER,
  LOCK,
  COORDINATION,
  LIMIT,
  CLEANUP_BUDGET_MS,
  admit,
  cleanup,
  pin,
  holdAgentDirectory,
  /**
   * Narrow seams for the deterministic coordination regressions: the canonical
   * record's atomic publication, its bounded read, and the targeted single-pid
   * owner identity. These are the same functions the acquisition loop uses.
   */
  coordinationInternals: {
    prepareCoordinationCandidate,
    readCoordinationRecord,
    ownerStartIdentity,
    /**
     * The bounded owned asynchronous birth probe the cleanup-lock wait uses: at
     * most one helper alive, a verdict that exists only after that helper's
     * positive close, and a slot that reads "unconfirmed" until the real close
     * lands. Resource accounting only — no cache, registry, or authority.
     */
    startOwnerIdentityProbe,
    ownerProbeSlotState,
    ownOwnerIdentity: () => ownOwnerIdentity(),
    /**
     * Narrow seam for the deterministic mutex error-handling regression: replace
     * the birth query, returning a restore function. Never consulted by the CLI.
     */
    setOwnerIdentityQuery: (query) => {
      const previous = ownerIdentityQuery;
      const previousOwn = OWN_OWNER_IDENTITY_CACHE;
      ownerIdentityQuery = typeof query === "function" ? query : previous;
      // Re-learn this process's own identity under the replacement query, so an
      // initially failed own-birth lookup is exercised exactly as at load.
      OWN_OWNER_IDENTITY_CACHE = "";
      return () => { ownerIdentityQuery = previous; OWN_OWNER_IDENTITY_CACHE = previousOwn; };
    },
  },
};
