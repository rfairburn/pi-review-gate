/**
 * Issue #354: the test-scratch runner allocates one private external root per
 * invocation, exports it through the OS temporary configuration, and removes
 * that exact root after success, failure, or partial setup. `--preserve`
 * retains it for evidence and reports the path. Strict fixture refusals and
 * unconfirmed settlement retain the root instead of being overridden.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { retainedFixtureBase } from "./helpers/scratch-fixture-base";

const requireCjs = createRequire(join(process.cwd(), "tests", "test-scratch-wrapper.test.ts"));
const wrapper = resolve(__dirname, "../../scripts/test-scratch.cjs");
const refusalHelper = resolve(__dirname, "../../scripts/test-scratch-refusal.cjs");
const refusal = requireCjs(refusalHelper) as {
  REFUSAL_DIR: string;
  signalCleanupRefusal(reason?: string): () => void;
  hasUnresolvedCleanupRefusal(root: string): boolean;
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the wrapper with an inline Node child, so the regression uses the real runner. */
function runWrapper(args: string[], body: string, tempBase = retainedFixtureBase()): Run {
  const result = spawnSync(process.execPath, [wrapper, ...args, "--", process.execPath, "-e", body], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TMPDIR: tempBase, TEMP: tempBase, TMP: tempBase },
  });
  assert.equal(result.error, undefined, `wrapper failed to run: ${String(result.error)}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The invocation root the child observed through PI_TEST_SCRATCH_ROOT. */
function reportedRoot(run: Run): string {
  const match = /^SCRATCH=(.+)$/m.exec(run.stdout);
  assert.ok(match, `child must report its scratch root; stdout=${run.stdout} stderr=${run.stderr}`);
  return match[1]!;
}

/** Remove only the exact root this test observed the wrapper report. */
function removeReportedRoot(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

function waitFor(check: () => boolean, deadlineMs: number): boolean {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (check()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return check();
}

const REPORT_ROOT = 'process.stdout.write("SCRATCH=" + process.env.PI_TEST_SCRATCH_ROOT + "\\n");';

test("a closed stdout consumer does not bypass teardown or mask the child failure", {
  skip: process.platform === "win32",
}, () => {
  const base = mkdtempSync(join(retainedFixtureBase(), "prg-closed-output-"));
  try {
    const body = `
      require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "artifact"), "owned");
      process.stdout.write("output to closed consumer\\n");
      setTimeout(() => { console.error("original failure"); process.exitCode = 4; }, 100);
    `;
    const supervisor = `
      const runner = require("node:child_process").spawn(process.execPath,
        [${JSON.stringify(wrapper)}, "--", process.execPath, "-e", ${JSON.stringify(body)}],
        { stdio: ["ignore", "pipe", "inherit"] });
      runner.stdout.destroy();
      runner.once("close", (status) => { process.exitCode = status ?? 99; });
    `;
    const run = spawnSync(process.execPath, ["-e", supervisor], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base },
    });
    assert.equal(run.status, 4, run.stderr);
    assert.match(run.stderr, /original failure[\s\S]*removed invocation root/);
    const root = /^test-scratch: invocation root: (.+)$/m.exec(run.stderr)?.[1];
    assert.ok(root, run.stderr);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup waits for a descendant holding the command output pipe", {
  skip: process.platform === "win32",
}, () => {
  const writer = `setTimeout(() => {
    require("node:fs").writeFileSync(require("node:path").join(process.env.TMPDIR, "settled.txt"), "done");
    console.error("owned writer settled");
  }, 300)`;
  const run = runWrapper([], `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
      stdio: ["ignore", "ignore", "inherit"],
    }).unref();
    ${REPORT_ROOT}
    process.exitCode = 4;
  `);
  assert.equal(run.status, 4, run.stderr);
  assert.match(run.stderr, /owned writer settled[\s\S]*removed invocation root/);
  assert.equal(existsSync(reportedRoot(run)), false);
});

test("a synchronous launch rejection removes the allocated root", () => {
  const base = retainedFixtureBase();
  const run = spawnSync(process.execPath, [wrapper, "--", ""], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /child process error/);
  const root = /^test-scratch: invocation root: (.+)$/m.exec(run.stderr)?.[1];
  assert.ok(root, run.stderr);
  assert.match(run.stderr, /removed invocation root/);
  assert.equal(existsSync(root), false);
});

test("an asynchronous launch failure without output pipes removes the allocated root", () => {
  const base = retainedFixtureBase();
  const bootstrap = `
    const { EventEmitter } = require("node:events");
    const childProcess = require("node:child_process");
    childProcess.spawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null });
      process.nextTick(() => {
        child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }));
        child.emit("close", -24, null);
      });
      return child;
    };
    require(${JSON.stringify(wrapper)}).runInTestScratch(["--", process.execPath]);
  `;
  const run = spawnSync(process.execPath, ["-e", bootstrap], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: base, TEMP: base, TMP: base },
  });
  assert.notEqual(run.status, 0, run.stderr);
  assert.match(run.stderr, /child process error[^\n]*EMFILE[\s\S]*removed invocation root/);
  const root = /^test-scratch: invocation root: (.+)$/m.exec(run.stderr)?.[1];
  assert.ok(root, run.stderr);
  assert.equal(existsSync(root), false);
});

test("default run exports one external root and removes it after a settled child", () => {
  const run = runWrapper([], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    if (process.env.TMPDIR !== root || process.env.TEMP !== root || process.env.TMP !== root) process.exit(8);
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "file.txt"), "fixture bytes\\n");
    fs.symlinkSync(path.join(root, "nested"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const settled = require("node:child_process").spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
    if (settled.status !== 0) process.exit(9);
    ${REPORT_ROOT}
  `);
  assert.equal(run.status, 0, run.stderr);
  const root = reportedRoot(run);
  assert.ok(root !== process.cwd() && !root.startsWith(process.cwd() + sep),
    `the invocation root must stay outside the checkout: ${root}`);
  assert.equal(existsSync(root), false, "the default run removes its own invocation root");
  assert.match(run.stderr, /removed invocation root/);
});

