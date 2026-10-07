import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  MAX_NATIVE_CONFIG_BYTES,
  MAX_NATIVE_NODE_OPTIONS_BYTES,
  NATIVE_SKILL_PUBLISH_PLAN,
  NODE_OPTIONS_RESTORE_ENV,
  RUNTIME_ROLE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
  prepareNativeLaunch,
  resolveNativePi,
} from "../src/session-host/launch";
import {
  admitSavedSession,
  listSavedSessions,
  SavedSessionAdmission,
} from "../src/session-host/saved-sessions";

interface PiFixture {
  /** Real (symlink-resolved) root holding the fake pi executable. */
  root: string;
  /** Directory of a PATH-searchable fake pi printing the wanted version. */
  bin: string;
}

async function makePiFixture(
  version: string,
  prefix = "pi-native-host",
  behavior?: "exit1" | "garbage" | "huge" | "hang",
): Promise<PiFixture> {
  const root = await realpath(await mkdtemp(join(process.cwd(), `.${prefix}-`)));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // All fake pi executables are controlled Node-entry fixtures with an
  // execPath shebang (the real Node CLI form): no node entry is required on
  // the fake PATH, and none of these fixtures claims real native Pi runtime
  // compatibility — they only print the exact Pi version/handler behavior
  // each test needs.
  const output = behavior === "exit1"
    ? "process.stderr.write('boom\\n');\nprocess.exit(3);\n"
    : behavior === "garbage"
      ? "process.stdout.write('not-a-version-at-all');\n"
      : behavior === "huge"
        ? "process.stdout.write('1.0.4' + 'x'.repeat(20000));\n"
        : behavior === "hang"
          // The probe owns this exact Node process (its timeout kill is the
          // SIGKILL that ends it); no descendants are spawned and nothing
          // lingers. No cleanup claim is made for arbitrary custom wrappers.
          ? "setTimeout(() => {}, 60000);\n"
          : `process.stdout.write('pi ${version}\\n');\n`;
  await writeFile(join(bin, "pi"), `#!${process.execPath}\n${output}`, "utf8");
  await chmod(join(bin, "pi"), 0o755);
  return { root, bin };
}

interface PackageFixture {
  /** Real (symlink-resolved) root of the synthetic fixture tree. */
  root: string;
  packageRoot: string;
  agentDir: string;
  workspace: string;
  configPath: string;
  skillsRoot: string;
}

async function makePackageFixture(prefix = "pi-native-host-pkg"): Promise<PackageFixture> {
  const root = await realpath(await mkdtemp(join(process.cwd(), `.${prefix}-`)));
  const packageRoot = join(root, "package");
  const bin = join(root, "bin");
  const agentDir = join(root, "home", ".pi", "agent");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(join(packageRoot, "dist", "src", "session-host"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  await writeFile(join(bin, "pi"), `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  await chmod(join(bin, "pi"), 0o755);
  await writeFile(join(packageRoot, "dist", "src", "index.js"), "// gate extension\n", "utf8");
  await writeFile(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// reporter\n", "utf8");
  // Placeholder for the sibling's compiled bootstrap-preload (descriptor
  // tests only; early-env/spawn behavior belongs to the reporter sibling).
  await writeFile(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// preload placeholder\n", "utf8");
  // Shipped skill sources, mirroring the packaged tree.
  await Promise.all([
    mkdir(join(packageRoot, "skills", "pi-review-gate-orchestrator", "references"), { recursive: true }),
    mkdir(join(packageRoot, "skills", "pi-review-gate-execution"), { recursive: true }),
    mkdir(join(packageRoot, "skills", "pi-review-gate-research"), { recursive: true }),
  ]);
  await writeFile(join(packageRoot, "skills", "pi-review-gate-orchestrator", "SKILL.md"), "orchestrator skill\n", "utf8");
  await writeFile(join(packageRoot, "skills", "pi-review-gate-orchestrator", "references", "recovery.md"), "recovery runbook\n", "utf8");
  await writeFile(join(packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "execution skill\n", "utf8");
  await writeFile(join(packageRoot, "skills", "pi-review-gate-research", "SKILL.md"), "research skill\n", "utf8");
  const configPath = join(agentDir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ enabled: true, review: { activeReviewers: [] } }), "utf8");
  return {
    root,
    packageRoot,
    agentDir,
    workspace,
    configPath,
    skillsRoot: join(agentDir, "skills"),
  };
}

function baseOptions(
  fixture: PackageFixture,
  overrides: Partial<{
    nativeSetup: boolean;
    packageRoot: string;
    agentDir: string;
    workspace: string;
    piExecutable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    savedSession: SavedSessionAdmission;
  }> = {},
): Parameters<typeof prepareNativeLaunch>[0] {
  return {
    nativeSetup: false,
    packageRoot: fixture.packageRoot,
    agentDir: fixture.agentDir,
    workspace: fixture.workspace,
    piExecutable: join(fixture.root, "bin", "pi"),
    args: [],
    env: { PATH: process.env.PATH },
    ...overrides,
  };
}

test("resolveNativePi resolves a PATH pi by bare filename without shell interpretation", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const resolved = resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:/nonexistent` } });
  assert.equal(resolved.version, "1.0.4");
  assert.ok(resolved.file.startsWith(fixture.bin), "resolved file should come from the searched PATH entry");
  assert.ok(resolved.file !== "pi" && resolve(resolved.file) === resolved.file, "file must be absolute (cwd independent)");
});

test("native executable validation checks caller access, not any execute bit", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires an unprivileged POSIX user");
    return;
  }
  const denied = await makePiFixture("1.0.4");
  const usable = await makePiFixture("1.0.4");
  const pkg = await makePackageFixture();
  for (const fixture of [denied, usable, pkg]) {
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
  }
  const deniedFile = join(denied.bin, "pi");
  await chmod(deniedFile, 0o645);
  // PATH resolution must skip the denied entry and select the usable later one.
  const resolved = resolveNativePi({ env: { PATH: `${denied.bin}:${usable.bin}` } });
  assert.equal(resolved.file, join(usable.bin, "pi"));
  // Explicit-path preparation also rejects the denied file.
  assert.throws(
    () => resolveNativePi({ executable: deniedFile, env: { PATH: usable.bin } }),
    /not an executable regular file/,
  );
  // Descriptor preparation rejects the denied executable before anything runs.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { piExecutable: deniedFile })),
    /not an executable regular file/,
  );
  assert.equal(existsSync(pkg.skillsRoot), false);
});

test("resolveNativePi accepts an explicit actual Node Pi CLI entry path", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const customDir = join(fixture.root, "custom-pi");
  await mkdir(customDir, { recursive: true });
  const explicit = join(customDir, "pi");
  await writeFile(explicit, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  await chmod(explicit, 0o755);
  const resolved = resolveNativePi({ executable: explicit, env: { PATH: "/nonexistent" } });
  assert.equal(resolved.file, explicit);
  assert.equal(resolved.version, "1.0.4");
});

test("resolveNativePi accepts the standard env Node shebang but rejects unproven interpreter flags", async (t) => {
  const fixture = await makePiFixture("1.0.4", "pi-native-host-shebang");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const envEntry = join(fixture.root, "env-pi");
  await writeFile(envEntry, "#!/usr/bin/env node\nprocess.stdout.write('pi 1.0.4\\n');\n", "utf8");
  await chmod(envEntry, 0o755);
  const envPath = `${dirname(process.execPath)}:${process.env.PATH ?? ""}`;
  assert.equal(
    resolveNativePi({ executable: envEntry, env: { PATH: envPath } }).version,
    "1.0.4",
    "the standard '#!/usr/bin/env node' entry is positive Node evidence",
  );

  const unsupported = [
    `#!${process.execPath} --no-warnings\nprocess.stdout.write('pi 1.0.4\\n');\n`,
    "#!/usr/bin/env -S node\nprocess.stdout.write('pi 1.0.4\\n');\n",
    "#!/usr/bin/env node --no-warnings\nprocess.stdout.write('pi 1.0.4\\n');\n",
    `#!${process.execPath}${" ".repeat(600)}`,
  ];
  for (const [index, source] of unsupported.entries()) {
    const candidate = join(fixture.root, `unsupported-${index}`);
    await writeFile(candidate, source, "utf8");
    await chmod(candidate, 0o755);
    assert.throws(
      () => resolveNativePi({ executable: candidate, env: { PATH: envPath } }),
      /positive Node-entry shebang/,
      `entry ${index} has flags or dispatch syntax without positive evidence`,
    );
  }
});

test("resolveNativePi rejects shell command strings, metacharacters, and bare PATH misses", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  // A shell command string with a slash in it is never executed either: it
  // falls to explicit-path validation and fails as a nonpath (covered in the
  // explicit-path test below); only exact bare names reach PATH lookup.
  assert.throws(
    () => resolveNativePi({ executable: "pi touch tmpfile", env: { PATH: fixture.bin } }),
    /command string/,
  );
  assert.throws(() => resolveNativePi({ executable: "pi|touch", env: { PATH: fixture.bin } }), /command string/);
  assert.throws(() => resolveNativePi({ executable: "pi", env: { PATH: join(fixture.root, "missing-bin") } }), /was not found on PATH/);
});

