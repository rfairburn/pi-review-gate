import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join, dirname, relative } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const requireCjs = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"));
// The CJS producer surface deliberately has no environment/CLI test bypasses.
const producer = requireCjs("../scripts/pi-review-sessions.cjs").__test;
const generations = requireCjs("../scripts/managed-generations.cjs");
function fixture(prefix = ".generations-") {
  const root = mkdtempSync(join(process.cwd(), "node_modules", prefix));
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const bin = join(root, "bin");
  for (const dir of [bin, ...["src/session-host", "scripts", "skills"].map((p) => join(packageRoot, p))]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) writeFileSync(join(packageRoot, name), "{}", { mode: 0o600 });
  writeFileSync(join(packageRoot, "src/session-host/main.ts"), "// input 0");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), { mode: 0o600 });
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\n// inert npm", { mode: 0o700 });
  return { root, agentDir, packageRoot, bin, env: { HOME: root, PATH: bin, NODE_OPTIONS: "--no-warnings", NODE_ENV: "development" }, npmCli: join(bin, "npm"), builds: join(agentDir, ".pi-review-gate/build"), runtimes: join(agentDir, ".pi-review-gate/pi-runtime") };
}
function ok(extra = {}) { return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "", ...extra }; }
function count(root: string) { return readdirSync(root).filter((name) => lstatSync(join(root, name)).isDirectory()).length; }
function writeCompiler(root: string) {
  const pkg = join(root, "node_modules/typescript");
  mkdirSync(join(pkg, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }));
  writeFileSync(join(pkg, "bin/tsc"), "// inert compiler");
}
async function build(f: ReturnType<typeof fixture>, extra = {}) {
  return producer.buildSourceExtension({ packageRoot: f.packageRoot, agentDir: f.agentDir, env: f.env,
    runNpm: async (_cli: string, _args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      assert.ok(String(o.env.TMPDIR).startsWith(o.cwd + "/"), "setup cannot escape the counted root");
      writeCompiler(o.cwd); return ok();
    },
    runCompile: async (_cli: string, _args: string[], o: { cwd: string }) => {
      mkdirSync(join(o.cwd, "dist/src/session-host"), { recursive: true });
      writeFileSync(join(o.cwd, "dist/src/session-host/main.js"), "// output"); return ok();
    }, ...extra });
}
function writePi(root: string, version: string) {
  const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "cli.js" } }));
  writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
}
async function provision(f: ReturnType<typeof fixture>, version: string, extra = {}) {
  return producer.provisionPiRuntime({ env: f.env, agentDir: f.agentDir, npmCli: f.npmCli, provisionVersion: version,
    writeError: () => undefined,
    runNpm: async (_cli: string, args: string[], o: { cwd: string }) => {
      assert.equal(args[2], o.cwd);
      assert.ok(count(f.runtimes) <= 5, "no sixth exists even during npm setup");
      writePi(o.cwd, version);
      return ok();
    }, processRunner: async () => ok({ stdout: version }), ...extra });
}
const posix = { skip: process.platform === "win32" };

// Query-boundary seam only: no env/CLI bypass, privileged mounts, or real cache.
function withMountEvidence(platform: string, query: (call: number) => string | object, action: () => void) {
  const childProcess = requireCjs("node:child_process") as typeof import("node:child_process");
  const original = childProcess.spawnSync;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  let calls = 0;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    childProcess.spawnSync = ((command: string, args: string[], options: any) => {
      assert.equal(command, platform === "linux" ? "/bin/cat" : "/sbin/mount");
      assert.deepEqual(args, platform === "linux" ? ["/proc/self/mountinfo"] : []);
      assert.deepEqual(options.env, { LC_ALL: "C" });
      assert.ok(options.timeout > 0 && options.timeout <= 1000);
      assert.equal(options.maxBuffer, 4 * 1024 * 1024);
      assert.equal(options.killSignal, "SIGKILL");
      const evidence = query(++calls);
      return typeof evidence === "string" ? { status: 0, signal: null, stdout: evidence } : evidence;
    }) as typeof original;
    action();
  } finally {
    childProcess.spawnSync = original;
    Object.defineProperty(process, "platform", descriptor);
  }
  return calls;
}
function mountEvidence(platform: string, mounted?: string) {
  const escape = (value: string) => value.replace(/\\/gu, "\\134").replace(/ /gu, "\\040").replace(/\t/gu, "\\011").replace(/\n/gu, "\\012");
  // Unrelated entries, including a lexical sibling, must not prevent cleanup.
  const paths = ["/", "/unrelated", ...(mounted ? [mounted] : [])];
  return paths.map((value, i) => platform === "linux"
    ? `${i + 1} 0 8:1 / ${escape(value)} rw,relatime shared:1 - ext4 /dev/fixture rw\n`
    : `/dev/fixture on ${value} (apfs, local)\n`).join("");
}
function reclamationFixture(prefix?: string) {
  const f = fixture(prefix); mkdirSync(f.builds, { recursive: true });
  const candidate = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
  const subtree = join(candidate.root, "mounted space\\tab\tnewline\n"); mkdirSync(subtree);
  const survivor = join(subtree, "survivor"); writeFileSync(survivor, "outside data stays intact");
  const ordinary = join(candidate.root, "ordinary"); writeFileSync(ordinary, "ordinary descendant");
  const outside = join(f.root, "outside"); writeFileSync(outside, "outside sentinel");
  assert.equal(candidate.generation.release(), true);
  for (let i = 0; i < 4; i++) generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "held-")) }));
  const attempt = () => generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "admitted-")) }));
  const retained = () => {
    assert.equal(count(f.builds), 5);
    assert.equal(readFileSync(survivor, "utf8"), "outside data stays intact");
    assert.equal(readFileSync(ordinary, "utf8"), "ordinary descendant");
    assert.equal(readFileSync(outside, "utf8"), "outside sentinel");
    assert.ok(existsSync(join(candidate.root, generations.RECORD)));
  };
  return { ...f, candidate, subtree, survivor, ordinary, outside, attempt, retained };
}

