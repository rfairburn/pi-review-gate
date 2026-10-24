/**
 * Native Windows ConPTY companion acceptance for Network storage (Refs #494).
 *
 * Same harness and opt-in as `session-host-native-windows-main.test.ts`: under
 * PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST=1 every missing prerequisite is a
 * hard failure, never a skip. The real public Main runs inside an owned outer
 * ConPTY against a task-created synthetic agent directory that this test broadens
 * with an inheritable Authenticated Users Modify grant (the earlier inherited
 * shape) through the fixed system `icacls`. It observes, through the actual
 * written frames: specific sanitized refusal reasons with Windows mitigation, the
 * explicit written repair confirmation, the persistent restart status, then a
 * deliberate restart with the same key and explicit Off values, and explicit
 * Hosting and Connect admission. The only listener and connection are
 * invocation-owned loopback ones on 127.0.0.1. No provider, clipboard, native
 * child session, or live profile is used. Nothing outside the fresh harness
 * root is inspected or modified, and every owned process is settled before that
 * exact root is removed.
 *
 * Two further cases observe the initial defaults through the same real written
 * frames, without binding or connecting anything: a FRESH synthetic agent
 * directory (no `session-host` at all, so the real Main creates it and must
 * create it private at creation) and a VALID pre-network base (an existing
 * private `session-host` holding only a valid host `keybindings.json` and an
 * empty `roster.json`). Each opens, reopens, and after a deliberate restart
 * opens Network again, and requires the unchanged defaults with no peers or
 * preferences directory, document, identity, or listener created by opening it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openPeerPreferencesStoreWithPermissions, DEFAULT_PEER_PREFERENCES } from "../src/session-host/network/peer-preferences-store";
import { openPeerStateStore } from "../src/session-host/network/peer-state";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import { inspectPeerStateAcl, verifyPrivateAclEvidence } from "../src/session-host/network/peer-state-windows-permissions";
import { createSessionHostStateDirectory } from "../src/session-host/roster-store";

import {
  WINDOWS_KEYS,
  WINDOWS_REQUIRE_ENV,
  WINDOWS_TEST_TIMEOUT_MS,
  WindowsMainPtyDriver,
  assertWindowsRuntimeFiles,
  createNativeAgentRoot,
  createOwnedDirectory,
  createWindowsHarnessRoot,
  denyAmbientNativeProjectTrust,
  probeWindowsPowerShell,
  resolveWindowsRuntime,
  writeOwnedFile,
  type WindowsRuntimePin,
} from "./helpers/session-host-native-windows-harness";

const optIn = process.env[WINDOWS_REQUIRE_ENV] === "1";
const AUTHENTICATED_USERS = "S-1-5-11";

function icacls(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot is unavailable on this Windows host");
  return join(systemRoot, "System32", "icacls.exe");
}

/** The right-hand pane text of the actual written frame, wrapped lines rejoined. */
function paneText(frame: string): string {
  return frame.split("\n").map((line) => {
    const divider = line.indexOf("│");
    return divider < 0 ? "" : line.slice(divider + 1).trimEnd();
  }).join(" ").replace(/\s+/gu, " ");
}

function highlighted(frame: string): string {
  for (const line of frame.split("\n")) {
    const divider = line.indexOf("│");
    const right = divider < 0 ? "" : line.slice(divider + 1);
    if (right.startsWith("> ")) return right;
  }
  return "";
}

function grantsAuthenticatedUsers(target: string): boolean {
  const observed = inspectPeerStateAcl(target);
  assert.ok(observed !== null, "the native helper observes this test's own fixture");
  return observed.evidence.aces.some((ace) => ace.sid === AUTHENTICATED_USERS && ace.aceType === "allow");
}

/**
 * Makes this account the owner of exactly the named objects this test just
 * created, through the fixed system `icacls`, then proves it from the native
 * helper's own evidence. An elevated runner token's default owner is the
 * built-in Administrators group, but the affected earlier profile was created
 * by this ordinary account; owning these fixture objects keeps the broad DACL
 * the only defect under test. No production ownership rule is changed.
 */
