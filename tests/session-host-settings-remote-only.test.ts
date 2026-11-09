/**
 * #613 acceptance gaps that the existing Settings/appearance suite does NOT
 * cover: a host whose roster is ONLY remote owner rows, and the grouped
 * Settings -> Network route that reaches an ordinary Network preference.
 *
 * Everything is proven through the seams the product actually uses: real
 * `main.ts` startup and action handling over a fake terminal, the frames Main
 * actually wrote, the production appearance store writing to an owned synthetic
 * native-agent directory, and the coordinator Main itself constructs. The local
 * roster is genuinely empty — no `create`, no native child, no session manager
 * row — while the roster is a controlled remote DTO, so the theme save cannot be
 * riding on any local session. Nothing here reads or changes Pi's own theme,
 * configuration, or keybindings, and nothing contacts a real peer or machine.
 *
 * Truthful scope: this is a synthetic remote-DTO/Main acceptance test. The
 * native real-empty-roster PTY probe lives separately; this file makes no
 * cross-machine, transport, or native-child claim.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import { appearancePath, readAppearanceConfig } from "../src/session-host/appearance-store";
import { SIDEBAR_GENERATED_SGR_ALLOWLIST, SidebarController, type SidebarAction } from "../src/session-host/sidebar";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import {
  DEFAULT_SIDEBAR_THEME,
  SIDEBAR_THEME_SGR_CODES,
  sidebarPaletteFor,
} from "../src/session-host/sidebar-theme";
import {
  ENTER,
  ESC,
  FakePeerCoordinator,
  closeWithSignal,
  createHarness,
  makeMainTestDirectory,
  nextTurn,
  plain,
  ready,
  type Harness,
} from "./helpers/session-host-main-harness";
import { remotePeerHost, remoteRosterRow } from "./helpers/session-host-main-remote";

const DOWN = "\x1b[B";
const SGR = /\x1b\[([0-9;]*)m/g;

/** The two owner hosts this roster is made of, in DTO order. */
const ALPHA = "Alpha remote";
const BETA = "Beta remote";
const ALPHA_HOST = "Lab Alpha";
const BETA_HOST = "Lab Beta";

/** A remote-only roster DTO: two paired owners, one row each, no local session. */
function remoteOnlySnapshotHosts(): PeerUiSnapshot["hosts"] {
  return [
    remotePeerHost({
      id: "lab-a",
      label: ALPHA_HOST,
      hostRunId: "run-alpha",
      rows: [remoteRosterRow({ id: "row-a", label: ALPHA, workspace: "/remote/ws/alpha" })],
    }),
    remotePeerHost({
      id: "lab-b",
      label: BETA_HOST,
      hostRunId: "run-beta",
      rows: [remoteRosterRow({ id: "row-b", label: BETA, workspace: "/remote/ws/beta" })],
    }),
  ] as unknown as PeerUiSnapshot["hosts"];
}

/** One synthetic native agent directory, exactly as Main sees one. */
function ownedAgentDir(): string {
  const dir = makeMainTestDirectory("remote-only-settings-agent");
  writeFileSync(join(dir, "keybindings.json"), "{}", "utf8");
  return dir;
}

interface RemoteOnlyMain {
  harness: Harness;
  peer: FakePeerCoordinator;
  /** Every action Main's own sidebar handler received, in order. */
  actions: SidebarAction[];
}

/**
 * One real Main run over `agentDir` whose coordinator publishes ONLY remote
 * owner rows. The fake manager is never asked to create anything, so a local
 * child, a session restart, or a per-child write would be a visible change.
 */