test("native same-device mounted roots and descendants refuse before opening any generation directory", posix, () => {
  for (const platform of ["linux", "darwin"]) for (const mountedRoot of [false, true]) {
    const f = reclamationFixture();
    assert.equal(lstatSync(f.subtree, { bigint: true }).dev, lstatSync(f.candidate.root, { bigint: true }).dev);
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const original = fs.opendirSync;
    let traversals = 0;
    fs.opendirSync = ((file: any, ...args: any[]) => {
      if (String(file) === f.candidate.root || String(file).startsWith(f.candidate.root + "/")) traversals += 1;
      return Reflect.apply(original, fs, [file, ...args]);
    }) as typeof original;
    try {
      withMountEvidence(platform, () => mountEvidence(platform, mountedRoot ? f.candidate.root : f.subtree), () => {
        assert.throws(f.attempt, /capacity exhausted/);
      });
    } finally { fs.opendirSync = original; }
    assert.equal(traversals, 0, `${platform}: mounted content must never be traversed`);
    f.retained();
  }
});

test("Darwin literal octal-looking cache ancestors cannot hide mounted roots or descendants", posix, () => {
  for (const mountedRoot of [false, true]) {
    const f = reclamationFixture(".generations-literal-\\040-");
    // Raw Darwin output: no Linux-style escaping. Keep this descendant simple
    // so refusal must detect its literal prefix, not reject a malformed line.
    const mounted = mountedRoot ? f.candidate.root : join(f.candidate.root, "mounted");
    if (!mountedRoot) {
      mkdirSync(mounted);
      writeFileSync(join(mounted, "survivor"), "mounted data");
    }
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const original = fs.opendirSync;
    let traversals = 0;
    fs.opendirSync = ((file: any, ...args: any[]) => {
      if (String(file).startsWith(f.candidate.root)) traversals += 1;
      return Reflect.apply(original, fs, [file, ...args]);
    }) as typeof original;
    try {
      withMountEvidence("darwin", () => `/dev/disk on / (apfs, local)\n/dev/fixture on ${mounted} (apfs, local)\n`, () => {
        assert.throws(f.attempt, /capacity exhausted/);
      });
    } finally { fs.opendirSync = original; }
    assert.equal(traversals, 0);
    f.retained();
    if (!mountedRoot) assert.equal(readFileSync(join(mounted, "survivor"), "utf8"), "mounted data");
  }
});

test("Darwin ambiguous literal cache prefixes fail closed", posix, () => {
  for (const prefix of [".generations-newline\n-", ".generations- on -", ".generations- (-"]) {
    const f = reclamationFixture(prefix);
    withMountEvidence("darwin", () => mountEvidence("darwin"), () => assert.throws(f.attempt, /capacity exhausted/));
    f.retained();
  }
});

test("relative cache spelling cannot bypass absolute native mount paths", posix, () => {
  const f = reclamationFixture();
  withMountEvidence("linux", () => mountEvidence("linux", f.subtree), () => {
    assert.throws(() => generations.admit(relative(process.cwd(), f.builds), () => {
      throw new Error("must not create a sixth");
    }), /capacity exhausted/);
  });
  f.retained();
});

test("different-device descendants refuse before traversal even without a corresponding mount-table entry", posix, () => {
  const f = reclamationFixture();
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const originalStat = fs.lstatSync, originalOpen = fs.opendirSync;
  let opened = false;
  Object.defineProperty(fs, "lstatSync", { configurable: true, writable: true, value: (file: any, options: any) => {
    const stat = originalStat(file, options);
    if (String(file) !== f.subtree) return stat;
    return Object.create(stat, { dev: { value: BigInt(stat.dev) + 1n } });
  } });
  fs.opendirSync = ((file: any, ...args: any[]) => {
    if (String(file) === f.subtree) opened = true;
    return Reflect.apply(originalOpen, fs, [file, ...args]);
  }) as typeof originalOpen;
  try {
    withMountEvidence("linux", () => mountEvidence("linux"), () => assert.throws(f.attempt, /capacity exhausted/));
  } finally { Object.defineProperty(fs, "lstatSync", { configurable: true, writable: true, value: originalStat }); fs.opendirSync = originalOpen; }
  assert.equal(opened, false); f.retained();
});

