/**
 * Issue #653: the session-host sidebar's Settings -> Review settings row and
 * its Main composition.
 *
 * Every case drives the ACTUAL SidebarController input/render path and the
 * real shared persisted settings transaction (`openLocalReviewSettings` ->
 * `runPersistedReviewSettings`) through the sidebar's own custom-screen host,
 * pinned pi-tui menu host, and shared SessionHostTextField. The Main cases run
 * the real `main.ts` controller over the focused fake terminal harness and
 * prove the callback wiring (startup snapshot env/args/cwd, canonical agent
 * directory, resolved Pi executable) plus the explicit larger external-editor
 * call. Only the metadata catalog is injected through the service's own test
 * seam; every HOME, agent directory, and config is synthetic and owned here.
 * No real config, provider, network, or Pi session is touched.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getKeybindings } from "pi-session-host-tui";

import { SidebarController, SIDEBAR_GENERATED_SGR_ALLOWLIST, type SidebarControllerOptions } from "../src/session-host/sidebar";
import { createSessionHostTextField, MAX_TEXT_FIELD_BYTES } from "../src/session-host/field-editor";
import { loadNativeFieldKeybindings, withNativeFieldKeybindings, MAX_EDITOR_TEXT_BYTES, runNativeExternalEditor } from "../src/session-host/form-support";
import { PI_AGENT_DIR_ENV } from "../src/config-path";
import { normalizeConfig, resolvedExternalAgent } from "../src/config";
import { selectExternalAgentEdit } from "../src/settings/external-agents";
import { openLocalReviewSettings, type LocalReviewSettingsInput } from "../src/session-host/review-settings";
import type { ReviewSettingsCatalog } from "../src/session-host/review-settings-catalog";
import type { SidebarReviewSettingsHost } from "../src/session-host/review-settings-ui";
import type { UiContext } from "../src/settings/ui";
import {
  ALT_LEFT,
  ENTER,
  ESC,
  type Harness,
  closeWithSignal,
  createHarness,
  makeMainTestDirectory,
  nextTurn,
  plain,
  ready,
} from "./helpers/session-host-main-harness";
import { FakePeerCoordinator } from "./helpers/session-host-main-harness";
import { remotePeerHost, remoteRosterRow } from "./helpers/session-host-main-remote";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { SidebarAction } from "../src/session-host/sidebar";

const DOWN = "\x1b[B";
const CTRL_S = "\x13";
const CTRL_S_REPEAT = "\x1b[115;5:2u";
const CTRL_S_RELEASE = "\x1b[115;5:3u";
const UP = "\x1b[A";
const ENTER_RELEASE = "\x1b[13;1:3u";
const CTRL_G = "\x07";
const CTRL_J = "\n";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Kitty keyboard-protocol held-key events (event type 2 = repeat, 3 = release).
const ESC_REPEAT = "\x1b[27;1:2u";
const ESC_RELEASE = "\x1b[27;1:3u";
const ENTER_REPEAT = "\x1b[13;1:2u";
const SGR = /\x1b\[([0-9;]*)m/g;
const PI_EXECUTABLE = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

/** The 17 persisted root sections, in the shared menu's order (no Scheduler runtime). */
const ROOT_SECTIONS = [
  "Operating mode", "Mode cycle hotkey", "Worker resources", "External workers", "Execution priority",
  "Research priority", "Reviewers", "Timeouts", "Review policy", "Retention", "Global concurrency", "Retry policy",
  "Subtask notifications", "Tools", "Subtasks view", "Subtask task IDs", "Scheduled tasks",
];
const DISK_A = { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true }, operatingMode: "execute", unrelatedFutureField: { keep: true } };