test("resolveNativePi fails closed on exit failure, garbage version, oversize output, and timeout", async (t) => {
  const cases = [
    ["exit1", /exited with status 3/] as const,
    ["garbage", /official version format/] as const,
    ["huge", /probe limit/] as const,
    ["hang", /did not answer within/] as const,
  ] as const;
  for (const [behavior, pattern] of cases) {
    const fixture = await makePiFixture("1.0.4", "pi-native-host-probe", behavior);
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    try {
      resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } });
      assert.fail(`expected failure for behavior ${behavior}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, pattern, `behavior ${behavior} should match the diagnostic`);
      assert.doesNotMatch(message, /boom/, "diagnostics must never dump command output");
      assert.doesNotMatch(message, /xxxx/, "diagnostics must never dump oversized output");
    }
  }
});

test("resolveNativePi enforces the pinned 1.0.4 minimum with no old-compatibility scaffold", async (t) => {
  const fixture = await makePiFixture("1.0.3");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /requires Pi 1\.0\.4 or newer|found 1\.0\.3/.test(message);
    },
  );
});

test("prepareNativeLaunch composes the exact standalone-policy native descriptor", async (t) => {
  const pkg = await makePackageFixture();
  const pi = await makePiFixture("1.0.4");
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  t.after(() => rm(pi.root, { recursive: true, force: true }));
  const forwarded = ["-p", "plan", "--tool", "read,edit", "commit;-ish;$(x)"];
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    piExecutable: join(pi.root, "bin", "pi"),
    args: forwarded,
  }));
  assert.equal(descriptor.file, join(pi.root, "bin", "pi"));
  const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    ...forwarded,
  ], "the reporter extension loads first, then the gate extension, then native args");
  assert.equal(descriptor.cwd, pkg.workspace);
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "none");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "1");
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, pkg.agentDir);
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, pkg.configPath);
  assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, undefined, "no kill switch is invented by preparation");
  // With no inherited NODE_OPTIONS: exactly the preload require clause, and a
  // null original in the one-shot restoration sidecar.
  assert.equal(descriptor.env.NODE_OPTIONS, `--require="${preloadPath}"`);
  assert.equal(descriptor.env[NODE_OPTIONS_RESTORE_ENV], JSON.stringify({ original: null }));
});

test("prepareNativeLaunch consumes explicit --scheduler opt-in and clears inherited scheduler state", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // Without the flag: an inherited PI_REVIEW_GATE_SCHEDULER must not survive.
  const off = prepareNativeLaunch(baseOptions(pkg, {
    args: ["-p", "plan"],
    env: { PATH: process.env.PATH, PI_REVIEW_GATE_SCHEDULER: "1" },
  }));
  assert.equal(off.env.PI_REVIEW_GATE_SCHEDULER, undefined);
  assert.deepEqual(off.args.slice(4), ["-p", "plan"]);
  // With the flag: consumed exactly like the ordinary wrapper.
  const on = prepareNativeLaunch(baseOptions(pkg, { args: ["--scheduler", "-p", "plan"] }));
  assert.equal(on.env.PI_REVIEW_GATE_SCHEDULER, "1");
  assert.deepEqual(on.args.slice(4), ["-p", "plan"]);
  assert.ok(!on.args.includes("--scheduler"), "the consumed flag is never forwarded to pi");
});

test("prepareNativeLaunch strips status authorization from the descriptor without touching the caller env", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const callerEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_OPTIONS: "--no-warnings",
    [SESSION_HOST_BOOTSTRAP_ENV]: "session-host-token",
    [NODE_OPTIONS_RESTORE_ENV]: '{"original":"stale"}',
    [RUNTIME_ROLE_ENV]: "",
    PI_REVIEW_GATE_SETTLEMENT_SECRET: "stale-secret",
    PI_REVIEW_GATE_SETTLEMENT_PATH: "stale-path",
    PI_REVIEW_GATE_SETTLEMENT_SESSION: "stale-session",
    PI_REVIEW_GATE_SETTLEMENT_CHILD: "1",
    PI_REVIEW_GATE_QUIESCENCE_SECRET: "stale-quiescence",
    processSentinel: "keep-me",
  };
  const sentinelBefore = "pi-native-host-sentinel";
  process.env[sentinelBefore] = sentinelBefore;
  try {
    const descriptor = prepareNativeLaunch(baseOptions(pkg, { env: callerEnv }));
    assert.equal(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV], undefined, "bootstrap token is absent from the setup descriptor");
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_SECRET, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_PATH, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_SESSION, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_SETTLEMENT_CHILD, undefined);
    assert.equal(descriptor.env.PI_REVIEW_GATE_QUIESCENCE_SECRET, undefined);
    // The user's original NODE_OPTIONS is preserved exactly in the one-shot
    // restoration sidecar; the inherited stale sidecar is replaced, and the
    // preload require clause is PREPENDED before the original value.
    const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
    assert.equal(descriptor.env[NODE_OPTIONS_RESTORE_ENV], JSON.stringify({ original: "--no-warnings" }));
    assert.equal(descriptor.env.NODE_OPTIONS, `--require="${preloadPath}" --no-warnings`);
    assert.equal(callerEnv[SESSION_HOST_BOOTSTRAP_ENV], "session-host-token", "the caller env object is never mutated");
    assert.equal(callerEnv.NODE_OPTIONS, "--no-warnings", "the caller NODE_OPTIONS is never mutated");
    assert.equal(callerEnv.PI_REVIEW_GATE_SETTLEMENT_SECRET, "stale-secret", "the caller env object is never mutated");
    assert.equal(process.env[sentinelBefore], sentinelBefore, "process.env is never mutated");
  } finally {
    delete process.env[sentinelBefore];
  }
});

test("prepareNativeLaunch rejects explicit worker/executor role input (actual flag names) and never elevates it", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "executor" } })),
    (error: unknown) => (error instanceof Error ? error.message.includes(RUNTIME_ROLE_ENV) : false),
    "executor runtime role input is rejected fail-closed",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "worker" } })),
    /runtime role authorization comes only from the delegated execution adapter/,
    "worker runtime role input is also rejected",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [EXECUTOR_TOOL_CATALOG_ENV]: "{}" } })),
    (error: unknown) => (error instanceof Error ? error.message.includes(EXECUTOR_TOOL_CATALOG_ENV) : false),
    "executor tool catalogs are executor-role-only",
  );
});

test("prepareNativeLaunch validates required compiled extension files before any publication", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  rmSync(join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"));
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /compiled extension file that is missing/);
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication may run when the compiled files are missing");
});

test("prepareNativeLaunch validates the profile: local config object and no global fallback", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));

  // A globally-inherited config path is overridden to the profile-local config.
  const withFallback = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, PI_REVIEW_GATE_CONFIG: "/some/global/fallback.json" },
  }));
  assert.equal(withFallback.env.PI_REVIEW_GATE_CONFIG, pkg.configPath, "the profile-local config wins over any inherited value");

  // Invalid config shape: array, invalid JSON, missing — all reject; no compatibility fallback, no creation.
  await writeFile(pkg.configPath, JSON.stringify([1, 2]), "utf8");
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /must be a JSON object/);
  await writeFile(pkg.configPath, "{not json", "utf8");
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /is not valid JSON/);
  rmSync(pkg.configPath);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH } })), /profile registry owns its creation/);
  assert.equal(
    existsSync(join(pkg.root, "home", ".config", "pi-review-gate", "config.json")),
    false,
    "no fallback config is created or consulted",
  );
});

test("nativeSetup retains native config, provider environment, resources, and skill locations", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const nativeEnv = {
    HOME: join(pkg.root, "home"),
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: pkg.agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "native-sessions"),
    PI_IMAGE_PROTOCOL: "native-image-selection",
    PI_REVIEW_GATE_CODEMODE_DEFAULT: "0",
    PI_REVIEW_GATE_SCHEDULER: "native-scheduler-setting",
    PI_REVIEW_GATE_DISABLED: "0",
    PI_PROVIDER_FIXTURE_KEY: "synthetic-provider-value",
  };
  const markers = [
    ["settings.json", "{\"theme\":\"native\"}\n"],
    ["keybindings.json", "{\"keys\":[]}\n"],
    ["models.json", "{\"provider\":\"native\"}\n"],
    ["mcp.json", "{\"servers\":{}}\n"],
    ["auth.json", "synthetic-fixture-auth-data\n"],
  ] as const;
  const originalConfig = await readFile(pkg.configPath);
  for (const [filename, bytes] of markers) await writeFile(join(pkg.agentDir, filename), bytes, "utf8");
  const nativeExtension = join(pkg.agentDir, "extensions", "native-extension.js");
  const nativeSkill = join(pkg.agentDir, "skills", "native-skill", "SKILL.md");
  const nativeSession = join(pkg.agentDir, "sessions", "saved.jsonl");
  await Promise.all([
    mkdir(dirname(nativeExtension), { recursive: true }),
    mkdir(dirname(nativeSkill), { recursive: true }),
    mkdir(dirname(nativeSession), { recursive: true }),
    mkdir(nativeEnv.PI_CODING_AGENT_SESSION_DIR, { recursive: true }),
  ]);
  await writeFile(nativeExtension, "native extension marker\n", "utf8");
  await writeFile(nativeSkill, "native skill marker\n", "utf8");
  await writeFile(nativeSession, "saved conversation marker\n", "utf8");
  const sessionMarker = join(nativeEnv.PI_CODING_AGENT_SESSION_DIR, "retained.jsonl");
  await writeFile(sessionMarker, "native session directory marker\n", "utf8");

  const descriptor = prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeEnv }));
  assert.equal(descriptor.env.PI_CODING_AGENT_DIR, realpathSync(pkg.agentDir));
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, undefined, "normal native config resolution is left to the extension");
  assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, nativeEnv.PI_CODING_AGENT_SESSION_DIR);
  assert.equal(descriptor.env.PI_PROVIDER_FIXTURE_KEY, nativeEnv.PI_PROVIDER_FIXTURE_KEY);
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "native-image-selection");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "0");
  assert.equal(descriptor.env.PI_REVIEW_GATE_SCHEDULER, "native-scheduler-setting");
  assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, "0");
  assert.equal((await readFile(pkg.configPath)).equals(originalConfig), true);
  for (const [filename, bytes] of markers) {
    assert.equal((await readFile(join(pkg.agentDir, filename), "utf8")), bytes);
  }
  assert.equal(await readFile(nativeExtension, "utf8"), "native extension marker\n");
  assert.equal(await readFile(nativeSkill, "utf8"), "native skill marker\n");
  assert.equal(await readFile(nativeSession, "utf8"), "saved conversation marker\n");
  assert.equal(await readFile(sessionMarker, "utf8"), "native session directory marker\n");
  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    assert.equal(existsSync(join(pkg.skillsRoot, skill.name)), false, "native launches do not republish nested profile skills");
  }

  const overridePath = join(pkg.root, "explicit-native-review-gate.json");
  const overrideBytes = Buffer.from(JSON.stringify({ enabled: false, marker: "explicit override" }));
  await writeFile(overridePath, overrideBytes);
  const overridden = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: { ...nativeEnv, PI_REVIEW_GATE_CONFIG: overridePath },
  }));
  assert.equal(overridden.env.PI_REVIEW_GATE_CONFIG, overridePath, "explicit ordinary config overrides are preserved byte-for-byte");
  assert.equal((await readFile(overridePath)).equals(overrideBytes), true);

  // Malformed native JSON remains untouched so the ordinary extension loader
  // can emit its normal recovery warning instead of preparation hiding it.
  const malformed = Buffer.from("{native-invalid");
  await writeFile(pkg.configPath, malformed);
  prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeEnv }));
  assert.equal((await readFile(pkg.configPath)).equals(malformed), true);
});

test("nativeSetup supplies only absent ordinary defaults and resolves the native root from its explicit env", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: {
      HOME: join(pkg.root, "home"),
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: pkg.agentDir,
      PI_IMAGE_PROTOCOL: "",
      PI_REVIEW_GATE_CODEMODE_DEFAULT: undefined,
    },
  }));
  assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "", "an explicit empty value is not replaced");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CODEMODE_DEFAULT, "1");
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, undefined);
  assert.equal(existsSync(pkg.skillsRoot), false);
});

test("prepareNativeLaunch enforces the bounded config size cap", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const big = " ".repeat(MAX_NATIVE_CONFIG_BYTES + 1);
  await writeFile(pkg.configPath, `{ "padding": "${big}" }`, "utf8");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("size bound") && message.includes(pkg.configPath);
    },
  );
});

test("prepareNativeLaunch publishes shipped skills into the reserved profile locations with parity to the shipped map", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  prepareNativeLaunch(baseOptions(pkg));

  for (const skill of NATIVE_SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(pkg.packageRoot, ...file.source);
      const destination = join(pkg.skillsRoot, skill.name, ...file.destination);
      assert.equal(
        (await readFile(destination)).equals(await readFile(source)),
        true,
        `shipped bytes must land identical at ${destination}`,
      );
    }
  }
  // Parity with the shipped launchers' SKILL_PUBLISH_PLAN (source of truth).
  const shSource = await readFile(resolve(__dirname, "../../scripts/pi-review-gate.sh"), "utf8");
  const dirNames = new Map(
    [...shSource.matchAll(/^([A-Z_]+_SKILL_DIR)="\$SKILLS_DIR\/([^"]+)"/gm)].map((m) => [m[1], m[2]]),
  );
  const shippedPairs = [...shSource.matchAll(/^  "\$REVIEW_GATE_ROOT\/(\S+?)"\$'\\t'"\$([A-Z_]+)_SKILL_DIR\/(\S+)"/gm)].map(
    (m) => `${m[1]}\t${dirNames.get(`${m[2]}_SKILL_DIR`)}/${m[3]}`,
  );
  const ownPairs = NATIVE_SKILL_PUBLISH_PLAN.flatMap((skill) =>
    skill.files.map((file) => `${file.source.join("/")}\t${skill.name}/${file.destination.join("/")}`),
  );
  assert.deepEqual(ownPairs.sort(), shippedPairs.sort(), "the native skill map must mirror the shipped SKILL_PUBLISH_PLAN");
});

test("prepareNativeLaunch leaves byte-identical publications and unrelated files untouched", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  // Identical content is pre-published: must remain untouched (mtime unchanged).
  await cp(
    join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"),
    join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"),
  );
  const before = (await stat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).mtimeMs;
  const sentinel = join(pkg.skillsRoot, "user-own-skill.md");
  await writeFile(sentinel, "user-owned unrelated content\n", "utf8");
  prepareNativeLaunch(baseOptions(pkg));
  const after = (await stat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).mtimeMs;
  assert.equal(before, after, "byte-identical publications must not rewrite the file");
  assert.equal(await readFile(sentinel, "utf8"), "user-owned unrelated content\n", "unrelated skill files are preserved");
  // Stale content is refreshed while an unrelated file keeps its bytes.
  await writeFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"), "stale local edit\n", "utf8");
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal(
    await readFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"), "utf8"),
    await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "utf8"),
    "stale skill files are refreshed from shipped content",
  );
  assert.equal(await readFile(sentinel, "utf8"), "user-owned unrelated content\n");
});

test("prepareNativeLaunch rejects a directory skill destination with no partial publication", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // A directory occupying a LATER plan destination must reject the whole
  // preparation before publishing ANY file (the orchestrator comes first).
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"), { recursive: true });
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg)), /not a replaceable regular file/);
  assert.equal(
    existsSync(join(pkg.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "the orchestrator skill must not be published when a later destination is invalid",
  );
});

test("prepareNativeLaunch follows the native symlink policy: leaf links replaced, external targets untouched", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const external = join(pkg.root, "external-target.md");
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  await writeFile(external, "external bytes\n", "utf8");
  await symlink(external, join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  const published = await readFile(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"));
  const shipped = await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"));
  assert.deepEqual(published, shipped, "the leaf link is replaced by the shipped content");
  assert.equal((await lstat(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md"))).isSymbolicLink(), false);
  // The external target never takes the published content and keeps its bytes.
  assert.equal(await readFile(external, "utf8"), "external bytes\n", "an external symlink target is never written through");

  // A symlinked ANCESTOR under the skills root refuses the whole preparation.
  const pkg2 = await makePackageFixture();
  t.after(() => rm(pkg2.root, { recursive: true, force: true }));
  const outside = join(pkg2.root, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(join(pkg2.skillsRoot, "pi-review-gate-orchestrator"), { recursive: true });
  await symlink(outside, join(pkg2.skillsRoot, "pi-review-gate-orchestrator", "references"));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg2)),
    /refusing to publish the native skills through a symlinked path component/,
  );
  assert.equal(
    existsSync(join(pkg2.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "no file is published when a path component is a symlink",
  );
});

test("prepareNativeLaunch never rewrites native arguments or tool policy", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const hostile = ["--tools", "read,bash;touch /tmp/pwned-launch", "payload|$(pwd);`ls`", "quote'quote"];
  const descriptor = prepareNativeLaunch(baseOptions(pkg, { args: hostile }));
  assert.deepEqual(descriptor.args.slice(4), hostile, "native arguments must be forwarded byte-for-byte in order");
  assert.ok((await readFile(pkg.configPath, "utf8")).startsWith("{"), "the profile config content is never rewritten by preparation");
});

test("prepareNativeLaunch stages the preload require with Node-parser-safe quoting and bounded, control-free values", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-quote");
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // A package tree whose preload path carries spaces and a double quote
  // exercises the two escapes Node's NODE_OPTIONS parser needs.
  const weirdRoot = join(pkg.root, 'pkg with "quotes"');
  await cp(pkg.packageRoot, weirdRoot, { recursive: true });
  const quotedPreload = join(weirdRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  // Same escape rule as the implementation, written out independently here:
  // backslashes doubled, then double quotes backslash-escaped, in one
  // --require="..." clause (no shell is ever involved).
  const escapedForNodeParser = quotedPreload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    packageRoot: weirdRoot,
    env: { PATH: process.env.PATH, NODE_OPTIONS: "--no-warnings" },
  }));
  assert.equal(descriptor.env.NODE_OPTIONS, `--require="${escapedForNodeParser}" --no-warnings`);
  assert.ok(descriptor.env.NODE_OPTIONS!.includes('\\"'), "an embedded quote must be backslash-escaped for the NODE_OPTIONS parser");
  assert.equal(
    (JSON.parse(descriptor.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    "--no-warnings",
    "the restored original must be byte-exact",
  );
  // Control-character injection in the inherited value rejects fail-closed,
  // and the diagnostic never echoes the rejected value.
  for (const injected of ["--bad\nvalue", "--bad\rvalue", "--bad\u0000value"]) {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: injected } })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes("control characters") && !message.slice(0, message.indexOf("NODE_OPTIONS") + 12).includes(injected.trim());
      },
    );
  }
  // Overlong inherited values reject within the bounded cap without echoing content.
  const oversized = "--x=" + "a".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES + 1);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: oversized } })),
    (error: unknown) => !(error instanceof Error ? error.message : String(error)).includes(oversized),
  );
});

test("resolveNativePi probes a clean env: no inherited bootstrap/restore markers reach the child, user NODE_OPTIONS is preserved", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  // A fake pi Node-entry fixture (execPath shebang) that prints the
  // version (satisfying the probe) and captures the exact child
  // environment values of interest to a side file under the fixture root.
  const fake = join(fixture.bin, "pi");
  await writeFile(fake, [
    `#!${process.execPath}`,
    `process.stdout.write(${JSON.stringify("pi 1.0.4\n")});`,
    'require("node:fs").writeFileSync(',
    '  process.env.CAPTURE_DIR + "/env",',
    '  "bootstrap=<" + (process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ?? "") + ">" +',
    '    "restore=<" + (process.env.PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE ?? "") + ">" +',
    '    "nodeopts=<" + (process.env.NODE_OPTIONS ?? "") + ">",',
    ');',
  ].join("\u000a"), "utf8");
  await chmod(fake, 0o755);
  resolveNativePi({
    executable: "pi",
    env: {
      PATH: `${fixture.bin}:${process.env.PATH}`,
      CAPTURE_DIR: fixture.root,
      PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "inherited-token",
      PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: '{"original":"stale"}',
      NODE_OPTIONS: "--no-warnings",
    },
  });
  const dump = (await readFile(join(fixture.root, "env"), "utf8")).trim();
  assert.equal(dump, "bootstrap=<>restore=<>nodeopts=<--no-warnings>");
});