test("unrelated native mount entries permit real ordinary path-owned reclamation and five-slot admission", posix, () => {
  for (const platform of ["linux", "darwin"]) {
    const f = reclamationFixture(".generations-literal-\\040-");
    const calls = withMountEvidence(platform, () => mountEvidence(platform, f.candidate.root + "-sibling"), () => {
      const admitted = f.attempt();
      assert.ok(existsSync(admitted.root)); assert.equal(count(f.builds), 5);
    });
    assert.ok(calls > 2, "native evidence is revalidated, not just cached once");
    assert.equal(existsSync(f.candidate.root), false);
    assert.equal(readFileSync(f.outside, "utf8"), "outside sentinel");
  }
});

test("missing, malformed, oversized, timed-out and unsupported mount evidence fails closed", posix, () => {
  for (const evidence of ["", "malformed\n", "1 0 8:1 / /bad\\777 rw - ext4 fixture rw\n", "x".repeat(4 * 1024 * 1024) + "\n",
    { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: mountEvidence("linux") },
    { status: 1, signal: null, stdout: mountEvidence("linux") }]) {
    const f = reclamationFixture();
    withMountEvidence("linux", () => evidence, () => assert.throws(f.attempt, /capacity exhausted/));
    f.retained();
  }
  const f = reclamationFixture();
  const calls = withMountEvidence("freebsd", () => { throw new Error("unsupported native query must not execute"); }, () => {
    assert.throws(f.attempt, /capacity exhausted/);
  });
  assert.equal(calls, 0); f.retained();
});

test("mount evidence changes before traversal or the first deletion preserve every actual survivor", posix, () => {
  for (const phase of ["traversal", "deletion"] as const) {
    const f = reclamationFixture();
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const original = fs.opendirSync;
    let changed = false;
    // Closing the root finishes preflight traversal. Change only mount
    // evidence then: inode/dev and all actual survivor files stay unchanged.
    fs.opendirSync = ((file: any, ...args: any[]) => {
      const dir = Reflect.apply(original, fs, [file, ...args]);
      if (String(file) === f.candidate.root) {
        const close = dir.closeSync.bind(dir);
        dir.closeSync = () => { changed = true; close(); };
      }
      return dir;
    }) as typeof original;
    try {
      withMountEvidence("linux", (call) => mountEvidence("linux", (phase === "traversal" ? call > 1 : changed) ? f.subtree : undefined), () => {
        assert.throws(f.attempt, /capacity exhausted/);
      });
    } finally { fs.opendirSync = original; }
    f.retained();
  }
});

test("changed mount evidence stops partial deletion while retaining lifetime and remaining real files", posix, () => {
  const f = reclamationFixture();
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const original = fs.unlinkSync;
  const files = [f.survivor, f.ordinary];
  let removed = "";
  fs.unlinkSync = ((file: any) => {
    original(file);
    if (String(file).startsWith(f.candidate.root + "/")) {
      assert.equal(removed, "", "a second deletion must revalidate native evidence");
      removed = String(file);
    }
  }) as typeof original;
  try {
    withMountEvidence("linux", () => mountEvidence("linux", removed ? f.subtree : undefined), () => {
      assert.throws(f.attempt, /capacity exhausted/);
    });
  } finally { fs.unlinkSync = original; }
  assert.ok(files.includes(removed), "one ordinary leaf was deleted before the synthetic mount change");
  for (const file of files.filter((file) => file !== removed)) assert.ok(existsSync(file));
  assert.ok(existsSync(join(f.candidate.root, generations.RECORD)));
  assert.equal(count(f.builds), 5);
  assert.equal(readFileSync(f.outside, "utf8"), "outside sentinel");
});

test("a root identity replaced while querying native metadata is not traversed or deleted", posix, () => {
  const f = reclamationFixture();
  const parked = join(f.root, "parked");
  withMountEvidence("linux", (call) => {
    if (call === 2) {
      renameSync(f.candidate.root, parked);
      mkdirSync(f.candidate.root);
      writeFileSync(join(f.candidate.root, "replacement-survivor"), "replacement");
    }
    return mountEvidence("linux");
  }, () => assert.throws(f.attempt, /capacity exhausted/));
  assert.equal(readFileSync(join(f.candidate.root, "replacement-survivor"), "utf8"), "replacement");
  assert.equal(readFileSync(join(parked, "ordinary"), "utf8"), "ordinary descendant");
  assert.equal(readFileSync(join(parked, generations.RECORD), "utf8").includes('"holders":[]'), true);
  assert.equal(readFileSync(f.outside, "utf8"), "outside sentinel");
  assert.equal(count(f.builds), 5);
});

