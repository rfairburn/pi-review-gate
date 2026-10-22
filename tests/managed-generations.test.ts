import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const requireCjs = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"));
// The CJS producer surface deliberately has no environment/CLI test bypasses.
const producer = requireCjs("../scripts/pi-review-sessions.cjs").__test;
const generations = requireCjs("../scripts/managed-generations.cjs");

/**
 * #385 startup-first contract: the designated `.pi-review-gate/{build,
 * pi-runtime,node}` subtrees are disposable caches. Every test below uses a
 * synthetic owned home under node_modules/ and drives the real producer paths:
 * five (and more) legacy generations without receipts must never block startup,
 * and excess generations must actually be deleted from the filesystem when
 * cleanup works. No real user cache is read or purged.
 */
function fixture(prefix = ".generations-") {
  const root = mkdtempSync(join(process.cwd(), "node_modules", prefix));
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const bin = join(root, "bin");
  for (const dir of [bin, ...["src/session-host", "scripts", "skills"].map((p) => join(packageRoot, p))]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-review-gate", version: "0.1.0" }), { mode: 0o600 });
  for (const name of ["package-lock.json", "tsconfig.json"]) {
    writeFileSync(join(packageRoot, name), "{}", { mode: 0o600 });
  }
  writeFileSync(join(packageRoot, "src/session-host/main.ts"), "// input 0");
  writeFileSync(join(bin, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "npm" } }), { mode: 0o600 });
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\n// inert npm", { mode: 0o700 });
  return {
    root,
    agentDir,
    packageRoot,
    bin,
    env: { HOME: root, PATH: bin, NODE_OPTIONS: "--no-warnings", NODE_ENV: "development", PI_CODING_AGENT_DIR: agentDir },
    npmCli: join(bin, "npm"),
    builds: join(agentDir, ".pi-review-gate/build"),
    runtimes: join(agentDir, ".pi-review-gate/pi-runtime"),
  };
}
type Fixture = ReturnType<typeof fixture>;
function ok(extra = {}) {
  return { status: 0, signal: null, cleanupConfirmed: true, timedOut: false, outputExceeded: false, stdout: "", ...extra };
}
function directories(root: string): string[] {
  return readdirSync(root).filter((name) => lstatSync(join(root, name)).isDirectory()).sort();
}
function count(root: string): number {
  return directories(root).length;
}


/** Direct cache candidates: directories plus direct-child links. */
function countCandidates(root: string): number {
  return readdirSync(root).filter((name) => {
    if (name === ".admission.lock") return false;
    const stat = lstatSync(join(root, name));
    return stat.isDirectory() || stat.isSymbolicLink();
  }).length;
}

/** Physical remaining entries (files, dirs, links) inside one disposable tree. */
function countEntries(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      total += 1;
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(join(current, entry.name));
    }
  }
  return total;
}
function writeCompiler(root: string) {
  const pkg = join(root, "node_modules/typescript");
  mkdirSync(join(pkg, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }));
  writeFileSync(join(pkg, "bin/tsc"), "// inert compiler");
}
function writePi(root: string, version: string) {
  const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "cli.js" } }));
  writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
}
async function build(f: Fixture, extra: Record<string, unknown> = {}) {
  // The shared authority forwards private runner seams as explicit keys; ignore
  // undefined values so this fixture's own runners stay authoritative.
  const overrides = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
  return producer.buildSourceExtension({
    packageRoot: f.packageRoot,
    agentDir: f.agentDir,
    env: f.env,
    writeError: () => undefined,
    runNpm: async (_cli: string, _args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      assert.ok(String(o.env.TMPDIR).startsWith(o.cwd + "/"), "setup stays inside the generation");
      writeCompiler(o.cwd);
      return ok();
    },
    runCompile: async (_cli: string, _args: string[], o: { cwd: string }) => {
      for (const entry of ["dist/src/session-host/main.js", "dist/src/index.js", "dist/src/web/cli.js"]) {
        mkdirSync(join(o.cwd, ...entry.split("/").slice(0, -1)), { recursive: true });
        writeFileSync(join(o.cwd, ...entry.split("/")), "// output");
      }
      return ok();
    },
    ...overrides,
  });
}
async function provision(f: Fixture, version: string, extra: Record<string, unknown> = {}) {
  return producer.provisionPiRuntime({
    env: f.env,
    agentDir: f.agentDir,
    npmCli: f.npmCli,
    provisionVersion: version,
    writeError: () => undefined,
    runNpm: async (_cli: string, args: string[], o: { cwd: string }) => {
      assert.equal(args[2], o.cwd);
      writePi(o.cwd, version);
      return ok();
    },
    processRunner: async () => ok({ stdout: version }),
    ...extra,
  });
}
/** Event-driven readiness wait for a path a concurrently admitted producer creates. */
function waitForPath(file: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (existsSync(file)) { resolve(); return; }
    const watcher = watch(dirname(file), (_event, name) => {
      if (name !== basename(file) || !existsSync(file)) return;
      cleanup();
      resolve();
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${file}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      try { watcher.close(); } catch { /* already closed */ }
    };
    if (existsSync(file)) { cleanup(); resolve(); }
  });
}

function seedLegacy(root: string, names: string[]): string[] {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const roots: string[] = [];
  for (const name of names) {
    const target = join(root, name);
    mkdirSync(join(target, "nested"), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "nested", "legacy-output.txt"), "disposable by location");
    roots.push(target);
  }
  return roots;
}
const posix = { skip: process.platform === "win32" };
const liveHost = (f: Fixture) => {
  mkdirSync(join(f.agentDir, "session-host"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.agentDir, "session-host", "host-ownership.json"), JSON.stringify({ version: 1, hostId: "seed" }));
};

test("legacy generations without receipts are pruned to five per type, not used to refuse startup", () => {
  const f = fixture();
  const legacyBuild = seedLegacy(f.builds, ["a-legacy", "b-malformed", "c-stale", "d-plain", "e-plain", "f-plain", "g-plain"]);
  writeFileSync(join(legacyBuild[1]!, ".generation.json"), "{}", { mode: 0o600 });
  writeFileSync(join(legacyBuild[2]!, ".node-lifetime"), "pi-review-gate-node-v1\n0:0\nbootstrap.x\nprotected\n", { mode: 0o600 });
  const legacyRuntime = seedLegacy(f.runtimes, ["pi-1.2.0", "pi-1.2.1", "pi-1.2.2", "pi-1.2.3", "pi-1.2.4", "pi-1.2.5"]);
  const warnings: string[] = [];
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  assert.ok(existsSync(stage.root));
  assert.equal(stage.generation.release(), true);
  assert.ok(count(f.builds) <= generations.LIMIT, `build cache stayed bounded: ${count(f.builds)}`);
  assert.ok(count(f.runtimes) === 6, "the separate Pi cache type is not touched by build cleanup");
  const removed = legacyBuild.filter((root) => !existsSync(root));
  assert.ok(removed.length >= 3, "actual legacy directories were deleted, not merely counted");
  assert.deepEqual(warnings, [], "successful cleanup reports no warning");
  // The independent Pi type prunes its own excess with no receipts either.
  const runtimeStage = generations.admit(f.runtimes, () => ({ root: mkdtempSync(join(f.runtimes, "pi-")) }));
  assert.ok(existsSync(runtimeStage.root));
  assert.equal(runtimeStage.generation.release(), true);
  assert.ok(count(f.runtimes) <= generations.LIMIT);
  assert.ok(legacyRuntime.filter((root) => !existsSync(root)).length >= 2);
  assert.equal(generations.LIMIT, 5);
});

test("cleanup is confined: outside sentinels survive while links and ordinary nested content are removed without following them", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "outside data");
  const linked = seedLegacy(f.builds, ["a-link"]);
  symlinkSync(outside, join(linked[0]!, "outside-link"));
  const populated = seedLegacy(f.builds, ["b-populated"]);
  mkdirSync(join(populated[0]!, "nested", "deep"), { recursive: true });
  writeFileSync(join(populated[0]!, "nested", "deep", "sentinel"), "ordinary disposable content");
  writeFileSync(join(populated[0]!, "direct-child.txt"), "ordinary disposable content");
  const hardlinked = seedLegacy(f.builds, ["0-hardlink"]);
  const hardlinkTarget = join(f.root, "hardlink-target");
  writeFileSync(hardlinkTarget, "hardlinked outside bytes");
  linkSync(hardlinkTarget, join(hardlinked[0]!, "nested", "hardlink"));
  seedLegacy(f.builds, ["c", "d", "e", "f", "g"]);
  const rootLink = join(f.builds, "a-root-link");
  symlinkSync(outside, rootLink);
  const warnings: string[] = [];
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  assert.ok(existsSync(stage.root), "startup is never refused by an unsafe or unreclaimable entry");
  stage.generation.release();
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside data");
  assert.equal(existsSync(linked[0]!), false, "a generation holding an outside link is removed without following it");
  assert.equal(existsSync(rootLink), false, "a direct-child link is unlinked, never entered");
  assert.equal(existsSync(populated[0]!), false,
    "cleanup traversal removes ordinary nested content inside a selected disposable generation");
  assert.equal(existsSync(join(populated[0]!, "nested", "deep", "sentinel")), false);
  assert.equal(existsSync(hardlinked[0]!), false, "a hardlinked descendant name is unlinked with its generation");
  assert.equal(readFileSync(hardlinkTarget, "utf8"), "hardlinked outside bytes", "outside bytes survive the hardlink removal");
  assert.equal(lstatSync(hardlinkTarget).nlink, 1, "only the cache name is removed");
  assert.deepEqual(warnings, [], "full removal reports no warning");
});

test("stale, empty and malformed admission locks never become permanent startup stops", posix, () => {
  for (const content of ["999999999\n", "", "not-a-pid\n"]) {
    const f = fixture();
    seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
    writeFileSync(join(f.builds, ".admission.lock"), content, { mode: 0o600 });
    const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
    assert.ok(existsSync(stage.root), `lock content ${JSON.stringify(content)} did not block creation`);
    assert.equal(stage.generation.release(), true);
    assert.ok(count(f.builds) <= generations.LIMIT + 1, "a reclaimed stale lock still allows cleanup");
    assert.equal(existsSync(join(f.builds, ".admission.lock")), false);
  }
});

test("malformed non-live admission lock shapes are reclaimed and actually prune", posix, () => {
  for (const shape of ["directory", "symlink", "oversized", "unreadable"] as const) {
    const f = fixture();
    const outside = join(f.root, "outside-lock-target");
    writeFileSync(outside, "outside lock target", { mode: 0o600 });
    seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
    const lock = join(f.builds, ".admission.lock");
    if (shape === "directory") mkdirSync(lock);
    else if (shape === "symlink") symlinkSync(outside, lock);
    // A parseable pid prefix does not make oversized metadata liveness evidence.
    else if (shape === "oversized") writeFileSync(lock, `999999999\n${"x".repeat(200)}`, { mode: 0o600 });
    else { writeFileSync(lock, "", { mode: 0o600 }); chmodSync(lock, 0o000); }
    const warnings: string[] = [];
    const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
    assert.ok(existsSync(stage.root), `${shape}: creation is never refused`);
    assert.equal(stage.generation.release(), true);
    assert.equal(count(f.builds), generations.LIMIT, `${shape}: removable malformed metadata prunes to the target`);
    assert.deepEqual(warnings, [], `${shape}: successful reclamation is not reported as a permanent skip`);
    assert.equal(existsSync(lock), false, `${shape}: the malformed lock artifact itself is gone`);
    assert.equal(readFileSync(outside, "utf8"), "outside lock target", `${shape}: outside the cache lock entry is untouched`);
  }
});

test("a live producer lock replacing malformed metadata during recovery is never deleted", posix, () => {
  const f = fixture();
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const lock = join(f.builds, ".admission.lock");
  mkdirSync(lock);
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const lstat = fs.lstatSync;
  const live = `${process.pid}\n`;
  let directoryObservations = 0;
  let swapPending = false;
  let swapped = false;
  Object.defineProperty(fs, "lstatSync", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof lstat>) => {
      if (!swapped && String(args[0]) === lock) {
        if (swapPending) {
          // The malformed directory has been observed the required number of
          // times; another producer now publishes its own valid live lock just
          // before the recovering producer's next (revalidating) inspection.
          swapped = true;
          swapPending = false;
          fs.rmdirSync(lock);
          fs.writeFileSync(lock, live, { mode: 0o600 });
          return Reflect.apply(lstat, fs, args);
        }
        const observed = Reflect.apply(lstat, fs, args);
        if (observed && observed.isDirectory()) {
          directoryObservations += 1;
          if (directoryObservations === 3) swapPending = true;
        }
        return observed;
      }
      return Reflect.apply(lstat, fs, args);
    },
  });
  const warnings: string[] = [];
  let stage;
  try {
    stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  } finally {
    Object.defineProperty(fs, "lstatSync", { configurable: true, writable: true, value: lstat });
  }
  assert.equal(swapped, true, "the replacement was published before reclamation");
  assert.equal(readFileSync(lock, "utf8"), live, "the replacement live producer lock survives byte-for-byte");
  assert.ok(warnings.some((warning) => warning.includes("cleanup lock was busy")), "cleanup is skipped for the live replacement");
  assert.ok(legacy.every((root) => existsSync(root)), "no generation was pruned while a live producer owns the lock");
  assert.equal(count(f.builds), legacy.length + 1, "startup still creates the fresh generation");
  stage.generation.release();
  assert.equal(readFileSync(lock, "utf8"), live, "releasing this admission never removes a foreign lock");
});

test("a live cleanup lock is left alone, warns, and still admits the new generation", posix, () => {
  const f = fixture();
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  writeFileSync(join(f.builds, ".admission.lock"), `${process.pid}\n`, { mode: 0o600 });
  const warnings: string[] = [];
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  assert.ok(existsSync(stage.root));
  assert.equal(stage.generation.release(), true);
  assert.ok(warnings.some((warning) => warning.includes("cleanup lock was busy")));
  // The foreign live lock was left untouched by that admission.
  assert.ok(existsSync(join(f.builds, ".admission.lock")), "a lock owned by a live process is not stolen");
  writeFileSync(join(f.builds, ".admission.lock"), "999999999\n");
  const next = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
  assert.ok(existsSync(next.root));
  assert.equal(next.generation.release(), true);
  assert.ok(count(f.builds) <= generations.LIMIT);
  assert.equal(existsSync(join(f.builds, ".admission.lock")), false, "a dead owner's lock is reclaimed later");
});

test("a real filesystem cleanup failure warns and startup still proceeds", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const f = fixture();
  const blocked = seedLegacy(f.builds, ["a-blocked"]);
  const locked = join(blocked[0]!, "nested");
  chmodSync(locked, 0o500);
  seedLegacy(f.builds, ["b", "c", "d", "e", "f"]);
  const warnings: string[] = [];
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  assert.ok(existsSync(stage.root), "a cleanup failure never stops creation");
  stage.generation.release();
  assert.ok(warnings.some((warning) => warning.includes("could not reclaim")));
  assert.equal(readFileSync(join(locked, "legacy-output.txt"), "utf8"), "disposable by location");
  chmodSync(locked, 0o700);
  const next = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
  assert.ok(existsSync(next.root));
  next.generation.release();
  assert.equal(existsSync(blocked[0]!), false, "the retry reclaims the formerly blocked generation");
  assert.ok(count(f.builds) <= generations.LIMIT);
});

test("an existing session-host ownership record skips cleanup without blocking creation", posix, () => {
  const f = fixture();
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  liveHost(f);
  const warnings: string[] = [];
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), { warn: (m: string) => warnings.push(m) });
  assert.ok(existsSync(stage.root), "the active host or this launch still starts");
  stage.generation.release();
  assert.ok(legacy.every((root) => existsSync(root)), "a live host's cache generations are left untouched");
  assert.ok(warnings.some((warning) => warning.includes("session host currently owns")));
});

test("application preparation does not reclaim at admission and never deletes live output", posix, async () => {
  const f = fixture();
  const outside = join(f.root, "outside"); writeFileSync(outside, "sentinel");
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const result = await build(f);
  assert.equal(result.ok, true, result.diagnostics);
  assert.ok(result.root.startsWith(f.builds + "/"));
  // Issue 344: admission is non-destructive for application preparation; the
  // coordinated, lease-aware pass runs after the completed generation is
  // published. Nothing is reclaimed before consumers are visible.
  assert.ok(legacy.every((root) => existsSync(root)), "no destructive pass ran before publication");
  assert.equal(readFileSync(outside, "utf8"), "sentinel");
  result.generation?.release();
  generations.cleanup(f.builds, { keep: [result.root] });
  assert.ok(count(f.builds) <= generations.LIMIT, `coordinated cleanup is bounded: ${count(f.builds)}`);
  assert.ok(directories(f.builds).filter((name) => name.startsWith("a")).length === 0, "legacy generations were actually removed");
  assert.ok(existsSync(result.root), "the prepared generation is never a removal candidate");
});