test("resolveNativePi does not expose rejected spawn environment values", async (t) => {
  const fixture = await makePiFixture("1.0.4", "pi-native-host-env-error");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const executionMarker = join(fixture.root, "pi-entry-executed");
  const secretMarker = "sk-spawn-env-private-marker";
  const fake = join(fixture.bin, "pi");
  await writeFile(fake, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "executed");`,
    `process.stdout.write(${JSON.stringify("pi 1.0.4\n")});`,
  ].join("\n"), "utf8");
  await chmod(fake, 0o755);

  assert.throws(
    () => resolveNativePi({
      executable: "pi",
      env: {
        PATH: `${fixture.bin}:${process.env.PATH}`,
        NODE_OPTIONS: `${secretMarker}\u0000`,
      },
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("version probe") && !message.includes(secretMarker);
    },
    "spawn validation errors are generic and never echo environment contents",
  );
  assert.equal(existsSync(executionMarker), false, "the fixture is not executed with an invalid environment");
});

test("the alpha rejects native/SEA pi binaries fail-closed in resolution and preparation", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const elf = join(pkg.root, "bin", "native-pi");
  await writeFile(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])); // ELF
  await chmod(elf, 0o755);
  assert.throws(
    () => resolveNativePi({ executable: elf, env: { PATH: "/nonexistent" } }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("native/SEA binary") && !message.includes("\u007f");
    },
  );
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { piExecutable: elf })), /native\/SEA binary/);
});

test("resolveNativePi ignores-SIGTERM wrappers fail within the bounded probe window (SIGKILL terminate)", (t) => {
  // The owned Node process ignores SIGTERM itself; the probe's non-ignorable
  // SIGKILL must end that exact process within the bounded window.
  const bin = resolve(join(process.cwd(), `.pi-native-host-sigterm-${process.pid}-${Date.now()}`));
  mkdirSync(bin, { recursive: true });
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = join(bin, "pi");
  // No descendant is spawned; nothing lingers after the direct process is
  // SIGKILLed. No cleanup claim is made for arbitrary custom wrappers.
  writeFileSync(fake, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 60000);\n`, "utf8");
  chmodSync(fake, 0o755);
  const started = Date.now();
  assert.throws(
    () => resolveNativePi({ executable: fake, env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /did not answer within/,
    "an unresponsive pi executable must fail with the bounded diagnostic",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `probe must return promptly (SIGKILL), not hang past the wrapper: ${elapsed}ms`);
});

test("resolveNativePi resolves explicit executable paths under directories with spaces, quotes, and parentheses", (t) => {
  const rawBase = resolve(join(process.cwd(), `.pi-native-host-spq-${process.pid}-${Date.now()}`));
  mkdirSync(rawBase);
  const base = realpathSync(rawBase);
  const dir = join(base, "pi tool dir (alpha) with 'quotes' & spaces");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(rawBase, { recursive: true, force: true }));
  const fake = join(dir, "pi");
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4\\n');\n`, "utf8");
  chmodSync(fake, 0o755);
  const resolved = resolveNativePi({ executable: fake, env: { PATH: "/nonexistent" } });
  assert.equal(resolved.file, fake, "the exact path is canonicalized as a whole filename");
  assert.equal(resolved.version, "1.0.4");
  // A relative explicit path also resolves (without shell interpretation).
  const previousCwd = process.cwd();
  process.chdir(base);
  try {
    const relative = resolveNativePi({ executable: join("pi tool dir (alpha) with 'quotes' & spaces", "pi"), env: { PATH: "/nonexistent" } });
    assert.equal(relative.file, fake);
  } finally {
    process.chdir(previousCwd);
  }
  // A shell command string with a slash in it is still never executed: it
  // falls to path validation and fails as a nonpath.
  assert.throws(
    () => resolveNativePi({ executable: "pi --version; touch /tmp/pwned", env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /not an executable regular file/,
  );
  // Bare-command strings remain rejected.
  assert.throws(
    () => resolveNativePi({ executable: "pi touch", env: { PATH: `/nonexistent:${process.env.PATH}` } }),
    /command string/,
  );
});

test("prepareNativeLaunch rejects an oversized shipped skill source before any publication", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // Pad the LAST plan source so failure cannot be a partial-publication accident.
  await writeFile(
    join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"),
    "x".repeat(1024 * 1024 * 2 + 1),
    "utf8",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /publication size bound/,
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "nothing is published when a shipped source is oversized");
});

test("prepareNativeLaunch publication reads are bounded and never block on special files", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-execution"), { recursive: true });
  // A FIFO occupying a destination leaf rejects the whole preparation before
  // any publication (a read through it could otherwise block forever).
  const fifo = join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md");
  execFileSync("mkfifo", [fifo]);
  const started = Date.now();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /not a replaceable regular file/,
  );
  assert.ok(Date.now() - started < 10_000, "the FIFO destination must be rejected without blocking");
  assert.equal(
    existsSync(join(pkg.skillsRoot, "pi-review-gate-orchestrator", "SKILL.md")),
    false,
    "no partial publication when a special-file destination is present",
  );

  // A symlink leaf pointing AT a FIFO is never read through: the leaf link is
  // replaced itself by the atomic rename and the FIFO target stays untouched.
  const fifoTarget = join(pkg.root, "target-fifo");
  execFileSync("mkfifo", [fifoTarget]);
  const execDir = join(pkg.skillsRoot, "pi-review-gate-execution");
  await mkdir(execDir, { recursive: true });
  rmSync(join(execDir, "SKILL.md")); // remove the FIFO occupying the leaf
  await symlink(fifoTarget, join(execDir, "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal((await lstat(join(execDir, "SKILL.md"))).isSymbolicLink(), false, "the symlink leaf is replaced");
  assert.equal((await stat(fifoTarget)).isFIFO(), true, "the FIFO target is untouched (never read through)");
  assert.equal(
    (await readFile(join(execDir, "SKILL.md"))).equals(await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"))),
    true,
    "the leaf is republished from the shipped bytes",
  );
});

test("prepareNativeLaunch publishes (never hangs on) an over-cap stale destination without reading it whole", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research"), { recursive: true });
  // A stale destination larger than the bound: parity cannot be established
  // without an unbounded read, so it is simply republished whole.
  await writeFile(
    join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"),
    "y".repeat(1024 * 1024 * 2 + 1),
    "utf8",
  );
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal(
    await readFile(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"), "utf8"),
    await readFile(join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"), "utf8"),
    "the over-cap stale destination is refreshed from shipped content",
  );
});

test("prepareNativeLaunch republishes a symlink leaf whose target is byte-identical to the shipped content", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // The target holds exactly the shipped bytes: parity must NOT be claimed
  // through the link (targets are never read); the link itself is replaced.
  const target = join(pkg.root, "identical-target.md");
  await cp(
    join(pkg.packageRoot, "skills", "pi-review-gate-research", "SKILL.md"),
    target,
  );
  await mkdir(join(pkg.skillsRoot, "pi-review-gate-research"), { recursive: true });
  await symlink(target, join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"));
  prepareNativeLaunch(baseOptions(pkg));
  assert.equal((await lstat(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md"))).isSymbolicLink(), false, "the leaf link is replaced, not preserved via target parity");
  assert.equal(await readFile(target, "utf8"), "research skill\n", "the byte-identical target is untouched");
});

test("prepareNativeLaunch validates caller paths even though the caller passes pre-validated values", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { workspace: join(pkg.root, "missing-workspace") })), /workspace is not a directory/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { agentDir: join(pkg.root, "missing-agent-dir") })), /selected registry owns its setup/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { piExecutable: join(pkg.root, "missing-bin", "pi") })), /executable regular file/);
  assert.throws(() => prepareNativeLaunch(baseOptions(pkg, { packageRoot: join(pkg.root, "missing-package-root") })), /package root/);
});

