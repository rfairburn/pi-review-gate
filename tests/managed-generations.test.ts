import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";

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
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
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
      mkdirSync(join(o.cwd, "dist/src/session-host"), { recursive: true });
      writeFileSync(join(o.cwd, "dist/src/session-host/main.js"), "// output");
      return ok();
    },
    ...extra,
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

test("cleanup is confined: outside sentinels survive while links and .terraform content are removed without following them", posix, () => {
  const f = fixture();
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "outside data");
  const linked = seedLegacy(f.builds, ["a-link"]);
  symlinkSync(outside, join(linked[0]!, "outside-link"));
  const terraform = seedLegacy(f.builds, ["b-terraform"]);
  mkdirSync(join(terraform[0]!, ".terraform"));
  writeFileSync(join(terraform[0]!, ".terraform", "sentinel"), "never entered");
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
  assert.equal(existsSync(terraform[0]!), false,
    "cleanup-specific traversal removes an initialized .terraform subtree inside a selected disposable generation");
  assert.equal(existsSync(join(terraform[0]!, ".terraform", "sentinel")), false);
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

test("real development producer reclaims excess legacy generations and reuses validated output", posix, async () => {
  const f = fixture();
  const outside = join(f.root, "outside"); writeFileSync(outside, "sentinel");
  seedLegacy(f.builds, ["a", "b", "c", "d", "e", "f"]);
  const result = await build(f);
  assert.equal(result.status, 0, result.diagnostics);
  assert.ok(result.stagingRoot.startsWith(f.builds + "/"));
  assert.ok(count(f.builds) <= generations.LIMIT, `actual build cache is bounded: ${count(f.builds)}`);
  assert.ok(directories(f.builds).filter((name) => name.startsWith("a")).length === 0, "legacy generations were actually removed");
  assert.equal(readFileSync(outside, "utf8"), "sentinel");
  const reused = await build(f);
  assert.equal(reused.cacheHit, true);
  assert.equal(reused.stagingRoot, result.stagingRoot);
  const changed = await build(f, { forceFresh: true });
  assert.equal(changed.status, 0);
  assert.notEqual(changed.stagingRoot, result.stagingRoot);
  assert.ok(count(f.builds) <= generations.LIMIT);
  assert.ok(existsSync(changed.stagingRoot));
});

test("compatible reuse performs no cache inventory or cleanup", posix, async () => {
  const f = fixture();
  const original = await build(f);
  const fs = requireCjs("node:fs") as typeof import("node:fs");
  const opendir = fs.opendirSync;
  let inventories = 0;
  Object.defineProperty(fs, "opendirSync", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof opendir>) => {
      if (String(args[0]) === f.builds) { inventories += 1; throw new Error("reuse must not inventory generations"); }
      return Reflect.apply(opendir, fs, args);
    },
  });
  let reused;
  try { reused = await build(f); } finally { fs.opendirSync = opendir; }
  assert.equal(reused.cacheHit, true);
  assert.equal(reused.stagingRoot, original.stagingRoot);
  assert.equal(inventories, 0);
  assert.equal(count(f.builds), 1);
});

test("legacy prepared-build reuse keeps freshness authority without any receipt", posix, async () => {
  const f = fixture();
  seedLegacy(f.builds, ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"]);
  const first = await build(f);
  assert.equal(first.status, 0);
  // Simulate a legacy generation that never had a lifetime receipt: reuse is
  // decided by the producer's own manifest/record validation.
  assert.equal(existsSync(join(first.stagingRoot, ".generation.json")), false);
  const legacyReuse = await build(f);
  assert.equal(legacyReuse.cacheHit, true);
  assert.equal(legacyReuse.stagingRoot, first.stagingRoot);
  assert.ok(producer.validateSourceBuildArtifact(legacyReuse.stagingRoot, {
    cacheKey: legacyReuse.cacheKey,
    sourceFingerprint: legacyReuse.sourceFingerprint,
    toolchainFingerprint: legacyReuse.toolchainFingerprint,
  }, legacyReuse.cacheParentChain));
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
    const result = await build(f, { forceFresh: true, runNpm: async () => ok({ status: 1, timedOut: true }) });
    assert.equal(result.status, 124);
    assert.ok(count(f.builds) <= generations.LIMIT, `failed build residue stays bounded: ${count(f.builds)}`);
  }
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
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.diagnostics).join("\n"));
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
  assert.equal((await first).status, 0);
  // The lock owner has settled; a third cleanup now runs while the second
  // producer is still filling its generation.
  const third = start("third");
  assert.ok(stages.third, "the third producer was admitted");
  assert.ok(existsSync(stages.second!), "cleanup skips the live producer's generation");
  settles.find((settle) => settle.name === "second")!.resolve();
  settles.find((settle) => settle.name === "third")!.resolve();
  const results = await Promise.all([second, third]);
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.diagnostics).join("\n"));
  assert.ok(existsSync(stages.second!), "the staggered setup completed without losing its generation");
  assert.ok(count(f.builds) <= generations.LIMIT);
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
  assert.ok(firstDiagnostics.some((line) => line.includes("cache retains 8 generations")),
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