test("dependency-sized isolated generation reclaims with real native metadata and admits the sixth", {
  skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 240_000,
}, () => {
  const f = reclamationFixture();
  const packages = 250, leavesPerPackage = 40;
  for (let i = 0; i < packages; i++) {
    const lib = join(f.candidate.root, "node_modules", `package-${i}`, "lib");
    mkdirSync(lib, { recursive: true });
    for (let j = 0; j < leavesPerPackage; j++) writeFileSync(join(lib, `module-${j}.js`), "// disposable dependency output\n");
  }
  const childProcess = requireCjs("node:child_process") as typeof import("node:child_process");
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const originalQuery = childProcess.spawnSync, originalUnlink = fs.unlinkSync;
  let queries = 0, firstDeletionQueries = 0;
  // Observe real queries; do not supply synthetic metadata in this size proof.
  childProcess.spawnSync = ((...args: any[]) => {
    queries += 1;
    return Reflect.apply(originalQuery, childProcess, args);
  }) as typeof originalQuery;
  fs.unlinkSync = ((file: any) => {
    if (!firstDeletionQueries && String(file).startsWith(f.candidate.root + "/")) firstDeletionQueries = queries;
    originalUnlink(file);
  }) as typeof originalUnlink;
  try {
    const admitted = f.attempt();
    assert.ok(existsSync(admitted.root));
    assert.equal(existsSync(f.candidate.root), false, "the entire settled dependency tree was actually removed");
    assert.equal(count(f.builds), 5);
  } finally { childProcess.spawnSync = originalQuery; fs.unlinkSync = originalUnlink; }
  assert.equal(firstDeletionQueries, 2 * packages + 5, "preflight queries directories, not the 10,000 ordinary leaves");
  assert.ok(queries > packages * leavesPerPackage, "every deletion still revalidates native mount evidence");
  assert.equal(readFileSync(f.outside, "utf8"), "outside sentinel");
});

test("real development producer reclaims path-owned settled generations, preserves pins, and reuses validated output", posix, async () => {
  const f = fixture();
  const outside = join(f.root, "outside"); writeFileSync(outside, "sentinel");
  const held = await build(f); assert.equal(held.status, 0);
  const selected = await build(f); assert.equal(selected.cacheHit, true);
  assert.equal(selected.stagingRoot, held.stagingRoot);
  assert.equal(selected.ownedStage.generation.release(), true);
  const recovery = generations.pin(f.builds, () => ({ root: held.stagingRoot }));
  assert.equal(held.ownedStage.generation.release(), true);
  const roots: string[] = [];
  for (let n = 1; n <= 8; n++) {
    writeFileSync(join(f.packageRoot, "src/session-host/main.ts"), `// input ${n}`);
    const result = await build(f); assert.equal(result.status, 0, result.diagnostics);
    roots.push(result.stagingRoot);
    // A descendant from another writer is still disposable by path policy.
    writeFileSync(join(result.stagingRoot, "foreign-descendant"), "disposable");
    assert.equal(result.ownedStage.generation.release(), true);
    assert.ok(count(f.builds) <= 5);
  }
  assert.ok(roots.some((root) => !existsSync(root)), "actual filesystem reclamation, not mocked removals");
  assert.ok(existsSync(held.stagingRoot), "held build survives pressure");
  assert.equal(readFileSync(outside, "utf8"), "sentinel");
  assert.equal(recovery.generation.release(), true, "an actual source-linked recovery holder releases explicitly");
});

test("Pi producer provisions more than five independent versions without a publication sixth", posix, async () => {
  const f = fixture();
  const held = await provision(f, "1.3.0");
  const roots: string[] = [];
  for (let n = 1; n <= 8; n++) {
    const version = `1.3.${n}`;
    const result = await provision(f, version);
    assert.equal(result.version, version);
    assert.equal(result.generation.root, join(f.runtimes, `pi-${version}`));
    roots.push(result.generation.root);
    assert.equal(result.generation.release(), true);
    assert.ok(count(f.runtimes) <= 5);
  }
  assert.ok(roots.some((root) => !existsSync(root)));
  assert.ok(existsSync(held.file));
  assert.equal(held.generation.release(), true);
  assert.equal(count(f.runtimes), 5);
  // The two independent caches do not borrow one another's slots.
  assert.equal((await build(f)).status, 0);
});

test("simultaneous real producers reserve before awaiting npm; full pinned capacity refuses without deletion", posix, async () => {
  const f = fixture();
  const stages: string[] = [];
  const settle: Array<() => void> = [];
  const pending = Array.from({ length: 5 }, () => build(f, { forceFresh: true,
    runNpm: async (_c: string, _a: string[], o: { cwd: string }) => {
      stages.push(o.cwd);
      await new Promise<void>((resolve) => settle.push(resolve));
      writeCompiler(o.cwd); return ok();
    } }));
  assert.equal(stages.length, 5);
  assert.equal(count(f.builds), 5);
  const refused = await build(f, { forceFresh: true });
  assert.equal(refused.status, 1); assert.match(refused.diagnostics, /capacity exhausted/);
  assert.ok(stages.every(existsSync));
  settle.forEach((done) => done());
  const results = await Promise.all(pending);
  assert.ok(results.every((r) => r.status === 0));
  assert.equal(count(f.builds), 5);
  results.forEach((r) => assert.equal(r.ownedStage.generation.release(), true));
});

test("cross-process exclusive admission never creates a sixth and abandoned pins remain uncertain", posix, async () => {
  const f = fixture(); mkdirSync(f.builds, { recursive: true });
  const modulePath = join(process.cwd(), "scripts/managed-generations.cjs");
  const source = `const fs=require('node:fs'),path=require('node:path');const g=require(${JSON.stringify(modulePath)});try{g.admit(process.argv[1],()=>{const root=fs.mkdtempSync(path.join(process.argv[1],'generation-'));return {root}});process.exitCode=0}catch(e){process.exitCode=2}`;
  const codes = await Promise.all(Array.from({ length: 16 }, () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, f.builds], { env: f.env, stdio: "ignore" });
    child.on("error", reject); child.on("close", resolve);
  })));
  assert.ok(codes.every((code) => code === 0 || code === 2));
  assert.ok(count(f.builds) <= 5);
  assert.throws(() => { while (true) generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "fill-")) })); }, /capacity exhausted/);
  assert.equal(count(f.builds), 5);
});