test("publication genuinely uses the shipped launcher helper's production rename implementation", () => {
  // The shipped helper exports the same atomic-rename implementation the
  // publication path loads at runtime (resolved from the repository root,
  // like the other launcher tests).
  const helperPath = resolve("scripts/pi-review-gate-launcher.cjs");
  const helper = require(helperPath) as { renameIntoPlaceWithContentionRetry: unknown };
  assert.equal(typeof helper.renameIntoPlaceWithContentionRetry, "function");
});
test("production descriptor NODE_OPTIONS parses with the preload require FIRST, before an original --require that spawns a child", async (t) => {
  const pkg = await makePackageFixture("pi-native-host-order");
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // A marker-writing preload placeholder (tests own the fake package root;
  // the reporter sibling owns the real preload's early-env behavior).
  const preloadPath = join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js");
  await writeFile(
    preloadPath,
    'require("node:fs").appendFileSync(process.env.MARKS, "preload\\n");\n',
    "utf8",
  );
  // An original user --require that marks itself and spawns a descendant
  // which also marks itself (the class of startup that must never preempt
  // the preload's auth scrub).
  const userRequireFixture = join(pkg.root, "user-require.cjs");
  await writeFile(
    userRequireFixture,
    [
      'require("node:fs").appendFileSync(process.env.MARKS, "user\\n");',
      "require(\"node:child_process\").spawnSync(",
      "  process.execPath,",
      '  ["-e", \'require("node:fs").appendFileSync(process.env.MARKS, "user-child\\\\n");\'],',
      '  { env: { ...process.env, NODE_OPTIONS: undefined }, stdio: "ignore" },',
      ");",
      "",
    ].join("\n"),
    "utf8",
  );
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${userRequireFixture}` },
  }));
  // String-level: the clause is the first entry of the descriptor.
  assert.equal(
    descriptor.env.NODE_OPTIONS!.indexOf("--require") === 0,
    true,
    "the preload require clause must be the first NODE_OPTIONS entry",
  );
  // Production parser: run real node with the exact descriptor value and
  // assert the actual execution order via markers.
  const marks = join(pkg.root, "marks");
  await writeFile(marks, "", "utf8");
  const childEnv = {
    NODE_OPTIONS: descriptor.env.NODE_OPTIONS!,
    MARKS: marks,
    PATH: process.env.PATH,
  };
  const result = spawnSync(
    process.execPath,
    ["-e", `require("node:fs").appendFileSync(process.env.MARKS, "main\\n");`],
    { env: childEnv, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  assert.equal(result.status, 0, `node must parse the descriptor NODE_OPTIONS successfully (${result.stderr ?? ""})`);
  const sequence = (await readFile(marks, "utf8")).trim().split("\n");
  assert.deepEqual(
    sequence,
    ["preload", "user", "user-child", "main"],
    "the preload always runs before any user --require startup, and before any descendant it spawns",
  );
  // The restoration sidecar still preserves the user's ORIGINAL value exactly.
  assert.equal(
    (JSON.parse(descriptor.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    `--require=${userRequireFixture}`,
  );
});

test("resolveNativePi rejects noisy, pre-release, and multi-number --version output (strict official formats only)", async (t) => {
  // A runtime banner plus the CLI version: a loose first-number scan would
  // wrongly accept "24.1.0"; only exact official formats may parse.
  const cases = [
    "node 24.1.0\npi 1.0.4\n",
    "pi 1.0.4 (build 2024)\n",
    "1.0.4-beta\n",
    "pi 1.0.5-rc.1\n",
    "v1.0.4.1\n",
    "some noise\n1.0.4\n",
  ] as const;
  const fake = await makePiFixture("1.0.4");
  t.after(() => rm(fake.root, { recursive: true, force: true }));
  for (const output of cases) {
    await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
    await chmod(join(fake.bin, "pi"), 0o755);
    try {
      resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } });
      assert.fail(`noisy output must be rejected: ${JSON.stringify(output)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /official version format/, `noise must be classified unparseable: ${JSON.stringify(output)}`);
      assert.doesNotMatch(message, /24\.1\.0/);
    }
  }
  // Exact official formats still parse: bare, v-prefixed, and CLI-prefixed.
  for (const [output, expected] of [["1.0.4\n", "1.0.4"], ["v1.0.4\n", "1.0.4"], ["pi 1.0.4\n", "1.0.4"]] as const) {
    await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, "utf8");
    await chmod(join(fake.bin, "pi"), 0o755);
    assert.equal(resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } }).version, expected);
  }
  // Pre-release at the floor is never accepted as a stable >= 4 build.
  await writeFile(join(fake.bin, "pi"), `#!${process.execPath}\nprocess.stdout.write('pi 1.0.4-beta\\n');\n`, "utf8");
  await chmod(join(fake.bin, "pi"), 0o755);
  assert.throws(() => resolveNativePi({ executable: "pi", env: { PATH: `${fake.bin}:${process.env.PATH}` } }), /official version format/);
});