test("a prepared generation stays current across repeated launches without new build output", posix, async () => {
  const f = fixture();
  const prepared = await build(f);
  assert.equal(prepared.ok, true);
  const app = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"))("../scripts/prepare-application.cjs") as {
    prepareApplication(options: Record<string, unknown>): Promise<{ mode: string; preparedRoot?: string; lease?: { release(): void } }>;
  };
  let prepareCalls = 0;
  const options = {
    packageRoot: f.packageRoot,
    agentDir: f.agentDir,
    env: f.env,
    prepare: async () => {
      prepareCalls += 1;
      return prepared;
    },
  };
  const first = await app.prepareApplication(options);
  assert.equal(first.mode, "prepared");
  first.lease?.release();
  const second = await app.prepareApplication(options);
  assert.equal(second.mode, "current", "the shared authority reuses its completed marker");
  assert.equal(second.preparedRoot, prepared.root);
  assert.equal(prepareCalls, 1, "a current launch never re-enters the producer");
  second.lease?.release();
});

test("a large and deep generation is deleted progressively instead of hitting a zero-deletion preflight", posix, () => {
  const f = fixture();
  // One over-full generation with >10k real entries, a chain far deeper than any
  // former recursion quota, ordinary nested content, and outside hardlink/symlink
  // sentinels.
  const big = join(f.builds, "a-large");
  let deepest = big;
  for (let depth = 0; depth < 90; depth += 1) {
    deepest = join(deepest, `d${depth}`);
    mkdirSync(deepest, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(deepest, "deep.txt"), "deep");
  for (let bucket = 0; bucket < 40; bucket += 1) mkdirSync(join(big, `files-${bucket}`), { recursive: true, mode: 0o700 });
  for (let index = 0; index < 12_000; index += 1) {
    writeFileSync(join(big, `files-${index % 40}`, `f-${index}.txt`), "disposable");
  }
  mkdirSync(join(big, "nested-cache", "deep"), { recursive: true, mode: 0o700 });
  writeFileSync(join(big, "nested-cache", "deep", "sentinel"), "ordinary nested content");
  const outside = join(f.root, "outside");
  writeFileSync(outside, "outside bytes");
  linkSync(outside, join(big, "outside-hardlink"));
  symlinkSync(outside, join(big, "outside-symlink"));
  seedLegacy(f.builds, ["b", "c", "d", "e", "f"]);
  const before = countEntries(big);
  assert.ok(before > 12_000, `the fixture is really populated: ${before} entries`);
  // A deliberately tiny pass budget proves the bound is real and that reaching it
  // still deletes content instead of returning an untouched generation.
  const bounded = admitStage(f, { cleanupBudgetMs: 25 });
  assert.ok(existsSync(bounded.root));
  bounded.generation.release();
  assert.ok(existsSync(big), "the bounded pass stopped before the whole generation was gone");
  const afterBounded = countEntries(big);
  assert.ok(afterBounded < before, `the bounded pass deleted real content: ${before} -> ${afterBounded}`);
  assert.equal(readFileSync(outside, "utf8"), "outside bytes", "outside bytes survive the partial pass");
  // The next same-producer passes continue from what remains and finish it.
  for (let pass = 0; pass < 6 && existsSync(big); pass += 1) generations.cleanup(f.builds, {});
  assert.equal(existsSync(big), false, "subsequent passes complete the generation");
  assert.equal(readFileSync(outside, "utf8"), "outside bytes", "the outside sentinel is never followed");
  assert.equal(lstatSync(outside).nlink, 1, "only the cache name of the hardlink was removed");
  assert.ok(count(f.builds) <= generations.LIMIT, `the cache converges: ${count(f.builds)}`);
});

test("a cleanup-only pass never deletes the generation the launch selected", posix, () => {
  const f = fixture();
  // The selected root sorts first, so it is the first removal candidate unless
  // the producer-owned keep set protects it.
  seedLegacy(f.builds, ["a-selected", "b", "c", "d", "e", "f", "g"]);
  const selected = join(f.builds, "a-selected");
  const identity = lstatSync(selected, { bigint: true });
  const result = generations.cleanup(f.builds, { keep: [selected] });
  assert.ok(result.reclaimed >= 1, "the pass actually reclaimed excess generations");
  const after = lstatSync(selected, { bigint: true });
  assert.equal(`${after.dev}:${after.ino}`, `${identity.dev}:${identity.ino}`, "the selected generation is untouched");
  assert.ok(count(f.builds) <= generations.LIMIT, `the cache converges to five: ${count(f.builds)}`);
  assert.ok(!existsSync(join(f.builds, "b")), "another generation was actually removed");
});

test("compatible Pi reuse keeps its validated runtime and converges older version roots", posix, async () => {
  const f = fixture();
  const first = await provision(f, "1.3.0");
  const runtimeRoot = join(f.runtimes, "pi-1.3.0");
  const identity = lstatSync(runtimeRoot, { bigint: true });
  const extra = seedLegacy(f.runtimes, Array.from({ length: 6 }, (_, index) => `pi-1.0.${index}`));
  let installs = 0;
  const reused = await provision(f, "1.3.0", {
    runNpm: async () => { installs += 1; return ok(); },
  });
  assert.equal(installs, 0, "warm Pi reuse installs nothing");
  assert.equal(reused.file, first.file);
  const after = lstatSync(runtimeRoot, { bigint: true });
  assert.equal(`${after.dev}:${after.ino}`, `${identity.dev}:${identity.ino}`, "the reused runtime keeps its identity");
  assert.ok(count(f.runtimes) <= generations.LIMIT, `warm Pi reuse converges the cache: ${count(f.runtimes)}`);
  assert.ok(extra.some((root) => !existsSync(root)), "older Pi version roots were actually reclaimed");
  assert.ok(existsSync(reused.file));
});

test("an abandoned pid-only marker or lock whose pid was reused never pins a generation", posix, () => {
  const longAgo = new Date(Date.now() - 3_600_000);
  // (a) A marker naming a live (reused) pid, written before that process started.
  const staleMarker = fixture();
  const staleRoots = seedLegacy(staleMarker.builds, ["a-marker", "b", "c", "d", "e", "f"]);
  const staleMarkerPath = join(staleRoots[0]!, ".producer-active");
  writeFileSync(staleMarkerPath, `${process.pid}\n`, { mode: 0o600 });
  utimesSync(staleMarkerPath, longAgo, longAgo);
  const staleStage = admitStage(staleMarker);
  staleStage.generation.release();
  assert.equal(existsSync(staleRoots[0]!), false, "a reused-pid marker does not pin its generation");

  // (b) A fresh pid-only marker is legitimate in-flight work from an older
  // producer and is still honored.
  const liveMarker = fixture();
  const liveRoots = seedLegacy(liveMarker.builds, ["a-marker", "b", "c", "d", "e", "f"]);
  writeFileSync(join(liveRoots[0]!, ".producer-active"), `${process.pid}\n`, { mode: 0o600 });
  const liveStage = admitStage(liveMarker);
  liveStage.generation.release();
  assert.equal(existsSync(liveRoots[0]!), true, "a genuinely in-flight legacy marker still protects its generation");

  // (c) A marker that names a birth identity which no longer holds is stale even
  // though its file is fresh.
  const wrongBirth = fixture();
  const wrongRoots = seedLegacy(wrongBirth.builds, ["a-marker", "b", "c", "d", "e", "f"]);
  writeFileSync(join(wrongRoots[0]!, ".producer-active"), `${process.pid}\nlinux:stale-birth:1\n`, { mode: 0o600 });
  const wrongStage = admitStage(wrongBirth);
  wrongStage.generation.release();
  assert.equal(existsSync(wrongRoots[0]!), false, "a mismatched birth identity is not liveness evidence");

  // (d) The same distinction applies to the per-cache admission lock.
  const staleLock = fixture();
  const staleLockRoots = seedLegacy(staleLock.builds, ["a", "b", "c", "d", "e", "f"]);
  const lockPath = join(staleLock.builds, ".admission.lock");
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  utimesSync(lockPath, longAgo, longAgo);
  const staleLockStage = admitStage(staleLock);
  staleLockStage.generation.release();
  assert.equal(existsSync(lockPath), false, "the reused-pid lock is reclaimed");
  assert.ok(staleLockRoots.some((root) => !existsSync(root)), "and reclamation actually ran");

  const liveLock = fixture();
  const liveLockRoots = seedLegacy(liveLock.builds, ["a", "b", "c", "d", "e", "f"]);
  const liveLockPath = join(liveLock.builds, ".admission.lock");
  writeFileSync(liveLockPath, `${process.pid}\n`, { mode: 0o600 });
  const liveLockWarnings: string[] = [];
  const liveLockStage = admitStage(liveLock, { warn: (warning: string) => liveLockWarnings.push(warning) });
  liveLockStage.generation.release();
  assert.ok(liveLockRoots.every((root) => existsSync(root)), "a genuinely current legacy lock still defers cleanup");
  assert.ok(liveLockWarnings.some((warning) => warning.includes("cleanup lock was busy")));
});

test("a completed generation requires its receipt and is never rebuilt in place", posix, async () => {
  const f = fixture();
  const prepared = await build(f);
  assert.equal(prepared.ok, true);
  const app = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"))("../scripts/prepare-application.cjs") as {
    prepareApplication(options: Record<string, unknown>): Promise<{ mode: string; preparedRoot?: string; lease?: { release(): void } }>;
    applicationStatus(options: Record<string, unknown>): { current: boolean };
    attachConsumer(options: Record<string, unknown>): { release(): void } | undefined;
  };
  const preparedResult = await app.prepareApplication({ packageRoot: f.packageRoot, agentDir: f.agentDir, env: f.env, prepare: async () => prepared });
  assert.equal(preparedResult.mode, "prepared");
  preparedResult.lease?.release();
  // The engine itself writes no receipt; publication does. A generation used as
  // a launcher therefore requires the receipt written with its marker.
  const receipt = join(preparedResult.preparedRoot as string, ".pi-review-gate-complete.json");
  assert.equal(existsSync(receipt), true, "publication writes the completion receipt");
  // Remove the receipt: the generation is refused, never rebuilt in place.
  rmSync(receipt);
  let prepareCalls = 0;
  const refused = await app.prepareApplication({
    packageRoot: preparedResult.preparedRoot as string,
    agentDir: f.agentDir,
    env: f.env,
    prepare: async () => {
      prepareCalls += 1;
      return prepared;
    },
  });
  assert.equal(refused.mode, "failed");
  assert.equal(prepareCalls, 0, "an incomplete generation is never rebuilt in place");
});

test("Pi producer provisions more than five versions and reclaims actual directories", posix, async () => {
  const f = fixture();
  seedLegacy(f.runtimes, ["pi-1.0.0", "pi-1.0.1", "pi-1.0.2", "pi-1.0.3", "pi-1.0.4", "pi-1.0.5", "pi-1.0.6"]);
  const roots: string[] = [];
  for (let n = 0; n < 4; n++) {
    const version = `1.3.${n}`;
    const result = await provision(f, version);
    assert.equal(result.version, version);
    roots.push(join(f.runtimes, `pi-${version}`));
    assert.ok(count(f.runtimes) <= generations.LIMIT, `Pi cache bounded after ${version}: ${count(f.runtimes)}`);
    assert.ok(existsSync(result.file));
  }
  assert.ok(roots.every((root) => existsSync(root)), "each newly provisioned version is published");
  assert.ok(directories(f.runtimes).filter((name) => name.startsWith("pi-1.0.")).length < 7,
    "actual legacy Pi directories were reclaimed");
  assert.ok(directories(f.runtimes).includes("pi-1.3.3"));
});

test("settled failed/aborted setup is reclaimed instead of blocking the next launch", posix, async () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) {
    const result = await build(f, { runNpm: async () => ok({ status: 1, timedOut: true }) });
    assert.equal(result.status, 124);
  }
  // Admission is non-destructive; the coordinated pass reclaims failed residue.
  generations.cleanup(f.builds);
  assert.ok(count(f.builds) <= generations.LIMIT, `failed build residue stays bounded: ${count(f.builds)}`);
  const pi = fixture();
  for (let i = 0; i < 7; i++) {
    await assert.rejects(provision(pi, `1.4.${i}`, { runNpm: async () => ok({ status: 1 }) }), /provisioning failed/);
    assert.ok(count(pi.runtimes) <= generations.LIMIT, `failed Pi residue stays bounded: ${count(pi.runtimes)}`);
  }
  // A settled failed same-version install retries after its residue is reclaimed.
  const retry = fixture();
  const versionRoot = join(retry.runtimes, "pi-1.3.0");
  await assert.rejects(provision(retry, "1.3.0", {
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      writeFileSync(join(o.cwd, "failed-install"), "settled partial output");
      return ok({ status: 1 });
    },
  }), /provisioning failed/);
  const retried = await provision(retry, "1.3.0");
  assert.equal(retried.version, "1.3.0");
  assert.equal(existsSync(join(versionRoot, ".setup/failed-install")), false, "actual failed residue was reclaimed");
  assert.ok(existsSync(retried.file));
});

test("simultaneous producers coordinate and are never refused for capacity", posix, async () => {
  const f = fixture();
  const stages: string[] = [];
  const settle: Array<() => void> = [];
  const pending = Array.from({ length: 6 }, () => build(f, {
    forceFresh: true,
    runNpm: async (_c: string, _a: string[], o: { cwd: string }) => {
      stages.push(o.cwd);
      await new Promise<void>((resolve) => settle.push(resolve));
      writeCompiler(o.cwd);
      return ok();
    },
  }));
  assert.equal(stages.length, 6, "all six producers reached setup; none was refused at five");
  const results = await Promise.all(pending.map((pendingBuild) => {
    settle.forEach((done) => done());
    return pendingBuild;
  }));
  assert.ok(results.every((result) => result.ok === true), results.map((result) => result.diagnostics).join("\n"));
  // A direct engine caller settles its own in-flight generation markers; the
  // shared authority does this as part of publication.
  for (const result of results) result.generation?.release();
  // Concurrent creations may briefly exceed the target; the next admission
  // (not a refusal) converges the cache back to five.
  const converged = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
  assert.ok(existsSync(converged.root));
  converged.generation.release();
  assert.ok(count(f.builds) <= generations.LIMIT, `the cache converges to its target: ${count(f.builds)}`);
});

test("native Windows simulation has no count-based refusal either", posix, () => {
  const f = fixture();
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
    assert.ok(existsSync(stage.root), "count alone never refuses creation");
    stage.generation.release();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  assert.ok(count(f.builds) <= generations.LIMIT + 1);
});

test("pin only confirms a direct cache child; generation release is a truthful no-op", posix, () => {
  const f = fixture();
  seedLegacy(f.builds, ["a"]);
  const pinned = generations.pin(f.builds, () => ({ root: join(f.builds, "a") }));
  assert.equal(pinned.selected.root, join(f.builds, "a"));
  assert.equal(pinned.generation.release(), true);
  assert.ok(existsSync(join(f.builds, "a")), "release never deletes a reusable generation");
  assert.throws(() => generations.pin(f.builds, () => ({ root: f.root })), /escaped cache/);
});

test("a cleanup never reclaims a generation another producer is still filling", posix, async () => {
  const f = fixture();
  seedLegacy(f.builds, ["legacy-1", "legacy-2", "legacy-3", "legacy-4"]);
  const stages: Record<string, string> = {};
  const settles: Array<{ name: string; resolve: () => void }> = [];
  const start = (name: string) => build(f, {
    forceFresh: true,
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      stages[name] = o.cwd;
      await new Promise<void>((resolve) => settles.push({ name, resolve }));
      writeCompiler(o.cwd);
      return ok();
    },
  });
  const first = start("first");
  const second = start("second");
  assert.ok(stages.first && stages.second, "both producers reached setup");
  settles.find((settle) => settle.name === "first")!.resolve();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  firstResult.generation?.release();
  // The lock owner has settled; a third cleanup now runs while the second
  // producer is still filling its generation.
  const third = start("third");
  assert.ok(stages.third, "the third producer was admitted");
  assert.ok(existsSync(stages.second!), "cleanup skips the live producer's generation");
  settles.find((settle) => settle.name === "second")!.resolve();
  settles.find((settle) => settle.name === "third")!.resolve();
  const results = await Promise.all([second, third]);
  assert.ok(results.every((result) => result.ok === true), results.map((result) => result.diagnostics).join("\n"));
  for (const result of results) result.generation?.release();
  assert.ok(existsSync(stages.second!), "the staggered setup completed without losing its generation");
  generations.cleanup(f.builds);
  assert.ok(count(f.builds) <= generations.LIMIT, `coordinated cleanup converges: ${count(f.builds)}`);
});