test("legacy, malformed, identity-replaced, hardlinked and out-of-root link generations remain counted", posix, async () => {
  for (const kind of ["legacy", "malformed", "replacement", "hardlink", "symlink", "terraform"] as const) {
    const f = fixture(); mkdirSync(f.builds, { recursive: true });
    const outside = join(f.root, "sentinel"); writeFileSync(outside, "safe");
    for (let i = 0; i < 5; i++) {
      const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
      assert.equal(stage.generation.release(), true);
      if (kind === "legacy") renameSync(join(stage.root, generations.RECORD), join(stage.root, "legacy-record"));
      if (kind === "malformed") writeFileSync(join(stage.root, generations.RECORD), "{}");
      if (kind === "replacement") {
        const record = readFileSync(join(stage.root, generations.RECORD));
        renameSync(stage.root, join(f.root, `held-${i}`)); mkdirSync(stage.root);
        writeFileSync(join(stage.root, generations.RECORD), record);
      }
      if (kind === "hardlink") linkSync(outside, join(stage.root, "link"));
      if (kind === "symlink") symlinkSync(outside, join(stage.root, "link"));
      if (kind === "terraform") mkdirSync(join(stage.root, ".terraform"));
    }
    const refused = await build(f, { forceFresh: true });
    assert.equal(refused.status, 1, kind); assert.match(refused.diagnostics, /capacity exhausted/, kind);
    assert.equal(count(f.builds), 5, kind); assert.equal(readFileSync(outside, "utf8"), "safe", kind);
  }
});

test("settled failed/aborted setup residue is reclaimable; unsettled failures never release", posix, async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) {
    const result = await build(f, { forceFresh: true, runNpm: async () => ok({ status: 1, timedOut: true }) });
    assert.equal(result.status, 124, "settled timeout remains a timeout, not success"); assert.ok(count(f.builds) <= 5);
  }
  const uncertain = fixture();
  for (let i = 0; i < 5; i++) {
    const result = await build(uncertain, { forceFresh: true, runNpm: async () => ok({ status: 1, cleanupConfirmed: false }) });
    assert.equal(result.status, 1);
  }
  assert.match((await build(uncertain, { forceFresh: true })).diagnostics, /capacity exhausted/);
  const pi = fixture();
  for (let i = 0; i < 8; i++) {
    await assert.rejects(provision(pi, `1.4.${i}`, { runNpm: async () => ok({ status: 1 }) }), /provisioning failed/);
    assert.ok(count(pi.runtimes) <= 5);
  }
});

test("replaced cache ancestors and out-of-cache selections fail closed", posix, () => {
  const f = fixture(); mkdirSync(f.builds, { recursive: true });
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
  renameSync(f.builds, join(dirname(f.builds), "held-builds")); mkdirSync(f.builds);
  assert.equal(stage.generation.release(), false);
  assert.throws(() => generations.pin(f.builds, () => ({ root: f.root })), /escaped cache/);
  assert.equal(count(f.builds), 0);
});

test("Pi concurrent reservations, abandoned setup and protected legacy capacity cannot admit a sixth", posix, async () => {
  const f = fixture();
  const settle: Array<() => void> = [];
  const pending = Array.from({ length: 5 }, (_, i) => provision(f, `1.5.${i}`, {
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      await new Promise<void>((resolve) => settle.push(resolve));
      writePi(o.cwd, `1.5.${i}`); return ok();
    },
  }));
  assert.equal(count(f.runtimes), 5);
  await assert.rejects(provision(f, "1.5.5"), /capacity exhausted/);
  settle.forEach((done) => done());
  const results = await Promise.all(pending);
  assert.equal(results.length, 5);
  assert.ok(results.every((result) => existsSync(result.file)));
  // These returned consumers still hold pins, even though npm has settled.
  await assert.rejects(provision(f, "1.5.6"), /capacity exhausted/);
  results.forEach((result) => assert.equal(result.generation.release(), true));

  const legacy = fixture(); mkdirSync(legacy.runtimes, { recursive: true });
  for (let i = 0; i < 5; i++) mkdirSync(join(legacy.runtimes, `legacy-${i}`));
  await assert.rejects(provision(legacy, "1.6.0"), /capacity exhausted/);
  assert.equal(count(legacy.runtimes), 5);

  const uncertain = fixture();
  for (let i = 0; i < 5; i++) await assert.rejects(provision(uncertain, `1.7.${i}`, {
    runNpm: async () => ok({ status: 1, cleanupConfirmed: false }),
  }), /cleanup was not confirmed/);
  await assert.rejects(provision(uncertain, "1.7.5"), /capacity exhausted/);
  assert.equal(count(uncertain.runtimes), 5);
});