async function remoteOnlyMain(agentDir: string): Promise<RemoteOnlyMain> {
  const peer = new FakePeerCoordinator();
  peer.snapshot = { ...peer.snapshot, hosts: remoteOnlySnapshotHosts() };
  const actions: SidebarAction[] = [];
  const controllers: SidebarController[] = [];
  const harness = createHarness({}, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("the synthetic harness prepares no profile"); } },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({ status: "opened", state: {
      agentDir: ownedDir, hostId, ownershipPath: join(ownedDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    createSidebar: (options) => {
      if (!options?.onAction) throw new Error("Main did not supply a sidebar handler");
      const mainHandler = options.onAction;
      // Wrap Main's own handler; the controller and its written render maps stay
      // exactly the production ones, so the recorded actions are the real ones.
      const controller = new SidebarController({
        ...options,
        onAction: (action: SidebarAction) => { actions.push(action); mainHandler(action); },
      });
      controllers.push(controller);
      return controller;
    },
    createPeerCoordinator: (options) => { peer.options = options; return peer; },
  });
  await ready(harness);
  await nextTurn();
  const controller = controllers[0];
  assert.ok(controller, "capture Main's actual controller, not a detached fixture");
  harness.sidebar = controller;
  assert.ok(peer.options, "network coordinator is owned under the acquired native agent directory");
  return { harness, peer, actions };
}

function lastFrame(harness: Harness): ComposedHostFrame | undefined {
  return harness.writer.frames.at(-1)?.frame;
}

function frameText(harness: Harness): string {
  return plain(lastFrame(harness));
}

function rawFrameText(harness: Harness): string {
  return lastFrame(harness)?.lines.join("\n") ?? "";
}

function frameLines(harness: Harness): string[] {
  return frameText(harness).split("\n");
}

function sgrCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(SGR)) codes.add(match[1] ?? "");
  return codes;
}

/** True when the LAST written frame draws `label` as its highlighted row. */
function highlighted(harness: Harness, label: string): boolean {
  return frameLines(harness).some((line) => line.includes(`> ${label}`));
}

async function moveTo(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step <= 24; step += 1) {
    if (highlighted(harness, label)) return;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  assert.fail(`the written host never highlighted a ${JSON.stringify(label)} row:\n${frameText(harness)}`);
}