test("a direct-child cache link never exposes an outside marker for deletion", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const outsideMarker = join(outside, ".producer-active");
  writeFileSync(outsideMarker, "999999999\n", { mode: 0o600 });
  const before = readFileSync(outsideMarker);
  seedLegacy(f.builds, ["b", "c", "d", "e", "f"]);
  symlinkSync(outside, join(f.builds, "a-link"));
  symlinkSync(outside, join(f.builds, "z-link"));
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
  stage.generation.release();
  assert.equal(readFileSync(outsideMarker).equals(before), true,
    "the outside marker behind a direct-child cache link is byte-identical");
  assert.equal(existsSync(join(f.builds, "a-link")), false, "the link itself is unlinked, never traversed");
  assert.ok(count(f.builds) <= generations.LIMIT);
});

test("malformed marker shapes are not permanent pins", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside");
  const roots = seedLegacy(f.builds, ["a-dir-marker", "b-link-marker", "c-oversized", "d", "e", "f"]);
  mkdirSync(join(roots[0]!, ".producer-active"));
  symlinkSync(outside, join(roots[1]!, ".producer-active"));
  writeFileSync(join(roots[2]!, ".producer-active"), "x".repeat(200));
  const stage = generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }));
  stage.generation.release();
  assert.equal(existsSync(roots[0]!), false, "a directory-shaped marker does not pin its generation");
  assert.equal(existsSync(roots[1]!), false, "a linked marker is unlinked with its generation, never followed");
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside");
  assert.ok(count(f.builds) <= generations.LIMIT);
});

test("a staggered Pi producer never loses its in-progress setup to a replacement", posix, async () => {
  const f = fixture();
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const first = provision(f, "1.3.11", {
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      await firstHeld;
      writePi(o.cwd, "1.3.11");
      return ok();
    },
  });
  // The second producer's version differs, so it starts while the first still
  // owns the admission lock and its own installation remains paused.
  const second = provision(f, "1.3.12", {
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      await secondHeld;
      writePi(o.cwd, "1.3.12");
      return ok();
    },
  });
  const heldRoot = join(f.runtimes, "pi-1.3.12");
  await waitForPath(heldRoot);
  const heldIdentity = lstatSync(heldRoot, { bigint: true });
  releaseFirst();
  assert.equal((await first).version, "1.3.11");
  // The first producer has settled; requesting the second producer's version
  // must not reclaim its paused generation.
  const warnings: string[] = [];
  const competing = await provision(f, "1.3.12", {
    writeError: (text: string) => warnings.push(text),
    runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
      writePi(o.cwd, "1.3.12");
      return ok();
    },
  });
  const after = lstatSync(heldRoot, { bigint: true });
  assert.equal(after.dev, heldIdentity.dev);
  assert.equal(after.ino, heldIdentity.ino, "the paused producer's generation keeps its identity");
  assert.ok(competing.file.startsWith(join(f.runtimes, "pi-1.3.12.1") + "/"), `the competing launch used a fallback: ${competing.file}`);
  assert.ok(warnings.some((warning) => warning.includes("could not reclaim")));
  releaseSecond();
  const secondResult = await second;
  assert.equal(secondResult.version, "1.3.12");
  assert.ok(secondResult.file.startsWith(heldRoot + "/"), "the paused installation completed in its own generation");
  assert.ok(existsSync(secondResult.file));
  assert.ok(existsSync(competing.file));
});

test("full launcher provisions past eight occupied Pi candidates and reuses the fallback", posix, async () => {
  const f = fixture();
  for (let index = 0; index < 8; index += 1) {
    const root = join(f.runtimes, index === 0 ? "pi-1.3.0" : `pi-1.3.0.${index}`);
    mkdirSync(root, { recursive: true });
    // These candidates are genuinely occupied by live producers, so cleanup
    // must keep skipping them and startup must keep falling back.
    writeFileSync(join(root, ".producer-active"), `${process.pid}\n`, { mode: 0o600 });
  }
  const installs: string[] = [];
  let resolved = "";
  const runLaunch = async (diagnostics: string[]) => {
    let hostStarted = 0;
    const status = await producer.runSessionHostLauncher([], {
      getEnv: () => f.env,
      processEnv: {},
      packageRoot: f.packageRoot,
      platform: "linux",
      cwd: f.root,
      nodeVersion: process.versions.node,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      build: (options: Record<string, unknown>) => build(f, options),
      resolvePiRuntime: async () => {
        const result = await provision(f, "1.3.0", {
          writeError: (text: string) => diagnostics.push(text),
          runNpm: async (_cli: string, _args: string[], o: { cwd: string }) => {
            installs.push(o.cwd);
            writePi(o.cwd, "1.3.0");
            return ok();
          },
        });
        resolved = result.file;
        return result;
      },
      ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
      refreshShippedSkills: () => ({ ok: true }),
      writeOut: () => undefined,
      writeError: (text: string) => diagnostics.push(text),
      loadMain: () => ({ runSessionHost: async () => { hostStarted += 1; return 0; } }),
    });
    return { status, hostStarted };
  };

  const firstDiagnostics: string[] = [];
  const first = await runLaunch(firstDiagnostics);
  assert.equal(first.status, 0, firstDiagnostics.join(""));
  assert.equal(first.hostStarted, 1);
  assert.equal(installs.length, 1, "exactly one install was needed past all occupied candidates");
  assert.ok(resolved.startsWith(join(f.runtimes, "pi-1.3.0.8") + "/"), `used the next confined candidate: ${resolved}`);
  assert.ok(firstDiagnostics.some((line) => /cache retains \d+ generations/u.test(line)),
    "the live-owned candidates are reported, not falsely counted as pruned");
  assert.ok(firstDiagnostics.some((line) => line.includes("could not reclaim")));

  const secondDiagnostics: string[] = [];
  const second = await runLaunch(secondDiagnostics);
  assert.equal(second.status, 0, secondDiagnostics.join(""));
  assert.equal(second.hostStarted, 1);
  assert.equal(installs.length, 1, "the next launch reuses the valid fallback without another install");
  assert.equal(resolved.startsWith(join(f.runtimes, "pi-1.3.0.8") + "/"), true);
  assert.doesNotMatch(secondDiagnostics.join(""), /cleanup lock was busy/);
});

test("an unreclaimable incomplete Pi generation falls back to a fresh confined generation", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = fixture();
  const blockedRoot = join(f.runtimes, "pi-1.3.0");
  mkdirSync(join(blockedRoot, "nested"), { recursive: true });
  writeFileSync(join(blockedRoot, "nested", "failed-install"), "settled residue");
  chmodSync(join(blockedRoot, "nested"), 0o500);
  const warnings: string[] = [];
  const result = await provision(f, "1.3.0", { writeError: (text: string) => warnings.push(text) });
  assert.equal(result.version, "1.3.0");
  assert.ok(result.file.startsWith(join(f.runtimes, "pi-1.3.0.1") + "/"), `fell back to a confined generation: ${result.file}`);
  assert.ok(existsSync(result.file));
  assert.ok(warnings.some((warning) => warning.includes("could not reclaim")), "the failed reclamation is reported");
  assert.ok(existsSync(join(blockedRoot, "nested", "failed-install")), "the unreclaimable generation is preserved");
});

test("a busy cleanup lock does not stop Pi provisioning into a fresh generation", posix, async () => {
  const f = fixture();
  mkdirSync(f.runtimes, { recursive: true });
  mkdirSync(join(f.runtimes, "pi-1.3.0"), { recursive: true });
  writeFileSync(join(f.runtimes, ".admission.lock"), `${process.pid}\n`, { mode: 0o600 });
  const warnings: string[] = [];
  const result = await provision(f, "1.3.0", { writeError: (text: string) => warnings.push(text) });
  assert.ok(result.file.startsWith(join(f.runtimes, "pi-1.3.0.1") + "/"));
  assert.ok(existsSync(result.file));
  assert.ok(warnings.some((warning) => warning.includes("cleanup lock was busy")));
});

test("full launcher startup succeeds when an incomplete Pi generation cannot be reclaimed", posix, async () => {
  const f = fixture();
  mkdirSync(join(f.runtimes, "pi-1.3.0"), { recursive: true });
  writeFileSync(join(f.runtimes, ".admission.lock"), `${process.pid}\n`, { mode: 0o600 });
  let hostStarted = 0;
  const diagnostics: string[] = [];
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    resolvePiRuntime: async () => provision(f, "1.3.0", { writeError: (text: string) => diagnostics.push(text) }),
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: () => ({ runSessionHost: async () => { hostStarted += 1; return 0; } }),
  });
  assert.equal(status, 0, diagnostics.join(""));
  assert.equal(hostStarted, 1, "the host actually started despite the unreclaimable Pi generation");
  assert.doesNotMatch(diagnostics.join(""), /capacity exhausted/);
  assert.ok(diagnostics.some((line) => line.includes("cleanup lock was busy")), "the skipped cleanup is reported");
});

test("full launcher startup succeeds with five and more legacy build/Pi generations", posix, async () => {
  for (const seeded of [5, 8]) {
    const f = fixture();
    const buildRoots = seedLegacy(f.builds, Array.from({ length: seeded }, (_, i) => `legacy-build-${i}`));
    const runtimeRoots = seedLegacy(f.runtimes, Array.from({ length: seeded }, (_, i) => `pi-1.1.${i}`));
    let loadedEntry = "";
    let hostStarted = 0;
    const diagnostics: string[] = [];
    const status = await producer.runSessionHostLauncher([], {
      getEnv: () => f.env,
      processEnv: {},
      packageRoot: f.packageRoot,
      platform: "linux",
      cwd: f.root,
      nodeVersion: process.versions.node,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      build: (options: Record<string, unknown>) => build(f, options),
      resolvePiRuntime: async () => provision(f, "1.3.0"),
      ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
      refreshShippedSkills: () => ({ ok: true }),
      writeOut: () => undefined,
      writeError: (text: string) => diagnostics.push(text),
      loadMain: (entry: string) => {
        loadedEntry = entry;
        return { runSessionHost: async () => { hostStarted += 1; return 0; } };
      },
    });
    assert.equal(status, 0, diagnostics.join(""));
    assert.equal(hostStarted, 1, "the host actually started");
    assert.ok(loadedEntry.startsWith(f.builds + "/"), `the compiled host came from the owned build cache: ${loadedEntry}`);
    assert.doesNotMatch(diagnostics.join(""), /capacity exhausted|unknown|cannot start/i);
    const survivingBuilds = count(f.builds);
    assert.ok(survivingBuilds <= generations.LIMIT, `${seeded} legacy builds bounded to ${survivingBuilds}`);
    assert.ok(count(f.runtimes) <= generations.LIMIT, "legacy Pi generations bounded independently");
    const removedBuilds = buildRoots.filter((root) => !existsSync(root)).length;
    const removedRuntimes = runtimeRoots.filter((root) => !existsSync(root)).length;
    assert.ok(removedBuilds >= seeded - 4, `actual build directories were reclaimed: ${removedBuilds}`);
    assert.ok(removedRuntimes >= seeded - 4, `actual Pi directories were reclaimed: ${removedRuntimes}`);
  }
});

test("the launcher holds the per-agent coordination entry from selection to host ownership", posix, async () => {
  const f = fixture();
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const coordination = join(f.agentDir, "session-host", generations.COORDINATION as string);
  const ownership = join(f.agentDir, "session-host", "host-ownership.json");
  let entryDuringLoad: string | undefined;
  let entryAfterHost = "unset";
  const diagnostics: string[] = [];
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    resolvePiRuntime: async () => provision(f, "1.3.0"),
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: () => {
      // The hold already protects the prepared selection here, before the host
      // claims ownership.
      entryDuringLoad = existsSync(coordination)
        ? readFileSync(coordination, "utf8").split("\n")[0]!.trim()
        : undefined;
      return {
        runSessionHost: async () => {
          // The host claims ownership inside that hold and hands the entry back.
          writeFileSync(ownership, JSON.stringify({ version: 1, hostId: "launcher-handoff" }));
          rmSync(coordination, { force: true });
          entryAfterHost = existsSync(coordination) ? "present" : "handed-back";
          rmSync(ownership, { force: true });
          return 0;
        },
      };
    },
  });
  assert.equal(status, 0, diagnostics.join(""));
  assert.equal(entryDuringLoad, String(process.pid),
    "the launcher holds the canonical per-agent coordination entry for the handoff");
  assert.equal(entryAfterHost, "handed-back", "ownership acquisition ends the launcher hold");
  assert.equal(existsSync(coordination), false, "no coordination entry is left behind");
});

/**
 * The handoff re-validates a managed Pi selection by re-entering the launcher's
 * own selection authority inside the hold. Both reclamation shapes are covered:
 * a removed generation, and a partially reclaimed generation that keeps its root
 * and CLI file while losing required runtime contents. In each case the existing
 * validator rejects the selection and replacement preparation runs, so startup
 * succeeds without a new refusal.
 */
async function runReclaimedPiSelectionTest(mode: "removed" | "partial"): Promise<void> {
  const f = fixture();
  const selections: string[] = [];
  let preparedFile = "";
  let handedOverFile = "";
  let hostStarted = 0;
  const diagnostics: string[] = [];
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    // The fixture producer runs the real provisionPiRuntime/validateCachedPiRuntime
    // validation code with injected npm and version-probe seams.
    resolvePiRuntime: async (options: { explicit?: string }) => {
      selections.push(String(options.explicit));
      if (selections.length === 1) {
        const result = await provision(f, "1.3.0");
        preparedFile = result.file;
        if (mode === "removed") {
          // A concurrent preparation reclaimed the whole selected generation.
          rmSync(join(f.runtimes, "pi-1.3.0"), { recursive: true, force: true });
        } else {
          // Bounded partial reclamation: the generation root and the CLI file
          // survive, required runtime contents do not.
          rmSync(join(f.runtimes, "pi-1.3.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), { force: true });
          rmSync(join(f.runtimes, "pi-1.3.0", "node_modules", "@earendil-works", "pi-coding-agent", "lib"), { recursive: true, force: true });
        }
        return result;
      }
      if (selections.length === 2) {
        // The launcher re-enters its normal validated selection for the managed
        // selection: run the REAL production resolver branch so its package
        // validation (not a substitute provisioner) decides usability.
        return producer.resolvePiRuntime({
          explicit: options.explicit,
          env: f.env,
          agentDir: f.agentDir,
          cwd: f.root,
          writeError: (text: string) => diagnostics.push(text),
          processRunner: async () => ok({ stdout: "1.3.0" }),
        });
      }
      return provision(f, mode === "removed" ? "1.3.0" : "1.3.1");
    },
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: () => ({
      runSessionHost: async (options: { piExecutable: string }) => {
        hostStarted += 1;
        handedOverFile = options.piExecutable;
        return 0;
      },
    }),
  });
  assert.equal(status, 0, diagnostics.join(""));
  assert.equal(hostStarted, 1, `${mode}: the host actually started`);
  assert.ok(selections.length >= 2, `${mode}: the hold re-entered validated selection: ${selections.join(" | ")}`);
  assert.equal(selections[1], preparedFile, `${mode}: the managed selection is re-validated inside the hold`);
  assert.ok(existsSync(handedOverFile), `${mode}: the runtime handed to the host exists: ${handedOverFile}`);
  assert.match(diagnostics.join(""), /validating and preparing the Pi runtime again inside the ownership handoff/);
  assert.doesNotMatch(diagnostics.join(""), /reclaimed by a concurrent cache cleanup|Session host refused/,
    `${mode}: no new startup refusal is introduced for a cache this launcher pruned itself`);
  if (mode === "removed") {
    // Re-entering the normal selection path re-prepared the same version generation.
    assert.equal(handedOverFile, preparedFile, "the re-prepared generation is handed to the host");
    assert.ok(existsSync(join(f.runtimes, "pi-1.3.0", "node_modules", "@earendil-works", "pi-coding-agent", "cli.js")));
  } else {
    // A published-but-partial generation is preserved and a confined replacement
    // generation is prepared instead.
    assert.ok(handedOverFile.startsWith(join(f.runtimes, "pi-1.3.1") + "/"), `a replacement generation is used: ${handedOverFile}`);
    assert.equal(existsSync(join(f.runtimes, "pi-1.3.0", "node_modules", "@earendil-works", "pi-coding-agent", "package.json")), false,
      "the partially reclaimed generation is preserved as-is, never repaired in place");
  }
}

test("a reclaimed prepared Pi selection is re-prepared inside the handoff instead of refusing startup", posix, async () => {
  await runReclaimedPiSelectionTest("removed");
});

test("a partially reclaimed Pi generation is rejected by the existing validator and replaced", posix, async () => {
  await runReclaimedPiSelectionTest("partial");
});

/**
 * The handoff hold is released only by the ownership claim or the launcher's own
 * exit — never by elapsed time. While a final rebuild/reprepare step is still
 * pending, a real second process cannot reclaim the selected build, and the host
 * still receives a live hold when it claims ownership.
 */
