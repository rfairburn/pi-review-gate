/**
 * Focused validator semantics for the optional session-host package surface
 * (#323). Every fixture in this file is synthetic (MOCK/SYNTHETIC): fake
 * installed packages, fake --help output, and a fake runtime-probe report.
 * These tests pin the validator's accept/reject boundaries only — they are
 * NOT actual npm package, native runtime, or consumer-install evidence. The
 * parent-owned integrated `npm run test:package` run is the real proof.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import test, { type TestContext } from "node:test";

interface RuntimeLoad {
  resolved: string;
  name?: string;
  version?: string;
  loaded?: boolean;
}

interface RuntimeReport {
  ok: boolean;
  error?: string;
  loads: Record<string, RuntimeLoad>;
  eagerNodePty: boolean;
  managerExportsInstanceManager: boolean;
  mainPresent: boolean;
  mainImported?: boolean;
  mainExportsRunSessionHost?: boolean;
  render: { ok: boolean; line0: string; cursorColumn: number };
}

interface SmokeModule {
  validateSessionHostPackage(options: {
    installedRoot: string;
    consumerNodeModules: string;
    sourceModulesDir: string;
    runHelp: (binPath: string) => { status: number; stdout: string };
    runRuntimeProbe: () => RuntimeReport;
  }): void;
  sessionHostSourceModules(sourceDir: string): string[];
  runSessionHostHelp(binPath: string): { status: number; stdout: string };
  removeOwnedScratch(root: string): string[];
  SESSION_HOST_RUNTIME_PROBE: string;
}

interface Fixture {
  root: string;
  consumerNodeModules: string;
  installedRoot: string;
  sourceModulesDir: string;
}

const SMOKE_TMP_PREFIX = "pi-review-package-smoke-";
// Captured before the smoke module is imported below: a require-time scratch
// directory or CLI run would leave a fresh entry behind.
const scratchBeforeImport = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(SMOKE_TMP_PREFIX));
const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-package.test.ts"));
const smoke = requireCjs("../scripts/package-smoke.cjs") as SmokeModule;

// The real (mutable) node:fs module object: the compiled namespace import is a
// getter-only copy, so only this reaches the smoke script's own fs require.
const fsModule = createRequire(__filename)("node:fs");

// MOCK/SYNTHETIC help text: names every semantic marker the validator
// requires, without copying the launcher's exact prose.
const SYNTHETIC_HELP = [
  "Usage: pi-review-sessions (SYNTHETIC) [--help]",
  "Alpha POSIX macOS/Linux session host. Requires Node >=22.19.0 and Pi >=1.0.4",
  "with a positively identified Node CLI entry. Starts an empty welcome/sidebar",
  "picker; choose a label, workspace, and profile explicitly in the UI. The",
  "startup working directory is not selected as a workspace. The sidebar toggle",
  "defaults to alt+left.",
].join("\n");

function makeFixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "session-host-package-test-"));
  // Retain the synthetic fixture root after the test; descendant creation
  // ownership is not established merely by owning this root.
  t.after(() => smoke.removeOwnedScratch(root));
  const consumerNodeModules = join(root, "consumer", "node_modules");
  const installedRoot = join(consumerNodeModules, "pi-review-gate");
  mkdirSync(join(installedRoot, "scripts"), { recursive: true });
  mkdirSync(join(installedRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(consumerNodeModules, ".bin"), { recursive: true });
  writeFileSync(
    join(installedRoot, "package.json"),
    JSON.stringify({ name: "pi-review-gate", version: "0.1.0", bin: { "pi-review-sessions": "scripts/pi-review-sessions.cjs" } }),
  );
  writeFileSync(join(installedRoot, "scripts", "pi-review-sessions.cjs"), "#!/usr/bin/env node\nconsole.log('mock');\n");
  const shim = join(consumerNodeModules, ".bin", "pi-review-sessions");
  writeFileSync(shim, "#!/bin/sh\nexec node ../pi-review-gate/scripts/pi-review-sessions.cjs \"$@\"\n");
  chmodSync(shim, 0o755);
  for (const mod of ["alpha", "beta"]) {
    writeFileSync(join(installedRoot, "dist", "src", "session-host", `${mod}.js`), "// mock compiled\n");
    writeFileSync(join(installedRoot, "dist", "src", "session-host", `${mod}.d.ts`), "// mock types\n");
  }
  // MOCK/SYNTHETIC inert compiled Main: side-effect-free export shape only,
  // never a production source stub.
  writeFileSync(
    join(installedRoot, "dist", "src", "session-host", "main.js"),
    "// MOCK/SYNTHETIC inert compiled Main\nexports.runSessionHost = async () => 0;\n",
  );
  writeFileSync(
    join(installedRoot, "dist", "src", "session-host", "main.d.ts"),
    "// MOCK/SYNTHETIC declarations\nexport declare function runSessionHost(options: unknown): Promise<number>;\n",
  );
  // Runtime-required dependencies at the fresh consumer dependency root,
  // including the entry files a real resolution would land on.
  mkdirSync(join(consumerNodeModules, "pi-session-host-tui", "dist"), { recursive: true });
  writeFileSync(
    join(consumerNodeModules, "pi-session-host-tui", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "1.0.4" }),
  );
  writeFileSync(join(consumerNodeModules, "pi-session-host-tui", "dist", "index.js"), "// mock entry\n");
  mkdirSync(join(consumerNodeModules, "@xterm", "headless", "lib-headless"), { recursive: true });
  writeFileSync(
    join(consumerNodeModules, "@xterm", "headless", "package.json"),
    JSON.stringify({ name: "@xterm/headless", version: "6.0.0" }),
  );
  writeFileSync(join(consumerNodeModules, "@xterm", "headless", "lib-headless", "index.js"), "// mock entry\n");
  mkdirSync(join(consumerNodeModules, "@xterm", "addon-unicode11", "lib"), { recursive: true });
  writeFileSync(
    join(consumerNodeModules, "@xterm", "addon-unicode11", "package.json"),
    JSON.stringify({ name: "@xterm/addon-unicode11", version: "0.9.0" }),
  );
  writeFileSync(join(consumerNodeModules, "@xterm", "addon-unicode11", "lib", "index.js"), "// mock entry\n");
  // Derived-inventory source directory (narrow, flat).
  const sourceModulesDir = join(root, "src", "session-host");
  mkdirSync(sourceModulesDir, { recursive: true });
  for (const mod of ["alpha", "beta"]) writeFileSync(join(sourceModulesDir, `${mod}.ts`), "// mock source\n");
  return { root, consumerNodeModules, installedRoot, sourceModulesDir };
}

// MOCK/SYNTHETIC runtime-probe report: shaped like the real fresh-consumer
// probe output but produced entirely from fixture paths. It is not native
// package evidence.
function makeRuntimeReport(f: Fixture, overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return {
    ok: true,
    loads: {
      "pi-session-host-tui": {
        resolved: join(f.consumerNodeModules, "pi-session-host-tui", "dist", "index.js"),
        name: "@earendil-works/pi-tui",
        version: "1.0.4",
        loaded: true,
      },
      "@xterm/headless": {
        resolved: join(f.consumerNodeModules, "@xterm", "headless", "lib-headless", "index.js"),
        version: "6.0.0",
        loaded: true,
      },
      "@xterm/addon-unicode11": {
        resolved: join(f.consumerNodeModules, "@xterm", "addon-unicode11", "lib", "index.js"),
        version: "0.9.0",
        loaded: true,
      },
    },
    eagerNodePty: false,
    managerExportsInstanceManager: true,
    mainPresent: true,
    mainImported: true,
    mainExportsRunSessionHost: true,
    render: { ok: true, line0: "中文😀", cursorColumn: 6 },
    ...overrides,
  };
}

function validate(f: Fixture, overrides: { help?: { status: number; stdout: string }; report?: RuntimeReport } = {}): void {
  smoke.validateSessionHostPackage({
    installedRoot: f.installedRoot,
    consumerNodeModules: f.consumerNodeModules,
    sourceModulesDir: f.sourceModulesDir,
    runHelp: (binPath) => {
      assert.equal(binPath, join(f.consumerNodeModules, ".bin", "pi-review-sessions"));
      return overrides.help ?? { status: 0, stdout: SYNTHETIC_HELP };
    },
    runRuntimeProbe: () => overrides.report ?? makeRuntimeReport(f),
  });
}

test("importing package-smoke.cjs is side-effect free (no scratch, no CLI)", () => {
  const after = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(SMOKE_TMP_PREFIX));
  assert.deepEqual(after, scratchBeforeImport);
  assert.equal(typeof smoke.validateSessionHostPackage, "function");
  assert.equal(typeof smoke.sessionHostSourceModules, "function");
});

test("accepts a complete synthetic installed session-host package", (t) => {
  const f = makeFixture(t);
  validate(f);
});

test("fails when bin metadata does not point exactly at scripts/pi-review-sessions.cjs", (t) => {
  const f = makeFixture(t);
  writeFileSync(
    join(f.installedRoot, "package.json"),
    JSON.stringify({ name: "pi-review-gate", bin: { "pi-review-sessions": "scripts/other-entry.cjs" } }),
  );
  assert.throws(() => validate(f), /bin metadata for pi-review-sessions/);
});

test("fails when the installed bin target lacks a Node shebang", (t) => {
  const f = makeFixture(t);
  writeFileSync(join(f.installedRoot, "scripts", "pi-review-sessions.cjs"), "#!/bin/sh\necho mock\n");
  assert.throws(() => validate(f), /Node shebang/);
});

test("fails when the consumer bin shim is not executable", (t) => {
  const f = makeFixture(t);
  chmodSync(join(f.consumerNodeModules, ".bin", "pi-review-sessions"), 0o644);
  assert.throws(() => validate(f), /EACCES|EPERM|ENOENT/);
});

test("fails when --help exits nonzero", (t) => {
  const f = makeFixture(t);
  assert.throws(
    () => validate(f, { help: { status: 2, stdout: SYNTHETIC_HELP } }),
    /--help must exit 0/,
  );
});

test("fails when --help omits semantic guidance", (t) => {
  const f = makeFixture(t);
  const stripped = SYNTHETIC_HELP.replace("defaults to alt+left.", "defaults to another key.");
  assert.throws(() => validate(f, { help: { status: 0, stdout: stripped } }), /alt\+left sidebar toggle/);
});

test("fails when a derived compiled module or its declarations are missing", (t) => {
  const f = makeFixture(t);
  rmSync(join(f.installedRoot, "dist", "src", "session-host", "beta.js"));
  assert.throws(() => validate(f), /dist\/src\/session-host\/beta\.js/);
  writeFileSync(join(f.installedRoot, "dist", "src", "session-host", "beta.js"), "// mock compiled\n");
  rmSync(join(f.installedRoot, "dist", "src", "session-host", "beta.d.ts"));
  assert.throws(() => validate(f), /dist\/src\/session-host\/beta\.d\.ts/);
});

test("fails when a fresh-consumer runtime dependency is not at its pinned version", (t) => {
  const f = makeFixture(t);
  writeFileSync(
    join(f.consumerNodeModules, "@xterm", "headless", "package.json"),
    JSON.stringify({ name: "@xterm/headless", version: "6.1.0" }),
  );
  assert.throws(() => validate(f), /pinned at 6\.0\.0/);
});

test("fails when canonical @earendil-works/pi-tui is hoisted into the consumer root", (t) => {
  const f = makeFixture(t);
  mkdirSync(join(f.consumerNodeModules, "@earendil-works", "pi-tui"), { recursive: true });
  writeFileSync(
    join(f.consumerNodeModules, "@earendil-works", "pi-tui", "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "1.0.4" }),
  );
  assert.throws(() => validate(f), /canonical @earendil-works\/pi-tui/);
});

test("fails when the runtime report shows an eager @lydell/node-pty load", (t) => {
  const f = makeFixture(t);
  assert.throws(
    () => validate(f, { report: makeRuntimeReport(f, { ok: false, eagerNodePty: true }) }),
    /eagerly load @lydell\/node-pty/,
  );
});

test("fails when a runtime dependency entry resolves but throws on load", (t) => {
  const f = makeFixture(t);
  const report = makeRuntimeReport(f, { ok: false });
  report.loads["pi-session-host-tui"] = {
    resolved: join(f.consumerNodeModules, "pi-session-host-tui", "dist", "index.js"),
    name: "@earendil-works/pi-tui",
    version: "1.0.4",
    loaded: false,
  };
  assert.throws(() => validate(f, { report }), /did not load pi-session-host-tui/);
});

test("fails when a runtime load resolves outside the fresh consumer", (t) => {
  const f = makeFixture(t);
  const outside = join(f.root, "outside", "index.js");
  mkdirSync(join(f.root, "outside"), { recursive: true });
  writeFileSync(outside, "// outside the consumer\n");
  const report = makeRuntimeReport(f, { ok: false });
  report.loads["@xterm/headless"] = { resolved: outside, version: "6.0.0", loaded: true };
  assert.throws(() => validate(f, { report }), /must resolve inside the fresh consumer/);
});

test("fails when the compiled Main is absent from the installed package", (t) => {
  const f = makeFixture(t);
  rmSync(join(f.installedRoot, "dist", "src", "session-host", "main.js"));
  rmSync(join(f.installedRoot, "dist", "src", "session-host", "main.d.ts"));
  assert.throws(
    () => validate(f, { report: makeRuntimeReport(f, { ok: false, mainPresent: false }) }),
    /missing compiled session host Main: dist\/src\/session-host\/main\.js/,
  );
});

test("fails when the compiled Main declaration is missing", (t) => {
  const f = makeFixture(t);
  rmSync(join(f.installedRoot, "dist", "src", "session-host", "main.d.ts"));
  assert.throws(() => validate(f), /missing compiled session host Main: dist\/src\/session-host\/main\.d\.ts/);
});

test("fails when the compiled Main import is not side-effect-free", (t) => {
  const f = makeFixture(t);
  assert.throws(
    () => validate(f, { report: makeRuntimeReport(f, { ok: false, mainImported: false }) }),
    /side-effect-free/,
  );
});

test("fails when the compiled Main does not expose runSessionHost", (t) => {
  const f = makeFixture(t);
  assert.throws(
    () => validate(f, { report: makeRuntimeReport(f, { ok: false, mainExportsRunSessionHost: false }) }),
    /runSessionHost/,
  );
});

test("sessionHostSourceModules derives only flat .ts files", (t) => {
  const f = makeFixture(t);
  mkdirSync(join(f.sourceModulesDir, "nested"), { recursive: true });
  writeFileSync(join(f.sourceModulesDir, "nested", "deep.ts"), "// not flat\n");
  writeFileSync(join(f.sourceModulesDir, "notes.md"), "// not ts\n");
  assert.deepEqual(smoke.sessionHostSourceModules(f.sourceModulesDir), ["alpha.ts", "beta.ts"]);
});

// Owned-scratch retention semantics (MOCK/SYNTHETIC markers only — no actual
// initialized Terraform content is created or accessed).
test("removeOwnedScratch retains unknown, symlink, FIFO, and .terraform descendants without traversal", () => {
  const root = mkdtempSync(join(os.tmpdir(), "session-host-scratch-retention-"));
  const unknownMarker = join(root, "package", "node_modules", "unknown.txt");
  const tfMarker = join(root, "consumer", ".terraform", "marker.txt");
  const symlinkTargetMarker = join(root, "symlink-target", "marker.txt");
  const symlinkPath = join(root, "links", "target-dir");
  const fifoPath = join(root, "consumer", "runtime-fifo");
  mkdirSync(join(root, "package", "node_modules"), { recursive: true });
  writeFileSync(unknownMarker, "synthetic unknown descendant\n");
  mkdirSync(join(root, "consumer", ".terraform"), { recursive: true });
  writeFileSync(tfMarker, "synthetic terraform marker\n");
  mkdirSync(join(root, "symlink-target"), { recursive: true });
  writeFileSync(symlinkTargetMarker, "synthetic symlink target\n");
  mkdirSync(join(root, "links"), { recursive: true });
  symlinkSync(join(root, "symlink-target"), symlinkPath, "dir");
  // Synthetic FIFO: cleanup must not need to classify or remove special files.
  execFileSync("mkfifo", [fifoPath], { cwd: root, stdio: "ignore" });

  const violations: string[] = [];
  const methods = [
    "readdirSync",
    "opendirSync",
    "realpathSync",
    "statSync",
    "lstatSync",
    "readFileSync",
    "rmSync",
    "rmdirSync",
    "unlinkSync",
  ];
  const originals = new Map<string, unknown>();
  const isUnderRoot = (candidate: unknown): boolean =>
    typeof candidate === "string" && (candidate === root || candidate.startsWith(root + sep));
  // Any descendant inspection, enumeration, or deletion is a contract failure.
  // The sole allowed operation is the bounded lstat admission check on root.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutableFs = fsModule as any;
  for (const method of methods) {
    const original = mutableFs[method];
    originals.set(method, original);
    mutableFs[method] = function (this: unknown, candidate: unknown, ...args: unknown[]) {
      const rootAdmission = method === "lstatSync" && candidate === root;
      if (isUnderRoot(candidate) && !rootAdmission) {
        violations.push(`${method} ${String(candidate)}`);
        throw new Error(`unexpected descendant access: ${method} ${String(candidate)}`);
      }
      return original.call(this, candidate, ...args);
    };
  }

  let retained: string[] = [];
  try {
    retained = smoke.removeOwnedScratch(root);
    assert.deepEqual(violations, []);
  } finally {
    for (const [method, original] of originals) mutableFs[method] = original;
  }

  assert.deepEqual(retained, [root]);
  assert.ok(existsSync(root), "the scratch root is retained");
  assert.equal(readFileSync(unknownMarker, "utf8"), "synthetic unknown descendant\n");
  assert.equal(readFileSync(tfMarker, "utf8"), "synthetic terraform marker\n");
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true, "the symlink itself is retained");
  assert.equal(readFileSync(symlinkTargetMarker, "utf8"), "synthetic symlink target\n");
  assert.equal(lstatSync(fifoPath).isFIFO(), true, "the FIFO is retained");
});

test("removeOwnedScratch rejects non-directory and symlinked roots", () => {
  const base = mkdtempSync(join(os.tmpdir(), "session-host-scratch-cleanup-"));
  try {
    const file = join(base, "a-file");
    writeFileSync(file, "not a directory\n");
    assert.throws(() => smoke.removeOwnedScratch(file), /not a directory/);

    const realDir = join(base, "real-dir");
    mkdirSync(realDir);
    const linkRoot = join(base, "link-root");
    symlinkSync(realDir, linkRoot);
    assert.throws(() => smoke.removeOwnedScratch(linkRoot), /must not be a symlink/);
    // The rejected symlink root and its target are left in place.
    assert.ok(existsSync(realDir));
  } finally {
    smoke.removeOwnedScratch(base);
  }
});

/**
 * MOCK/SYNTHETIC probe fixture: a fake installed package whose Main swallows
 * the forbidden node-pty require, plus a poison @lydell/node-pty entry that
 * must never be reached. Inert shapes only — no production source stubs.
 */
