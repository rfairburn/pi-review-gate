/**
 * Native Windows console-attachment probe for trusted PowerShell helpers
 * (Refs #494). Diagnosis evidence, not Main acceptance and not a fix claim.
 *
 * The real Main Network acceptance observed, only inside its owned outer
 * ConPTY, the trusted synchronous PowerShell helpers reaching their fixed
 * 10 s / 15 s deadlines while a `node --version` child with the same libuv
 * creation flags (windowsHide:true, no inherited stdio, i.e. CREATE_NO_WINDOW)
 * finished in about half a second. This test runs one fixed matrix
 * (`tests/fixtures/session-host-windows-console-probe.cjs`) twice, with the
 * production helper deadline and stdio shape: directly from this test process,
 * then from a node child hosted in an owned public outer ConPTY spawned exactly
 * as the Main harness does (pinned public node-pty, useConptyDll, the same
 * minimal harness environment, terminal replies through the same
 * TerminalSurface). The matrix separates console attachment (hidden / shared /
 * detached), command (production cmdlet / .NET only / readiness), and
 * environment (harness / owned profile) one axis at a time.
 *
 * Asserted: both matrices are complete and well-formed, every child pid is gone
 * once its synchronous call returned, the known-good baselines succeed (direct
 * node and readiness PowerShell; ConPTY node), and the outer ConPTY child exits
 * zero on its own. Every other outcome is reported, never asserted, so the
 * probe distinguishes the candidate differentials without presuming a cause.
 * Under PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST=1 any missing prerequisite
 * is a hard failure. Only the fresh harness root is created and, after every
 * owned process settled, removed (preserved on failure).
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { TerminalSurface } from "../src/session-host/terminal-surface";
import {
  WINDOWS_OUTER_COLS,
  WINDOWS_OUTER_ROWS,
  WINDOWS_REQUIRE_ENV,
  assertNoRoleOrCatalogMarkers,
  assertWindowsRuntimeFiles,
  createOwnedDirectory,
  createWindowsHarnessRoot,
  probeWindowsPowerShell,
  resolveWindowsRuntime,
  safeWindowsPath,
  writeOwnedFile,
  type NativePtyExit,
} from "./helpers/session-host-native-windows-harness";

interface ProbeRecord {
  readonly id: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly childGone: boolean | null;
}
interface ProbeResult {
  readonly context: "direct" | "conpty";
  readonly records: readonly ProbeRecord[];
}
interface ProbeModule {
  readonly PROBE_VARIANT_IDS: readonly string[];
  readonly PROBE_CHILD_CAP_MS: number;
  readonly PROFILE_SYSTEM_NAMES: readonly string[];
  runConsoleProbe(options: Record<string, unknown>): ProbeResult;
  isConsoleProbeResult(value: unknown): boolean;
  formatConsoleProbe(value: unknown): string;
}

const PROBE_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-windows-console-probe.cjs");
const probe = createRequire(join(process.cwd(), "package.json"))(PROBE_FIXTURE) as ProbeModule;
const optIn = process.env[WINDOWS_REQUIRE_ENV] === "1";
const CREDENTIAL_NAME = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i;
/** Whole matrix at its fixed per-child cap, plus ConPTY/node startup. Never stretched. */
const CONPTY_EXIT_DEADLINE_MS = probe.PROBE_VARIANT_IDS.length * probe.PROBE_CHILD_CAP_MS + 30_000;

function outcomeOf(result: ProbeResult, id: string): string {
  const record = result.records.find((candidate) => candidate.id === id);
  assert.ok(record, `the ${result.context} probe recorded ${id}`);
  return record.outcome;
}

function assertComplete(result: unknown, context: string): asserts result is ProbeResult {
  assert.equal(probe.isConsoleProbeResult(result), true, `the ${context} probe result is complete fixed vocabulary`);
  for (const record of (result as ProbeResult).records) {
    assert.equal(record.childGone, true, `${context} ${record.id}: the child pid is gone after its synchronous call returned`);
  }
}

