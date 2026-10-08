import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { ensureIgnoredFixtureRoot } from "./helpers/ignored-fixture-root";

// Pure contract tests for the bounded scripts copier in
// scripts/ci/session-host-windows-acceptance.cjs (copy-scripts): exclusive
// create-new writes that preserve a replaced or prepopulated leaf, bounded
// descriptor reads, finite file/directory/entry/depth/aggregate budgets,
// symlink and non-regular refusal, .terraform pruning without traversal, and
// retained partial output. Like the workflow contract tests, every synthetic
// fixture is allocated under the ignored own-root node_modules subtree with
// explicit names and retained: no default-temp allocation, no recursive
// deletion, no cleanup at all.

const projectRoot = join(dirname(__dirname), "..");
const HELPER = join(projectRoot, "scripts", "ci", "session-host-windows-acceptance.cjs");
const FIXTURE_REL_PATH = "node_modules/.prg-alpha-copier-fixtures";

interface CopierResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runChild(args: string[]): CopierResult {
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: failed.status ?? -1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
    };
  }
}

function runCopier(source: string, dest: string): CopierResult {
  return runChild([HELPER, "copy-scripts", source, dest]);
}

function runSourceCopier(source: string, dest: string): CopierResult {
  return runChild([HELPER, "copy-source", source, dest]);
}

/** Allocate one fresh exclusive fixture root under the validated ignored own-root subtree. */
function allocateFixtureRoot(): string {
  const fixtureRoot = ensureIgnoredFixtureRoot(projectRoot, FIXTURE_REL_PATH);
  const root = execFileSync(process.execPath, [HELPER, "create-root", fixtureRoot], { encoding: "utf8", timeout: 5_000 }).trim();
  assert.ok(lstatSync(root).isDirectory(), "the fixture root must be a real directory");
  return root;
}

function writeFileTree(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(base, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Create a sparse file of exactly sizeBytes (size without disk use). */
function makeSparseFile(file: string, sizeBytes: number): void {
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, sizeBytes);
  } finally {
    closeSync(fd);
  }
}

test("copyFileBounded rejects zero-byte write progress and retains partial output", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source.txt");
  writeFileSync(source, "owned synthetic input", { flag: "wx" });
  const dest = join(root, "dest");
  mkdirSync(dest);
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    "fs.writeSync = () => 0;",
    'copyFileBounded(process.argv[1], process.argv[2], "source.txt",',
    "  fs.lstatSync(process.argv[1], { bigint: true }),",
    "  fs.lstatSync(process.argv[2], { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });",
  ].join("\n");
  const result = runChild(["-e", script, source, dest]);
  assert.equal(result.code, 1, "zero write progress must fail, not loop until timeout");
  assert.match(result.stderr, /destination write made no valid progress; retaining partial output/);
  assert.ok(existsSync(join(dest, "source.txt")), "the exclusive partial leaf remains retained");
  assert.equal(readFileSync(source, "utf8"), "owned synthetic input");
});

test("copy-scripts copies a bounded tree and prunes .terraform before descent", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  writeFileTree(source, {
    "a.txt": "alpha",
    "nested/deep/b.txt": "beta",
    "empty.txt": "",
    ".terraform/state.tf": "must not be copied",
    "sub/.terraform/nested-state.tf": "also pruned",
  });
  // A symlink inside .terraform: if the copier ever descended into a pruned
  // directory it would have to refuse this entry, so success proves pruning
  // happens before descent.
  symlinkSync(join(source, "a.txt"), join(source, ".terraform", "evil-link"));
  const dest = join(root, "dest");
  const result = runCopier(source, dest);
  assert.equal(result.code, 0, `the bounded copy must succeed: ${result.stderr}`);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "alpha");
  assert.equal(readFileSync(join(dest, "nested", "deep", "b.txt"), "utf8"), "beta");
  assert.equal(readFileSync(join(dest, "empty.txt"), "utf8"), "");
  assert.ok(!existsSync(join(dest, ".terraform")), "top-level .terraform must be pruned");
  assert.ok(!existsSync(join(dest, "sub", ".terraform")), "nested .terraform must be pruned at every depth");
  assert.match(result.stdout, /copied 3 scripts files \(3 directories, 9 bytes\)/,
    "the report must reflect exactly the copied files, directories, and bytes");
  // Retained fixtures: both trees remain under the ignored own-root subtree.
  assert.ok(existsSync(source) && existsSync(dest), "source and destination fixture trees must be retained");
});