function ownFixtureObjects(targets: readonly string[]): void {
  for (const target of targets) {
    const before = inspectPeerStateAcl(target);
    assert.ok(before !== null, "the native helper observes this test's own fixture");
    if (before.evidence.ownerSid !== before.currentSid) {
      execFileSync(icacls(), [target, "/setowner", `*${before.currentSid}`], { stdio: "ignore", timeout: 30_000, windowsHide: true });
    }
    const after = inspectPeerStateAcl(target);
    assert.ok(after !== null && after.evidence.ownerSid === after.currentSid,
      `${target.slice(target.lastIndexOf("session-host"))} is owned by this account before Main starts`);
  }
}

function isPrivate(target: string, kind: "dir" | "file"): boolean {
  const observed = inspectPeerStateAcl(target);
  assert.ok(observed !== null);
  return verifyPrivateAclEvidence(observed.evidence, observed.currentSid, kind);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

interface Run {
  readonly driver: WindowsMainPtyDriver;
  quit(): Promise<void>;
  cleanup(): Promise<void>;
}

function startRun(runtime: WindowsRuntimePin, root: string, nativeAgentDir: string, home: string, temporary: string,
  name: string): Run {
  const runRoot = createOwnedDirectory(root, name);
  createOwnedDirectory(runRoot, "observer");
  const driver = WindowsMainPtyDriver.start({
    root: runRoot,
    runtime,
    nativeAgentDir,
    home,
    temporary,
    stateRoot: createOwnedDirectory(runRoot, "native-state"),
    fixtureState: createOwnedDirectory(runRoot, "fixture-state"),
    workspaceA: createOwnedDirectory(runRoot, "a"),
    workspaceB: createOwnedDirectory(runRoot, "b"),
  });
  let exited = false;
  return {
    driver,
    async quit() {
      await driver.ensureSidebarFocus();
      await driver.moveRosterTo("Quit host");
      await driver.sendKeys(WINDOWS_KEYS.enter, "Quit is requested with no native session",
        (frame) => frame.includes("Quit host?") || driver.exitEvent !== undefined);
      if (driver.exitEvent === undefined && driver.currentText().includes("Quit host?")) driver.pty.write(WINDOWS_KEYS.enter);
      const exit = await driver.waitForNormalExit();
      assert.equal(exit.exitCode, 0);
      assert.equal(driver.forcedCleanup, false, "the run needed no forced cleanup");
      exited = true;
    },
    async cleanup() {
      if (!exited) {
        await driver.tryGracefulQuitAfterFailure();
        if (!driver.exitEvent) driver.forceKillOuterAfterFailure();
      }
      await driver.settleSubscriptions();
    },
  };
}

/** Opens the Network pane from sidebar focus and waits for `ready` text. */
async function openNetwork(driver: WindowsMainPtyDriver, ready: (pane: string) => boolean, description: string): Promise<void> {
  await driver.ensureSidebarFocus();
  await driver.moveRosterTo("Network");
  await driver.sendKeys(WINDOWS_KEYS.enter, description, (frame) => ready(paneText(frame)));
}

async function highlightPaneRow(driver: WindowsMainPtyDriver, text: string): Promise<void> {
  for (let step = 0; step < 24; step += 1) {
    if (highlighted(driver.currentText()).includes(text)) return;
    const before = highlighted(driver.currentText());
    await driver.sendKeys(WINDOWS_KEYS.down, `the Network highlight moves toward ${text}`,
      (frame) => highlighted(frame) !== before);
  }
  assert.fail(`the Network pane never drew ${text}`);
}

test("real public Main shows Windows Network storage refusal, repairs only after the written confirmation, and reopens after restart", {
  timeout: WINDOWS_TEST_TIMEOUT_MS,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  assert.equal(process.env[WINDOWS_REQUIRE_ENV], "1");
  assert.equal(process.platform, "win32", "the opted-in companion runs only on a real Windows host");
  const runtime = resolveWindowsRuntime();
  assertWindowsRuntimeFiles(runtime);
  const root = createWindowsHarnessRoot();
  const home = createOwnedDirectory(root, "home");
  const temporary = createOwnedDirectory(root, "tmp");
  probeWindowsPowerShell(runtime, home, temporary);
  const runs: Run[] = [];
  let completed = false;
  t.after(async () => {
    for (const run of runs) await run.cleanup();
    if (completed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`preserved failed Windows Network witness tree: ${root}\n`);
  });

  // Seed a VALID upgraded profile with the production stores in a private
  // scratch agent directory: a real identity, an explicit bell Off, and a saved
  // loopback listen endpoint and destination (hosting itself stays Off).
  const port = await reserveLoopbackPort();
  const seedAgent = createOwnedDirectory(root, "seed-agent");
  const seedState = openPeerStateStore({ agentDir: seedAgent });
  const identity = await seedState.initializeIdentity("pi-session-host");
  seedState.close();
  const preferences = openPeerPreferencesStoreWithPermissions({ agentDir: seedAgent, permissions: createPeerStatePermissionPolicy() });
  preferences.write({
    ...DEFAULT_PEER_PREFERENCES,
    bellEnabled: false,
    hosting: { enabled: false, bindHost: "127.0.0.1", bindPort: port },
    destinations: [{ id: "loopback-1", label: "loopback", host: "127.0.0.1", port, previouslyConnected: false, reconnectSuppressed: false }],
  });
  preferences.close();
  const stateBytes = readFileSync(join(seedAgent, "session-host", "peers", "state.json"));
  const preferenceBytes = readFileSync(join(seedAgent, "session-host", "peer-preferences", "preferences.json"));

  // The synthetic broad profile: everything below the agent directory inherits
  // an ordinary-account Modify grant, exactly as an earlier build left it.
  const nativeAgentDir = createNativeAgentRoot(root);
  denyAmbientNativeProjectTrust(nativeAgentDir);
  execFileSync(icacls(), [nativeAgentDir, "/grant", `*${AUTHENTICATED_USERS}:(OI)(CI)M`], { stdio: "ignore", timeout: 30_000, windowsHide: true });
  const stateDir = join(nativeAgentDir, "session-host");
  mkdirSync(join(stateDir, "peers"), { recursive: true });
  mkdirSync(join(stateDir, "peer-preferences"));
  writeFileSync(join(stateDir, "peers", "state.json"), stateBytes);
  writeFileSync(join(stateDir, "peer-preferences", "preferences.json"), preferenceBytes);
  writeFileSync(join(stateDir, "unrelated.json"), "{}\n");
  ownFixtureObjects([stateDir, join(stateDir, "peers"), join(stateDir, "peers", "state.json"),
    join(stateDir, "peer-preferences"), join(stateDir, "peer-preferences", "preferences.json"), join(stateDir, "unrelated.json")]);
  assert.ok(grantsAuthenticatedUsers(stateDir) && grantsAuthenticatedUsers(join(stateDir, "peers", "state.json")),
    "the fixture really is the inherited broad shape");

  // ---- First run: truthful refusal, written confirmation, repair, restart status.
  const first = startRun(runtime, root, nativeAgentDir, home, temporary, "run-1");
  runs.push(first);
  await first.driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("Quit host"),
    "actual public Main renders its welcome frame");
  await openNetwork(first.driver, (pane) => pane.includes("session-host does not meet the required access permissions.")
    && pane.includes("Repair Network storage permissions"), "Network shows the sanitized refusal and the offered repair");
  const refused = paneText(first.driver.currentText());
  assert.ok(refused.includes("your account, SYSTEM, and Administrators"), "Windows mitigation is shown");
  assert.ok(refused.includes("hosting: unknown (settings unavailable)"), "unsafe settings are never defaults");
  assert.equal(/S-1-5|[A-Za-z]:\\/u.test(refused), false, "no SID or private path is drawn");
  assert.ok(grantsAuthenticatedUsers(stateDir), "showing the refusal changes nothing");

  await highlightPaneRow(first.driver, "Repair Network storage permissions");
  await first.driver.sendKeys(WINDOWS_KEYS.enter, "the repair confirmation is written",
    (frame) => paneText(frame).includes("Repair Network storage permissions?") && paneText(frame).includes("> Cancel"));
  const confirmation = paneText(first.driver.currentText());
  for (const expected of ["session-host/peers/state.json", "SYSTEM, and Administrators", "byte for byte",
    "parent folders", "Repair cannot undo earlier access", "until you restart Pi"]) {
    assert.ok(confirmation.includes(expected), `the confirmation shows ${expected}`);
  }
  await first.driver.sendKeys("y", "Repair is chosen and drawn",
    (frame) => paneText(frame).includes("> Repair permissions"));
  // Enter acts only on an actually written Repair frame; a press that raced the
  // writer receipt is refused by the sidebar and repeated once it is written.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await first.driver.sendKeys(WINDOWS_KEYS.enter, "the confirmed repair is requested or refused for an unwritten frame",
      (frame) => paneText(frame).includes("Permissions were repaired") || paneText(frame).includes("No written receipt"), 60_000);
    if (paneText(first.driver.currentText()).includes("Permissions were repaired")) break;
  }
  const repaired = paneText(first.driver.currentText());
  assert.ok(repaired.includes("Network stays unavailable until you restart Pi"));
  assert.ok(repaired.includes("replace the identity key separately"));
  for (const [target, kind] of [[stateDir, "dir"], [join(stateDir, "peers"), "dir"], [join(stateDir, "peers", "state.json"), "file"],
    [join(stateDir, "peer-preferences"), "dir"], [join(stateDir, "peer-preferences", "preferences.json"), "file"]] as const) {
    assert.ok(isPrivate(target, kind), `${target.slice(stateDir.length) || "session-host"} is private after the repair`);
  }
  assert.ok(grantsAuthenticatedUsers(join(stateDir, "unrelated.json")), "an unrelated child keeps its inherited grant");
  assert.ok(grantsAuthenticatedUsers(nativeAgentDir), "the agent directory is never modified");
  assert.deepEqual(readFileSync(join(stateDir, "peers", "state.json")), stateBytes, "the key document is byte-identical");
  assert.deepEqual(readFileSync(join(stateDir, "peer-preferences", "preferences.json")), preferenceBytes);

  await first.driver.sendKeys(WINDOWS_KEYS.escape, "Escape leaves the Network pane for the sidebar",
    (frame) => !paneText(frame).includes("Permissions were repaired"));
  await first.quit();

  // ---- Deliberate restart: same key, explicit Off, then explicit Hosting/Connect.
  const second = startRun(runtime, root, nativeAgentDir, home, temporary, "run-2");
  runs.push(second);
  await second.driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("Quit host"),
    "the restarted Main renders its welcome frame");
  await openNetwork(second.driver, (pane) => pane.includes(`identity key: ${identity.key.fingerprint}`),
    "the restarted Network reopens the same identity");
  const reopened = paneText(second.driver.currentText());
  assert.ok(reopened.includes("Hosting: disabled"), "hosting stays Off after restart");
  assert.ok(reopened.includes("Incoming bell: off"), "the explicit bell Off is kept");
  assert.ok(reopened.includes("Auto reconnect: off"));
  assert.equal(reopened.includes("unavailable"), false, "Network storage opens normally");

  await highlightPaneRow(second.driver, "Hosting: disabled");
  await second.driver.sendKeys(WINDOWS_KEYS.enter, "explicit Enable binds the saved loopback endpoint",
    (frame) => paneText(frame).includes(`listener: listening on 127.0.0.1:${port}`), 60_000);
  await highlightPaneRow(second.driver, "loopback 127.0.0.1");
  await second.driver.sendKeys("c", "an explicit Connect is admitted to first-use approval",
    (frame) => paneText(frame).includes("approval window"), 60_000);
  await second.driver.sendKeys("x", "Disconnect ends the explicit attempt and both pending approvals",
    (frame) => !paneText(frame).includes("approval window") && !paneText(frame).includes("connecting"), 60_000);
  await second.driver.sendKeys(WINDOWS_KEYS.escape, "Escape leaves the Network pane for the sidebar",
    (frame) => !paneText(frame).includes("listener: listening"));
  await second.quit();
  assert.equal(readFileSync(join(stateDir, "peers", "state.json")).length > 0, true);
  completed = true;
});

