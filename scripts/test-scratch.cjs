#!/usr/bin/env node
"use strict";

/**
 * Run one test command inside a fresh private scratch root.
 *
 * The root is allocated under the host temporary directory, never inside the
 * development checkout, and is exported to the child as TMPDIR/TEMP/TMP (and
 * PI_TEST_SCRATCH_ROOT for fixtures that redirect their checkout-local
 * allocations). After the direct child exits and its stdio closes, the root is
 * removed even if the child failed or threw during setup.
 *
 * Removal happens only for the exact root this process allocated: it records
 * the device/inode identity and canonical path at creation, revalidates both
 * before touching anything, and never follows symlinks. A root that was
 * replaced, moved behind a symlinked ancestor, or is still holding a strict
 * fixture's unresolved cleanup refusal (scripts/test-scratch-refusal.cjs) is
 * retained and the run fails instead of overriding that refusal. An
 * interrupted child (terminated by a signal) is not assumed settled: the root
 * is retained.
 *
 * Usage:
 *   node scripts/test-scratch.cjs [--preserve] -- <command> [...args]
 *
 * --preserve keeps the invocation's filesystem artifacts for evidence and
 * reports the retained path.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hasUnresolvedCleanupRefusal } = require("./test-scratch-refusal.cjs");

// Short prefix: the native Main legs build a macOS Unix-socket path under the
// host temporary directory, and 103 bytes is their hard limit. A long wrapper
// prefix would exhaust that budget before those tests start.
const ROOT_PREFIX = "prg-";
const USAGE = "usage: node scripts/test-scratch.cjs [--preserve] -- <command> [...args]";
const failedOutputs = new Set();

function report(message) {
  if (!failedOutputs.has(process.stderr)) process.stderr.write(`test-scratch: ${message}\n`);
}

function relayOutput(source, destination) {
  if (!source) return; // A resource-exhausted spawn may have no output pipe.
  if (failedOutputs.has(destination)) {
    source.resume();
    return;
  }
  destination.once("error", () => {
    source.unpipe(destination);
    source.resume();
  });
  source.pipe(destination, { end: false });
}

function isInside(parent, candidate) {
  // Compare device/inode identity rather than path spelling: a case-insensitive
  // volume can name the checkout with different capitalization, while distinct
  // differently cased directories on a case-sensitive volume stay distinct.
  const boundary = fs.statSync(parent, { bigint: true });
  for (let current = candidate; ; current = path.dirname(current)) {
    const entry = fs.statSync(current, { bigint: true });
    if (entry.dev === boundary.dev && entry.ino === boundary.ino) return true;
    if (path.dirname(current) === current) return false;
  }
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const unknown = flags.filter((flag) => flag !== "--preserve");
  return {
    preserve: flags.includes("--preserve"),
    unknown,
    command: separator === -1 ? [] : argv.slice(separator + 1),
  };
}

function main(argv) {
  for (const [name, stream] of [["stdout", process.stdout], ["stderr", process.stderr]]) {
    stream.on("error", (error) => {
      if (failedOutputs.has(stream)) return;
      failedOutputs.add(stream);
      process.exitCode ||= 1;
      report(`could not write ${name}: ${error.message}`);
    });
  }
  const { preserve, unknown, command } = parseArgs(argv);
  if (unknown.length > 0) {
    report(`unknown option: ${unknown[0]}`);
    process.exitCode = 2;
    return;
  }
  if (command.length === 0) {
    report(USAGE);
    process.exitCode = 2;
    return;
  }

  const checkout = fs.realpathSync(path.resolve(__dirname, ".."));
  const hostTemp = fs.realpathSync(os.tmpdir());
  if (isInside(checkout, hostTemp) || isInside(fs.realpathSync(process.cwd()), hostTemp)) {
    report(`host temporary directory ${hostTemp} is inside the checkout; refusing to allocate a checkout-local scratch root`);
    process.exitCode = 1;
    return;
  }

  // A nested invocation would otherwise allocate inside the enclosing root and
  // the outer runner would delete its refused or preserved evidence.
  const enclosingRoot = process.env.PI_TEST_SCRATCH_ROOT;
  if (enclosingRoot) {
    let enclosingCanonical;
    try {
      enclosingCanonical = fs.realpathSync(enclosingRoot);
    } catch (error) {
      report(`inherited invocation root is not a usable directory: ${enclosingRoot}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    if (isInside(enclosingCanonical, hostTemp)) {
      report(`refusing to allocate scratch inside an enclosing invocation root: ${enclosingRoot}`);
      process.exitCode = 1;
      return;
    }
  }

  const root = fs.mkdtempSync(path.join(hostTemp, ROOT_PREFIX));
  const receipt = fs.lstatSync(root, { bigint: true });
  const canonical = fs.realpathSync(root);
  report(`invocation root: ${root}`);

  let child;
  let interruptedBy = null;
  const forward = (signal) => () => {
    interruptedBy ??= signal;
    child.kill(signal);
  };
  const forwarded = new Map([["SIGINT", forward("SIGINT")], ["SIGTERM", forward("SIGTERM")]]);

  let finished = false;
  const finish = ({ status, signal, startError }) => {
    if (finished) return;
    finished = true;
    for (const [forwardedSignal, handler] of forwarded) process.off(forwardedSignal, handler);

    if (signal) report(`child terminated by ${signal}`);
    // A runner can catch a forwarded signal and exit with a numeric status
    // while its descendants are still active, so a forwarded interruption is
    // remembered and treated as unsettled even when the child exits normally.
    const interruption = interruptedBy ?? signal;
    const childFailed = startError || interruption !== null || status !== 0;
    const childExitCode = status || (childFailed ? 1 : 0);

    if (interruption) {
      report(`interrupted run; retained invocation root without confirmed settlement: ${root}`);
      process.exitCode = childExitCode || 1;
      return;
    }

    let retained = false;
    try {
      // Validate the root and its canonical location before probing anything
      // inside it, so a replaced root or symlinked ancestor is refused rather
      // than traversed.
      const current = fs.lstatSync(root, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory()
        || current.dev !== receipt.dev || current.ino !== receipt.ino
        || fs.realpathSync(root) !== canonical) {
        retained = true;
        report(`invocation root changed identity or canonical path; retained instead of removing: ${root}`);
      } else if (hasUnresolvedCleanupRefusal(root)) {
        retained = true;
        report(`a test fixture refused cleanup; retained invocation root: ${root}`);
      } else if (!preserve) {
        fs.rmSync(root, { recursive: true, force: false });
        if (fs.lstatSync(root, { throwIfNoEntry: false })) {
          retained = true;
          report(`invocation root still exists after removal; retained: ${root}`);
        }
      }
    } catch (error) {
      retained = true;
      report(`cleanup of invocation root ${root} failed; retained: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!retained) {
      report(preserve
        ? `preserved invocation root (--preserve): ${root}`
        : `removed invocation root: ${root}`);
    }
    process.exitCode = childFailed || retained || failedOutputs.size > 0 ? childExitCode || 1 : 0;
  };

  const reportChildError = (error) => {
    report(`child process error for ${command[0]}: ${error.message}`);
  };

  try {
    // Pipe the child's output through this process: a descendant that inherits
    // stdout/stderr then keeps those pipes open, so the close finalizer waits
    // for observable output-handle settlement before cleanup.
    child = spawn(command[0], command.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        PI_TEST_SCRATCH_ROOT: root,
      },
    });
  } catch (error) {
    // A synchronous launch rejection bypasses the close event; run the normal
    // ownership-checked finalizer so the allocated root is not stranded.
    reportChildError(error);
    finish({ status: 1, signal: null, startError: true });
    return;
  }
  relayOutput(child.stdout, process.stdout);
  relayOutput(child.stderr, process.stderr);
  for (const [signal, handler] of forwarded) process.on(signal, handler);

  let childError = false;
  child.on("error", (error) => {
    childError = true;
    reportChildError(error);
  });
  // close (not exit) so stdio held by an owned subprocess is settled first.
  child.on("close", (status, signal) => finish({ status, signal, startError: childError }));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { runInTestScratch: main };