test("the handoff hold survives a pending preparation and cannot be pruned by a real competing producer", posix, async () => {
  const f = fixture();
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const coordination = join(f.agentDir, "session-host", generations.COORDINATION as string);
  const generationsPath = join(process.cwd(), "scripts", "managed-generations.cjs");
  const barrierMarker = join(f.root, "preparation-pending");
  const barrierRelease = join(f.root, "preparation-release");
  const competingLog = join(f.root, "competing-admit.jsonl");
  const childSource = join(f.root, "competing-admit.cjs");
  writeFileSync(childSource, [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const generations = require(${JSON.stringify(generationsPath)});`,
    `const cache = process.argv[2];`,
    `const marker = process.argv[3];`,
    `const release = process.argv[4];`,
    `const warnings = [];`,
    `const stage = generations.admit(cache, () => ({ root: fs.mkdtempSync(path.join(cache, "competing-")) }), {`,
    `  warn: (warning) => warnings.push(warning),`,
    `});`,
    `let preparedRootSeen = false;`,
    `for (const name of fs.readdirSync(cache)) {`,
    `  if (name === "pi-review-sessions-prepared") preparedRootSeen = fs.existsSync(path.join(cache, name, "dist", "main.js"));`,
    `}`,
    `fs.appendFileSync(release, JSON.stringify({ warnings, preparedRootSeen }) + "\\n");`,
    `stage.generation.release();`,
    ``,
  ].join("\n"), "utf8");
  // A deterministic prepared build generation this launch hands to the host.
  const preparedRoot = join(f.builds, "pi-review-sessions-prepared");
  mkdirSync(join(preparedRoot, "dist"), { recursive: true });
  writeFileSync(join(preparedRoot, "dist", "main.js"), "// prepared host entry");
  const preparedIdentity = lstatSync(preparedRoot, { bigint: true });
  const timeouts: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  let holdPresentDuringPreparation = false;
  let resolveCalls = 0;
  let instrumented = false;
  const diagnostics: string[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    if (typeof delay === "number") timeouts.push(delay);
    return (realSetTimeout as (...args: unknown[]) => unknown)(handler, delay, ...rest);
  }) as typeof globalThis.setTimeout;
  instrumented = true;
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    resolvePiRuntime: async () => {
      resolveCalls += 1;
      if (resolveCalls === 2) {
        // The managed Pi re-selection runs inside the ownership handoff: another
        // producer runs against the same agent directory while the selected
        // prepared generation must stay protected.
        writeFileSync(barrierMarker, "pending");
        const competing = spawnSync(process.execPath, [childSource, f.builds, barrierMarker, competingLog], { encoding: "utf8" });
        assert.equal(competing.status, 0, competing.stderr);
        holdPresentDuringPreparation = existsSync(coordination)
          && readFileSync(coordination, "utf8").split("\n")[0]!.trim() === String(process.pid);
        writeFileSync(barrierRelease, "done");
      }
      return provision(f, "1.3.0");
    },
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: () => ({
      runSessionHost: async () => {
        // The host still receives a live hold at its ownership claim.
        assert.equal(existsSync(coordination), true, "the hold is still held when the host claims ownership");
        const held = readFileSync(coordination, "utf8").split("\n");
        assert.equal(held[0]!.trim(), String(process.pid));
        assert.ok((held[1] ?? "").trim().length > 0, "the published record already carries the owner identity");
        writeFileSync(join(f.agentDir, "session-host", "host-ownership.json"), JSON.stringify({ version: 1, hostId: "delayed" }));
        rmSync(coordination, { force: true });
        return 0;
      },
    }),
  });
  globalThis.setTimeout = realSetTimeout;
  assert.equal(instrumented, true);
  assert.equal(status, 0, diagnostics.join(""));
  assert.equal(holdPresentDuringPreparation, true, `the handoff is active during Pi selection (resolveCalls=${resolveCalls})`);
  // The competing producer reached the cache but was told to leave it alone.
  const release = readFileSync(competingLog, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(release.length >= 1, "the competing producer reported its admission");
  const competing = JSON.parse(release[0]!) as { warnings: string[]; preparedRootSeen: boolean };
  assert.equal(competing.preparedRootSeen, true, "the prepared build generation survived the competing producer");
  assert.ok(competing.warnings.some((warning) => warning.includes("host ownership coordination")),
    `the competing producer skipped reclamation through the live handoff: ${competing.warnings.join(" | ")}`);
  const after = lstatSync(preparedRoot, { bigint: true });
  assert.equal(`${after.dev}:${after.ino}`, `${preparedIdentity.dev}:${preparedIdentity.ino}`,
    "the selected build keeps its filesystem identity through ownership acquisition");
  assert.ok(timeouts.every((delay) => delay < 120_000),
    `the handoff schedules no elapsed-time release valve: ${timeouts.join(", ")}`);
  assert.equal(existsSync(coordination), false, "ownership acquisition ended the hold");
});
/**
 * A handoff hold never inherits the producer admission busy deadline: after a
 * live-holder wait longer than that deadline, the holder's own release (an
 * EEXIST→ENOENT transition) or a freshly published empty record must still result
 * in a held entry, never an uncoordinated continuation.
 */
test("the handoff still acquires the entry after a live-holder release past the admission deadline", posix, async () => {
  for (const shape of ["release", "empty-record"] as const) {
    const f = fixture();
    const stateDir = join(f.agentDir, "session-host");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const coordination = join(stateDir, generations.COORDINATION as string);
    const handoffScript = join(f.root, "handoff.cjs");
    const holderScript = join(f.root, "holder.cjs");
    writeFileSync(handoffScript, [
      `const fs = require("node:fs");`,
      `const generations = require(${JSON.stringify(join(process.cwd(), "scripts", "managed-generations.cjs"))});`,
      `const started = Date.now();`,
      `const lease = generations.holdAgentDirectory(process.argv[2]);`,
      `const elapsed = Date.now() - started;`,
      `if (!lease) { process.stdout.write(JSON.stringify({ held: false, elapsed }) + "\\n"); process.exit(2); }`,
      `const text = fs.readFileSync(process.argv[3], "utf8");`,
      `const lines = text.split("\\n");`,
      `process.stdout.write(JSON.stringify({ held: true, elapsed, owner: lines[0].trim(), identity: (lines[1] || "").trim(), pid: process.pid }) + "\\n");`,
      `lease.release();`,
      ``,
    ].join("\n"), "utf8");
    // A real live holder keeps the entry past the producer admission deadline and
    // then settles it exactly as a completing producer does.
    writeFileSync(holderScript, [
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const stateDir = process.argv[2];`,
      `const lock = path.join(stateDir, ${JSON.stringify(generations.COORDINATION)});`,
      `const shape = process.argv[3];`,
      `const identity = require(${JSON.stringify(join(process.cwd(), "scripts", "managed-generations.cjs"))}).coordinationInternals.ownerStartIdentity(process.pid);`,
      `fs.writeFileSync(lock, String(process.pid) + "\\n" + identity + "\\n", { mode: 0o600 });`,
      `process.stdout.write("holding\\n");`,
      // Longer than the 2s producer admission deadline, then settle the entry.
      `const holdUntil = Date.now() + 2600;`,
      `while (Date.now() < holdUntil) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
      // Publish the empty fixture atomically: unlink-then-write would expose a
      // gap in which the handoff can acquire, then truncate its new record. That
      // tests a destructive fixture writer, not malformed-record recovery.
      `if (shape === "empty-record") {`,
      `  const settled = lock + ".fixture-settled";`,
      `  fs.writeFileSync(settled, "", { mode: 0o600, flag: "wx" });`,
      `  fs.renameSync(settled, lock);`,
      `} else {`,
      `  fs.unlinkSync(lock);`,
      `}`,
      `process.stdout.write("settled\\n");`,
      ``,
    ].join("\n"), "utf8");
    const holder = spawn(process.execPath, [holderScript, stateDir, shape], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
      const handoff = spawn(process.execPath, [handoffScript, f.agentDir, coordination], { stdio: ["ignore", "pipe", "inherit"] });
      let output = "";
      handoff.stdout!.setEncoding("utf8");
      handoff.stdout!.on("data", (chunk: string) => { output += chunk; });
      const result = await new Promise<{ held: boolean; elapsed: number; owner: string; identity: string; pid: number }>((resolve, reject) => {
        handoff.once("exit", (code, signal) => {
          const line = output.trim().split("\n").filter((entry) => entry.startsWith("{"))[0];
          if (code !== 0) reject(new Error(`handoff did not exit successfully (code=${code}, signal=${signal}): ${output}`));
          else if (!line) reject(new Error(`no handoff result: ${output}`));
          else resolve(JSON.parse(line!) as { held: boolean; elapsed: number; owner: string; identity: string; pid: number });
        });
      });
      assert.equal(result.held, true, `${shape}: the handoff holds the entry instead of continuing uncoordinated`);
      assert.ok(result.elapsed >= 2000, `${shape}: the live-holder wait exceeded the producer admission deadline (${result.elapsed}ms)`);
      assert.equal(result.owner, String(result.pid), `${shape}: the handoff owns the entry it published`);
      if (process.platform !== "win32") {
        assert.ok(result.identity.length > 0, `${shape}: the published record carries its owner identity`);
      }
      assert.equal(existsSync(coordination), false, `${shape}: the handoff released only its own entry`);
    } finally {
      holder.kill("SIGKILL");
    }
  }
});

/**
 * Canonical-record publication is atomic: the complete record is written to a
 * private candidate and published with a no-overwrite hard link. A publisher
 * paused between those two steps therefore only loses the link race; it can never
 * expose a half-written entry or resume believing it owns the mutex.
 */
test("a paused coordination publisher loses the link race and never owns the entry", posix, async () => {
  const f = fixture();
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const coordination = join(stateDir, generations.COORDINATION as string);
  const releaseFile = join(f.root, "publisher-resume");
  const publisherScript = join(f.root, "paused-publisher.cjs");
  writeFileSync(publisherScript, [
    `const fs = require("node:fs");`,
    `const generations = require(${JSON.stringify(join(process.cwd(), "scripts", "managed-generations.cjs"))});`,
    `const stateDir = process.argv[2];`,
    `const releaseFile = process.argv[3];`,
    `const candidate = generations.coordinationInternals.prepareCoordinationCandidate(stateDir);`,
    `process.stdout.write((candidate ? "candidate-ready" : "candidate-failed") + "\\n");`,
    `const deadline = Date.now() + 30000;`,
    `while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `const entry = require("node:path").join(stateDir, generations.COORDINATION);`,
    `const outcome = candidate.publish(entry);`,
    `process.stdout.write("publish:" + outcome + "\\n");`,
    ``,
  ].join("\n"), "utf8");
  const publisher = spawn(process.execPath, [publisherScript, stateDir, releaseFile], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  publisher.stdout!.setEncoding("utf8");
  publisher.stdout!.on("data", (chunk: string) => { output += chunk; });
  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes("candidate-ready") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(output.includes("candidate-ready"), "the publisher prepared its complete candidate");
    assert.equal(existsSync(coordination), false,
      "a paused publisher never exposes a half-written canonical record");
    // Another actor publishes and holds the canonical entry while the first
    // publisher is still paused.
    const lease = generations.holdAgentDirectory(f.agentDir);
    assert.ok(lease, "the second actor holds the entry");
    const ownedBytes = readFileSync(coordination, "utf8");
    assert.equal(ownedBytes.split("\n")[0]!.trim(), String(process.pid));
    writeFileSync(releaseFile, "resume");
    await new Promise<void>((resolve) => publisher.once("exit", () => resolve()));
    assert.match(output, /publish:lost/, "the resumed publisher loses the link race instead of adopting the entry");
    assert.equal(readFileSync(coordination, "utf8"), ownedBytes,
      "the holder's record is byte-for-byte intact after the resumed publisher");
    lease!.release();
    assert.equal(existsSync(coordination), false, "the holder released only its own entry");
  } finally {
    writeFileSync(releaseFile, "resume");
    publisher.kill("SIGKILL");
  }
});

/**
 * Owner-lifetime identity keeps a reused pid from becoming a permanent gate: a
 * live pid with a mismatched start identity is stale metadata and is reclaimed,
 * while a live pid with its recorded identity is a current holder and is honored.
 */
test("a live pid with a mismatched start identity is stale metadata, not a permanent holder", posix, async () => {
  const f = fixture();
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const coordination = join(stateDir, generations.COORDINATION as string);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const identity = generations.coordinationInternals.ownerStartIdentity(holder.pid as number);
    assert.ok(identity.length > 0, "the targeted single-pid start identity is available on this platform");
    const seeded = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
    // A live but unrelated pid recorded with a start identity that is not its own:
    // this is exactly the abandoned-record-with-reused-pid case.
    writeFileSync(coordination, `${holder.pid}\nSat Jan  1 00:00:00 2000\n`, { mode: 0o600 });
    const warnings: string[] = [];
    const stage = admitStage(f, { warn: (warning: string) => warnings.push(warning) });
    assert.ok(existsSync(stage.root), "startup proceeds");
    stage.generation.release();
    assert.ok(seeded.some((root) => !existsSync(root)), "the stale record was reclaimed and reclamation ran");
    assert.ok(!warnings.some((warning) => warning.includes("coordination was busy")),
      "a reused pid is not treated as a current holder");
    assert.equal(existsSync(coordination), false, "the stale record itself is gone");

    // The same live pid recorded with its real start identity is a current holder.
    const second = fixture();
    mkdirSync(join(second.agentDir, "session-host"), { recursive: true, mode: 0o700 });
    const secondCoordination = join(second.agentDir, "session-host", generations.COORDINATION as string);
    writeFileSync(secondCoordination, `${holder.pid}\n${identity}\n`, { mode: 0o600 });
    const protectedRoots = seedLegacy(second.builds, ["a", "b", "c", "d", "e", "f"]);
    const heldWarnings: string[] = [];
    const heldStage = admitStage(second, { warn: (warning: string) => heldWarnings.push(warning) });
    assert.ok(existsSync(heldStage.root), "startup proceeds while a current holder is honored");
    heldStage.generation.release();
    assert.ok(protectedRoots.every((root) => existsSync(root)), "a current holder's cache is left untouched");
    assert.ok(heldWarnings.some((warning) => warning.includes("host ownership coordination")),
      `the current holder was honored: ${heldWarnings.join(" | ")}`);
  } finally {
    holder.kill("SIGKILL");
  }
});

/**
 * Protocol consistency across the CJS, TypeScript host, POSIX, and PowerShell
 * paths: the canonical coordination record is published already complete with an
 * atomic no-overwrite hard link (never created empty and written in place), it
 * carries a targeted single-pid owner identity, and readers accept the
 * publisher's transient nlink 2.
 */
