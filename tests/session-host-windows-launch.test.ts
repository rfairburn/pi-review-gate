import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  MAX_NATIVE_NODE_OPTIONS_BYTES,
  NODE_OPTIONS_RESTORE_ENV,
  RUNTIME_ROLE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  VERSION_PROBE_MAX_BYTES,
  VERSION_PROBE_TIMEOUT_MS,
  prepareNativeLaunch,
  resolveNativePi,
} from "../src/session-host/launch";
import {
  admitSavedSession,
  listSavedSessions,
  SavedSessionAdmission,
} from "../src/session-host/saved-sessions";

const REAL_PLATFORM = process.platform;
const PRIVATE_ROOT = join(process.cwd(), "node_modules", ".worker-private-winlaunch");

type Identity = { dev: bigint; ino: bigint };

interface OwnedFixture {
  root: string;
  directories: Map<string, Identity>;
  files: Map<string, Identity>;
  cleanupEligible: boolean;
  directory(...parts: string[]): string;
  file(path: string, contents: string | Buffer): string;
  trackChildFile(path: string): void;
  complete(): void;
  cleanup(): void;
}

function identity(path: string): Identity {
  const stats = lstatSync(path, { bigint: true });
  assert.equal(stats.isSymbolicLink(), false, `owned fixture path must not be a symlink: ${path}`);
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(path: string, expected: Identity): boolean {
  const stats = lstatSync(path, { bigint: true });
  return !stats.isSymbolicLink() && stats.dev === expected.dev && stats.ino === expected.ino;
}

function ensurePrivateRoot(): void {
  const nodeModules = join(process.cwd(), "node_modules");
  const modulesStats = lstatSync(nodeModules);
  assert.equal(modulesStats.isDirectory(), true, "the owned ignored node_modules root must be a real directory");
  assert.equal(modulesStats.isSymbolicLink(), false, "fixture storage must not traverse a node_modules symlink");
  try {
    mkdirSync(PRIVATE_ROOT, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const privateStats = lstatSync(PRIVATE_ROOT);
  assert.equal(privateStats.isDirectory(), true, "private fixture storage must be a real directory");
  assert.equal(privateStats.isSymbolicLink(), false, "private fixture storage must not be a symlink");
  if (REAL_PLATFORM !== "win32") {
    assert.equal(privateStats.mode & 0o077, 0, "private fixture storage must remain owner-only");
  }
}

function makeFixture(): OwnedFixture {
  ensurePrivateRoot();
  const root = mkdtempSync(join(PRIVATE_ROOT, "component-"));
  const directories = new Map<string, Identity>([[root, identity(root)]]);
  const files = new Map<string, Identity>();
  let cleanupEligible = false;
  return {
    root,
    directories,
    files,
    get cleanupEligible() {
      return cleanupEligible;
    },
    set cleanupEligible(value: boolean) {
      cleanupEligible = value;
    },
    directory(...parts: string[]): string {
      let current = root;
      for (const part of parts) {
        current = join(current, part);
        if (!directories.has(current)) {
          mkdirSync(current, { mode: 0o700 });
          directories.set(current, identity(current));
        }
      }
      return current;
    },
    file(path: string, contents: string | Buffer): string {
      writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
      files.set(path, identity(path));
      return path;
    },
    trackChildFile(path: string): void {
      files.set(path, identity(path));
    },
    complete(): void {
      cleanupEligible = true;
    },
    cleanup(): void {
      if (!cleanupEligible) return; // failed witnesses are retained for diagnosis
      for (const [path, expected] of files) {
        if (!sameIdentity(path, expected)) throw new Error(`refusing to clean a changed fixture file: ${path}`);
        unlinkSync(path);
      }
      const dirs = [...directories.entries()].sort((left, right) => right[0].length - left[0].length);
      for (const [path, expected] of dirs) {
        if (!sameIdentity(path, expected)) throw new Error(`refusing to clean a changed fixture directory: ${path}`);
        rmdirSync(path); // unknown contents fail rather than being recursively removed
      }
    },
  };
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  if (!previous) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...previous, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", previous);
  }
}

/** Simulate the win32 launch branch while keeping test fixture paths host-native. */
function withWindowsLaunchPlatform<T>(run: () => T): T {
  const configPath = require("../src/config-path") as {
    resolveConfigPathResolution: (resolution?: Partial<{ homeDir: string; platform: NodeJS.Platform }>) => { homeDir: string; platform: NodeJS.Platform };
  };
  const original = configPath.resolveConfigPathResolution;
  const hostPaths = (resolution?: Partial<{ homeDir: string; platform: NodeJS.Platform }>) =>
    original({ ...resolution, platform: REAL_PLATFORM });
  if (!Reflect.set(configPath, "resolveConfigPathResolution", hostPaths)) {
    throw new Error("could not preserve host-native fixture path resolution");
  }
  try {
    return withPlatform("win32", run);
  } finally {
    Reflect.set(configPath, "resolveConfigPathResolution", original);
  }
}

interface SpawnObservation {
  command: string;
  args: string[];
  shell: unknown;
  timeout: unknown;
  maxBuffer: unknown;
  envNames: string[];
}

function withSpawnObservation<T>(run: (observations: SpawnObservation[]) => T): T {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const original = childProcess.spawnSync as (...args: unknown[]) => unknown;
  const observations: SpawnObservation[] = [];
  const wrapped = (...args: unknown[]): unknown => {
    const [command, argv, options] = args as [string, string[], Record<string, unknown>];
    observations.push({
      command,
      args: [...argv],
      shell: options.shell,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      envNames: Object.keys((options.env ?? {}) as NodeJS.ProcessEnv).sort(),
    });
    return original(...args);
  };
  if (!Reflect.set(childProcess, "spawnSync", wrapped)) throw new Error("could not observe the native version probe spawn");
  try {
    return run(observations);
  } finally {
    Reflect.set(childProcess, "spawnSync", original);
  }
}

interface LaunchFixture {
  packageRoot: string;
  agentDir: string;
  workspace: string;
  cli: string;
}

function makeLaunchFixture(fixture: OwnedFixture, options: { strangePackagePath?: boolean } = {}): LaunchFixture {
  const packageName = options.strangePackagePath
    ? REAL_PLATFORM === "win32" ? "package with spaces" : 'package with spaces \\ and "quotes"'
    : "package";
  const packageRoot = fixture.directory(packageName);
  const packageSessionHost = fixture.directory(packageName, "dist", "src", "session-host");
  const agentDir = fixture.directory("home", ".pi", "agent");
  const workspace = fixture.directory("workspace");
  const bin = fixture.directory("bin");
  const cli = join(bin, "pi");
  fixture.file(cli, "#!/usr/bin/env node\nprocess.stdout.write(\"pi 1.0.4\\n\");\n");
  // Readable is sufficient under Windows policy; intentionally omit X_OK.
  chmodSync(cli, 0o600);
  fixture.file(join(packageRoot, "dist", "src", "index.js"), "// synthetic extension\n");
  fixture.file(join(packageSessionHost, "reporter.js"), "// synthetic reporter\n");
  fixture.file(join(packageSessionHost, "bootstrap-preload.js"), "// synthetic preload\n");
  return { packageRoot, agentDir, workspace, cli };
}

function nativeEnv(fixture: OwnedFixture, launch: LaunchFixture): NodeJS.ProcessEnv {
  const tempDir = fixture.directory("tmp");
  return {
    HOME: join(fixture.root, "home"),
    PATH: process.env.PATH,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    PI_CODING_AGENT_DIR: launch.agentDir,
  };
}

async function admittedSession(fixture: OwnedFixture, launch: LaunchFixture): Promise<{ file: string; admission: SavedSessionAdmission }> {
  const projectDir = fixture.directory("home", ".pi", "agent", "sessions", "project");
  const file = fixture.file(join(projectDir, "conversation.jsonl"), `${JSON.stringify({ type: "session", id: "saved-1", cwd: launch.workspace })}\n`);
  const catalog = await listSavedSessions({
    agentDir: launch.agentDir,
    listAll: async () => [{ path: file, id: "saved-1", cwd: launch.workspace }],
  });
  const result = admitSavedSession(catalog, catalog.rows[0]);
  assert.equal(result.status, "admitted");
  if (result.status !== "admitted") throw new Error("synthetic saved session did not admit");
  return { file: result.admission.file, admission: result.admission };
}

test("simulated win32 resolver uses readable JS, exact PATH names, and a bounded Node-host probe", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const firstBin = fixture.directory("path-first");
  const firstCmd = join(firstBin, "pi.cmd");
  fixture.file(firstCmd, "#!/bin/sh\nexit 0\n");
  const firstExe = join(firstBin, "pi.exe");
  fixture.file(firstExe, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  const secondBin = fixture.directory("path-second");
  const candidate = join(secondBin, "pi");
  const capturePath = join(fixture.root, "probe-capture.json");
  fixture.file(candidate, [
    "#!/usr/bin/env node",
    `require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(1), nodeOptions: process.env.NODE_OPTIONS, bootstrap: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP, restore: process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE, settlement: process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET, quiescence: process.env.PI_REVIEW_GATE_QUIESCENCE_SECRET }));`,
    'process.stdout.write("pi 1.0.4\\n");',
    "",
  ].join("\n"));
  chmodSync(candidate, 0o600);
  assert.equal(lstatSync(candidate).mode & 0o111, 0, "the Windows-admitted JS CLI has no POSIX execute bits");

  withSpawnObservation((observations) => withPlatform("win32", () => {
    const result = resolveNativePi({
      executable: "pi",
      env: {
        Path: `${firstBin};${secondBin}`,
        node_options: "--no-warnings",
        TMPDIR: fixture.directory("tmp"),
        TMP: fixture.directory("tmp"),
        TEMP: fixture.directory("tmp"),
        [SESSION_HOST_BOOTSTRAP_ENV]: "stale-bootstrap",
        [SESSION_HOST_BOOTSTRAP_ENV.toLowerCase()]: "conflicting-stale-bootstrap",
        [NODE_OPTIONS_RESTORE_ENV]: "stale-restore",
        [NODE_OPTIONS_RESTORE_ENV.toLowerCase()]: "conflicting-stale-restore",
        PI_REVIEW_GATE_SETTLEMENT_SECRET: "stale-settlement",
        pi_review_gate_settlement_secret: "conflicting-stale-settlement",
        PI_REVIEW_GATE_QUIESCENCE_SECRET: "stale-quiescence",
        pi_review_gate_quiescence_secret: "conflicting-stale-quiescence",
      },
    });
    assert.equal(result.file, realpathSync(candidate), "Windows PATH search returns the canonical actual JS CLI file");
    assert.equal(result.version, "1.0.4");
    assert.deepEqual(observations, [{
      command: process.execPath,
      args: [result.file, "--version"],
      shell: false,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: VERSION_PROBE_MAX_BYTES,
      envNames: ["NODE_OPTIONS", "PATH", "TEMP", "TMP", "TMPDIR"],
    }], "Windows probes through process.execPath with no shell and the existing finite bounds; all stale mixed-case capabilities are absent from the child env");
    fixture.trackChildFile(capturePath);
    const captured = JSON.parse(require("node:fs").readFileSync(capturePath, "utf8")) as Record<string, unknown>;
    assert.equal(captured.execPath, process.execPath);
    assert.deepEqual(captured.argv, [result.file, "--version"]);
    assert.equal(captured.nodeOptions, "--no-warnings", "trusted user NODE_OPTIONS is preserved for the probe");
    assert.equal(captured.bootstrap, undefined);
    assert.equal(captured.restore, undefined);
    assert.equal(captured.settlement, undefined);
    assert.equal(captured.quiescence, undefined);

    // The default filename lookup does not adopt npm.cmd/pi.exe shims, even
    // when they appear earlier on PATH; it looks only for the exact `pi` file.
    assert.throws(
      () => resolveNativePi({ executable: "pi", env: { Path: firstBin } }),
      /was not found on PATH/,
    );
    const beforeConflict = observations.length;
    assert.throws(
      () => resolveNativePi({ executable: "pi", env: { Path: firstBin, PATH: secondBin } }),
      /conflicting case variants in the Windows environment/,
      "conflicting aliases fail closed instead of relying on Windows child-process deduplication",
    );
    assert.equal(observations.length, beforeConflict, "conflicting environment aliases reject before any probe");
    assert.throws(
      () => resolveNativePi({
        executable: "pi",
        env: { Path: `${firstBin};${secondBin}`, NODE_OPTIONS: "--no-warnings", node_options: "--trace-warnings" },
      }),
      /conflicting case variants in the Windows environment/,
      "conflicting NODE_OPTIONS spellings do not rely on child-process deduplication",
    );
    const explicit = resolveNativePi({
      executable: candidate,
      env: {
        PATH: firstBin,
        TMPDIR: fixture.directory("tmp"),
        TMP: fixture.directory("tmp"),
        TEMP: fixture.directory("tmp"),
      },
    });
    assert.equal(explicit.file, realpathSync(candidate), "an explicit owned drive/absolute path is honored as one filename");
    assert.equal(explicit.version, "1.0.4");

    // Windows drive, UNC, and backslash forms are explicit paths, never a
    // reason to fall back to PATH or to interpret a shell command string.
    // Fake drive/UNC spellings are exercised only on POSIX, where they are
    // inert filenames rooted at this workspace; actual Windows uses only
    // owned fixture paths to avoid probing any external drive/share.
    const pathExamples = REAL_PLATFORM === "win32"
      ? [".\\relative\\pi.js"]
      : ["C:\\Program Files\\Pi\\pi.js", "\\\\server\\share\\pi.js", ".\\relative\\pi.js"];
    for (const path of pathExamples) {
      assert.throws(
        () => resolveNativePi({ executable: path, env: { PATH: secondBin } }),
        /configured native pi executable is not a readable regular file/,
        `explicit Windows path form must not be treated as a bare PATH name: ${path}`,
      );
    }

    assert.throws(
      () => resolveNativePi({ executable: "pi --version; touch marker", env: { PATH: secondBin } }),
      /command string/,
      "a shell command string is rejected as data and never executed",
    );
    const nativeBinary = join(fixture.root, "native-pi");
    fixture.file(nativeBinary, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    assert.throws(
      () => resolveNativePi({ executable: nativeBinary, env: { PATH: secondBin } }),
      /native\/SEA binary/,
      "a synthetic native/SEA header is rejected before any probe",
    );

    for (const [name, source] of [
      ["flagged.js", "#!/usr/bin/env -S node\\nprocess.stdout.write('pi 1.0.4');\\n"],
      ["opaque.js", "#!/bin/sh\\necho pi 1.0.4\\n"],
    ] as const) {
      const rejected = join(fixture.root, name);
      fixture.file(rejected, source.replaceAll("\\n", "\n"));
      assert.throws(() => resolveNativePi({ executable: rejected, env: { PATH: secondBin } }), /positive Node-entry shebang/);
    }

    const roleProbeCount = observations.length;
    assert.throws(
      () => resolveNativePi({
        executable: candidate,
        env: { Path: secondBin, [RUNTIME_ROLE_ENV]: "", [RUNTIME_ROLE_ENV.toLowerCase()]: "private-role-marker" },
      }),
      (error: unknown) => error instanceof Error && error.message.includes(RUNTIME_ROLE_ENV) && !error.message.includes("private-role-marker"),
    );
    assert.throws(
      () => resolveNativePi({
        executable: candidate,
        env: { Path: secondBin, [EXECUTOR_TOOL_CATALOG_ENV.toLowerCase()]: "private-catalog-marker" },
      }),
      (error: unknown) => error instanceof Error && error.message.includes(EXECUTOR_TOOL_CATALOG_ENV) && !error.message.includes("private-catalog-marker"),
    );
    assert.equal(observations.length, roleProbeCount, "nonempty worker roles reject before any version child probe");
  }));
  fixture.complete();
});

test("simulated Windows descriptor runs Node plus the canonical CLI prefix and preserves native setup/session fencing", async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const launch = makeLaunchFixture(fixture, { strangePackagePath: true });
  const { file: savedFile, admission } = await admittedSession(fixture, launch);
  const preload = join(launch.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  const preloadMarker = join(fixture.root, "preload-ran");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "ok");\n`, { flag: "w" });
  const callerEnv: NodeJS.ProcessEnv = {
    ...nativeEnv(fixture, launch),
    node_options: "--no-warnings",
    [SESSION_HOST_BOOTSTRAP_ENV]: "stale-bootstrap",
    [SESSION_HOST_BOOTSTRAP_ENV.toLowerCase()]: "conflicting-stale-bootstrap",
    [NODE_OPTIONS_RESTORE_ENV]: "stale-restore",
    [NODE_OPTIONS_RESTORE_ENV.toLowerCase()]: "conflicting-stale-restore",
    [RUNTIME_ROLE_ENV]: "",
    PI_REVIEW_GATE_SETTLEMENT_SECRET: "stale-settlement",
    pi_review_gate_settlement_secret: "conflicting-stale-settlement",
    PI_REVIEW_GATE_QUIESCENCE_SECRET: "stale-quiescence",
    pi_review_gate_quiescence_secret: "conflicting-stale-quiescence",
    PI_IMAGE_PROTOCOL: "native-image-selection",
    PI_REVIEW_GATE_CODEMODE_DEFAULT: "0",
    PI_REVIEW_GATE_SCHEDULER: "native-scheduler",
    PI_REVIEW_GATE_DISABLED: "0",
    pi_provider_test_key: "synthetic-provider-value",
  };
  const args = ["-p", "plan", "--", "message data"];

  const descriptor = withWindowsLaunchPlatform(() => prepareNativeLaunch({
    nativeSetup: true,
    packageRoot: launch.packageRoot,
    agentDir: launch.agentDir,
    workspace: launch.workspace,
    piExecutable: launch.cli,
    args,
    savedSession: admission,
    env: callerEnv,
  }));

  assert.equal(descriptor.file, process.execPath, "Windows launches the Pi JS CLI with the running Node executable");
  assert.deepEqual(descriptor.args, [
    realpathSync(launch.cli),
    "--extension",
    join(launch.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(launch.packageRoot, "dist", "src", "index.js"),
    "--session",
    savedFile,
    ...args,
  ], "the exact canonical CLI prefix precedes existing extensions and the admitted --session pair stays before forwarded --");
  assert.equal(descriptor.cwd, realpathSync(launch.workspace));
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, realpathSync(launch.agentDir));
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "native-image-selection");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "0");
  assert.equal(descriptor.env.PI_REVIEW_GATE_SCHEDULER, "native-scheduler");
  assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, "0");
  assert.equal(descriptor.env.PI_PROVIDER_TEST_KEY, "synthetic-provider-value", "case-normalization preserves unrelated provider values");
  assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(existsSync(join(launch.agentDir, "skills")), false, "native setup does not republish/copy skill resources");
  assert.equal(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV], undefined);
  assert.equal(descriptor.env[RUNTIME_ROLE_ENV], undefined);
  assert.equal(descriptor.env[EXECUTOR_TOOL_CATALOG_ENV], undefined);
  assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
  assert.equal(descriptor.env.PI_REVIEW_GATE_QUIESCENCE_SECRET, undefined);
  const strippedCapabilityNames = new Set([
    SESSION_HOST_BOOTSTRAP_ENV,
    "PI_REVIEW_GATE_SETTLEMENT_SECRET",
    "PI_REVIEW_GATE_QUIESCENCE_SECRET",
  ]);
  const descriptorNames = Object.keys(descriptor.env);
  assert.equal(
    descriptorNames.some((name) => strippedCapabilityNames.has(name.toUpperCase())),
    false,
    "no mixed-case stale host capability alias survives descriptor composition",
  );
  assert.deepEqual(
    descriptorNames.filter((name) => name.toUpperCase() === NODE_OPTIONS_RESTORE_ENV),
    [NODE_OPTIONS_RESTORE_ENV],
    "the stale mixed-case restore alias is replaced by exactly one canonical restoration frame",
  );
  assert.equal(descriptor.env[NODE_OPTIONS_RESTORE_ENV], JSON.stringify({ original: "--no-warnings" }));
  assert.equal(callerEnv.node_options, "--no-warnings", "the input environment is never mutated");
  assert.equal(callerEnv.NODE_OPTIONS, undefined);
  assert.equal(callerEnv[SESSION_HOST_BOOTSTRAP_ENV], "stale-bootstrap");
  assert.equal(callerEnv[NODE_OPTIONS_RESTORE_ENV], "stale-restore");

  const escapedPreload = preload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  assert.equal(descriptor.env.NODE_OPTIONS, `--require="${escapedPreload}" --no-warnings`);
  assert.ok(Buffer.byteLength(descriptor.env[NODE_OPTIONS_RESTORE_ENV]!, "utf8") <= MAX_NATIVE_NODE_OPTIONS_BYTES);

  // Exercise the public Node NODE_OPTIONS parser with an owned preload path
  // containing spaces and (on POSIX test hosts) literal backslashes/quotes.
  // This parses an argv/env string only; no shell or real Pi runtime is used.
  const childProcess = require("node:child_process") as { spawnSync: (...args: unknown[]) => { status: number | null; stderr?: string } };
  const parserResult = childProcess.spawnSync(process.execPath, ["-e", ""], {
    env: descriptor.env,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    shell: false,
    windowsHide: true,
  });
  assert.equal(parserResult.status, 0, `Node must parse the descriptor NODE_OPTIONS value (${parserResult.stderr ?? ""})`);
  fixture.trackChildFile(preloadMarker);
  assert.equal(require("node:fs").readFileSync(preloadMarker, "utf8"), "ok", "the quoted preload path was loaded by Node");

  const mixedCaseSessionEnv = {
    ...nativeEnv(fixture, launch),
    pi_coding_agent_session_dir: join(fixture.root, "parent-session-dir"),
  };
  assert.throws(
    () => withWindowsLaunchPlatform(() => prepareNativeLaunch({
      packageRoot: fixture.directory("invalid-package"),
      agentDir: launch.agentDir,
      workspace: launch.workspace,
      piExecutable: launch.cli,
      env: mixedCaseSessionEnv,
    })),
    (error: unknown) => error instanceof Error
      && error.message.includes("PI_CODING_AGENT_SESSION_DIR")
      && !error.message.includes("parent-session-dir"),
    "Windows-aware env snapshotting must precede startup preflight and detect mixed-case session-dir overrides",
  );

  // Startup overrides stay parent-owned; copied/unbranded receipts do not
  // become a resume path, even in the Windows descriptor mode.
  assert.throws(
    () => withWindowsLaunchPlatform(() => prepareNativeLaunch({
      nativeSetup: true,
      packageRoot: launch.packageRoot,
      agentDir: launch.agentDir,
      workspace: launch.workspace,
      piExecutable: launch.cli,
      args: ["--session", savedFile],
      env: nativeEnv(fixture, launch),
    })),
    (error: unknown) => error instanceof Error && error.message.includes("--session") && !error.message.includes(savedFile),
  );
  assert.throws(
    () => withWindowsLaunchPlatform(() => prepareNativeLaunch({
      nativeSetup: true,
      packageRoot: launch.packageRoot,
      agentDir: launch.agentDir,
      workspace: launch.workspace,
      piExecutable: launch.cli,
      savedSession: { ...admission },
      env: nativeEnv(fixture, launch),
    })),
    /not a valid admission receipt/,
  );
  fixture.complete();
});

test("POSIX launch descriptor remains direct with no Node CLI prefix", (t) => {
  if (REAL_PLATFORM === "win32") {
    t.skip("POSIX direct-execution preservation is covered on POSIX hosts");
    return;
  }
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const launch = makeLaunchFixture(fixture);
  chmodSync(launch.cli, 0o700);
  const env = {
    ...nativeEnv(fixture, launch),
    PI_PROVIDER_TEST_KEY: "posix-uppercase-value",
    pi_provider_test_key: "posix-lowercase-value",
  };
  const descriptor = prepareNativeLaunch({
    nativeSetup: true,
    packageRoot: launch.packageRoot,
    agentDir: launch.agentDir,
    workspace: launch.workspace,
    piExecutable: launch.cli,
    args: ["-p", "plan"],
    env,
  });
  assert.equal(descriptor.file, realpathSync(launch.cli));
  assert.equal(descriptor.env.PI_PROVIDER_TEST_KEY, "posix-uppercase-value");
  assert.equal(descriptor.env.pi_provider_test_key, "posix-lowercase-value", "POSIX environment names remain case-sensitive");
  assert.deepEqual(descriptor.args.slice(0, 4), [
    "--extension",
    join(launch.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(launch.packageRoot, "dist", "src", "index.js"),
  ]);
  assert.deepEqual(descriptor.args.slice(4), ["-p", "plan"]);
  fixture.complete();
});

test("simulated Windows version probes reject noisy stderr rescue and oversized output without dumping bytes", (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const cli = join(fixture.directory("bin"), "pi");
  fixture.file(cli, "#!/usr/bin/env node\nprocess.stdout.write(\"noise\\n\"); process.stderr.write(\"pi 1.0.4\\n\");\n");
  const tempDir = fixture.directory("tmp");
  const env = { PATH: process.env.PATH, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir };

  withPlatform("win32", () => {
    assert.throws(
      () => resolveNativePi({ executable: cli, env }),
      (error: unknown) => error instanceof Error
        && /official version format/.test(error.message)
        && !error.message.includes("noise")
        && !error.message.includes("1.0.4"),
      "stderr must never rescue noisy stdout, and neither stream is echoed",
    );
    const oversized = join(fixture.directory("oversized"), "pi");
    fixture.file(oversized, `#!/usr/bin/env node\nprocess.stdout.write(\"1.0.4\" + \"x\".repeat(${VERSION_PROBE_MAX_BYTES * 4}));\n`);
    assert.throws(
      () => resolveNativePi({ executable: oversized, env }),
      (error: unknown) => error instanceof Error
        && /probe limit/.test(error.message)
        && !error.message.includes("xxxx"),
      "the Windows Node-host probe retains the finite output cap",
    );
  });
  fixture.complete();
});