test("default run removes the root after a failing child and keeps its diagnostics", () => {
  const run = runWrapper([], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    fs.writeFileSync(path.join(root, "artifact.bin"), Buffer.alloc(16));
    process.stderr.write("original test failure diagnostic\\n");
    ${REPORT_ROOT}
    process.exit(4);
  `);
  assert.equal(run.status, 4, run.stderr);
  assert.match(run.stderr, /original test failure diagnostic/);
  assert.match(run.stderr, /removed invocation root/);
  assert.equal(existsSync(reportedRoot(run)), false);
});

test("default run removes partial setup artifacts when the child throws before teardown", () => {
  const run = runWrapper([], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    fs.mkdirSync(path.join(root, "half"), { recursive: true });
    fs.writeFileSync(path.join(root, "half", "partial.txt"), "partial setup");
    ${REPORT_ROOT}
    throw new Error("partial setup failed before teardown registration");
  `);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /partial setup failed before teardown registration/);
  assert.match(run.stderr, /removed invocation root/);
  assert.equal(existsSync(reportedRoot(run)), false);
});

test("--preserve retains the run's filesystem evidence and reports the path", () => {
  const run = runWrapper(["--preserve"], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    fs.mkdirSync(path.join(root, "evidence"));
    fs.writeFileSync(path.join(root, "evidence", "report.txt"), "retained evidence\\n");
    ${REPORT_ROOT}
  `);
  assert.equal(run.status, 0, run.stderr);
  const root = reportedRoot(run);
  assert.match(run.stderr, /preserved invocation root \(--preserve\)/);
  assert.ok(run.stderr.includes(root), "the retained path is reported");
  try {
    assert.equal(readFileSync(join(root, "evidence", "report.txt"), "utf8"), "retained evidence\n");
  } finally {
    removeReportedRoot(root);
  }
});

test("--preserve keeps evidence on a failing run without masking the original status", () => {
  const run = runWrapper(["--preserve"], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    fs.writeFileSync(path.join(root, "failure.txt"), "failure evidence\\n");
    process.stderr.write("assertion failure diagnostic\\n");
    ${REPORT_ROOT}
    process.exit(5);
  `);
  assert.equal(run.status, 5, run.stderr);
  assert.match(run.stderr, /assertion failure diagnostic/);
  const root = reportedRoot(run);
  try {
    assert.equal(existsSync(join(root, "failure.txt")), true);
  } finally {
    removeReportedRoot(root);
  }
});

test("a fixture's unresolved cleanup refusal retains the root and fails in both modes", () => {
  for (const args of [[], ["--preserve"]]) {
    const run = runWrapper(args, `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.env.PI_TEST_SCRATCH_ROOT;
      fs.writeFileSync(path.join(root, "evidence.txt"), "refused evidence\\n");
      require(${JSON.stringify(refusalHelper)}).signalCleanupRefusal("unresolved ownership");
      ${REPORT_ROOT}
    `);
    assert.equal(run.status, 1, `a cleanup refusal must fail the run (${args.join(" ") || "default"}): ${run.stderr}`);
    const root = reportedRoot(run);
    try {
      assert.match(run.stderr, /a test fixture refused cleanup/);
      assert.equal(existsSync(join(root, "evidence.txt")), true, "the refused evidence is not overridden");
    } finally {
      removeReportedRoot(root);
    }
  }
});