test("every coordination path publishes the complete record atomically with an owner identity", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  const cjs = read("scripts/managed-generations.cjs");
  assert.match(cjs, /fs\.linkSync\(candidate, entryPath\)/, "CJS publishes with an atomic no-overwrite link");
  assert.match(cjs, /ownerStartIdentity/, "CJS records a targeted single-pid owner identity");
  assert.match(cjs, /`linux:\$\{boot\}:\$\{starttime\}`/, "CJS derives the Linux token from one pid's /proc stat fields");
  assert.match(cjs, /`darwin:\$\{token\}`/, "CJS derives the macOS token from one targeted ps query");
  assert.match(cjs, /`\/proc\/\$\{pid\}\/stat`/, "CJS reads a single pid's /proc stat (no procps required)");
  assert.match(cjs, /\[Console\]::Out\.Write\('win32:' \+/, "CJS derives the Windows token from one targeted native query");
  assert.match(cjs, /Get-Process -Id \$OwnerPid/, "the Windows query takes one known numeric pid through its script-block parameter");
  assert.match(cjs, /& \{ param\(\[int\]\$OwnerPid\)/, "the Windows query is invoked as a parameterized script block");
  assert.match(cjs, /if \(record\.identity === ""\) return false;/u, "CJS never honors a record without a birth identity");
  assert.match(cjs, /record\.pid === process\.pid/u,
    "CJS self-adoption is scoped to this process's own pid");
  assert.match(cjs, /if \(ownIdentity !== "" && record\.identity === ownIdentity\)/u,
    "CJS self-adoption also requires the recorded birth identity");
  assert.match(cjs, /& \{ param\(\[int\]\$OwnerPid\)/u, "the Windows query is a parameterized script block");
  assert.match(cjs, /let OWN_OWNER_IDENTITY_CACHE = "";/,
    "CJS publishes no record when the owner identity is unavailable");
  assert.match(cjs, /before\.nlink !== 1n && before\.nlink !== 2n/,
    "CJS accepts the publisher's transient hard-link pairing and rejects other link counts");
  assert.doesNotMatch(cjs, /openSync\(entryPath, "wx"/, "CJS never creates the canonical entry empty and writes it in place");

  const host = read("src/session-host/roster-store.ts");
  assert.match(host, /linkSync\(candidate, entryPath\)/, "the host publishes with an atomic no-overwrite link");
  assert.match(host, /ownerStartIdentity/, "the host records a targeted single-pid owner identity");
  assert.match(host, /let OWN_OWNER_IDENTITY_CACHE = "";/,
    "the host publishes no record when the owner identity is unavailable");
  assert.match(host, /& \{ param\(\[int\]\$OwnerPid\)/u, "the host query is a parameterized script block");
  assert.match(host, /Get-Process -Id \$OwnerPid/u, "the host query takes one known numeric pid through its script-block parameter");
  assert.match(host, /if \(record\.identity === ""\) return false;/u, "the host never honors a record without a birth identity");
  assert.match(host, /if \(record\.identity === ownIdentity\) return \{ status: "self" \}/u,
    "host self-adoption also requires the recorded birth identity");
  assert.match(host, /linux:\$\{boot\}|linux:/, "the host derives the Linux token from /proc");
  assert.match(host, /before\.nlink !== 1n && before\.nlink !== 2n/,
    "the host accepts the transient hard-link pairing");
  assert.doesNotMatch(host, /openSync\(entryPath, "wx"/, "the host never creates the canonical entry empty");

  const posix = read("scripts/node-generations.sh");
  assert.match(posix, /"\$NODE_HARDLINK_BIN" "\$candidate" "\$NODE_COORDINATION_LOCK"/,
    "the POSIX wrapper publishes with an atomic no-overwrite hard link");
  assert.match(posix, /node_owner_identity/, "the POSIX wrapper records a targeted single-pid owner identity");
  assert.match(posix, /printf '%s' "linux:\$boot:\$\{fields\[19\]\}"/, "the POSIX wrapper derives the Linux token from /proc");
  assert.match(posix, /printf '%s' "darwin:\$\{words\[\*\]\}"/, "the POSIX wrapper derives the macOS token from one ps query");
  assert.doesNotMatch(posix, /requires unlink, rmdir, and ln/, "coordination tooling is never a cache-cleanup prerequisite");
  assert.match(posix, /\[\[ -n "\$owner" && -n "\$\{NODE_HARDLINK_BIN:-\}" \]\] \|\| return 1/u,
    "the POSIX publisher refuses to publish without a birth identity");
  assert.match(posix, /\[\[ -n "\$identity" \]\] \|\| return 1/u, "the POSIX reader never honors a record without a birth identity");
  assert.match(posix, /"\$links" == 1 \|\| "\$links" == 2/, "the POSIX wrapper accepts the transient hard-link pairing");
  assert.doesNotMatch(posix, /> "\$NODE_COORDINATION_LOCK"/, "the POSIX wrapper never writes the canonical entry in place");

  const powershell = read("scripts/pi-review-sessions-node.ps1");
  assert.match(powershell, /CreateHardLinkW\(\$entry, \$candidate/, "the PowerShell path publishes with an atomic no-overwrite hard link");
  assert.match(powershell, /Get-NodeOwnerIdentity/, "the PowerShell path records a targeted single-pid owner identity");
  assert.match(powershell, /return 'win32:' \+/, "the PowerShell path uses the same win32 token format as the CJS/TypeScript writers");
  assert.match(powershell, /if \(\[string\]::IsNullOrEmpty\(\$identity\)\) \{ return 'failed' \}/,
    "the PowerShell path publishes no record when the owner identity is unavailable");
  assert.match(powershell, /if \(\[string\]::IsNullOrEmpty\(\$Record\.Identity\)\) \{ return \$false \}/,
    "the PowerShell path never honors a record without a birth identity");
  assert.doesNotMatch(powershell, /\[IO\.FileMode\]::CreateNew[^\n]*host-coordination\.lock/, "PowerShell never creates the canonical entry in place");
});

test("the canonical record carries a real per-platform birth identity that round-trips", posix, async () => {
  const f = fixture();
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const coordination = join(stateDir, generations.COORDINATION as string);
  const internals = generations.coordinationInternals as {
    ownerStartIdentity(pid: number): string;
    ownOwnerIdentity(): string;
  };
  const own = internals.ownOwnerIdentity();
  assert.match(own, /^(?:linux:[0-9a-zA-Z-]+:[0-9]+|darwin:\S.*|win32:\S.*)$/u,
    `the owner birth identity uses one exact per-platform format: ${own}`);
  assert.equal(internals.ownerStartIdentity(process.pid), own,
    "the identity computed for this pid is the one recorded for this pid");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    assert.ok(Number.isInteger(other.pid), "the foreign process is alive");
    const foreign = internals.ownerStartIdentity(other.pid as number);
    assert.match(foreign, /^(?:linux|darwin|win32):/u, "one targeted query yields the foreign pid's identity");
    assert.equal(internals.ownerStartIdentity(other.pid as number), foreign,
      "the same pid round-trips to the same birth identity");
    assert.notEqual(foreign, "darwin:Sat Jan  1 00:00:00 2000", "an unrelated birth identity is distinguishable");
  } finally {
    other.kill("SIGKILL");
  }
  // A published record therefore always carries the identity, never a bare pid.
  const lease = generations.holdAgentDirectory(f.agentDir);
  assert.ok(lease, "the launcher handoff holds the canonical entry");
  const published = readFileSync(coordination, "utf8").split("\n");
  assert.equal(published[0]!.trim(), String(process.pid));
  assert.equal(published[1]!.trim(), own, "the published record carries the owner birth identity");
  lease!.release();
  assert.equal(existsSync(coordination), false);
});

/**
 * No record without a birth identity is ever honored, on the holder path or in
 * self-adoption: empty-identity metadata naming an unrelated live pid, and a
 * record naming this very pid with a wrong birth identity, are both stale.
 */
test("pid-only and same-pid-wrong-birth records are stale metadata, never holders", posix, async () => {
  const f = fixture();
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const coordination = join(stateDir, generations.COORDINATION as string);
  const internals = generations.coordinationInternals as { ownOwnerIdentity(): string };
  const own = internals.ownOwnerIdentity();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    // (a) A live foreign pid with an EMPTY birth identity is never honored.
    const seeded = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
    writeFileSync(coordination, `${holder.pid}\n\n`, { mode: 0o600 });
    const warnings: string[] = [];
    const stage = admitStage(f, { warn: (warning: string) => warnings.push(warning) });
    assert.ok(existsSync(stage.root), "startup proceeds");
    stage.generation.release();
    assert.ok(seeded.some((root) => !existsSync(root)), "an empty-identity record was reclaimed and reclamation ran");
    assert.ok(!warnings.some((warning) => warning.includes("host ownership coordination")),
      `a pid-only record is never honored as a current holder: ${warnings.join(" | ")}`);

    // (b) A record naming THIS pid with a wrong birth identity is not self-adoption.
    writeFileSync(coordination, `${process.pid}\nlinux:stale-birth:1\n`, { mode: 0o600 });
    const lease = generations.holdAgentDirectory(f.agentDir);
    assert.ok(lease, "the stale same-pid record did not block the handoff");
    const published = readFileSync(coordination, "utf8").split("\n");
    assert.equal(published[0]!.trim(), String(process.pid));
    assert.equal(published[1]!.trim(), own, "a genuinely held record carries this process's real birth identity");
    lease!.release();
    assert.equal(existsSync(coordination), false);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("an unconfirmed Pi validation cleanup fails closed instead of re-preparing", posix, async () => {
  const f = fixture();
  const selections: string[] = [];
  let hostStarted = 0;
  const diagnostics: string[] = [];
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    resolvePiRuntime: async (options: { explicit?: string }) => {
      selections.push(String(options.explicit));
      if (selections.length === 1) return provision(f, "1.3.0");
      // The in-hold validation probe's process termination was not confirmed.
      const error = new Error("pi runtime validation probe cleanup was not confirmed") as Error & { cleanupUnconfirmed?: boolean };
      error.cleanupUnconfirmed = true;
      throw error;
    },
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: () => ({ runSessionHost: async () => { hostStarted += 1; return 0; } }),
  });
  assert.equal(status, 1, "an unconfirmed cleanup fails the launch closed");
  assert.equal(hostStarted, 0, "the host never starts over an unconfirmed validation cleanup");
  assert.equal(selections.length, 2, `no fallback resolution or provisioning is attempted: ${selections.join(" | ")}`);
  assert.match(diagnostics.join(""), /Pi runtime validation cleanup was not confirmed; preserving its runtime/u);
});

test("full startup reclaims a directory-shaped cache lock and prunes five legacy generations per type", posix, async () => {
  const f = fixture();
  const buildRoots = seedLegacy(f.builds, ["legacy-build-0", "legacy-build-1", "legacy-build-2", "legacy-build-3", "legacy-build-4"]);
  const runtimeRoots = seedLegacy(f.runtimes, ["pi-1.1.0", "pi-1.1.1", "pi-1.1.2", "pi-1.1.3", "pi-1.1.4"]);
  // Malformed non-live lock metadata at the exact cache entry: an empty
  // directory, a shape this producer never creates and no live owner can hold.
  mkdirSync(join(f.builds, ".admission.lock"));
  mkdirSync(join(f.runtimes, ".admission.lock"));
  let loadedEntry = "";
  let hostStarted = 0;
  const diagnostics: string[] = [];
  const status = await producer.runSessionHostLauncher([], {
    getEnv: () => f.env,
    processEnv: {},
    packageRoot: f.packageRoot,
    platform: "linux",
    cwd: f.root,
    nodeVersion: process.versions.node,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    build: (options: Record<string, unknown>) => build(f, options),
    resolvePiRuntime: async () => provision(f, "1.3.0"),
    ensureDdgs: () => ({ ok: true, python: join(f.root, "python") }),
    refreshShippedSkills: () => ({ ok: true }),
    writeOut: () => undefined,
    writeError: (text: string) => diagnostics.push(text),
    loadMain: (entry: string) => {
      loadedEntry = entry;
      return { runSessionHost: async () => { hostStarted += 1; return 0; } };
    },
  });
  assert.equal(status, 0, diagnostics.join(""));
  assert.equal(hostStarted, 1, "the host actually started");
  assert.ok(loadedEntry.startsWith(f.builds + "/"), `the compiled host came from the owned build cache: ${loadedEntry}`);
  assert.equal(count(f.builds), generations.LIMIT, `build cache pruned to the target: ${count(f.builds)}`);
  assert.equal(count(f.runtimes), generations.LIMIT, `Pi cache pruned to the target: ${count(f.runtimes)}`);
  assert.equal(existsSync(join(f.builds, ".admission.lock")), false, "the malformed build lock directory is gone");
  assert.equal(existsSync(join(f.runtimes, ".admission.lock")), false, "the malformed Pi lock directory is gone");
  assert.doesNotMatch(diagnostics.join(""), /cleanup lock was busy|lock artifact could not be removed|could not reclaim/i);
  assert.ok(buildRoots.some((root) => !existsSync(root)), "an actual legacy build directory was reclaimed");
  assert.ok(runtimeRoots.some((root) => !existsSync(root)), "an actual legacy Pi directory was reclaimed");
});

// ---------------------------------------------------------------------------
// #385 coordination boundary: host ownership acquisition and destructive cache
// reclamation take one canonical per-agent entry
// (`session-host/host-coordination.lock`). The scenarios below are the source
// of the startup race: a producer authorized to reclaim while a host becomes the
// owner of the same agent directory. Each one is driven through the real
// producer path with a narrow deterministic hook or a real child process; no
// outcome depends on timer luck.
// ---------------------------------------------------------------------------
const ownershipPath = (f: Fixture) => join(f.agentDir, "session-host", "host-ownership.json");
const coordinationPath = (f: Fixture) => join(f.agentDir, "session-host", generations.COORDINATION as string);
const admitStage = (f: Fixture, options: Record<string, unknown> = {}) =>
  generations.admit(f.builds, () => ({ root: mkdtempSync(join(f.builds, "pi-review-sessions-")) }), options);

function liveHostRecord(f: Fixture): void {
  mkdirSync(join(f.agentDir, "session-host"), { recursive: true, mode: 0o700 });
  writeFileSync(ownershipPath(f), JSON.stringify({ version: 1, hostId: "live-owner" }), { mode: 0o600 });
}

test("host ownership appearing during a live producer lock wait leaves that host's generations untouched", posix, () => {
  const f = fixture();
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f", "g"]);
  const lock = join(f.builds, ".admission.lock");
  // A genuinely live foreign producer holds the admission lock: this producer
  // observes the real bounded wait instead of an immediate same-process skip.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  try {
    const fs = requireCjs("node:fs") as typeof import("node:fs");
    const lstat = fs.lstatSync;
    let appeared = false;
    writeFileSync(lock, `${holder.pid}\n`, { mode: 0o600 });
    Object.defineProperty(fs, "lstatSync", {
      configurable: true,
      writable: true,
      value: (...args: Parameters<typeof lstat>) => {
        // The host becomes the owner while this producer waits for the lock.
        if (!appeared && String(args[0]) === lock) {
          appeared = true;
          liveHostRecord(f);
        }
        return Reflect.apply(lstat, fs, args);
      },
    });
    const warnings: string[] = [];
    let stage;
    try {
      stage = admitStage(f, { warn: (warning: string) => warnings.push(warning) });
    } finally {
      Object.defineProperty(fs, "lstatSync", { configurable: true, writable: true, value: lstat });
    }
    assert.equal(appeared, true, "ownership appeared during the real lock wait");
    assert.ok(existsSync(stage.root), "startup is never refused for cache capacity");
    stage.generation.release();
    assert.ok(legacy.every((root) => existsSync(root)), "the host's actual generations survive the wait");
    assert.equal(count(f.builds), legacy.length + 1, "the competing launch still created its own generation");
    assert.equal(readFileSync(lock, "utf8"), `${holder.pid}\n`, "the live foreign lock is never stolen");
    assert.ok(warnings.some((warning) => warning.includes("session host currently owns")),
      `the truthful skip is reported: ${warnings.join(" | ")}`);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("host ownership appearing during malformed-lock recovery stops reclamation after the wait", posix, () => {
  const f = fixture();
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f", "g"]);
  const lock = join(f.builds, ".admission.lock");
  mkdirSync(lock);
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const lstat = fs.lstatSync;
  let directoryObservations = 0;
  let appeared = false;
  Object.defineProperty(fs, "lstatSync", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof lstat>) => {
      const observed = Reflect.apply(lstat, fs, args);
      if (String(args[0]) === lock && observed && observed.isDirectory()) {
        directoryObservations += 1;
        // The recovery needed for a malformed non-live artifact is exactly the
        // window in which a host can become the owner.
        if (directoryObservations === 3 && !appeared) {
          appeared = true;
          liveHostRecord(f);
        }
      }
      return observed;
    },
  });
  const warnings: string[] = [];
  let stage;
  try {
    stage = admitStage(f, { warn: (warning: string) => warnings.push(warning) });
  } finally {
    Object.defineProperty(fs, "lstatSync", { configurable: true, writable: true, value: lstat });
  }
  assert.equal(appeared, true, "ownership appeared during stale/malformed lock recovery");
  assert.ok(existsSync(stage.root), "startup is never refused for cache capacity");
  stage.generation.release();
  assert.equal(existsSync(lock), false, "the malformed artifact itself was still reclaimed");
  assert.ok(legacy.every((root) => existsSync(root)), "no generation was pruned after the ownership recheck");
  assert.ok(warnings.some((warning) => warning.includes("session host currently owns")),
    `the post-wait recheck reports the skip: ${warnings.join(" | ")}`);
  assert.ok(!warnings.some((warning) => warning.includes("could not reclaim")), "nothing is reported as failed");
});

test("a host that appears mid-cleanup stops removal at the next destructive boundary", posix, () => {
  const f = fixture();
  const legacy = seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f", "g"]);
  const warnings: string[] = [];
  let appeared = false;
  const stage = admitStage(f, {
    warn: (warning: string) => warnings.push(warning),
    // Producer-path hook: it runs inside the destructive pass, after the
    // per-generation ownership recheck and before that generation is removed.
    beforeReclaim: () => {
      if (!appeared) {
        appeared = true;
        liveHostRecord(f);
      }
      return undefined;
    },
  });
  assert.equal(appeared, true, "ownership appeared after cleanup was already authorized");
  assert.ok(existsSync(stage.root), "startup still proceeds");
  stage.generation.release();
  assert.equal(existsSync(legacy[0]!), false, "the generation already authorized was reclaimed");
  assert.ok(legacy.slice(1).every((root) => existsSync(root)),
    "the remaining generations survive: removal stops at the ownership boundary");
  assert.ok(warnings.some((warning) => warning.includes("acquired the agent directory during cleanup")),
    `the boundary stop is reported truthfully: ${warnings.join(" | ")}`);
});

test("a real cleanup pass and a real host ownership acquisition never interleave", posix, async () => {
  const f = fixture();
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f", "g"]);
  const log = join(f.root, "order.log");
  writeFileSync(log, "");
  const releaseCleanup = join(f.root, "release-cleanup");
  const releaseHost = join(f.root, "release-host");
  const generationsPath = join(process.cwd(), "scripts", "managed-generations.cjs");
  const rosterStorePath = join(process.cwd(), "dist-test", "src", "session-host", "roster-store.js");
  const cleanupScript = join(f.root, "cleanup-race.cjs");
  writeFileSync(cleanupScript, [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const generations = require(${JSON.stringify(generationsPath)});`,
    `const cache = process.argv[2];`,
    `const log = process.argv[3];`,
    `const releaseFile = process.argv[4];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `let paused = false;`,
    `const stage = generations.admit(cache, () => ({ root: fs.mkdtempSync(path.join(cache, "pi-review-sessions-")) }), {`,
    `  warn: (warning) => append("warn:" + warning),`,
    `  beforeReclaim: (root) => {`,
    `    if (!paused) {`,
    `      paused = true;`,
    `      process.stdout.write("PAUSED\\n");`,
    // Hold the destructive critical section past the old short acquisition
    // bypass, then record whether any host owned the directory during the hold.
    `      const holdUntil = Date.now() + 3000;`,
    `      while (Date.now() < holdUntil) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
    `      append("ownership-during-hold:" + fs.existsSync(path.join(process.argv[5], "session-host", "host-ownership.json")));`,
    `      const deadline = Date.now() + 60000;`,
    `      while (!fs.existsSync(releaseFile) && Date.now() < deadline) {`,
    `        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
    `      }`,
    `    }`,
    `    append("reclaim:" + path.basename(root));`,
    `  },`,
    `});`,
    `append("pass-complete");`,
    `stage.generation.release();`,
    `append("cleanup-settled");`,
    ``,
  ].join("\n"), "utf8");
  const hostScript = join(f.root, "host-race.cjs");
  writeFileSync(hostScript, [
    `const fs = require("node:fs");`,
    `const { openHostState } = require(${JSON.stringify(rosterStorePath)});`,
    `const agentDir = process.argv[2];`,
    `const log = process.argv[3];`,
    `const releaseFile = process.argv[4];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `append("host-started");`,
    `append("host-acquiring");`,
    `const opened = openHostState({ agentDir, hostId: "race-host" });`,
    `append("host-result:" + opened.status);`,
    `if (opened.status !== "opened") process.exit(2);`,
    `append("host-owning");`,
    `const deadline = Date.now() + 60000;`,
    `while (!fs.existsSync(releaseFile) && Date.now() < deadline) {`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
    `}`,
    `append("host-release:" + opened.state.release());`,
    ``,
  ].join("\n"), "utf8");
  const cleanupChild = spawn(process.execPath, [cleanupScript, f.builds, log, releaseCleanup, f.agentDir], { stdio: ["ignore", "pipe", "inherit"] });
  const paused = new Promise<void>((resolve, reject) => {
    let buffered = "";
    cleanupChild.stdout!.setEncoding("utf8");
    cleanupChild.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.includes("PAUSED")) resolve();
    });
    cleanupChild.once("exit", (code) => reject(new Error(`cleanup exited before its barrier (${code})`)));
  });
  await paused;
  assert.equal(existsSync(ownershipPath(f)), false, "no host owns the agent directory while the pass is paused");
  const hostChild = spawn(process.execPath, [hostScript, f.agentDir, log, releaseHost], { stdio: ["ignore", "ignore", "inherit"] });
  const waitForLine = async (needle: string): Promise<void> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (existsSync(log) && readFileSync(log, "utf8").includes(needle)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    // The competing host reaches its ownership boundary but cannot claim the
    // directory while the authorized destructive pass holds the coordination
    // entry. The pass keeps running past the old short acquisition bypass and
    // reports whether ownership appeared during that hold.
    await waitForLine("host-acquiring");
    await waitForLine("ownership-during-hold:");
    const held = readFileSync(log, "utf8");
    assert.match(held, /ownership-during-hold:false/,
      `ownership is not claimed while a live destructive pass runs past the acquisition timeout: ${held}`);
    assert.equal(existsSync(ownershipPath(f)), false, "ownership is not claimed mid-destructive-cleanup");
    writeFileSync(releaseCleanup, "release");
    await new Promise<void>((resolve, reject) => {
      cleanupChild.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cleanup exited ${code}`))));
    });
    await waitForLine("host-owning");
    const ordered = readFileSync(log, "utf8").trim().split("\n");
    const ownershipIndex = ordered.indexOf("host-result:opened");
    assert.ok(ownershipIndex > 0, `the host actually acquired ownership: ${ordered.join(" | ")}`);
    const reclaimIndexes = ordered.map((line, index) => (line.startsWith("reclaim:") ? index : -1)).filter((index) => index >= 0);
    assert.ok(reclaimIndexes.length > 0, "the cleanup pass actually removed generations");
    assert.ok(reclaimIndexes.every((index) => index < ownershipIndex),
      `every removal precedes ownership acquisition: ${ordered.join(" | ")}`);
    assert.ok(ordered.indexOf("pass-complete") < ownershipIndex, "ownership is taken only after the pass settles");
    assert.equal(ordered.indexOf("cleanup-settled") < ownershipIndex, true);
    // A competing launch during ownership is never refused for cache capacity,
    // and every surviving generation keeps its exact filesystem identity.
    const ownedSnapshot = readdirSync(f.builds)
      .filter((name) => name !== ".admission.lock")
      .map((name) => {
        const stats = lstatSync(join(f.builds, name), { bigint: true });
        return { name, id: `${stats.dev}:${stats.ino}` };
      });
    const warnings: string[] = [];
    const competing = admitStage(f, { warn: (warning: string) => warnings.push(warning) });
    assert.ok(existsSync(competing.root), "a competing launch still starts");
    competing.generation.release();
    for (const entry of ownedSnapshot) {
      const stats = lstatSync(join(f.builds, entry.name), { bigint: true });
      assert.equal(`${stats.dev}:${stats.ino}`, entry.id,
        `the owned generation ${entry.name} keeps its identity while a session host owns the directory`);
    }
    assert.ok(warnings.some((warning) => warning.includes("session host currently owns")),
      `the existing guard is what skips cleanup: ${warnings.join(" | ")}`);
    // The host that owns the directory releases only its own record.
    writeFileSync(releaseHost, "release");
    await new Promise<void>((resolve, reject) => {
      hostChild.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`host exited ${code}`))));
    });
    assert.equal(existsSync(ownershipPath(f)), false, "the owning host released its own record");
    assert.equal(existsSync(coordinationPath(f)), false, "no coordination entry is left behind");
  } finally {
    writeFileSync(releaseCleanup, "release");
    writeFileSync(releaseHost, "release");
    cleanupChild.kill("SIGKILL");
    hostChild.kill("SIGKILL");
  }
});