test("trusted PowerShell helper console attachment: direct versus owned outer ConPTY", {
  timeout: 2 * CONPTY_EXIT_DEADLINE_MS + 60_000,
  skip: optIn ? false : `${WINDOWS_REQUIRE_ENV}=1 is required; this is not Windows host proof`,
}, async (t) => {
  assert.equal(process.env[WINDOWS_REQUIRE_ENV], "1");
  assert.equal(process.platform, "win32", "the opted-in probe runs only on a real Windows host");
  const runtime = resolveWindowsRuntime();
  assertWindowsRuntimeFiles(runtime);
  const root = createWindowsHarnessRoot();
  const home = createOwnedDirectory(root, "home");
  const temporary = createOwnedDirectory(root, "tmp");
  // PowerShell may initialize AppData even for the readiness query. Establish
  // these owned directories first rather than colliding with its initialization.
  const appData = createOwnedDirectory(home, "AppData");
  const localAppData = createOwnedDirectory(appData, "Local");
  const roamingAppData = createOwnedDirectory(appData, "Roaming");
  probeWindowsPowerShell(runtime, home, temporary);

  // The same minimal environment the Main harness hands its ConPTY runner.
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR!;
  const harnessEnv: Record<string, string> = {
    PATH: safeWindowsPath(systemRoot),
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
    HOME: home,
    USERPROFILE: home,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    NODE_PATH: runtime.nodePath,
    TERM: "xterm-256color",
  };
  // The profile control adds fixed system names from this host and points the
  // per-user profile folders at owned directories, so nothing outside the root
  // is written by the probe's PowerShell children.
  const profileEnv: Record<string, string> = { ...harnessEnv, LOCALAPPDATA: localAppData, APPDATA: roamingAppData };
  for (const name of probe.PROFILE_SYSTEM_NAMES) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) profileEnv[name] = value;
  }
  for (const env of [harnessEnv, profileEnv]) {
    assertNoRoleOrCatalogMarkers(env);
    assert.deepEqual(Object.keys(env).filter((name) => CREDENTIAL_NAME.test(name)), [],
      "the probe child environment contains no credential-like variable names");
  }
  const envs = { harness: harnessEnv, profile: profileEnv };

  let completed = false;
  let pty: ReturnType<typeof runtime.pty.spawn> | undefined;
  let exitEvent: NativePtyExit | undefined;
  let forced = false;
  const subscriptions: { dispose(): void }[] = [];
  let surface: TerminalSurface | undefined;
  t.after(() => {
    if (pty !== undefined && exitEvent === undefined) {
      forced = true;
      try { pty.kill(); } catch { /* exact owned outer PTY, no signal argument */ }
    }
    for (const subscription of subscriptions) {
      try { subscription.dispose(); } catch { /* exact owned subscription */ }
    }
    try { surface?.dispose(); } catch { /* owned terminal model */ }
    if (completed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`preserved failed Windows console probe tree: ${root}\n`);
  });

  // Direct control: this test process, outside any ConPTY.
  const direct = probe.runConsoleProbe({ context: "direct", powershell: runtime.powershell, node: process.execPath, envs });
  assertComplete(direct, "direct");
  const directLine = probe.formatConsoleProbe(direct);
  t.diagnostic(directLine);
  process.stderr.write(`${directLine}\n`);

  // Owned outer ConPTY, spawned exactly as the Main harness spawns its runner.
  const optionsFile = join(root, "console-probe-options.json");
  const resultFile = join(root, "console-probe-result.json");
  writeOwnedFile(optionsFile, JSON.stringify({ powershell: runtime.powershell, envs }));
  const outerEnv: NodeJS.ProcessEnv = {
    ...harnessEnv,
    PRG_SESSION_HOST_WINDOWS_CONSOLE_PROBE_OPTIONS: optionsFile,
    PRG_SESSION_HOST_WINDOWS_CONSOLE_PROBE_RESULT: resultFile,
  };
  assertNoRoleOrCatalogMarkers(outerEnv);
  const exited = new Promise<NativePtyExit>((resolve) => {
    const owned = runtime.pty.spawn(process.execPath, [PROBE_FIXTURE], {
      name: "xterm-256color",
      cols: WINDOWS_OUTER_COLS,
      rows: WINDOWS_OUTER_ROWS,
      cwd: process.cwd(),
      env: outerEnv,
      encoding: "utf8",
      useConptyDll: true,
    });
    pty = owned;
    const terminal = new TerminalSurface(WINDOWS_OUTER_COLS, WINDOWS_OUTER_ROWS, {
      onReply: (reply) => {
        try { owned.write(reply); } catch { /* exact outer PTY may have exited */ }
      },
    });
    surface = terminal;
    subscriptions.push(owned.onData((data) => terminal.write(data)));
    subscriptions.push(owned.onExit((event) => {
      exitEvent = event;
      resolve(event);
    }));
  });
  let deadline: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    exited,
    new Promise<undefined>((resolve) => { deadline = setTimeout(() => resolve(undefined), CONPTY_EXIT_DEADLINE_MS); }),
  ]);
  clearTimeout(deadline);
  assert.ok(exit !== undefined, "the owned ConPTY probe child exited within the fixed matrix deadline");
  assert.equal(forced, false, "the owned ConPTY probe child needed no forced cleanup");
  assert.equal(exit.exitCode, 0, "the owned ConPTY probe child exited zero");
  assert.ok(!exit.signal, "the owned ConPTY probe child exited without a signal");
  assert.ok(existsSync(resultFile), "the owned ConPTY probe child recorded its result");
  const stats = lstatSync(resultFile);
  assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size <= 16 * 1024, "the ConPTY result is a bounded regular file");
  const conpty: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
  assertComplete(conpty, "conpty");
  assert.equal(conpty.context, "conpty");
  const conptyLine = probe.formatConsoleProbe(conpty);
  t.diagnostic(conptyLine);
  process.stderr.write(`${conptyLine}\n`);

  // Known-good baselines only: a failure here invalidates the comparison.
  assert.equal(outcomeOf(direct, "node-version/hidden/harness"), "ok", "direct node baseline");
  assert.equal(outcomeOf(direct, "ps-version/hidden/harness"), "ok", "direct readiness PowerShell baseline");
  assert.equal(outcomeOf(conpty, "node-version/hidden/harness"), "ok", "ConPTY node baseline");
  completed = true;
});