/** The exact written initial defaults: Hosting/Auto Off, bell and both optional flags On, `*:8088` draft. */
const UNCHANGED_DEFAULTS = [
  "hosting: disabled", "listener: off", "auto: off", "bell: on", "destinations: 0", "receiving: 0",
  "identity key: unavailable",
  "Hosting: disabled (enter to enable)",
  "Listen address: * (enter to edit)",
  "Listen port: 8088 (enter to edit)",
  "Apply listen address/port",
  "Auto reconnect: off (enter to toggle)",
  "Incoming bell: on (enter to toggle)",
  "Remote input/copy: on (enter to toggle)",
  "Allow remote history deletion: on (enter to toggle)",
  "Add destination",
] as const;

function showsUnchangedDefaults(pane: string): boolean {
  return UNCHANGED_DEFAULTS.every((expected) => pane.includes(expected));
}

function assertUnchangedDefaults(pane: string, label: string): void {
  for (const expected of UNCHANGED_DEFAULTS) assert.ok(pane.includes(expected), `${label}: the pane shows ${expected}`);
  assert.equal(pane.includes("(unsaved changes)"), false, `${label}: the suggestion is an unedited local draft`);
  assert.equal(pane.includes("unknown"), false, `${label}: no setting is unknown`);
  assert.equal(pane.includes("Repair Network storage permissions"), false, `${label}: no storage refusal or repair`);
  assert.equal(pane.includes("listening"), false, `${label}: nothing is bound`);
  assert.equal(/S-1-5|[A-Za-z]:\\/u.test(pane), false, `${label}: no SID or private path is drawn`);
}