test("a stale or special-leaf entry inside a designated disposable generation cannot pin it", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside-special");
  writeFileSync(outside, "outside bytes");
  const roots = seedLegacy(f.builds, ["a-special", "b", "c", "d", "e", "f"]);
  const fifo = join(roots[0]!, "nested", "fifo");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (made.status !== 0) return; // platforms without mkfifo are covered elsewhere
  const stage = admitStage(f);
  assert.ok(existsSync(stage.root), "startup is never refused for a special leaf");
  stage.generation.release();
  assert.equal(existsSync(roots[0]!), false,
    "a special leaf is unlinked with its disposable generation instead of pinning it forever");
  assert.equal(readFileSync(outside, "utf8"), "outside bytes");
  assert.ok(count(f.builds) <= generations.LIMIT);
});

/**
 * Progressive cleanup is one protocol across the four native producer paths: one
 * pass-level runtime budget, deletion as progress (never a whole-tree preflight
 * or an entry/depth quota that could refuse to delete anything), and owner
 * records that carry a pid plus a targeted birth identity so a reused pid can
 * never pin a generation. Native behaviour is exercised by the POSIX wrapper and
 * native Windows suites; this pins the shared source contract.
 */
test("every native cleanup path deletes progressively and disambiguates a reused pid", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  const cjs = read("scripts/managed-generations.cjs");
  assert.match(cjs, /const CLEANUP_BUDGET_MS = 120_000;/u, "one pass-level runtime budget");
  assert.match(cjs, /removed > 0 && performance\.now\(\) >= deadline/u,
    "the budget only stops a pass after it deleted something");
  assert.doesNotMatch(cjs, /MAX_ENTRIES|MAX_DEPTH/u, "no entry/depth quota can make a generation permanently undeletable");
  assert.match(cjs, /function ownerBirthMs\(pid\)/u, "a legacy pid-only record is judged by one targeted owner birth");
  assert.match(cjs, /return birth <= recordMtimeMs\(stat\) \+ OWNER_BIRTH_MARGIN_MS;/u,
    "a birth after the record was written is a reused pid, not a holder");
  assert.match(cjs, /function cleanup\(cacheRoot, options = \{\}\)/u, "a cleanup-only pass exists for reuse/settlement");
  assert.match(cjs, /keep\.has\(path\.resolve\(entry\.file\)\)/u, "the selected generation is never a removal candidate");

  const posix = read("scripts/node-generations.sh");
  assert.doesNotMatch(posix, /node_visit/u, "the whole-tree preflight walker is gone");
  assert.doesNotMatch(posix, /\$\{#NODE_REMOVE_PATHS\[@\]\} < 100000|depth <= 64/u, "no entry/depth quota remains");
  assert.match(posix, /NODE_CLEANUP_BUDGET=120/u, "the POSIX pass shares one runtime budget");
  assert.match(posix, /node_cleanup_running/u, "the POSIX walker is budget-checked as it deletes");
  assert.match(posix, /node_owner_birth_epoch/u, "the POSIX path judges a legacy pid-only record by owner birth");
  assert.ok(posix.includes('printf \'%s\\n%s\\n\' "$$" "$(node_owner_identity "$$")" > "$WORK_ROOT/.producer-active"'),
    "the POSIX marker carries the owner birth identity");
  assert.ok(posix.includes('printf \'%s\\n%s\\n\' "$$" "$owner" > "$NODE_LOCK"'),
    "the POSIX admission lock carries the owner birth identity");

  const powershell = read("scripts/pi-review-sessions-node.ps1");
  assert.doesNotMatch(powershell, /Depth -gt 64/u, "no depth quota remains on the native Windows walker");
  assert.match(powershell, /\$script:NodeCleanupBudgetSeconds = 120/u, "the PowerShell pass shares one runtime budget");
  assert.match(powershell, /function Test-NodeCleanupRunning/u, "the PowerShell walker is budget-checked as it deletes");
  assert.match(powershell, /function Test-NodeOwnerRecord/u, "the PowerShell path parses pid plus birth identity");
  assert.match(powershell, /NodeOwnerBirthMarginSeconds/u, "the PowerShell path applies the same birth/mtime distinction");
  assert.match(powershell, /\(Get-NodeOwnerIdentity \(\[int\]\$PID\)\) \+ "`n"/u, "the PowerShell marker carries the owner birth identity");
});

/**
 * Progressive cleanup must be measured on the shapes a real extraction produces.
 * A broad directory-only tree is the case a "collect then delete" walker can
 * spend forever on: it queues every directory, hits the budget, deletes nothing,
 * and repeats. A short budget must still delete real content here, and later
 * passes must finish it.
 */
test("a broad directory-only generation is deleted progressively instead of collecting forever", posix, () => {
  const f = fixture();
  const broad = join(f.builds, "a-dirs-only");
  for (let a = 0; a < 12; a += 1) {
    for (let b = 0; b < 12; b += 1) {
      for (let c = 0; c < 10; c += 1) mkdirSync(join(broad, `a${a}`, `b${b}`, `c${c}`), { recursive: true, mode: 0o700 });
    }
  }
  seedLegacy(f.builds, ["b", "c", "d", "e", "f"]);
  const before = countEntries(broad);
  assert.ok(before > 1400, `the fixture is really broad: ${before} entries`);
  const bounded = admitStage(f, { cleanupBudgetMs: 25 });
  assert.ok(existsSync(bounded.root));
  bounded.generation.release();
  assert.ok(existsSync(broad), "a short bounded pass stops part-way");
  assert.ok(countEntries(broad) < before, `the bounded pass already deleted whole directories: ${before} -> ${countEntries(broad)}`);
  for (let pass = 0; pass < 40 && existsSync(broad); pass += 1) generations.cleanup(f.builds, {});
  assert.equal(existsSync(broad), false, "later passes finish the directory-only generation");
  assert.ok(count(f.builds) <= generations.LIMIT);
});

/**
 * Owner birth must be read in one timezone-independent frame of reference. The
 * macOS `ps lstart` token carries no zone, so a caller-local interpretation would
 * place a genuinely live legacy producer's birth hours in the future on a non-UTC
 * host and reclaim the generation it is still filling. The child process below
 * runs with a deliberately non-UTC TZ; only its own environment is changed.
 */
test("a non-UTC child still honors a live legacy producer and still reclaims a reused pid", posix, async () => {
  const generationsPath = join(process.cwd(), "scripts", "managed-generations.cjs");
  const runChild = async (cache: string, mode: string): Promise<{ warnings: string[]; liveSurvives: boolean; tz: string }> => {
    const script = join(process.cwd(), "node_modules", `.tz-admit-${mode}-${Date.now()}.cjs`);
    writeFileSync(script, [
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const { spawn } = require("node:child_process");`,
      `const generations = require(${JSON.stringify(generationsPath)});`,
      `const cache = process.argv[2];`,
      `const mode = process.argv[3];`,
      // A live process born in this same non-UTC child environment.
      `const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });`,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);`,
      `const marker = path.join(cache, "a-live", ".producer-active");`,
      `if (mode === "identity") {`,
      `  fs.writeFileSync(marker, holder.pid + "\\n" + generations.coordinationInternals.ownerStartIdentity(holder.pid) + "\\n", { mode: 0o600 });`,
      `} else {`,
      `  fs.writeFileSync(marker, holder.pid + "\\n", { mode: 0o600 });`,
      `  if (mode === "stale") { const old = new Date(Date.now() - 3600000); fs.utimesSync(marker, old, old); }`,
      `}`,
      `const warnings = [];`,
      `const stage = generations.admit(cache, () => ({ root: fs.mkdtempSync(path.join(cache, "new-")) }), { warn: (w) => warnings.push(w) });`,
      `stage.generation.release();`,
      `process.stdout.write(JSON.stringify({ warnings, tz: String(process.env.TZ), liveSurvives: fs.existsSync(path.join(cache, "a-live")) }) + "\\n");`,
      `holder.kill("SIGKILL");`,
    ].join("\n"), "utf8");
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, cache, mode], {
        env: { ...process.env, TZ: "Pacific/Honolulu" },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("exit", (code) => {
        if (code !== 0) { reject(new Error(`tz child exited ${code}`)); return; }
        try { resolve(JSON.parse(output.trim().split("\n").filter(Boolean).pop()!)); }
        catch (error) { reject(error instanceof Error ? error : new Error("bad tz child output")); }
      });
    });
  };
  for (const mode of ["fresh", "identity"] as const) {
    const f = fixture();
    seedLegacy(f.builds, ["a-live", "b", "c", "d", "e", "f"]);
    const result = await runChild(f.builds, mode);
    assert.equal(result.tz, "Pacific/Honolulu", "the child really ran in a non-UTC timezone");
    assert.equal(result.liveSurvives, true, `${mode}: a genuinely live legacy producer's generation is preserved`);
    assert.ok(directories(f.builds).filter((name) => ["b", "c", "d", "e", "f"].includes(name)).length <= 4,
      `${mode}: cleanup still reclaimed the excess it was allowed to reclaim`);
  }
  // The same live pid recorded before it existed is a reused pid: stale.
  const stale = fixture();
  seedLegacy(stale.builds, ["a-live", "b", "c", "d", "e", "f"]);
  const staleResult = await runChild(stale.builds, "stale");
  assert.equal(staleResult.liveSurvives, false, "a reused pid stays stale in any timezone");
});

test("owner birth is read in UTC for the macOS ps token and keeps the Windows zone", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "managed-generations.cjs"), "utf8");
  assert.match(source, /env: \{ \.\.\.process\.env, TZ: "UTC0", LC_ALL: "C", LANG: "C" \}/u,
    "the targeted ps query is pinned to UTC and the C locale");
  assert.match(source, /function utcPsLstartMs\(token\)/u, "the darwin token is parsed explicitly as UTC");
  assert.match(source, /Date\.UTC\(Number\(match\[6\]\), month/u, "the parse builds a UTC instant, not a local one");
  assert.match(source, /Date\.parse\(token\.slice\("win32:"\.length\)\)/u, "the Windows token keeps its own zone");
  const host = readFileSync(join(process.cwd(), "src", "session-host", "roster-store.ts"), "utf8");
  assert.match(host, /env: \{ \.\.\.process\.env, TZ: "UTC0", LC_ALL: "C", LANG: "C" \}/u,
    "the TypeScript host publishes the same timezone-independent token");
  const posix = readFileSync(join(process.cwd(), "scripts", "node-generations.sh"), "utf8");
  assert.ok(posix.includes('output="$(TZ=UTC0 LC_ALL=C LANG=C "$NODE_PS_BIN" -p "$pid" -o lstart= 2>/dev/null)"'),
    "the POSIX wrapper publishes the same timezone-independent token");
  assert.ok(posix.includes('now="$(TZ=UTC0 "$NODE_DATE_BIN" +%s 2>/dev/null)"'),
    "the POSIX owner-birth conversion is explicitly UTC");
});