test("resolveNativePi rejects unreadable, unknown, and opaque non-Node entries before probing", async (t) => {
  const rawBase = resolve(join(process.cwd(), `.pi-native-host-head-${process.pid}-${Date.now()}`));
  mkdirSync(rawBase, { recursive: true });
  const root = realpathSync(rawBase);
  t.after(() => rmSync(rawBase, { recursive: true, force: true }));
  // An unreadable executable is rejected without probing.
  const unreadableDir = join(root, "unreadable");
  mkdirSync(unreadableDir, { recursive: true });
  const unreadable = join(unreadableDir, "pi");
  writeFileSync(unreadable, "binary-ish\n", "utf8");
  chmodSync(unreadable, 0o000);
  assert.throws(
    () => resolveNativePi({ executable: unreadable, env: { PATH: "/nonexistent" } }),
    /not an executable regular file/,
    "an X_OK-unreadable executable is rejected at file validation, before any probe",
  );
  // A non-shebang unknown executable is rejected without executing it: the
  // fake would create a marker if any probe ran.
  const unknownDir = join(root, "unknown");
  mkdirSync(unknownDir, { recursive: true });
  const unknown = join(unknownDir, "pi");
  writeFileSync(unknown, "plain custom blob without shebang and without binary magic\n", "utf8");
  const marker = join(root, "probe-marker");
  chmodSync(unknown, 0o755);
  try {
    resolveNativePi({ executable: unknown, env: { PATH: "/nonexistent", MARKER: marker } });
    assert.fail("unknown non-shebang executable must be rejected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /does not start with a positive Node-entry shebang/);
  }
  assert.equal(existsSync(marker), false, "no probe is executed for an unknown executable format");

  // Opaque shell startup could spawn helpers before Node consumes the
  // NODE_OPTIONS scrubber. Reject it before probe or skill publication, and
  // prove its body never runs by leaving a marker if it does.
  const shimDir = join(root, "opaque-shim");
  await mkdir(shimDir, { recursive: true });
  const shim = join(shimDir, "pi");
  const shimMarker = join(root, "shim-body-ran");
  await writeFile(shim, "#!/bin/sh\nprintf 'ran' > \"$MARKER\"\nprintf 'pi 1.0.4\\n'\n", "utf8");
  await chmod(shim, 0o755);
  assert.throws(
    () => resolveNativePi({ executable: shim, env: { PATH: "/nonexistent", MARKER: shimMarker } }),
    /positive Node-entry shebang/,
    "opaque shell entrypoints are rejected rather than parsed or probed",
  );
  assert.equal(existsSync(shimMarker), false, "the rejected shim body never executes");

  const pkg = await makePackageFixture("pi-native-host-opaque");
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { piExecutable: shim })),
    /positive Node-entry shebang/,
    "descriptor preparation also rejects an opaque launcher before publication",
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "rejected shell entrypoints publish no profile files");
});