test("compatible reuse at full capacity performs no generation inventory; eviction retires only its validated freshness pointer", posix, async () => {
  const f = fixture();
  const original = await build(f);
  const others = [];
  for (let i = 0; i < 4; i++) others.push(await build(f, { forceFresh: true }));
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const opendir = fs.opendirSync;
  let inventories = 0;
  Object.defineProperty(fs, "opendirSync", { configurable: true, writable: true, value: (...args: Parameters<typeof opendir>) => {
    if (String(args[0]) === f.builds) { inventories += 1; throw new Error("reuse must not inventory generations"); }
    return Reflect.apply(opendir, fs, args);
  } });
  let reused;
  try { reused = await build(f); } finally { fs.opendirSync = opendir; }
  assert.equal(reused.cacheHit, true); assert.equal(inventories, 0);
  assert.equal(count(f.builds), 5);
  assert.equal(reused.ownedStage.generation.release(), true);
  assert.equal(original.ownedStage.generation.release(), true);
  // Only the original is eligible, so its actual deletion is deterministic.
  writeFileSync(join(f.packageRoot, "src/session-host/main.ts"), "// changed");
  const changed = await build(f);
  assert.equal(changed.status, 0); assert.equal(existsSync(original.stagingRoot), false);
  assert.equal(existsSync(join(f.builds, `source-${original.cacheKey}.json`)), false);
  assert.equal(changed.ownedStage.generation.release(), true);
  writeFileSync(join(f.packageRoot, "src/session-host/main.ts"), "// input 0");
  const rebuilt = await build(f);
  assert.equal(rebuilt.cachePublished, true, "an evicted key can publish a new completed prepared build");
  const same = await build(f);
  assert.equal(same.cacheHit, true);
  assert.equal(same.stagingRoot, rebuilt.stagingRoot);
});

test("partial filesystem cleanup stays counted and retry reclaims only after the obstruction is settled", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture(); mkdirSync(f.builds, { recursive: true });
  const blocked = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
  const locked = join(blocked.root, "locked"); mkdirSync(locked);
  writeFileSync(join(locked, "file"), "retain on partial failure");
  writeFileSync(join(blocked.root, "z-first"), "disposable");
  chmodSync(locked, 0o500);
  assert.equal(blocked.generation.release(), true);
  for (let i = 0; i < 4; i++) generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
  const refused = await build(f, { forceFresh: true });
  assert.equal(refused.status, 1); assert.match(refused.diagnostics, /capacity exhausted/);
  assert.equal(count(f.builds), 5);
  assert.ok(existsSync(join(blocked.root, generations.RECORD)), "partial failure retains lifetime evidence");
  assert.equal(readFileSync(join(locked, "file"), "utf8"), "retain on partial failure");
  chmodSync(locked, 0o700);
  const admitted = await build(f, { forceFresh: true });
  assert.equal(admitted.status, 0); assert.equal(count(f.builds), 5);
  assert.equal(existsSync(blocked.root), false);
});

test("legacy prepared-build reuse preserves freshness authority without inventing inactivity", posix, async () => {
  const f = fixture();
  const first = await build(f);
  assert.equal(first.ownedStage.generation.release(), true);
  requireCjs("node:fs").unlinkSync(join(first.stagingRoot, generations.RECORD));
  const legacy = await build(f);
  assert.equal(legacy.cacheHit, true);
  assert.equal(legacy.stagingRoot, first.stagingRoot);
  assert.equal(legacy.ownedStage.generation, undefined);
  assert.ok(producer.validateSourceBuildArtifact(legacy.stagingRoot, {
    cacheKey: legacy.cacheKey, sourceFingerprint: legacy.sourceFingerprint, toolchainFingerprint: legacy.toolchainFingerprint,
  }, legacy.cacheParentChain));
  for (let i = 0; i < 7; i++) {
    const next = await build(f, { forceFresh: true });
    assert.equal(next.status, 0); assert.equal(next.ownedStage.generation.release(), true);
  }
  assert.ok(existsSync(first.stagingRoot), "absence of metadata is protected uncertainty, never an idle proof");
  assert.equal(count(f.builds), 5);
});

test("synthetic native policy counts five even explicitly released roots and refuses unsupported reclamation", () => {
  const f = fixture(); mkdirSync(f.builds, { recursive: true });
  const roots = [];
  for (let i = 0; i < 5; i++) {
    const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
    assert.equal(stage.generation.release(), true); roots.push(stage.root);
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    assert.throws(() => generations.admit(f.builds, () => { throw new Error("must not create a sixth"); }), /capacity exhausted/);
  } finally { Object.defineProperty(process, "platform", descriptor); }
  assert.ok(roots.every(existsSync)); assert.equal(count(f.builds), 5);
});