/**
 * A birth query that temporarily fails is NOT a proven mismatch. If it were
 * treated as staleness, another actor could steal a live destructive holder's
 * canonical mutex and claim ownership beside an active deletion. The contender
 * below runs with a failing birth query; it must not claim the entry, must not
 * delete the holder's selected files, and must recover once the holder settles
 * (and a real, different birth still proves a reused pid).
 */
test("a failing birth query never steals a live destructive holder's mutex mid-cleanup", posix, async () => {
  const f = fixture();
  const generationsPath = join(process.cwd(), "scripts", "managed-generations.cjs");
  const log = join(f.root, "order.log");
  writeFileSync(log, "");
  const releaseCleanup = join(f.root, "release-cleanup");
  const selected = seedLegacy(f.builds, ["a-selected"]);
  seedLegacy(f.builds, ["b", "c", "d", "e", "f", "g"]);
  const selectedBytes = readFileSync(join(selected[0]!, "nested", "legacy-output.txt"), "utf8");
  // The destructive holder pauses inside its pass (still holding the canonical
  // entry) until the parent releases it.
  const holderScript = join(f.root, "holder-cleanup.cjs");
  writeFileSync(holderScript, [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const generations = require(${JSON.stringify(generationsPath)});`,
    `const cache = process.argv[2];`,
    `const log = process.argv[3];`,
    `const releaseFile = process.argv[4];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `let paused = false;`,
    `const stage = generations.admit(cache, () => ({ root: fs.mkdtempSync(path.join(cache, "pi-review-sessions-")) }), {`,
    `  warn: (warning) => append("warn:" + warning),`,
    `  beforeReclaim: (root) => {`,
    `    if (paused) return undefined;`,
    `    paused = true;`,
    `    process.stdout.write("PAUSED\\n");`,
    `    const deadline = Date.now() + 60000;`,
    `    while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
    `    append("reclaim:" + path.basename(root));`,
    `    return undefined;`,
    `  },`,
    `});`,
    `append("pass-complete");`,
    `stage.generation.release();`,
  ].join("\n"), "utf8");
  // The contender's birth query always fails while it tries to take the entry.
  const contenderScript = join(f.root, "contender.cjs");
  writeFileSync(contenderScript, [
    `const fs = require("node:fs");`,
    `const generations = require(${JSON.stringify(generationsPath)});`,
    `const agentDir = process.argv[2];`,
    `const cache = process.argv[3];`,
    `const log = process.argv[4];`,
    `const mode = process.argv[5];`,
    `const append = (line) => fs.appendFileSync(log, line + "\\n");`,
    `if (mode === "failing") generations.coordinationInternals.setOwnerIdentityQuery(() => "");`,
    `const warnings = [];`,
    `generations.cleanup(cache, { warn: (warning) => warnings.push(warning) });`,
    `append("skip-warnings:" + (warnings.some((w) => w.includes("host ownership coordination was busy or unreadable")) ? "honest" : warnings.join("|")));`,
    `const lease = generations.holdAgentDirectory(agentDir);`,
    `append("held:" + (lease ? "yes" : "no"));`,
    `if (lease) lease.release();`,
  ].join("\n"), "utf8");
  const holder = spawn(process.execPath, [holderScript, f.builds, log, releaseCleanup], { stdio: ["ignore", "pipe", "inherit"] });
  const paused = await new Promise<void>((resolve, reject) => {
    let buffered = "";
    holder.stdout!.setEncoding("utf8");
    holder.stdout!.on("data", (chunk: string) => { buffered += chunk; if (buffered.includes("PAUSED")) resolve(); });
    holder.once("exit", (code) => reject(new Error(`the holder exited before its barrier (${code})`)));
  });
  void paused;
  const contender = spawn(process.execPath, [contenderScript, f.agentDir, f.builds, log, "failing"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const exited = new Promise<number | null>((resolve) => contender.once("exit", (code) => resolve(code)));
    // The contender may only proceed after the holder settles; a stealing
    // implementation republishes the entry immediately, so a bounded wait is
    // decisive without being any part of the product behaviour.
    const outcome = await Promise.race([exited, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 1_500))]);
    if (outcome === "running") contender.kill("SIGKILL");
    await exited;
    const duringHold = readFileSync(log, "utf8");
    assert.match(duringHold, /skip-warnings:honest/,
      `an unverifiable holder is reported honestly instead of claimed stale: ${duringHold}`);
    assert.doesNotMatch(duringHold, /held:yes/,
      "the contender never claims the canonical entry while the destructive holder is running");
    assert.ok(existsSync(selected[0]!), "the holder's selected generation was never deleted mid-pass");
    assert.equal(readFileSync(join(selected[0]!, "nested", "legacy-output.txt"), "utf8"), selectedBytes);
    const entryPath = join(f.agentDir, "session-host", generations.COORDINATION as string);
    assert.equal(readFileSync(entryPath, "utf8").split("\n")[0]!.trim(), String(holder.pid),
      "the canonical entry still names the live destructive holder");
    // Release the holder: it finishes its pass, and only then can a contender
    // take the entry (recovery once the owner is really gone, never a timer).
    writeFileSync(releaseCleanup, "release");
    await new Promise<void>((resolve, reject) => {
      holder.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`holder exited ${code}`))));
    });
    // A contender whose own identity query works again now acquires the settled
    // entry; the earlier skip was about a live holder, not a permanent lock.
    const after = spawn(process.execPath, [contenderScript, f.agentDir, f.builds, log, "real"], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      after.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`recovered contender exited ${code}`))));
    });
    const ordered = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(ordered.indexOf("pass-complete") < ordered.indexOf("held:yes"),
      `the entry is claimed only after the pass settled: ${ordered.join(" | ")}`);
    assert.equal(ordered[ordered.length - 1], "held:yes", `the settled entry is claimed: ${ordered.join(" | ")}`);
  } finally {
    writeFileSync(releaseCleanup, "release");
    holder.kill("SIGKILL");
    contender.kill("SIGKILL");
  }

  // A real, different birth identity is still proven stale: a live pid with a
  // mismatched token never blocks a new holder.
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const stateDir = join(f.agentDir, "session-host");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const entry = join(stateDir, generations.COORDINATION as string);
    rmSync(entry, { force: true });
    writeFileSync(entry, `${live.pid}\nlinux:definitely-not-this-process:1\n`, { mode: 0o600 });
    const lease = generations.holdAgentDirectory(f.agentDir);
    assert.ok(lease, "a genuinely different birth identity is reclaimed as a reused pid");
    const published = readFileSync(entry, "utf8").split("\n");
    assert.equal(published[0]!.trim(), String(process.pid));
    assert.ok((published[1] ?? "").trim().length > 0, "the new record carries this process's birth identity");
    lease!.release();
    assert.equal(existsSync(entry), false);
  } finally {
    live.kill("SIGKILL");
  }
});

/**
 * An initially failed own-birth query must not be cached forever: with the CJS
 * launcher owning a handoff, a host whose own identity query failed at load would
 * otherwise never recognize its own record, adopt it, or publish its own — it
 * would wait on itself forever. Retrying keeps a genuine outage honest (no
 * pid-only adoption) while recovering as soon as the query works again.
 */
test("an initially failed own-birth query is retried instead of deadlocking the handoff", posix, async () => {
  const f = fixture();
  const generationsPath = join(process.cwd(), "scripts", "managed-generations.cjs");
  const script = join(f.root, "own-identity-recovery.cjs");
  writeFileSync(script, [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const generations = require(${JSON.stringify(generationsPath)});`,
    `const agentDir = process.argv[2];`,
    `const internals = generations.coordinationInternals;`,
    `const restore = internals.setOwnerIdentityQuery(() => "");`,
    `const result = {};`,
    // With the identity query failing, this process must report the boundary as
    // unavailable instead of waiting on (or adopting) its own record.
    `result.duringOutage = Boolean(generations.holdAgentDirectory(agentDir));`,
    `const real = internals.ownerStartIdentity(process.pid);`,
    `fs.mkdirSync(path.join(agentDir, "session-host"), { recursive: true, mode: 0o700 });`,
    `fs.writeFileSync(path.join(agentDir, "session-host", generations.COORDINATION), process.pid + "\\n" + real + "\\n", { mode: 0o600 });`,
    `result.stillDuringOutage = Boolean(generations.holdAgentDirectory(agentDir));`,
    // The real query works again: the positive identity is learned then, never cached as empty.
    `restore();`,
    `const lease = generations.holdAgentDirectory(agentDir);`,
    `result.recovered = Boolean(lease);`,
    `const text = fs.readFileSync(path.join(agentDir, "session-host", generations.COORDINATION), "utf8");`,
    `const lines = text.split("\\n");`,
    `result.owner = lines[0].trim();`,
    `result.identity = (lines[1] || "").trim();`,
    `result.ownIdentity = internals.ownOwnerIdentity();`,
    `result.pid = process.pid;`,
    `result.entryAfterSelf = fs.readFileSync(path.join(agentDir, "session-host", generations.COORDINATION), "utf8").split("\\n")[0].trim();`,
    `if (lease) lease.release();`,
    `result.entryAfterRelease = fs.existsSync(path.join(agentDir, "session-host", generations.COORDINATION));`,
    `process.stdout.write(JSON.stringify(result) + "\\n");`,
  ].join("\n"), "utf8");
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, [script, f.agentDir], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("exit", (code) => {
      if (code !== 0) { reject(new Error(`own-identity child exited ${code}`)); return; }
      try { resolve(JSON.parse(output.trim().split("\n").filter(Boolean).pop()!) as Record<string, unknown>); }
      catch (error) { reject(error instanceof Error ? error : new Error("bad child output")); }
    });
  });
  assert.equal(result.duringOutage, false, "an unavailable own identity reports the boundary as unavailable");
  assert.equal(result.stillDuringOutage, false,
    "a record naming this live pid is never adopted pid-only and never waited on during the outage");
  assert.equal(result.recovered, true, "the handoff succeeds as soon as the birth query works again");
  assert.equal(result.owner, String(result.pid));
  assert.ok(String(result.identity).length > 0, "the published record carries a real birth identity");
  assert.equal(result.identity, result.ownIdentity, "self-adoption uses the recovered identity, not a placeholder");
  assert.equal(result.entryAfterSelf, String(result.pid),
    "the recovered hold recognizes this process's own record instead of waiting on it");
  assert.equal(result.entryAfterRelease, true,
    "the launcher's own hold is handed to the ownership claim, never silently deleted here");
});

/**
 * One mutex error-handling rule in every native path: an unverifiable birth is not
 * a proven mismatch (a live holder is honored), a real different birth is stale,
 * pid-only canonical records stay reclaimable, and a process's own identity query
 * is retried until it succeeds instead of caching the failure.
 */
test("every path treats an unverifiable birth as a possible live holder, never as staleness", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  const cjs = read("scripts/managed-generations.cjs");
  assert.match(cjs, /if \(observed === ""\) return true;/u,
    "CJS honors a live pid whose birth query failed instead of treating it as stale");
  assert.match(cjs, /function coordinationRecordIsCurrent\(record\)/u, "CJS has one shared owner-current authority");
  assert.match(cjs, /let OWN_OWNER_IDENTITY_CACHE = "";/u, "CJS caches this process's identity separately");
  assert.match(cjs, /if \(observed !== ""\) OWN_OWNER_IDENTITY_CACHE = observed;/u,
    "CJS caches only a positive own identity, never a failed query");
  assert.match(cjs, /if \(ownIdentity !== "" && record\.identity === ownIdentity\)/u,
    "CJS self-adoption requires a real matching identity, and never waits on its own pid");

  const host = read("src/session-host/roster-store.ts");
  assert.match(host, /if \(observed === ""\) return true;/u,
    "the TypeScript host honors a live pid whose birth query failed");
  assert.match(host, /let OWN_OWNER_IDENTITY_CACHE = "";/u, "the host caches its identity separately");
  assert.match(host, /if \(observed !== ""\) OWN_OWNER_IDENTITY_CACHE = observed;/u,
    "the host caches only a positive own identity");
  assert.match(host, /if \(record\.identity === ownIdentity\) return \{ status: "self" \}/u,
    "host self-adoption requires a real matching identity");

  const posix = read("scripts/node-generations.sh");
  assert.match(posix, /\[\[ -n "\$observed" \]\] \|\| return 0/u,
    "the POSIX path honors a live pid whose birth query failed");
  assert.doesNotMatch(posix, /\[\[ -n "\$observed" && "\$observed" == "\$identity" \]\]/u,
    "no POSIX path claims an unverified owner is stale");

  const powershell = read("scripts/pi-review-sessions-node.ps1");
  assert.match(powershell, /if \(\[string\]::IsNullOrEmpty\(\$observed\)\) \{ return \$true \}/u,
    "the PowerShell path honors a live pid whose birth query failed");
});

/**
 * Progressive deletion must be immediate postorder in every walker, and the
 * budget must be enforced at pass scope: no walker may spend its whole budget
 * classifying or identifying candidates before deleting anything, and no pass may
 * keep starting new candidates after it has deleted something and reached the
 * budget while the canonical mutex is still held.
 */