test("prepareNativeLaunch enforces the NODE_OPTIONS bound in real UTF-8 bytes (unicode values)", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // 2750 astral-plane chars = 11000 UTF-8 bytes, but only 2750 UTF-16 units:
  // a length-based check would wrongly accept this value.
  const unicodeOpts = "\u{1F600}".repeat(2750);
  assert.ok(Buffer.byteLength(unicodeOpts, "utf8") > MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.ok(unicodeOpts.length < MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: unicodeOpts } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("UTF-8") && !message.includes(unicodeOpts.slice(0, 64));
    },
  );
});

test("prepareNativeLaunch role rejection diagnostics never echo the role flag value", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, [RUNTIME_ROLE_ENV]: "secret-worker-token" } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(RUNTIME_ROLE_ENV) && !message.includes("secret-worker-token");
    },
  );
});

test("prepareNativeLaunch validates the config through a bounded, non-blocking, secret-safe read", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));

  // A regular-target symlink is admitted (profile registry may stage it).
  const linkedTarget = join(pkg.root, "real-config.json");
  await writeFile(linkedTarget, JSON.stringify({ enabled: true, review: { activeReviewers: [] } }), "utf8");
  rmSync(pkg.configPath);
  await symlink(linkedTarget, pkg.configPath);
  const descriptor = prepareNativeLaunch(baseOptions(pkg));
  assert.equal(descriptor.env.PI_REVIEW_GATE_CONFIG, pkg.configPath);

  // A malformed config containing a private API-key marker rejects with a
  // generic, path-only diagnostic: modern V8 JSON.parse errors embed input
  // snippets, which must never be echoed.
  const malformed = '{ "leaked": "sk-private-API-KEY-marker", invalid';
  await rm(pkg.configPath);
  await writeFile(pkg.configPath, malformed, "utf8");
  try {
    prepareNativeLaunch(baseOptions(pkg));
    assert.fail("malformed config must reject");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /not valid JSON/);
    assert.doesNotMatch(message, /sk-private-API-KEY-marker/, "config content is never echoed");
    assert.doesNotMatch(message, /leaked/);
    assert.ok(!message.includes("Unexpected token"), "no parser error snippet survives");
  }

  // A FIFO at the config path is rejected without blocking, through a direct
  // link or a symlink pointing at a FIFO.
  await rm(pkg.configPath);
  const fifo = join(pkg.root, "config-fifo");
  execFileSync("mkfifo", [fifo]);
  await symlink(fifo, pkg.configPath);
  const started = Date.now();
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    (error: unknown) => (error instanceof Error ? /not a regular file/.test(error.message) : false),
    "a FIFO-target config symlink must be rejected",
  );
  assert.ok(Date.now() - started < 10_000, "the FIFO-target config must reject without blocking");
  assert.equal((await stat(fifo)).isFIFO(), true, "the FIFO target is untouched");
});

test("prepareNativeLaunch prevalidates symlinked skill directories before ANY mkdir (external tree untouched)", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  // Profile-registry-style setup: the skills root exists, and the orchestrator
  // skill directory is a symlink aliasing an EXTERNAL directory that does not
  // contain the expected "references" child. The earlier behavior (mkdir
  // before the symlink precheck) would have created <external>/references
  // before rejecting.
  const outside = join(pkg.root, "external-target");
  await mkdir(outside, { recursive: true });
  await mkdir(pkg.skillsRoot, { recursive: true });
  await symlink(outside, join(pkg.skillsRoot, "pi-review-gate-orchestrator"));
  const before = await (await import("node:fs/promises")).readdir(outside);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg)),
    /refusing to publish the native skills through a symlinked path component/,
  );
  assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), before, "the external target tree is unchanged");
  assert.equal(existsSync(join(outside, "references")), false, "no references directory was created through the alias");
  assert.equal(existsSync(join(outside, "SKILL.md")), false, "no skill file leaked into the external target");
  // No partial publication: later plan members were not written either.
  assert.equal(existsSync(join(pkg.skillsRoot, "pi-review-gate-execution", "SKILL.md")), false);
  assert.equal(existsSync(join(pkg.skillsRoot, "pi-review-gate-research", "SKILL.md")), false);
});

test("the restoration-frame bound covers the SERIALIZED sidecar in UTF-8 bytes, at exact boundaries", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));

  // Boundary A: whitespace-only options — an accepted original produces a
  // frame that exactly reaches (never exceeds) the 8 KiB restore cap.
  // JSON overhead for {"original":""} is 15 bytes, value bytes plain.
  const fitsExactly = " ".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES - 15);
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: fitsExactly }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES,
    "test precondition: the frame sits exactly at the cap",
  );
  const ok = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: fitsExactly },
  }));
  assert.equal(Buffer.byteLength(ok.env[NODE_OPTIONS_RESTORE_ENV]!, "utf8"), MAX_NATIVE_NODE_OPTIONS_BYTES);
  assert.ok(ok.env.NODE_OPTIONS!.startsWith(`--require="${join(pkg.packageRoot, "dist", "src", "session-host", "bootstrap-preload.js")}"`));
  const oneOver = " ".repeat(MAX_NATIVE_NODE_OPTIONS_BYTES - 14);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: oneOver } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("restore cap") && !message.includes(oneOver);
    },
  );

  // Boundary B: escape-heavy options — every quote/backslash grows the
  // serialized frame beyond the original's byte count.
  const escapesFit = Array.from({ length: 4088 }, () => "\\").join("");
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: escapesFit }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES - 1,
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify({ original: `${escapesFit}\\` }), "utf8"),
    MAX_NATIVE_NODE_OPTIONS_BYTES + 1,
  );
  const okEscaped = prepareNativeLaunch(baseOptions(pkg, {
    env: { PATH: process.env.PATH, NODE_OPTIONS: escapesFit },
  }));
  assert.equal(
    (JSON.parse(okEscaped.env[NODE_OPTIONS_RESTORE_ENV]!) as { original: string }).original,
    escapesFit,
    "escape-heavy original is preserved byte-exact through the sidecar",
  );
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, NODE_OPTIONS: `${escapesFit}\\` } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("restore cap") && !message.includes(escapesFit);
    },
  );
});

test("the version probe parses the official stdout format only; stderr never rescues an unsupported CLI", async (t) => {
  const fixture = await makePiFixture("1.0.4");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  // An older-version (plus noise) stdout cannot be rescued by a valid-looking
  // newer version on stderr: the CLI's real version is the stdout identity.
  await writeFile(
    join(fixture.bin, "pi"),
    `#!${process.execPath}\nprocess.stdout.write('pi 1.0.3\\nnoise-output\\n'); process.stderr.write('pi 1.0.4\\n');\n`,
    "utf8",
  );
  await chmod(join(fixture.bin, "pi"), 0o755);
  try {
    resolveNativePi({ executable: "pi", env: { PATH: `${fixture.bin}:${process.env.PATH}` } });
    assert.fail("noisy stdout must never be rescued by stderr");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /official version format/);
    assert.doesNotMatch(message, /1\.0\.3/, "the stdout content is never echoed");
    assert.doesNotMatch(message, /1\.0\.4/, "the stderr content is never echoed");
    assert.doesNotMatch(message, /noise-output/);
  }
  // Empty stdout is likewise unparseable-strict, whatever stderr says.
  const fixture2 = await makePiFixture("1.0.4");
  t.after(() => rm(fixture2.root, { recursive: true, force: true }));
  await writeFile(join(fixture2.bin, "pi"), `#!${process.execPath}\nprocess.stderr.write('pi 1.0.4\\n');\n`, "utf8");
  await chmod(join(fixture2.bin, "pi"), 0o755);
  assert.throws(
    () => resolveNativePi({ executable: "pi", env: { PATH: `${fixture2.bin}:${process.env.PATH}` } }),
    /official version format/,
  );
});