test("copyFileBounded refuses a prepopulated destination leaf and preserves the original", () => {
  // The CLI's top-level guard rejects any non-empty destination before
  // descending, so the exclusive create-new (wx) leaf path is exercised at
  // unit level in a child process: this is the TOCTOU backstop for a leaf
  // that appears between the top-level check and the write.
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  const sourcePath = join(source, "a.txt");
  writeFileSync(sourcePath, "new content");
  const dest = join(root, "dest");
  mkdirSync(dest);
  writeFileSync(join(dest, "a.txt"), "original sentinel");
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    `copyFileBounded(${JSON.stringify(sourcePath)}, ${JSON.stringify(dest)}, "a.txt",`,
    "  fs.lstatSync(process.argv[1], { bigint: true }),",
    `  fs.lstatSync(${JSON.stringify(dest)}, { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });`,
  ].join("\n");
  const result = runChild(["-e", script, sourcePath]);
  assert.equal(result.code, 1, `the exclusive write must fail on a prepopulated leaf: ${result.stdout}`);
  assert.match(result.stderr, /destination leaf already exists; preserving the original/);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "original sentinel",
    "the original leaf must be preserved byte-for-byte");
  assert.ok(existsSync(dest), "the partially populated destination stage must be retained");
});

test("copy-scripts refuses a non-empty destination directory", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  writeFileTree(source, { "a.txt": "alpha" });
  const dest = join(root, "dest");
  mkdirSync(dest);
  writeFileSync(join(dest, "pre-existing.txt"), "keep");
  const result = runCopier(source, dest);
  assert.equal(result.code, 1, `the copy must fail on a non-empty destination: ${result.stdout}`);
  assert.match(result.stderr, /destination already contains entries/);
  assert.equal(readFileSync(join(dest, "pre-existing.txt"), "utf8"), "keep",
    "pre-existing destination content must survive untouched");
});

test("copy-scripts refuses file and directory symlinks in the source tree", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  writeFileTree(source, { "a.txt": "alpha", "target.txt": "target" });
  symlinkSync(join(source, "target.txt"), join(source, "link.txt"));
  let result = runCopier(source, join(root, "dest-file-link"));
  assert.equal(result.code, 1, `the copy must fail on a file symlink: ${result.stdout}`);
  assert.match(result.stderr, /refusing symlink in scripts tree/);

  const dirSource = join(root, "source-dir-link");
  writeFileTree(dirSource, { "dir/inner.txt": "inner", "real.txt": "real" });
  symlinkSync(join(dirSource, "dir"), join(dirSource, "dir-link"));
  result = runCopier(dirSource, join(root, "dest-dir-link"));
  assert.equal(result.code, 1, `the copy must fail on a directory symlink: ${result.stdout}`);
  assert.match(result.stderr, /refusing symlink in scripts tree/);
});

test("copy-scripts refuses non-regular files in the source tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix domain sockets are not supported on Windows");
    return;
  }
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "a.txt"), "alpha");
  // A listening Unix domain socket is a non-regular file entry; the copier
  // must refuse it without ever opening it. The holder child chdirs into the
  // source directory so the kernel sees a short relative path (macOS bounds
  // sun_path), and stays alive while the copier runs.
  const holder = spawn(process.execPath, ["-e", [
    "process.chdir(process.argv[1]);",
    'const server = require("node:net").createServer();',
    'server.listen("socket.sock", () => process.stdout.write("READY\\n"));',
    "setTimeout(() => process.exit(0), 60000);",
  ].join("\n"), source], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      holder.stdout?.on("data", (chunk: Buffer) => {
        if (!ready && chunk.toString("utf8").includes("READY")) {
          ready = true;
          resolve();
        }
      });
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`socket holder exited early with code ${code}`)));
    });
    const result = runCopier(source, join(root, "dest"));
    assert.equal(result.code, 1, `the copy must fail on a non-regular entry: ${result.stdout}`);
    assert.match(result.stderr, /refusing non-regular file in scripts tree/);
  } finally {
    holder.kill();
  }
});

