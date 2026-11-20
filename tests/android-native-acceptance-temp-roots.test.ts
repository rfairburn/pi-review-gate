/**
 * Focused temporary-root check for the Android acceptance fixtures.
 *
 * Both entry points used to create their roots beneath a literal `/tmp` prefix, so an
 * exported `TMPDIR` moved nothing and every fixture tree landed on one filesystem.
 * These cases run the two real entry points as subprocesses with a controlled temporary
 * environment and assert on the directories that actually appear on disk — observed
 * placement, not argument strings:
 *
 * - the owner fixture's default root parent and the evidence directory derived from it
 *   follow the configured OS temporary root;
 * - an explicit `--root` still wins, and the configured default parent is then never
 *   created at all;
 * - the device runner's default artifacts directory follows the configured root too;
 * - a configured temporary root that cannot host an allocation fails the start visibly
 *   and strands no run directory;
 * - a configured root too long for the broker's unchanged Unix-socket bound fails with
 *   the broker's own message, which is what shows the socket path is taken from the
 *   configured root rather than from a literal one.
 *
 * Scope, stated honestly: these are owner-data-root, explicit-override, runner-artifact,
 * and allocation-failure-placement checks. They do not open a content subscription and
 * the runner case stops before it spawns the owner, so the live status-socket path under
 * the configured root in a working run, and the runner-spawned owner's use of it, belong
 * to the manual no-device self-check and the real-device trace.
 *
 * No device is involved anywhere. The runner case answers the ownership probes with a
 * stub `adb` and a PATH containing nothing else, and stops at the first missing APK,
 * which is the step right after the artifacts directory is created. The listener cases
 * occupy the listener port, exactly as the startup-cleanup test does, so the fixture
 * fails its start and preserves the children's journals under its root parent.
 */

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";

/** The compiled owner fixture, which is what the device runner spawns too. */
const OWNER_ENTRY = join(__dirname, "android-native-acceptance", "owner-fixture.js");
/** The device runner is exercised from source; it is not compiled. */
const RUNNER_ENTRY = resolve(__dirname, "..", "..", "tests", "android-native-acceptance", "run-device-suite.cjs");

const BOUND_MS = 180_000;

/**
 * What the status broker appends below a socket root: `/prg-XXXXXX` from this fixture,
 * then `/prg-st-XXXXXX/s.sock` from the broker, for 32 bytes.
 */
const SOCKET_SUFFIX_BYTES = 32;
/** The broker's unchanged Unix-socket path bound, measured in bytes as the broker does. */
const MAX_SOCKET_PATH_BYTES = 103;

/** A unique `--run` token in the shape the owner fixture accepts. */
function runToken(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

/**
 * One owned, short, disk-backed temporary environment for one subprocess.
 *
 * `TMPDIR`, `TMP`, and `TEMP` all name the same configured root, so selection is the
 * configured OS temporary directory on every platform. When `onlyPath` is given it
 * replaces `PATH` outright rather than extending it, so nothing outside this test's own
 * scratch directory can be found by the subprocess.
 */
function configuredTempEnv(onlyPath: string | null): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "tr-"));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
  if (onlyPath !== null) env.PATH = onlyPath;
  return { root, env };
}

/** Fail early and legibly when even the configured root cannot host the status socket. */
function assertSocketFitsUnder(configuredRoot: string): void {
  // Measure the canonical path, exactly as the broker does: a short alias can pass a
  // length check on its unresolved form and still be rejected later.
  const canonicalRoot = realpathSync(configuredRoot);
  assert.ok(
    Buffer.byteLength(canonicalRoot, "utf8") + SOCKET_SUFFIX_BYTES <= MAX_SOCKET_PATH_BYTES,
    `the configured temporary root ${canonicalRoot} leaves no room for the owner fixture's status `
      + `socket inside the unchanged ${MAX_SOCKET_PATH_BYTES}-byte Unix-socket bound; run this test from a shorter temporary directory`,
  );
}

/** Run one fixture entry point with a controlled temporary environment. */
function runEntry(file: string, args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    env,
    timeout: BOUND_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `the fixture subprocess must be startable: ${result.error?.message ?? ""}`);
  return result;
}

/** Hold one TCP port so an owner listener cannot bind it. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** No run directory for this run may survive anywhere under the fixture's root parent. */
function assertNoRunDirectory(rootParent: string, run: string, label: string): void {
  assert.ok(existsSync(rootParent), `${label}: the explicit root parent must exist: ${rootParent}`);
  assert.deepEqual(
    readdirSync(rootParent).filter((name) => name.startsWith(`owner-${run}-`)),
    [],
    `${label}: no run directory may be left behind`,
  );
}

