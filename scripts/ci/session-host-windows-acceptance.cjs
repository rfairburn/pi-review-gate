#!/usr/bin/env node
'use strict';

/**
 * Bounded scripts copier for the Windows session-host alpha candidate root.
 *
 * Usage:
 *   node scripts/ci/session-host-windows-acceptance.cjs copy-scripts <sourceDir> <destDir>
 *   node scripts/ci/session-host-windows-acceptance.cjs create-root <parentDir>
 *
 * copy-scripts copies the shipped scripts tree (every stage) into a fresh
 * candidate root so the staged candidate keeps its own package-root helper
 * layout:
 * - prunes directories named .terraform before descending into them, at every depth;
 * - refuses symlinks and non-regular files: any such entry in the source tree fails the copy;
 * - bounds file count, per-file size, directory count, nesting depth, per-directory
 *   entry count (checked while enumerating, so a runaway directory cannot exhaust
 *   memory before rejection), and aggregate byte total;
 * - copies each file through bounded public descriptor reads of exactly the
 *   opened descriptor's admitted size (fixed chunk cap, premature EOF fails)
 *   instead of unbounded path reads;
 * - proves source identity with BigInt dev/ino checks: the admitted source
 *   directory receipt is re-verified before and after enumeration and around
 *   every child action, and each file's descriptor identity is checked before
 *   open, after the write (descriptor and path), against the admitted size;
 * - carries BigInt destination-directory receipts through recursion and
 *   re-verifies the owned parent stage around mkdir/open/write operations;
 *   the created leaf's descriptor identity (captured immediately after the
 *   exclusive create) is compared with the final path stat, so a same-sized
 *   replacement leaf or a replaced parent fails closed;
 * - creates destination stages as real directories and writes regular files
 *   only, exclusively (create-new `wx`): a replaced or prepopulated leaf fails
 *   without modifying the original.
 *
 * It never deletes or replaces an existing tree: destDir must not exist, or
 * must exist as an empty real directory, and every file write is create-new.
 * On any race or error the copy fails closed and the partial destination
 * output is retained for inspection, never cleaned up.
 */

const fs = require('node:fs');
const path = require('node:path');

const PRUNED_DIR_NAME = '.terraform';
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIRS = 512;
const MAX_DEPTH = 32;
const MAX_ENTRIES_PER_DIR = 4096;
// The whole scripts tree must fit in one max-size file's worth of bytes.
const MAX_TOTAL_BYTES = 16n * 1024n * 1024n;
const READ_CHUNK_BYTES = 64 * 1024;

function fail(message) {
  process.stderr.write(`session-host-windows-acceptance: ${message}\n`);
  process.exit(1);
}

/**
 * Allocate one fresh exclusive child root under parentDir (Node's O_EXCL
 * mkdtempSync) and print its path. Nothing pre-existing is inspected, cleaned,
 * or replaced; a missing or non-directory parent fails closed.
 */
function createRoot(parentArg) {
  const parent = path.resolve(parentArg);
  assertRealDirectory(parent, 'parent directory');
  let root;
  try {
    root = fs.mkdtempSync(path.join(parent, 'session-host-alpha-'));
  } catch (error) {
    fail(`cannot allocate a fresh exclusive child root under ${parent}: ${error.message}`);
  }
  process.stdout.write(`${root}\n`);
}

function assertRealDirectory(dir, label) {
  const stats = lstatOrFail(dir, label);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail(`${label} must be a real directory, not a symlink or other entry`);
  }
  return stats;
}

function lstatOrFail(target, label) {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    fail(`cannot stat ${label} ${target}: ${error.message}`);
  }
}

/**
 * Re-verify that a stage directory is still the exact real directory
 * recorded in receipt (BigInt dev/ino). A detected replacement fails closed.
 * These checks are not atomic openat-style containment: a concurrent parent
 * replacement can redirect an operation between checks. Such partial output
 * is retained, not cleaned up or presented as a successful copy.
 */
