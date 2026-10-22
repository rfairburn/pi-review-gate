"use strict";

// One owned helper process for the bounded cleanup-lock regressions, in the role
// named by argv[2]:
//
//   holder <stateRoot> [sentinelPath]
//     Acquires the REAL cleanup lock through the production entry point in its own
//     process, reports the published record over IPC, and exits after an ordinary
//     release. It never deletes a lock file directly: the only removal is the
//     production identity-guarded release.
//
//     When `sentinelPath` is given it also acts as its own release coordinator:
//     as soon as that path exists — written by a contender the moment it enters a
//     foreign birth query, synchronous or not — this process releases through the
//     production release path. The contender cannot ask for that release itself,
//     because on the old path it is blocked inside the query, so the observation
//     and the release have to live in another owned process.
//
//   probe
//     A stand-in for one native owner-birth helper. It queries no process and no
//     filesystem at all, and loads no production module, so its own start-up costs
//     no native birth query; it stays alive until its owning test tells it to exit, so
//     a test observes the real window in which a native `ps` or PowerShell query
//     would still have been running, and a real `close` event is the only thing
//     that ends it. `hold` is deliberately ignored, which models a helper whose
//     close cannot be confirmed.
//
//   contender <stateRoot> <sentinelPath> <outcomePath>
//     A contender that takes the cleanup lock as soon as the holder releases, then
//     exits on its own. It reports how long its OWN event loop took to drain after
//     the acquisition succeeded, which is the only way to see a join deadline that
//     stayed referenced after its helper had already closed: the acquisition promise
//     resolves promptly either way, and this process is what would linger. It uses
//     no IPC channel precisely so that natural exit stays measurable.
//
// Both roles exist so the regressions run against real processes and real close
// events instead of timers, on every supported platform.

const fs = require("node:fs");
const path = require("node:path");

/**
 * Loaded only by the roles that actually run the production acquisition path.
 * Requiring `prepare-application.cjs` loads `managed-generations.cjs`, which learns
 * this process's own owner identity synchronously at load time — one targeted `ps`
 * on darwin, one PowerShell launch on win32. The `probe` role queries no process and
 * no filesystem, so loading it there would spend a real native birth query inside
 * the window its owning test measures.
 */
function loadPrepare() {
  return require(path.join(__dirname, "..", "..", "scripts", "prepare-application.cjs"));
}

const CLEANUP_LOCK_NAME = "cleanup.lock";

/** Send one message, running `then` once it has actually been handed off. */
function send(message, then) {
  if (typeof process.send !== "function") {
    if (then !== undefined) then();
    return;
  }
  process.send(message, () => {
    if (then !== undefined) then();
  });
}

/** The record currently at the canonical cleanup entry, or null. */
function readRecord(stateRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateRoot, CLEANUP_LOCK_NAME), "utf8"));
  } catch {
    return null;
  }
}

function runProbe() {
  // Nothing here is time-based: only an explicit instruction from the owning test,
  // or a real termination signal, ends this process. Leaving when the channel
  // closes means a helper can never outlive the test that owns it.
  const keepAlive = setInterval(() => {}, 60_000);
  process.on("disconnect", () => process.exit(0));
  process.on("message", (message) => {
    if (message === "hold") return;
    if (message === "finish") {
      clearInterval(keepAlive);
      process.exit(0);
      return;
    }
    if (message === "fail") {
      clearInterval(keepAlive);
      process.exit(3);
    }
  });
  send({ type: "ready" });
}

async function runHolder(stateRoot, sentinelPath) {
  const prepare = loadPrepare();
  process.on("disconnect", () => process.exit(0));
  const lock = await prepare.__test.acquireCleanupLock(stateRoot);
  if (lock === null) {
    send({ type: "failed", pid: process.pid }, () => process.exit(1));
    return;
  }
  const record = readRecord(stateRoot);
  send({
    type: "held",
    pid: process.pid,
    birth: typeof record?.birth === "string" ? record.birth : "",
    nonce: typeof record?.nonce === "string" ? record.nonce : "",
  });
  let released = false;
  const release = (reason) => {
    if (released) return;
    released = true;
    // An ordinary release: the identity-guarded release removes exactly this
    // owner's record, then the holder exits normally.
    lock.release();
    const after = readRecord(stateRoot);
    send({ type: "released", pid: process.pid, reason, present: after !== null }, () => process.exit(0));
  };
  process.on("message", (message) => {
    if (message !== "release") return;
    release("requested");
  });
  if (typeof sentinelPath !== "string" || sentinelPath.length === 0) return;
  // The coordinator half of this role: poll for the sentinel in THIS process, so a
  // contender that is blocked inside a synchronous query is still observed. The
  // poll is bounded by the holder's own lifetime — it holds until it is told to
  // stop, which is the point of the fixture.
  const watch = setInterval(() => {
    if (!fs.existsSync(sentinelPath)) return;
    clearInterval(watch);
    release("sentinel");
  }, 10);
}

/**
 * One owned helper that closes promptly once asked, which is the case a leftover
 * join deadline timer hides: the join wins, the acquisition resolves promptly, and
 * only this process's own drain reveals a referenced timer.
 */
function installPromptlyClosingHelper(internals, sentinel) {
  const verdict = { identity: "", reason: "canceled" };
  internals.startOwnerIdentityProbe = () => {
    // Entering a birth query is what the holder's coordinator watches for.
    if (!fs.existsSync(sentinel)) fs.writeFileSync(sentinel, "entered\n");
    let settle;
    const close = new Promise((resolve) => { settle = resolve; });
    const handle = {
      state: "pending",
      verdict: undefined,
      close,
      cancel() {
        if (handle.state !== "pending") return;
        handle.state = "closed";
        handle.verdict = verdict;
        settle(verdict);
      },
    };
    return { status: "started", probe: handle };
  };
  internals.ownerProbeSlotState = () => "free";
}

async function runContender(stateRoot, sentinel, outcomePath) {
  if ([stateRoot, sentinel, outcomePath].some((value) => typeof value !== "string" || value.length === 0)) {
    process.exit(2);
    return;
  }
  const prepare = loadPrepare();
  const generations = require(path.join(__dirname, "..", "..", "scripts", "managed-generations.cjs"));
  installPromptlyClosingHelper(generations.coordinationInternals, sentinel);
  const lock = await prepare.__test.acquireCleanupLock(stateRoot);
  const acquiredAt = Date.now();
  if (lock !== null) lock.release();
  // `beforeExit` IS the drain: a timer still referenced here pushes it out by the
  // rest of the cleanup budget. Nothing in this role ever calls `process.exit()`.
  let written = false;
  process.on("beforeExit", () => {
    if (written) return;
    written = true;
    fs.writeFileSync(outcomePath, `${JSON.stringify({
      acquired: lock !== null,
      drainMs: Date.now() - acquiredAt,
    })}\n`);
  });
}

const role = process.argv[2];
if (role === "probe") {
  runProbe();
} else if (role === "holder") {
  const stateRoot = process.argv[3];
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    process.exit(2);
  } else {
    void runHolder(stateRoot, process.argv[4]);
  }
} else if (role === "contender") {
  void runContender(process.argv[3], process.argv[4], process.argv[5]);
} else {
  process.exit(2);
}
