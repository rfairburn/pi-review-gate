/**
 * Issue #653: managed local session creation reloads the saved review-gate
 * configuration from disk at each child's own startup.
 *
 * Child-freshness evidence (real processes): the production
 * LocalOwningHostService opens the production InstanceManager with Main's
 * production broker adapter over a real Unix-socket StatusBroker, the
 * production NativeAgentRegistry native setup, and the default PTY factory
 * (pinned node-pty). New is `hostService.startSession`; SessionSpawn is a real
 * authenticated `spawn_request` frame sent by the live parent child with its
 * own one-shot bootstrap token, routed by the broker to the manager's
 * `onSpawnRequest`, wired to `hostService.spawnRequestedChild` exactly as Main
 * wires it. Each child is the controlled stand-in
 * tests/fixtures/session-host-persisted-defaults-child.cjs: a Node "pi" that
 * runs under the real session-host bootstrap preload and calls the production
 * compiled `loadConfig()` (the gate extension's own zero-argument call) from
 * the compiled module tree the descriptor names, then records what it loaded.
 *
 * NOT covered here: the installed native Pi CLI, the gate extension's full
 * activation, the Settings menu UI (draft, cancel, Save, reopen), the Pi
 * SessionSpawn tool surface inside a model turn, and Main's routed
 * (`spawn_routed_request`) handler. Everything uses an owned synthetic HOME,
 * agent directory, workspaces, and config files; no provider, model, network,
 * real user configuration, or live session is touched.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createStatusBroker, type StatusBroker } from "../src/session-host/broker";
import { InstanceManager, type InstanceManagerOptions } from "../src/session-host/instances";
import { __test as mainTest } from "../src/session-host/main";
import { createLocalOwningHostService, type OwningHostService } from "../src/session-host/owning-host-service";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import {
  MANAGED_CONFIG_OVERRIDE_ENV,
  managedConfigOverrideWarning,
  resolveManagedConfigOverride,
} from "../src/session-host/startup-config-override";
import { updateReviewGateConfig } from "../src/settings/persistence";
import { closeWithSignal, createHarness, started } from "./helpers/session-host-main-harness";

const CHILD_FIXTURE = join(__dirname, "..", "..", "tests", "fixtures", "session-host-persisted-defaults-child.cjs");
const COMPILED_SRC = realpathSync(join(__dirname, "..", "src"));
const CONTROL_ENV = "PRG_PERSISTED_DEFAULTS_CONTROL";

// --- Managed startup canonicalization helper (pure). ---

test("a relative managed override resolves once against the startup directory into a detached env copy", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/synthetic-home", [MANAGED_CONFIG_OVERRIDE_ENV]: "conf/review-gate.json", OTHER: "kept" };
  const before = { ...env };
  const result = resolveManagedConfigOverride(env, "/launch/dir", "linux");
  assert.deepEqual(env, before, "the caller's environment object is never mutated");
  assert.notEqual(result.env, env, "a detached copy is returned");
  assert.equal(result.env[MANAGED_CONFIG_OVERRIDE_ENV], "/launch/dir/conf/review-gate.json");
  assert.equal(result.env.OTHER, "kept");
  assert.deepEqual(result.relative, { original: "conf/review-gate.json", resolved: "/launch/dir/conf/review-gate.json" });
  assert.match(managedConfigOverrideWarning(result.relative!), /relative path.*"\/launch\/dir\/conf\/review-gate\.json"/);

  for (const value of ["./x.json", "../up/x.json", "~/literal-tilde.json"]) {
    assert.equal(resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: value }, "/launch/dir", "darwin").env[MANAGED_CONFIG_OVERRIDE_ENV],
      resolve("/launch/dir", value), "loadConfig never expands tilde, so it is resolved literally like any relative path");
  }
});

test("absolute, empty, and absent managed overrides pass through unchanged without a warning", () => {
  for (const env of [
    { [MANAGED_CONFIG_OVERRIDE_ENV]: "/abs/review-gate.json" },
    { [MANAGED_CONFIG_OVERRIDE_ENV]: "" },
    {},
  ] as NodeJS.ProcessEnv[]) {
    const result = resolveManagedConfigOverride(env, "/launch/dir", "linux");
    assert.deepEqual(result.env, env);
    assert.equal(result.relative, undefined);
  }
  const windows = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: "C:\\cfg\\rg.json" }, "D:\\launch", "win32");
  assert.equal(windows.env[MANAGED_CONFIG_OVERRIDE_ENV], "C:\\cfg\\rg.json");
  assert.equal(windows.relative, undefined);
  const windowsRelative = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: "cfg\\rg.json" }, "D:\\launch", "win32");
  assert.equal(windowsRelative.env[MANAGED_CONFIG_OVERRIDE_ENV], "D:\\launch\\cfg\\rg.json");
});

test("Windows fully qualified overrides pass through while root-relative spellings resolve once against the startup drive", () => {
  // Drive-qualified and UNC/device paths name one file whatever a child's drive is.
  for (const value of ["C:\\cfg\\rg.json", "c:/cfg/rg.json", "\\\\server\\share\\rg.json", "//server/share/rg.json", "\\\\?\\C:\\cfg\\rg.json"]) {
    const result = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: value }, "C:\\launch", "win32");
    assert.equal(result.env[MANAGED_CONFIG_OVERRIDE_ENV], value, `${value} is unchanged`);
    assert.equal(result.relative, undefined, `${value} does not warn`);
  }
  // Rooted but drive-relative: win32.isAbsolute accepts these, yet a child on
  // another drive would read a different file, so they resolve to the startup drive.
  for (const value of ["\\cfg\\rg.json", "/cfg/rg.json"]) {
    const result = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: value }, "C:\\launch", "win32");
    assert.equal(result.env[MANAGED_CONFIG_OVERRIDE_ENV], "C:\\cfg\\rg.json", `${value} pins the startup drive`);
    assert.deepEqual(result.relative, { original: value, resolved: "C:\\cfg\\rg.json" }, `${value} warns`);
    const elsewhere = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: value }, "D:\\other\\launch", "win32");
    assert.equal(elsewhere.env[MANAGED_CONFIG_OVERRIDE_ENV], "D:\\cfg\\rg.json", "the drive comes from the startup directory");
  }
  // POSIX rooted paths remain absolute.
  assert.equal(resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: "/cfg/rg.json" }, "/launch", "linux").relative, undefined);
});

// --- Main applies the canonicalization to its one startup snapshot. ---

test("Main hands every startup consumer the startup-resolved absolute override, warns, and still starts", async (t) => {
  const seen: Record<string, string | undefined> = {};
  const callerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/synthetic-home", [MANAGED_CONFIG_OVERRIDE_ENV]: "relative/review-gate.json" };
  const callerEnvBefore = { ...callerEnv };
  const expected = resolve(process.cwd(), "relative/review-gate.json");
  const harness = createHarness({ env: callerEnv }, {
    resolvePi: ({ executable, env }) => {
      seen.resolvePi = env[MANAGED_CONFIG_OVERRIDE_ENV];
      return { file: executable ?? "/synthetic/pi", version: "1.0.4" };
    },
    nativeCliHosting: (env) => {
      seen.nativeCliHosting = env[MANAGED_CONFIG_OVERRIDE_ENV];
      return { targets: [] };
    },
  });
  const manager = await started(harness);
  t.after(async () => { await closeWithSignal(harness); });
  seen.manager = (manager.options as InstanceManagerOptions).env?.[MANAGED_CONFIG_OVERRIDE_ENV];
  assert.deepEqual(seen, { resolvePi: expected, nativeCliHosting: expected, manager: expected },
    "Pi resolution, native hosting, and the manager (New + SessionSpawn creates) all see one absolute path");
  assert.deepEqual(callerEnv, callerEnvBefore, "the caller's env object is preserved");
  assert.deepEqual(harness.reports, [managedConfigOverrideWarning({ original: "relative/review-gate.json", resolved: expected })],
    "the relative case warns once and is not refused");
});

test("Main leaves an absolute override and the session setup env byte-identical with no warning", async (t) => {
  let setupEnv: NodeJS.ProcessEnv | undefined;
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: "/synthetic-home", [MANAGED_CONFIG_OVERRIDE_ENV]: "/abs/review-gate.json" } }, {
    createSessionSetup: ({ env }) => {
      setupEnv = env;
      return {
        nativeSetup: false,
        nativeAgentDir: harness.agentDir,
        profileRegistry: { prepare: () => { throw new Error("not used"); } },
      };
    },
  });
  const manager = await started(harness);
  t.after(async () => { await closeWithSignal(harness); });
  assert.equal(setupEnv?.[MANAGED_CONFIG_OVERRIDE_ENV], "/abs/review-gate.json");
  assert.equal((manager.options as InstanceManagerOptions).env?.[MANAGED_CONFIG_OVERRIDE_ENV], "/abs/review-gate.json");
  assert.deepEqual(harness.reports, []);
});

// --- Real managed children: New and SessionSpawn reload saved disk defaults. ---

interface ChildRecord {
  pid: number;
  instanceId: string;
  bootstrapPrimed: boolean;
  bootstrapEnvRemaining: boolean;
  cwd: string;
  args: string[];
  env: Record<string, string | null>;
  loadedPath: string | null;
  marker: string | null;
  disabledReason: string | null;
}

interface LiveRecord {
  pid: number;
  outcome?: string;
  loadedPath: string | null;
  marker: string | null;
}

interface Host {
  root: string;
  home: string;
  agentDir: string;
  canonical: string;
  fallback: string;
  control: string;
  env: NodeJS.ProcessEnv;
  hostService: OwningHostService;
  manager: InstanceManager;
  workspace(name: string): string;
  startNew(workspace: string): Promise<ChildRecord>;
  spawnFrom(parent: ChildRecord, workspace: string, title: string): Promise<{ outcome: string; parentLive: LiveRecord; child?: ChildRecord }>;
  report(child: ChildRecord): Promise<LiveRecord>;
  records(): string[];
}

function configDocument(marker: string): string {
  return `${JSON.stringify({ web: { fetch: { userAgent: marker } } }, null, 2)}\n`;
}

async function until<T>(read: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 40));
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Owned synthetic package root whose compiled tree is this build's dist-test/src. */
function packageFixture(root: string): { packageRoot: string; piExecutable: string } {
  const packageRoot = join(root, "pkg");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  symlinkSync(COMPILED_SRC, join(packageRoot, "dist", "src"), "dir");
  const piExecutable = join(root, "bin", "pi");
  mkdirSync(dirname(piExecutable), { recursive: true });
  writeFileSync(piExecutable, `#!/usr/bin/env node\n"use strict";\nrequire(${JSON.stringify(CHILD_FIXTURE)});\n`, "utf8");
  chmodSync(piExecutable, 0o755);
  return { packageRoot, piExecutable };
}