function assertNoNetworkState(stateDir: string, label: string): void {
  for (const name of ["peers", "peer-preferences"]) {
    assert.equal(existsSync(join(stateDir, name)), false, `${label}: no ${name} directory, document, or identity exists`);
  }
}

/** The protection-relevant projection of one descriptor (entry counts legitimately change). */
function protectionOf(target: string): unknown {
  const observed = inspectPeerStateAcl(target);
  assert.ok(observed !== null, "the native helper observes this test's own fixture");
  const { ownerSid, daclPresent, daclProtected, aces } = observed.evidence;
  return { ownerSid, daclPresent, daclProtected, aces };
}

interface DefaultsHarness {
  readonly runtime: WindowsRuntimePin;
  readonly root: string;
  readonly home: string;
  readonly temporary: string;
  readonly runs: Run[];
  complete(): void;
}

function prepareDefaultsHarness(t: TestContext, witness: string): DefaultsHarness {
  assert.equal(process.env[WINDOWS_REQUIRE_ENV], "1");
  assert.equal(process.platform, "win32", "the opted-in companion runs only on a real Windows host");
  const runtime = resolveWindowsRuntime();
  assertWindowsRuntimeFiles(runtime);
  const root = createWindowsHarnessRoot();
  const runs: Run[] = [];
  let completed = false;
  t.after(async () => {
    // Every owned process exits (or is settled) before this exact root is removed.
    for (const run of runs) await run.cleanup();
    if (completed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`preserved failed Windows Network ${witness} witness tree: ${root}\n`);
  });
  const home = createOwnedDirectory(root, "home");
  const temporary = createOwnedDirectory(root, "tmp");
  probeWindowsPowerShell(runtime, home, temporary);
  return { runtime, root, home, temporary, runs, complete() { completed = true; } };
}

