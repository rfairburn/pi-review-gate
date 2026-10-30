/**
 * The one shared production compile for explicit native cases.
 *
 * Proof level: SYNTHETIC for the compile only. The stand-in replaces ONLY the
 * tsc process, so the owned scratch root, the retained receipts, and the
 * unchanged candidate copier stay real. The two pinned native cases in
 * `session-host-network-native-input-copy.test.ts` are the real end-to-end
 * evidence that one actual production compile serves both of them.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { createSharedProductionCompile } from "./helpers/session-host-native-main-harness";

const COMPILED_LEAVES = [
  "index.js",
  "session-host/reporter.js",
  "session-host/bootstrap-preload.js",
];

/** Write the emitted leaves the candidate entry assertions require. */
function writeCompiledTree(compiledRoot: string): void {
  for (const relativePath of COMPILED_LEAVES) {
    const target = join(compiledRoot, "src", relativePath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, "'use strict';\nmodule.exports = {};\n", { mode: 0o600, flag: "wx" });
  }
}

function caseRoot(name: string): string {
  return track(realpathSync(mkdtempSync(join("/tmp", name))));
}

/** Every root this file created, removed after the focused run. */
const owned: string[] = [];

function track(path: string): string {
  owned.push(path);
  return path;
}

after(() => {
  for (const path of owned) rmSync(path, { recursive: true, force: true });
});

test("one synthetic production compile serves two independent fresh candidate stages", (t) => {
  let compiles = 0;
  const shared = createSharedProductionCompile((compiledRoot) => {
    compiles += 1;
    writeCompiledTree(compiledRoot);
  });
  t.after(() => { shared.dispose(); });

  const first = shared.stageCandidate(caseRoot("prg-shared-a-"));
  const second = shared.stageCandidate(caseRoot("prg-shared-b-"));
  assert.equal(compiles, 1, "one production compile served both cases");
  assert.equal(shared.builds, 1);
  assert.notEqual(first.root, second.root, "each case stages its own candidate package");
  assert.deepEqual(readFileSync(second.entry), readFileSync(first.entry),
    "both cases stage the same compiled bytes");
  assert.notEqual(statSync(first.entry).ino, statSync(second.entry).ino,
    "each case stages a fresh exclusive copy, not one shared file");
});

test("a case root replaced during the compile fails closed before any candidate write", () => {
  const root = caseRoot("prg-shared-swap-");
  const moved = track(`${root}-moved`);
  const shared = createSharedProductionCompile((compiledRoot) => {
    writeCompiledTree(compiledRoot);
    renameSync(root, moved);
    mkdirSync(root, { mode: 0o700 });
  });
  try {
    assert.throws(() => shared.stageCandidate(root), /replaced or linked source ancestor/);
    assert.equal(existsSync(join(root, "candidate-package")), false,
      "the pre-compile case-root receipt stays authoritative through staging");
  } finally {
    shared.dispose();
  }
});

test("a compiler failure is never retried", () => {
  let compiles = 0;
  const shared = createSharedProductionCompile(() => {
    compiles += 1;
    throw new Error("synthetic compiler failure");
  });
  try {
    assert.throws(() => shared.stageCandidate(caseRoot("prg-shared-fail-")),
      /synthetic compiler failure/);
    assert.throws(() => shared.stageCandidate(caseRoot("prg-shared-fail-2-")), /never retried/);
    assert.equal(compiles, 1);
    assert.equal(shared.builds, 0);
  } finally {
    shared.dispose();
  }
});

test("an unused shared compile creates nothing and reports no build", () => {
  const shared = createSharedProductionCompile();
  assert.equal(shared.builds, 0);
  assert.equal(shared.dispose(), false);
});