test("copy-scripts enforces the bounded per-directory entry count", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  for (let i = 0; i < 4097; i += 1) writeFileSync(join(source, `f${i}.txt`), "x");
  const dest = join(root, "dest");
  const result = runCopier(source, dest);
  assert.equal(result.code, 1, `the copy must fail past the per-directory entry budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded entry count of 4096/);
  // Bounded enumeration rejects at the bound, before any descent or copy.
  assert.ok(existsSync(dest) && readdirSync(dest).length === 0,
    "the entry budget must fail during enumeration, before any entry is processed");
});

test("copy-scripts refuses a symlinked source root", () => {
  const root = allocateFixtureRoot();
  const realSource = join(root, "real-source");
  writeFileTree(realSource, { "a.txt": "alpha" });
  const linkSource = join(root, "link-source");
  symlinkSync(realSource, linkSource);
  const result = runCopier(linkSource, join(root, "dest"));
  assert.equal(result.code, 1, `a symlinked source root must be refused: ${result.stdout}`);
  assert.match(result.stderr, /source scripts directory must be a real directory/);
});

test("copyStage refuses a source directory replaced with a symlink after admission", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  writeFileTree(source, { "a.txt": "alpha" });
  const target = join(root, "target");
  writeFileTree(target, { "b.txt": "beta" });
  const dest = join(root, "dest");
  mkdirSync(dest);
  // Admit the real directory, replace it with a symlink to another tree,
  // then require the stale receipt to reject the new path identity.
  const script = [
    'const fs = require("node:fs");',
    `const { copyStage } = require(${JSON.stringify(HELPER)});`,
    "const sourceDir = process.argv[1];",
    "const receipt = fs.lstatSync(sourceDir, { bigint: true });",
    // Replace the admitted directory with a symlink to another tree; the
    // original is moved aside and retained, never deleted.
    "fs.renameSync(sourceDir, sourceDir + \"-admitted\");",
    "fs.symlinkSync(process.argv[2], sourceDir);",
    `copyStage(sourceDir, ${JSON.stringify(dest)}, receipt,`,
    `  fs.lstatSync(${JSON.stringify(dest)}, { bigint: true }), 0, { files: 0, dirs: 0, totalBytes: 0n });`,
  ].join("\n");
  const result = runChild(["-e", script, source, target]);
  assert.equal(result.code, 1, `a replaced source directory must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /source scripts directory was replaced/);
});

test("copyFileBounded fails closed when the source grows during copy and retains partial output", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  const sourcePath = join(source, "grow.txt");
  writeFileSync(sourcePath, "0123456789"); // 10 bytes admitted
  const dest = join(root, "dest");
  mkdirSync(dest);
  // Simulate a concurrent writer: the first read grows the source file.
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    "const realReadSync = fs.readSync;",
    "let grew = false;",
    "fs.readSync = (fd, buffer, offset, length, position) => {",
    "  if (!grew) { grew = true; fs.appendFileSync(process.argv[1], \"GROW\"); }",
    "  return realReadSync(fd, buffer, offset, length, position);",
    "};",
    `copyFileBounded(${JSON.stringify(sourcePath)}, ${JSON.stringify(dest)}, "grow.txt",`,
    "  fs.lstatSync(process.argv[1], { bigint: true }),",
    `  fs.lstatSync(${JSON.stringify(dest)}, { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });`,
  ].join("\n");
  const result = runChild(["-e", script, sourcePath]);
  assert.equal(result.code, 1, `growth during copy must fail closed: ${result.stdout}`);
  assert.match(result.stderr, /source file changed during copy; retaining partial output/);
  // Partial output retained: exactly the admitted 10 bytes were written.
  assert.equal(readFileSync(join(dest, "grow.txt"), "utf8"), "0123456789");
});