test("launcher releases actual source/Pi pins only on the explicit complete lifetime handoff; helper uncertainty stays artifact-specific", posix, async () => {
  for (const mode of ["complete", "numeric-only", "ddgs-uncertain"] as const) {
    const f = fixture();
    let built: any;
    let runtime: any;
    const status = await producer.runSessionHostLauncher([], {
      getEnv: () => f.env, processEnv: {}, packageRoot: f.packageRoot,
      platform: "linux", nodeVersion: process.versions.node, stdinIsTTY: true, stdoutIsTTY: true,
      build: async () => { built = await build(f); return built; },
      resolvePiRuntime: async () => { runtime = await provision(f, "1.3.0"); return runtime; },
      ensureDdgs: () => mode === "ddgs-uncertain" ? { ok: false, cleanupUnconfirmed: true } : { ok: true, python: join(f.root, "python") },
      refreshShippedSkills: () => ({ ok: true }), writeOut: () => undefined, writeError: () => undefined,
      loadMain: () => ({ runSessionHost: (options: { onCacheConsumersSettled: () => void }) => {
        if (mode === "complete") options.onCacheConsumersSettled();
        return 0;
      } }),
    });
    assert.equal(status, mode === "ddgs-uncertain" ? 1 : 0);
    const sourceLifetime = JSON.parse(readFileSync(join(built.stagingRoot, generations.RECORD), "utf8"));
    const piLifetime = JSON.parse(readFileSync(join(runtime.generation.root, generations.RECORD), "utf8"));
    assert.equal(sourceLifetime.holders.length, mode === "complete" ? 0 : 1, mode);
    assert.equal(piLifetime.holders.length, mode === "numeric-only" ? 1 : 0, "uncertain source helper does not pin unrelated Pi");
  }
});

test("failed reservation publication and unsafe admission ownership stay counted and untouched", posix, () => {
  const f = fixture(); mkdirSync(f.builds, { recursive: true });
  let retained = "";
  assert.throws(() => generations.admit(f.builds, () => {
    retained = mkdtempSync(join(f.builds, "generation-"));
    writeFileSync(join(retained, generations.RECORD), "preexisting collision", { mode: 0o600 });
    return { root: retained };
  }), (error: unknown) => {
    assert.equal((error as { retainedStage?: boolean }).retainedStage, true); return true;
  });
  assert.equal(count(f.builds), 1);
  assert.equal(readFileSync(join(retained, generations.RECORD), "utf8"), "preexisting collision");
  for (let i = 0; i < 4; i++) generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "generation-")) }));
  assert.throws(() => generations.admit(f.builds, () => { throw new Error("must not admit"); }), /capacity exhausted/);
  const other = fixture(); mkdirSync(other.builds, { recursive: true });
  const sentinel = join(other.root, "sentinel"); writeFileSync(sentinel, "outside admission");
  symlinkSync(sentinel, join(other.builds, ".admission.lock"));
  assert.throws(() => generations.admit(other.builds, () => { throw new Error("must not create"); }), /admission is busy or uncertain/);
  assert.equal(count(other.builds), 0);
  assert.equal(readFileSync(sentinel, "utf8"), "outside admission");
});

test("settled failed Pi setup can retry the identical version below and at full capacity", posix, async () => {
  for (const full of [false, true]) {
    const f = fixture();
    const versionRoot = join(f.runtimes, "pi-1.3.0");
    await assert.rejects(provision(f, "1.3.0", {
      runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
        writeFileSync(join(o.cwd, "failed-install"), "settled partial output");
        return ok({ status: 1 });
      },
    }), /provisioning failed/);
    assert.equal(JSON.parse(readFileSync(join(versionRoot, generations.RECORD), "utf8")).holders.length, 0);
    const survivors = [];
    if (full) for (let i = 1; i <= 4; i++) survivors.push(await provision(f, `1.3.${i}`));
    const result = await provision(f, "1.3.0");
    assert.equal(result.version, "1.3.0");
    assert.equal(result.generation.root, versionRoot);
    assert.equal(existsSync(join(versionRoot, ".setup/failed-install")), false, "actual failed residue was reclaimed before replacement");
    assert.ok(existsSync(result.file));
    assert.ok(survivors.every((survivor) => existsSync(survivor.file)));
    assert.equal(count(f.runtimes), full ? 5 : 1);
    assert.equal(result.generation.release(), true);
  }
});

test("same-version retry protects active, uncertain, legacy, malformed and unsafe incomplete Pi roots", posix, async () => {
  for (const mode of ["active", "uncertain", "legacy", "malformed", "unsafe"] as const) {
    const f = fixture();
    const root = join(f.runtimes, "pi-1.3.0");
    const sentinel = join(f.root, "outside"); writeFileSync(sentinel, "outside retry");
    await assert.rejects(provision(f, "1.3.0", {
      runNpm: async () => ok({ status: 1, cleanupConfirmed: mode !== "uncertain" }),
    }), /provisioning failed/);
    let holder;
    if (mode === "active") holder = generations.pin(f.runtimes, () => ({ root }));
    if (mode === "legacy") requireCjs("node:fs").unlinkSync(join(root, generations.RECORD));
    if (mode === "malformed") writeFileSync(join(root, generations.RECORD), "{}");
    if (mode === "unsafe") symlinkSync(sentinel, join(root, ".setup/outside-link"));
    const before = lstatSync(root, { bigint: true });
    let installs = 0;
    await assert.rejects(provision(f, "1.3.0", { runNpm: async () => { installs += 1; return ok(); } }));
    assert.equal(installs, 0, mode);
    assert.equal(lstatSync(root, { bigint: true }).ino, before.ino, mode);
    assert.equal(count(f.runtimes), 1, mode);
    assert.equal(readFileSync(sentinel, "utf8"), "outside retry", mode);
    if (holder) {
      assert.equal(holder.generation.release(), true);
      const retried = await provision(f, "1.3.0");
      assert.ok(existsSync(retried.file), "an active reservation can retry only once its consumer settles");
    }
  }
});