function fakeCatalog(toolName = "bash"): ReviewSettingsCatalog {
  return {
    scoped: [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }],
    tools: [{ name: toolName, description: "Execute a command." }, { name: "read" }, { name: "tool_search" }],
    warnings: [],
    modelScope: { source: "enabledModels", patterns: ["acme/deep"] },
  };
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function turns(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Sidebar-level fixture: a real controller and the real LOCAL service
// ---------------------------------------------------------------------------

interface Local {
  root: string;
  home: string;
  agentDir: string;
  canonical: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

function local(t: TestContext): Local {
  const root = mkdtempSync(join(tmpdir(), "rs-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const agentDir = realpathSync(join(home, ".pi", "agent"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  return { root, home, agentDir, canonical: join(agentDir, "review-gate.json"), workspace, env: { HOME: home, USERPROFILE: home } };
}

function write(path: string, body: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(path, text, "utf8");
  return text;
}

interface Driven {
  sidebar: SidebarController;
  /** When true (default) every drawn frame is reported written, like Main's writer. */
  writes: boolean;
  actions: SidebarAction[];
  opens: UiContext[];
  inputs: LocalReviewSettingsInput[];
  settled: Array<Promise<void>>;
  cols: number;
  rows: number;
  frame(): string[];
  text(): string;
  raw(): string;
  key(data: string): void;
}

function driven(
  l: Local,
  extra: Partial<SidebarControllerOptions> = {},
  catalog: () => ReviewSettingsCatalog = () => fakeCatalog(),
  gate?: () => Promise<void>,
): Driven {
  const opens: UiContext[] = [];
  const inputs: LocalReviewSettingsInput[] = [];
  const settled: Array<Promise<void>> = [];
  const host: SidebarReviewSettingsHost = {
    open: (ui) => {
      opens.push(ui);
      const input: LocalReviewSettingsInput = { env: l.env, agentDir: l.agentDir, piExecutable: PI_EXECUTABLE, args: [], cwd: l.workspace, ui };
      inputs.push(input);
      const run = openLocalReviewSettings(input, {
        loadChoices: async () => {
          await gate?.();
          return catalog();
        },
      });
      settled.push(run);
      return run;
    },
    loadKeybindings: () => {
      const loaded = loadNativeFieldKeybindings(l.agentDir);
      return { manager: loaded.manager, run: (operation) => withNativeFieldKeybindings(loaded.manager, operation) };
    },
  };
  const actions: SidebarAction[] = [];
  const sidebar = new SidebarController({
    settingsAvailable: true,
    reviewSettings: host,
    onAction: (action) => actions.push(action),
    ...extra,
  });
  const state = {
    sidebar,
    writes: true,
    actions,
    opens,
    inputs,
    settled,
    cols: 80,
    rows: 30,
    frame(): string[] {
      const lines = sidebar.render(state.cols, state.rows).lines.map(strip);
      // The synthetic writer: report this exact frame written, as Main does.
      const presented = sidebar.captureReviewSettingsPresentation();
      if (state.writes && presented !== undefined) sidebar.settleReviewSettingsRender(presented.renderToken);
      return lines;
    },
    text(): string {
      return state.frame().join("\n");
    },
    raw(): string {
      const raw = sidebar.render(state.cols, state.rows).lines.join("\n");
      const presented = sidebar.captureReviewSettingsPresentation();
      if (state.writes && presented !== undefined) sidebar.settleReviewSettingsRender(presented.renderToken);
      return raw;
    },
    key(data: string): void {
      sidebar.handleInput(data);
    },
  };
  return state;
}

/** Roster/Settings rows use the host's "> " marker. */
function moveToHostRow(d: Driven, label: string): void {
  for (let step = 0; step < 40; step += 1) {
    if (d.frame().some((line) => line.startsWith(`> ${label}`))) return;
    d.key(DOWN);
  }
  assert.fail(`no highlighted host row ${label}:\n${d.text()}`);
}

/** Shared settings screens use the pinned SelectList's "→ " marker. */
function moveToMenuRow(d: Driven, label: string): void {
  for (let step = 0; step < 60; step += 1) {
    if (d.frame().some((line) => line.trimStart().startsWith(`→ ${label}`))) return;
    d.key(DOWN);
  }
  assert.fail(`no highlighted menu row ${label}:\n${d.text()}`);
}

async function waitFor(d: Driven, predicate: (text: string) => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate(d.text())) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}:\n${d.text()}`);
}

async function openReviewSettings(d: Driven): Promise<void> {
  moveToHostRow(d, "Settings");
  d.key(ENTER);
  moveToHostRow(d, "Review settings");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "the shared root menu");
}

async function chooseMenuRow(d: Driven, label: string, next: string): Promise<void> {
  moveToMenuRow(d, label);
  d.key(ENTER);
  await waitFor(d, (text) => text.includes(next), next);
}

/** Every root label the shared menu draws, collected through its own scroll window. */
function collectRootLabels(d: Driven): string[] {
  const seen: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    for (const line of d.frame()) {
      const match = /^\s*(?:→ )?\s*(.+?)\s{2,}/.exec(line);
      const label = match?.[1]?.replace(/^→\s*/, "").trim();
      if (label !== undefined && [...ROOT_SECTIONS, "Scheduler runtime"].includes(label) && !seen.includes(label)) seen.push(label);
    }
    d.key(DOWN);
  }
  return seen;
}

function assertClosedSgr(raw: string): void {
  for (const match of raw.matchAll(SGR)) {
    assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(match[1] ?? ""), `generated SGR ${JSON.stringify(match[1])} is outside the closed set`);
  }
  assert.ok(!/\x1b\]/.test(raw), "no OSC sequence reaches a frame");
  assert.ok(!/\x1b[P_^X]/.test(raw), "no DCS/APC/PM/SOS sequence reaches a frame");
}

// ---------------------------------------------------------------------------
// Row placement and availability
// ---------------------------------------------------------------------------

test("Settings appends Review settings after the existing rows; the port alone offers it", (t) => {
  const l = local(t);
  const d = driven(l);
  moveToHostRow(d, "Settings");
  d.key(ENTER);
  const rows = d.frame().filter((line) => /^[> ] {1}\S/.test(line)).map((line) => line.slice(2).trim());
  assert.deepEqual(rows.filter((row) => ["Theme", "Network", "Host shortcuts", "Review settings"].includes(row)),
    ["Theme", "Host shortcuts", "Review settings"], d.text());

  const onlyPort = driven(l, { settingsAvailable: false });
  moveToHostRow(onlyPort, "Settings");
  onlyPort.key(ENTER);
  assert.ok(onlyPort.frame().some((line) => line.startsWith("> Review settings")), onlyPort.text());
  assert.ok(!onlyPort.text().includes("Theme") || onlyPort.text().includes("theme:"), "Theme keeps its own authority");

  const legacy = new SidebarController({ settingsAvailable: true });
  for (let step = 0; step < 10; step += 1) legacy.handleInput(DOWN);
  const legacyText = legacy.render(80, 30).lines.map(strip).join("\n");
  assert.ok(!legacyText.includes("Review settings"), "no port, no row");
});

// ---------------------------------------------------------------------------
// A / B, C cancel, D save, E reopen, first use
// ---------------------------------------------------------------------------

test("disk A: the full shared root renders LOCAL; staged C then Cancel or root Escape leaves A; Save D writes; E reopens fresh", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const keybindingsBefore = getKeybindings();
  const d = driven(l);
  await openReviewSettings(d);
  assert.match(d.text(), /Review settings \(local\)/);
  assert.match(d.text(), /Editing LOCAL review-gate settings for this host/, "the service's LOCAL target notice is shown");
  assert.ok(d.text().replace(/\s+/g, "").includes(l.canonical.replace(/\s+/g, "")), "the absolute config target is shown unclipped");
  assert.deepEqual(collectRootLabels(d), ROOT_SECTIONS, "the same 17 persisted root sections, no Scheduler runtime");
  assertClosedSgr(d.raw());

  // Stage C (toggle YouShouldKnow notices), back to root, Cancel.
  await chooseMenuRow(d, "Tools", "YouShouldKnow notices");
  moveToMenuRow(d, "YouShouldKnow notices");
  d.key(ENTER);
  await waitFor(d, (text) => /YouShouldKnow notices\s+Off/.test(text), "staged C");
  d.key(ESC); // nested Back only navigates
  await waitFor(d, (text) => text.includes("→ Tools"), "root after Back");
  assert.equal(d.sidebar.focus, "form");
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Cancel");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "Cancel leaves disk A");

  // Stage C again; root Escape discards too.
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "reopened root");
  await chooseMenuRow(d, "Tools", "YouShouldKnow notices");
  moveToMenuRow(d, "YouShouldKnow notices");
  d.key(ENTER);
  await waitFor(d, (text) => /YouShouldKnow notices\s+Off/.test(text), "staged C");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("→ Tools"), "root");
  d.key(ESC_REPEAT); // a held Escape never replays across the root
  d.key(ESC_RELEASE);
  assert.match(d.text(), /→ Tools/, "the held Escape did not close the root");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after root Escape");
  d.key(ESC_REPEAT);
  d.key(ESC_RELEASE);
  assert.equal(d.sidebar.focus, "form", "the held root Escape did not also leave Settings");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "root Escape leaves disk A");

  // Save D through Ctrl+S at the root.
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "reopened root");
  await chooseMenuRow(d, "Tools", "YouShouldKnow notices");
  moveToMenuRow(d, "YouShouldKnow notices");
  d.key(ENTER);
  await waitFor(d, (text) => /YouShouldKnow notices\s+Off/.test(text), "staged D");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("→ Tools"), "root");
  d.key(CTRL_S);
  await waitFor(d, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "Settings with the saved notice");
  await Promise.all(d.settled);
  const fileD = JSON.parse(readFileSync(l.canonical, "utf8"));
  assert.deepEqual(fileD.youShouldKnow, { enabled: false, completionGuidance: true });
  assert.deepEqual(fileD.unrelatedFutureField, { keep: true });

  // Another legitimate editor writes E; the next open reads it fresh.
  write(l.canonical, { ...DISK_A, operatingMode: "orchestrate" });
  d.key(ENTER);
  await waitFor(d, (text) => /Operating mode\s+Prefer orchestration/.test(text), "fresh E");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.equal(d.opens.length, 4);
  assert.equal(getKeybindings(), keybindingsBefore, "no native keybinding manager stays installed");
});

test("first use: Cancel and root Escape create nothing; Save creates the canonical file", async (t) => {
  const l = local(t);
  const d = driven(l);
  await openReviewSettings(d);
  assert.match(d.text(), /No config exists yet/);
  d.key(ESC);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.equal(existsSync(l.canonical), false, "root Escape creates no file");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "root");
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.deepEqual(readdirSync(l.agentDir), [], "Cancel creates nothing");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "root");
  moveToMenuRow(d, "Save changes");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Save");
  await Promise.all(d.settled);
  assert.equal(existsSync(l.canonical), true, "explicit Save publishes the canonical file");
});

test("a selected remote card still opens the LOCAL settings, with no process-only control and no remote action", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const actions: SidebarAction[] = [];
  const d = driven(l, { onAction: (action) => actions.push(action) });
  const snapshot: PeerUiSnapshot = {
    ...new FakePeerCoordinator().snapshot,
    hosts: [remotePeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: "run-a", rows: [remoteRosterRow({ id: "row-a", label: "Alpha remote" })] })],
  } as unknown as PeerUiSnapshot;
  d.sidebar.setPeerUiSnapshot(snapshot);
  const owner = { kind: "remote", hostId: "lab-a", hostRunId: "run-a", rowId: "row-a" } as const;
  d.sidebar.setActiveMainOwnerKey(owner);
  // The remote card is the first (highlighted) roster entry.
  assert.match(d.text(), /Alpha remote/);
  const ownerBefore = d.sidebar.activeMainOwnerKey;
  assert.equal(ownerBefore?.kind, "remote", "Main displays the remote session");
  moveToHostRow(d, "Settings");
  d.key(ENTER);
  const rows = d.frame().filter((line) => /^[> ] \S/.test(line)).map((line) => line.slice(2).trim());
  assert.deepEqual(rows.filter((row) => ["Theme", "Network", "Host shortcuts", "Review settings"].includes(row)),
    ["Theme", "Network", "Host shortcuts", "Review settings"], d.text());
  moveToHostRow(d, "Review settings");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Operating mode"), "the shared root menu");
  assert.match(d.text(), /Editing LOCAL review-gate settings/);
  assert.equal(d.inputs.length, 1);
  assert.equal(d.inputs[0]!.agentDir, l.agentDir, "the LOCAL agent directory, never the remote owner's");
  assert.deepEqual(collectRootLabels(d), ROOT_SECTIONS, "process-only Scheduler runtime is absent");
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
  assert.deepEqual(d.sidebar.activeMainOwnerKey, ownerBefore, "Main's remote content owner is untouched");
  assert.deepEqual(actions.filter((action) => action.type !== "visibility").map((action) => action.type), [],
    "no remote, local, or network action was emitted");
});

// ---------------------------------------------------------------------------
// Lifecycle, paste, held keys, geometry
// ---------------------------------------------------------------------------

test("hide, toggle, and shutdown discard the open: outstanding screens/edits settle and nothing late acts", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const keybindingsBefore = getKeybindings();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const d = driven(l, {}, () => fakeCatalog(), () => gate);
  moveToHostRow(d, "Settings");
  d.key(ENTER);
  moveToHostRow(d, "Review settings");
  d.key(ENTER);
  await turns();
  assert.match(d.text(), /Loading local review settings/);
  // The reserved toggle hides the pane while the catalog is still loading.
  d.key(ALT_LEFT);
  assert.equal(d.sidebar.visible, false);
  assert.equal(d.sidebar.focus, "main");
  release();
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a late preload never saves");
  d.key(ALT_LEFT); // show again: the roster, never a resurrected settings pane
  assert.equal(d.sidebar.focus, "sidebar");
  assert.ok(!d.text().includes("Review settings (local)"), "a late preload never resurrects the pane");

  // The toggle inside a nested menu discards the staged draft too.
  const n = driven(l);
  await openReviewSettings(n);
  await chooseMenuRow(n, "Tools", "YouShouldKnow notices");
  moveToMenuRow(n, "YouShouldKnow notices");
  n.key(ENTER);
  await waitFor(n, (text) => /YouShouldKnow notices\s+Off/.test(text), "staged C");
  n.key(ALT_LEFT);
  await Promise.all(n.settled);
  assert.equal(n.sidebar.visible, false);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "toggle never saves the staged draft");

  // A nested text edit: hiding settles it and leaves no field behind.
  const e = driven(l);
  await openReviewSettings(e);
  await chooseMenuRow(e, "Tools", "Web");
  await chooseMenuRow(e, "Web", "URL blocklist");
  moveToMenuRow(e, "URL blocklist");
  e.key(ENTER);
  await waitFor(e, (text) => text.includes("Blocked URL patterns"), "the shared text field");
  for (const ch of "^https://staged") e.key(ch);
  e.sidebar.cancelReviewSettings();
  await Promise.all(e.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "the staged text was discarded");
  assert.equal(getKeybindings(), keybindingsBefore, "no native keybinding manager stays installed");
  e.key(ENTER); // a late Enter acts on nothing
  await turns();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

test("bracketed paste is opaque: pasted Enter, Ctrl+S, and Escape never confirm, save, or close", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  moveToMenuRow(d, "Save changes");
  d.key(`${PASTE_START}x\r${CTRL_S}${ESC}y`);
  d.key(`\r${PASTE_END}`);
  await turns();
  assert.match(d.text(), /→ Save changes/, "the menu is still open on the same row");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
  d.key(ESC);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

test("a too-small or not-yet-drawn screen keeps no action authority; a complete redraw restores it", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  moveToMenuRow(d, "Save changes");
  // Below the header, one list row with its scroll cue, the hint, and the footer.
  d.rows = 5;
  assert.match(d.text(), /too small/);
  d.key(ENTER);
  await turns();
  d.rows = 30;
  assert.match(d.text(), /not completely shown/, "Enter on the clipped frame was refused");
  assert.match(d.text(), /→ Save changes/);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
  d.key(ENTER_REPEAT); // a held Enter repeat never confirms
  await turns();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

/** The shared root rows one frame draws (19 entries: 17 sections, Save changes, Cancel). */
const ROOT_ENTRIES = [...ROOT_SECTIONS, "Save changes", "Cancel"];
function rootRows(shown: readonly string[]): string[] {
  return shown
    .map((line) => line.replace(/^\s*(→\s*)?/, ""))
    .filter((line) => ROOT_ENTRIES.some((label) => line === label || line.startsWith(`${label} `)));
}
const SCROLL_CUE = /^\s*\(\d+\/\d+\)\s*$/;

test("the shared root list uses the sidebar pane height: tall shows every row, short scrolls, resizing keeps the choice", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  d.rows = 40;
  await openReviewSettings(d);
  let shown = d.frame();
  assert.equal(rootRows(shown).length, ROOT_ENTRIES.length, `more than ten rows, every row in one frame:\n${shown.join("\n")}`);
  assert.ok(!shown.some((line) => SCROLL_CUE.test(line)), "a complete list has no scroll cue");
  assert.ok(shown.join("").replace(/\s+/g, "").includes(l.canonical.replace(/\s+/g, "")), "the LOCAL target notice stays whole");

  // A short pane well below ten rows plus chrome: a smaller list that scrolls.
  d.rows = 12;
  shown = d.frame();
  assert.equal(shown.length, 12);
  assert.doesNotMatch(shown.join("\n"), /too small/);
  const visible = rootRows(shown).length;
  assert.ok(visible >= 1 && visible < 10, shown.join("\n"));
  assert.ok(shown.some((line) => SCROLL_CUE.test(line)), "the native scroll cue is drawn");
  assert.ok(shown.some((line) => line.includes("Editing LOCAL")), "the newest notice keeps room");

  moveToMenuRow(d, "Cancel");
  d.rows = 40;
  shown = d.frame();
  assert.ok(shown.some((line) => line.trimStart().startsWith("→ Cancel")), "growing keeps the bottom choice");
  assert.equal(rootRows(shown).length, ROOT_ENTRIES.length);
  d.rows = 12;
  shown = d.frame();
  assert.ok(shown.some((line) => line.trimStart().startsWith("→ Cancel")), "shrinking keeps it too");
  assert.deepEqual(d.frame(), shown, "a stable pane redraws the same frame");

  // Page navigation uses the list's current visible size.
  d.key("\x1b[5~");
  shown = d.frame();
  const expected = ROOT_ENTRIES[ROOT_ENTRIES.length - 1 - visible]!;
  assert.ok(shown.some((line) => line.trimStart().startsWith(`→ ${expected}`)), `page up moved by ${visible}:\n${shown.join("\n")}`);

  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Cancel");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

// ---------------------------------------------------------------------------
// One contextual notice at a time (#653)
// ---------------------------------------------------------------------------

/** The notice phrases a frame may show; each starts its notice's first row at this width. */
const NOTICE_PHRASES = {
  target: "Editing LOCAL review-gate settings",
  review: "Review: automatic primary/subtask review toggles",
  evidence: "Evidence methods: Enter cycles",
  nativeReview: "Automatic primary review covers",
  nativeEvidence: "Evidence methods only",
  primaryWarning: "! WARNING: Applying Primary",
  landedInactive: "Reviewing landed changes is inactive",
  notDrawn: "! Review settings changed or are not completely shown",
} as const;
type NoticeKey = keyof typeof NOTICE_PHRASES;

/** Exactly the one expected notice is shown, once, and the header stays local. */
function assertOnlyNotice(d: Driven, expected: NoticeKey | undefined, what: string): string[] {
  const shown = d.frame();
  const text = shown.join("\n");
  assert.ok(shown[0]?.includes("Review settings (local)"), `${what}: the header stays local\n${text}`);
  for (const [key, phrase] of Object.entries(NOTICE_PHRASES) as Array<[NoticeKey, string]>) {
    const count = shown.filter((line) => line.includes(phrase)).length;
    assert.equal(count, key === expected ? 1 : 0, `${what}: ${key} ${key === expected ? "once" : "absent"}\n${text}`);
  }
  return shown;
}

test("one contextual notice: root -> Review -> deeper -> Back -> root -> Review restores each slot without stacking", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  assertOnlyNotice(d, "target", "root");

  for (let visit = 0; visit < 3; visit += 1) {
    await chooseMenuRow(d, "Reviewers", "→ Automatic primary review");
    assertOnlyNotice(d, "review", `Review visit ${visit}`);
    // A toggle re-shows the same menu as a new screen: the help stays, once.
    moveToMenuRow(d, "Automatic subtask review");
    d.key(ENTER);
    await waitFor(d, (text) => /→ Automatic subtask review\s+(On|Off)/.test(text) && text.includes(NOTICE_PHRASES.review), "re-shown Review");
    assertOnlyNotice(d, "review", `Review after a toggle ${visit}`);

    // Deeper: Evidence methods replaces the Review help with its own.
    await chooseMenuRow(d, "Evidence methods", "Primary / top-level");
    assertOnlyNotice(d, "evidence", `Evidence ${visit}`);
    if (visit === 0) {
      // A staged warning takes the slot on the next screen and survives navigation
      // within it, then is not pinned once the next action re-shows the menu.
      moveToMenuRow(d, "Primary / top-level");
      d.key(ENTER);
      await waitFor(d, (text) => /→ Primary \/ top-level\s+Tools only/.test(text), "the staged evidence warning");
      assertOnlyNotice(d, "primaryWarning", "evidence warning");
      d.key(DOWN);
      assertOnlyNotice(d, "primaryWarning", "evidence warning after moving");
      moveToMenuRow(d, "Isolated worktree");
      d.key(ENTER);
      await waitFor(d, (text) => /→ Isolated worktree\s+Tools only/.test(text), "evidence help again");
      assertOnlyNotice(d, "evidence", "evidence after the next action");
    }
    d.key(ESC); // Back to Review
    await waitFor(d, (text) => text.includes("→ Evidence methods") && text.includes(NOTICE_PHRASES.review), `Review after Back ${visit}`);
    assertOnlyNotice(d, "review", `Review after Back ${visit}`);

    // A reviewer picker inherits the Review help; Back keeps it.
    await chooseMenuRow(d, "Primary reviewers", "Enable all");
    assertOnlyNotice(d, "review", `reviewer picker ${visit}`);
    d.key(ESC);
    await waitFor(d, (text) => text.includes("→ Primary reviewers"), "Review after the picker");
    assertOnlyNotice(d, "review", `Review after the picker ${visit}`);

    d.key(ESC); // Back to the root
    await waitFor(d, (text) => text.includes("→ Reviewers") && text.includes(NOTICE_PHRASES.target), "root after Back");
    assertOnlyNotice(d, "target", `root after visit ${visit}`);
  }

  // An info result of an action replaces the help on its next screen only.
  await chooseMenuRow(d, "Reviewers", "→ Automatic primary review");
  moveToMenuRow(d, "Automatic primary review");
  d.key(ENTER);
  await waitFor(d, (text) => /→ Automatic primary review\s+Off/.test(text), "primary review Off");
  moveToMenuRow(d, "Review landed changes");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("→ Review landed changes"), "the inactive notice");
  assertOnlyNotice(d, "landedInactive", "landed inactive result");
  moveToMenuRow(d, "Automatic primary review");
  d.key(ENTER);
  await waitFor(d, (text) => /→ Automatic primary review\s+On/.test(text) && text.includes(NOTICE_PHRASES.review), "help after the next action");
  assertOnlyNotice(d, "review", "Review after the inactive result");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("→ Reviewers"), "root");

  // The pane's own refusal is the one notice while it stands; a fresh key clears it.
  moveToMenuRow(d, "Cancel");
  d.writes = false;
  d.key(UP);
  d.frame();
  d.key(ENTER);
  await turns();
  d.writes = true;
  assertOnlyNotice(d, "notDrawn", "the refused action");
  d.key(DOWN);
  assertOnlyNotice(d, "target", "root after the refusal clears");

  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Cancel");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "navigation saved nothing");
});

test("one contextual notice: opening diagnostics take the slot once, the LOCAL target returns, and a failed Save reports its error", async (t) => {
  const l = local(t);
  const catalogWarning = "no Pi models are scoped yet";
  const first = driven(l, {}, () => ({ ...fakeCatalog(), warnings: [catalogWarning] }));
  first.rows = 40;
  await openReviewSettings(first);
  // First use with a catalog diagnostic: the diagnostic is the first screen's notice.
  let shown = first.text();
  assert.ok(shown.includes(`! review gate: settings catalog: ${catalogWarning}`), shown);
  assert.ok(!shown.includes("No config exists yet"), `one notice at a time:\n${shown}`);
  first.key(DOWN);
  assert.ok(first.text().includes(catalogWarning), "the diagnostic stays while the screen does");
  // After an action the root restores the first-use target notice; the diagnostic is not pinned.
  await chooseMenuRow(first, "Reviewers", "→ Automatic primary review");
  first.key(ESC);
  await waitFor(first, (text) => text.includes("→ Reviewers") && text.includes("No config exists yet"), "the first-use target");
  shown = first.text();
  assert.ok(!shown.includes(catalogWarning), shown);
  assert.ok(shown.includes("Save creates"), "the first-use Save semantics are shown");
  first.key(ESC);
  await waitFor(first, (text) => text.includes("> Review settings"), "Settings");
  await Promise.all(first.settled);
  assert.equal(existsSync(l.canonical), false);

  // An unparseable config: its load warning opens; a failed Save is the next root's one error.
  const bytes = "{ \"secretMarker-7f3a\": ";
  writeFileSync(l.canonical, bytes, "utf8");
  const broken = driven(l);
  broken.rows = 40;
  await openReviewSettings(broken);
  shown = broken.text();
  assert.match(shown, /could not be read or parsed/);
  assert.ok(!shown.includes(NOTICE_PHRASES.target), shown);
  // Navigating away and back restores the target: the opening warning is not pinned.
  await chooseMenuRow(broken, "Reviewers", "→ Automatic primary review");
  assertOnlyNotice(broken, "review", "Review in the unparseable config");
  broken.key(ESC);
  await waitFor(broken, (text) => text.includes("→ Reviewers"), "root again");
  assertOnlyNotice(broken, "target", "root after the opening warning");
  // A failed Save ends the open truthfully: its one error is the Settings result.
  broken.key(CTRL_S);
  await waitFor(broken, (text) => text.includes("> Review settings"), "Settings after the failed Save");
  shown = broken.text();
  assert.match(shown, /! review gate: local review settings failed: .*not valid/);
  assert.ok(!shown.includes("secretMarker"));
  assert.ok(!shown.includes(NOTICE_PHRASES.target), shown);
  await Promise.all(broken.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytes, "the broken file is untouched");
});

const RETENTION_DISCLOSURE_START = "Turning this on saves every auditor invocation";
const RETENTION_DISCLOSURE_END = "Save/Ctrl+S (disk).";

async function openRetentionConfirmation(d: Driven): Promise<void> {
  await chooseMenuRow(d, "Tools", "Tool protection");
  await chooseMenuRow(d, "Tool protection", "Save auditor sessions");
  moveToMenuRow(d, "Save auditor sessions");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("Save every auditor session?") && text.includes("→ No"), "the retention confirmation");
}

test("one contextual notice: a confirmation's disclosure replaces the section notice, stays whole, and gates Yes", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  await openRetentionConfirmation(d);
  let shown = d.frame();
  let text = shown.join("\n");
  assert.ok(text.includes(RETENTION_DISCLOSURE_START) && text.includes(RETENTION_DISCLOSURE_END), `the whole disclosure:\n${text}`);
  assert.equal(shown.filter((line) => line.includes(RETENTION_DISCLOSURE_START)).length, 1, "drawn once");
  assert.ok(!text.includes(NOTICE_PHRASES.target), `the disclosure is the one notice:\n${text}`);
  assert.ok(shown.some((line) => line.trimStart().startsWith("Yes")) && shown.some((line) => line.trimStart().startsWith("→ No")), text);

  // A pane too short for the whole disclosure is too small and confirms nothing.
  d.rows = 12;
  assert.match(d.text(), /too small/);
  d.key(UP);
  d.key(ENTER);
  await turns();
  d.rows = 30;
  text = d.text();
  assert.match(text, /Save every auditor session\?/, "still confirming");
  assert.ok(!text.includes(RETENTION_DISCLOSURE_START), `the refusal error takes the slot:\n${text}`);
  assert.match(text, /not completely shown/);
  // Yes on a written frame without the disclosure is refused and restores it.
  d.key(ENTER);
  await turns();
  text = d.text();
  assert.match(text, /Save every auditor session\?/, "Yes was not accepted without the disclosure");
  assert.ok(text.includes(RETENTION_DISCLOSURE_START) && !/not completely shown/.test(text), `the disclosure is back alone:\n${text}`);
  assert.ok(d.frame().some((line) => line.trimStart().startsWith("→ Yes")));

  // Restoring the disclosure never hides a later refusal on the same screen.
  d.sidebar.invalidateReviewSettingsPresentation(); // e.g. a terminal handoff
  d.key(ENTER);
  await turns();
  text = d.text();
  assert.match(text, /Save every auditor session\?/, "the revoked frame confirmed nothing");
  assert.match(text, /not completely shown/, `the new refusal is shown:\n${text}`);
  assert.ok(!text.includes(RETENTION_DISCLOSURE_START), text);
  // A newer error replaces the older refusal; it authorizes nothing.
  d.opens[0]!.notify?.("review gate: a newer settings error", "error");
  text = d.text();
  assert.match(text, /a newer settings error/);
  assert.doesNotMatch(text, /not completely shown/);
  assert.ok(!text.includes(RETENTION_DISCLOSURE_START), text);
  d.key(ENTER);
  await turns();
  text = d.text();
  assert.match(text, /Save every auditor session\?/, "Yes was again refused without the disclosure");
  assert.ok(text.includes(RETENTION_DISCLOSURE_START) && !/a newer settings error|not completely shown/.test(text), text);

  // Now Yes is shown with its disclosure and confirms.
  d.key(ENTER);
  await waitFor(d, (shownText) => /→ Save auditor sessions\s+On/.test(shownText), "retention staged On");
  moveToMenuRow(d, "Back");
  d.key(ESC);
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a staged confirmation saves nothing");
});

for (const cancelKey of ["backspace", "ctrl+s", "alt+right", "alt+left", "tab"] as const) test(`one contextual notice: an oversized disclosure refuses confirmation and provides a way back with Cancel on ${cancelKey}`, async (t) => {
  const l = local(t);
  // Alt+Right and Alt+Left are the default host shortcuts; legacy Tab is the same byte as a Ctrl+I Toggle.
  const shadowed = cancelKey === "alt+right" || cancelKey === "alt+left" || cancelKey === "tab";
  // The remapped Cancel still wins when it is also bound to Confirm.
  write(join(l.agentDir, "keybindings.json"), {
    // A long Cancel list must not make the fallback unrenderable.
    "tui.select.cancel": cancelKey === "backspace"
      ? [cancelKey, "ctrl+shift+alt+super+pageUp", "ctrl+shift+alt+super+pageDown", "ctrl+shift+alt+super+left"]
      : [cancelKey],
    "tui.select.confirm": ["enter", cancelKey],
  });
  const toolNames = Array.from({ length: 120 }, (_, index) => `audited_tool_name_${String(index).padStart(3, "0")}`);
  const bytesA = write(l.canonical, { ...DISK_A, toolProtection: { level: "off", scope: "selected", toolNames } });
  const d = driven(l, cancelKey === "tab" ? { toggleKey: "ctrl+i" } : {});
  d.rows = 80; // room for far more than a truncated prefix
  await openReviewSettings(d);
  await chooseMenuRow(d, "Tools", "Tool protection");
  await chooseMenuRow(d, "Tool protection", "Auditor");
  moveToMenuRow(d, "Auditor");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("Tool protection auditor"), "the auditor picker");
  moveToMenuRow(d, "acme/deep");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("exceeds the display limit"), "the oversized confirmation");
  const shown = d.frame();
  const text = shown.join("\n");
  assert.match(text, /escape go back/i, `Escape is the advertised way back:\n${text}`);
  assert.equal(shown.filter((line) => line.startsWith("! ")).length, 1, text);
  assert.ok(!text.includes("Choosing acme/deep") && !text.includes("audited_tool_name_000"), `no prefix is shown as the disclosure:\n${text}`);
  assert.ok(!shown.some((line) => /^\s*(→ )?(Yes|No)\s*$/.test(line)), `no choice is offered:\n${text}`);
  assert.equal(d.sidebar.captureReviewSettingsPresentation(), undefined, "no frame can authorize Yes");
  d.key(UP); // toward Yes
  d.key(ENTER);
  await turns();
  assert.match(d.text(), /exceeds the display limit/, "Yes/Enter did nothing");
  d.key(shadowed ? ESC : cancelKey === "backspace" ? "\x7f" : CTRL_S);
  await waitFor(d, (shownText) => shownText.includes("Auditor unchanged"), "Cancel answered No");
  assert.equal(d.sidebar.focus, "form", "the editor stays open");
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

test("one contextual notice: the fail-closed tool-protection diagnostic outranks routine catalog guidance", async (t) => {
  const l = local(t);
  write(l.canonical, { ...DISK_A, toolProtection: { level: "not-a-level" } });
  const d = driven(l, {}, () => ({ ...fakeCatalog(), warnings: ["no Pi models are scoped yet"] }));
  d.rows = 40;
  await openReviewSettings(d);
  const text = d.text();
  assert.match(text, /! review gate: saved tool-protection settings are invalid/);
  assert.ok(!text.includes("no Pi models are scoped yet"), `one notice at a time:\n${text}`);
  assert.ok(!text.includes(NOTICE_PHRASES.target), text);
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
});

test("one contextual notice: a notice arriving after a written frame revokes its authority until a fresh frame is written", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  moveToMenuRow(d, "Cancel");
  d.frame(); // written
  d.opens[0]!.notify?.("review gate: a late warning", "warning");
  d.key(ENTER);
  d.key(CTRL_S);
  await turns();
  assert.equal(d.sidebar.focus, "form", "neither Cancel nor Save acted");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
  // The refusal is now the one notice; a fresh written frame restores authority.
  assert.match(d.text(), /not completely shown/);
  d.frame();
  d.key(CTRL_S);
  await waitFor(d, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "saved from the fresh frame");
  await Promise.all(d.settled);
});

test("one contextual notice: a field rejection outranks the field warning and clears after an accepted edit", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const fieldWarning = "Native keybindings.json is unavailable; using Pi's default form keys";
  // Ctrl+G replacements, applied asynchronously like the real host editor's.
  const externalResults = ["unsafe\x07text", "^https://corrected"];
  const d = driven(l, {
    createTextField: (options) => ({
      field: createSessionHostTextField({
        kind: "text",
        multiline: options.multiline === true,
        initialText: options.initialText,
        onInvalidate: options.onInvalidate,
        onSubmit: options.onSubmit,
        onCancel: options.onCancel,
        onReject: options.onReject,
        onChange: options.onChange,
        onExternalEditor: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return externalResults.shift();
        },
      }),
      notice: fieldWarning,
    }),
  });
  await openReviewSettings(d);
  await chooseMenuRow(d, "Tools", "Web");
  await chooseMenuRow(d, "Web", "URL blocklist");
  moveToMenuRow(d, "URL blocklist");
  d.key(ENTER);
  await waitFor(d, (shown) => shown.includes("Blocked URL patterns"), "the shared text field");
  const notices = (): string[] => d.frame().filter((line) => line.startsWith("! ")).map((line) => line.trimEnd());
  assert.deepEqual(notices(), [`! ${fieldWarning}`], d.text());
  d.key(`${PASTE_START}${"z".repeat(9000)}${PASTE_END}`);
  assert.deepEqual(notices(), ["! Pasted text exceeds the field limit"], `the error wins:\n${d.text()}`);
  d.key("\x1b[D"); // cursor-only movement keeps it
  assert.deepEqual(notices(), ["! Pasted text exceeds the field limit"], d.text());
  d.key("a"); // an accepted value change clears it without leaving the editor
  assert.deepEqual(notices(), [`! ${fieldWarning}`], d.text());
  assert.match(d.text(), /Blocked URL patterns/);

  // Another rejection keeps the error; a rejected external replacement replaces it
  // with its own; an accepted changed external replacement clears it with no keystroke.
  d.key(`${PASTE_START}${"z".repeat(9000)}${PASTE_END}`);
  d.key(`${PASTE_START}${"z".repeat(9000)}${PASTE_END}`);
  assert.deepEqual(notices(), ["! Pasted text exceeds the field limit"], d.text());
  d.key(CTRL_G);
  await turns();
  assert.deepEqual(notices(), ["! Unsafe terminal text was rejected"], `a rejected replacement:\n${d.text()}`);
  d.key(CTRL_G);
  await turns();
  assert.deepEqual(notices(), [`! ${fieldWarning}`], `the accepted replacement cleared it:\n${d.text()}`);
  assert.match(d.text(), /\^https:\/\/corrected/);
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
});

test("one contextual notice: a screen that cannot be drawn shows only its failure and keeps no authority", async () => {
  let settledWith: string | undefined | null = null;
  let finish!: () => void;
  const sidebar = new SidebarController({
    settingsAvailable: false,
    reviewSettings: {
      open: async (ui) => {
        await ui.settingsSectionHelp?.section("Section help that must not stack", async () => {
          settledWith = await ui.custom!(() => ({
            render: (): string[] => { throw new Error("boom"); },
            handleInput: (): void => undefined,
          }));
        });
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    },
  });
  for (let step = 0; step < 10 && !sidebar.render(80, 30).lines.map(strip).some((line) => line.startsWith("> Settings")); step += 1) sidebar.handleInput(DOWN);
  sidebar.handleInput(ENTER);
  sidebar.render(80, 30);
  sidebar.handleInput(ENTER);
  await turns();
  const lines = sidebar.render(80, 30).lines.map(strip);
  const text = lines.join("\n");
  assert.equal(lines.filter((line) => line.startsWith("! ")).length, 1, text);
  assert.match(text, /! This settings screen could not be drawn/);
  assert.ok(!text.includes("Section help that must not stack"), text);
  assert.equal(sidebar.captureReviewSettingsPresentation(), undefined, "an undrawable screen offers no frame to authorize");
  sidebar.handleInput(ENTER);
  await turns();
  assert.equal(settledWith, null, "Enter never reached the undrawable screen");
  sidebar.cancelReviewSettings();
  finish?.();
});

test("a short sidebar shows both choices of a two-item list instead of one choice and a scroll cue", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  await chooseMenuRow(d, "Subtask notifications", "Quiet — terminal and recovery events");
  d.cols = 80;
  d.rows = 7;
  const shown = d.frame();
  assert.equal(shown.length, 7);
  assert.doesNotMatch(shown.join("\n"), /too small/);
  assert.ok(shown.some((line) => line.includes("Quiet — terminal and recovery events")), shown.join("\n"));
  assert.ok(shown.some((line) => line.includes("Noisy — include running and reviewing")), shown.join("\n"));
  assert.ok(!shown.some((line) => SCROLL_CUE.test(line)), "a complete two-item list draws no scroll cue");
  assert.ok(shown.some((line) => line.includes("Editing LOCAL")), "the LOCAL notice stays visible");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("→ Subtask notifications"), "root after Back");
  d.rows = 30;
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Cancel");
  await Promise.all(d.settled);
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA);
});

test("a narrow sidebar measures wrapped notices, hints, and footer before sizing the list", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  d.cols = 36;
  d.rows = 18;
  const shown = d.frame();
  assert.equal(shown.length, 18);
  assert.doesNotMatch(shown.join("\n"), /too small/);
  assert.ok(shown.some((line) => line.includes("Editing LOCAL")), shown.join("\n"));
  assert.ok(shown.some((line) => line.trimStart().startsWith("→ ")), "an actionable row is drawn");
  assert.ok(shown.some((line) => SCROLL_CUE.test(line)));
  const hintRows = shown.filter((line) => /navigate|discard|Ctrl\+S save|enter select/.test(line)).length;
  assert.ok(hintRows >= 2, `the key hints wrap at this width:\n${shown.join("\n")}`);
  for (const line of shown) assert.ok(line.length <= d.cols, line);
  // The screen keeps its action authority on this complete frame.
  moveToMenuRow(d, "Cancel");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("> Review settings"), "Settings after Cancel");
  await Promise.all(d.settled);
});

test("navigation then Enter before a redraw, an unwritten frame, or a revoked frame never confirms or saves", async (t) => {
  const l = local(t);
  const bytesA = write(l.canonical, DISK_A);
  // A key bound to both Cancel and Confirm confirms on an ordinary list, so it
  // needs the same written frame as Enter.
  write(join(l.agentDir, "keybindings.json"), {
    "tui.select.cancel": ["escape", "backspace"],
    "tui.select.confirm": ["enter", "backspace"],
  });
  const d = driven(l);
  await openReviewSettings(d);
  moveToMenuRow(d, "Cancel");
  // Up selects Save changes; Enter, a shared Confirm/Cancel key, and Ctrl+S arrive before the redraw.
  d.key(UP);
  d.key(ENTER);
  d.key("\x7f");
  d.key(CTRL_S);
  await turns();
  assert.equal(d.sidebar.focus, "form");
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "an unseen selection never saves");
  assert.match(d.text(), /→ Save changes/);
  assert.match(d.text(), /review the current screen/);

  // A drawn frame the writer never reported written authorizes nothing.
  d.writes = false;
  d.key(UP);
  d.key(DOWN);
  d.frame();
  d.key(ENTER);
  await turns();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a queued/held frame never saves");
  // Nor does a written frame that Main later revoked (a resize or handoff).
  d.writes = true;
  d.frame();
  d.sidebar.invalidateReviewSettingsPresentation();
  d.key(ENTER);
  await turns();
  assert.equal(readFileSync(l.canonical, "utf8"), bytesA, "a revoked frame never saves");

  // The current, written frame does, through the shared key too.
  d.frame();
  d.key("\x7f");
  await waitFor(d, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "saved");
  await Promise.all(d.settled);
  assert.notEqual(readFileSync(l.canonical, "utf8"), bytesA);
});

test("held Enter and Ctrl+S never replay across a finished screen, a hidden pane, or into Main", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const forwards = (d: Driven): string[] => d.actions
    .filter((action): action is Extract<SidebarAction, { type: "forward" }> => action.type === "forward")
    .map((action) => action.data);

  // Enter on Cancel ends the transaction; the toggle hides the pane while it is held.
  const enter = driven(l);
  await openReviewSettings(enter);
  moveToMenuRow(enter, "Cancel");
  enter.key(ENTER);
  await waitFor(enter, (text) => text.includes("> Review settings"), "Settings");
  enter.key(ENTER_REPEAT);
  assert.ok(enter.frame().some((line) => line.startsWith("> Review settings")), "the held Enter did not reopen anything");
  enter.key(ALT_LEFT);
  assert.equal(enter.sidebar.focus, "main");
  enter.key(ENTER_REPEAT);
  enter.key(ENTER_RELEASE);
  assert.deepEqual(forwards(enter), [], "the held Enter never reaches the child");
  enter.key(ENTER);
  assert.deepEqual(forwards(enter), [ENTER], "a fresh Enter is ordinary native input");
  await Promise.all(enter.settled);

  // Ctrl+S saves and returns to Settings; its held repeat/release never forwards.
  const save = driven(l);
  await openReviewSettings(save);
  save.key(CTRL_S);
  await waitFor(save, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "saved");
  save.key(ALT_LEFT);
  assert.equal(save.sidebar.focus, "main");
  save.key(CTRL_S_REPEAT);
  save.key(CTRL_S_RELEASE);
  assert.deepEqual(forwards(save), [], "the held Ctrl+S never reaches the child");
  save.key(CTRL_S);
  assert.deepEqual(forwards(save), [CTRL_S], "a fresh Ctrl+S is ordinary native input");
  await Promise.all(save.settled);

  // A submitted text field's held Enter neither confirms the re-shown menu nor forwards.
  const text = driven(l);
  await openReviewSettings(text);
  await chooseMenuRow(text, "Tools", "Web");
  await chooseMenuRow(text, "Web", "URL blocklist");
  moveToMenuRow(text, "URL blocklist");
  text.key(ENTER);
  await waitFor(text, (shown) => shown.includes("Blocked URL patterns"), "the shared text field");
  for (const ch of "^https://held") text.key(ch);
  text.key(ENTER);
  await waitFor(text, (shown) => shown.includes("→ URL blocklist"), "Web settings");
  text.key(ENTER_REPEAT);
  await turns();
  assert.match(text.text(), /→ URL blocklist/, "the held submit did not reopen the field");
  text.key(ALT_LEFT);
  text.key(ENTER_REPEAT);
  text.key(ENTER_RELEASE);
  assert.deepEqual(forwards(text), [], "the held submit never reaches the child");
  await Promise.all(text.settled);
});

test("configuration text is sanitized to the closed sidebar palette", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const d = driven(l, {}, () => fakeCatalog("evil\x1b]52;c;cGF5bG9hZA==\x07\x1b[38;2;1;2;3mred\x1b[0m"));
  await openReviewSettings(d);
  await chooseMenuRow(d, "Tools", "Top-level tools");
  moveToMenuRow(d, "Top-level tools");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("evil"), "the deny picker");
  assertClosedSgr(d.raw());
  assert.ok(!d.raw().includes("38;2;1;2;3"), "an injected RGB color is removed");
  d.key(ESC);
  await waitFor(d, (text) => text.includes("Top-level tools") && text.includes("Executor tools"), "Tools");
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
});

// ---------------------------------------------------------------------------
// The shared generic text field
// ---------------------------------------------------------------------------

test("every settings value edits in the shared multi-line field: >8 KiB, CRLF, trailing newline, explicit editor bound", async (t) => {
  const l = local(t);
  let captured: UiContext | undefined;
  let finish!: () => void;
  const editorCalls: unknown[][] = [];
  const sidebar = new SidebarController({
    settingsAvailable: false,
    reviewSettings: {
      open: (ui) => {
        captured = ui;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    },
    createTextField: (options) => {
      assert.equal(options.kind, "text");
      assert.equal(options.multiline, true);
      return {
        field: createSessionHostTextField({
          kind: "text",
          multiline: options.multiline === true,
          initialText: options.initialText,
          onInvalidate: options.onInvalidate,
          onSubmit: options.onSubmit,
          onCancel: options.onCancel,
          onReject: options.onReject,
          onExternalEditor: (...args: unknown[]) => {
            editorCalls.push(args);
            return `edited\r\n${"y".repeat(9000)}\r\n`;
          },
        }),
      };
    },
  });
  for (let step = 0; step < 10 && !sidebar.render(80, 30).lines.map(strip).some((line) => line.startsWith("> Settings")); step += 1) sidebar.handleInput(DOWN);
  sidebar.handleInput(ENTER);
  sidebar.render(80, 30); // the Settings rows must be drawn before Enter acts
  sidebar.handleInput(ENTER); // the only Settings row: Review settings
  await turns();
  assert.ok(captured, "Main's port received the sidebar UI");
  const ui = captured;
  assert.equal(ui.mode, "tui");
  assert.ok(ui.menuTuiHost && ui.menuTuiHost.setKeybindings === undefined, "no process-global keybinding install");

  const long = `${"x".repeat(9000)}\r\nsecond line\r\n`;
  assert.ok(Buffer.byteLength(long) > MAX_EDITOR_TEXT_BYTES);
  const first = ui.editText!({ title: "Scheduled instructions", currentValue: long, options: {} });
  await turns();
  const shown = sidebar.render(80, 30).lines.map(strip).join("\n");
  assert.match(shown, /Scheduled instructions/);
  sidebar.handleInput(CTRL_S); // inert while typing
  sidebar.handleInput(ENTER);
  assert.equal(await first, long.replace(/\r\n/g, "\n"), "the value round-trips untruncated with its final line break");

  const second = ui.editText!({ title: "Blocked URL patterns", currentValue: "a", options: {} });
  await turns();
  sidebar.render(80, 30);
  sidebar.handleInput(`${PASTE_START}b${ESC}\r${PASTE_END}`);
  sidebar.handleInput(CTRL_J);
  sidebar.handleInput("c");
  sidebar.handleInput(ENTER);
  const typed = await second;
  assert.ok(typed !== undefined && typed.includes("\n"), `Ctrl+J inserts a line break: ${JSON.stringify(typed)}`);
  assert.ok(typed.includes("b") && typed.includes("c"), "a pasted chord stayed text and never cancelled");

  const third = ui.editText!({ title: "Edit externally", currentValue: "start\n", options: {} });
  await turns();
  sidebar.render(80, 30);
  sidebar.handleInput(CTRL_G);
  await turns();
  assert.deepEqual(editorCalls, [["start\n", MAX_TEXT_FIELD_BYTES, true]], "the text field reports its own bound and line shape");
  sidebar.handleInput(ENTER);
  assert.equal(await third, `edited\n${"y".repeat(9000)}\n`, "external CRLF content normalizes and keeps its final newline");

  const cancelled = ui.editText!({ title: "Cancel me", currentValue: "keep", options: {} });
  await turns();
  sidebar.handleInput(ESC);
  assert.equal(await cancelled, undefined, "Escape cancels the field");
  finish();
  await turns();
});

test("an external worker ID edits single-line in the shared field: an ordinary Ctrl+G save keeps the valid ID", async (t) => {
  const l = local(t);
  const tempRoot = join(l.root, "editor-files");
  mkdirSync(tempRoot);
  let captured: UiContext | undefined;
  let finish!: () => void;
  const fieldShapes: Array<boolean | undefined> = [];
  const editorCalls: unknown[][] = [];
  // An ordinary editor save (Vim's :wq on an unchanged buffer) writes the
  // temporary file back with its conventional closing newline.
  const ordinarySave = ((_command: string, args: string[]) => {
    const file = args.at(-1)!;
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`, "utf8");
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 12_351, exitCode: null, signalCode: null, killed: false, kill: () => true });
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const sidebar = new SidebarController({
    settingsAvailable: false,
    reviewSettings: {
      open: (ui) => {
        captured = ui;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    },
    createTextField: (options) => {
      assert.equal(options.kind, "text");
      fieldShapes.push(options.multiline);
      return {
        field: createSessionHostTextField({
          kind: "text",
          multiline: options.multiline === true,
          initialText: options.initialText,
          onInvalidate: options.onInvalidate,
          onSubmit: options.onSubmit,
          onCancel: options.onCancel,
          onReject: options.onReject,
          // The real host editor helper, exactly as Main forwards the field's call.
          onExternalEditor: (text, maxTextBytes, preserveFinalLineTerminator) => {
            editorCalls.push([text, maxTextBytes, preserveFinalLineTerminator]);
            return runNativeExternalEditor(text, {
              env: { [PI_AGENT_DIR_ENV]: l.agentDir, VISUAL: "vim" },
              cwd: l.workspace,
              tempRoot,
              spawn: ordinarySave,
              ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
              ...(preserveFinalLineTerminator === undefined ? {} : { preserveFinalLineTerminator }),
            });
          },
        }),
      };
    },
  });
  // The synthetic writer: every drawn frame is reported written, as Main does.
  const frame = (): string => {
    const lines = sidebar.render(80, 30).lines.map(strip);
    const presented = sidebar.captureReviewSettingsPresentation();
    if (presented !== undefined) sidebar.settleReviewSettingsRender(presented.renderToken);
    return lines.join("\n");
  };
  for (let step = 0; step < 10 && !frame().split("\n").some((line) => line.startsWith("> Settings")); step += 1) sidebar.handleInput(DOWN);
  sidebar.handleInput(ENTER);
  frame();
  sidebar.handleInput(ENTER);
  await turns();
  assert.ok(captured, "Main's port received the sidebar UI");
  const ui = captured;

  // The real external-agent editor flow, through the sidebar's own UI.
  const config = normalizeConfig({ externalAgents: { "worker-id": { adapter: "codex-cli", execution: {} } } });
  const edit = selectExternalAgentEdit(ui, config, resolvedExternalAgent(config, "worker-id")!);
  const waitFrame = async (predicate: (text: string) => boolean, what: string): Promise<string> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const text = frame();
      if (predicate(text)) return text;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    return assert.fail(`timed out waiting for ${what}:\n${frame()}`);
  };
  const moveTo = async (label: string): Promise<void> => {
    await waitFrame((text) => text.includes(label), label);
    for (let step = 0; step < 20; step += 1) {
      if (frame().split("\n").some((line) => line.trimStart().startsWith(`→ ${label}`))) return;
      sidebar.handleInput(DOWN);
    }
    assert.fail(`no highlighted menu row ${label}:\n${frame()}`);
  };
  await moveTo("Identifier: worker-id");
  sidebar.handleInput(ENTER);
  const shown = await waitFrame((text) => text.includes("Unique identifier"), "the identifier field");
  assert.doesNotMatch(shown, /ctrl\+j newline/, "a single-line value advertises no newline chord");
  assert.deepEqual(fieldShapes, [false], "the identifier opens the shared field single-line");

  sidebar.handleInput(CTRL_G);
  const deadline = Date.now() + 10_000;
  while (editorCalls.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 2));
  await turns();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(editorCalls, [["worker-id", MAX_TEXT_FIELD_BYTES, false]], "the editor is asked to drop the closing newline");
  frame();
  sidebar.handleInput(ENTER);
  await moveTo("Apply edit");
  assert.doesNotMatch(frame(), /Identifier must be unique/, "the unchanged valid ID raised no validation error");
  sidebar.handleInput(ENTER);
  const result = await edit;
  assert.ok(result?.kind === "apply", `the edit applied: ${JSON.stringify(result)}`);
  assert.equal(result.agent.id, "worker-id", "the ordinary save kept the exact valid ID");

  // A multi-line settings value keeps the existing shape and its final newline.
  const multi = ui.editText!({ title: "Scheduled instructions", currentValue: "line one\n\tline two\n", options: {} });
  await waitFrame((text) => text.includes("Scheduled instructions"), "the multi-line field");
  assert.match(frame(), /ctrl\+j newline/);
  sidebar.handleInput(CTRL_G);
  while (editorCalls.length < 2 && Date.now() < deadline + 10_000) await new Promise<void>((resolve) => setTimeout(resolve, 2));
  await turns();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fieldShapes, [false, true]);
  assert.deepEqual(editorCalls[1], ["line one\n    line two\n", MAX_TEXT_FIELD_BYTES, true]);
  frame();
  sidebar.handleInput(ENTER);
  assert.equal(await multi, "line one\n    line two\n\n", "the saved closing newline is preserved as content, with the native TAB expansion");
  assert.deepEqual(readdirSync(tempRoot), [], "the owned editor files are removed");
  finish();
  await turns();
});