test("copyFileBounded rejects a same-sized destination replacement by identity", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  const sourcePath = join(source, "a.txt");
  writeFileSync(sourcePath, "0123456789"); // 10 bytes
  const dest = join(root, "dest");
  mkdirSync(dest);
  const decoy = join(root, "decoy.txt");
  writeFileSync(decoy, "ABCDEFGHIJ"); // same size, different identity
  // Simulate a replacement: the final path stat returns a same-sized decoy.
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    "const realLstatSync = fs.lstatSync;",
    `fs.lstatSync = (p, options) => p === ${JSON.stringify(join(dest, "a.txt"))}
      ? realLstatSync(${JSON.stringify(decoy)}, options)
      : realLstatSync(p, options);`,
    `copyFileBounded(${JSON.stringify(sourcePath)}, ${JSON.stringify(dest)}, "a.txt",`,
    `  fs.lstatSync(${JSON.stringify(sourcePath)}, { bigint: true }),`,
    `  fs.lstatSync(${JSON.stringify(dest)}, { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });`,
  ].join("\n");
  const result = runChild(["-e", script]);
  assert.equal(result.code, 1, `a same-sized replacement must be rejected by identity: ${result.stdout}`);
  assert.match(result.stderr, /created destination identity mismatch; retaining partial output/);
  // The bytes we wrote remain in the created leaf (retained partial output).
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "0123456789");
});

test("copy-scripts enforces the bounded file count", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  // Spread across two directories so no single directory trips the
  // per-directory entry budget before the aggregate file budget does.
  mkdirSync(source);
  mkdirSync(join(source, "a"));
  mkdirSync(join(source, "b"));
  for (let i = 0; i < 2049; i += 1) writeFileSync(join(source, "a", `f${i}.txt`), "x");
  for (let i = 0; i < 2048; i += 1) writeFileSync(join(source, "b", `f${i}.txt`), "x");
  const result = runCopier(source, join(root, "dest"));
  assert.equal(result.code, 1, `the copy must fail past the file budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded file count of 4096/);
});

test("copy-scripts enforces the bounded directory count", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  for (let i = 0; i < 513; i += 1) mkdirSync(join(source, `d${i}`), { recursive: true });
  const result = runCopier(source, join(root, "dest"));
  assert.equal(result.code, 1, `the copy must fail past the directory budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded directory count of 512/);
});

test("copy-scripts enforces the bounded depth", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  let cursor = source;
  for (let i = 0; i < 33; i += 1) {
    cursor = join(cursor, `level${i}`);
    mkdirSync(cursor, { recursive: true });
  }
  writeFileSync(join(cursor, "bottom.txt"), "deep");
  const result = runCopier(source, join(root, "dest"));
  assert.equal(result.code, 1, `the copy must fail past the depth budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded depth of 32/);
});

test("copy-scripts enforces the bounded per-file size", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  makeSparseFile(join(source, "big.bin"), 16 * 1024 * 1024 + 1);
  const result = runCopier(source, join(root, "dest"));
  assert.equal(result.code, 1, `the copy must fail past the per-file budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded size of 16777216 bytes/);
});

test("copy-scripts enforces the bounded aggregate byte total and retains partial output", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  makeSparseFile(join(source, "one.bin"), 9 * 1024 * 1024);
  makeSparseFile(join(source, "two.bin"), 9 * 1024 * 1024);
  const dest = join(root, "dest");
  const result = runCopier(source, dest);
  assert.equal(result.code, 1, `the copy must fail past the aggregate budget: ${result.stdout}`);
  assert.match(result.stderr, /exceeds the bounded aggregate size of 16777216 bytes/);
  // Directory order is not alphabetical: exactly the first-copied file is
  // retained as partial output, whichever of the two that was.
  const retained = readdirSync(dest);
  assert.equal(retained.length, 1, "exactly one partially copied file must be retained");
  assert.ok(retained.includes("one.bin") || retained.includes("two.bin"),
    "the partially copied stage must be retained for inspection, never cleaned up");
});