test("replacement rechecks identity and producer eligibility under the admission lock", posix, () => {
  for (const mode of ["replaced", "published", "active"] as const) {
    const f = fixture(); mkdirSync(f.runtimes, { recursive: true });
    const root = join(f.runtimes, "pi-1.3.0");
    const original = generations.admit(f.runtimes, () => { mkdirSync(root); return { root }; });
    const id = lstatSync(root, { bigint: true });
    assert.equal(original.generation.release(), true);
    if (mode === "replaced") {
      renameSync(root, join(f.root, "retained-original"));
      generations.admit(f.runtimes, () => { mkdirSync(root); return { root }; });
    }
    if (mode === "active") generations.pin(f.runtimes, () => ({ root }));
    if (mode === "published") mkdirSync(join(root, "node_modules"));
    let creates = 0;
    assert.throws(() => generations.admit(f.runtimes, () => { creates += 1; throw new Error("must not create"); }, undefined, {
      root, identity: id, eligible: () => !existsSync(join(root, "node_modules")),
    }), /replacement refused/);
    assert.equal(creates, 0, mode);
    assert.ok(existsSync(root), mode);
    assert.equal(count(f.runtimes), 1, mode);
  }
});

test("explicit, PATH and global managed selections pin before probing and survive capacity pressure until settlement", { ...posix, timeout: 30_000 }, async () => {
  for (const route of ["explicit", "path", "npm-global"] as const) {
    const f = fixture();
    const original = await provision(f, "1.3.0");
    assert.equal(original.generation.release(), true);
    const sentinel = join(f.root, "outside"); writeFileSync(sentinel, "outside selection");
    if (route === "path") symlinkSync(original.file, join(f.bin, "pi"));
    if (route === "npm-global") {
      const alias = join(f.root, "global-alias");
      symlinkSync(join(original.generation.root, "node_modules"), alias, "dir");
      writeFileSync(f.npmCli, `#!/usr/bin/env node\nif (process.argv[2] === "root") console.log(${JSON.stringify(alias)});\n`);
    }
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => { entered = resolve; });
    let settle!: () => void;
    const pendingProbe = new Promise<void>((resolve) => { settle = resolve; });
    const selected = producer.resolvePiRuntime({
      ...(route === "explicit" ? { explicit: original.file } : {}),
      env: f.env, agentDir: join(f.root, "different-agent"), cwd: f.root, writeError: () => undefined,
      processRunner: async (_cli: string, args: string[]) => {
        assert.equal(args[0], original.file);
        assert.equal(JSON.parse(readFileSync(join(original.generation.root, generations.RECORD), "utf8")).holders.length, 1,
          "the canonical pin exists before any executable version probe");
        entered(); await pendingProbe; return ok({ stdout: "1.3.0" });
      },
    });
    // Propagate a resolution failure instead of leaving this test waiting for
    // a probe that was never admitted. The production probe itself is mocked,
    // but admission and reclamation use the actual filesystem throughout.
    await Promise.race([probing, selected.then(() => { throw new Error("probe was not held"); })]);
    const survivors = [];
    for (let i = 1; i <= 4; i++) survivors.push(await provision(f, `1.3.${i}`));
    await assert.rejects(provision(f, "1.3.5"), /capacity exhausted/);
    assert.ok(existsSync(original.file), route);
    settle();
    const result = await selected;
    assert.equal(result.source, route);
    assert.equal(result.file, original.file);
    assert.equal(result.generation.root, original.generation.root);
    await assert.rejects(provision(f, "1.3.5"), /capacity exhausted/, "successful probing does not settle the eventual native consumer");
    assert.equal(result.generation.release(), true);
    const admitted = await provision(f, "1.3.5");
    assert.ok(existsSync(admitted.file));
    assert.equal(existsSync(original.file), false, "only after explicit settlement is the selected runtime reclaimable");
    assert.ok(survivors.every((survivor) => existsSync(survivor.file)));
    assert.equal(readFileSync(sentinel, "utf8"), "outside selection");
    assert.equal(count(f.runtimes), 5);
  }
});

test("managed explicit selections release settled failed probes but retain uncertain probe cleanup", posix, async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    const original = await provision(f, "1.3.0");
    assert.equal(original.generation.release(), true);
    await assert.rejects(producer.resolvePiRuntime({
      explicit: original.file, env: f.env, agentDir: f.agentDir, cwd: f.root, writeError: () => undefined,
      processRunner: async () => ok({ status: 1, cleanupConfirmed: !uncertain }),
    }), uncertain ? /cleanup was not confirmed/ : /exited with status 1/);
    assert.equal(JSON.parse(readFileSync(join(original.generation.root, generations.RECORD), "utf8")).holders.length, uncertain ? 1 : 0);
    for (let i = 1; i <= 4; i++) await provision(f, `1.3.${i}`);
    if (uncertain) {
      await assert.rejects(provision(f, "1.3.5"), /capacity exhausted/);
      assert.ok(existsSync(original.file));
    } else {
      assert.ok(existsSync((await provision(f, "1.3.5")).file));
      assert.equal(existsSync(original.file), false);
    }
  }
});
