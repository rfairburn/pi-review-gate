/**
 * Real installed-Pi TUI smoke for the staged evidence-settings transaction.
 *
 * The candidate is compiled into a disposable package (never the checkout's
 * live dist/), with this checkout's dependencies and scripts available beside
 * it. The test launches the installed Pi CLI directly through its public
 * `--no-extensions --extension <candidate>` seam on a real node-pty terminal.
 * It drives `/review-settings` → Reviewers → Evidence methods and asserts the
 * rendered rows as well as the synthetic config file at each persistence
 * boundary. The Pi child gets a synthetic HOME/agent/config/workspace, no
 * provider credentials or inherited PI_REVIEW_GATE_RUNTIME_ROLE, `--offline`,
 * and no user prompt; no model/provider call is possible or attempted.
 *
 * The PTY and its process group are owned and settled on success, setup error,
 * and test failure. The scratch fixture is removed only after the PTY process
 * group is positively observed gone; uncertain ownership preserves it for
 * diagnosis. Native Windows is explicitly skipped: this POSIX process-group
 * harness does not claim Windows parity.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { describeFixturePrerequisites } from "./pi-native-mcp-fixture";
import { skipOrFail } from "./bridge-fakes";

const projectRoot = join(dirname(__dirname), "..");
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";
const KEY_CTRL_S = "\x13";
const KEY_CTRL_C = "\x03";
const PTY_OVERALL_TIMEOUT_MS = 8 * 60_000;
const PTY_OUTPUT_LIMIT = 8 * 1024 * 1024;
const LIVE_WARNING = "WARNING: Applying Primary / top-level Tools + workspace changes → Tools only";

interface PtyExit {
  exitCode: number;
  signal?: number;
}

interface OwnedPty {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: PtyExit) => void): { dispose(): void };
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): OwnedPty;
}

interface EvidenceValues {
  primaryToolOnly: boolean;
  worktreeToolOnly: boolean;
  inplaceToolOnly: boolean;
  snapshotFailureFallback: boolean;
}

const EVIDENCE_ROWS: ReadonlyArray<[keyof EvidenceValues, string]> = [
  ["primaryToolOnly", "Primary / top-level"],
  ["worktreeToolOnly", "Isolated worktree"],
  ["inplaceToolOnly", "InPlace"],
  ["snapshotFailureFallback", "Snapshot-failure fallback"],
];

const DEFAULTS: EvidenceValues = {
  primaryToolOnly: false,
  worktreeToolOnly: false,
  inplaceToolOnly: false,
  snapshotFailureFallback: true,
};

async function canonicalFixtureTempRoot(checkoutRoot: string, temporaryRoot: string): Promise<string | undefined> {
  const [checkout, temporary] = await Promise.all([realpath(checkoutRoot), realpath(temporaryRoot)]);
  const withinCheckout = relative(checkout, temporary);
  return isAbsolute(withinCheckout) || withinCheckout === ".." || withinCheckout.startsWith(`..${sep}`)
    ? temporary : undefined;
}

function resolveTypeScriptCompiler(): string | undefined {
  try {
    return createRequire(join(projectRoot, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

function resolveNodePty(): NodePtyModule | undefined {
  try {
    const loaded = createRequire(join(projectRoot, "package.json"))("@lydell/node-pty") as Partial<NodePtyModule>;
    return typeof loaded?.spawn === "function" ? loaded as NodePtyModule : undefined;
  } catch {
    return undefined;
  }
}

function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-2A-Z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupState(pgid: number): "present" | "absent" | "unknown" {
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

/** Check that node-pty's returned PID is the dedicated PTY process-group ID. */
function isProcessGroupLeader(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && Number.parseInt(result.stdout.trim(), 10) === pid;
}

class LivePiPty {
  private output = "";
  private readonly wakeups = new Set<() => void>();
  private readonly exitPromise: Promise<PtyExit>;
  private exitEvent?: PtyExit;
  private outputError?: Error;
  private readonly dataSubscription: { dispose(): void };
  private readonly exitSubscription: { dispose(): void };
  private ownedPgid?: number;