function verifyStage(dir, receipt, label) {
  const now = lstatOrFail(dir, label);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== receipt.dev || now.ino !== receipt.ino) {
    fail(`${label} was replaced; refusing to continue: ${dir}`);
  }
  return now;
}

/**
 * The admitted source snapshot must still hold: identity, size, and mutation
 * timestamps. Access time is deliberately not compared because reads may
 * change it.
 */
function sameSourceSnapshot(now, receipt) {
  return now.isFile() && now.dev === receipt.dev && now.ino === receipt.ino &&
    now.size === receipt.size && now.mtimeNs === receipt.mtimeNs &&
    now.ctimeNs === receipt.ctimeNs;
}

/**
 * Copy one regular source file into destParent/entryName through bounded
 * descriptor reads of exactly the admitted size. preStats is the caller's
 * lstat of sourcePath, destReceipt is the BigInt identity of the owned
 * destination stage, and checkParents re-verifies the complete admitted
 * ancestor chain around every operation; a replaced source, mutated file,
 * or redirected parent fails closed and the partial output is retained.
 */
function copyFileBounded(sourcePath, destParent, entryName, preStats, destReceipt, counter,
  checkParents = () => verifyStage(destParent, destReceipt, 'destination stage')) {
  const destPath = path.join(destParent, entryName);

  // Own the destination parent (and any admitted ancestors) around the leaf
  // operations.
  checkParents();

  let fd;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY
      | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    fail(`cannot open scripts file ${sourcePath}: ${error.message}`);
  }
  try {
    checkParents();
    const current = fs.fstatSync(fd, { bigint: true });
    if (!current.isFile()) {
      fail(`refusing non-regular descriptor for scripts file: ${sourcePath}`);
    }
    // The descriptor must be the very entry we pre-statted: no replacement
    // between lstat and open.
    if (!sameSourceSnapshot(current, preStats)) {
      fail(`source file replaced between stat and open: ${sourcePath}`);
    }
    if (current.size > BigInt(MAX_FILE_BYTES)) {
      fail(`scripts file exceeds the bounded size of ${MAX_FILE_BYTES} bytes: ${sourcePath}`);
    }
    const admittedSize = Number(current.size);
    counter.totalBytes += current.size;
    if (counter.totalBytes > MAX_TOTAL_BYTES) {
      fail(`scripts tree exceeds the bounded aggregate size of ${Number(MAX_TOTAL_BYTES)} bytes: ${sourcePath}`);
    }

    // Exclusive create-new: a replaced or prepopulated leaf fails without
    // modifying the original. The parent chain is re-verified immediately
    // before and after the open to detect redirection; public path operations
    // do not provide atomic parent containment.
    let out;
    checkParents();
    try {
      out = fs.openSync(destPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        fail(`destination leaf already exists; preserving the original: ${destPath}`);
      }
      fail(`cannot create destination file ${destPath}: ${error.message}`);
    }
    // Capture the created descriptor's identity immediately.
    const outIdentity = fs.fstatSync(out, { bigint: true });
    if (!outIdentity.isFile()) {
      fail(`created destination is not a regular file: ${destPath}`);
    }

    let offset = 0;
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    try {
      checkParents();
      while (offset < admittedSize) {
        // Read exactly the admitted descriptor size, capped per read.
        const length = Math.min(buffer.length, admittedSize - offset);
        let bytesRead;
        try {
          bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        } catch (error) {
          fail(`cannot read scripts file ${sourcePath}: ${error.message}`);
        }
        if (bytesRead === 0) {
          fail(`source file shrank during copy; premature EOF at ${offset} of ${admittedSize} bytes: ${sourcePath}`);
        }
        try {
          let written = 0;
          while (written < bytesRead) {
            checkParents();
            const count = fs.writeSync(out, buffer, written, bytesRead - written, offset + written);
            if (!Number.isSafeInteger(count) || count <= 0 || count > bytesRead - written) {
              fail(`destination write made no valid progress; retaining partial output: ${destPath}`);
            }
            written += count;
            checkParents();
          }
        } catch (error) {
          fail(`cannot write destination file ${destPath}: ${error.message}`);
        }
        offset += bytesRead;
      }
      // Validate the created descriptor before closing it.
      const outAfter = fs.fstatSync(out, { bigint: true });
      if (!outAfter.isFile() || outAfter.dev !== outIdentity.dev || outAfter.ino !== outIdentity.ino ||
          outAfter.size !== BigInt(offset)) {
        fail(`created destination changed during write; retaining partial output: ${destPath}`);
      }
    } finally {
      fs.closeSync(out);
    }

    // The admitted source snapshot must still hold at the descriptor and at
    // the path: growth, shrinkage, or a same-sized rewrite during copy fails
    // closed.
    const currentAfter = fs.fstatSync(fd, { bigint: true });
    if (!sameSourceSnapshot(currentAfter, current)) {
      fail(`source file changed during copy; retaining partial output: ${sourcePath}`);
    }
    const after = lstatOrFail(sourcePath, 'scripts file');
    if (!sameSourceSnapshot(after, current)) {
      fail(`source file replaced during copy; retaining partial output: ${sourcePath}`);
    }

    // The destination path must resolve to the exact descriptor we created
    // and wrote: a same-sized replacement leaf has a different identity.
    const destStats = lstatOrFail(destPath, 'created destination file');
    if (!destStats.isFile() || destStats.dev !== outIdentity.dev || destStats.ino !== outIdentity.ino ||
        destStats.size !== BigInt(admittedSize)) {
      fail(`created destination identity mismatch; retaining partial output: ${destPath}`);
    }
    checkParents();
  } finally {
    fs.closeSync(fd);
  }
}