test("a strict fixture is not admitted when its refusal marker cannot be created", () => {
  const root = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-unavailable-"));
  const previous = process.env.PI_TEST_SCRATCH_ROOT;
  process.env.PI_TEST_SCRATCH_ROOT = root;
  try {
    // A file occupying the refusal directory makes marker creation fail.
    writeFileSync(join(root, refusal.REFUSAL_DIR), "not a directory");
    let admitted = false;
    assert.throws(() => {
      const resolveRefusal = refusal.signalCleanupRefusal("strict fixture admission");
      admitted = true;
      resolveRefusal();
    });
    assert.equal(admitted, false, "the strict fixture is not admitted without its refusal marker");
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
    else process.env.PI_TEST_SCRATCH_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an aliased refusal directory is refused and its target survives resolution", {
  skip: process.platform === "win32", // POSIX symlink semantics; junctions need privileges
}, () => {
  const previous = process.env.PI_TEST_SCRATCH_ROOT;
  const root = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-symlink-"));
  const target = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-symlink-target-"));
  process.env.PI_TEST_SCRATCH_ROOT = root;
  try {
    symlinkSync(target, join(root, refusal.REFUSAL_DIR), "dir");
    let admitted = false;
    assert.throws(() => {
      const resolveRefusal = refusal.signalCleanupRefusal("aliased admission");
      admitted = true;
      resolveRefusal();
    });
    assert.equal(admitted, false, "an aliased refusal directory cannot admit the fixture");
    assert.deepEqual(readdirSync(target), [], "registration never writes through the alias");
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
    else process.env.PI_TEST_SCRATCH_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }

  // A marker registered through the real directory cannot unlink through a later
  // replacement (symlinked directory); its external target stays untouched. The
  // witness is named exactly after the registered marker, so a resolver that
  // follows the alias and swallows ENOENT is still detected.
  const root2 = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-resolution-"));
  const target2 = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-resolution-target-"));
  process.env.PI_TEST_SCRATCH_ROOT = root2;
  try {
    const resolveRefusal = refusal.signalCleanupRefusal("resolution target");
    const directory = join(root2, refusal.REFUSAL_DIR);
    const [entry] = readdirSync(directory);
    assert.ok(entry, "registration created a refusal marker");
    writeFileSync(join(target2, entry), "keep\n");
    rmSync(directory, { recursive: true, force: true });
    symlinkSync(target2, directory, "dir");
    resolveRefusal();
    assert.equal(readFileSync(join(target2, entry), "utf8"), "keep\n",
      "resolution does not unlink through a replaced refusal directory");
    assert.deepEqual(readdirSync(target2), [entry]);
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
    else process.env.PI_TEST_SCRATCH_ROOT = previous;
    rmSync(root2, { recursive: true, force: true });
    rmSync(target2, { recursive: true, force: true });
  }
});

test("resolving one refusal cannot clear an unrelated unresolved refusal", () => {
  const root = mkdtempSync(join(retainedFixtureBase(), "prg-refusal-independence-"));
  const previous = process.env.PI_TEST_SCRATCH_ROOT;
  process.env.PI_TEST_SCRATCH_ROOT = root;
  try {
    const unresolved = refusal.signalCleanupRefusal("unrelated unresolved refusal");
    const resolved = refusal.signalCleanupRefusal("deliberately resolved refusal");
    assert.equal(refusal.hasUnresolvedCleanupRefusal(root), true);
    resolved();
    assert.equal(refusal.hasUnresolvedCleanupRefusal(root), true,
      "resolving one fixture's entry cannot erase another fixture's refusal");
    unresolved();
    assert.equal(refusal.hasUnresolvedCleanupRefusal(root), false);
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_ROOT;
    else process.env.PI_TEST_SCRATCH_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced invocation root is retained without masking the child status", () => {
  const run = runWrapper([], `
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    fs.writeFileSync(path.join(root, "evidence.txt"), "before replacement\\n");
    ${REPORT_ROOT}
    fs.rmSync(root, { recursive: true });
    fs.writeFileSync(root, "replaced root\\n");
  `);
  assert.equal(run.status, 1, run.stderr);
  const root = reportedRoot(run);
  try {
    assert.match(run.stderr, /changed identity or canonical path/);
    assert.equal(lstatSync(root).isFile(), true, "the replaced root is retained, not traversed");
  } finally {
    removeReportedRoot(root);
  }
});

test("a symlinked temporary ancestor is detected and retained", () => {
  const base = mkdtempSync(join(retainedFixtureBase(), "prg-scratch-ancestor-"));
  const moved = `${base}-moved`;
  try {
    const run = runWrapper([], `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.env.PI_TEST_SCRATCH_ROOT;
      fs.writeFileSync(path.join(root, "evidence.txt"), "ancestor moved\\n");
      ${REPORT_ROOT}
      fs.renameSync(${JSON.stringify(base)}, ${JSON.stringify(moved)});
      fs.symlinkSync(${JSON.stringify(moved)}, ${JSON.stringify(base)}, process.platform === "win32" ? "junction" : "dir");
    `, base);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /changed identity or canonical path/);
    assert.equal(readFileSync(join(reportedRoot(run), "evidence.txt"), "utf8"), "ancestor moved\n",
      "the moved root and its evidence are retained");
    assert.match(run.stderr, /retained instead of removing/);
  } finally {
    rmSync(moved, { recursive: true, force: true });
    if (lstatSync(base, { throwIfNoEntry: false })) unlinkSync(base);
  }
});

test("an interrupted child retains the root while an owned subprocess is still pending", {
  skip: process.platform === "win32", // POSIX signal and surviving descendant semantics
}, () => {
  const started = Date.now();
  const run = runWrapper([], `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PI_TEST_SCRATCH_ROOT;
    const marker = path.join(root, "subprocess-settled.txt");
    const owned = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'settled'), 500)", marker], { stdio: "ignore" });
    fs.writeFileSync(path.join(root, "in-flight.txt"), String(owned.pid));
    ${REPORT_ROOT}
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
  `);
  const root = reportedRoot(run);
  try {
    assert.notEqual(run.status, 0, run.stderr);
    assert.match(run.stderr, /interrupted run; retained invocation root without confirmed settlement/);
    assert.ok(existsSync(join(root, "in-flight.txt")), "the root survives the interruption");
    assert.equal(waitFor(() => existsSync(join(root, "subprocess-settled.txt")), 5_000), true,
      "the owned subprocess was still pending when the wrapper retained the root");
    assert.ok(Date.now() - started >= 50);
  } finally {
    removeReportedRoot(root);
  }
});

test("a forwarded interruption retains scratch even when the child exits normally", {
  skip: process.platform === "win32",
}, () => {
  const run = runWrapper([], `
    const fs = require("node:fs");
    const marker = require("node:path").join(process.env.PI_TEST_SCRATCH_ROOT, "settled.txt");
    const owned = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 500)", marker], { stdio: "ignore" });
    owned.unref();
    const timer = setInterval(() => {}, 1000);
    process.once("SIGTERM", () => { clearInterval(timer); process.exitCode = 23; });
    ${REPORT_ROOT}
    process.kill(process.ppid, "SIGTERM");
  `);
  const root = reportedRoot(run);
  try {
    assert.equal(run.status, 23, run.stderr);
    assert.match(run.stderr, /interrupted run; retained invocation root/);
    assert.equal(waitFor(() => existsSync(join(root, "settled.txt")), 5_000), true,
      "the owned subprocess was still pending when the wrapper retained the root");
  } finally {
    removeReportedRoot(root);
  }
});

test("retained fixture base allocates beside the invocation root, not inside it", () => {
  const parent = realpathSync(mkdtempSync(join(retainedFixtureBase(), "prg-retained-parent-")));
  const helper = resolve(__dirname, "helpers", "scratch-fixture-base.js");
  try {
    const run = runWrapper([], `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.env.PI_TEST_SCRATCH_ROOT;
      const { retainedFixtureBase } = require(${JSON.stringify(helper)});
      const base = retainedFixtureBase();
      if (base === root || base.startsWith(root + path.sep)) throw new Error("retained base inside the invocation root: " + base);
      if (path.dirname(root) !== base) throw new Error("retained base is not the invocation parent: " + base);
      let rejected = false;
      try { retainedFixtureBase(root); } catch { rejected = true; }
      if (!rejected) throw new Error("retained base accepted the invocation root");
      const witness = fs.mkdtempSync(path.join(base, "prg-witness-"));
      fs.writeFileSync(path.join(witness, "kept.txt"), "witness");
      process.stdout.write("SCRATCH=" + root + "\\nWITNESS=" + witness + "\\n");
    `, parent);
    assert.equal(run.status, 0, run.stderr);
    const root = reportedRoot(run);
    const witness = /^WITNESS=(.+)$/m.exec(run.stdout)?.[1];
    assert.ok(witness, run.stdout);
    try {
      assert.equal(existsSync(root), false, "the runner removes only its own invocation root");
      assert.equal(readFileSync(join(witness, "kept.txt"), "utf8"), "witness",
        "a retained sibling witness survives the wrapped run");
      assert.ok(witness.startsWith(parent + sep), "the witness stays beside the invocation root");
    } finally {
      rmSync(witness, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an inner wrapper cannot allocate inside an enclosing invocation root", () => {
  const run = runWrapper([], `
    const assert = require("node:assert/strict");
    const { spawnSync } = require("node:child_process");
    const nested = spawnSync(process.execPath, [${JSON.stringify(wrapper)}, "--preserve", "--", process.execPath, "-e", ""], { encoding: "utf8" });
    assert.equal(nested.status, 1, nested.stderr);
    assert.match(nested.stderr, /refusing to allocate scratch inside an enclosing invocation root/);
    assert.doesNotMatch(nested.stderr, /^test-scratch: invocation root:/m);
    ${REPORT_ROOT}
  `);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(reportedRoot(run)), false);
});

test("a checkout-local temporary root is rejected before allocation", () => {
  const run = runWrapper([], `${REPORT_ROOT}`, process.cwd());
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /inside the checkout/);
  assert.equal(run.stdout, "", "no scratch root or child output is produced");

  const helper = resolve(__dirname, "helpers", "scratch-fixture-base.js");
  const cwd = process.cwd();
  const env = { ...process.env, TMPDIR: cwd, TEMP: cwd, TMP: cwd } as NodeJS.ProcessEnv;
  delete env.PI_TEST_SCRATCH_ROOT;
  const direct = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(helper)}).disposableFixtureBase()`], {
    encoding: "utf8",
    env,
  });
  assert.notEqual(direct.status, 0, "a settings-menu style allocation rejects a checkout-local base");
  assert.match(direct.stderr, /must stay outside the checkout/);

  // On a case-insensitive volume, a differently spelled checkout alias resolves
  // to the same directory identity; both entry points must still reject it.
  const checkout = realpathSync(process.cwd());
  const baseName = checkout.slice(checkout.lastIndexOf(sep) + 1);
  const swapped = baseName === baseName.toUpperCase() ? baseName.toLowerCase() : baseName.toUpperCase();
  const alias = checkout.slice(0, checkout.length - baseName.length) + swapped;
  let aliasResolvesToCheckout = false;
  if (alias !== checkout) {
    try {
      const original = statSync(checkout, { bigint: true });
      const alternative = statSync(alias, { bigint: true });
      aliasResolvesToCheckout = original.dev === alternative.dev && original.ino === alternative.ino;
    } catch {
      // Case-sensitive volume: the alternate spelling is not this directory.
    }
  }
  if (aliasResolvesToCheckout) {
    const aliasRun = runWrapper([], `${REPORT_ROOT}`, alias);
    assert.equal(aliasRun.status, 1, aliasRun.stderr);
    assert.match(aliasRun.stderr, /inside the checkout/);
    assert.equal(aliasRun.stdout, "", "the alternate-case checkout alias allocates nothing");

    const aliasEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias };
    delete aliasEnv.PI_TEST_SCRATCH_ROOT;
    const aliasDirect = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(helper)}).disposableFixtureBase()`], {
      encoding: "utf8",
      env: aliasEnv,
    });
    assert.notEqual(aliasDirect.status, 0, "the helper rejects the alternate-case checkout alias");
    assert.match(aliasDirect.stderr, /must stay outside the checkout/);
  }
});

test("default teardown leaves a pre-existing sibling fixture untouched", () => {
  const sibling = mkdtempSync(join(retainedFixtureBase(), "prg-scratch-sibling-"));
  writeFileSync(join(sibling, "pre-existing.txt"), "pre-existing\n");
  try {
    const run = runWrapper([], `${REPORT_ROOT}`);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(reportedRoot(run)), false);
    assert.equal(readFileSync(join(sibling, "pre-existing.txt"), "utf8"), "pre-existing\n");
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
});

test("usage errors are visible and do not allocate a root", () => {
  const missing = spawnSync(process.execPath, [wrapper], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: node scripts\/test-scratch\.cjs/);
  const unknown = spawnSync(process.execPath, [wrapper, "--nope", "--", process.execPath, "-e", ""], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option: --nope/);
});
