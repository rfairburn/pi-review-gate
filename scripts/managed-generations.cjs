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
/** Per-agent coordination entry shared with the session host's ownership guard. */
const COORDINATION = "host-coordination.lock";
const LIMIT = 5;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const CLEANUP_DEADLINE_MS = 120_000;
const LOCK_WAIT_MS = 2_000;
const MAX_LOCK_BYTES = 64;
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

const LOCK_OWNER = /^(\d{1,10})\n?$/u;

/** A lock record is only ever a fresh single-linked small regular file. */
function lockRecordCandidate(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(MAX_LOCK_BYTES);
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
    const owner = LOCK_OWNER.exec(readLockOwner(file) ?? "");
    if (owner && (Number(owner[1]) === process.pid || processIsAlive(Number(owner[1])))) return "kept";
  }
  try {
    if (!stat.isDirectory()) {
      fs.unlinkSync(file);
      return "reclaimed";
    }
    return remove(file) ? "reclaimed" : "failed";
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
      const owner = LOCK_OWNER.exec((lockRecordCandidate(observed) ? readLockOwner(file) : undefined) ?? "");
      if (owner && Number(owner[1]) === process.pid) {
        // Same-process concurrency cannot be waited out (the holder only
        // settles on another turn of this event loop): skip cleanup at once.
        warnings.push(messages.busy);
        return undefined;
      }
      if (owner && processIsAlive(Number(owner[1]))) {
        // A live owner is never ours: wait, then skip cleanup. A selection
        // handoff waits for the whole bounded destructive pass instead.
        malformed = 0;
        malformedIdentity = undefined;
        if (options.waitForLiveOwner === true) {
          sleep(25);
          continue;
        }
      } else if (owner) {
        // A dead owner's record is reclaimed only if it is still that record.
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
 */
function ensureCoordinationDirectory(stateDir) {
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
const { execFileSync } = require("node:child_process");

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

/**
 * Target single-pid process-start token used as the owner-lifetime identity, in
 * one exact per-platform format so a writer and a reader agree byte for byte:
 * - `linux:<boot identity>:<starttime ticks>` from this single pid's
 *   `/proc/<pid>/stat` (no procps `ps` needed, so minimal/BusyBox distributions
 *   work);
 * - `darwin:<ps lstart token>` from one targeted `ps -p <pid>` query;
 * - `win32:<StartTime round-trip>` from one targeted native PowerShell query
 *   (the same facility and format the PowerShell producer uses).
 * Always exactly one pid, never a process census, and no third-party package.
 * An empty result means the identity genuinely cannot be established.
 */
function ownerStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") {
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
  if (process.platform === "darwin") {
    const ps = standardBinary(["/bin/ps", "/usr/bin/ps"])
      || (() => {
        try {
          return execFileSync("sh", ["-c", "command -v ps"], { encoding: "utf8", timeout: 5_000 }).trim() || undefined;
        } catch {
          return undefined;
        }
      })();
    if (!ps) return "";
    try {
      const output = execFileSync(ps, ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const token = String(output).replace(/\s+/gu, " ").trim();
      return token.length > 0 && token.length <= MAX_COORDINATION_BYTES - 48 ? `darwin:${token}` : "";
    } catch {
      return "";
    }
  }
  if (process.platform === "win32") {
    // The existing native Windows PowerShell facility queries exactly one known
    // numeric pid; the value is validated digits and passed as a fixed argv entry,
    // so no shell string is ever composed. Bounded and non-interactive.
    const powershell = standardBinary([
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\pwsh.exe`,
    ]);
    if (!powershell) return "";
    const script = "& { param([int]$OwnerPid) try { $p = Get-Process -Id $OwnerPid -ErrorAction Stop; "
      + "[Console]::Out.Write('win32:' + $p.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)) } "
      + "catch { exit 2 } }";
    try {
      const output = execFileSync(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", script, String(pid),
      ], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const token = String(output).trim();
      return /^win32:.{4,}$/u.test(token) && token.length <= MAX_COORDINATION_BYTES - 48 ? token : "";
    } catch {
      return "";
    }
  }
  return "";
}

const OWN_OWNER_IDENTITY = ownerStartIdentity(process.pid);

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
 * record without a birth identity is never honored on any platform.
 */
function coordinationOwnerIsCurrent(record) {
  if (!record || !processIsAlive(record.pid)) return false;
  // A record without a birth identity is never honored: pid-only metadata could
  // otherwise be pinned forever behind an unrelated live process.
  if (record.identity === "") return false;
  return ownerStartIdentity(record.pid) === record.identity;
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
  const body = coordinationRecordBody(process.pid, OWN_OWNER_IDENTITY);
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
    if (OWN_OWNER_IDENTITY === "") {
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
        identity: OWN_OWNER_IDENTITY,
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
    if (record && record.pid === process.pid && record.identity === OWN_OWNER_IDENTITY) {
      // This process already holds it (launcher handoff); single-threaded
      // execution means no destructive pass runs beside it. A record naming this
      // pid with a different birth identity is stale metadata, not this hold.
      return { status: "self", identity: record.identity };
    }
    if (record && coordinationOwnerIsCurrent(record)) {
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
      if (performance.now() - unremovableSince >= CLEANUP_DEADLINE_MS) return { status: "unavailable" };
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
      // Every non-directory, non-link entry inside this designated disposable
      // generation is only a name here (ordinary file, FIFO, socket, or device):
      // unlinking it never opens or follows it, and it leaves no disposable
      // residue that a later cleanup could still have to reclaim.
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
 * exclusive admission lock while this producer also holds the per-agent
 * coordination boundary, so a host becoming the owner cannot interleave.
 * `hostOwned` is rechecked at every destructive boundary: even when that
 * boundary could not be taken, a host's ownership record stops further removal
 * instead of being raced by cleanup.
 */
function reclaim(cacheRoot, options, warnings, hostOwned) {
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
  const hostOwned = () => activeHostOwnsAgentDirectory(cache);
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
            if (!remove(target)) warnings.push(`could not reclaim the incomplete generation ${path.basename(target)}; continuing`);
          }
        }
        reclaim(cache, options, warnings, hostOwned);
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
  admit,
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
    ownOwnerIdentity: () => OWN_OWNER_IDENTITY,
  },
};