// ---------------------------------------------------------------------------
// Mouse caret placement on the shared #714 route
// ---------------------------------------------------------------------------

test("a settings text value places its caret through the shared written-frame route; stale, resized, clipped, pasting, settled, and hidden frames refuse", async () => {
  let captured: UiContext | undefined;
  let finish!: () => void;
  const sidebar = new SidebarController({
    settingsAvailable: false,
    reviewSettings: {
      open: (ui) => {
        captured = ui;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    },
  });
  const COLS = 60;
  const ROWS = 20;
  const lines = (rows = ROWS): string[] => sidebar.render(COLS, rows).lines.map(strip);
  const rowOf = (shown: readonly string[], prefix: string): number => {
    const row = shown.findIndex((line) => line.startsWith(prefix));
    assert.ok(row >= 0, `no row starting ${JSON.stringify(prefix)}:\n${shown.join("\n")}`);
    return row;
  };
  for (let step = 0; step < 10 && !lines().some((line) => line.startsWith("> Settings")); step += 1) sidebar.handleInput(DOWN);
  sidebar.handleInput(ENTER);
  lines();
  sidebar.handleInput(ENTER); // the only Settings row: Review settings
  await turns();
  const ui = captured!;

  const edit = ui.editText!({ title: "Scheduled instructions", currentValue: "first line\nsecond line", options: {} });
  await turns();
  let shown = lines();
  const secondRow = rowOf(shown, "second line");
  const firstRow = rowOf(shown, "first line");
  let written = sidebar.captureMousePresentation();
  assert.equal(written.activateFormRowAt(0, rowOf(shown, "Scheduled instructions"), COLS, ROWS), false, "the title is not editable text");
  assert.equal(written.activateFormRowAt(7, secondRow, COLS + 1, ROWS), false, "geometry the frame did not use");
  assert.equal(written.activateFormRowAt(7, firstRow - 1, COLS, ROWS), false, "the Editor's own top border");
  assert.equal(written.activateFormRowAt(7, secondRow, COLS, ROWS), true, "a press on the second drawn line is accepted");
  sidebar.handleInput("X");
  assert.equal(written.activateFormRowAt(0, firstRow, COLS, ROWS), false, "an edit typed after the written frame refuses it");
  shown = lines();
  assert.ok(shown.some((line) => line.startsWith("second Xline")), shown.join("\n"));
  const fresh = sidebar.captureMousePresentation();
  assert.notEqual(fresh.authorizationKey, written.authorizationKey, "the field frame is part of the authorization");
  assert.equal(written.activateFormRowAt(0, firstRow, COLS, ROWS), false, "the old capture stays refused after a redraw");

  lines(4); // too small: no field is drawn, so nothing is retained
  assert.equal(sidebar.captureMousePresentation().activateFormRowAt(0, firstRow, COLS, ROWS), false, "a too-small frame keeps no caret target");

  shown = lines();
  sidebar.handleInput(PASTE_START);
  lines();
  assert.equal(sidebar.captureMousePresentation().activateFormRowAt(0, firstRow, COLS, ROWS), false, "a bracketed paste in flight refuses");
  sidebar.handleInput(PASTE_END);

  // #653: a late notice takes the pane's one slot above the field and moves it.
  shown = lines();
  written = sidebar.captureMousePresentation();
  const rowBeforeWarning = rowOf(shown, "first line");
  ui.notify!("review gate: a late warning", "warning");
  assert.equal(written.activateFormRowAt(0, rowBeforeWarning, COLS, ROWS), false, "a capture from before the warning refuses before the redraw");
  shown = lines();
  assert.ok(shown.some((line) => line.startsWith("! review gate: a late warning")), shown.join("\n"));
  assert.notEqual(rowOf(shown, "first line"), rowBeforeWarning, "the warning moved the field");
  assert.equal(written.activateFormRowAt(0, rowBeforeWarning, COLS, ROWS), false, "and stays refused after it");

  written = sidebar.captureMousePresentation();
  assert.equal(written.activateFormRowAt(0, rowOf(shown, "first line"), COLS, ROWS), true, "the newly written field row is accepted");
  sidebar.handleInput("Y");
  sidebar.handleInput(ENTER);
  assert.equal(await edit, "Yfirst line\nsecond Xline", "each press moved only the caret; the typed edits landed there");
  assert.equal(written.activateFormRowAt(1, firstRow, COLS, ROWS), false, "a settled edit's frame refuses");

  const hidden = ui.editText!({ title: "Blocked URL patterns", currentValue: "keep", options: {} });
  await turns();
  shown = lines();
  written = sidebar.captureMousePresentation();
  sidebar.cancelReviewSettings();
  assert.equal(await hidden, undefined, "leaving the pane cancels the edit");
  assert.equal(written.activateFormRowAt(1, rowOf(shown, "keep"), COLS, ROWS), false, "a hidden/cancelled open refuses");
  finish();
  await turns();
});

test("the deny picker's query places its caret in the sidebar screen; list rows, stale views, and unwritten frames refuse", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const d = driven(l);
  await openReviewSettings(d);
  await chooseMenuRow(d, "Tools", "Top-level tools");
  moveToMenuRow(d, "Top-level tools");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("Top-level tools —") && text.includes("bash"), "the deny picker");
  d.key("b");
  d.key("a");
  const queryRow = (shown: readonly string[], value: string): number => shown.findIndex((line) => line.trimEnd().endsWith(`> ${value}`) || line.trimEnd() === `> ${value}`);
  let shown = d.frame();
  let row = queryRow(shown, "ba");
  assert.ok(row >= 0, shown.join("\n"));
  const promptColumn = (shown[row] ?? "").indexOf("> ba");
  let written = d.sidebar.captureMousePresentation();
  const bashRow = shown.findIndex((line, index) => index > row && line.includes("bash"));
  assert.ok(bashRow > row, shown.join("\n"));
  assert.equal(written.activateFormRowAt(promptColumn + 2, bashRow, d.cols, d.rows), false, "a list row is never toggled or confirmed");
  assert.deepEqual(d.frame(), shown, "the refused press changed nothing");
  assert.equal(written.activateFormRowAt(promptColumn + 2, row, d.cols, d.rows + 1), false, "geometry the frame did not use");

  assert.equal(written.activateFormRowAt(promptColumn + 2, row, d.cols, d.rows), true, "a press before 'b' is accepted");
  d.key("x");
  assert.equal(written.activateFormRowAt(promptColumn + 3, row, d.cols, d.rows), false, "a key after the written frame refuses it");
  shown = d.frame();
  row = queryRow(shown, "xba");
  assert.ok(row >= 0, `the typed key landed at the clicked caret:\n${shown.join("\n")}`);

  d.writes = false;
  shown = d.frame();
  d.key("\x1b[D"); // a view change the writer has not reported
  d.frame();
  written = d.sidebar.captureMousePresentation();
  assert.equal(written.activateFormRowAt(promptColumn + 2, row, d.cols, d.rows), false, "an unwritten frame keeps no caret authority");
  d.writes = true;
  shown = d.frame();
  written = d.sidebar.captureMousePresentation();
  assert.equal(written.activateFormRowAt(promptColumn + 5, row, d.cols, d.rows), true, "a press after 'xba' is accepted once written");
  d.key("!");
  assert.ok(queryRow(d.frame(), "xba!") >= 0, d.text());
  d.key(ESC);
  await waitFor(d, (text) => text.includes("Top-level tools") && text.includes("Executor tools"), "Tools");
  assert.equal(written.activateFormRowAt(promptColumn + 2, row, d.cols, d.rows), false, "a closed picker's frame refuses");
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
});