/** Recursively copy one source stage into its destination stage. */
function copyStage(sourceDir, destDir, sourceReceipt, destReceipt, depth, counter,
  checkAncestors = () => {}) {
  // The complete guard: admitted ancestors plus this stage's own receipts.
  const checkParents = () => {
    checkAncestors();
    verifyStage(sourceDir, sourceReceipt, 'source scripts directory');
    verifyStage(destDir, destReceipt, 'destination stage');
  };

  // Re-verify the full chain before enumeration.
  checkParents();

  // Bounded enumeration: stop at MAX_ENTRIES_PER_DIR + 1 entries so a
  // runaway directory cannot exhaust memory before the bound rejects it.
  const entries = [];
  let dirHandle;
  try {
    dirHandle = fs.opendirSync(sourceDir);
  } catch (error) {
    fail(`cannot open scripts tree directory ${sourceDir}: ${error.message}`);
  }
  try {
    for (;;) {
      const entry = dirHandle.readSync();
      if (entry === null) break;
      entries.push(entry);
      if (entries.length > MAX_ENTRIES_PER_DIR) {
        fail(`scripts directory exceeds the bounded entry count of ${MAX_ENTRIES_PER_DIR}: ${sourceDir}`);
      }
    }
  } finally {
    dirHandle.closeSync();
  }

  // Re-verify the full chain after enumeration.
  checkParents();

  for (const entry of entries) {
    // Re-verify the full chain around each child action: a replaced stage or
    // ancestor can redirect the path-based operations below outside it.
    checkParents();

    const sourcePath = path.join(sourceDir, entry.name);
    const stats = lstatOrFail(sourcePath, 'scripts tree entry');
    if (stats.isSymbolicLink()) {
      fail(`refusing symlink in scripts tree: ${sourcePath}`);
    }
    if (stats.isDirectory()) {
      // Prune before descending: .terraform contents are never copied.
      if (entry.name === PRUNED_DIR_NAME) continue;
      if (depth + 1 > MAX_DEPTH) {
        fail(`scripts tree exceeds the bounded depth of ${MAX_DEPTH}: ${sourcePath}`);
      }
      counter.dirs += 1;
      if (counter.dirs > MAX_DIRS) {
        fail(`scripts tree exceeds the bounded directory count of ${MAX_DIRS}: ${sourcePath}`);
      }
      const childDest = path.join(destDir, entry.name);
      checkParents();
      try {
        fs.mkdirSync(childDest);
      } catch (error) {
        if (error.code === 'EEXIST') {
          fail(`destination directory already exists; refusing to replace it: ${childDest}`);
        }
        fail(`cannot create destination directory ${childDest}: ${error.message}`);
      }
      checkParents();
      const childReceipt = lstatOrFail(childDest, 'created destination directory');
      if (!childReceipt.isDirectory() || childReceipt.isSymbolicLink()) {
        fail(`created destination directory is not a real directory: ${childDest}`);
      }
      copyStage(sourcePath, childDest, stats, childReceipt, depth + 1, counter, checkParents);
    } else if (stats.isFile()) {
      counter.files += 1;
      if (counter.files > MAX_FILES) {
        fail(`scripts tree exceeds the bounded file count of ${MAX_FILES}: ${sourcePath}`);
      }
      copyFileBounded(sourcePath, destDir, entry.name, stats, destReceipt, counter, checkParents);
    } else {
      fail(`refusing non-regular file in scripts tree: ${sourcePath}`);
    }
    checkParents();
  }
  checkParents();
}