/**
 * A stub `adb` that answers exactly the owned-emulator identity probes the runner makes
 * and nothing else, using only an absolute interpreter and shell builtins. It is the
 * only entry on the subprocess's `PATH`, so no real device, emulator, or installed SDK
 * tool can be contacted.
 */
function writeStubAdb(binDir: string): void {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const stub = join(binDir, "adb");
  writeFileSync(stub, [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *get-state*) printf 'device\\n' ;;",
    "  *ro.kernel.qemu*) printf '1\\n' ;;",
    "  *'avd name'*) printf 'OK\\nprg_native_tmproots\\n' ;;",
    "  *'emu pid'*) printf '4242\\n' ;;",
    "  *ro.build.version.sdk*) printf '37\\n' ;;",
    "  *) printf '\\n' ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"), "utf8");
  chmodSync(stub, 0o755);
}

/**
 * Prove the subprocess really failed at the owner listener bind: the failure is a fixture
 * start failure, its cause is the held port, and nothing failed earlier under the
 * configured root. This says nothing about where the socket itself landed — that is the
 * too-long-root case below and the manual traces.
 */
function assertFailedAtTheListener(stderr: string, label: string): void {
  assert.match(stderr, /the owner fixture failed to start/, `${label}: startup must fail as a fixture failure`);
  assert.match(stderr, /the owner listener did not start/, `${label}: the held port must be the reason`);
  assert.doesNotMatch(
    stderr,
    /Unix-socket limit/,
    `${label}: startup must have reached the listener with the configured root`,
  );
}

test("the owner fixture's default root and derived evidence follow the configured temporary root", async (t) => {
  const { root, env } = configuredTempEnv(null);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Only POSIX creates a Unix socket here; a Windows broker uses a named pipe and
  // ignores the socket root entirely, so the bound applies to no Windows path.
  if (process.platform !== "win32") assertSocketFitsUnder(root);
  const held = await occupyPort();
  t.after(() => held.release());
  const run = runToken("prgtempdef");

  const result = runEntry(OWNER_ENTRY, ["--run", run, "--port", String(held.port), "--backends", "claude"], env);
  assert.notEqual(result.status, 0, "an occupied listener port must fail the run");
  assertFailedAtTheListener(result.stderr, "the default-root run");

  // The default root parent is the configured OS temporary root, and the evidence
  // directory the fixture derives from it is a child of that default.
  const defaultParent = join(resolve(root), "prg-android-owner-acceptance");
  assert.ok(existsSync(defaultParent), `the default root parent must exist under the configured root: ${defaultParent}`);
  const evidence = join(defaultParent, `evidence-${run}-failed-startup-failed`);
  assert.ok(existsSync(evidence), `the derived evidence directory must exist: ${evidence}`);
  assert.deepEqual(
    readdirSync(evidence).sort(),
    ["claude.control", "claude.journal.jsonl"],
    "the children's witness files were preserved under the configured root",
  );
  assertNoRunDirectory(defaultParent, run, "the settled default-root run");
});

test("an explicit owner root still overrides the configured temporary root", async (t) => {
  const { root, env } = configuredTempEnv(null);
  const explicitRoot = join(mkdtempSync(join(tmpdir(), "trw-")), "owner-root");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(explicitRoot, ".."), { recursive: true, force: true });
  });
  if (process.platform !== "win32") assertSocketFitsUnder(root);
  const held = await occupyPort();
  t.after(() => held.release());
  const run = runToken("prgtempown");

  const result = runEntry(
    OWNER_ENTRY,
    ["--run", run, "--port", String(held.port), "--backends", "claude", "--root", explicitRoot],
    env,
  );
  assert.notEqual(result.status, 0, "an occupied listener port must fail the run");
  assertFailedAtTheListener(result.stderr, "the explicit-root run");

  const evidence = join(resolve(explicitRoot), `evidence-${run}-failed-startup-failed`);
  assert.ok(existsSync(evidence), `the evidence directory must sit under the explicit root: ${evidence}`);
  assert.ok(
    !existsSync(join(resolve(root), "prg-android-owner-acceptance")),
    "an explicit root must replace the configured default parent entirely",
  );
});