test("copy-scripts rejects a destination parent replaced with a symlink before the leaf write", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "a.txt"), "x", { flag: "wx" });
  const dest = join(root, "dest");
  const other = join(root, "other");
  mkdirSync(other);
  // Intercept the exclusive leaf open: swap the destination parent for a
  // symlink to another fixture directory immediately before it happens.
  const script = [
    'const fs = require("node:fs");',
    `const { copyScripts } = require(${JSON.stringify(HELPER)});`,
    "const realOpen = fs.openSync;",
    "fs.openSync = (p, flags) => {",
    '  if (flags === "wx") {',
    '    fs.renameSync(process.argv[1], process.argv[1] + "-moved");',
    '    fs.symlinkSync(process.argv[2], process.argv[1], "junction");',
    "  }",
    "  return realOpen(p, flags);",
    "};",
    `copyScripts(${JSON.stringify(source)}, ${JSON.stringify(dest)});`,
  ].join("\n");
  const result = runChild(["-e", script, dest, other]);
  assert.equal(result.code, 1, `the replaced parent must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /destination stage was replaced; refusing to continue/);
  assert.ok(existsSync(`${dest}-moved`), "the moved original parent must be retained");
  assert.ok(lstatSync(dest).isSymbolicLink(), "the replacing symlink must be retained");
  assert.ok(existsSync(join(other, "a.txt")), "the redirected partial leaf must be retained");
});

test("copy-scripts rejects a destination root replaced during a nested copy", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(join(source, "sub"), { recursive: true });
  writeFileSync(join(source, "sub", "file.txt"), "x", { flag: "wx" });
  const dest = join(root, "dest");
  // Intercept the nested leaf open: swap the destination root for a symlink
  // to the moved original root mid-copy.
  const script = [
    'const fs = require("node:fs");',
    `const { copyScripts } = require(${JSON.stringify(HELPER)});`,
    "const realOpen = fs.openSync;",
    "fs.openSync = (p, flags) => {",
    '  if (flags === "wx") {',
    '    fs.renameSync(process.argv[1], process.argv[1] + "-moved");',
    '    fs.symlinkSync(process.argv[1] + "-moved", process.argv[1], "junction");',
    "  }",
    "  return realOpen(p, flags);",
    "};",
    `copyScripts(${JSON.stringify(source)}, ${JSON.stringify(dest)});`,
  ].join("\n");
  const result = runChild(["-e", script, dest]);
  assert.equal(result.code, 1, `the replaced destination root must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /was replaced; refusing to continue/);
  assert.ok(existsSync(`${dest}-moved`), "the moved original root must be retained");
  assert.ok(lstatSync(dest).isSymbolicLink(), "the replacing symlink must be retained");
  assert.ok(existsSync(join(`${dest}-moved`, "sub", "file.txt")),
    "the redirected partial output must be retained in the moved tree");
});

