import assert from "node:assert/strict";
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, lstatSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_REVIEW_GATE_CONFIG_JSON,
  MAX_PROFILE_CONFIG_BYTES,
  PROFILE_MUTABLE_CONFIG_FILENAMES,
  NativeAgentRegistry,
  ProfileRegistry,
  defaultProfileStateRoot,
  initializeProfileDirectory,
  nativePiAgentDir,
} from "../src/session-host/profiles";
import { PI_AGENT_DIR_ENV, piAgentDir } from "../src/config-path";

/** Unique synthetic test root inside this worker tree, with Unicode and spaces. */
function makeTestRoot(label: string): string {
  // Realpath so expectations match canonical prepared paths on macOS (/var -> /private/var).
  return realpathSync(mkdtempSync(join(process.cwd(), `.prg-session-host-${label}- ünïcode-`)));
}

function writeConfig(dir: string, content: string, filename = "review-gate.json"): string {
  const path = join(dir, filename);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

function enabledConfig(): string {
  return JSON.stringify({ enabled: true });
}

function tryReadFileSync(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined; // unreadable owned entries are compared by mode only
  }
}

function snapshotTree(dir: string): Map<string, { mode: number; bytes?: Buffer }> {
  const snapshot = new Map<string, { mode: number; bytes?: Buffer }>();
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Traversal-time prune: never descend into directories named .terraform
      // (global search-scope rule applies to owned synthetic test roots too).
      if (entry.isDirectory() && entry.name === ".terraform") {
        continue;
      }
      const path = join(current, entry.name);
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        snapshot.set(`${key}/`, { mode: lstatSync(path).mode & 0o777 });
        visit(path, key);
      } else if (entry.isSymbolicLink()) {
        // Records the link target text (no following on dangling links).
        snapshot.set(key, { mode: lstatSync(path).mode & 0o777, bytes: Buffer.from(readlinkSync(path), "utf8") });
      } else {
        snapshot.set(key, {
          mode: lstatSync(path).mode & 0o777,
          // Unreadable (e.g. chmod 000) owned entries are recorded by mode
          // only; contents equality still holds when both snapshots agree.
          bytes: tryReadFileSync(path),
        });
      }
    }
  };
  visit(dir, "");
  return snapshot;
}

function assertTreesEqual(before: Map<string, { mode: number; bytes?: Buffer }>, dir: string): void {
  assert.deepEqual(snapshotTree(dir), before);
}

function expectError(fn: () => unknown, ...substrings: string[]): Error {
  let threw: unknown;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  assert.ok(threw instanceof Error, "expected the operation to reject");
  const error = threw as Error;
  for (const substring of substrings) {
    assert.ok(
      error.message.includes(substring),
      `expected diagnostic to contain ${JSON.stringify(substring)}, got: ${error.message}`,
    );
  }
  return error;
}

interface OwnedFixtureFile {
  path: string;
  dev: bigint;
  ino: bigint;
}

function ownedFixtureFileFromPath(path: string): OwnedFixtureFile {
  const stats = lstatSync(path, { bigint: true });
  assert.ok(stats.isFile(), `expected owned fixture file ${path} to be regular`);
  return { path, dev: stats.dev, ino: stats.ino };
}

function ownedFixtureFileFromDescriptor(path: string, fd: number): OwnedFixtureFile {
  const stats = fs.fstatSync(fd, { bigint: true });
  assert.ok(stats.isFile(), `expected owned fixture descriptor for ${path} to be regular`);
  return { path, dev: stats.dev, ino: stats.ino };
}