test("a long deny picker fills a tall sidebar and scrolls in a short one; its query, caret, and selection survive resizing", async (t) => {
  const l = local(t);
  write(l.canonical, DISK_A);
  const many = (): ReviewSettingsCatalog => ({
    ...fakeCatalog(),
    tools: Array.from({ length: 30 }, (_, index) => ({ name: `tool_${String(index).padStart(2, "0")}` })),
  });
  const d = driven(l, {}, many);
  d.rows = 44;
  await openReviewSettings(d);
  await chooseMenuRow(d, "Tools", "Top-level tools");
  moveToMenuRow(d, "Top-level tools");
  d.key(ENTER);
  await waitFor(d, (text) => text.includes("Top-level tools —") && text.includes("tool_00"), "the deny picker");
  const toolRows = (shown: readonly string[]): number => shown.filter((line) => /(✓ denied|✗ allowed)\s*$/.test(line)).length;
  let shown = d.frame();
  assert.equal(toolRows(shown), 30, `every tool fits:\n${shown.join("\n")}`);
  assert.ok(!shown.some((line) => SCROLL_CUE.test(line)));

  for (const key of ["t", "o", "o", "l", "_", "1"]) d.key(key);
  d.key(DOWN);
  d.key(DOWN);
  shown = d.frame();
  const highlightedRow = (lines: readonly string[]): string | undefined => lines.find((line) => line.trimStart().startsWith("→ "))?.trim();
  const target = highlightedRow(shown);
  assert.ok(target !== undefined && target.includes("tool_"), shown.join("\n"));

  d.rows = 14;
  shown = d.frame();
  assert.doesNotMatch(shown.join("\n"), /too small/);
  assert.ok(toolRows(shown) >= 1 && toolRows(shown) < 10, shown.join("\n"));
  assert.ok(shown.some((line) => SCROLL_CUE.test(line)));
  assert.equal(highlightedRow(shown), target, "the picker's selection survives the resize");
  const row = shown.findIndex((line) => line.trimEnd().endsWith("> tool_1"));
  assert.ok(row >= 0, `the query survives the resize:\n${shown.join("\n")}`);
  const column = (shown[row] ?? "").indexOf("> tool_1");
  const written = d.sidebar.captureMousePresentation();
  assert.equal(written.activateFormRowAt(column + 2, row, d.cols, d.rows), true, "the caret maps to the written short frame");
  d.key("x");
  assert.ok(d.frame().some((line) => line.trimEnd().endsWith("> xtool_1")), d.text());
  d.key(ESC);
  await waitFor(d, (text) => text.includes("Executor tools"), "Tools");
  d.sidebar.cancelReviewSettings();
  await Promise.all(d.settled);
});

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

