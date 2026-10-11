/**
 * Focused tests for the native image display acceptance fixture (issue #363,
 * hosted image display): tests/fixtures/pi-host-image-proof.cjs — a compact
 * test-only Pi 1.1.0 extension that appends a native visible custom message
 * rendering the choice's constant solid-color PNG through the installed
 * pi-tui Image component.
 *
 * What is actually verified here (truthful coverage; no physical display
 * claims):
 * 1. Both fixture PNG constants are structurally valid 16x16 8-bit RGBA PNGs
 *    (signature, per-chunk CRCs, IHDR fields, IDAT inflating to the exact raw
 *    scanline size) with every pixel the solid choice color — red pixels for
 *    red, blue pixels for blue, so the visible image (not only the label)
 *    identifies the session; deterministic, always runs.
 * 2. The fixture registers exactly one explicit diagnostic command and one
 *    message renderer; every other pi surface (tools, providers, events,
 *    startup output) is trapped in the mock and must stay unused.
 * 3. The command appends the native visible custom message per choice:
 *    plain-text label, display true, per-choice PNG identity (byte length +
 *    sha256, distinct for red vs blue) in details — image bytes never appear
 *    in message text or diagnostics.
 * 4. Against the ACTUALLY INSTALLED pi-tui peer (resolved from the installed
 *    @earendil-works/pi-coding-agent), the renderer returns a genuine native
 *    Image component per choice: instanceof the installed class, carrying the
 *    exact per-choice PNG bytes, and the SAME fixed native image ID for both
 *    choices (the intentional cross-process namespacing probe).
 * 5. The real installed pi interactive TUI on a plain PTY proves BOTH native
 *    render paths end to end: with PI_IMAGE_PROTOCOL=kitty the terminal byte
 *    stream carries the genuine kitty placement (a=T prefix, fixed image ID
 *    parameter, exact per-choice PNG base64 payload); without it the installed
 *    Image component's own text fallback line renders. The physical
 *    Ghostty/kitty pixel display is NOT observed here and not claimed; these
 *    are byte-stream assertions.
 * 6. Owned-process supervision: the pty.fork child lives in its OWN process
 *    group, so every path reaps the exact child with waitpid (reported in the
 *    driver verdict) instead of inferring exit from PTY EOF; a forced timeout
 *    test proves a SIGHUP/SIGTERM-ignoring owned child is SIGKILLed, reaped,
 *    and verified gone under both the driver's own cap and the TS-side
 *    backstop (which kills that separately owned group via a sidecar pid).
 *
 * Runtime tests skip when prerequisites are missing and hard-fail under
 * PI_REVIEW_GATE_REQUIRE_PI_HOST=1 (existing real-host convention). Every
 * child process is spawned, pid-tracked, and killed by this test (pty
 * children reaped with waitpid and verified gone via ESRCH probes); only the
 * test's own mkdtemp scratch trees are removed.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import test from "node:test";
import { skipOrFail } from "./bridge-fakes";
import { explicitInstalledAgentDir, findInstalledAgentDirs } from "./menu-tui-fakes";

const FIXTURE_NAME = "pi-host-image-proof.cjs";
/** Fixture-owned loader seam (documented in the fixture header). */
const TUI_ENTRY_SEAM = "PRG_HOST_IMAGE_PROOF_TUI_ENTRY";

interface FixtureModule {
  (pi: MockPi): Promise<void>;
  default: (pi: MockPi) => Promise<void>;
  CUSTOM_TYPE: string;
  COMMAND_NAME: string;
  IMAGE_FILENAME: string;
  FIXED_IMAGE_ID: number;
  RED_PNG_BASE64: string;
  BLUE_PNG_BASE64: string;
}

interface SentMessage {
  customType: string;
  content: string | unknown[];
  display: boolean;
  details?: unknown;
}

type MockPi = Record<string, unknown> & {
  on: (event: string) => void;
  registerCommand: (name: string, options: { description?: string; handler: (args: string) => Promise<void> }) => void;
  registerMessageRenderer: (customType: string, renderer: (message: SentMessage, options: unknown, theme: unknown) => unknown) => void;
  sendMessage: (message: SentMessage) => void;
};

/** The repo-root-relative fixture location, valid from compiled test output. */
function fixturePath(): string {
  const compiledRoot = resolvePath(__dirname, "..", ".."); // dist-test/tests -> repo root
  const sourceRoot = resolvePath(__dirname, ".."); // tests/ (source-side run)
  for (const root of [compiledRoot, sourceRoot]) {
    const candidate = join(root, "tests", "fixtures", FIXTURE_NAME);
    if (existsSync(candidate)) return candidate;
  }
  return join(sourceRoot, "tests", "fixtures", FIXTURE_NAME);
}

function loadFixtureModule(): FixtureModule {
  const path = fixturePath();
  delete require.cache[require.resolve(path)];
  return require(path) as unknown as FixtureModule;
}

/** Mock pi API: records the two allowed registrations, traps everything else. */
function createMockPi() {
  const commands = new Map<string, { description?: string; handler: (args: string) => Promise<void> }>();
  const renderers = new Map<string, (message: SentMessage, options: unknown, theme: unknown) => unknown>();
  const sent: SentMessage[] = [];
  const pi = {} as MockPi;
  pi.on = () => {
    throw new Error("fixture must not subscribe to session events (no automatic startup output)");
  };
  pi.registerCommand = (name, options) => commands.set(name, options);
  pi.registerMessageRenderer = (customType, renderer) => renderers.set(customType, renderer);
  pi.sendMessage = (message) => sent.push(message);
  for (const name of [
    "registerTool",
    "registerProvider",
    "unregisterProvider",
    "registerShortcut",
    "registerFlag",
    "appendEntry",
    "sendUserMessage",
    "exec",
    "getSettings",
    "getCommands",
    "setModel",
  ]) {
    (pi as Record<string, unknown>)[name] = () => {
      throw new Error(`fixture must not use pi.${name} (explicit diagnostic fixture only)`);
    };
  }
  return { pi, commands, renderers, sent };
}