/** roster -> the ONE grouped Settings row -> Enter. */
async function openSettingsMenu(harness: Harness): Promise<void> {
  await moveTo(harness, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.ok(highlighted(harness, "Theme"),
    `the grouped Settings submenu did not open with Theme first:\n${frameText(harness)}`);
}

/** One submenu entry -> Enter. */
async function openSettingsEntry(harness: Harness, label: string): Promise<void> {
  await moveTo(harness, label);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
}

/** The roster projection this written frame draws for the two remote cards. */
function remoteProjection(harness: Harness): string[] {
  // The wide layout draws the roster in its own pane followed by a divider; the
  // card text is everything left of it, so the projection never depends on the
  // right-hand slot's current content.
  return frameLines(harness)
    .filter((line) => line.includes(ALPHA) || line.includes(BETA)
      || line.includes(ALPHA_HOST) || line.includes(BETA_HOST))
    .map((line) => line.split("\u2502")[0]!.trimEnd());
}

/** Every action type except the one this gesture is allowed to emit. */
function otherActionTypes(actions: readonly SidebarAction[], allowed: string): string[] {
  return actions.filter((action) => action.type !== allowed).map((action) => action.type);
}

/** The session-host settings scope Main owns under this agent directory. */
function hostStateEntries(agentDir: string): string[] {
  return readdirSync(join(agentDir, "session-host")).sort();
}

function agentRootEntries(agentDir: string): string[] {
  return readdirSync(agentDir).sort();
}

// ---------------------------------------------------------------------------
// 1. The host's OWN appearance under a remote-only roster
// ---------------------------------------------------------------------------

test("a remote-only roster saves and reloads the host's own theme with no local child and no session side effect", async () => {
  const agentDir = ownedAgentDir();
  try {
    const { harness, peer, actions } = await remoteOnlyMain(agentDir);
    const manager = harness.manager;
    assert.ok(manager, "the synthetic manager is open after preflight");

    // The roster really is remote-only: no local row, no create, no spawn.
    assert.equal(manager.views.length, 0, "no local session row exists in this host");
    assert.equal(manager.createOptions.length, 0, "no session manager create was ever asked for");
    assert.equal(manager.spawnCount, 0, "no child was ever started");
    assert.equal(manager.writes.length, 0, "nothing was ever written to a child");
    assert.match(frameText(harness), /Sessions \(0\)/, "the local roster count stays honest");
    assert.equal(frameLines(harness).filter((line) => line.includes("> Network")
      || line.includes("> Host shortcuts")).length, 0,
    "#613: Network and Host shortcuts are Settings submenus, never roster rows");

    // Both owner cards are drawn, in DTO order, each naming its own owner host.
    const projected = remoteProjection(harness);
    assert.deepEqual(projected, [
      ALPHA,
      `  host ${ALPHA_HOST}`,
      BETA,
      `  host ${BETA_HOST}`,
    ], `the remote-only roster projects both owner cards with their host lines:\n${frameText(harness)}`);

    // Startup selects the default without writing anything of its own.
    assert.equal(harness.sidebar?.currentTheme, DEFAULT_SIDEBAR_THEME);
    assert.equal(existsSync(appearancePath(agentDir)), false,
      "a remote-only host still selects the default without creating a file");
    assert.deepEqual(hostStateEntries(agentDir), [], "startup wrote no session-host settings");

    // The roster exactly as drawn with the grouped Settings row highlighted.
    await moveTo(harness, "Settings");
    const rosterBefore = frameText(harness);
    assert.ok(highlighted(harness, "Settings"), "the grouped Settings row is a roster row like any other");
    const createsBefore = manager.createOptions.length;
    const writesBefore = manager.writes.length;
    const commandsBefore = peer.commands.length;
    const decisionsBefore = peer.decisions.length;
    const selectionBefore = harness.sidebar?.selectedId;
    const ownerKeyBefore = harness.sidebar?.activeMainOwnerKey;

    // Choose Light through the real Settings -> Theme pane and real keystrokes.
    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Theme");
    assert.equal(harness.sidebar?.focus, "form", "the Theme pane owns the right-hand slot");
    assert.match(frameText(harness), /Dark \(current\)/);
    assert.match(frameText(harness), /Host sidebar only/, "the pane states its own scope");
    assert.match(frameText(harness), /Saved for this native Pi agent/);
    // The remote cards keep their place while the pane is open.
    assert.deepEqual(remoteProjection(harness), projected, "the open Theme pane redraws the same remote cards");

    await moveTo(harness, "Light");
    harness.terminal.emitInput(ENTER);
    await nextTurn();

    // Live: the host's own palette changed, in the frame Main actually wrote.
    assert.equal(harness.sidebar?.currentTheme, "light",
      "the palette changes only after Main reports a successful save");
    assert.match(frameText(harness), /Light \(current\)/,
      "the applied choice is stated in text, not color alone");
    const codes = sgrCodes(rawFrameText(harness));
    assert.ok(codes.has(sidebarPaletteFor("light").selected), "the live palette is the light one");
    assert.equal(codes.has(sidebarPaletteFor("dark").header), false, "the dark-only header sequence is gone");
    for (const code of codes) {
      assert.ok(SIDEBAR_THEME_SGR_CODES.has(code) || SIDEBAR_GENERATED_SGR_ALLOWLIST.has(code),
        `every generated sequence stays inside the closed palette set: ${code}`);
    }

    // Persisted: exactly the host's own versioned record, in its own file.
    assert.deepEqual(JSON.parse(readFileSync(appearancePath(agentDir), "utf8")),
      { version: 1, theme: "light" });
    assert.equal(readAppearanceConfig(agentDir).status, "loaded");
    assert.deepEqual(hostStateEntries(agentDir), ["appearance.json"],
      "the theme is the only session-host setting this gesture wrote");

    // No Pi configuration and no child side effect anywhere.
    assert.deepEqual(agentRootEntries(agentDir), ["keybindings.json", "session-host"],
      "no Pi settings, model, or session file was created under the native agent directory");
    assert.equal(readFileSync(join(agentDir, "keybindings.json"), "utf8"), "{}",
      "Pi's own keybindings file is byte-identical");
    assert.deepEqual(otherActionTypes(actions, "theme-save"), [],
      `the theme gesture emitted only its own host-owned save:\n${JSON.stringify(actions)}`);
    assert.equal(actions.length, 1, "the whole gesture emitted exactly one action");
    const themeSave = actions[0];
    assert.ok(themeSave && themeSave.type === "theme-save" && themeSave.theme === "light",
      "the one emitted intent names the chosen appearance and nothing else");
    assert.equal(peer.commands.length, commandsBefore, "the theme gesture sent no network command");
    assert.equal(peer.decisions.length, decisionsBefore, "and confirmed or denied nothing");
    assert.equal(peer.closeCalls, 0, "no network resource was closed or restarted");
    assert.equal(manager.createOptions.length, createsBefore, "no local Pi child was created");
    assert.equal(manager.writes.length, writesBefore, "no keystroke reached a native child");
    assert.equal(manager.renameCalls.length, 0, "no session was renamed");
    assert.equal(manager.closeExitedCalls.length, 0, "no row was retired");
    assert.equal(manager.shutdownCalls, 0, "no session manager shutdown happened");
    assert.equal(manager.disposeCalls, 0, "no session manager dispose happened");
    assert.equal(manager.views.length, 0, "the roster is still remote-only");

    // Back through the Settings menu to the roster.
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "Escape returns to the Settings menu that opened it");
    assert.match(frameText(harness), /Theme/);
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar", "leaving Settings closes to the roster");
    assert.equal(harness.sidebar?.visible, true, "closing a submenu never hides the sidebar");

    // Remote identity, order, host routing, selection, and focus are exactly
    // what they were before the deliberate menu navigation.
    assert.equal(frameText(harness), rosterBefore,
      "the roster Main writes after the theme gesture is textually identical to the one before it");
    assert.deepEqual(remoteProjection(harness), projected);
    assert.equal(harness.sidebar?.selectedId, selectionBefore, "no local row became selected");
    assert.deepEqual(harness.sidebar?.activeMainOwnerKey, ownerKeyBefore,
      "the theme gesture never claimed or changed Main's content owner");
    assert.equal(harness.sidebar?.savedPickerRequestId, undefined, "no Saved picker was opened");
    assert.equal(peer.commands.length, commandsBefore);

    assert.equal(await closeWithSignal(harness), 0, "the host closed cleanly");

    // A second real Main over the same synthetic agent directory and the same
    // remote-only snapshot reloads the host's own selection.
    const second = await remoteOnlyMain(agentDir);
    try {
      assert.equal(second.peer.options?.agentDir, agentDir,
        "the reopened host owns the same synthetic native agent directory");
      const secondManager = second.harness.manager;
      assert.ok(secondManager);
      assert.equal(second.harness.sidebar?.currentTheme, "light",
        "a fresh host over the same native agent directory reloads its own choice");
      const secondCodes = sgrCodes(rawFrameText(second.harness));
      assert.ok(secondCodes.has(sidebarPaletteFor("light").selected),
        "the reloaded host draws the light palette from its first frame");
      assert.equal(secondCodes.has(sidebarPaletteFor("dark").header), false);
      assert.deepEqual(remoteProjection(second.harness), projected,
        "the reloaded roster is the same remote-only projection");
      assert.match(frameText(second.harness), /Sessions \(0\)/);
      assert.equal(secondManager.views.length, 0, "the reloaded host started no local child");
      assert.equal(secondManager.createOptions.length, 0);
      assert.equal(secondManager.spawnCount, 0);
      assert.equal(secondManager.writes.length, 0);
      assert.equal(second.peer.commands.length, 0, "a reload sends no network command");
      assert.deepEqual(JSON.parse(readFileSync(appearancePath(agentDir), "utf8")),
        { version: 1, theme: "light" }, "the reload reads the record, it does not rewrite or invent one");
      assert.deepEqual(hostStateEntries(agentDir), ["appearance.json"]);
      assert.equal(await closeWithSignal(second.harness), 0);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  } catch (error) {
    // A failed fixture must not leave its owned synthetic agent directory behind.
    rmSync(agentDir, { recursive: true, force: true });
    throw error;
  }
});

// ---------------------------------------------------------------------------
// 2. The grouped Settings -> Network route
// ---------------------------------------------------------------------------

test("Settings -> Network sends exactly one existing bell preference command and returns through Settings", async () => {
  const agentDir = ownedAgentDir();
  try {
    const { harness, peer, actions } = await remoteOnlyMain(agentDir);
    const manager = harness.manager;
    assert.ok(manager);
    const settingsBefore = { ...peer.snapshot.settings! };
    const hostsBefore = peer.snapshot.hosts;
    const listenerBefore = { ...peer.snapshot.listener };

    await moveTo(harness, "Settings");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.match(frameText(harness), /Theme/);
    assert.match(frameText(harness), /Network/);
    assert.match(frameText(harness), /Host shortcuts/);
    assert.equal(peer.commands.length, 0, "opening the menu sends nothing");

    await openSettingsEntry(harness, "Network");
    assert.equal(harness.sidebar?.focus, "form", "the existing Network pane owns the right-hand slot");
    assert.match(frameText(harness), /Network/, "the Network pane is the pane that already existed");
    assert.match(frameText(harness), /Incoming bell: on/, "the drawn bell state is the coordinator's default");
    assert.equal(peer.commands.length, 0, "reaching the pane through Settings sends no command");

    // One deliberate press on the ordinary, harmless preference row.
    await moveTo(harness, "Incoming bell:");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    await nextTurn();

    assert.deepEqual(peer.commands, [{ type: "peer-bell", enabled: false }],
      "the pane's existing row emits its exact existing command exactly once");
    assert.deepEqual(otherActionTypes(actions, "peer-bell"), [],
      `the grouped route emitted only that one preference intent:\n${JSON.stringify(actions)}`);
    assert.equal(actions.length, 1, "the whole grouped gesture emitted exactly one action");
    assert.match(frameText(harness), /Bell change requested/,
      `the pane reports its own request where the operator pressed:\n${frameText(harness)}`);
    assert.match(frameText(harness), /Incoming bell: on/,
      "the drawn state stays the coordinator's until the coordinator reports otherwise");

    // No consent, connection, create, selection, routing, or lifecycle change.
    assert.equal(peer.decisions.length, 0, "no pairing or consent decision was made");
    assert.equal(peer.snapshot.consents.length, 0, "no consent arrived");
    assert.deepEqual(peer.snapshot.settings, settingsBefore,
      "the fake coordinator's saved settings are untouched by the forwarded intent");
    assert.deepEqual(peer.snapshot.listener, listenerBefore, "no listener started or stopped");
    assert.equal(peer.snapshot.hosts, hostsBefore, "no destination was added, removed, connected, or disconnected");
    assert.equal(peer.closeCalls, 0, "no network resource was closed");
    assert.equal(manager.views.length, 0, "no local session row appeared");
    assert.equal(manager.createOptions.length, 0, "no local Pi child was created");
    assert.equal(manager.writes.length, 0, "nothing was written to a child");
    assert.equal(manager.shutdownCalls, 0, "no session was restarted");
    assert.equal(harness.sidebar?.selectedId, undefined, "no roster row was selected");
    assert.equal(harness.sidebar?.activeMainOwnerKey, undefined, "Main's content owner was not claimed");
    assert.equal(harness.sidebar?.savedPickerRequestId, undefined, "no Saved picker was opened");
    assert.equal(existsSync(appearancePath(agentDir)), false,
      "the Network route writes nothing to the host's appearance record");

    // Back through the Settings menu, then close.
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "Escape returns to the Settings menu that opened it");
    assert.match(frameText(harness), /Theme/);
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar", "leaving Settings closes to the roster");
    assert.equal(harness.sidebar?.visible, true, "closing a submenu never hides the sidebar");
    assert.deepEqual(remoteProjection(harness), [
      ALPHA,
      `  host ${ALPHA_HOST}`,
      BETA,
      `  host ${BETA_HOST}`,
    ], "the remote-only roster is intact after the grouped route");
    assert.equal(peer.commands.length, 1, "leaving the pane sent nothing further");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