function ownedAgentDir(): string {
  const dir = makeMainTestDirectory("review-settings-agent");
  writeFileSync(join(dir, "keybindings.json"), "{}", "utf8");
  return dir;
}

function frameText(harness: Harness): string {
  return plain(harness.writer.frames.at(-1)?.frame);
}

async function settleMain(harness: Harness, predicate: (text: string) => boolean, what: string): Promise<void> {
  // Real disk IO (the shared persistence) settles on the event loop, so this
  // waits in bounded wall-clock steps rather than a fixed number of turns.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate(frameText(harness))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}:\n${frameText(harness)}`);
}

async function mainMoveTo(harness: Harness, pattern: RegExp, what: string): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    if (frameText(harness).split("\n").some((line) => pattern.test(line))) return;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  assert.fail(`never highlighted ${what}:\n${frameText(harness)}`);
}

test("Main wires Review settings to the fresh LOCAL service with its startup snapshot and forwards the larger editor call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rs-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const agentDir = ownedAgentDir();
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const canonical = join(agentDir, "review-gate.json");
  const bytesA = write(canonical, DISK_A);
  const inputs: LocalReviewSettingsInput[] = [];
  const editorCalls: Array<{ text: string; options: Record<string, unknown> }> = [];
  const blocklist = Array.from({ length: 400 }, (_, index) => `^https://blocked-${String(index).padStart(4, "0")}\\.example/`);
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, args: ["--models", "acme/*"] }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    openLocalReviewSettings: (input) => {
      inputs.push(input);
      return openLocalReviewSettings(input, { loadChoices: async () => fakeCatalog() });
    },
    runExternalEditor: async (text, editorOptions) => {
      editorCalls.push({ text, options: { ...editorOptions } as Record<string, unknown> });
      return `${blocklist.join("\r\n")}\r\n`;
    },
  });
  await ready(harness);
  await nextTurn();

  await mainMoveTo(harness, /> Settings/, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await mainMoveTo(harness, /> Review settings/, "Review settings");
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("→ Operating mode"), "the root menu");
  assert.equal(inputs.length, 1);
  const input = inputs[0]!;
  assert.equal(input.agentDir, agentDir, "the canonical native agent directory");
  assert.equal(input.piExecutable, "/synthetic/pi", "the actually resolved Pi executable");
  assert.deepEqual([...(input.args ?? [])], ["--models", "acme/*"], "the startup args");
  assert.equal(input.cwd, process.cwd(), "the startup directory");
  assert.equal(input.env.HOME, home, "the startup snapshot environment");
  assert.deepEqual(Object.keys(input).sort(), ["agentDir", "args", "cwd", "env", "piExecutable", "ui"], "no session or row data");
  assert.match(frameText(harness), /Editing LOCAL review-gate settings/);

  // Tools -> Web -> URL blocklist: the shared field and the explicit editor bound.
  for (const [row, next] of [["Tools", "Web"], ["Web", "URL blocklist"], ["URL blocklist", "Blocked URL patterns"]] as const) {
    await mainMoveTo(harness, new RegExp(`→ ${row}`), row);
    harness.terminal.emitInput(ENTER);
    await settleMain(harness, (text) => text.includes(next), next);
  }
  harness.terminal.emitInput(CTRL_G);
  await settleMain(harness, () => editorCalls.length === 1, "the external editor call");
  await nextTurn();
  assert.equal(editorCalls[0]!.options.maxTextBytes, MAX_TEXT_FIELD_BYTES);
  assert.equal(editorCalls[0]!.options.preserveFinalLineTerminator, true);
  assert.deepEqual(Object.keys(editorCalls[0]!.options).sort(), ["cwd", "env", "maxTextBytes", "preserveFinalLineTerminator", "signal"]);
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("→ URL blocklist"), "Web settings");
  harness.terminal.emitInput(CTRL_S);
  await settleMain(harness, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "saved");
  const saved = JSON.parse(readFileSync(canonical, "utf8"));
  assert.deepEqual(saved.web?.urlBlocklist, blocklist, "the >8 KiB multi-line value saved untruncated");
  assert.notEqual(readFileSync(canonical, "utf8"), bytesA);

  // An existing name/path field keeps the original editor call shape.
  harness.terminal.emitInput(ESC);
  await nextTurn();
  harness.terminal.emitInput(ESC);
  await nextTurn();
  await mainMoveTo(harness, /> New session/, "New session");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  harness.terminal.emitInput(CTRL_G);
  await settleMain(harness, () => editorCalls.length === 2, "the path field's editor call");
  assert.deepEqual(Object.keys(editorCalls[1]!.options).sort(), ["cwd", "env", "signal"], "old fields keep the default bound and shape");
  assert.equal(await closeWithSignal(harness), 0);
});