test("copy-scripts rejects an existing destination replaced after its emptiness check", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "a.txt"), "x", { flag: "wx" });
  const dest = join(root, "dest");
  mkdirSync(dest); // an existing empty destination
  // Intercept the emptiness check: replace the destination with a different
  // real directory immediately after it is opened as empty.
  const script = [
    'const fs = require("node:fs");',
    `const { copyScripts } = require(${JSON.stringify(HELPER)});`,
    "const realOpenDir = fs.opendirSync;",
    "fs.opendirSync = (p) => {",
    "  if (p === process.argv[1]) {",
    '    fs.renameSync(p, p + "-moved");',
    "    fs.mkdirSync(p);",
    "  }",
    "  return realOpenDir(p);",
    "};",
    `copyScripts(${JSON.stringify(source)}, ${JSON.stringify(dest)});`,
  ].join("\n");
  const result = runChild(["-e", script, dest]);
  assert.equal(result.code, 1, `the replaced destination must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /destination directory was replaced; refusing to continue/);
  assert.ok(existsSync(`${dest}-moved`), "the moved original destination must be retained");
  const now = lstatSync(dest);
  assert.ok(now.isDirectory() && !now.isSymbolicLink(), "the replacing directory must be retained");
});

test("copyFileBounded rejects a same-sized source rewrite between chunks", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source.txt");
  const size = 200_000; // spans multiple 64 KiB read chunks
  writeFileSync(source, "a".repeat(size), { flag: "wx" });
  const dest = join(root, "dest");
  mkdirSync(dest);
  // Rewrite the source with different same-sized content on the second chunk
  // read; only the mutation timestamps expose this.
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    "const realReadSync = fs.readSync;",
    "let calls = 0;",
    "fs.readSync = (fd, buffer, offset, length, position) => {",
    "  calls += 1;",
    `  if (calls === 2) fs.writeFileSync(process.argv[1], "b".repeat(${size}));`,
    "  return realReadSync(fd, buffer, offset, length, position);",
    "};",
    'copyFileBounded(process.argv[1], process.argv[2], "source.txt",',
    "  fs.lstatSync(process.argv[1], { bigint: true }),",
    "  fs.lstatSync(process.argv[2], { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });",
  ].join("\n");
  const result = runChild(["-e", script, source, dest]);
  assert.equal(result.code, 1, `the same-sized rewrite must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /source file changed during copy; retaining partial output/);
  assert.ok(existsSync(join(dest, "source.txt")), "the mixed-version partial output must be retained");
});

test("copyFileBounded rejects growth immediately after the final source descriptor stat", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "source.txt");
  writeFileSync(source, "0123456789", { flag: "wx" });
  const dest = join(root, "dest");
  mkdirSync(dest);
  // Append immediately after capturing the post-copy descriptor stat (the
  // fourth fstatSync in copyFileBounded): the descriptor check sees the
  // admitted snapshot and only the final path check can reject the growth.
  const script = [
    'const fs = require("node:fs");',
    `const { copyFileBounded } = require(${JSON.stringify(HELPER)});`,
    "const realFstat = fs.fstatSync;",
    "let calls = 0;",
    "fs.fstatSync = (fd, options) => {",
    "  calls += 1;",
    "  const snapshot = realFstat(fd, options);",
    '  if (calls === 4) fs.appendFileSync(process.argv[1], "X");',
    "  return snapshot;",
    "};",
    'copyFileBounded(process.argv[1], process.argv[2], "source.txt",',
    "  fs.lstatSync(process.argv[1], { bigint: true }),",
    "  fs.lstatSync(process.argv[2], { bigint: true }), { files: 0, dirs: 0, totalBytes: 0n });",
  ].join("\n");
  const result = runChild(["-e", script, source, dest]);
  assert.equal(result.code, 1, `the post-stat growth must be rejected: ${result.stdout}`);
  assert.match(result.stderr, /source file replaced during copy; retaining partial output/);
  assert.ok(existsSync(join(dest, "source.txt")), "partial output must be retained");
});