function copyScripts(sourceArg, destArg) {
  const source = path.resolve(sourceArg);
  const dest = path.resolve(destArg);
  const sourceReceipt = assertRealDirectory(source, 'source scripts directory');
  if (source === dest) fail('source and destination must differ');
  if (dest.startsWith(`${source}${path.sep}`) || source.startsWith(`${dest}${path.sep}`)) {
    fail('source and destination must not be nested');
  }

  let destStats;
  try {
    destStats = fs.lstatSync(dest, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') fail(`cannot stat destination: ${error.message}`);
  }
  if (destStats) {
    if (!destStats.isDirectory() || destStats.isSymbolicLink()) {
      fail('destination must be a real directory, not a symlink or other entry');
    }
    // Bounded emptiness check: stop at the first entry.
    let dirHandle;
    try {
      dirHandle = fs.opendirSync(dest);
    } catch (error) {
      fail(`cannot read destination directory ${dest}: ${error.message}`);
    }
    try {
      if (dirHandle.readSync() !== null) {
        fail('destination already contains entries; refusing to replace an existing tree');
      }
    } finally {
      dirHandle.closeSync();
    }
  } else {
    try {
      fs.mkdirSync(dest);
    } catch (error) {
      if (error.code === 'EEXIST') {
        fail('destination appeared during allocation; refusing to replace an existing tree');
      }
      fail(`cannot create destination directory ${dest}: ${error.message}`);
    }
  }
  // Preserve the pre-existing receipt when one exists: a destination
  // replaced after its emptiness check must not be admitted under its new
  // identity.
  const destReceipt = destStats || lstatOrFail(dest, 'destination directory');
  verifyStage(dest, destReceipt, 'destination directory');

  const counter = { files: 0, dirs: 0, totalBytes: 0n };
  copyStage(source, dest, sourceReceipt, destReceipt, 0, counter);
  process.stdout.write(
    `session-host-windows-acceptance: copied ${counter.files} scripts files ` +
    `(${counter.dirs} directories, ${Number(counter.totalBytes)} bytes) into ${dest}\n`,
  );
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'copy-scripts' && args.length === 2) {
    copyScripts(args[0], args[1]);
    return;
  }
  if (command === 'create-root' && args.length === 1) {
    createRoot(args[0]);
    return;
  }
  process.stderr.write('usage: node scripts/ci/session-host-windows-acceptance.cjs <copy-scripts <sourceDir> <destDir> | create-root <parentDir>>\n');
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

// Exposed for the pure copier-contract tests; fail() exits the process, so
// callers must run these in a child process.
module.exports = { copyFileBounded, copyStage, copyScripts };