test("prepareNativeLaunch rejects parent startup session overrides before any publication", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const cases: Array<{ args: string[]; flag: string; secret?: string }> = [
    { args: ["--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
    { args: ["--session=/sensitive/path"], flag: "--session", secret: "/sensitive/path" },
    { args: ["--continue"], flag: "--continue" },
    { args: ["-c"], flag: "-c" },
    { args: ["--resume"], flag: "--resume" },
    { args: ["-r"], flag: "-r" },
    { args: ["--session-id", "id-secret"], flag: "--session-id", secret: "id-secret" },
    { args: ["--fork", "id-secret"], flag: "--fork", secret: "id-secret" },
    { args: ["--session-dir", "/storage/secret"], flag: "--session-dir", secret: "/storage/secret" },
    { args: ["--no-session"], flag: "--no-session" },
    // --scheduler removal shifts native boundaries: Pi would see
    // `--system-prompt -- --session …` with a live session option.
    { args: ["--system-prompt", "--scheduler", "--", "--session", "/tmp/old.jsonl"], flag: "--session", secret: "/tmp/old.jsonl" },
  ];
  for (const entry of cases) {
    assert.throws(
      () => prepareNativeLaunch(baseOptions(pkg, { args: entry.args })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(entry.flag));
        if (entry.secret) assert.ok(!message.includes(entry.secret), "diagnostic must not leak override content");
        return true;
      },
      entry.flag,
    );
  }
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication for rejected startup overrides");
});

test("prepareNativeLaunch rejects a nonempty inherited session-dir env override before any publication", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "private-storage") } })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("PI_CODING_AGENT_SESSION_DIR") && !message.includes(join(pkg.root, "private-storage"));
    },
  );
  assert.equal(existsSync(pkg.skillsRoot), false, "no skill publication for a rejected session-dir override");
  // An empty inherited value is benign and passes through untouched.
  const descriptor = prepareNativeLaunch(baseOptions(pkg, { env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: "" } }));
  assert.equal(descriptor.env.PI_CODING_AGENT_SESSION_DIR, "");
});

test("prepareNativeLaunch admits value lookalikes and native -- data byte-for-byte", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  for (const args of [
    ["--model", "--session"],
    ["--system-prompt", "--session"],
    ["--", "--session", "/tmp/old.jsonl"],
  ]) {
    const descriptor = prepareNativeLaunch(baseOptions(pkg, { args }));
    assert.deepEqual(descriptor.args.slice(4), args, "native arguments are forwarded byte-for-byte");
  }
});

interface CompiledLaunchModule {
  prepareNativeLaunch(options: Record<string, unknown>): unknown;
}

/**
 * Non-recursive teardown for the anchor-fixture trees: only the EXPLICIT owned
 * file paths are unlinked and the known directories are removed leaf-to-root.
 * No recursive scan or descent of any kind (the .terraform-pruning rule
 * applies to synthetic roots too); unknown content surfaces as an honest
 * rmdir error instead of being deleted.
 */
function removeOwnedFixtureTree(root: string, files: string[], dirsLeafToRoot: string[]): void {
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const dir of dirsLeafToRoot) {
    rmdirSync(dir); // non-empty (unknown content) rejects honestly
  }
}

// ---------------------------------------------------------------------------
// Deliberate per-child saved-session selection (issue 323)
// ---------------------------------------------------------------------------

/** Synthetic flat listAll for launch tests: .jsonl files of one directory only. */
async function flatListAll(sessionDir: string): Promise<{ path: string; id: string; cwd: string }[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true });
  const rows: { path: string; id: string; cwd: string }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const file = join(sessionDir, entry.name);
    const text = await readFile(file, "utf8");
    const firstLine = text.split("\n")[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.cwd !== "string") continue;
    rows.push({ path: file, id: record.id, cwd: record.cwd });
  }
  return rows;
}

/** Create one saved conversation under the fixture agent dir and admit it. */
async function admitFixtureSavedSession(pkg: PackageFixture, id = "saved-1"): Promise<{ savedFile: string; admission: SavedSessionAdmission }> {
  const projDir = join(pkg.agentDir, "sessions", "proj");
  await mkdir(projDir, { recursive: true });
  const savedFile = join(projDir, "saved.jsonl");
  await writeFile(savedFile, `${JSON.stringify({ type: "session", id, cwd: pkg.workspace })}\n`, "utf8");
  const catalog = await listSavedSessions({ agentDir: pkg.agentDir, listAll: flatListAll });
  const result = admitSavedSession(catalog, catalog.rows[0]);
  assert.equal(result.status, "admitted", "the fixture saved session must admit");
  if (result.status !== "admitted") throw new Error("unreachable");
  return { savedFile, admission: result.admission };
}

function nativeLaunchEnv(pkg: PackageFixture): NodeJS.ProcessEnv {
  return {
    HOME: join(pkg.root, "home"),
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: pkg.agentDir,
  };
}

test("prepareNativeLaunch composes the exact --session option for an admitted saved selection (native mode)", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    "--session",
    savedFile,
  ], "the authorized --session <file> option follows the extensions and nothing else is injected");
  assert.equal(descriptor.cwd, pkg.workspace);
});

test("saved selection argument order snapshot: --session composes before any caller args", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["-p", "plan", "--", "message data"],
    savedSession: admission,
  }));
  // Snapshot: extensions first, then the authorized --session option in a
  // position that is ALWAYS an option position for the native parser, then
  // the caller args byte-for-byte (a genuine `--` still terminates options).
  assert.deepEqual(descriptor.args, [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
    "--session",
    savedFile,
    "-p",
    "plan",
    "--",
    "message data",
  ]);
});

test("saved selection composes in option position regardless of caller args that look like separators or values", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);
  const extensions = [
    "--extension",
    join(pkg.packageRoot, "dist", "src", "session-host", "reporter.js"),
    "--extension",
    join(pkg.packageRoot, "dist", "src", "index.js"),
  ];

  // A `--` that is the VALUE of a value-taking flag is not the separator:
  // composing before the caller args keeps --session in option position.
  let descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--model", "--", "message"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--model", "--", "message"]);

  // A trailing value-taking flag: our pair is never consumed as its value.
  descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--model"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--model"]);

  // A genuine separator: everything after it stays message/file data.
  descriptor = prepareNativeLaunch(baseOptions(pkg, {
    nativeSetup: true,
    env: nativeLaunchEnv(pkg),
    args: ["--", "data"],
    savedSession: admission,
  }));
  assert.deepEqual(descriptor.args, [...extensions, "--session", savedFile, "--", "data"]);
});

test("legacy profile mode rejects the native saved selection (no cross-setup copies)", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { admission } = await admitFixtureSavedSession(pkg);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { savedSession: admission })),
    /legacy profile mode does not accept a native saved-session selection/,
  );
});

test("parent startup overrides, raw --session args, and role env still reject with a saved selection present", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { admission } = await admitFixtureSavedSession(pkg);
  // Parent resume flags are rejected by the startup guard before composition.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), args: ["--resume"], savedSession: admission })),
    /--resume/,
  );
  // A raw --session in caller args is never an admission path.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), args: ["--session", "/tmp/old.jsonl"], savedSession: admission })),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("--session") && !message.includes("/tmp/old.jsonl");
    },
  );
  // Executor role input is still rejected fail-closed.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: { ...nativeLaunchEnv(pkg), [RUNTIME_ROLE_ENV]: "executor" }, savedSession: admission })),
    (error: unknown) => (error instanceof Error ? error.message.includes(RUNTIME_ROLE_ENV) : false),
  );
  // Legacy session-dir env override is still rejected before any selection work.
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { savedSession: admission, env: { PATH: process.env.PATH, PI_CODING_AGENT_SESSION_DIR: join(pkg.root, "private-storage") } })),
    /PI_CODING_AGENT_SESSION_DIR|legacy profile mode/,
  );
});

test("alien receipts and foreign agent directories are refused at launch", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { admission } = await admitFixtureSavedSession(pkg);
  // A caller-fabricated receipt object (no brand) is refused.
  const alien = { ...admission };
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: alien })),
    /not a valid admission receipt/,
  );
  // A receipt minted under a DIFFERENT native agent directory is refused.
  const foreignAgent = join(pkg.root, "home2", ".pi", "agent");
  const foreignProj = join(foreignAgent, "sessions", "proj");
  await mkdir(foreignProj, { recursive: true });
  await writeFile(join(foreignProj, "saved.jsonl"), `${JSON.stringify({ type: "session", id: "foreign-1", cwd: pkg.workspace })}\n`, "utf8");
  const foreignCatalog = await listSavedSessions({ agentDir: foreignAgent, listAll: flatListAll });
  const foreignResult = admitSavedSession(foreignCatalog, foreignCatalog.rows[0]);
  assert.equal(foreignResult.status, "admitted");
  if (foreignResult.status !== "admitted") throw new Error("unreachable");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: foreignResult.admission })),
    /different native agent directory/,
  );
});

