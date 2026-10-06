// Compiled-launch regression for the unified notification expansion wiring
// (#92 correction). This reproduces the production failure exactly as the user
// saw it and proves the correction at the real public seam:
//
// - the ACTUAL compiled CommonJS candidate (dist/src/index.js built by tsc,
//   never jiti-transformed) is launched inside the REAL installed Pi TUI
//   through `pi --no-extensions --extension <candidate>` on a real PTY;
// - a fixture extension loaded through the same public `--extension` seam (a
//   second, repeatable flag) sends deterministic synthetic notification
//   messages via pi's public `sendMessage(..., { triggerTurn: false })` — no
//   model, no provider API, no network;
// - the two neighbouring pi-review-subtask-event messages and the
//   pi-review-bg-shell wake must render COMPACTLY with the live configured
//   expansion hint, expand/contract COMPLETELY under the real configured
//   binding (default Ctrl+O AND a user-remapped keybindings.json binding with
//   its real keystroke; a configured-empty binding renders no hint), and
//   toggle individually on a real fullscreen mouse click without disturbing
//   the neighbour.
//
// The regression is the compiled-launch behavior itself: no
// setPiTuiHost/setNativeExpansionHost injection exists anywhere in this file —
// those component-level seams exist in other test files and masked the missing
// peer wiring. Everything below happens only through pi's public surface.
//
// Host conventions: same as tests/pi-tui-live-settings-smoke.test.ts (skip on
// missing prerequisites locally; hard-fail under PI_REVIEW_GATE_REQUIRE_PI_HOST).
// Reported gap: the click step depends on the running Pi TUI recording the
// press target for custom-message rows; if the installed host never dispatches
// the synthesized click to the extension's MouseRegion, that step fails with
// the concrete observation rather than being silently skipped.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { skipOrFail } from "./bridge-fakes";
import { explicitInstalledAgentDir, findInstalledAgentDir } from "./menu-tui-fakes";

const projectRoot = join(dirname(__dirname), "..");

/** Raw key hex for the driver steps. */
const KEYS = {
  enter: "0d",
  ctrlO: "0f",
  ctrlE: "05",
  ctrlC: "03",
};

interface DriverStep {
  type: "wait" | "wait_exit" | "send" | "settle" | "assert_latest" | "click";
  marker?: string;
  hex?: string;
  offsetX?: number;
  seconds?: number;
  includes?: string[];
  excludes?: string[];
  timeoutMs?: number;
}

interface DriverResult {
  ok: boolean;
  alive: boolean;
  steps: Array<{ index: number; ok: boolean; screen?: string; error?: string; clicked?: string }>;
  lastScreen: string;
}

const DRIVER_OVERALL_TIMEOUT_MS = 6 * 60_000;

// ── The synthetic notifications the fixture extension sends ──────────────────
// Sentinel bodies model the two user-reported production examples (an in-place
// subtask settlement "reported" and a background-shell exit wake) with unique
// deep-content markers that exist ONLY in the complete retained text.

const SUBTASK_A_HEADER = "Task: task-fixaaa · Create fixture-a-file with lorem ipsum · reported";
const SUBTASK_A_CONTENT = [
  "In-place subtask task-fixaaa finished in place in /tmp/fixture-ws. Review: passed.",
  "Workspace changes since launch: added fixture-a-file.txt",
  SUBTASK_A_HEADER,
  "Top-off opportunity: up to 16 additional task(s) can run in place.",
  "In-place exec-777 COMPLETE: 1/1 tasks settled in place.",
  "Full report: /tmp/fixture-report-a.md",
  "",
  "REPORT-SENTINEL-A: fixture-alpha-zulu-body",
].join("\n");

const SUBTASK_B_HEADER = "Task: task-fixbbb · Fixture neighbour summary task · reported";
const SUBTASK_B_CONTENT = [
  "In-place subtask task-fixbbb finished in place in /tmp/fixture-ws. Review: passed.",
  "Workspace changes since launch: added fixture-b-file.txt",
  SUBTASK_B_HEADER,
  "In-place exec-888 COMPLETE: 1/1 tasks settled in place.",
  "Full report: /tmp/fixture-report-b.md",
  "",
  "REPORT-SENTINEL-B: fixture-bravo-yankee-body",
].join("\n");