// ---------------------------------------------------------------------------
// Part 1: the per-choice PNG constants are valid solid-color images
// ---------------------------------------------------------------------------

let crc32Table: Uint32Array | undefined;

function crc32(buffer: Buffer): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crc32Table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate a constant PNG: signature, chunk CRCs, IHDR, and every pixel. */
function validatePng(base64: string, expectedPixel: [number, number, number, number], label: string): void {
  const png = Buffer.from(base64, "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${label}: PNG signature`);
  const types: string[] = [];
  let ihdr: Buffer | undefined;
  let idat = Buffer.alloc(0);
  for (let pos = 8; pos < png.length; ) {
    assert.ok(png.length - pos >= 12, `${label}: chunk header truncated`);
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    const data = png.subarray(pos + 8, pos + 8 + length);
    assert.ok(png.length - pos >= 12 + length, `${label}: chunk ${type} truncated`);
    assert.equal(
      png.readUInt32BE(pos + 8 + length),
      crc32(Buffer.concat([png.subarray(pos + 4, pos + 8), data])),
      `${label}: CRC mismatch in ${type}`,
    );
    types.push(type);
    if (type === "IHDR") ihdr = Buffer.from(data);
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    pos += 12 + length;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"], `${label}: chunk order`);
  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  assert.equal(width, 16, `${label}: 16x16`);
  assert.equal(height, 16, `${label}: 16x16`);
  assert.equal(ihdr![8], 8, `${label}: 8-bit depth`);
  assert.equal(ihdr![9], 6, `${label}: color type RGBA`);
  assert.equal(ihdr![12], 0, `${label}: not interlaced`);
  const raw = zlib.inflateSync(idat);
  const stride = 1 + width * 4;
  assert.equal(raw.length, height * stride, `${label}: IDAT inflates to the exact raw scanline size`);
  for (let y = 0; y < height; y += 1) {
    const lineStart: number = y * stride;
    assert.equal(raw[lineStart], 0, `${label}: scanline ${y} uses filter type 0`);
    for (let x = 0; x < width; x += 1) {
      const offset = lineStart + 1 + x * 4;
      assert.deepEqual([...raw.subarray(offset, offset + 4)], expectedPixel, `${label}: pixel (${x},${y}) is solid`);
    }
  }
}

test("fixture PNG constants are valid 16x16 RGBA images with distinct solid colors", () => {
  const mod = loadFixtureModule();
  validatePng(mod.RED_PNG_BASE64, [255, 0, 0, 255], "red");
  validatePng(mod.BLUE_PNG_BASE64, [0, 0, 255, 255], "blue");
  assert.notEqual(mod.RED_PNG_BASE64, mod.BLUE_PNG_BASE64, "distinct bytes per choice (visible pixels identify the session)");
  const redSha = createHash("sha256").update(Buffer.from(mod.RED_PNG_BASE64, "base64")).digest("hex");
  const blueSha = createHash("sha256").update(Buffer.from(mod.BLUE_PNG_BASE64, "base64")).digest("hex");
  assert.notEqual(redSha, blueSha, "distinct per-choice identity");
});

test("fixture source carries no private paths or runtime locations", () => {
  const source = readFileSync(fixturePath(), "utf8");
  assert.ok(!source.includes("/Users/"), "no absolute home paths in tracked fixture");
  assert.ok(!source.includes(".pi-review-gate"), "no private runtime cache references");
  assert.ok(!source.includes("pi-runtime"), "no private runtime cache references");
});

// ---------------------------------------------------------------------------
// Part 2: registration contract and per-color message shape (mock pi)
// ---------------------------------------------------------------------------

test("fixture registers exactly the diagnostic command and one message renderer", async () => {
  const mod = loadFixtureModule();
  const { pi, commands, renderers } = createMockPi();
  await mod(pi);
  assert.equal(mod.COMMAND_NAME, "host-image-proof");
  assert.equal(mod.CUSTOM_TYPE, "prg-host-image-proof");
  assert.deepEqual([...commands.keys()], [mod.COMMAND_NAME], "exactly one explicit diagnostic command");
  assert.deepEqual([...renderers.keys()], [mod.CUSTOM_TYPE], "exactly one message renderer");
  const command = commands.get(mod.COMMAND_NAME);
  assert.ok(command, "command registered");
  assert.match(command.description ?? "", /red\|blue/);
});

test("command appends per-color native visible custom messages with distinct image identity", async () => {
  const mod = loadFixtureModule();
  const { pi, commands, sent } = createMockPi();
  await mod(pi);
  const command = commands.get(mod.COMMAND_NAME);
  if (!command) throw new Error("fixture did not register the expected command");
  const handler = command.handler;

  for (const [choice, base64] of [["red", mod.RED_PNG_BASE64], ["blue", mod.BLUE_PNG_BASE64]] as const) {
    await handler(choice);
    const message = sent[sent.length - 1];
    const bytes = Buffer.from(base64, "base64");
    assert.deepEqual(message, {
      customType: mod.CUSTOM_TYPE,
      content: `host-image-proof: ${choice}`,
      display: true,
      details: {
        choice,
        pngBytes: bytes.length,
        pngSha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }, `${choice}: native visible custom message with the exact per-color image identity`);
  }
  const redDetails = sent[0].details as { pngSha256: string };
  const blueDetails = sent[1].details as { pngSha256: string };
  assert.notEqual(redDetails.pngSha256, blueDetails.pngSha256, "distinct per-choice identity");

  // Image bytes never appear in message text or diagnostics.
  for (const message of sent) {
    const text = JSON.stringify(message);
    assert.ok(!text.includes(mod.RED_PNG_BASE64) && !text.includes(mod.BLUE_PNG_BASE64), "no PNG payload in message text or details");
  }

  await handler("green");
  const usage = sent[sent.length - 1];
  assert.match(String(usage.content), /expected "red" or "blue"/);
  assert.equal(usage.display, true);
  assert.deepEqual(usage.details, { choice: null }, "usage message carries no image identity");

  await handler("");
  assert.match(String(sent[sent.length - 1].content), /expected "red" or "blue"/);
});

test("renderer degrades to Pi's default box when the pi-tui peer is unavailable", async (t) => {
  const mod = loadFixtureModule();
  const previous = process.env[TUI_ENTRY_SEAM];
  process.env[TUI_ENTRY_SEAM] = join(tmpdir(), "prg-host-image-proof-missing-tui-entry.js");
  t.after(() => {
    if (previous === undefined) delete process.env[TUI_ENTRY_SEAM];
    else process.env[TUI_ENTRY_SEAM] = previous;
  });
  const { pi, commands, renderers, sent } = createMockPi();
  await mod(pi);
  const command = commands.get(mod.COMMAND_NAME);
  const renderer = renderers.get(mod.CUSTOM_TYPE);
  if (!command || !renderer) throw new Error("fixture did not register the expected surfaces");
  await command.handler("red");
  const component = renderer(sent[0], { expanded: false, outputPad: 1 }, {});
  assert.equal(component, undefined, "undefined renderer output lets Pi's default custom-message box show the label");
});

// ---------------------------------------------------------------------------
// Installed-host helpers (existing real-host conventions)
// ---------------------------------------------------------------------------

interface InstalledHost {
  agentDir: string;
  cliEntry: string;
  version: string;
}

/** Resolve an installed Pi 1.x host (PI_REVIEW_GATE_INSTALLED_AGENT pins it). */
function resolveInstalledHost(): InstalledHost | undefined {
  const candidates = [explicitInstalledAgentDir(), ...findInstalledAgentDirs()].filter(
    (dir): dir is string => dir !== undefined,
  );
  for (const agentDir of candidates) {
    const cliEntry = join(agentDir, "dist", "bundle", "cli.js");
    try {
      const version = (JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as { version?: string }).version ?? "";
      if (!/^[1-9]\d*$/.test(version.split(".")[0] ?? "")) continue; // fixture targets the Pi 1.x surface
      if (!existsSync(cliEntry)) continue;
      return { agentDir, cliEntry, version };
    } catch {
      // Unreadable install: try the next candidate.
    }
  }
  return undefined;
}

/** The installed pi-tui entry file inside the resolved host (public package name). */
function resolveInstalledTuiEntry(agentDir: string): string | undefined {
  try {
    return createRequire(join(agentDir, "package.json")).resolve("@earendil-works/pi-tui");
  } catch {
    return undefined;
  }
}

/** Load one module file: require (incl. require(esm)) then native dynamic import. */
async function loadModuleFile(filePath: string): Promise<Record<string, any> | undefined> {
  try {
    const mod = require(filePath) as unknown;
    if (mod && typeof mod === "object") return mod as Record<string, any>;
  } catch {
    // ERR_REQUIRE_ESM on older Node: use a native dynamic import.
  }
  // tsc rewrites `await import(x)` to require(x) in CommonJS output; compile a
  // native dynamic import the transpiler leaves untouched (src/host-peer-loader.ts).
  const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<unknown>;
  try {
    const mod = await nativeDynamicImport(pathToFileURL(filePath).href);
    return mod && typeof mod === "object" ? (mod as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Part 3: genuine installed pi-tui Image components (requires the installed host)
// ---------------------------------------------------------------------------

test("renderer builds genuine installed pi-tui Images: distinct pixels per choice, shared fixed image ID", async (t) => {
  const host = resolveInstalledHost();
  const tuiEntry = host ? resolveInstalledTuiEntry(host.agentDir) : undefined;
  if (!host || !tuiEntry) {
    skipOrFail(
      t,
      "installed Pi 1.x with a resolvable @earendil-works/pi-tui peer unavailable (PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)",
    );
    return;
  }
  const mod = loadFixtureModule();
  const previousSeam = process.env[TUI_ENTRY_SEAM];
  process.env[TUI_ENTRY_SEAM] = tuiEntry;
  t.after(() => {
    if (previousSeam === undefined) delete process.env[TUI_ENTRY_SEAM];
    else process.env[TUI_ENTRY_SEAM] = previousSeam;
  });

  const tui = await loadModuleFile(tuiEntry);
  assert.ok(tui && typeof tui.Image === "function", "installed pi-tui peer exposes the public Image export");

  const { pi, commands, renderers, sent } = createMockPi();
  await mod(pi);
  const command = commands.get(mod.COMMAND_NAME);
  const renderer = renderers.get(mod.CUSTOM_TYPE);
  if (!command || !renderer) throw new Error("fixture did not register the expected surfaces");
  const theme = { fg: (_name: string, text: string) => text };

  for (const [choice, base64] of [["red", mod.RED_PNG_BASE64], ["blue", mod.BLUE_PNG_BASE64]] as const) {
    await command.handler(choice);
    const component = renderer(sent[sent.length - 1], { expanded: false, outputPad: 1 }, theme) as any;
    assert.ok(component instanceof tui.Container, `renderer returns the installed pi-tui Container (${choice})`);
    const children: unknown[] = component.children;
    assert.equal(children.length, 2, `${choice}: label + native image`);
    assert.ok(children[0] instanceof tui.Text, `${choice}: native message text label`);
    const image: any = children[1];
    assert.ok(image instanceof tui.Image, `genuine installed pi-tui Image component (${choice})`);
    assert.equal(image.base64Data, base64, `Image carries the exact ${choice} PNG bytes (distinct visible pixels)`);
    assert.equal(
      image.getImageId(),
      mod.FIXED_IMAGE_ID,
      "same fixed native image ID for every choice and session (intentional cross-process namespacing probe)",
    );
  }

  // Usage message (no valid choice): label only, no image.
  await command.handler("green");
  const usageComponent = renderer(sent[sent.length - 1], { expanded: false, outputPad: 1 }, theme) as any;
  assert.ok(usageComponent instanceof tui.Container);
  assert.equal((usageComponent.children as unknown[]).length, 1, "no image for an invalid choice");
});

// ---------------------------------------------------------------------------
// Part 4: real installed pi interactive TUI on a plain PTY (bounded seconds)
// ---------------------------------------------------------------------------

const TEXT_KEYS = (text: string): string => Buffer.from(text, "utf8").toString("hex");
const CTRL_C_CTRL_C = "0303";
/** Default overall cap for the PTY driver session (ms). */
const DEFAULT_PTY_DRIVER_CAP_MS = 90_000;
/** Fixture-owned test seams (documented in the driver source header). */
const DRIVER_CAP_SEAM = "PRG_HOST_IMAGE_PROOF_PTY_DRIVER_CAP_MS";
const BACKSTOP_SEAM = "PRG_HOST_IMAGE_PROOF_PTY_BACKSTOP_MS";

function ptyDriverCapMs(): number {
  const raw = Number.parseInt(process.env[DRIVER_CAP_SEAM] ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PTY_DRIVER_CAP_MS;
}

/** TS-side backstop: by default slightly after the driver's own cap so the graceful Python cleanup path wins. */
function ptyBackstopMs(driverCapMs: number): number {
  const raw = Number.parseInt(process.env[BACKSTOP_SEAM] ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : driverCapMs + 15_000;
}

/** Read the owned pty child pid the driver publishes immediately after fork. */
function readSidecarPid(sidecarPath: string): number | undefined {
  try {
    const parsed = Number.parseInt(readFileSync(sidecarPath, "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group already gone.
  }
}

/** Positive proof a pid is gone: the signal-0 probe throws ESRCH (bounded). */
async function processGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
}

interface BackstopState {
  fired: boolean;
  childPid?: number;
}

/**
 * TS-side backstop for a detached PTY driver. The pty.fork child lives in its
 * OWN session/process group, so killing the driver's group (or closing the
 * PTY) does not reach it: on the cap this kills the driver group AND the
 * separately owned child group via the published sidecar pid.
 */
function armPtyBackstop(
  driver: ChildProcess,
  driverPid: number | undefined,
  sidecarPath: string,
  backstopMs: number,
): { state: BackstopState; cancel: () => void } {
  const state: BackstopState = { fired: false };
  const timer = setTimeout(() => {
    state.fired = true;
    if (driverPid !== undefined) killProcessGroup(driverPid);
    try {
      driver.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    state.childPid = readSidecarPid(sidecarPath);
    if (state.childPid !== undefined) killProcessGroup(state.childPid);
  }, backstopMs);
  timer.unref?.();
  return { state, cancel: () => clearTimeout(timer) };
}

/** Bounded wait for the driver's own exit (safety net; on breach kills the
 * driver group AND the separately owned pty child group via the sidecar). */
async function awaitDriverExit(driver: ChildProcess, timeoutMs: number, sidecarPath?: string): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      if (driver.pid !== undefined) killProcessGroup(driver.pid);
      try {
        driver.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      const childPid = sidecarPath ? readSidecarPid(sidecarPath) : undefined;
      if (childPid !== undefined) killProcessGroup(childPid);
      rejectPromise(new Error(`PTY driver did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    driver.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
    driver.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

interface PtyChildExit {
  exited?: boolean;
  code?: number;
  signaled?: boolean;
  signal?: number;
  note?: string;
  unknown?: boolean;
}

interface PtyDriverResult {
  ok: boolean;
  alive: boolean;
  pid?: number;
  /** Confirmed exit status of the exact owned pty child (waitpid), not PTY EOF. */
  childExit?: PtyChildExit;
  steps: Array<{ index: number; ok: boolean; error?: string; evidence?: string }>;
  lastScreen?: string;
}

/**
 * Compact PTY driver (Python stdlib only): forks a real pseudo-terminal,
 * launches the installed pi through the public --no-extensions --extension
 * seam with a scrubbed allowlisted environment (no PI_REVIEW_GATE_* variables,
 * no provider keys — no model/API call is possible), walks the scripted steps,
 * and writes a JSON verdict.
 *
 * Owned-child supervision contract (the pty.fork child is a session leader in
 * its OWN process group; PTY closure/SIGHUP alone is never relied upon):
 * - immediately after fork (inside the protected block), the exact child pid
 *   is published to <sandbox>/child-pid.txt so the TS-side backstop can kill
 *   that separately owned group even if this driver is SIGKILLed before
 *   Python cleanup runs;
 * - every path (post-fork setup failure, step failure, deadline breach,
 *   unexpected exception) goes through a finally that reaps the exact child
 *   with waitpid — first non-blocking, then bounded SIGTERM->SIGKILL
 *   escalation against its process group — and reports the confirmed exit
 *   status in the verdict; setup (sidecar publication, PTY init) runs inside
 *   the protected block so it cannot bypass cleanup;
 * - PRG_PTY_CHILD (test seam): run an owned non-pi child instead of pi;
 * - PRG_PTY_IMAGE_PROTOCOL (test seam): force PI_IMAGE_PROTOCOL in the child.
 */
const PTY_DRIVER_SOURCE = String.raw`
import os, pty, sys, time, select, signal, struct, fcntl, termios, re, json

sandbox, result_path = sys.argv[1:3]
steps = json.load(open(os.path.join(sandbox, "steps.json")))
child_pid_file = os.path.join(sandbox, "child-pid.txt")

# Overall wall-clock cap for this driver (fixture-owned test seam; default 90s).
overall_deadline = time.time() + float(os.environ.get("PRG_HOST_IMAGE_PROOF_PTY_DRIVER_CAP_MS", "90000")) / 1000.0

home = os.path.join(sandbox, "home")
workspace = os.path.join(sandbox, "workspace")
os.makedirs(os.path.join(home, ".pi", "agent"), exist_ok=True)
os.makedirs(workspace, exist_ok=True)

allow = ("PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL")
child_env = {key: os.environ[key] for key in allow if key in os.environ}
child_env["HOME"] = home
child_env["USERPROFILE"] = home
child_env["TERM"] = "xterm-256color"
for var in ("TMUX", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "ITERM_SESSION_ID"):
    child_env.pop(var, None)
if os.environ.get("PRG_PTY_IMAGE_PROTOCOL"):
    child_env["PI_IMAGE_PROTOCOL"] = os.environ["PRG_PTY_IMAGE_PROTOCOL"]

if os.environ.get("PRG_PTY_CHILD"):
    # Test seam: run an owned non-pi child (e.g. a SIGHUP/SIGTERM-ignoring stub).
    argv = [os.environ["PRG_PTY_CHILD"]]
else:
    argv = [os.environ["NODE_BIN"], os.environ["PRG_PI_CLI"],
            "--no-extensions", "--extension", os.environ["PRG_FIXTURE"],
            "--no-session", "--offline", "--no-context-files", "--no-skills", "--no-themes"]

pid, master = pty.fork()
if pid == 0:
    os.chdir(workspace)
    os.environ.clear()
    os.environ.update(child_env)
    try:
        os.execvp(argv[0], argv)
    except Exception:
        os._exit(127)

buffer = bytearray()
alive = [True]
last_raw_offset = [0]
last_clean_offset = [0]
child_exit = [None]

def try_reap():
    """Reap the exact owned child without blocking; record its exit status."""
    try:
        done, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        child_exit[0] = {"note": "already reaped"}
        return True
    if done == pid:
        if os.WIFSIGNALED(status):
            child_exit[0] = {"signaled": True, "signal": os.WTERMSIG(status)}
        elif os.WIFEXITED(status):
            child_exit[0] = {"exited": True, "code": os.WEXITSTATUS(status)}
        else:
            child_exit[0] = {"unknown": True}
        return True
    return False

def terminate_child():
    """Bounded SIGTERM->SIGKILL escalation against the child's own process
    group, then a confirmed waitpid reap (survives SIGHUP/SIGTERM ignores)."""
    if child_exit[0] is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except Exception:
            pass
        deadline = time.time() + 3.0
        while time.time() < deadline:
            if try_reap():
                return
            time.sleep(0.05)

def pump(seconds):
    end = min(time.time() + seconds, overall_deadline)
    while time.time() < end and alive[0]:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            alive[0] = False
            return
        if not data:
            alive[0] = False
            return
        buffer.extend(data)

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07")

def visible():
    text = bytes(buffer).decode("utf-8", "replace")
    return ANSI_RE.sub("", text).replace("\x1b>", "").replace("\x1b=", "")

def fresh_visible():
    return visible()[last_clean_offset[0]:]

def raw_fresh():
    # Unstripped bytes since the last send (kitty protocol assertions).
    return bytes(buffer[last_raw_offset[0]:]).decode("utf-8", "replace")

def wait_for(marker, timeout_ms):
    deadline = min(time.time() + timeout_ms / 1000.0, overall_deadline)
    while time.time() < deadline and alive[0]:
        if marker in fresh_visible():
            return True
        pump(0.25)
    if marker in fresh_visible():
        return True
    if time.time() >= overall_deadline:
        raise RuntimeError("overall driver deadline exceeded")
    return False

def wait_exit(timeout_ms):
    deadline = min(time.time() + timeout_ms / 1000.0, overall_deadline)
    while time.time() < deadline and alive[0]:
        pump(0.25)
    if not alive[0]:
        return True
    if time.time() >= overall_deadline:
        raise RuntimeError("overall driver deadline exceeded")
    return False

def send(keys):
    last_raw_offset[0] = len(bytes(buffer))
    last_clean_offset[0] = len(visible())
    try:
        os.write(master, keys)
    except OSError:
        alive[0] = False

def run_assert(kind, step):
    # Output emitted since the last send: stale history cannot satisfy.
    source = raw_fresh if kind == "assert_raw_fresh" else fresh_visible
    deadline = min(time.time() + step.get("timeoutMs", 15000) / 1000.0, overall_deadline)
    current = ""
    while True:
        pump(0.3)
        current = source()
        if all(marker in current for marker in step.get("includes", [])):
            break
        if time.time() >= deadline:
            break
    for marker in step.get("includes", []):
        if marker not in current:
            raise RuntimeError("%s missing %r" % (kind, marker))
    return repr(current[-1200:])

results = []
ok = True
try:
    # Setup failures must also terminate and reap the exact owned child.
    # Sidecar publication first: the TS-side backstop uses it to kill this
    # separately owned group if the driver is SIGKILLed before cleanup runs.
    with open(child_pid_file, "w") as handle:
        handle.write(str(pid))
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.set_blocking(master, False)
    for index, step in enumerate(steps):
        kind = step.get("type")
        entry = {"index": index, "ok": True}
        try:
            if not alive[0] and kind != "wait_exit":
                raise RuntimeError("child exited before this step")
            if kind == "wait":
                if not wait_for(step["marker"], step.get("timeoutMs", 20000)):
                    raise RuntimeError("timed out waiting for %r" % step["marker"])
            elif kind == "wait_exit":
                if not wait_exit(step.get("timeoutMs", 20000)):
                    raise RuntimeError("child did not exit within the deadline")
            elif kind == "send":
                send(bytes.fromhex(step["hex"]))
                pump(0.8)
            elif kind in ("assert_fresh", "assert_raw_fresh"):
                entry["evidence"] = run_assert(kind, step)
            elif kind == "assert_visible":
                deadline = min(time.time() + step.get("timeoutMs", 15000) / 1000.0, overall_deadline)
                current = ""
                while True:
                    pump(0.3)
                    current = visible()
                    if all(marker in current for marker in step.get("includes", [])):
                        break
                    if time.time() >= deadline:
                        break
                entry["evidence"] = repr(current[-1500:])
                for marker in step.get("includes", []):
                    if marker not in current:
                        raise RuntimeError("screen missing %r" % marker)
            else:
                raise RuntimeError("unknown step type %r" % kind)
        except Exception as error:
            entry["ok"] = False
            entry["error"] = str(error)
            entry.setdefault("evidence", repr(visible()[-1500:]))
            ok = False
        results.append(entry)
        if not ok:
            break
except Exception as error:
    # A post-fork setup failure (sidecar publication, PTY init) lands here.
    ok = False
    results.append({"index": -1, "ok": False, "error": str(error)})
finally:
    # Confirm the exact owned child's exit on EVERY path before the verdict is
    # written and the sandbox removed (reap, else escalate, then waitpid).
    try_reap()
    terminate_child()
    try:
        os.close(master)
    except Exception:
        pass

with open(result_path, "w") as handle:
    json.dump({"ok": ok, "alive": alive[0], "pid": pid, "childExit": child_exit[0],
               "steps": results, "lastScreen": visible()[-2500:]}, handle)
sys.exit(0 if ok else 1)
`;

async function hasPython3(): Promise<boolean> {
  const result = spawnSync("python3", ["-c", "print(1)"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/** One bounded pi PTY render walk: spawn the driver, arm the backstop, read the verdict. */
async function runPtyWalk(host: InstalledHost, sandbox: string, steps: unknown[], imageProtocol?: string): Promise<{ result: PtyDriverResult; backstopFired: boolean }> {
  const resultPath = join(sandbox, `result-${imageProtocol ?? "fallback"}.json`);
  await writeFile(join(sandbox, "steps.json"), JSON.stringify(steps));
  const driverCap = ptyDriverCapMs();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: sandbox,
    NODE_BIN: process.execPath,
    PRG_PI_CLI: host.cliEntry,
    PRG_FIXTURE: fixturePath(),
    [DRIVER_CAP_SEAM]: String(driverCap),
  };
  if (imageProtocol) env.PRG_PTY_IMAGE_PROTOCOL = imageProtocol;
  const driver = spawn("python3", [join(sandbox, "driver.py"), sandbox, resultPath], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
    env,
  });
  // Backstop for a hung/dead driver: kills the driver group AND the separately
  // owned pty child group (via the sidecar pid) — PTY closure is not relied on.
  const backstop = armPtyBackstop(driver, driver.pid, join(sandbox, "child-pid.txt"), ptyBackstopMs(driverCap));
  let settled = false;
  const result: PtyDriverResult = await new Promise((resolve) => {
    driver.on("error", (error) => {
      if (settled) return;
      settled = true;
      backstop.cancel();
      resolve({ ok: false, alive: false, steps: [], lastScreen: `driver spawn failed: ${String(error)}` });
    });
    driver.on("exit", () => {
      if (settled) return;
      settled = true;
      backstop.cancel();
      try {
        resolve(JSON.parse(readFileSync(resultPath, "utf8")) as PtyDriverResult);
      } catch {
        resolve({ ok: false, alive: false, steps: [], lastScreen: "driver produced no result.json (killed or crashed)" });
      }
    });
  });
  return { result, backstopFired: backstop.state.fired };
}

/** Assert the shared owned-process settlement proof for one completed walk. */
function assertWalkSettled(result: PtyDriverResult, label: string): void {
  assert.ok(!result.alive, `${label}: the owned pi PTY child must have exited`);
  // Positive owned-process cleanup proof: the exact child's exit was confirmed
  // by waitpid in the driver (not inferred from PTY EOF).
  assert.ok(
    result.childExit !== undefined && (result.childExit.exited === true || result.childExit.signaled === true),
    `${label}: owned pi PTY child exit confirmed by waitpid (child pid ${result.pid ?? "?"}): ${JSON.stringify(result.childExit)}`,
  );
}

test("installed pi PTY renders the chosen color natively: kitty protocol bytes and text fallback", async (t) => {
  const host = resolveInstalledHost();
  if (!host) {
    skipOrFail(t, "installed Pi 1.x unavailable (PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)");
    return;
  }
  if (!(await hasPython3())) {
    skipOrFail(t, "python3 unavailable for the PTY driver");
    return;
  }
  const tuiEntry = resolveInstalledTuiEntry(host.agentDir);
  const tui = tuiEntry ? await loadModuleFile(tuiEntry) : undefined;
  if (!tui || typeof tui.imageFallback !== "function") {
    skipOrFail(t, "installed @earendil-works/pi-tui peer unavailable (PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)");
    return;
  }

  const mod = loadFixtureModule();
  const sandbox = await mkdtemp(join(tmpdir(), "prg-host-image-proof-pty-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(join(sandbox, "driver.py"), PTY_DRIVER_SOURCE);

  // The installed Image component's own text fallback line (no image protocol).
  const fallbackLine = tui.imageFallback("image/png", { widthPx: 16, heightPx: 16 }, mod.IMAGE_FILENAME);
  // Genuine kitty placement markers from the installed encoder contract:
  // \x1b_Ga=T,f=100,q=2,C=1,c=..,r=..,i=<fixedId>;<per-choice base64>\x1b\\
  const kittyPrefix = "\u001b_Ga=T,f=100,q=2,C=1,";
  const imageIdParam = `,i=${mod.FIXED_IMAGE_ID};`;
  const kittyPayload = (base64: string): string => `;${base64}\u001b\\`;

  // Shared walk skeleton: startup -> one step block per choice -> host exit.
  const startupSteps = [
    { type: "wait", marker: "Press ctrl+o", timeoutMs: 30_000 },
    { type: "assert_visible", includes: ["[Extensions]", "pi-host-image-proof.cjs"], timeoutMs: 15_000 },
  ];
  const exitSteps = [
    { type: "send", hex: CTRL_C_CTRL_C },
    { type: "wait_exit", timeoutMs: 20_000 },
  ];
  const choiceSteps = (choice: string, imageKind: "assert_raw_fresh" | "assert_fresh", imageMarkers: string[]): unknown[] => [
    { type: "send", hex: TEXT_KEYS(`/host-image-proof ${choice}\r`) },
    { type: imageKind, includes: imageMarkers, timeoutMs: 20_000 },
    { type: "assert_fresh", includes: [`host-image-proof: ${choice}`], timeoutMs: 5_000 },
  ];

  // Walk A: PI_IMAGE_PROTOCOL=kitty — the terminal byte stream must carry the
  // native kitty placement with the exact per-choice PNG payload and ID.
  const walkA = await runPtyWalk(
    host,
    sandbox,
    [
      ...startupSteps,
      ...choiceSteps("red", "assert_raw_fresh", [kittyPrefix, imageIdParam, kittyPayload(mod.RED_PNG_BASE64)]),
      ...choiceSteps("blue", "assert_raw_fresh", [kittyPrefix, imageIdParam, kittyPayload(mod.BLUE_PNG_BASE64)]),
      ...exitSteps,
    ],
    "kitty",
  );
  const failedA = walkA.result.steps.filter((step) => !step.ok);
  const detailA =
    failedA.length > 0
      ? failedA.map((step) => `step ${step.index}: ${step.error ?? "unknown"}\nevidence:\n${step.evidence ?? ""}`).join("\n---\n")
      : walkA.result.lastScreen ?? "";
  assert.ok(walkA.result.ok, `kitty PTY render walk failed (owned pi child pid ${walkA.result.pid ?? "?"}):\n${detailA}`);
  assertWalkSettled(walkA.result, "kitty");
  assert.ok((await processGone(walkA.result.pid!, 5_000)), "kitty: owned child verified gone (ESRCH) after waitpid reap");
  console.log(
    `prg-host-image-proof pty(kitty): owned pi child pid ${walkA.result.pid} emitted the native kitty placement with the exact red and blue PNG payloads (fixed image ID ${mod.FIXED_IMAGE_ID}), then exited (waitpid: ${JSON.stringify(walkA.result.childExit)}${walkA.backstopFired ? "; TS backstop fired" : ""})`,
  );

  // Walk B: no image protocol — the installed Image component's own text
  // fallback line renders for both choices (byte-stream assertion, not pixels).
  const walkB = await runPtyWalk(host, sandbox, [
    ...startupSteps,
    ...choiceSteps("red", "assert_fresh", [fallbackLine]),
    ...choiceSteps("blue", "assert_fresh", [fallbackLine]),
    ...exitSteps,
  ]);
  const failedB = walkB.result.steps.filter((step) => !step.ok);
  const detailB =
    failedB.length > 0
      ? failedB.map((step) => `step ${step.index}: ${step.error ?? "unknown"}\nevidence:\n${step.evidence ?? ""}`).join("\n---\n")
      : walkB.result.lastScreen ?? "";
  assert.ok(walkB.result.ok, `fallback PTY render walk failed (owned pi child pid ${walkB.result.pid ?? "?"}):\n${detailB}`);
  assertWalkSettled(walkB.result, "fallback");
  assert.ok((await processGone(walkB.result.pid!, 5_000)), "fallback: owned child verified gone (ESRCH) after waitpid reap");
  console.log(
    `prg-host-image-proof pty(fallback): owned pi child pid ${walkB.result.pid} rendered the installed Image text fallback line for red and blue, then exited (waitpid: ${JSON.stringify(walkB.result.childExit)}${walkB.backstopFired ? "; TS backstop fired" : ""})`,
  );
});

// ---------------------------------------------------------------------------
// Part 5: forced PTY timeout — owned-child supervision under failure paths
// ---------------------------------------------------------------------------

test("forced PTY timeout: a SIGHUP/SIGTERM-ignoring owned child is killed, reaped, and verified gone", async (t) => {
  if (!(await hasPython3())) {
    skipOrFail(t, "python3 unavailable for the PTY driver");
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "prg-host-image-proof-pty-timeout-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const driverPath = join(sandbox, "driver.py");
  await writeFile(driverPath, PTY_DRIVER_SOURCE);

  // Owned test child: ignores SIGHUP (PTY closure) and SIGTERM; only SIGKILL
  // reaches it. Proves cleanup does not rely on PTY closure or SIGTERM.
  const stubbornChild = join(sandbox, "stubborn-child.sh");
  await writeFile(stubbornChild, "#!/bin/sh\ntrap '' HUP TERM\nwhile :; do sleep 1; done\n");
  await chmod(stubbornChild, 0o700);

  // A step that can never succeed within the caps below.
  await writeFile(join(sandbox, "steps.json"), JSON.stringify([{ type: "wait", marker: "prg-never-marker", timeoutMs: 30_000 }]));

  const driverEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: sandbox,
    PRG_PTY_CHILD: stubbornChild,
    ...extra,
  });

  // Phase A: the driver's own overall cap fires. Its finally must escalate to
  // SIGKILL (SIGHUP/SIGTERM are ignored), reap the exact child with waitpid,
  // and report the confirmed exit status in result.json before exiting.
  {
    const resultPath = join(sandbox, "result-a.json");
    const sidecar = join(sandbox, "child-pid.txt");
    const driver = spawn("python3", [driverPath, sandbox, resultPath], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
      env: driverEnv({ [DRIVER_CAP_SEAM]: "6000" }),
    });
    const code = await awaitDriverExit(driver, 30_000, sidecar);
    assert.equal(code, 1, "driver exits nonzero after the forced deadline");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as PtyDriverResult;
    assert.equal(result.ok, false);
    assert.ok(result.pid !== undefined && result.pid > 0, "owned child pid tracked");
    assert.deepEqual(
      result.childExit,
      { signaled: true, signal: 9 },
      "child reaped via waitpid after SIGKILL escalation (SIGHUP/SIGTERM ignored)",
    );
    assert.ok(await processGone(result.pid!, 5_000), "owned child verified gone (ESRCH)");
    assert.ok(driver.pid !== undefined && (await processGone(driver.pid, 5_000)), "driver verified gone (ESRCH)");
    console.log(`prg-host-image-proof pty-timeout A: driver self-cap killed+reaped stubborn child pid ${result.pid} (signal 9), driver pid ${driver.pid}`);
  }

  // Phase B: the TS backstop fires while the driver is still waiting. It must
  // kill the separately owned pty child through the sidecar — not PTY closure.
  {
    const resultPath = join(sandbox, "result-b.json");
    const sidecar = join(sandbox, "child-pid.txt");
    const driver = spawn("python3", [driverPath, sandbox, resultPath], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
      env: driverEnv({ [DRIVER_CAP_SEAM]: "120000" }),
    });
    const backstop = armPtyBackstop(driver, driver.pid, sidecar, 5_000);
    await awaitDriverExit(driver, 20_000, sidecar);
    backstop.cancel();
    assert.ok(backstop.state.fired, "TS backstop fired before the driver could self-cap");
    assert.ok(!existsSync(resultPath), "SIGKILLed driver cannot write its verdict");
    const childPid = backstop.state.childPid;
    assert.ok(childPid !== undefined && childPid > 0, "sidecar published the owned child pid before the backstop fired");
    assert.ok(await processGone(childPid!, 5_000), "backstop killed and verified the separately owned pty child gone (ESRCH)");
    assert.ok(driver.pid !== undefined && (await processGone(driver.pid, 5_000)), "driver verified gone (ESRCH)");
    console.log(`prg-host-image-proof pty-timeout B: TS backstop killed+verified stubborn child pid ${childPid} and driver pid ${driver.pid}`);
  }

  // Phase C: a setup failure after fork (before any step) must still terminate
  // and reap the exact owned child; the verdict records the setup error.
  {
    const failingDriver = PTY_DRIVER_SOURCE.replace(
      'fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))',
      'raise RuntimeError("forced PTY setup failure")',
    );
    assert.ok(failingDriver !== PTY_DRIVER_SOURCE, "setup-failure injection point present in the driver source");
    const failingPath = join(sandbox, "driver-setup-fail.py");
    await writeFile(failingPath, failingDriver);
    const resultPath = join(sandbox, "result-c.json");
    const sidecar = join(sandbox, "child-pid.txt");
    const driver = spawn("python3", [failingPath, sandbox, resultPath], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
      env: driverEnv({}),
    });
    const code = await awaitDriverExit(driver, 20_000, sidecar);
    assert.equal(code, 1, "driver exits nonzero after the forced setup failure");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as PtyDriverResult;
    assert.equal(result.ok, false);
    const setupEntry = result.steps.find((step) => step.index === -1);
    assert.ok(setupEntry !== undefined && setupEntry.ok === false, "setup failure recorded in the verdict");
    assert.match(setupEntry?.error ?? "", /forced PTY setup failure/, "verdict carries the setup error");
    // TERM may land before the stub installs its ignore trap (Phase A pins the
    // full KILL-escalation path); either way the exact child is confirmed reaped.
    assert.ok(
      result.childExit !== undefined &&
        result.childExit.signaled === true &&
        (result.childExit.signal === 9 || result.childExit.signal === 15),
      `setup failure still reaped the exact owned child via waitpid: ${JSON.stringify(result.childExit)}`,
    );
    assert.ok(result.pid !== undefined && result.pid > 0, "owned child pid tracked");
    assert.ok(await processGone(result.pid!, 5_000), "owned child verified gone (ESRCH)");
    assert.ok(driver.pid !== undefined && (await processGone(driver.pid, 5_000)), "driver verified gone (ESRCH)");
    console.log(`prg-host-image-proof pty-timeout C: forced setup failure still killed+reaped stubborn child pid ${result.pid} (signal ${result.childExit?.signal}), driver pid ${driver.pid}`);
  }
});