function removeOwnedFixtureFile(file: OwnedFixtureFile | undefined): void {
  if (file === undefined) return;
  try {
    const current = lstatSync(file.path, { bigint: true });
    if (current.isFile() && current.dev === file.dev && current.ino === file.ino) {
      unlinkSync(file.path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeEmptyFixtureDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

/** Remove only positively identified fixture files, then known empty directories; unexpected entries survive. */
function cleanupNativeTempTestRoot(root: string, ownedFiles: Array<OwnedFixtureFile | undefined>): void {
  for (const file of ownedFiles) removeOwnedFixtureFile(file);
  for (const directory of [
    join(root, "home", ".pi", "agent"),
    join(root, "home", ".pi"),
    join(root, "home"),
    join(root, "workspace"),
    root,
  ]) {
    removeEmptyFixtureDirectory(directory);
  }
}

test("default profile state root follows the native Pi agent directory", () => {
  const env = { HOME: "/synthetic-home", [PI_AGENT_DIR_ENV]: "/custom agent dir" };
  assert.equal(defaultProfileStateRoot(env), join(piAgentDir(env), "session-host"));
  assert.equal(defaultProfileStateRoot({ HOME: "/synthetic-home" }), join("/synthetic-home", ".pi", "agent", "session-host"));
});

test("NativeAgentRegistry admits simultaneous children against one untouched native root", () => {
  const root = makeTestRoot("native-shared");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  try {
    writeConfig(agentDir, JSON.stringify({ enabled: true, marker: "preserve-native-config" }));
    for (const [filename, content] of [
      ["settings.json", "{\"theme\":\"native\"}\n"],
      ["keybindings.json", "{\"bindings\":[]}\n"],
      ["models.json", "{\"models\":[\"native-model\"]}\n"],
      ["mcp.json", "{\"servers\":{}}\n"],
      ["auth.json", "synthetic-fixture-credential\n"],
    ]) {
      writeConfig(agentDir, content, filename);
    }
    const extension = join(agentDir, "extensions", "native-extension.js");
    const skill = join(agentDir, "skills", "native-skill", "SKILL.md");
    const session = join(agentDir, "sessions", "native-session.jsonl");
    mkdirSync(dirname(extension), { recursive: true });
    mkdirSync(dirname(skill), { recursive: true });
    mkdirSync(dirname(session), { recursive: true });
    writeFileSync(extension, "synthetic extension\n", "utf8");
    writeFileSync(skill, "synthetic skill\n", "utf8");
    writeFileSync(session, "synthetic saved conversation\n", "utf8");

    const before = snapshotTree(agentDir);
    const env = { HOME: home, [PI_AGENT_DIR_ENV]: agentDir };
    assert.equal(nativePiAgentDir({ HOME: home, [PI_AGENT_DIR_ENV]: "~/.pi/agent" }), realpathSync(agentDir));
    const registry = new NativeAgentRegistry({ env });
    // Admissions must keep using Main's captured environment even if the
    // source object later changes (or process.env contains another override).
    env[PI_AGENT_DIR_ENV] = join(root, "unrelated-agent-dir");

    const first = registry.prepare({ workspace: workspaceA });
    const second = registry.prepare({ workspace: workspaceB });
    assert.equal(first.agentDir, realpathSync(agentDir));
    assert.equal(second.agentDir, first.agentDir, "simultaneous children intentionally share native setup");
    assert.equal(first.created, false);
    assert.equal(second.created, false);
    assert.notEqual(first.workspace, second.workspace, "workspace ownership remains independent");
    assertTreesEqual(before, agentDir);

    first.release();
    first.release();
    assertTreesEqual(before, agentDir);
    second.release();
    assertTreesEqual(before, agentDir);
    expectError(() => registry.prepare({ workspace: workspaceA, profile: join(root, "legacy-profile") }), "per-instance profiles are not supported");
    expectError(() => registry.prepare({ workspace: agentDir }), "must not be the workspace");
    assertTreesEqual(before, agentDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NativeAgentRegistry preserves native config fallback and initializes only an absent default", () => {
  const root = makeTestRoot("native-defaults");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace);
  try {
    const fallback = join(home, ".config", "pi-review-gate", "config.json");
    mkdirSync(dirname(fallback), { recursive: true });
    const fallbackBytes = Buffer.from(JSON.stringify({ enabled: false, marker: "fallback" }));
    writeFileSync(fallback, fallbackBytes);
    const withFallback = new NativeAgentRegistry({ env: { HOME: home, [PI_AGENT_DIR_ENV]: agentDir } });
    const adopted = withFallback.prepare({ workspace });
    assert.equal(readFileSync(fallback).equals(fallbackBytes), true);
    assert.equal(fs.existsSync(join(agentDir, "review-gate.json")), false, "a native default does not shadow the existing fallback");
    adopted.release();

    rmSync(fallback);
    const withoutConfig = new NativeAgentRegistry({ env: { HOME: home } });
    assert.equal(withoutConfig.agentDir, realpathSync(agentDir), "the default is the snapshotted home/.pi/agent root");
    const initialized = withoutConfig.prepare({ workspace });
    const primary = join(agentDir, "review-gate.json");
    assert.equal(readFileSync(primary, "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
    assert.equal(statSync(primary).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(agentDir), ["review-gate.json"], "successful publication removes its owned temporary file");
    initialized.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native default temp collision preserves the unknown file and its permissions", (t) => {
  const root = makeTestRoot("native-temp-collision");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace);
  const primary = join(agentDir, "review-gate.json");
  const unknownBytes = Buffer.from("unknown collided temporary file\n", "utf8");
  let collisionPath: string | undefined;
  let collisionMode: number | undefined;
  let collisionFile: OwnedFixtureFile | undefined;
  const originalOpenSync = fs.openSync.bind(fs) as (
    path: fs.PathOrFileDescriptor,
    flags?: string | number,
    mode?: fs.Mode,
  ) => number;
  const originalWriteSync = fs.writeSync.bind(fs);
  const originalCloseSync = fs.closeSync.bind(fs);
  try {
    t.mock.method(
      fs,
      "openSync",
      ((path: fs.PathOrFileDescriptor, flags?: string | number, mode?: fs.Mode): number => {
        if (
          typeof path === "string" &&
          path.startsWith(join(agentDir, ".review-gate.json.")) &&
          path.endsWith(".tmp") &&
          flags === "wx" &&
          collisionPath === undefined
        ) {
          collisionPath = path;
          const fd = originalOpenSync(path, "wx", 0o640);
          originalWriteSync(fd, unknownBytes, 0, unknownBytes.length, 0);
          originalCloseSync(fd);
          chmodSync(path, 0o640);
          collisionMode = statSync(path).mode & 0o777;
          collisionFile = ownedFixtureFileFromPath(path);
        }
        return originalOpenSync(path, flags as string | number | undefined, mode as fs.Mode | undefined);
      }) as unknown as typeof fs.openSync,
    );

    const registry = new NativeAgentRegistry({ env: { HOME: join(root, "home") } });
    expectError(() => registry.prepare({ workspace }), "could not initialize absent native review-gate config", "(EEXIST)");
    assert.ok(collisionPath !== undefined, "the exclusive-open collision was exercised");
    assert.equal(readFileSync(collisionPath).equals(unknownBytes), true, "unknown bytes survive the collision");
    assert.equal(statSync(collisionPath).mode & 0o777, collisionMode, "unknown permissions survive the collision");
    assert.equal(fs.existsSync(primary), false, "a collided temporary file is never published");
  } finally {
    t.mock.restoreAll();
    cleanupNativeTempTestRoot(root, [collisionFile]);
  }
});

test("native default replacement is neither published nor removed", (t) => {
  const root = makeTestRoot("native-temp-replaced");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace);
  const primary = join(agentDir, "review-gate.json");
  const replacementBytes = Buffer.from("replacement file supplied during initialization\n", "utf8");
  const displacedOwnedFile = join(root, "displaced-owned-temporary.tmp");
  let temporaryPath: string | undefined;
  let ownedTemporaryFile: OwnedFixtureFile | undefined;
  let replacementFile: OwnedFixtureFile | undefined;
  let replacementMode: number | undefined;
  let replaced = false;
  const originalOpenSync = fs.openSync.bind(fs) as (
    path: fs.PathOrFileDescriptor,
    flags?: string | number,
    mode?: fs.Mode,
  ) => number;
  const originalWriteSync = fs.writeSync.bind(fs);
  const originalCloseSync = fs.closeSync.bind(fs);
  try {
    t.mock.method(
      fs,
      "openSync",
      ((path: fs.PathOrFileDescriptor, flags?: string | number, mode?: fs.Mode): number => {
        if (
          typeof path === "string" &&
          path.startsWith(join(agentDir, ".review-gate.json.")) &&
          path.endsWith(".tmp") &&
          flags === "wx"
        ) {
          temporaryPath = path;
          const fd = originalOpenSync(path, flags, mode);
          ownedTemporaryFile = ownedFixtureFileFromDescriptor(path, fd);
          return fd;
        }
        return originalOpenSync(path, flags as string | number | undefined, mode as fs.Mode | undefined);
      }) as unknown as typeof fs.openSync,
    );
    t.mock.method(
      fs,
      "writeSync",
      ((fd: number, buffer: Buffer, offset: number, length: number, position: number): number => {
        const count = originalWriteSync(fd, buffer, offset, length, position);
        if (!replaced) {
          assert.ok(temporaryPath !== undefined, "the owned temporary path was captured before writing");
          assert.ok(ownedTemporaryFile !== undefined, "the created temporary file identity was captured");
          renameSync(temporaryPath, displacedOwnedFile);
          ownedTemporaryFile = { ...ownedTemporaryFile, path: displacedOwnedFile };
          const replacementFd = originalOpenSync(temporaryPath, "wx", 0o644);
          originalWriteSync(replacementFd, replacementBytes, 0, replacementBytes.length, 0);
          originalCloseSync(replacementFd);
          chmodSync(temporaryPath, 0o644);
          replacementMode = statSync(temporaryPath).mode & 0o777;
          replacementFile = ownedFixtureFileFromPath(temporaryPath);
          replaced = true;
        }
        return count;
      }) as unknown as typeof fs.writeSync,
    );

    const registry = new NativeAgentRegistry({ env: { HOME: join(root, "home") } });
    expectError(() => registry.prepare({ workspace }), "could not initialize absent native review-gate config", "(ESTALE)");
    assert.equal(replaced, true, "the pathname was replaced after exclusive creation");
    assert.ok(temporaryPath !== undefined);
    assert.equal(readFileSync(temporaryPath).equals(replacementBytes), true, "replacement bytes survive failed publication and cleanup");
    assert.equal(statSync(temporaryPath).mode & 0o777, replacementMode, "replacement permissions are unchanged");
    assert.equal(readFileSync(displacedOwnedFile, "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
    assert.equal(fs.existsSync(primary), false, "the replaced pathname is not published");
  } finally {
    t.mock.restoreAll();
    cleanupNativeTempTestRoot(root, [ownedTemporaryFile, replacementFile]);
  }
});

test("native default failed writes clean only the owned temporary file and retain the write error", (t) => {
  const root = makeTestRoot("native-temp-write-failure");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace);
  const primary = join(agentDir, "review-gate.json");
  let temporaryPath: string | undefined;
  let ownedTemporaryFile: OwnedFixtureFile | undefined;
  const originalOpenSync = fs.openSync.bind(fs) as (
    path: fs.PathOrFileDescriptor,
    flags?: string | number,
    mode?: fs.Mode,
  ) => number;
  const originalWriteSync = fs.writeSync.bind(fs);
  try {
    t.mock.method(
      fs,
      "openSync",
      ((path: fs.PathOrFileDescriptor, flags?: string | number, mode?: fs.Mode): number => {
        if (
          typeof path === "string" &&
          path.startsWith(join(agentDir, ".review-gate.json.")) &&
          path.endsWith(".tmp") &&
          flags === "wx"
        ) {
          temporaryPath = path;
          const fd = originalOpenSync(path, flags, mode);
          ownedTemporaryFile = ownedFixtureFileFromDescriptor(path, fd);
          return fd;
        }
        return originalOpenSync(path, flags as string | number | undefined, mode as fs.Mode | undefined);
      }) as unknown as typeof fs.openSync,
    );
    t.mock.method(
      fs,
      "writeSync",
      ((fd: number, buffer: Buffer, offset: number, length: number, position: number): number => {
        originalWriteSync(fd, buffer, offset, Math.min(length, 8), position);
        throw Object.assign(new Error("controlled native default write failure"), { code: "EIO" });
      }) as unknown as typeof fs.writeSync,
    );

    const registry = new NativeAgentRegistry({ env: { HOME: join(root, "home") } });
    expectError(() => registry.prepare({ workspace }), "could not initialize absent native review-gate config", "(EIO)");
    assert.ok(temporaryPath !== undefined, "the created temporary pathname was captured");
    assert.equal(fs.existsSync(temporaryPath), false, "the owned failed-write temporary file is cleaned");
    assert.equal(fs.existsSync(primary), false, "a failed write is not published");
  } finally {
    t.mock.restoreAll();
    cleanupNativeTempTestRoot(root, [ownedTemporaryFile]);
  }
});

test("native default concurrent primary creation remains no-clobber", (t) => {
  const root = makeTestRoot("native-primary-race");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace);
  const primary = join(agentDir, "review-gate.json");
  const concurrentBytes = Buffer.from("{\"enabled\":false,\"owner\":\"concurrent-launch\"}\n", "utf8");
  let concurrentMode: number | undefined;
  let concurrentFile: OwnedFixtureFile | undefined;
  const originalLinkSync = fs.linkSync.bind(fs);
  try {
    t.mock.method(
      fs,
      "linkSync",
      ((existingPath: fs.PathLike, newPath: fs.PathLike): void => {
        if (newPath === primary) {
          writeFileSync(primary, concurrentBytes, { mode: 0o640 });
          concurrentMode = statSync(primary).mode & 0o777;
          concurrentFile = ownedFixtureFileFromPath(primary);
        }
        originalLinkSync(existingPath, newPath);
      }) as unknown as typeof fs.linkSync,
    );

    const registry = new NativeAgentRegistry({ env: { HOME: join(root, "home") } });
    const prepared = registry.prepare({ workspace });
    assert.equal(readFileSync(primary).equals(concurrentBytes), true, "the concurrent primary is preserved byte-for-byte");
    assert.equal(statSync(primary).mode & 0o777, concurrentMode, "the concurrent primary permissions are preserved");
    assert.deepEqual(readdirSync(agentDir), ["review-gate.json"], "the owned losing temporary file is removed");
    prepared.release();
  } finally {
    t.mock.restoreAll();
    cleanupNativeTempTestRoot(root, [concurrentFile]);
  }
});

test("prepare creates a private profile with the byte-exact zero-model default config", () => {
  const root = makeTestRoot("created");
  const workspace = join(root, "workspace dir");
  mkdirSync(workspace);
  const before = snapshotTree(workspace);
  try {
    // The state root itself is not pre-created; the module must create its own
    // private subtree without touching unrelated siblings.
    const sentinel = join(root, "unrelated sibling.txt");
    writeFileSync(sentinel, "unrelated", "utf8");

    const registry = new ProfileRegistry({ stateRoot: join(root, "state root") });
    const prepared = registry.prepare({ workspace });

    assert.equal(prepared.created, true);
    assert.equal(prepared.workspace, resolve(workspace));
    assert.ok(prepared.agentDir.startsWith(join(root, "state root", "profiles", "session-host-")));

    // Private permissions: the profile directory is 0700, the config 0600.
    assert.equal(statSync(prepared.agentDir).mode & 0o777, 0o700);
    const configPath = join(prepared.agentDir, "review-gate.json");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    // Byte-exact documented native defaults, still enabled.
    assert.equal(readFileSync(configPath, "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      enabled: boolean;
      review: { activeReviewers: unknown[] };
      externalAgents: Record<string, unknown>;
      execution: { workerResources: Record<string, unknown>; routes: { execute: string[]; research: string[] } };
    };
    assert.equal(parsed.enabled, true);
    assert.deepEqual(parsed.review.activeReviewers, []);
    assert.deepEqual(parsed.externalAgents, {});
    assert.deepEqual(parsed.execution, { workerResources: {}, routes: { execute: [], research: [] } });

    // Only the config is initialized; no settings/keybindings/models/mcp/auth
    // files copied or symlinked, the workspace keeps exactly its prior
    // content (config resolution never depends on the launching cwd), and
    // unrelated siblings of the new state tree are untouched.
    assert.deepEqual(readdirSync(prepared.agentDir), ["review-gate.json"]);
    assertTreesEqual(before, workspace);
    assert.equal(readFileSync(sentinel, "utf8"), "unrelated");

    // Admission is per-instance state: profiles persist after release.
    prepared.release();
    assert.equal(readFileSync(configPath, "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("created default config bytes match the standalone launcher's documented defaults", () => {
  // dist-test/tests/session-host-profiles.test.js -> repository root.
  const launcher = readFileSync(join(__dirname, "..", "..", "scripts", "pi-review-gate.sh"), "utf8");
  assert.ok(
    launcher.includes(DEFAULT_REVIEW_GATE_CONFIG_JSON),
    "session-host default config must stay identical to scripts/pi-review-gate.sh zero-model defaults",
  );
});

test("existing supplied profile is adopted untouched, including unknown fields and auth files", () => {
  const root = makeTestRoot("supplied");
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  mkdirSync(workspace);
  mkdirSync(profile);
  try {
    writeConfig(
      profile,
      JSON.stringify({
        enabled: true,
        review: { activeReviewers: [{ source: "external", id: "custom" }] },
        externalAgents: {},
        execution: { workerResources: {}, routes: { execute: ["x"], research: [] } },
        customNativeField: { note: "user-owned", nested: [1, 2] },
      }),
    );
    writeConfig(profile, JSON.stringify({ theme: "dark" }), "settings.json");
    writeConfig(profile, JSON.stringify("sk-do-not-copy-secret"), "auth.json");

    const before = snapshotTree(profile);
    const beforeWorkspace = snapshotTree(workspace);

    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    const prepared = registry.prepare({ workspace, profile });

    assert.equal(prepared.created, false);
    assert.equal(prepared.agentDir, resolve(profile));
    assertTreesEqual(before, profile);
    assertTreesEqual(beforeWorkspace, workspace);
    prepared.release();
    assertTreesEqual(before, profile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace acceptance: tilde expansion, relative paths, and canonical directories", () => {
  const root = makeTestRoot("paths");
  try {
    const workspace = join(root, "a dir space");
    mkdirSync(workspace);
    const profile = join(root, "profile");
    mkdirSync(profile);
    writeConfig(profile, enabledConfig());
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });

    // Relative path resolves against the process working directory.
    const relativeWorkspace = relative(process.cwd(), workspace);
    const viaRelative = registry.prepare({ workspace: relativeWorkspace });
    assert.equal(viaRelative.workspace, resolve(workspace));
    viaRelative.release();

    // Bare tilde resolves against a synthetic home wholly inside this test root.
    const syntheticHome = join(root, "synthetic-home");
    mkdirSync(syntheticHome);
    const priorHome = process.env.HOME;
    const priorUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = syntheticHome;
      process.env.USERPROFILE = syntheticHome;
      const viaTilde = registry.prepare({ workspace: "~" });
      assert.equal(viaTilde.workspace, realpathSync(syntheticHome));
      viaTilde.release();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = priorUserProfile;
    }

    // A symlinked workspace canonicalizes to its real directory.
    const link = join(root, "workspace-link");
    symlinkSync(workspace, link, "dir");
    const viaSymlink = registry.prepare({ workspace: link, profile });
    assert.equal(viaSymlink.workspace, resolve(workspace));
    viaSymlink.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace and profile rejections before any launch", () => {
  const root = makeTestRoot("rejects");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });

    // Missing workspace / not a directory.
    expectError(
      () => registry.prepare({ workspace: join(root, "missing-dir") }),
      "does not exist",
      resolve(root, "missing-dir"),
    );
    const notDirectory = join(root, "not-a-directory.txt");
    writeFileSync(notDirectory, "file, not dir", "utf8");
    expectError(() => registry.prepare({ workspace: notDirectory }), "is not a directory", notDirectory);

    // Missing profile directory.
    expectError(
      () => registry.prepare({ workspace, profile: join(root, "no-such-profile") }),
      "does not exist",
      "no-such-profile",
    );

    // Profile state directory must never be the workspace.
    expectError(
      () => registry.prepare({ workspace, profile: workspace }),
      "must not be the workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supplied profile requires a local parseable JSON-object review-gate.json", () => {
  const root = makeTestRoot("config-required");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });

    const missing = join(root, "missing-config");
    mkdirSync(missing);
    expectError(
      () => registry.prepare({ workspace, profile: missing }),
      join(missing, "review-gate.json"),
      "shared external configuration",
    );

    const malformed = join(root, "malformed-config");
    mkdirSync(malformed);
    writeConfig(malformed, "{ not json");
    expectError(
      () => registry.prepare({ workspace, profile: malformed }),
      join(malformed, "review-gate.json"),
      "does not contain a valid JSON object",
    );

    const isArray = join(root, "array-config");
    mkdirSync(isArray);
    writeConfig(isArray, "[]");
    expectError(
      () => registry.prepare({ workspace, profile: isArray }),
      join(isArray, "review-gate.json"),
      "does not contain a JSON object",
    );

    // A giant config is refused with a path-level diagnostic that does not
    // expose the file's contents.
    const giant = join(root, "giant-config");
    mkdirSync(giant);
    writeConfig(giant, `{"padding":"${"x".repeat(MAX_PROFILE_CONFIG_BYTES + 16)}"}`);
    const error = expectError(
      () => registry.prepare({ workspace, profile: giant }),
      join(giant, "review-gate.json"),
      `${MAX_PROFILE_CONFIG_BYTES}-byte`,
    );
    assert.ok(!error.message.includes("padding"), "diagnostics must not expose config values");
    assert.ok(!error.message.includes("xxxxx"), "diagnostics must not expose config values");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active profiles reject shared mutable config files via symlinks and hardlinks", () => {
  const root = makeTestRoot("aliases");
  try {
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const profileA = join(root, "profile-a");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    mkdirSync(profileA);

    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    const configA = writeConfig(profileA, JSON.stringify({ enabled: true, shared: "marker" }));
    writeConfig(profileA, JSON.stringify({ theme: "shared" }), "settings.json");

    const first = registry.prepare({ workspace: workspaceA, profile: profileA });
    assert.equal(first.agentDir, resolve(profileA));

    // Symlink alias: settings.json of a second profile points at profile A's.
    const profileSymlink = join(root, "profile-symlink");
    mkdirSync(profileSymlink);
    writeConfig(profileSymlink, enabledConfig());
    symlinkSync(join(profileA, "settings.json"), join(profileSymlink, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileSymlink }),
      "settings.json",
      profileSymlink,
      profileA,
    );

    // Hardlink alias on the review-gate config itself.
    const profileHardlink = join(root, "profile-hardlink");
    mkdirSync(profileHardlink);
    linkSync(configA, join(profileHardlink, "review-gate.json"));
    writeConfig(profileHardlink, JSON.stringify({ theme: "own" }), "settings.json");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileHardlink }),
      "review-gate.json",
      profileHardlink,
      profileA,
    );

    // The same profile directory twice (via a symlinked spelling) is rejected
    // while active.
    const profileAliasLink = join(root, "profile-a-alias");
    symlinkSync(profileA, profileAliasLink, "dir");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileAliasLink }),
      "already has an active admission",
      profileA,
    );

    // After release, the same profile directory is reusable and no longer
    // aliases anything, so all previously rejected admissions now pass.
    first.release();
    const reuse = registry.prepare({ workspace: workspaceB, profile: profileSymlink });
    assert.equal(reuse.agentDir, resolve(profileSymlink));
    reuse.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-filename aliases are rejected: candidate settings.json against active review-gate.json", () => {
  const root = makeTestRoot("cross-alias");
  try {
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const profileA = join(root, "profile-a");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    mkdirSync(profileA);

    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    writeConfig(profileA, enabledConfig());
    const first = registry.prepare({ workspace: workspaceA, profile: profileA });

    // Candidate review-gate.json is its own JSON object, but its settings.json
    // is an alias of profile A's review-gate.json: file names must not defeat
    // the independence check.
    const profileB = join(root, "profile-b");
    mkdirSync(profileB);
    writeConfig(profileB, enabledConfig());
    symlinkSync(join(profileA, "review-gate.json"), join(profileB, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileB }),
      "settings.json",
      "review-gate.json",
      profileB,
      profileA,
    );
    first.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identities are refreshed: a settings.json created in an active profile cannot be aliased", () => {
  const root = makeTestRoot("late-file");
  try {
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const profileA = join(root, "profile-a");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    mkdirSync(profileA);

    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    writeConfig(profileA, enabledConfig());
    const first = registry.prepare({ workspace: workspaceA, profile: profileA });

    // The optional file appears only after A's admission (Pi may create it
    // while the instance runs).
    const latePath = join(profileA, "settings.json");
    writeConfig(profileA, JSON.stringify({ theme: "late" }), "settings.json");

    // A second profile aliasing that late file must be rejected even though
    // A's cached identity map predates it.
    const profileB = join(root, "profile-b");
    mkdirSync(profileB);
    writeConfig(profileB, enabledConfig());
    symlinkSync(latePath, join(profileB, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileB }),
      "settings.json",
      profileB,
      profileA,
    );
    first.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identities are refreshed: an atomically replaced active config file cannot be aliased", () => {
  const root = makeTestRoot("replace");
  try {
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const profileA = join(root, "profile-a");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    mkdirSync(profileA);

    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    writeConfig(profileA, enabledConfig());
    const settingsPath = writeConfig(profileA, JSON.stringify({ theme: "before" }), "settings.json");
    const first = registry.prepare({ workspace: workspaceA, profile: profileA });

    // Atomic replacement: a new file is written elsewhere and renamed over
    // the existing settings.json while A is active.
    const replacementPath = join(root, "replacement.json");
    writeFileSync(replacementPath, JSON.stringify({ theme: "after" }), { encoding: "utf8", mode: 0o600 });
    renameSync(replacementPath, settingsPath);

    const profileB = join(root, "profile-b");
    mkdirSync(profileB);
    writeConfig(profileB, enabledConfig());
    symlinkSync(settingsPath, join(profileB, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace: workspaceB, profile: profileB }),
      "settings.json",
      profileB,
      profileA,
    );
    first.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state roots are resolved through symlinks before anything is created", () => {
  const root = makeTestRoot("state-symlink");
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const registry = new ProfileRegistry({ stateRoot: join(root, "out-of-tree-state") });

    // A symlinked state root outside the workspace is accepted and canonicalizes.
    const realState = join(root, "real-state");
    mkdirSync(realState);
    symlinkSync(realState, join(root, "out-of-tree-state"), "dir");
    const prepared = registry.prepare({ workspace });
    assert.ok(prepared.agentDir.startsWith(join(realState, "profiles", "session-host-")));
    assert.ok(statSync(prepared.agentDir).isDirectory());
    prepared.release();

    // A state root resolving INTO the workspace is rejected before anything
    // is created inside the workspace.
    const innerState = join(workspace, "inner-state");
    mkdirSync(innerState);
    symlinkSync(innerState, join(root, "in-workspace-state"), "dir");
    const beforeWorkspace = snapshotTree(workspace);
    const inWorkspaceRegistry = new ProfileRegistry({ stateRoot: join(root, "in-workspace-state") });
    expectError(
      () => inWorkspaceRegistry.prepare({ workspace }),
      "must never be the workspace",
    );
    assertTreesEqual(beforeWorkspace, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace children '..state' and '..\\state' stay inside the workspace containment check", () => {
  const root = makeTestRoot("dotdot-state");
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    // A child directory whose name starts with ".." is a workspace child, not
    // traversal: generated state rooted there must be rejected. On POSIX a
    // backslash is an ordinary filename character, so "..\\state" is also a
    // (perfectly valid) workspace child.
    const names = process.platform === "win32" ? ["..state"] : ["..state", "..\\state"];
    for (const name of names) {
      const stateRoot = join(workspace, name);
      const beforeWorkspace = snapshotTree(workspace);
      const registry = new ProfileRegistry({ stateRoot });
      expectError(
        () => registry.prepare({ workspace }),
        "must never be the workspace",
        join(stateRoot, "profiles"),
      );
      assertTreesEqual(beforeWorkspace, workspace);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creation never touches unrelated files when the profiles root cannot be created", () => {
  const root = makeTestRoot("broken-root");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const sentinel = join(root, "unrelated sentinel.txt");
    writeFileSync(sentinel, "unrelated", "utf8");

    // The state root itself is a regular file: mkdir fails, nothing is created.
    const stateRootFile = join(root, "state-root-not-dir");
    writeFileSync(stateRootFile, "not a directory", "utf8");
    const registryFile = new ProfileRegistry({ stateRoot: stateRootFile });
    expectError(
      () => registryFile.prepare({ workspace }),
      "could not use or create the generated profiles directory",
      stateRootFile,
    );
    assert.equal(readFileSync(sentinel, "utf8"), "unrelated");
    assert.equal(readFileSync(stateRootFile, "utf8"), "not a directory");

    // The profiles root occupies the path as a regular file: creating the
    // generated profiles directory is refused instead of replaced or
    // traversed, and a sentinel sibling inside the state root stays untouched.
    const stateRoot = join(root, "state-root");
    mkdirSync(stateRoot);
    writeFileSync(join(stateRoot, "profiles"), "occupying", "utf8");
    const siblingSentinel = join(stateRoot, "sibling.txt");
    writeFileSync(siblingSentinel, "unrelated", "utf8");
    const registryOccupied = new ProfileRegistry({ stateRoot });
    expectError(
      () => registryOccupied.prepare({ workspace }),
      "could not use or create the generated profiles directory",
      join(stateRoot, "profiles"),
    );
    assert.deepEqual(readdirSync(stateRoot), ["profiles", "sibling.txt"]);
    assert.equal(readFileSync(siblingSentinel, "utf8"), "unrelated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated profiles directory inside the workspace is rejected", () => {
  const root = makeTestRoot("state-in-workspace");
  try {
    const registry = new ProfileRegistry({ stateRoot: root });
    expectError(
      () => registry.prepare({ workspace: root }),
      "must never be the workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initializeProfileDirectory refuses overwrite and preserves unknown files on failure", () => {
  const root = makeTestRoot("init");
  try {
    // Pre-existing config and sentinel: the config is never clobbered and
    // unknown files are preserved (the directory stays when not empty).
    const owned = join(root, "pre-existing");
    mkdirSync(owned);
    writeConfig(owned, `{"enabled":true,"userOwned":"marker"}`);
    writeFileSync(join(owned, "unknown.txt"), "unrelated", "utf8");
    const mode = statSync(join(owned, "review-gate.json")).mode & 0o777;
    expectError(() => initializeProfileDirectory(owned), "could not initialize", owned);
    assert.equal(readFileSync(join(owned, "review-gate.json"), "utf8"), `{"enabled":true,"userOwned":"marker"}`);
    assert.equal(statSync(join(owned, "review-gate.json")).mode & 0o777, mode);
    assert.equal(readFileSync(join(owned, "unknown.txt"), "utf8"), "unrelated");
    assert.ok(statSync(owned).isDirectory());

    // A failed creation in a positively-owned fresh directory (config path
    // occupied by a directory) never force-removes the unknown config path:
    // the sentinel survives and the directory is preserved.
    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    mkdirSync(join(occupied, "review-gate.json"));
    writeFileSync(join(occupied, "unknown.txt"), "unrelated", "utf8");
    expectError(() => initializeProfileDirectory(occupied), "could not initialize", occupied);
    assert.ok(statSync(join(occupied, "review-gate.json")).isDirectory());
    assert.equal(readFileSync(join(occupied, "unknown.txt"), "utf8"), "unrelated");
    assert.ok(statSync(occupied).isDirectory());

    // Success path in a fresh, positively-created mode context.
    const fresh = join(root, "fresh-profile");
    mkdirSync(fresh);
    initializeProfileDirectory(fresh);
    assert.equal(readFileSync(join(fresh, "review-gate.json"), "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
    assert.equal(statSync(join(fresh, "review-gate.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization write returning zero bytes fails closed without spinning", (t) => {
  const root = makeTestRoot("zero-write");
  try {
    const profile = join(root, "profile");
    mkdirSync(profile);
    writeFileSync(join(profile, "unknown.txt"), "unrelated", "utf8");
    // Controlled production-path zero-write: every writeSync on the open
    // config descriptor returns 0. Without the guard this would spin
    // forever; it must instead report a truthful EIO-like diagnostic and
    // preserve the failed profile without any cleanup.
    t.mock.method(fs, "writeSync", () => 0);
    expectError(
      () => initializeProfileDirectory(profile),
      "EIO",
      "returned 0 bytes",
      "no cleanup was attempted",
      profile,
    );
    // The created-but-empty config stays exactly as the failed write left it:
    // preserved, never removed, and unknown entries are untouched.
    const configStats = fs.statSync(join(profile, "review-gate.json"));
    assert.ok(configStats.isFile());
    assert.equal(configStats.mode & 0o777, 0o600);
    assert.equal(configStats.size, 0);
    assert.equal(readFileSync(join(profile, "unknown.txt"), "utf8"), "unrelated");
  } finally {
    t.mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization failure preserves a concurrently substituted config symlink", (t) => {
  const root = makeTestRoot("failed-write");
  try {
    const profile = join(root, "profile");
    mkdirSync(profile);
    const config = join(profile, "review-gate.json");
    const original = join(root, "original-config.json");
    writeFileSync(join(profile, "unknown.txt"), "unrelated", "utf8");
    // Controlled production-path write failure: while the initialization
    // call is mid-write, another actor moves the created config away and
    // substitutes the pathname with a symlink to that moved inode.
    t.mock.method(fs, "writeSync", () => {
      renameSync(config, original);
      symlinkSync(original, config, "file");
      throw Object.assign(new Error("controlled write failure"), { code: "EIO" });
    });
    expectError(() => initializeProfileDirectory(profile), "EIO", "no cleanup was attempted", profile);
    // The substituted entry and everything the concurrent actor supplied
    // survives: failed profiles are preserved, never cleaned.
    assert.ok(fs.lstatSync(config).isSymbolicLink());
    assert.equal(fs.readlinkSync(config), original);
    assert.equal(readFileSync(join(profile, "unknown.txt"), "utf8"), "unrelated");
    assert.ok(statSync(original).isFile());
  } finally {
    t.mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent optional settings files are fine; release is idempotent and state persists", () => {
  const root = makeTestRoot("release");
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    const first = registry.prepare({ workspace });
    first.release();
    first.release(); // idempotent

    // Re-admission of a created profile as a supplied one works, and the
    // generated files still exist untouched after release.
    const again = registry.prepare({ workspace, profile: first.agentDir });
    assert.equal(again.agentDir, first.agentDir);
    assert.equal(again.created, false);
    // Optional mutable config files beyond review-gate.json are not needed.
    for (const filename of PROFILE_MUTABLE_CONFIG_FILENAMES.slice(1)) {
      assert.ok(!statSync(join(first.agentDir, filename), { throwIfNoEntry: false }));
    }
    assert.equal(readFileSync(join(first.agentDir, "review-gate.json"), "utf8"), DEFAULT_REVIEW_GATE_CONFIG_JSON);
    again.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("present-but-unusable optional config entries fail closed; truly absent stays fine", (t) => {
  const root = makeTestRoot("unusable-entries");
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });

    const buildProfile = (name: string): string => {
      const profile = join(root, name);
      mkdirSync(profile);
      writeConfig(profile, enabledConfig());
      return profile;
    };

    const missingTarget = join(root, "no-such-shared-target");
    // Two dangling settings.json symlinks to the SAME missing target would
    // couple both profiles on first write; admission must already fail for
    // the first one instead of treating the entry as absent.
    const danglingA = buildProfile("dangling-a");
    symlinkSync(missingTarget, join(danglingA, "settings.json"), "file");
    const danglingBeforeA = snapshotTree(danglingA);
    expectError(
      () => registry.prepare({ workspace, profile: danglingA }),
      join(danglingA, "settings.json"),
      "symlink to a missing or unreadable target",
    );
    assertTreesEqual(danglingBeforeA, danglingA);

    const danglingB = buildProfile("dangling-b");
    symlinkSync(missingTarget, join(danglingB, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace, profile: danglingB }),
      join(danglingB, "settings.json"),
      "symlink to a missing or unreadable target",
    );

    // Cyclic symlink: present, resolvable by lstat, unusable.
    const cyclic = buildProfile("cyclic");
    symlinkSync(join(cyclic, "settings.json"), join(cyclic, "settings.json"), "file");
    expectError(
      () => registry.prepare({ workspace, profile: cyclic }),
      join(cyclic, "settings.json"),
      "refusing to admit a profile with an unusable config file",
    );

    // Present non-regular optional entry (directory named settings.json).
    const nonRegular = buildProfile("non-regular");
    mkdirSync(join(nonRegular, "settings.json"));
    expectError(
      () => registry.prepare({ workspace, profile: nonRegular }),
      join(nonRegular, "settings.json"),
      "is present but is not a regular file",
    );

    // Unreadable optional entry, exercised in every environment (including
    // as root, where real file modes are ignored) via a controlled fs error
    // on the owned fixture's settings.json pathname.
    {
      const controlled = buildProfile("mock-unreadable");
      const settingsPath = writeConfig(controlled, JSON.stringify({ theme: "owned" }), "settings.json");
      const controlledBefore = snapshotTree(controlled);
      const originalOpenSync = fs.openSync.bind(fs) as (
        path: fs.PathOrFileDescriptor,
        flags?: string | number,
        mode?: fs.Mode,
      ) => number;
      const openMock = t.mock.method(
        fs,
        "openSync",
        ((path: fs.PathOrFileDescriptor, flags?: string | number, mode?: fs.Mode): number => {
          if (path === settingsPath) {
            throw Object.assign(new Error("controlled EACCES"), { code: "EACCES" });
          }
          return originalOpenSync(path, flags as string | number | undefined, mode as fs.Mode | undefined);
        }) as unknown as typeof fs.openSync,
      );
      try {
        expectError(
          () => registry.prepare({ workspace, profile: controlled }),
          settingsPath,
          "(EACCES)",
          "refusing to admit a profile with an unusable config file",
        );
      } finally {
        // Restore before post-prepare assertions: readFileSync routes through
        // the same module-object openSync on current Node, so a still-active
        // mock would corrupt the untouched-input snapshot.
        openMock.mock.restore();
      }
      assertTreesEqual(controlledBefore, controlled);
    }

    // The same rejection via a real permission error where the platform
    // honors file modes (root ignores them, so that environment is excluded
    // from this variant rather than producing a dishonest negative).
    if (process.getuid?.() !== 0) {
      const unreadable = buildProfile("unreadable");
      writeConfig(unreadable, JSON.stringify({ theme: "owned" }), "settings.json");
      const settingsPath = join(unreadable, "settings.json");
      chmodSync(settingsPath, 0o000);
      const unreadableBefore = snapshotTree(unreadable);
      expectError(
        () => registry.prepare({ workspace, profile: unreadable }),
        settingsPath,
        "not a readable regular file",
      );
      assertTreesEqual(unreadableBefore, unreadable);
    }

    // A valid, independently aliased-but-not-active profile still admits:
    // truly absent optional files remain fine.
    const plain = buildProfile("plain");
    const admitted = registry.prepare({ workspace, profile: plain });
    assert.equal(admitted.agentDir, resolve(plain));
    admitted.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FIFO config pathnames are rejected without blocking via the nonblocking bounded read", (t) => {
  const root = makeTestRoot("fifo");
  try {
    const workspace = join(root, "workspace");
    const profile = join(root, "profile");
    mkdirSync(workspace);
    mkdirSync(profile);
    // The required review-gate.json pathname itself is the FIFO fixture: no
    // regular file is pre-created at that path (mkfifo would fail otherwise).
    try {
      execFileSync("mkfifo", [join(profile, "review-gate.json")], { stdio: "ignore" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Honest capability skip: no POSIX FIFO creation available here (this
        // is a platform-capability boundary, not a hidden test failure).
        t.skip("mkfifo is not available on this platform");
        return;
      }
      throw error; // fixture problems must fail loudly, never hide as skips
    }

    // Opening a FIFO read-only without O_NONBLOCK would park until a writer
    // appears; the descriptor-based path must reject it immediately and
    // without hanging.
    const registry = new ProfileRegistry({ stateRoot: join(root, "state") });
    expectError(
      () => registry.prepare({ workspace, profile }),
      join(profile, "review-gate.json"),
      "is not a regular file",
    );
    assert.ok(fs.lstatSync(join(profile, "review-gate.json")).isFIFO());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot tree helper prunes .terraform directories at traversal time", () => {
  const root = makeTestRoot("terraform-prune");
  try {
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, ".terraform", "providers"), { recursive: true });
    writeFileSync(join(workspace, ".terraform", "providers", "big.bin"), "synthetic-terraform-payload", "utf8");
    writeFileSync(join(workspace, "ordinary.txt"), "ordinary", "utf8");

    const snapshot = snapshotTree(workspace);
    assert.ok(!snapshot.has(".terraform/"), ".terraform must be pruned before descending");
    assert.ok(!snapshot.has(".terraform/providers/"), ".terraform must be pruned before descending");
    assert.ok(snapshot.has("ordinary.txt"), "unrelated files are still recorded");
    assert.ok(statSync(join(workspace, ".terraform")).isDirectory(), "the owned synthetic fixture itself is untouched");
    assert.equal(readFileSync(join(workspace, ".terraform", "providers", "big.bin"), "utf8"), "synthetic-terraform-payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