const BG_SHELL_CONTENT = [
  'background job "fixture-job" (job-1) — exited 0',
  "command: sleep 30 && echo fixture-done > /tmp/fixture-job-out.txt",
  "running: 31s · exit 0",
  "last 1 of 1 lines:",
  "```",
  "EXCERPT-SENTINEL-C: fixture-charlie-xray-output",
  "```",
].join("\n");

/** The fixture extension written into the sandbox and loaded via --extension. */
function fixtureExtensionSource(): string {
  const send = (customType: string, content: string, details: unknown): unknown =>
    ({ customType, content, display: true, details });
  return `
export default function register(pi) {
  pi.registerCommand("fixture-notify", {
    description: "send deterministic review-gate notification fixtures",
    handler: async () => {
      pi.sendMessage(
        ${JSON.stringify(send("pi-review-subtask-event", SUBTASK_A_CONTENT, { state: "reported", executionId: "exec-777" }))},
        { triggerTurn: false },
      );
      pi.sendMessage(
        ${JSON.stringify(send("pi-review-subtask-event", SUBTASK_B_CONTENT, { state: "reported", executionId: "exec-888" }))},
        { triggerTurn: false },
      );
      pi.sendMessage(
        ${JSON.stringify(send("pi-review-bg-shell", BG_SHELL_CONTENT, { id: "job-1", kind: "exit" }))},
        { triggerTurn: false },
      );
    },
  });
}
`;
}

async function runDriver(
  driverPath: string,
  sandbox: string,
  cliEntry: string,
  candidateEntry: string,
  fixtureEntry: string,
): Promise<DriverResult> {
  const resultPath = join(sandbox, "result.json");
  return await new Promise<DriverResult>((resolve) => {
    const child = spawn("python3", [driverPath, sandbox, resultPath], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: process.env.LANG ?? "C.UTF-8",
        TMPDIR: sandbox,
        NODE_BIN: process.execPath,
        PRG_PI_CLI: cliEntry,
        PRG_CANDIDATE: candidateEntry,
        PRG_FIXTURE: fixtureEntry,
      },
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }, DRIVER_OVERALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, alive: false, steps: [], lastScreen: `driver spawn failed: ${String(error)}` });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(readFileSync(resultPath, "utf8")) as DriverResult);
      } catch {
        resolve({ ok: false, alive: false, steps: [], lastScreen: "driver produced no result.json (killed or crashed)" });
      }
    });
  });
}