  constructor(readonly pty: OwnedPty) {
    let resolveExit!: (event: PtyExit) => void;
    this.exitPromise = new Promise<PtyExit>((resolve) => {
      resolveExit = resolve;
    });
    this.exitSubscription = pty.onExit((event) => {
      this.exitEvent = event;
      resolveExit(event);
      this.wake();
    });
    this.dataSubscription = pty.onData((data) => {
      this.output += data;
      if (this.output.length > PTY_OUTPUT_LIMIT) {
        this.output = this.output.slice(-PTY_OUTPUT_LIMIT);
        this.outputError = new Error(`PTY output exceeded the ${PTY_OUTPUT_LIMIT}-character smoke bound`);
      }
      this.wake();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  claimOwnedProcessGroup(): boolean {
    if (!isProcessGroupLeader(this.pid)) return false;
    this.ownedPgid = this.pid;
    return true;
  }

  private wake(): void {
    for (const wake of this.wakeups) wake();
    this.wakeups.clear();
  }

  private textFrom(offset: number): string {
    return stripTerminalControls(this.output.slice(offset));
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (this.outputError) throw this.outputError;
      if (this.exitEvent) {
        throw new Error(`Pi PTY exited before ${description} (code ${this.exitEvent.exitCode}, signal ${String(this.exitEvent.signal)})`);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${description}; latest PTY output: ${this.textFrom(Math.max(0, this.output.length - 4_000))}`);
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.wakeups.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(remaining, 1_000));
        this.wakeups.add(finish);
      });
    }
  }

  async waitForText(marker: string, timeoutMs = 30_000, offset = 0): Promise<string> {
    await this.waitUntil(() => this.textFrom(offset).includes(marker), timeoutMs, JSON.stringify(marker));
    await delay(80);
    return this.textFrom(offset);
  }

  async sendAndWait(data: string, marker: string, timeoutMs = 30_000): Promise<string> {
    const offset = this.output.length;
    this.pty.write(data);
    return this.waitForText(marker, timeoutMs, offset);
  }

  async press(data: string, settleMs = 180): Promise<string> {
    const offset = this.output.length;
    this.pty.write(data);
    const waitForOutput = Math.min(800, Math.max(150, settleMs));
    await this.waitUntil(() => this.output.length > offset, waitForOutput, "PTY redraw after key input").catch((error: unknown) => {
      // Some host key actions legitimately produce no redraw. Keep the fixed
      // settle bound, but retain any real PTY/output errors and early exits.
      if (this.outputError || this.exitEvent) throw error;
    });
    await delay(settleMs);
    return this.textFrom(offset);
  }

  async waitForExit(timeoutMs: number): Promise<PtyExit> {
    if (this.exitEvent) return this.exitEvent;
    return await new Promise<PtyExit>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi PTY did not exit within ${timeoutMs}ms`)), timeoutMs);
      this.exitPromise.then((event) => {
        clearTimeout(timer);
        resolve(event);
      }, (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async dispose(): Promise<boolean> {
    const pgid = this.ownedPgid;
    if (pgid === undefined) {
      try { this.pty.kill("SIGTERM"); } catch { /* settlement below decides */ }
      if (!this.exitEvent) {
        try { await this.waitForExit(3_000); } catch { /* preserve scratch below */ }
      }
      this.dataSubscription.dispose();
      this.exitSubscription.dispose();
      return false;
    }
    let state = processGroupState(pgid);
    if (state === "present") {
      try { process.kill(-pgid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") state = "unknown";
      }
    } else if (state === "unknown" && !this.exitEvent) {
      // Direct PTY termination is a fallback only; it does not prove that
      // descendants settled, so uncertain ownership still preserves scratch.
      try { this.pty.kill("SIGTERM"); } catch { /* settlement below decides */ }
    }

    if (!this.exitEvent) {
      try { await this.waitForExit(3_000); } catch { /* escalate below */ }
    }
    state = processGroupState(pgid);
    if (state === "present") {
      try { process.kill(-pgid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") state = "unknown";
      }
    }
    if (!this.exitEvent) {
      try { await this.waitForExit(3_000); } catch { /* preserve scratch below */ }
    }

    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline && processGroupState(pgid) === "present") await delay(50);
    const settled = this.exitEvent !== undefined && processGroupState(pgid) === "absent";
    this.dataSubscription.dispose();
    this.exitSubscription.dispose();
    return settled;
  }
}

function assertEvidenceRows(frame: string, actual: EvidenceValues, context: string): void {
  assert.ok(frame.includes("Review evidence methods"), `${context}: real evidence submenu heading missing`);
  for (const [field, label] of EVIDENCE_ROWS) {
    const state = field === "snapshotFailureFallback" ? actual[field] ? "On" : "Off"
      : actual[field] ? "Tools only" : "Tools + workspace changes";
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedState = state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const position = frame.lastIndexOf(label);
    assert.notEqual(position, -1, `${context}: visible ${label} row missing`);
    const gap = Math.max(...EVIDENCE_ROWS.map(([, rowLabel]) => rowLabel.length)) - label.length + 2;
    const rowWindow = frame.slice(position, position + label.length + gap + state.length + 1);
    assert.match(rowWindow, new RegExp(`^${escapedLabel}\\s{${gap}}${escapedState}(?:\\b|\\s|$)`),
      `${context}: the visible ${label} row must show ${state}`);
  }
}

async function selectVisibleRow(session: LivePiPty, label: string, maxDown = 24, currentFrame = ""): Promise<string> {
  if (currentFrame.includes(`→ ${label}`)) return currentFrame;
  for (let count = 0; count < maxDown; count += 1) {
    const frame = await session.press(KEY_DOWN, 80);
    if (frame.includes(`→ ${label}`)) return frame;
  }
  throw new Error(`real Pi selector did not highlight ${JSON.stringify(label)} within ${maxDown} Down presses`);
}

async function openEvidenceMenu(session: LivePiPty): Promise<string> {
  await session.sendAndWait("/review-settings\r", "Review settings");
  await selectVisibleRow(session, "Reviewers");
  await session.sendAndWait(KEY_ENTER, "Automatic primary review");
  await selectVisibleRow(session, "Evidence methods");
  return await session.sendAndWait(KEY_ENTER, "Review evidence methods");
}

async function backToRoot(session: LivePiPty): Promise<void> {
  await session.sendAndWait(KEY_ESCAPE, "Evidence methods");
  await session.sendAndWait(KEY_ESCAPE, "Review settings");
}

async function applySessionOnly(session: LivePiPty): Promise<string> {
  return await session.sendAndWait(KEY_ESCAPE, "Review settings applied for this session (not saved to disk).");
}

async function readDiskEvidence(configPath: string): Promise<unknown> {
  const disk = JSON.parse(await readFile(configPath, "utf8")) as { review?: { evidence?: unknown } };
  return disk.review?.evidence;
}

function assertDiskEvidence(actual: unknown, expected: EvidenceValues, context: string): void {
  assert.deepEqual(actual, expected, `${context}: persisted review.evidence must preserve independent fields`);
}

async function waitForGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const state = processGroupState(pgid);
    if (state === "absent") return true;
    if (state === "unknown") return false;
    await delay(50);
  }
  return processGroupState(pgid) === "absent";
}

test("TUI fixture temp-root guard rejects checkout aliases and returns the checked canonical outside path", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "prg-temp-containment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"), build = join(checkout, "dist-test"), outside = join(root, "outside");
  await mkdir(build, { recursive: true });
  await mkdir(outside);
  const checkoutAlias = join(root, "checkout-alias"), buildAlias = join(root, "build-alias"), outsideAlias = join(root, "outside-alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(checkout, checkoutAlias, linkType);
  await symlink(build, buildAlias, linkType);
  await symlink(outside, outsideAlias, linkType);
  for (const project of [checkout, checkoutAlias]) {
    for (const temporary of [checkout, build, buildAlias]) {
      assert.equal(await canonicalFixtureTempRoot(project, temporary), undefined, "an alias must not place preserved fixtures in clean:test's deletion scope");
    }
    assert.equal(await canonicalFixtureTempRoot(project, outsideAlias), outside, "allocation must use the canonical directory actually checked, not its alias");
  }
});

test("live installed Pi TUI applies, cancels, and saves evidence settings without a model call", { timeout: PTY_OVERALL_TIMEOUT_MS }, async (t) => {
  if (process.platform === "win32") {
    t.skip("native Windows is unsupported by this POSIX node-pty/process-group smoke; no parity claim");
    return;
  }

  const prerequisites = describeFixturePrerequisites({ candidateEntry: null });
  const compiler = resolveTypeScriptCompiler();
  const nodePty = resolveNodePty();
  const missing = [...prerequisites.problems];
  if (!existsSync(join(projectRoot, "node_modules"))) missing.push("checkout node_modules for the isolated candidate dependency link");
  if (!compiler) missing.push("checkout TypeScript compiler");
  if (!nodePty) missing.push("@lydell/node-pty for bounded real terminal input");
  if (missing.length > 0 || !prerequisites.host) {
    skipOrFail(t, `live evidence-settings TUI prerequisites unavailable: ${missing.join("; ") || "installed Pi host"}`);
    return;
  }
  assert.ok(compiler);
  assert.ok(nodePty);
  assert.ok(prerequisites.host);

  // Resolve both roots before allocating: lexical aliases must not place a
  // preserved uncertain fixture in clean:test's deletion scope.
  const temporaryRoot = await canonicalFixtureTempRoot(projectRoot, tmpdir());
  if (!temporaryRoot) {
    skipOrFail(t, "temporary directory resolves inside the checkout; refusing to place the candidate or PTY fixture there");
    return;
  }
  const sandbox = await mkdtemp(join(temporaryRoot, "prg-evidence-settings-tui-"));
  let preserveSandbox = false;
  let session: LivePiPty | undefined;
  t.after(async () => {
    if (session) {
      const settled = await session.dispose();
      if (!settled) {
        preserveSandbox = true;
        throw new Error("Pi PTY process-group settlement was not confirmed; preserving the owned scratch fixture");
      }
    }
    if (!preserveSandbox) await rm(sandbox, { recursive: true, force: true });
  });

  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "pi-agent");
  const workspace = join(sandbox, "workspace");
  const candidateRoot = join(sandbox, "candidate");
  const configPath = join(agentDir, "review-gate.json");
  const initialConfig = {
    enabled: false,
    operatingMode: "execute",
    smokeOnlyUnknownField: { preserve: true },
    review: { primaryEnabled: false, subtaskEnabled: false, primaryReviewers: [], subtaskReviewers: [] },
  };
  const initialBytes = `${JSON.stringify(initialConfig, null, 2)}\n`;

  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(home, ".config"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(configPath, initialBytes, { mode: 0o600 });
  await writeFile(join(workspace, "smoke-fixture.txt"), "synthetic workspace only\n");

  // Build an inactive candidate into scratch and give it only this checkout's
  // dependency link and shipped runtime scripts; never touch root dist/.
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(join(candidateRoot, "package.json"), JSON.stringify({
    name: "pi-review-gate-evidence-settings-smoke-candidate",
    version: "0.0.0-test",
    private: true,
    type: "commonjs",
  }, null, 2) + "\n");
  await cp(join(projectRoot, "scripts"), join(candidateRoot, "scripts"), { recursive: true });
  await symlink(join(projectRoot, "node_modules"), join(candidateRoot, "node_modules"), "dir");
  const build = spawnSync(process.execPath, [compiler, "-p", join(projectRoot, "tsconfig.json"), "--outDir", join(candidateRoot, "dist"), "--pretty", "false"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: sandbox,
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  });
  assert.equal(build.status, 0,
    `scratch candidate TypeScript build failed (status ${String(build.status)}):\n${build.stdout ?? ""}\n${build.stderr ?? ""}\n${String(build.error ?? "")}`);
  const candidateEntry = join(candidateRoot, "dist", "src", "index.js");
  assert.ok(existsSync(candidateEntry), "scratch build must produce the isolated candidate entry");

  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: sandbox,
    PI_CODING_AGENT_DIR: agentDir,
    PI_REVIEW_GATE_CONFIG: configPath,
  };
  assert.equal(childEnv.PI_REVIEW_GATE_RUNTIME_ROLE, undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.GOOGLE_API_KEY, undefined);
  assert.deepEqual(Object.keys(childEnv).filter((name) => name.startsWith("PI_REVIEW_GATE_") && name !== "PI_REVIEW_GATE_CONFIG"), []);

  const cliEntry = prerequisites.host.cliEntry;
  let pty: OwnedPty;
  try {
    pty = nodePty.spawn(process.execPath, [
      cliEntry,
      "--no-extensions",
      "--extension", candidateEntry,
      "--no-session",
      "--offline",
      "--no-context-files",
      "--no-skills",
      "--no-themes",
    ], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: workspace,
      env: childEnv,
    });
  } catch (error) {
    // A PTY spawn that throws provides no PID to authenticate or settle.
    // Preserve the fixture instead of assuming no partial child was created.
    preserveSandbox = true;
    throw error;
  }
  try {
    session = new LivePiPty(pty);
  } catch (error) {
    // The handle exists but the driver could not establish its event receipts.
    // Request direct termination, wait briefly for the public exit event, and
    // preserve scratch because group settlement cannot be authenticated.
    preserveSandbox = true;
    try {
      const exited = new Promise<void>((resolve) => { pty.onExit(() => resolve()); });
      pty.kill("SIGTERM");
      await Promise.race([exited, delay(3_000)]);
    } catch { /* preserve scratch on any uncertainty */ }
    throw error;
  }
  assert.ok(session);
  assert.equal(session.claimOwnedProcessGroup(), true, "node-pty must provide a dedicated, positively owned POSIX process group");
  await session.waitForText("operating mode:", 30_000);

  // Initial config omits review.evidence. The real selector must show each
  // scope's default Tools + workspace changes and the separate fallback On.
  let evidenceFrame = await openEvidenceMenu(session);
  assertEvidenceRows(evidenceFrame, DEFAULTS, "fresh config defaults");
  assert.equal(await readDiskEvidence(configPath), undefined, "opening the real menu must not materialize defaults on disk");

  // A non-Primary scope is staged and applied alone. Its real screen and its
  // disk state establish independent flags and a no-Primary-reset path.
  await selectVisibleRow(session, "InPlace");
  let frame = await session.sendAndWait(KEY_ENTER, "InPlace");
  assert.match(frame, /InPlace\s+Tools only/, "the actual host screen must show the staged InPlace choice");
  assert.ok(!frame.includes(LIVE_WARNING),
    "changing only InPlace must not display the Primary-reset warning");
  await backToRoot(session);
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "nested Back/Escape must not apply or persist the staged InPlace change");
  frame = await applySessionOnly(session);
  assert.ok(!frame.includes(LIVE_WARNING),
    "applying only another scope must not display the Primary-reset warning");
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "root Escape must keep the non-Primary change off disk");

  // Reopening must reflect the applied session-only choice. Applying the
  // unchanged draft again is an observable no-warning/no-disk-write control.
  evidenceFrame = await openEvidenceMenu(session);
  assertEvidenceRows(evidenceFrame, { ...DEFAULTS, inplaceToolOnly: true }, "reopened after session-only apply");
  await backToRoot(session);
  frame = await applySessionOnly(session);
  assert.ok(!frame.includes(LIVE_WARNING),
    "an unchanged Primary value must not emit a reset warning");
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "unchanged root Escape must not persist anything");

  // A real Primary Tools + workspace changes → Tools only cycle must display the production prominent
  // warning. Root Escape applies it to this session only, not the config file.
  // No evidence has accumulated in this no-model smoke, so the underlying
  // evidence-window reset effect itself is intentionally not claimed here.
  evidenceFrame = await openEvidenceMenu(session);
  assertEvidenceRows(evidenceFrame, { ...DEFAULTS, inplaceToolOnly: true }, "before Primary transition");
  await selectVisibleRow(session, "Primary / top-level", 24, evidenceFrame);
  frame = await session.sendAndWait(KEY_ENTER, LIVE_WARNING, 10_000);
  const warningText = frame.replace(/\s+/g, " "); // native notification text may wrap at the real terminal width
  assert.ok(warningText.includes(`${LIVE_WARNING} clears accumulated primary review evidence`), "the visible warning must name the methods and pending reset");
  assert.ok(warningText.includes("Tools only → Tools + workspace changes retains evidence"), "the visible warning must name the inverse method and retention");
  assert.ok(warningText.includes("Cancel discards it"), "the observed warning must disclose that the reset remains staged until apply");
  await backToRoot(session);
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "nested navigation must not apply or persist the warned Primary draft");
  await applySessionOnly(session);
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "Primary root Escape must apply session-only without disk mutation");

  // The actual reopened screen is the source of truth for live in-memory state;
  // the raw config remains the source of truth for durable state.
  evidenceFrame = await openEvidenceMenu(session);
  const sessionOnly = { ...DEFAULTS, primaryToolOnly: true, inplaceToolOnly: true };
  assertEvidenceRows(evidenceFrame, sessionOnly, "reopened Primary session-only state");

  // Stage a Primary Tools only → Tools + workspace changes change plus Worktree/Fallback edits,
  // then Cancel. Pi keeps the earlier ui.notify warning in its visible
  // transcript and redraws it with subsequent rows, so after this point a
  // fresh-frame absence check cannot distinguish an old warning from a new
  // one. The staged row and post-Cancel live state remain directly observable.
  await selectVisibleRow(session, "Primary / top-level", 24, evidenceFrame);
  frame = await session.sendAndWait(KEY_ENTER, "Primary / top-level");
  assert.match(frame, /Primary \/ top-level\s+Tools \+ workspace changes/, "the staged Primary cancellation draft must visibly use Tools + workspace changes");
  await selectVisibleRow(session, "Isolated worktree");
  frame = await session.sendAndWait(KEY_ENTER, "Isolated worktree");
  assert.match(frame, /Isolated worktree\s+Tools only/, "the Cancel draft must visibly include an independent Worktree edit");
  await selectVisibleRow(session, "Snapshot-failure fallback");
  frame = await session.sendAndWait(KEY_ENTER, "Snapshot-failure fallback");
  assert.match(frame, /Snapshot-failure fallback\s+Off/, "the Cancel draft must visibly include an independent fallback edit");
  await backToRoot(session);
  await selectVisibleRow(session, "Cancel");
  await session.press(KEY_ENTER, 180);
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "Cancel must preserve the original config bytes");

  evidenceFrame = await openEvidenceMenu(session);
  assertEvidenceRows(evidenceFrame, sessionOnly, "reopened after Cancel");
  assert.equal(await readFile(configPath, "utf8"), initialBytes, "Cancel must preserve prior session-only state without saving it");

  // Explicit root Save persists a separate fallback change together with the
  // previously applied session-only Primary/InPlace values.
  await selectVisibleRow(session, "Snapshot-failure fallback");
  frame = await session.sendAndWait(KEY_ENTER, "Snapshot-failure fallback");
  assert.match(frame, /Snapshot-failure fallback\s+Off/, "the explicit-Save draft must visibly disable fallback");
  await backToRoot(session);
  await selectVisibleRow(session, "Save changes");
  await session.sendAndWait(KEY_ENTER, "Review settings saved.");
  const afterExplicitSave = { ...sessionOnly, snapshotFailureFallback: false };
  assertDiskEvidence(await readDiskEvidence(configPath), afterExplicitSave, "explicit Save");
  const savedDocument = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(savedDocument.smokeOnlyUnknownField, { preserve: true }, "Save must preserve unrelated config keys");

  // Finally exercise the actual nested Ctrl+S path: it persists a Worktree
  // edit and the full independent flag set from inside Evidence methods.
  evidenceFrame = await openEvidenceMenu(session);
  assertEvidenceRows(evidenceFrame, afterExplicitSave, "reopened after explicit Save");
  await selectVisibleRow(session, "Isolated worktree");
  frame = await session.sendAndWait(KEY_ENTER, "Isolated worktree");
  assert.match(frame, /Isolated worktree\s+Tools only/, "the nested Ctrl+S draft must visibly select Tools only for Worktree");
  await session.sendAndWait(KEY_CTRL_S, "Review settings saved.");
  const afterNestedSave: EvidenceValues = {
    primaryToolOnly: true,
    worktreeToolOnly: true,
    inplaceToolOnly: true,
    snapshotFailureFallback: false,
  };
  assertDiskEvidence(await readDiskEvidence(configPath), afterNestedSave, "nested Ctrl+S");
  assert.deepEqual(
    (JSON.parse(await readFile(configPath, "utf8")) as { review?: { evidence?: unknown } }).review?.evidence,
    afterNestedSave,
    "the real disk config must independently store all four persisted evidence flags",
  );

  // The documented Pi host exit is driven through the same real terminal.
  await session.press(KEY_CTRL_C, 120);
  await session.press(KEY_CTRL_C, 120);
  const exit = await session.waitForExit(30_000);
  assert.equal(exit.exitCode, 0, "the Pi host must exit normally on the documented Ctrl+C-twice sequence");
  assert.equal(await waitForGroupGone(session.pid, 3_000), true, "the owned PTY process group must settle before fixture cleanup");
});