test("the device runner's default artifacts directory follows the configured temporary root", (t) => {
  // The owned-emulator identity stub is a POSIX shell script, and the device suite
  // itself only ever runs on POSIX hosts; this is an explicit platform boundary, not a
  // tolerated failure.
  if (process.platform === "win32") return t.skip("the runner's owned-emulator identity stub is POSIX-only");
  const work = mkdtempSync(join(tmpdir(), "trw-"));
  const binDir = join(work, "bin");
  const { root, env } = configuredTempEnv(binDir);
  t.after(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  writeStubAdb(binDir);
  const missingApk = join(work, "missing-app-debug.apk");
  assert.ok(!existsSync(missingApk), "the run must stop at an APK that does not exist");

  const result = runEntry(
    RUNNER_ENTRY,
    ["--serial", "emulator-5554", "--api", "37", "--app-apk", missingApk],
    env,
  );
  assert.notEqual(result.status, 0, "the run must stop once the APK is missing");
  assert.match(result.stderr, /missing app APK/, "the failure must be the missing APK, after the artifacts root");

  const announced = /^RUN (\S+) MARKER \S+ ARTIFACTS (.+)$/m.exec(result.stdout);
  assert.ok(announced !== null, `the runner must announce its run and artifacts root: ${result.stdout}`);
  const run = announced[1]!;
  const artifacts = announced[2]!;
  const expected = join(resolve(root), `prg-android-acceptance-${run}`);
  assert.equal(resolve(artifacts), expected, "the default artifacts root must be the configured temporary root");
  assert.ok(existsSync(expected) && statSync(expected).isDirectory(), `the artifacts directory must really exist: ${expected}`);
});

test("a configured temporary root that cannot host an allocation fails visibly, strands no run directory, and never touches a shared run parent", (t) => {
  const work = mkdtempSync(join(tmpdir(), "trw-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  // `TMPDIR` names a path beneath a regular file: the run root under the explicit
  // `--root` is allocated first, then the socket allocation under the configured root
  // fails, and the run directory it already made must not be left behind.
  const blocker = join(work, "not-a-directory");
  writeFileSync(blocker, "regular file\n", "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: join(blocker, "tmp"), TMP: join(blocker, "tmp"), TEMP: join(blocker, "tmp") };
  const explicitRoot = join(work, "owner-root");
  // A run parent another fixture already created and is still using: this run may reuse
  // it, but nothing in a failed allocation may reach into it.
  const sharedSibling = join(explicitRoot, "other-run-root");
  mkdirSync(sharedSibling, { recursive: true, mode: 0o700 });
  const run = runToken("prgtempbad");

  const result = runEntry(OWNER_ENTRY, ["--run", run, "--backends", "claude", "--root", explicitRoot], env);
  assert.notEqual(result.status, 0, "an unusable configured temporary root must fail the run");
  assert.match(result.stderr, /the owner fixture failed to start/, "the failure must stay a visible fixture failure");
  assert.match(result.stderr, /mkdtemp/, `the failure must name the failed allocation: ${result.stderr}`);
  assertNoRunDirectory(explicitRoot, run, "the unusable-temporary-root run");
  assert.ok(existsSync(sharedSibling), "a run parent this call did not allocate must be left untouched");
});

test("a configured temporary root too long for the unchanged socket bound fails instead of relocating", (t) => {
  // Windows brokers use a named pipe and never touch a socket root, so this bound is a
  // POSIX-path property only.
  if (process.platform === "win32") return t.skip("the Unix-socket path bound applies to POSIX socket roots only");
  const work = mkdtempSync(join(tmpdir(), "trw-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  // Deep enough that `<configured>/prg-XXXXXX/prg-st-XXXXXX/s.sock` cannot fit the
  // broker's unchanged limit, while the explicit `--root` stays short and valid.
  const deep = join(work, "deep-temporary-root-".repeat(5));
  mkdirSync(deep, { recursive: true, mode: 0o700 });
  assert.ok(
    Buffer.byteLength(realpathSync(deep), "utf8") + SOCKET_SUFFIX_BYTES > MAX_SOCKET_PATH_BYTES,
    `the constructed root must exceed the bound: ${realpathSync(deep)}`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: deep, TMP: deep, TEMP: deep };
  const explicitRoot = join(work, "owner-root");
  const run = runToken("prgtemplong");

  const result = runEntry(OWNER_ENTRY, ["--run", run, "--backends", "claude", "--root", explicitRoot], env);
  assert.notEqual(result.status, 0, "a configured root too long for the socket bound must fail the run");
  assert.match(
    result.stderr,
    new RegExp(`the session-host status socket path exceeds the ${MAX_SOCKET_PATH_BYTES}-byte OS Unix-socket limit`),
    `the broker's own limit must fire on the configured root, never a fallback to another root: ${result.stderr}`,
  );
  assertNoRunDirectory(explicitRoot, run, "the too-long-temporary-root run");
  // The socket directory this fixture allocated under the configured root is its own to
  // remove, and it must not linger there.
  assert.deepEqual(
    readdirSync(resolve(deep)).filter((name) => name.startsWith("prg-")),
    [],
    "the allocated socket root under the configured temporary root must be removed",
  );
});