async function startHost(
  t: TestContext,
  setup: { args?: readonly string[]; env?: (paths: { root: string; home: string; agentDir: string }) => NodeJS.ProcessEnv } = {},
): Promise<Host> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-653-")));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const control = join(root, "control");
  mkdirSync(join(control, "records"), { recursive: true });
  mkdirSync(join(control, "commands"), { recursive: true });
  const { packageRoot, piExecutable } = packageFixture(root);
  // An explicit minimal environment: nothing from the operator's real HOME,
  // configuration, role markers, or provider credentials reaches a child.
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    [CONTROL_ENV]: control,
    ...setup.env?.({ root, home, agentDir }),
  };
  const envBefore = { ...env };
  const broker: StatusBroker = await createStatusBroker({ socketRoot: realpathSync(tmpdir()) });
  const hostService = createLocalOwningHostService({
    createManager: (options) => new InstanceManager(options),
    teardownRequested: () => false,
  });
  const registry = new NativeAgentRegistry({ env });
  const manager = hostService.openManager({
    packageRoot,
    piExecutable,
    statusRegistrar: mainTest.statusRegistrar(broker),
    nativeSetup: true,
    profileRegistry: registry,
    args: setup.args ?? [],
    env,
    cols: 100,
    rows: 30,
    onSpawnRequest: (parentInstanceId, request) => hostService.spawnRequestedChild(parentInstanceId, request),
  }) as InstanceManager;
  t.after(async () => {
    await manager.shutdown({ graceMs: 1_000, killMs: 2_000 });
    await broker.dispose();
    assert.deepEqual(env, envBefore, "the host's startup env snapshot is never mutated by launches");
    // Remove the owned fixture only on positive evidence no child still runs in it.
    if (!manager.hasLiveProcesses()) rmSync(root, { recursive: true, force: true });
  });

  let seq = 0;
  const recordPath = (name: string) => join(control, "records", name);
  const command = (child: ChildRecord, body: Record<string, unknown>) => {
    const file = join(control, "commands", `${child.instanceId}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(body));
    // Atomic publication so the child never reads a partial command.
    renameSync(`${file}.tmp`, file);
  };
  const host: Host = {
    root,
    home,
    agentDir,
    canonical: join(agentDir, "review-gate.json"),
    fallback: join(home, ".config", "pi-review-gate", "config.json"),
    control,
    env,
    hostService,
    manager,
    workspace(name) {
      const path = join(root, "workspaces", name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    async startNew(workspace) {
      const outcome = await hostService.startSession({ workspace });
      assert.equal(outcome.status, "started", "the local New create starts a real child");
      const id = (outcome as { id: string }).id;
      return until(() => readJson<ChildRecord>(recordPath(`${id}.startup.json`)), `New child ${id} startup record`);
    },
    async spawnFrom(parent, workspace, title) {
      const before = new Set(manager.list().map((row) => row.id));
      seq += 1;
      const mine = seq;
      command(parent, { type: "spawn", seq: mine, workspace, title, prompt: `fixture prompt ${mine}` });
      const parentLive = await until(() => readJson<LiveRecord>(recordPath(`${parent.instanceId}.spawn-${mine}.json`)), "parent spawn result");
      const outcome = parentLive.outcome ?? "missing";
      const created = manager.list().map((row) => row.id).filter((id) => !before.has(id));
      if (outcome !== "started") return { outcome, parentLive };
      assert.equal(created.length, 1, "exactly one SessionSpawn child was created");
      const child = await until(() => readJson<ChildRecord>(recordPath(`${created[0]}.startup.json`)), "SessionSpawn child startup record");
      return { outcome, parentLive, child };
    },
    async report(child) {
      seq += 1;
      const mine = seq;
      command(child, { type: "report", seq: mine });
      return until(() => readJson<LiveRecord>(recordPath(`${child.instanceId}.report-${mine}.json`)), "live report");
    },
    records() {
      return readdirSync(join(control, "records")).filter((name) => name.endsWith(".startup.json"));
    },
  };
  return host;
}

function assertOrdinaryChild(host: Host, child: ChildRecord, workspace: string): void {
  assert.equal(child.bootstrapPrimed, true, "the real preload consumed this child's own bootstrap");
  assert.equal(child.bootstrapEnvRemaining, false, "the one-shot bootstrap is gone from the child environment");
  assert.equal(child.cwd, realpathSync(workspace), "the child runs in its own workspace");
  assert.equal(child.env.HOME, host.home);
  assert.equal(child.env.PI_CODING_AGENT_DIR, realpathSync(host.agentDir));
  assert.equal(child.env.PI_REVIEW_GATE_RUNTIME_ROLE, null, "no role authorization reaches a managed child");
  assert.equal(child.disabledReason, null);
}

function assertParentUnchanged(host: Host, parent: ChildRecord, live: LiveRecord, marker: string): void {
  assert.equal(live.pid, parent.pid, "the parent is the same live process");
  assert.equal(live.marker, marker, "the parent's live snapshot is unchanged");
  const row = host.manager.list().find((view) => view.id === parent.instanceId);
  assert.equal(row?.lifecycle, "alive", "the parent row is still alive");
  assert.equal(row?.hasLiveProcess, true);
  process.kill(parent.pid, 0); // throws if the parent process were gone
}

test("New and SessionSpawn children load the disk defaults current at their own startup; the live parent keeps B", async (t) => {
  const host = await startHost(t);

  // The parent starts while disk holds B and keeps B as its live snapshot.
  writeFileSync(host.canonical, configDocument("marker-B"), { mode: 0o600 });
  const parentWorkspace = host.workspace("parent");
  const parent = await host.startNew(parentWorkspace);
  assertOrdinaryChild(host, parent, parentWorkspace);
  assert.equal(parent.loadedPath, host.canonical);
  assert.equal(parent.marker, "marker-B");

  // Disk moves to A (another writer). An editor draft C exists only in memory
  // and is canceled, so nothing is written: disk stays A and no child sees C.
  writeFileSync(host.canonical, configDocument("marker-A"));
  const draftC = configDocument("marker-C");
  assert.notEqual(readFileSync(host.canonical, "utf8"), draftC);
  const afterCancelWorkspace = host.workspace("after-cancel");
  const afterCancel = await host.startNew(afterCancelWorkspace);
  assertOrdinaryChild(host, afterCancel, afterCancelWorkspace);
  assert.equal(afterCancel.marker, "marker-A", "a canceled draft never becomes effective for a new child");

  // Save D through the production settings save boundary (atomic rename).
  const inodeBefore = statSync(host.canonical).ino;
  await updateReviewGateConfig(host.canonical, (parsed) => {
    parsed.web = { fetch: { userAgent: "marker-D" } };
  });
  assert.notEqual(statSync(host.canonical).ino, inodeBefore, "Save replaced the file atomically");

  const newDWorkspace = host.workspace("new-d");
  const newD = await host.startNew(newDWorkspace);
  assertOrdinaryChild(host, newD, newDWorkspace);
  assert.equal(newD.loadedPath, host.canonical);
  assert.equal(newD.marker, "marker-D", "a New child loads the saved D");

  const spawnDWorkspace = host.workspace("spawn-d");
  const spawnD = await host.spawnFrom(parent, spawnDWorkspace, "Spawned after save D");
  assert.equal(spawnD.outcome, "started", "the authenticated SessionSpawn request started a local child");
  assert.ok(spawnD.child);
  assertOrdinaryChild(host, spawnD.child, spawnDWorkspace);
  assert.equal(spawnD.child.marker, "marker-D", "a SessionSpawn child loads the saved D");
  assert.deepEqual(spawnD.child.args.slice(-2), ["--name", "Spawned after save D"], "the fresh SessionSpawn argv composition is preserved");
  assertParentUnchanged(host, parent, spawnD.parentLive, "marker-B");
  assertParentUnchanged(host, parent, await host.report(parent), "marker-B");

  // Older children keep what they loaded; nothing was retrofitted.
  assert.equal((await host.report(afterCancel)).marker, "marker-A");

  // Another editor writes E in place; the next New and SessionSpawn load E.
  writeFileSync(host.canonical, configDocument("marker-E"));
  const newE = await host.startNew(host.workspace("new-e"));
  assert.equal(newE.marker, "marker-E");
  const spawnE = await host.spawnFrom(parent, host.workspace("spawn-e"), "Spawned after editor E");
  assert.equal(spawnE.outcome, "started");
  assert.equal(spawnE.child?.marker, "marker-E");
  assertParentUnchanged(host, parent, await host.report(parent), "marker-B");
  assert.equal((await host.report(newD)).marker, "marker-D");
});

test("an explicit absolute override keeps selecting that exact file for New and SessionSpawn children", async (t) => {
  let explicit = "";
  const host = await startHost(t, {
    env: ({ root }) => {
      explicit = join(root, "explicit", "chosen-review-gate.json");
      return { [MANAGED_CONFIG_OVERRIDE_ENV]: explicit };
    },
  });
  mkdirSync(dirname(explicit), { recursive: true });
  writeFileSync(explicit, configDocument("explicit-1"), { mode: 0o600 });
  writeFileSync(host.canonical, configDocument("canonical-ignored-1"), { mode: 0o600 });

  const parent = await host.startNew(host.workspace("parent"));
  assert.equal(parent.env.PI_REVIEW_GATE_CONFIG, explicit, "the override is passed through, never stripped");
  assert.equal(parent.loadedPath, explicit);
  assert.equal(parent.marker, "explicit-1");

  await updateReviewGateConfig(explicit, (parsed) => { parsed.web = { fetch: { userAgent: "explicit-2" } }; });
  writeFileSync(host.canonical, configDocument("canonical-ignored-2"));

  const fresh = await host.startNew(host.workspace("new"));
  assert.equal(fresh.loadedPath, explicit);
  assert.equal(fresh.marker, "explicit-2");
  const spawned = await host.spawnFrom(parent, host.workspace("spawn"), "Explicit spawn");
  assert.equal(spawned.outcome, "started");
  assert.equal(spawned.child?.env.PI_REVIEW_GATE_CONFIG, explicit);
  assert.equal(spawned.child?.loadedPath, explicit);
  assert.equal(spawned.child?.marker, "explicit-2");
  assertParentUnchanged(host, parent, await host.report(parent), "explicit-1");
});

test("a relative managed override is read from the one startup-resolved file in every child workspace", async (t) => {
  const relative = join("..", "launch-config", "relative-review-gate.json");
  let resolved = "";
  let startupDir = "";
  const host = await startHost(t, {
    env: ({ root }) => {
      // Exactly Main's startup step: one resolution against the host startup
      // directory, applied to the env snapshot every managed create uses.
      startupDir = join(root, "launch-dir");
      const result = resolveManagedConfigOverride({ [MANAGED_CONFIG_OVERRIDE_ENV]: relative }, startupDir);
      resolved = result.env[MANAGED_CONFIG_OVERRIDE_ENV] as string;
      return result.env;
    },
  });
  assert.equal(resolved, join(host.root, "launch-config", "relative-review-gate.json"));
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, configDocument("relative-1"), { mode: 0o600 });
  writeFileSync(host.canonical, configDocument("canonical-ignored"), { mode: 0o600 });

  // Decoy files at the workspace-relative spelling: a per-workspace resolution
  // would read these instead of the single startup-resolved file.
  const workspaces = ["parent", "new", "nested/deeper", "spawn-a", "spawn-b"].map((name) => host.workspace(name));
  for (const workspace of workspaces) {
    const decoy = resolve(workspace, relative);
    mkdirSync(dirname(decoy), { recursive: true });
    writeFileSync(decoy, configDocument(`decoy-${workspace}`));
  }

  const parent = await host.startNew(workspaces[0]);
  assert.equal(parent.env.PI_REVIEW_GATE_CONFIG, resolved);
  assert.equal(parent.marker, "relative-1");

  await updateReviewGateConfig(resolved, (parsed) => { parsed.web = { fetch: { userAgent: "relative-2" } }; });
  for (const workspace of workspaces.slice(1, 3)) {
    const child = await host.startNew(workspace);
    assert.equal(child.env.PI_REVIEW_GATE_CONFIG, resolved);
    assert.equal(child.loadedPath, resolved);
    assert.equal(child.marker, "relative-2", "every New child reads the startup-resolved file");
  }
  for (const workspace of workspaces.slice(3)) {
    const spawned = await host.spawnFrom(parent, workspace, "Relative spawn");
    assert.equal(spawned.outcome, "started");
    assert.equal(spawned.child?.loadedPath, resolved);
    assert.equal(spawned.child?.marker, "relative-2", "every SessionSpawn child reads the startup-resolved file");
  }
  assertParentUnchanged(host, parent, await host.report(parent), "relative-1");
});

test("implicit canonical-then-fallback discovery and --model launch args are re-evaluated per child", async (t) => {
  const host = await startHost(t, { args: ["--model", "fixture-provider/fixture-model"] });
  mkdirSync(dirname(host.fallback), { recursive: true });
  writeFileSync(host.fallback, configDocument("fallback-1"), { mode: 0o600 });

  const parent = await host.startNew(host.workspace("parent"));
  assert.equal(existsSync(host.canonical), false, "native setup never publishes a default over an existing fallback");
  assert.equal(parent.env.PI_REVIEW_GATE_CONFIG, null, "no override is invented");
  assert.equal(parent.loadedPath, host.fallback);
  assert.equal(parent.marker, "fallback-1");
  assert.deepEqual(parent.args.slice(-2), ["--model", "fixture-provider/fixture-model"]);

  await updateReviewGateConfig(host.fallback, (parsed) => { parsed.web = { fetch: { userAgent: "fallback-2" } }; });
  const fresh = await host.startNew(host.workspace("new"));
  assert.equal(fresh.loadedPath, host.fallback);
  assert.equal(fresh.marker, "fallback-2");
  assert.deepEqual(fresh.args.slice(-2), ["--model", "fixture-provider/fixture-model"]);
  const spawned = await host.spawnFrom(parent, host.workspace("spawn"), "Model spawn");
  assert.equal(spawned.outcome, "started");
  assert.equal(spawned.child?.marker, "fallback-2");
  assert.deepEqual(spawned.child?.args.slice(-4), ["--model", "fixture-provider/fixture-model", "--name", "Model spawn"]);

  // The canonical location appears: the next children prefer it.
  writeFileSync(host.canonical, configDocument("canonical-now"), { mode: 0o600 });
  const preferred = await host.startNew(host.workspace("preferred"));
  assert.equal(preferred.loadedPath, host.canonical);
  assert.equal(preferred.marker, "canonical-now");
  assertParentUnchanged(host, parent, await host.report(parent), "fallback-1");
});

for (const marker of ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"]) {
  test(`a host env carrying ${marker} still launches no managed child`, async (t) => {
    const host = await startHost(t, { env: () => ({ [marker]: marker.endsWith("ROLE") ? "executor" : "[\"read\"]" }) });
    writeFileSync(host.canonical, configDocument("never-loaded"), { mode: 0o600 });
    const outcome = await host.hostService.startSession({ workspace: host.workspace("refused") });
    assert.notEqual(outcome.status, "started");
    await new Promise((settle) => setTimeout(settle, 300));
    assert.deepEqual(host.records(), [], "no child process ever started");
    assert.equal(host.manager.hasLiveProcesses(), false);
  });
}