test("copy-source copies only the exact production build inputs and prunes .terraform", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "package");
  writeFileTree(source, {
    "package.json": "{\"name\":\"synthetic\"}",
    "package-lock.json": "{\"lockfileVersion\":3}",
    "tsconfig.json": "{}",
    "src/session-host/main.ts": "export {};",
    "src/.terraform/state.tf": "must not be copied",
    "src/nested/.terraform/other.tf": "also pruned",
    "scripts/pi-review-sessions.cjs": "// launcher",
    "skills/pi-review-gate-execution/SKILL.md": "# skill",
    "tests/should-not-copy.test.ts": "must not be copied",
    "dist/prebuilt.js": "must not be copied",
    "node_modules/dep/index.js": "must not be copied",
    ".git/config": "must not be copied",
    "private-notes.md": "must not be copied",
  });
  // A symlink inside a pruned .terraform tree would be refused if the copier
  // ever descended there, so success proves pruning happens before descent.
  symlinkSync(join(source, "package.json"), join(source, "src", ".terraform", "evil-link"));
  const dest = join(root, "source-fixture");
  const result = runSourceCopier(source, dest);
  assert.equal(result.code, 0, `copy-source must succeed: ${result.stderr}`);
  for (const rel of ["package.json", "package-lock.json", "tsconfig.json",
    "src/session-host/main.ts", "scripts/pi-review-sessions.cjs", "skills/pi-review-gate-execution/SKILL.md"]) {
    assert.ok(existsSync(join(dest, rel)), `the exact production build input must be copied: ${rel}`);
  }
  for (const rel of ["tests", "dist", "node_modules", ".git", "private-notes.md",
    "src/.terraform", "src/nested/.terraform"]) {
    assert.ok(!existsSync(join(dest, rel)), `copy-source must never copy: ${rel}`);
  }
  assert.match(result.stdout, /copied 6 source files \(\d+ directories, \d+ bytes\)/,
    "the report must reflect exactly the copied production inputs");
  assert.ok(existsSync(source) && existsSync(dest), "both fixture trees must be retained");
});

test("copy-source copies package-lock.json byte-for-byte", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "package");
  const lockBytes = `{"lockfileVersion":3,"synthetic":"${'x'.repeat(1024)}"}\n`;
  writeFileTree(source, {
    "package.json": "{}",
    "package-lock.json": lockBytes,
    "tsconfig.json": "{}",
    "src/a.ts": "export {};",
    "scripts/a.cjs": "// a",
    "skills/a/SKILL.md": "# a",
  });
  const dest = join(root, "source-fixture");
  const result = runSourceCopier(source, dest);
  assert.equal(result.code, 0, `copy-source must succeed: ${result.stderr}`);
  assert.equal(readFileSync(join(dest, "package-lock.json"), "utf8"), lockBytes,
    "the production lockfile must survive the bounded copy byte-for-byte");
});

test("copy-source refuses a missing or symlinked required input", () => {
  const root = allocateFixtureRoot();
  const missing = join(root, "missing-skills");
  writeFileTree(missing, {
    "package.json": "{}",
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "src/a.ts": "export {};",
    "scripts/a.cjs": "// a",
  });
  let result = runSourceCopier(missing, join(root, "dest-missing"));
  assert.equal(result.code, 1, `a missing required tree must fail the copy: ${result.stdout}`);
  assert.match(result.stderr, /source package input is missing/);

  const symlinked = join(root, "symlinked-src");
  writeFileTree(symlinked, {
    "package.json": "{}",
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "real-src/a.ts": "export {};",
    "scripts/a.cjs": "// a",
    "skills/a/SKILL.md": "# a",
  });
  symlinkSync(join(symlinked, "real-src"), join(symlinked, "src"));
  result = runSourceCopier(symlinked, join(root, "dest-symlink"));
  assert.equal(result.code, 1, `a symlinked required tree must be refused: ${result.stdout}`);
  assert.match(result.stderr, /source package input must be a real directory/);
});

test("copy-source refuses a non-empty destination and preserves its content", () => {
  const root = allocateFixtureRoot();
  const source = join(root, "package");
  writeFileTree(source, {
    "package.json": "{}",
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "src/a.ts": "export {};",
    "scripts/a.cjs": "// a",
    "skills/a/SKILL.md": "# a",
  });
  const dest = join(root, "source-fixture");
  mkdirSync(dest);
  writeFileSync(join(dest, "pre-existing.txt"), "keep");
  const result = runSourceCopier(source, dest);
  assert.equal(result.code, 1, `a non-empty destination must fail the copy: ${result.stdout}`);
  assert.match(result.stderr, /destination already contains entries/);
  assert.equal(readFileSync(join(dest, "pre-existing.txt"), "utf8"), "keep",
    "pre-existing destination content must survive untouched");
});
