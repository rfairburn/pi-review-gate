'use strict';

/**
 * Owning helper process for the #666 Windows ConPTY reader-settlement regression.
 *
 * This process is the evidence. It:
 *
 *   1. requires the COMPILED PRODUCTION session-host module by absolute path,
 *   2. calls the production `createDefaultPtyFactory()` — no injected factory and
 *      no test shim around the spawn, so the shipped bundled-ConPTY request and
 *      its owned-reader adapter are the real ones,
 *   3. spawns one real child through that public path and journals the exact
 *      public PTY pid plus that handle's genuine exit event,
 *   4. then does nothing else: it never kills, never terminates a Worker, and
 *      never calls `process.exit`.
 *
 * The process ends only when its own event loop drains, so the harness observing
 * this process exit zero — with no kill from anyone — is direct evidence that the
 * owned conout reader actually settled. A live reader Worker would keep this
 * process alive instead.
 *
 * Invoked with `--as-child`, this same file is instead the ConPTY child: it
 * prints one marker, waits for a release file the harness writes (the deliberate
 * quit), then clears its only timer so Node exits naturally with code zero. A
 * fixed self-cap keeps the child finite if the harness never releases it; the
 * child never kills anything either.
 *
 * Only bounded fixed-vocabulary records are journaled: type, pid, exit code,
 * signal, Node version, and platform. Never argv, environment values, or output.
 */

const fs = require("node:fs");

const SELF = __filename;
const CHILD_POLL_MS = 25;
/** Fixed self-cap for the ConPTY child if the harness never releases it. */
const CHILD_CAP_MS = 60_000;
/** Fixed cap for publishing the public PTY pid, which node-pty reports asynchronously. */
const PID_PUBLISH_CAP_MS = 30_000;
const PID_POLL_MS = 25;
const HELPER_STARTED_AT = Date.now();

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--as-child") {
      options.asChild = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function journal(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function runChild(options) {
  const releaseFile = options.release;
  if (typeof releaseFile !== "string" || releaseFile.length === 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("PRG666-CHILD-READY\n");
  const startedAt = Date.now();
  const timer = setInterval(() => {
    let released = false;
    try {
      released = fs.existsSync(releaseFile);
    } catch {
      released = false;
    }
    if (!released && Date.now() - startedAt < CHILD_CAP_MS) return;
    // The deliberate quit: dropping this module's only handle lets Node settle
    // and the process exit with code zero on its own. No process.exit, no kill.
    clearInterval(timer);
  }, CHILD_POLL_MS);
}

function runHelper(options) {
  const journalFile = options.journal;
  const modulePath = options.module;
  const releaseFile = options.release;
  const cwd = options.cwd;
  if (typeof journalFile !== "string" || journalFile.length === 0
    || typeof modulePath !== "string" || modulePath.length === 0
    || typeof releaseFile !== "string" || releaseFile.length === 0
    || typeof cwd !== "string" || cwd.length === 0) {
    process.exitCode = 1;
    return;
  }
  journal(journalFile, {
    type: "helper_started",
    pid: process.pid,
    platform: process.platform,
    node: process.versions.node,
  });
  try {
    const production = require(modulePath);
    if (typeof production.createDefaultPtyFactory !== "function") {
      throw new Error("production module exposes no default PTY factory");
    }
    const factory = production.createDefaultPtyFactory();
    const pty = factory({
      file: process.execPath,
      args: [SELF, "--as-child", "--release", releaseFile],
      env: { ...process.env },
      cwd,
      cols: 80,
      rows: 24,
    });
    const dataSubscription = pty.onData(() => {
      // The output stream is consumed and discarded; this process renders nothing.
    });
    let pidTimer;
    let pidPublished = false;
    const publishPid = () => {
      const pid = pty.pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) {
        if (pidTimer !== undefined) clearInterval(pidTimer);
        pidTimer = undefined;
        pidPublished = true;
        journal(journalFile, { type: "pty_spawn", pid });
        return true;
      }
      return false;
    };
    pidTimer = setInterval(() => {
      if (publishPid() || Date.now() - HELPER_STARTED_AT > PID_PUBLISH_CAP_MS) {
        clearInterval(pidTimer);
        pidTimer = undefined;
        if (!pidPublished) journal(journalFile, { type: "pid_unpublished" });
      }
    }, PID_POLL_MS);
    pty.onExit((event) => {
      journal(journalFile, {
        type: "pty_exit",
        pid: typeof pty.pid === "number" ? pty.pid : null,
        exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
        signal: event.signal === undefined ? null : event.signal,
      });
      if (pidTimer !== undefined) {
        clearInterval(pidTimer);
        pidTimer = undefined;
      }
      try {
        dataSubscription.dispose();
      } catch {
        // The owned handle is already final; nothing here depends on this.
      }
    });
  } catch (error) {
    // A failed spawn is reported, never hidden: the caller's "exited zero"
    // assertion cannot then be satisfied by an accidentally quiet process.
    journal(journalFile, {
      type: "helper_error",
      name: typeof error && typeof error.name === "string" ? error.name.slice(0, 64) : "unknown",
    });
    process.exitCode = 1;
  }
}

const argvOptions = parseArgs(process.argv.slice(2));
if (argvOptions.asChild) runChild(argvOptions);
else runHelper(argvOptions);