/**
 * Production Main twice against the same agent directory: the first run opens,
 * leaves, and reopens Network; the deliberate restart opens it once more. Every
 * written ready pane must show the unchanged defaults, and nothing Network-owned
 * may exist after any open, leave, or quit.
 */
async function observeDefaultsAcrossRestart(harness: DefaultsHarness, nativeAgentDir: string, stateDir: string,
  label: string): Promise<void> {
  for (const [name, opens] of [["run-1", 2], ["run-2", 1]] as const) {
    const run = startRun(harness.runtime, harness.root, nativeAgentDir, harness.home, harness.temporary, name);
    harness.runs.push(run);
    await run.driver.waitFrame((frame) => frame.includes("Welcome") && frame.includes("Quit host"),
      `${label} ${name}: actual public Main renders its welcome frame`);
    for (let open = 1; open <= opens; open += 1) {
      const step = `${label} ${name} open ${open}`;
      await openNetwork(run.driver, showsUnchangedDefaults, `${step}: Network shows the unchanged defaults`);
      assertUnchangedDefaults(paneText(run.driver.currentText()), step);
      assertNoNetworkState(stateDir, step);
      await run.driver.sendKeys(WINDOWS_KEYS.escape, `${step}: Escape leaves the Network pane for the sidebar`,
        (frame) => !paneText(frame).includes("Listen port:"));
      assertNoNetworkState(stateDir, `${step} after leaving`);
    }
    await run.quit();
    assertNoNetworkState(stateDir, `${label} ${name} after quit`);
  }
}

