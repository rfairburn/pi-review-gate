#!/usr/bin/env node
"use strict";

/**
 * Per-fixture cleanup-refusal entries for the test-scratch runner.
 *
 * A strict fixture that cannot resolve ownership, or cannot confirm that its
 * owned children/handles settled, records one entry here. The runner refuses
 * to delete an invocation root that contains any unresolved entry. Entries are
 * independent: resolving one never clears another, so a test that deliberately
 * triggers and resolves a synthetic refusal cannot erase an unrelated
 * fixture's unresolved refusal.
 *
 * Entries live in a top-level directory of the invocation root and are only
 * ever inspected one level deep; nothing under them is followed or removed.
 */
const fs = require("node:fs");
const path = require("node:path");

const REFUSAL_DIR = ".pi-test-scratch-refusals";
let sequence = 0;

function refusalDirectory(root) {
  return path.join(root, REFUSAL_DIR);
}

/**
 * Record one unresolved refusal for the current invocation.
 * Returns a resolver that removes exactly this entry (idempotent).
 * Without an invocation root this is a no-op.
 */
function signalCleanupRefusal(reason = "fixture cleanup refused") {
  const root = process.env.PI_TEST_SCRATCH_ROOT;
  if (!root) return () => {};
  if (fs.realpathSync(root) !== root) {
    throw new Error(`invocation root is no longer canonical: ${root}`);
  }
  const directory = refusalDirectory(root);
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const receipt = fs.lstatSync(directory, { bigint: true });
  if (!receipt.isDirectory()) {
    throw new Error(`refusal path is not a real directory: ${directory}`);
  }
  const entry = path.join(
    directory,
    `${process.pid}-${++sequence}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.writeFileSync(entry, `${reason}\n`, { flag: "wx" });
  let resolved = false;
  return () => {
    if (resolved) return;
    resolved = true;
    try {
      if (fs.realpathSync(root) !== root) return;
      const current = fs.lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.dev !== receipt.dev || current.ino !== receipt.ino) return;
      fs.unlinkSync(entry);
    } catch {
      // The entry was already removed or the root is gone.
    }
  };
}

/**
 * Whether the invocation root has at least one unresolved refusal entry.
 * An unexpected non-directory replacement is itself an unresolved refusal.
 */
function hasUnresolvedCleanupRefusal(root) {
  const stats = fs.lstatSync(refusalDirectory(root), { throwIfNoEntry: false });
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) return true;
  return fs.readdirSync(refusalDirectory(root)).length > 0;
}

module.exports = {
  REFUSAL_DIR,
  signalCleanupRefusal,
  hasUnresolvedCleanupRefusal,
};