test("launch revalidates the saved file before spawn: replacement, deletion, and identity change refuse", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { savedFile, admission } = await admitFixtureSavedSession(pkg);

  // Replaced first line (different id): the live header no longer matches.
  await writeFile(savedFile, `${JSON.stringify({ type: "session", id: "replaced-1", cwd: pkg.workspace })}\n`, "utf8");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /no longer matches its admission/,
  );

  // Deleted file: refused honestly.
  await rm(savedFile);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /saved-session file is missing/,
  );

  // Re-created with identical content but a NEW identity (dev/ino changed):
  // mtime immutability is never pretended; the identity check refuses.
  await writeFile(savedFile, `${JSON.stringify({ type: "session", id: "saved-1", cwd: pkg.workspace })}\n`, "utf8");
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /changed since admission/,
  );

  // A symlink at the admitted path is refused.
  const target = join(pkg.root, "saved-target.jsonl");
  await writeFile(target, `${JSON.stringify({ type: "session", id: "saved-1", cwd: pkg.workspace })}\n`, "utf8");
  await rm(savedFile);
  await symlink(target, savedFile);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /saved-session file is a symlink/,
  );
});

test("saved selection is bound to its admitted workspace: mismatched and retargeted workspaces refuse before spawn", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { admission } = await admitFixtureSavedSession(pkg);

  // A receipt for workspace A never launches in workspace B.
  const otherWorkspace = join(pkg.root, "other-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), workspace: otherWorkspace, savedSession: admission })),
    /different workspace than this launch/,
  );

  // The admitted workspace retargeted to a different directory (symlink
  // swap) no longer resolves to the canonical workspace bound at admission.
  const target = join(pkg.root, "workspace-target");
  await mkdir(target, { recursive: true });
  await rm(pkg.workspace, { recursive: true });
  await symlink(target, pkg.workspace);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /changed since admission/,
  );
});

test("launch revalidates the sessions path structure: a project directory swapped for a symlink refuses before spawn", async (t) => {
  const pkg = await makePackageFixture();
  t.after(() => rm(pkg.root, { recursive: true, force: true }));
  const { admission } = await admitFixtureSavedSession(pkg);

  // Move the project directory outside the sessions root and replace it with
  // a symlink: the file's inode and header identity are preserved, but the
  // canonical location now escapes the native sessions root.
  const projDir = join(pkg.agentDir, "sessions", "proj");
  const moved = join(pkg.root, "moved-proj");
  await rename(projDir, moved);
  await symlink(moved, projDir);
  assert.throws(
    () => prepareNativeLaunch(baseOptions(pkg, { nativeSetup: true, env: nativeLaunchEnv(pkg), savedSession: admission })),
    /outside the native agent sessions root/,
  );
});

test("the startup options helper resolves only the own compiled package scripts (no ancestor fallback)", async (t) => {
  const compiledLaunch = join(process.cwd(), "dist-test", "src", "session-host", "launch.js");
  const compiledConfigPath = join(process.cwd(), "dist-test", "src", "config-path.js");
  const compiledSavedSessions = join(process.cwd(), "dist-test", "src", "session-host", "saved-sessions.js");
  const compiledNativeSessionSdk = join(process.cwd(), "dist-test", "src", "session-host", "native-session-sdk.js");
  assert.ok(existsSync(compiledLaunch), "the compiled launch module under test must exist");
  assert.ok(existsSync(compiledConfigPath), "the compiled native config-path helper must exist");
  assert.ok(existsSync(compiledSavedSessions), "the compiled saved-session catalog module must exist");
  assert.ok(existsSync(compiledNativeSessionSdk), "the compiled public SDK loader module must exist");

  // Tree A: the own package scripts/ is missing, but a MALICIOUS ancestor
  // scripts/ helper exists. The loader must reject fail-closed without ever
  // loading it (no profile/skills work runs before the helper gate).
  const rootA = await realpath(await mkdtemp(join(process.cwd(), ".pi-native-host-anchor-a-")));
  const markerA = join(rootA, "parent-helper-loaded");
  t.after(() => removeOwnedFixtureTree(rootA, [
    join(rootA, "node_modules", "pi-review-gate", "dist", "src", "session-host", "launch.js"),
    join(rootA, "node_modules", "pi-review-gate", "dist", "src", "session-host", "saved-sessions.js"),
    join(rootA, "node_modules", "pi-review-gate", "dist", "src", "session-host", "native-session-sdk.js"),
    join(rootA, "node_modules", "pi-review-gate", "dist", "src", "config-path.js"),
    join(rootA, "scripts", "session-host-startup-options.cjs"),
    markerA,
  ], [
    join(rootA, "node_modules", "pi-review-gate", "dist", "src", "session-host"),
    join(rootA, "node_modules", "pi-review-gate", "dist", "src"),
    join(rootA, "node_modules", "pi-review-gate", "dist"),
    join(rootA, "node_modules", "pi-review-gate"),
    join(rootA, "node_modules"),
    join(rootA, "scripts"),
    rootA,
  ]));
  const pkgA = join(rootA, "node_modules", "pi-review-gate");
  const distA = join(pkgA, "dist", "src", "session-host");
  await mkdir(distA, { recursive: true });
  await cp(compiledLaunch, join(distA, "launch.js"));
  await cp(compiledSavedSessions, join(distA, "saved-sessions.js"));
  await cp(compiledNativeSessionSdk, join(distA, "native-session-sdk.js"));
  await cp(compiledConfigPath, join(pkgA, "dist", "src", "config-path.js"));
  await mkdir(join(rootA, "scripts"), { recursive: true });
  await writeFile(
    join(rootA, "scripts", "session-host-startup-options.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(markerA)}, "loaded");\nmodule.exports = { assertSessionHostStartupOptions: () => undefined };\n`,
    "utf8",
  );
  const launchA = require(join(distA, "launch.js")) as CompiledLaunchModule;
  assert.throws(
    () => launchA.prepareNativeLaunch({ packageRoot: pkgA, agentDir: join(pkgA, "missing-agent-dir"), workspace: join(pkgA, "missing-workspace"), piExecutable: join(pkgA, "missing-bin", "pi"), args: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Bounded diagnostic: fixed filename only, never the fixture path.
      return message.includes("session-host-startup-options.cjs") && !message.includes(rootA);
    },
  );
  assert.equal(existsSync(markerA), false, "an ancestor scripts/ helper is never loaded");

  // Tree B: the own scripts/ is present -> the helper loads and admission runs.
  const rootB = await realpath(await mkdtemp(join(process.cwd(), ".pi-native-host-anchor-b-")));
  t.after(() => removeOwnedFixtureTree(rootB, [
    join(rootB, "node_modules", "pi-review-gate", "dist", "src", "session-host", "launch.js"),
    join(rootB, "node_modules", "pi-review-gate", "dist", "src", "session-host", "saved-sessions.js"),
    join(rootB, "node_modules", "pi-review-gate", "dist", "src", "session-host", "native-session-sdk.js"),
    join(rootB, "node_modules", "pi-review-gate", "dist", "src", "config-path.js"),
    join(rootB, "node_modules", "pi-review-gate", "scripts", "session-host-startup-options.cjs"),
  ], [
    join(rootB, "node_modules", "pi-review-gate", "dist", "src", "session-host"),
    join(rootB, "node_modules", "pi-review-gate", "dist", "src"),
    join(rootB, "node_modules", "pi-review-gate", "dist"),
    join(rootB, "node_modules", "pi-review-gate", "scripts"),
    join(rootB, "node_modules", "pi-review-gate"),
    join(rootB, "node_modules"),
    rootB,
  ]));
  const pkgB = join(rootB, "node_modules", "pi-review-gate");
  const distB = join(pkgB, "dist", "src", "session-host");
  await mkdir(distB, { recursive: true });
  await cp(compiledLaunch, join(distB, "launch.js"));
  await cp(compiledSavedSessions, join(distB, "saved-sessions.js"));
  await cp(compiledNativeSessionSdk, join(distB, "native-session-sdk.js"));
  await cp(compiledConfigPath, join(pkgB, "dist", "src", "config-path.js"));
  await mkdir(join(pkgB, "scripts"), { recursive: true });
  await cp(join(process.cwd(), "scripts", "session-host-startup-options.cjs"), join(pkgB, "scripts", "session-host-startup-options.cjs"));
  const launchB = require(join(distB, "launch.js")) as CompiledLaunchModule;
  assert.throws(
    () => launchB.prepareNativeLaunch({ packageRoot: pkgB, agentDir: join(pkgB, "missing-agent-dir"), workspace: join(pkgB, "missing-workspace"), piExecutable: join(pkgB, "missing-bin", "pi"), args: ["--session", "/tmp/old.jsonl"] }),
    /startup override is not accepted: --session/,
  );
});