test("real public Main shows the unchanged Network defaults for a fresh agent directory and creates no Network state", {
  timeout: WINDOWS_TEST_TIMEOUT_MS,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  const harness = prepareDefaultsHarness(t, "fresh-default");
  const nativeAgentDir = createNativeAgentRoot(harness.root);
  denyAmbientNativeProjectTrust(nativeAgentDir);
  const stateDir = join(nativeAgentDir, "session-host");
  assert.equal(existsSync(stateDir), false, "the fresh fixture has no session-host directory");

  await observeDefaultsAcrossRestart(harness, nativeAgentDir, stateDir, "fresh");

  // The real Main was the only creator of session-host: it is private at creation.
  assert.ok(isPrivate(stateDir, "dir"), "the session-host directory Main created is private");
  assert.equal(grantsAuthenticatedUsers(stateDir), false, "no broad inherited grant reached it");
  assertNoNetworkState(stateDir, "fresh after restart");
  harness.complete();
});

test("real public Main shows the unchanged Network defaults for a valid pre-network base and creates no Network state", {
  timeout: WINDOWS_TEST_TIMEOUT_MS,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  const harness = prepareDefaultsHarness(t, "pre-network-default");
  const nativeAgentDir = createNativeAgentRoot(harness.root);
  denyAmbientNativeProjectTrust(nativeAgentDir);
  // A valid existing pre-network base with normal safe protection: a private
  // session-host holding only valid host shortcuts and an empty roster.
  const stateDir = join(nativeAgentDir, "session-host");
  assert.deepEqual(createSessionHostStateDirectory(stateDir), { outcome: "created-protected" },
    "the positive-control base is created private");
  const keybindings = join(stateDir, "keybindings.json");
  const keybindingBytes = Buffer.from(`${JSON.stringify({ version: 1, returnToMain: "alt+right" })}\n`, "utf8");
  writeOwnedFile(keybindings, keybindingBytes);
  writeOwnedFile(join(stateDir, "roster.json"), `${JSON.stringify({ version: 1, entries: [] })}\n`);
  assert.equal(existsSync(join(nativeAgentDir, "keybindings.json")), false, "host shortcuts live only under session-host");
  assert.ok(isPrivate(stateDir, "dir"), "the existing base is safely protected");
  assertNoNetworkState(stateDir, "pre-network fixture");
  const protection = protectionOf(stateDir);

  await observeDefaultsAcrossRestart(harness, nativeAgentDir, stateDir, "pre-network");

  assert.deepEqual(protectionOf(stateDir), protection, "the existing base's protection is never changed");
  assert.deepEqual(readFileSync(keybindings), keybindingBytes, "the host shortcuts are byte-identical");
  assert.equal(existsSync(join(stateDir, "roster.json")), true, "the roster remains");
  assertNoNetworkState(stateDir, "pre-network after restart");
  harness.complete();
});