test("no native walker defers deletion behind a collection pass or past its budget", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  const cjs = read("scripts/managed-generations.cjs");
  assert.match(cjs, /fs\.rmdirSync\(frame\.file\);\n\s+progress\(\);/u,
    "the CJS walker removes a directory as soon as its own entries are exhausted");
  assert.match(cjs, /const state = pass && typeof pass === "object" \? pass : \{ removed: 0 \};/u,
    "CJS deletion progress is tracked at pass scope, not per remove() call");
  assert.match(cjs, /if \(pass\.removed > 0 && performance\.now\(\) >= pass\.deadline\) \{\n\s+\/\/ The pass already deleted something/u,
    "CJS stops before starting another candidate once the pass budget is spent");

  const posix = read("scripts/node-generations.sh");
  assert.match(posix, /^node_remove_dir\(\) \{$/mu, "the POSIX walker recurses in place");
  assert.match(posix, /chunk=\("\$\{subdirs\[@\]:start:NODE_CLEANUP_BATCH\}"\)/u,
    "POSIX identifies and deletes one bounded sibling batch before the next");
  assert.match(posix, /node_batch_identities "\$\{chunk\[@\]\}"/u,
    "POSIX captures identities for that batch only");
  assert.match(posix, /node_cleanup_allows_work/u,
    "POSIX grants one pass-scope progress allowance before the deadline applies");
  assert.match(posix, /NODE_CLEANUP_PROGRESS=\$\(\(NODE_CLEANUP_PROGRESS \+ 1\)\)/u,
    "POSIX records deletions at pass scope");
  assert.match(posix, /node_unlink_batch/u, "POSIX batches leaf removal instead of one process per file");
  assert.doesNotMatch(posix, /NODE_DIRS=\(\)/u, "no deferred directory queue remains");
  assert.match(posix, /node_cleanup_only\(\) \{/u, "POSIX has a producer-owned cleanup-only pass");
  assert.match(posix, /node_remove_dir "\$root" \|\| return 1\n(?:.*\n)*?  if ! node_cleanup_allows_work; then/u,
    "POSIX applies the pass-scope allowance to root removal, so an empty generation still progresses");
  assert.match(posix, /node_cleanup_only \|\| true/u,
    "POSIX retries deferred cleanup, joined, when preparation settles");
  assert.match(posix, /node_reclaim_excess \$\(\(NODE_LIMIT - 1\)\) "\$\{NODE_KEEP_ROOT:-\}" "\$NODE_LIMIT"/u,
    "the settlement pass preserves this launch's generation and targets five");

  const powershell = read("scripts/pi-review-sessions-node.ps1");
  assert.match(powershell, /immediate postorder/u, "the PowerShell walker documents immediate postorder");
  assert.match(powershell, /\$stack\.Push\(@\{ Path = \$child; Entries = \$null; Index = 0 \}\)/u,
    "PowerShell descends with an explicit frame stack, never collecting every directory first");
  assert.match(powershell, /\[IO\.Directory\]::Delete\(\$frame\.Path, \$false\)/u,
    "PowerShell removes each directory as soon as its subtree is empty");
  assert.match(powershell, /function Test-NodeCleanupAllowsWork/u,
    "PowerShell grants the same pass-scope progress allowance");
  assert.match(powershell, /\$candidateTarget = \$Target\n\s+if \(-not \[string\]::IsNullOrEmpty\(\$Keep\)\) \{ \$candidateTarget-- \}/u,
    "PowerShell subtracts the kept generation from the removable-candidate target");
  assert.match(powershell, /if \(\$count -le \$candidateTarget\) \{ break \}/u,
    "PowerShell uses an inclusive stopping condition so creation still lands at five");
  assert.match(powershell, /if \(\$held -gt \$Target\) \{/u,
    "PowerShell warns only above the total target");
  assert.match(powershell, /function Invoke-NodeSettlementCleanup/u,
    "PowerShell has a producer-owned cleanup-only settlement pass");
  assert.match(powershell, /Invoke-NodeSettlementCleanup \$cacheRoot \$agentDirectory \$WorkRoot/u,
    "PowerShell retries deferred cleanup, joined, when preparation settles");
  assert.match(powershell, /if \(\(\$script:NodeCleanupProgress -gt 0\) -and -not \(Test-NodeCleanupRunning\)\) \{/u,
    "PowerShell stops before another candidate once the pass budget is spent");
  assert.doesNotMatch(powershell, /\$directories\.Add/u, "no deferred directory list remains");
});

/**
 * One mutex error-handling rule in every native path: an unverifiable birth is not
 * a proven mismatch (a live holder is honored), a real different birth is stale,
 * pid-only canonical records stay reclaimable, and a process's own identity query
 * is retried until it succeeds instead of caching the failure.
 */
test("every path treats an unverifiable birth as a possible live holder, never as staleness", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  const cjs = read("scripts/managed-generations.cjs");
  assert.match(cjs, /if \(observed === ""\) return true;/u,
    "CJS honors a live pid whose birth query failed instead of treating it as stale");
  assert.match(cjs, /function coordinationRecordIsCurrent\(record\)/u, "CJS has one shared owner-current authority");
  assert.match(cjs, /let OWN_OWNER_IDENTITY_CACHE = "";/u, "CJS caches this process's identity separately");
  assert.match(cjs, /if \(observed !== ""\) OWN_OWNER_IDENTITY_CACHE = observed;/u,
    "CJS caches only a positive own identity, never a failed query");
  assert.match(cjs, /if \(ownIdentity !== "" && record\.identity === ownIdentity\)/u,
    "CJS self-adoption requires a real matching identity, and never waits on its own pid");

  const host = read("src/session-host/roster-store.ts");
  assert.match(host, /if \(observed === ""\) return true;/u,
    "the TypeScript host honors a live pid whose birth query failed");
  assert.match(host, /let OWN_OWNER_IDENTITY_CACHE = "";/u, "the host caches its identity separately");
  assert.match(host, /if \(observed !== ""\) OWN_OWNER_IDENTITY_CACHE = observed;/u,
    "the host caches only a positive own identity");
  assert.match(host, /if \(record\.identity === ownIdentity\) return \{ status: "self" \}/u,
    "host self-adoption requires a real matching identity");

  const posix = read("scripts/node-generations.sh");
  assert.match(posix, /\[\[ -n "\$observed" \]\] \|\| return 0/u,
    "the POSIX path honors a live pid whose birth query failed");
  assert.doesNotMatch(posix, /\[\[ -n "\$observed" && "\$observed" == "\$identity" \]\]/u,
    "no POSIX path claims an unverified owner is stale");

  const powershell = read("scripts/pi-review-sessions-node.ps1");
  assert.match(powershell, /if \(\[string\]::IsNullOrEmpty\(\$observed\)\) \{ return \$true \}/u,
    "the PowerShell path honors a live pid whose birth query failed");
});

/**
 * The pass budget must bound the whole pass, not each generation: a long run of
 * tiny candidates (empty roots, links) must stop once the pass has deleted
 * something and spent its budget, and later passes must finish the job.
 */
test("a short pass budget stops a long run of tiny generations and later passes finish", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  writeFileSync(outside, "outside bytes");
  mkdirSync(f.builds, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 60; index += 1) mkdirSync(join(f.builds, `a-${String(index).padStart(3, "0")}`), { mode: 0o700 });
  for (let index = 0; index < 20; index += 1) symlinkSync(outside, join(f.builds, `b-${String(index).padStart(3, "0")}`));
  const total = 80;
  assert.equal(countCandidates(f.builds), total);
  const first = generations.cleanup(f.builds, { cleanupBudgetMs: 1 });
  assert.equal(first.stopped, true, "the pass reports that its runtime budget stopped it");
  assert.ok(first.reclaimed >= 1, `the pass still deleted real entries: ${first.reclaimed}`);
  assert.ok(countCandidates(f.builds) > generations.LIMIT, `the pass stopped before reaching the target: ${countCandidates(f.builds)}`);
  assert.ok(countCandidates(f.builds) < total, "the pass did not process the whole run after its budget");
  for (let pass = 0; pass < total && countCandidates(f.builds) > generations.LIMIT; pass += 1) {
    generations.cleanup(f.builds, { cleanupBudgetMs: 1 });
  }
  assert.ok(countCandidates(f.builds) <= generations.LIMIT, `successive passes finish it: ${countCandidates(f.builds)}`);
  assert.equal(readFileSync(outside, "utf8"), "outside bytes", "link candidates never touch their target");
});

test("a completed Pi discovery is reused without npm-root or a version probe", posix, async () => {
  const f = fixture();
  const pkg = join(f.bin, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "1.0.4",
    bin: { pi: "cli.js" },
  }));
  writeFileSync(join(pkg, "cli.js"), [
    "#!/usr/bin/env node",
    'if (process.argv.includes("--version")) { process.stdout.write("1.0.4\\n"); process.exit(0); }',
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  symlinkSync(join(pkg, "cli.js"), join(f.bin, "pi"));
  const env = { ...f.env, PATH: f.bin };
  const spawns: Array<{ file: string; args: string[] }> = [];
  const runner = async (file: string, args: string[]) => {
    spawns.push({ file, args: args.slice() });
    return ok({ stdout: args.includes("--version") ? "1.0.4\n" : "" });
  };
  const options = {
    env,
    agentDir: f.agentDir,
    cwd: f.root,
    writeError: () => undefined,
    processRunner: runner,
  };
  const first = await producer.resolvePiRuntime(options);
  assert.equal(first.source, "path");
  assert.ok(spawns.length >= 1, "the first resolution probes the installation");
  spawns.length = 0;
  const second = await producer.resolvePiRuntime(options);
  assert.equal(second.file, first.file);
  assert.equal(spawns.length, 0, "a completed discovery performs no npm-root and no version probe");
  // A PATH change is honored without rebuilding: the cache key no longer matches.
  spawns.length = 0;
  await producer.resolvePiRuntime({ ...options, env: { ...env, PATH: `/nonexistent:${f.bin}` } });
  assert.ok(spawns.length >= 1, "an explicit PATH change falls back to full validation");
});

test("a managed Pi selection is leased under its owning cache and preserved by cleanup", posix, async () => {
  const f = fixture();
  const versionRoot = join(f.runtimes, "pi-1.3.0");
  writePi(versionRoot, "1.3.0");
  // Generations beyond the retention target so a coordinated cleanup has
  // candidates while the selected runtime must be preserved.
  const siblings: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const sibling = join(f.runtimes, `pi-1.0.${index}`);
    writePi(sibling, `1.0.${index}`);
    siblings.push(sibling);
  }
  const cli = join(versionRoot, "node_modules", "@earendil-works", "pi-coding-agent", "cli.js");
  const runner = async (file: string, args: string[]) => ok({ stdout: args.includes("--version") ? "1.3.0\n" : "" });
  const selected = await producer.resolvePiRuntime({
    explicit: cli,
    env: f.env,
    agentDir: f.agentDir,
    cwd: f.root,
    writeError: () => undefined,
    processRunner: runner,
  });
  assert.ok(selected.lease, "the selected managed runtime is leased");
  assert.equal(existsSync(versionRoot), true, "the selected runtime survives the coordinated cleanup");
  assert.ok(siblings.some((sibling) => !existsSync(sibling)), "unleased excess Pi generations are reclaimed");
  selected.lease.release();
  generations.cleanup(f.runtimes);
  assert.equal(existsSync(versionRoot), true, "releasing the lease does not delete code that nothing reclaims yet");
});

test("two complete sidebar launches perform no npm-root or version probe on the current start", posix, async () => {
  const f = fixture();
  // A public Pi package on PATH (managed by nobody: no pi-runtime cache).
  const pkg = join(f.bin, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "1.0.4",
    bin: { pi: "cli.js" },
  }));
  const piLog = join(f.root, "pi-invocations.txt");
  writeFileSync(join(pkg, "cli.js"), [
    "#!/usr/bin/env node",
    'require("node:fs").appendFileSync(' + JSON.stringify(piLog) + ', process.argv.slice(2).join(" ") + "\\n");',
    'if (process.argv.includes("--version")) { process.stdout.write("1.0.4\\n"); process.exit(0); }',
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  symlinkSync(join(pkg, "cli.js"), join(f.bin, "pi"));
  // A validating npm stand-in on PATH: the first launch may ask for its global
  // root, the current start must not.
  const npmLog = join(f.root, "npm-invocations.txt");
  const npmPkg = join(f.bin, "node_modules", "npm");
  mkdirSync(join(npmPkg, "bin"), { recursive: true });
  writeFileSync(join(npmPkg, "package.json"), JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "bin/npm-cli.js" } }));
  writeFileSync(join(npmPkg, "bin", "npm-cli.js"), [
    "#!/usr/bin/env node",
    'require("node:fs").appendFileSync(' + JSON.stringify(npmLog) + ', process.argv.slice(2).join(" ") + "\\n");',
    "process.exit(0);",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(join(npmPkg, "bin", "npm-cli.js"), 0o755);
  // PATH's npm entry must resolve into the logging package (the generic fixture
  // writes a plain file there) so the global-root query is observable.
  rmSync(join(f.bin, "npm"), { force: true });
  symlinkSync(join("node_modules", "npm", "bin", "npm-cli.js"), join(f.bin, "npm"));
  for (const entry of ["dist/src/session-host/main.js", "dist/src/index.js", "dist/src/web/cli.js"]) {
    const target = join(f.packageRoot, ...entry.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// compiled entry");
  }
  const env = { ...f.env, PATH: f.bin };
  const runOnce = async () => {
    let started = 0;
    const status = await producer.runSessionHostLauncher([], {
      getEnv: () => env,
      processEnv: {},
      platform: "linux",
      nodeVersion: process.versions.node,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      packageRoot: f.packageRoot,
      prepareApplication: (options: { agentDir: string }) => ({
        mode: "current",
        preparedRoot: f.packageRoot,
        applicationMode: "packaged",
        ddgsPython: join(f.root, "python"),
        skills: [],
        stateRoot: join(options.agentDir, ".pi-review-gate", "application"),
        lease: { release: () => undefined },
      }),
      loadMain: () => ({ runSessionHost: () => { started += 1; return 0; } }),
      writeOut: () => undefined,
      writeError: () => undefined,
    });
    return { status, started };
  };
  const first = await runOnce();
  assert.equal(first.status, 0);
  assert.equal(first.started, 1);
  const piAfterFirst = readFileSync(piLog, "utf8").trim().split("\n").length;
  assert.equal(piAfterFirst, 1, "the first launch probes the Pi version once");
  assert.match(readFileSync(npmLog, "utf8"), /root -g/u, "the first launch performs its global-root query once");

  const second = await runOnce();
  assert.equal(second.status, 0);
  assert.equal(second.started, 1);
  assert.equal(readFileSync(piLog, "utf8").trim().split("\n").length, piAfterFirst,
    "the current start performs no version probe");
  assert.equal(readFileSync(npmLog, "utf8").trim().split("\n").length, 1,
    "the current start performs no additional npm-root query");
  assert.equal(existsSync(f.runtimes), false, "an unmanaged PATH selection creates no managed runtime");
});

test("Pi provisioning admission never reclaims a concurrently leased runtime", posix, async () => {
  const f = fixture();
  const leasedRoot = join(f.runtimes, "pi-1.0.0");
  writePi(leasedRoot, "1.0.0");
  for (let index = 1; index <= 7; index += 1) writePi(join(f.runtimes, `pi-1.0.${index}`), `1.0.${index}`);
  const prepareModule = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"))("../scripts/prepare-application.cjs") as {
    attachConsumer(options: Record<string, unknown>): { release(): void } | undefined;
  };
  const stateRoot = join(f.agentDir, ".pi-review-gate", "application");
  mkdirSync(stateRoot, { recursive: true });
  const lease = prepareModule.attachConsumer({ stateRoot, agentDir: f.agentDir, preparedRoot: leasedRoot });
  assert.ok(lease);
  const result = await provision(f, "1.3.0");
  assert.equal(result.version, "1.3.0");
  assert.equal(existsSync(leasedRoot), true, "a concurrently leased runtime survives provisioning admission and settlement");
  lease.release();
});

test("a cached managed selection is revalidated inside the lease coordination", posix, async () => {
  const f = fixture();
  const versionRoot = join(f.runtimes, "pi-1.3.0");
  writePi(versionRoot, "1.3.0");
  const cli = join(versionRoot, "node_modules", "@earendil-works", "pi-coding-agent", "cli.js");
  const runner = async () => ok({ stdout: "1.3.0\n" });
  const options = {
    explicit: cli,
    env: f.env,
    agentDir: f.agentDir,
    cwd: f.root,
    writeError: () => undefined,
    processRunner: runner,
  };
  const first = await producer.resolvePiRuntime(options);
  first.lease?.release();
  const warm = await producer.resolvePiRuntime(options);
  assert.equal(warm.file, first.file, "the completed discovery is reused before the race");
  warm.lease?.release();
  const prepareModule = createRequire(join(process.cwd(), "tests", "managed-generations.test.ts"))("../scripts/prepare-application.cjs") as {
    acquireCleanupLock(stateRoot: string): Promise<{ release(): void } | null>;
  };
  const stateRoot = join(f.agentDir, ".pi-review-gate", "application");
  const lock = await prepareModule.acquireCleanupLock(stateRoot);
  assert.ok(lock, "the cleanup coordination entry is available for the test");
  const pending = producer.resolvePiRuntime(options);
  // The resolver has synchronously revalidated the cached selection and is now
  // waiting for the coordination entry; reclaim it before that entry is released.
  rmSync(versionRoot, { recursive: true, force: true });
  lock.release();
  await assert.rejects(pending, /changed before leasing/u);
});

test("Pi discovery is keyed to cwd and the current PATH resolution", posix, async () => {
  const base = mkdtempSync(join(process.cwd(), "node_modules", ".pi-discovery-"));
  const runner = async () => ok({ stdout: "1.0.4\n" });
  const writePackage = (directory: string, label: string): string => {
    const pkg = join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.0.4",
      bin: { pi: "cli.js" },
    }));
    const cli = join(pkg, "cli.js");
    writeFileSync(cli, `#!/usr/bin/env node\nprocess.exit(0); // ${label}\n`, { mode: 0o755 });
    return cli;
  };
  const agentDir = join(base, "agent");
  const dirA = join(base, "a");
  const dirB = join(base, "b");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  for (const dir of [dirA, dirB]) {
    const pkg = join(dir, "pi-bin", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.4", bin: { pi: "cli.js" } }));
    writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    mkdirSync(join(dir, "pi-bin"), { recursive: true });
  }
  // A relative --pi-executable resolves differently from different cwds.
  const resolve = (cwd: string) => producer.resolvePiRuntime({
    explicit: join("pi-bin", "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"),
    env: { ...process.env, PATH: "" },
    agentDir,
    cwd,
    writeError: () => undefined,
    processRunner: runner,
  });
  const a = await resolve(dirA);
  a.lease?.release();
  const b = await resolve(dirB);
  b.lease?.release();
  assert.equal(a.file, join(dirA, "pi-bin", "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"));
  assert.equal(b.file, join(dirB, "pi-bin", "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"),
    "a relative explicit selection is not reused across working directories");

  // Retargeting a PATH alias is visible without changing PATH or spawning npm.
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const firstCli = writePackage(join(base, "install-a"), "a");
  const secondCli = writePackage(join(base, "install-b"), "b");
  symlinkSync(firstCli, join(bin, "pi"));
  const env = { ...process.env, PATH: bin };
  const viaPath = await producer.resolvePiRuntime({ env, agentDir, cwd: base, writeError: () => undefined, processRunner: runner });
  assert.equal(viaPath.file, firstCli);
  rmSync(join(bin, "pi"), { force: true });
  symlinkSync(secondCli, join(bin, "pi"));
  const retargeted = await producer.resolvePiRuntime({ env, agentDir, cwd: base, writeError: () => undefined, processRunner: runner });
  assert.equal(retargeted.file, secondCli, "a retargeted PATH alias invalidates discovery on unchanged PATH");
});