async function hasPython3(): Promise<boolean> {
  const result = spawnSync("python3", ["-c", "print(1)"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/** Resolved launch prerequisites, or the list of what is missing. */
interface LaunchPrereq {
  cliEntry: string;
  candidateEntry: string;
}

async function launchPrerequisites(t: { skip(message?: string): void }): Promise<LaunchPrereq | undefined> {
  const agentDir = explicitInstalledAgentDir() ?? findInstalledAgentDir();
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY ?? join(projectRoot, "dist", "src", "index.js");
  const cliEntry = agentDir ? join(agentDir, "dist", "bundle", "cli.js") : undefined;
  const missing: string[] = [];
  if (!agentDir || !cliEntry || !existsSync(cliEntry)) {
    missing.push("installed pi-coding-agent (dist/bundle/cli.js; PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)");
  }
  if (!existsSync(candidateEntry)) {
    missing.push("built review-gate candidate entry (PI_REVIEW_GATE_CANDIDATE_ENTRY or dist/src/index.js)");
  }
  if (!(await hasPython3())) missing.push("python3");
  if (missing.length > 0) {
    skipOrFail(t, `compiled-launch expansion regression prerequisites unavailable: ${missing.join(", ")}`);
    return undefined;
  }
  return { cliEntry: cliEntry!, candidateEntry };
}

interface ScenarioOptions {
  /** The keybindings.json content the synthetic home starts with (undefined = none written). */
  keybindings?: Record<string, unknown> | undefined;
  steps: DriverStep[];
  /** Test label for the failure detail. */
  label: string;
}

async function runCompiledLaunchScenario(prereq: LaunchPrereq, options: ScenarioOptions): Promise<void> {
  // ── Sandbox: synthetic home/config + workspace + fixture extension ──────────────────
  const sandbox = await mkdtemp(join(tmpdir(), "prg-compiled-launch-"));
  try {
    const home = join(sandbox, "home");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await mkdir(join(sandbox, "workspace"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "review-gate.json"), "{}\n");
    if (options.keybindings !== undefined) {
      // The same file the running mode reads at startup (KeybindingsManager.create());
      // a configured remap or empty binding must be reflected by the extension's
      // warm hint resolution without any hard-coded default.
      await writeFile(join(home, ".pi", "agent", "keybindings.json"), `${JSON.stringify(options.keybindings)}\n`);
    }
    const fixtureEntry = join(sandbox, "fixture-notify.js");
    await writeFile(fixtureEntry, fixtureExtensionSource());
    const driverPath = join(sandbox, "driver.py");
    await writeFile(driverPath, DRIVER_SOURCE);
    await chmod(driverPath, 0o755);
    await writeFile(join(sandbox, "steps.json"), JSON.stringify(options.steps));

    const result = await runDriver(driverPath, sandbox, prereq.cliEntry, prereq.candidateEntry, fixtureEntry);
    const failed = result.steps.filter((step) => !step.ok);
    const detail = failed.length > 0
      ? failed
          .map((step) => `step ${step.index} (${options.steps[step.index]?.type}): ${step.error ?? "unknown"}\nlast screen:\n${step.screen ?? ""}`)
          .join("\n---\n")
      : result.lastScreen;
    assert.ok(result.ok, `${options.label} failed:\n${detail}`);
    assert.ok(!result.alive, "the pi process must have exited on the final Ctrl+C-twice exit");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

const compactRowA = "[subtask] Create fixture-a-file with lorem ipsum · REPORTED · 1/1";
const compactRowB = "[subtask] Fixture neighbour summary task · REPORTED · 1/1";

/** The full default-binding walk: compact rows, hint, Ctrl+O expand/contract,
 * independent fullscreen clicks. */
test("compiled candidate through the real pi seam renders compact, hint-hinting, expandable notifications", async (t) => {
  const prereq = await launchPrerequisites(t);
  if (!prereq) return;
  const deepSentinels = ["REPORT-SENTINEL-A", "REPORT-SENTINEL-B", "EXCERPT-SENTINEL-C"];
  await runCompiledLaunchScenario(prereq, {
    label: "default-binding compiled launch",
    steps: [
      { type: "wait", marker: "Press ctrl+o", timeoutMs: 60_000 },
      // Three neighbouring synthetic notifications via the fixture command.
      { type: "send", hex: textInputHex("/fixture-notify\r") },
      {
        type: "assert_latest",
        includes: [compactRowA, compactRowB, "[bg-shell] fixture-job (job-1)", "to expand"],
        excludes: [...deepSentinels],
        timeoutMs: 60_000,
      },
      // Global Ctrl+O (the host's configured app.tools.expand binding) expands
      // every notification to its COMPLETE retained text.
      { type: "send", hex: KEYS.ctrlO },
      {
        type: "assert_latest",
        includes: ["REPORT-SENTINEL-A", "REPORT-SENTINEL-B", "EXCERPT-SENTINEL-C", "to collapse"],
        timeoutMs: 60_000,
      },
      // ...and contracts everything again.
      { type: "send", hex: KEYS.ctrlO },
      {
        type: "assert_latest",
        includes: [compactRowA, "to expand"],
        excludes: [...deepSentinels],
        timeoutMs: 60_000,
      },
      // Fullscreen click on notification A only: A expands, B stays compact.
      { type: "click", marker: compactRowA, timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: ["REPORT-SENTINEL-A"],
        excludes: ["REPORT-SENTINEL-B", "EXCERPT-SENTINEL-C"],
        timeoutMs: 60_000,
      },
      // Clicking A again contracts it back to the identical compact row.
      { type: "click", marker: "REPORT-SENTINEL-A", timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: [compactRowA],
        excludes: [...deepSentinels],
        timeoutMs: 60_000,
      },
      // The neighbour's independent click: B expands, A stays compact.
      { type: "click", marker: compactRowB, timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: ["REPORT-SENTINEL-B"],
        excludes: ["REPORT-SENTINEL-A", "EXCERPT-SENTINEL-C"],
        timeoutMs: 60_000,
      },
      // Clicking the neighbour contracts it again; then the background-shell wake
      // expands on its own click.
      { type: "click", marker: "REPORT-SENTINEL-B", timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: [compactRowB],
        excludes: [...deepSentinels],
        timeoutMs: 60_000,
      },
      { type: "click", marker: "[bg-shell] fixture-job (job-1)", timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: ["EXCERPT-SENTINEL-C"],
        excludes: ["REPORT-SENTINEL-A", "REPORT-SENTINEL-B"],
        timeoutMs: 60_000,
      },
      { type: "click", marker: "EXCERPT-SENTINEL-C", timeoutMs: 60_000 },
      {
        type: "assert_latest",
        includes: ["[bg-shell] fixture-job (job-1)"],
        excludes: [...deepSentinels],
        timeoutMs: 60_000,
      },
      // Ctrl+C twice is the documented host exit.
      { type: "send", hex: KEYS.ctrlC + KEYS.ctrlC },
      { type: "wait_exit", timeoutMs: 30_000 },
    ],
  });
});

function textInputHex(text: string): string {
  return [...Buffer.from(text, "utf8")].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A user-remapped app.tools.expand (keybindings.json) must flow through the
 * extension's warm hint resolution: the compact hint shows the configured key
 * and the REAL configured keystroke toggles the expansion. */
test("compiled candidate honors a remapped app.tools.expand binding for hints and keyboard expansion", async (t) => {
  const prereq = await launchPrerequisites(t);
  if (!prereq) return;
  // ctrl+e is otherwise bound to tui.editor.cursorLineEnd; the host checks the
  // app action first, so the remap is observable exactly as a user sees it.
  await runCompiledLaunchScenario(prereq, {
    label: "remapped-binding compiled launch",
    keybindings: { "app.tools.expand": "ctrl+e" },
    steps: [
      { type: "wait", marker: "operating mode:", timeoutMs: 60_000 },
      { type: "send", hex: textInputHex("/fixture-notify\r") },
      {
        type: "assert_latest",
        includes: [`${compactRowA} (ctrl+e to expand)`, `${compactRowB} (ctrl+e to expand)`],
        excludes: ["(ctrl+o "],
        timeoutMs: 60_000,
      },
      // The REAL configured keystroke expands the complete retained text.
      { type: "send", hex: KEYS.ctrlE },
      {
        type: "assert_latest",
        includes: ["Tool output: expanded", "REPORT-SENTINEL-A", "REPORT-SENTINEL-B", "EXCERPT-SENTINEL-C"],
        timeoutMs: 60_000,
      },
      // ...and contracts again with the same configured keystroke.
      { type: "send", hex: KEYS.ctrlE },
      {
        type: "assert_latest",
        includes: [`${compactRowA} (ctrl+e to expand)`],
        excludes: ["REPORT-SENTINEL-A", "REPORT-SENTINEL-B", "EXCERPT-SENTINEL-C"],
        timeoutMs: 60_000,
      },
      { type: "send", hex: KEYS.ctrlC + KEYS.ctrlC },
      { type: "wait_exit", timeoutMs: 30_000 },
    ],
  });
});

/** An unconfigured (empty) app.tools.expand binding produces NO hint at all —
 * never a keyless guess — while the honest compact rendering stays. */
test("compiled candidate renders no expansion hint when the binding is configured empty", async (t) => {
  const prereq = await launchPrerequisites(t);
  if (!prereq) return;
  await runCompiledLaunchScenario(prereq, {
    label: "empty-binding compiled launch",
    keybindings: { "app.tools.expand": [] },
    steps: [
      { type: "wait", marker: "operating mode:", timeoutMs: 60_000 },
      { type: "send", hex: textInputHex("/fixture-notify\r") },
      {
        type: "assert_latest",
        includes: [compactRowA, compactRowB],
        excludes: [`${compactRowA} (`, `${compactRowB} (`],
        timeoutMs: 60_000,
      },
      { type: "send", hex: KEYS.ctrlC + KEYS.ctrlC },
      { type: "wait_exit", timeoutMs: 30_000 },
    ],
  });
});

/** The PTY driver: same conventions as tests/pi-tui-live-settings-smoke.test.ts,
 * with an added deterministic "click" step: it locates the unique rendered line
 * containing `marker` on the real fullscreen grid and injects the SGR mouse
 * press+release the running host itself asked the terminal for. Python stdlib only. */
const DRIVER_SOURCE = String.raw`
import os, pty, sys, time, select, signal, json, re, struct, fcntl, termios

sandbox, result_path = sys.argv[1:3]
steps = json.load(open(os.path.join(sandbox, "steps.json")))

class VTScreen:
    """Render actual PTY VT100/xterm bytes; never synthesize Pi UI content."""
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.primary = self._blank_state()
        self.alternate = self._blank_state()
        self.active = self.primary
        self.alternate_active = False
        self.parser = "text"
        self.sequence = ""
        self.decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")

    def _blank_state(self):
        return {
            "cells": [[" "] * self.cols for _ in range(self.rows)],
            "row": 0, "col": 0, "saved": (0, 0), "top": 0,
            "bottom": self.rows - 1, "wrap": True, "wrap_pending": False,
            "insert": False,
        }

    def _move(self, row=None, col=None):
        if row is not None:
            self.active["row"] = max(0, min(self.rows - 1, row))
        if col is not None:
            self.active["col"] = max(0, min(self.cols - 1, col))
        self.active["wrap_pending"] = False

    def _scroll_up(self, count=1):
        state = self.active
        top, bottom = state["top"], state["bottom"]
        for _ in range(max(1, count)):
            state["cells"].pop(top)
            state["cells"].insert(bottom, [" "] * self.cols)

    def _scroll_down(self, count=1):
        state = self.active
        top, bottom = state["top"], state["bottom"]
        for _ in range(max(1, count)):
            state["cells"].pop(bottom)
            state["cells"].insert(top, [" "] * self.cols)

    def _index(self):
        state = self.active
        state["wrap_pending"] = False
        if state["row"] == state["bottom"]:
            self._scroll_up()
        else:
            state["row"] = min(self.rows - 1, state["row"] + 1)

    def _reverse_index(self):
        state = self.active
        state["wrap_pending"] = False
        if state["row"] == state["top"]:
            self._scroll_down()
        else:
            state["row"] = max(0, state["row"] - 1)

    def _char_width(self, char):
        import unicodedata
        if unicodedata.combining(char):
            return 0
        return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1

    def _put(self, char):
        import unicodedata
        state = self.active
        width = self._char_width(char)
        if width == 0:
            col = max(0, state["col"] - (1 if state["wrap_pending"] else 0))
            row = state["row"]
            while col > 0 and state["cells"][row][col] == "":
                col -= 1
            state["cells"][row][col] += char
            return
        if state["wrap_pending"]:
            if state["wrap"]:
                state["col"] = 0
                self._index()
            state["wrap_pending"] = False
        if width == 2 and state["col"] == self.cols - 1:
            if state["wrap"]:
                state["col"] = 0
                self._index()
            else:
                return
        row, col = state["row"], state["col"]
        if state["insert"]:
            state["cells"][row][col:col] = [" "] * width
            del state["cells"][row][self.cols:]
        state["cells"][row][col] = char
        if width == 2:
            state["cells"][row][col + 1] = ""
        if col + width >= self.cols:
            state["col"] = self.cols - 1
            state["wrap_pending"] = state["wrap"]
        else:
            state["col"] += width

    def _erase_line(self, mode):
        row, col = self.active["row"], self.active["col"]
        cells = self.active["cells"][row]
        start, end = (col, self.cols) if mode == 0 else (0, col + 1) if mode == 1 else (0, self.cols)
        cells[start:end] = [" "] * (end - start)

    def _erase_display(self, mode):
        row, col = self.active["row"], self.active["col"]
        cells = self.active["cells"]
        if mode == 0:
            self._erase_line(0)
            for y in range(row + 1, self.rows):
                cells[y] = [" "] * self.cols
        elif mode == 1:
            for y in range(0, row):
                cells[y] = [" "] * self.cols
            self._erase_line(1)
        elif mode == 2:
            for y in range(self.rows):
                cells[y] = [" "] * self.cols
        elif mode == 3:
            pass  # CSI 3 J clears scrollback, which this viewport doesn't model.

    def _switch_screen(self, enter, clear=False):
        if enter and not self.alternate_active:
            self.primary["saved"] = (self.primary["row"], self.primary["col"])
            if clear:
                self.alternate = self._blank_state()
            self.active = self.alternate
            self.alternate_active = True
        elif not enter and self.alternate_active:
            self.active = self.primary
            self.alternate_active = False
            self._move(*self.primary["saved"])

    def _csi(self, body, final):
        private = body[:1] if body[:1] in "?<=>!" else ""
        params_text = body[1:] if private else body
        params_text = re.sub(r"[ -/].*$", "", params_text)
        try:
            params = [int(value) if value else 0 for value in params_text.split(";")]
        except ValueError:
            params = []
        first = params[0] if params else 0
        n = first or 1
        state = self.active
        if final in ("H", "f"):
            row = params[0] if len(params) > 0 and params[0] else 1
            col = params[1] if len(params) > 1 and params[1] else 1
            self._move(row - 1, col - 1)
        elif final == "A": self._move(row=state["row"] - n)
        elif final == "B": self._move(row=state["row"] + n)
        elif final == "C": self._move(col=state["col"] + n)
        elif final == "D": self._move(col=state["col"] - n)
        elif final == "E": self._move(row=state["row"] + n, col=0)
        elif final == "F": self._move(row=state["row"] - n, col=0)
        elif final == "G": self._move(col=n - 1)
        elif final == "d": self._move(row=n - 1)
        elif final == "J": self._erase_display(first)
        elif final == "K": self._erase_line(first)
        elif final == "X":
            row, col = state["row"], state["col"]
            state["cells"][row][col:min(self.cols, col + n)] = [" "] * min(n, self.cols - col)
        elif final == "P":
            row, col = state["row"], state["col"]
            line = state["cells"][row]
            del line[col:col + n]
            line.extend([" "] * n)
            del line[self.cols:]
        elif final == "@":
            row, col = state["row"], state["col"]
            line = state["cells"][row]
            line[col:col] = [" "] * n
            del line[self.cols:]
        elif final == "L":
            if state["top"] <= state["row"] <= state["bottom"]:
                for _ in range(n):
                    state["cells"].pop(state["bottom"])
                    state["cells"].insert(state["row"], [" "] * self.cols)
        elif final == "M":
            if state["top"] <= state["row"] <= state["bottom"]:
                for _ in range(n):
                    state["cells"].pop(state["row"])
                    state["cells"].insert(state["bottom"], [" "] * self.cols)
        elif final == "S": self._scroll_up(n)
        elif final == "T": self._scroll_down(n)
        elif final == "r":
            top = params[0] if len(params) > 0 and params[0] else 1
            bottom = params[1] if len(params) > 1 and params[1] else self.rows
            if 1 <= top < bottom <= self.rows:
                state["top"], state["bottom"] = top - 1, bottom - 1
                self._move(0, 0)
        elif final in ("s",): state["saved"] = (state["row"], state["col"])
        elif final == "u": self._move(*state["saved"])
        elif final in ("h", "l"):
            enabled = final == "h"
            if private == "?":
                for mode in params:
                    if mode == 1049: self._switch_screen(enabled, clear=True)
                    elif mode == 1047: self._switch_screen(enabled, clear=True)
                    elif mode == 47: self._switch_screen(enabled)
                    elif mode == 7: self.active["wrap"] = enabled
            elif not private and 4 in params:
                self.active["insert"] = enabled
        elif final == "m": pass  # SGR changes attributes, not screen text.

    def _char(self, char):
        code = ord(char)
        if self.parser == "osc":
            if char == "\x07": self.parser = "text"
            elif char == "\x1b": self.parser = "osc_esc"
            return
        if self.parser == "osc_esc":
            self.parser = "text" if char == "\\" else "osc"
            return
        if self.parser == "ignore":
            if char == "\x1b": self.parser = "ignore_esc"
            return
        if self.parser == "ignore_esc":
            self.parser = "text" if char == "\\" else "ignore"
            return
        if self.parser == "csi":
            if 0x40 <= code <= 0x7e:
                self._csi(self.sequence, char)
                self.sequence = ""
                self.parser = "text"
            else:
                self.sequence += char
            return
        if self.parser == "esc":
            self.parser = "text"
            if char == "[": self.parser = "csi"; self.sequence = ""
            elif char == "]": self.parser = "osc"
            elif char in ("P", "^", "_"): self.parser = "ignore"
            elif char == "7": self.active["saved"] = (self.active["row"], self.active["col"])
            elif char == "8": self._move(*self.active["saved"])
            elif char == "D": self._index()
            elif char == "E": self.active["col"] = 0; self._index()
            elif char == "M": self._reverse_index()
            elif char == "c":
                self.primary = self._blank_state()
                self.alternate = self._blank_state()
                self.active = self.primary
                self.alternate_active = False
            elif char in "()*+-./": self.parser = "charset"
            return
        if self.parser == "charset":
            self.parser = "text"
            return
        if char == "\x1b": self.parser = "esc"
        elif char == "\r": self.active["col"] = 0; self.active["wrap_pending"] = False
        elif char in ("\n", "\v", "\f"): self._index()
        elif char == "\b": self._move(col=self.active["col"] - 1)
        elif char == "\t": self._move(col=min(self.cols - 1, ((self.active["col"] // 8) + 1) * 8))
        elif code >= 0x20 and code != 0x7f: self._put(char)

    def feed(self, data):
        for char in self.decoder.decode(data):
            self._char(char)

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.active["cells"])

home = os.path.join(sandbox, "home")
os.makedirs(os.path.join(home, ".pi", "agent"), exist_ok=True)
with open(os.path.join(home, ".pi", "agent", "review-gate.json"), "w") as handle:
    handle.write("{}\n")

# Allowlisted environment: no PI_REVIEW_GATE_* (the extension must never touch a
# user's live config), no session/model state, no provider API keys -> no
# model/API call is possible.
allow = ("PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "LOGNAME", "USER", "NODE_BIN")
child_env = {key: os.environ[key] for key in allow if key in os.environ}
child_env["HOME"] = home
child_env["TERM"] = "xterm-256color"

argv = [os.environ.get("NODE_BIN", "node"), os.environ["PRG_PI_CLI"],
        "--no-extensions", "--extension", os.environ["PRG_CANDIDATE"],
        "--extension", os.environ["PRG_FIXTURE"],
        "--no-session", "--offline", "--no-context-files", "--no-skills",
        "--no-themes"]

pid, master = pty.fork()
if pid == 0:
    os.chdir(os.path.join(sandbox, "workspace"))
    os.makedirs(os.path.join(sandbox, "workspace"), exist_ok=True)
    os.environ.clear()
    os.environ.update(child_env)
    try:
        os.execvp(argv[0], argv)
    except Exception:
        os._exit(127)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
os.set_blocking(master, False)

buffer = bytearray()
terminal = VTScreen(40, 120)
alive = [True]
last_send_offset = [0]

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end and alive[0]:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                alive[0] = False
                return
            if not data:
                alive[0] = False
                return
            buffer.extend(data)
            terminal.feed(data)

def clean(text):
    text = text.decode("utf-8", "replace") if isinstance(text, bytes) else text
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
    return text.replace("\x1b>", "").replace("\x1b=", "")

def visible():
    return clean(bytes(buffer))

def latest():
    text = visible()
    marker = "operating mode:"
    last = text.rfind(marker)
    if last == -1:
        raise RuntimeError("Pi status marker missing; cannot scope the latest redraw")
    return text[last + len(marker):]

def fresh_since_send():
    return visible()[last_send_offset[0]:]

def wait_for(marker, timeout_ms):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline and alive[0]:
        if marker in fresh_since_send():
            return True
        pump(0.25)
    return marker in fresh_since_send()

def wait_exit(timeout_ms):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline and alive[0]:
        pump(0.25)
    return not alive[0]

def send(keys):
    last_send_offset[0] = len(visible())
    try:
        os.write(master, keys)
    except OSError:
        alive[0] = False

def click_marker(marker, timeout_ms, offset_x):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline and alive[0]:
        pump(0.25)
        rows = terminal.text().splitlines()
        hits = [i for i, line in enumerate(rows) if marker in line]
        if len(hits) == 1:
            row = hits[0]
            col = rows[row].index(marker) + max(0, offset_x)
            press = ("\x1b[<0;%d;%dM" % (col + 1, row + 1)).encode("ascii")
            release = ("\x1b[<0;%d;%dm" % (col + 1, row + 1)).encode("ascii")
            last_send_offset[0] = len(visible())
            os.write(master, press)
            pump(0.2)
            os.write(master, release)
            pump(0.5)
            return "row %d col %d" % (row, col)
        if len(hits) > 1:
            raise RuntimeError("click marker %r is not unique on screen (%d hits)" % (marker, len(hits)))
    raise RuntimeError("timed out waiting for a unique click target %r" % marker)

results = []
ok = True
for index, step in enumerate(steps):
    kind = step.get("type")
    entry = {"index": index, "ok": True}
    try:
        if not alive[0] and kind != "wait_exit":
            raise RuntimeError("pi exited before this step")
        if kind == "wait":
            if not wait_for(step["marker"], step.get("timeoutMs", 30000)):
                raise RuntimeError("timed out waiting for %r" % step["marker"])
        elif kind == "wait_exit":
            if not wait_exit(step.get("timeoutMs", 30000)):
                raise RuntimeError("pi did not exit within the deadline")
        elif kind == "send":
            send(bytes.fromhex(step["hex"]))
            pump(0.8)
        elif kind == "settle":
            pump(step.get("seconds", 1.0))
        elif kind == "click":
            entry["clicked"] = click_marker(step["marker"], step.get("timeoutMs", 20000), step.get("offsetX", 6))
        elif kind == "assert_latest":
            deadline = time.time() + step.get("timeoutMs", 20000) / 1000.0
            includes = step.get("includes", [])
            current = ""
            while True:
                pump(0.4)
                latest()
                current = fresh_since_send()
                if not includes or all(marker in current for marker in includes):
                    break
                if time.time() >= deadline:
                    break
            entry["screen"] = current[-2500:]
            for marker in includes:
                if marker not in current:
                    raise RuntimeError("fresh frame missing %r" % marker)
            for marker in step.get("excludes", []):
                if marker in current:
                    raise RuntimeError("fresh frame unexpectedly contains %r" % marker)
        else:
            raise RuntimeError("unknown step type %r" % kind)
    except Exception as error:
        entry["ok"] = False
        entry["error"] = str(error)
        entry.setdefault("screen", terminal.text()[-3000:] + "\n[raw buffer tail]\n" + visible()[-2500:])
        ok = False
    results.append(entry)
    if not ok:
        break

try:
    os.killpg(os.getpgid(pid), signal.SIGKILL)
except Exception:
    pass

with open(result_path, "w") as handle:
    json.dump({"ok": ok, "alive": alive[0], "steps": results, "lastScreen": terminal.text()[-3000:]}, handle)
sys.exit(0 if ok else 1)
`;