function makeProbeFixture(t: TestContext): { root: string; consumerDir: string; installedRoot: string } {
  const root = mkdtempSync(join(os.tmpdir(), "session-host-probe-test-"));
  // Retain the synthetic fixture root after the test; descendant creation
  // ownership is not established merely by owning this root.
  t.after(() => smoke.removeOwnedScratch(root));
  const consumerDir = join(root, "consumer");
  const nm = join(consumerDir, "node_modules");
  const installedRoot = join(nm, "pi-review-gate");
  mkdirSync(join(installedRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0" }));
  writeFileSync(
    join(installedRoot, "dist", "src", "session-host", "instances.js"),
    "// MOCK/SYNTHETIC\nexports.InstanceManager = class {};\n",
  );
  // The regression target: a Main that catches the guard's rejection.
  writeFileSync(
    join(installedRoot, "dist", "src", "session-host", "main.js"),
    '// MOCK/SYNTHETIC swallowing Main\ntry { require("@lydell/node-pty"); } catch {}\nexports.runSessionHost = async () => 0;\n',
  );
  writeFileSync(
    join(installedRoot, "dist", "src", "session-host", "terminal-surface.js"),
    "// MOCK/SYNTHETIC inert surface\n"
      + "exports.TerminalSurface = class { write() {} async flush() {} frame() { return { lines: ['中文😀'], cursor: { column: 6 } }; } dispose() {} };\n",
  );
  const fakeDeps: Record<string, { name: string; version: string }> = {
    "pi-session-host-tui": { name: "@earendil-works/pi-tui", version: "1.0.4" },
    "@xterm/headless": { name: "@xterm/headless", version: "6.0.0" },
    "@xterm/addon-unicode11": { name: "@xterm/addon-unicode11", version: "0.9.0" },
  };
  for (const [dir, meta] of Object.entries(fakeDeps)) {
    mkdirSync(join(nm, dir), { recursive: true });
    writeFileSync(join(nm, dir, "package.json"), JSON.stringify(meta));
    writeFileSync(join(nm, dir, "index.js"), "// MOCK/SYNTHETIC inert entry\nmodule.exports = {};\n");
  }
  // Poison optional PTY: the guard must reject before this entry loads.
  mkdirSync(join(nm, "@lydell", "node-pty"), { recursive: true });
  writeFileSync(join(nm, "@lydell", "node-pty", "package.json"), JSON.stringify({ name: "@lydell/node-pty", version: "1.2.0-beta.15" }));
  writeFileSync(join(nm, "@lydell", "node-pty", "index.js"), 'throw new Error("NATIVE ADDON LOADED - MUST NOT HAPPEN");\n');
  return { root, consumerDir, installedRoot };
}

test("runtime probe rejects a Main that swallows the forbidden node-pty require", (t) => {
  const f = makeProbeFixture(t);
  // Bounded synthetic subprocess run of the real probe code against the
  // MOCK/SYNTHETIC fixture — not an integrated package or native runtime.
  const output = execFileSync(process.execPath, ["-e", smoke.SESSION_HOST_RUNTIME_PROBE, f.installedRoot], {
    cwd: f.consumerDir,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = JSON.parse(output) as RuntimeReport;
  assert.equal(report.ok, false);
  assert.match(report.error ?? "", /forbidden eager @lydell\/node-pty load/);
  // The poison entry must never be reached: the guard rejects before the
  // native loader, even when the imported module swallows the attempt.
  assert.doesNotMatch(report.error ?? "", /NATIVE ADDON LOADED/);
});

// Bounded synthetic command tests of the real help seam: the bin is executed
// directly through its POSIX shebang entry point (not via a Node argument),
// against fixture files only.
test("runSessionHostHelp executes a synthetic bin through its Node shebang", (t) => {
  const f = makeFixture(t);
  const shim = join(f.consumerNodeModules, ".bin", "pi-review-sessions");
  writeFileSync(shim, "#!/usr/bin/env node\nprocess.stdout.write('SYNTHETIC HELP\\n');\n");
  chmodSync(shim, 0o755);
  const help = smoke.runSessionHostHelp(shim);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, "SYNTHETIC HELP\n");
});

test("runSessionHostHelp fails on a broken Node interpreter shebang", (t) => {
  const f = makeFixture(t);
  const shim = join(f.consumerNodeModules, ".bin", "pi-review-sessions");
  writeFileSync(shim, "#!/usr/bin/env node-does-not-exist-xyz\nprocess.stdout.write('unreachable\\n');\n");
  chmodSync(shim, 0o755);
  assert.throws(() => smoke.runSessionHostHelp(shim), /No such file or directory|ENOENT|EACCES/);
});