test("Main grants a settings action only to the current, actually written frame: held writer and resize", async (t) => {
  const agentDir = ownedAgentDir();
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const root = mkdtempSync(join(tmpdir(), "rs-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(agentDir, "review-gate.json");
  const bytesA = write(canonical, DISK_A);
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    openLocalReviewSettings: (input) => openLocalReviewSettings(input, { loadChoices: async () => fakeCatalog() }),
  });
  await ready(harness);
  await nextTurn();
  await mainMoveTo(harness, /> Settings/, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await mainMoveTo(harness, /> Review settings/, "Review settings");
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("→ Operating mode"), "the root menu");
  await mainMoveTo(harness, /→ Cancel/, "Cancel");

  // A held writer: the newly rendered selection (Save changes) is composed but
  // not yet presented, so neither Enter nor Ctrl+S may act on it.
  harness.writer.holdWrites = true;
  harness.terminal.emitInput(UP);
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  harness.terminal.emitInput(CTRL_S);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "form");
  assert.equal(readFileSync(canonical, "utf8"), bytesA, "nothing saved before the frame was presented");
  harness.writer.drainHeldWrites();
  await nextTurn();

  // A resize before the redraw revokes the receipt; Enter in that window is refused.
  harness.terminal.setSize(100, 30);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(readFileSync(canonical, "utf8"), bytesA, "nothing saved from the pre-resize frame");
  await settleMain(harness, (text) => text.includes("→ Save changes"), "the post-resize frame");
  await nextTurn();

  // The current written frame acts.
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("> Review settings") && /saved to disk/.test(text), "saved");
  assert.notEqual(readFileSync(canonical, "utf8"), bytesA);
  assert.equal(await closeWithSignal(harness), 0);
});

test("Main shutdown discards an open review-settings draft", async (t) => {
  const agentDir = ownedAgentDir();
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const root = mkdtempSync(join(tmpdir(), "rs-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(agentDir, "review-gate.json");
  const bytesA = write(canonical, DISK_A);
  const runs: Array<Promise<void>> = [];
  const harness = createHarness({ env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root } }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    openLocalReviewSettings: (input) => {
      const run = openLocalReviewSettings(input, { loadChoices: async () => fakeCatalog() });
      runs.push(run);
      return run;
    },
  });
  await ready(harness);
  await nextTurn();
  await mainMoveTo(harness, /> Settings/, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  await mainMoveTo(harness, /> Review settings/, "Review settings");
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("→ Operating mode"), "the root menu");
  await mainMoveTo(harness, /→ Tools/, "Tools");
  harness.terminal.emitInput(ENTER);
  await settleMain(harness, (text) => text.includes("YouShouldKnow notices"), "Tools");
  await mainMoveTo(harness, /→ YouShouldKnow notices/, "notices");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(await closeWithSignal(harness), 0);
  await Promise.all(runs);
  assert.equal(readFileSync(canonical, "utf8"), bytesA, "shutdown never saves the staged draft");
});
