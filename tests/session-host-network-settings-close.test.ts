/**
 * Portable regression for the caller-side Network close chain (#613 CI follow-up).
 *
 * The native Windows Network acceptance drives the real public Main through a
 * ConPTY, and its callers had been pressing ONE Escape between the Network pane
 * and the roster. Since #613 the product routes that return through the grouped
 * Settings menu, so one Escape leaves the UI in the submenu while the caller's
 * focus bookkeeping still says sidebar: the next roster walk sees Settings already
 * selected, the Enter that follows re-opens Network, and every later receipt races
 * the wrong pane. That defect is not Windows-specific — it is the caller's
 * bookkeeping around the shared submenu — so it is pinned here against a real
 * `main.ts` run over the synthetic Main dependency seam with a synthetic peer
 * coordinator, using the SAME helper the native acceptance now uses.
 *
 * What is proven through the frames Main actually wrote:
 * - closing a Network pane that was opened through the grouped Settings row is two
 *   distinct Escape receipts, the written Settings submenu (with the Network row
 *   still carried) and then a complete sidebar-focused roster frame with the
 *   Settings row selected;
 * - the caller's focus record agrees with the host's own focus after the close, so
 *   the same Settings -> Network key path reopens and the next roster walk selects
 *   the Quit row, whose Enter makes Main emit its own quit and exit;
 * - the whole gesture activates no network command, no consent decision, no child
 *   session, and no write to a child.
 *
 * Truthful scope: no ConPTY, no Windows host, no real peer, listener, transport,
 * or native child is involved, and no native Windows evidence is claimed here. The
 * native Windows proof remains the opted-in companion in
 * `session-host-native-windows-network.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENTER,
  closeWithSignal,
  nextTurn,
  peerMainHarness,
  plain,
  type Harness,
} from "./helpers/session-host-main-harness";
import {
  parseRosterFrame,
  selectedRosterEntry,
  SIDEBAR_COLUMNS,
} from "./helpers/session-host-native-roster-witness";
import {
  closeNetworkThroughSettings,
  contentPaneHighlight,
  contentPaneText,
  rosterReturnReceipt,
  settingsSubmenuOnScreen,
  type NetworkPaneNavigator,
  type PaneFocus,
} from "./helpers/session-host-network-settings-return";

const DOWN = "\x1b[B";

/**
 * Exactly the three operations the shared close helper needs, adapted to the
 * synthetic Main harness: one key write awaited against the next frame Main
 * actually wrote, the latest written frame, and the caller's own focus record. No
 * production seam is added for this test.
 */
class MainHarnessNavigator implements NetworkPaneNavigator {
  focus: PaneFocus = "sidebar";
  private readonly harness: Harness;

  constructor(harness: Harness) {
    this.harness = harness;
  }

  currentText(): string {
    return plain(this.harness.writer.frames.at(-1)?.frame);
  }

  async sendKeys(data: string, description: string, predicate: (frame: string) => boolean): Promise<void> {
    const writtenBefore = this.harness.writer.frames.length;
    this.harness.terminal.emitInput(data);
    for (let turn = 0; turn < 4; turn += 1) {
      await nextTurn();
      if (this.harness.writer.frames.length > writtenBefore && predicate(this.currentText())) return;
    }
    assert.fail(`${description}: no written frame satisfied the receipt\n${this.currentText()}`);
  }
}

/** The driver's roster walk: one Down per receipt, until the written selection is `label`. */
async function moveRosterTo(driver: MainHarnessNavigator, label: string, step: string): Promise<void> {
  for (let presses = 0; presses < 8; presses += 1) {
    const selected = selectedRosterEntry(driver.currentText(), SIDEBAR_COLUMNS)?.label;
    if (selected === label) return;
    assert.ok(selected, `${step}: the written roster exposes a selected row\n${driver.currentText()}`);
    await driver.sendKeys(DOWN, `${step}: roster selection advances from ${selected}`,
      (frame) => selectedRosterEntry(frame, SIDEBAR_COLUMNS)?.label !== selected);
  }
  assert.fail(`${step}: the written roster never selected ${label}\n${driver.currentText()}`);
}

/** The native acceptance's own key path: roster -> Settings -> Network. */
async function openNetworkThroughSettings(driver: MainHarnessNavigator, label: string): Promise<void> {
  await moveRosterTo(driver, "Settings", label);
  await driver.sendKeys(ENTER, `${label}: the grouped Settings submenu opens`,
    (frame) => contentPaneHighlight(frame).includes("Theme"));
  await driver.sendKeys(DOWN, `${label}: the submenu highlights Network`,
    (frame) => contentPaneHighlight(frame).includes("Network"));
  await driver.sendKeys(ENTER, `${label}: the existing Network pane opens`,
    (frame) => contentPaneText(frame).includes("Incoming bell: on"));
  driver.focus = "form";
}

test("a Network pane opened through Settings closes through Settings to the roster, then reopens and quits", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const driver = new MainHarnessNavigator(harness);
  try {
    const frame = driver.currentText();
    assert.equal(harness.sidebar?.focus, "sidebar", "Main starts with the roster owning input");
    assert.ok(parseRosterFrame(frame, SIDEBAR_COLUMNS).complete, `the written roster is complete\n${frame}`);

    for (const visit of ["first visit", "reopened visit"]) {
      await openNetworkThroughSettings(driver, visit);
      assert.equal(harness.sidebar?.focus, "form", `${visit}: the Network pane owns the content slot`);
      assert.equal(driver.focus, "form", `${visit}: the caller recorded the pane, not the roster`);
      assert.equal(settingsSubmenuOnScreen(driver.currentText()), false,
        `${visit}: the pane is drawn on its own, not above the menu`);

      await closeNetworkThroughSettings(driver, visit);
      const closed = driver.currentText();
      assert.equal(harness.sidebar?.focus, "sidebar", `${visit}: the second Escape returned the roster its focus`);
      assert.equal(driver.focus, "sidebar", `${visit}: the caller's bookkeeping matches the host`);
      assert.equal(harness.sidebar?.visible, true, `${visit}: closing the submenu never hid the sidebar`);
      assert.ok(rosterReturnReceipt(closed),
        `${visit}: the second Escape's written frame is the roster receipt\n${closed}`);
      assert.equal(selectedRosterEntry(closed, SIDEBAR_COLUMNS)?.label, "Settings",
        `${visit}: the walk resumes from the Settings row the menu was opened on\n${closed}`);
    }

    // Nothing in the open/close/reopen route touched Network or a child.
    assert.equal(peer.commands.length, 0, "no network command was ever performed");
    assert.equal(peer.decisions.length, 0, "no consent decision was made");
    assert.equal(peer.snapshot.consents.length, 0, "no consent arrived");
    assert.equal(peer.closeCalls, 0, "no network resource was closed by the navigation itself");
    const manager = harness.manager;
    assert.ok(manager, "the synthetic manager is open");
    assert.equal(manager.views.length, 0, "no local session row appeared");
    assert.equal(manager.createOptions.length, 0, "no child was created");
    assert.equal(manager.spawnCount, 0, "no child was started");
    assert.equal(manager.writes.length, 0, "nothing was written to a child");

    // The route the failing acceptance needed: after the close chain the very next
    // roster walk selects the Quit row, and Enter acts on that written row. With no
    // live row to protect, `activateQuit` emits the host's own quit immediately, so
    // the decisive proof is Main exiting on its own — a stale Settings submenu under
    // the cursor could never produce that.
    await moveRosterTo(driver, "Quit host", "quit walk");
    assert.equal(selectedRosterEntry(driver.currentText(), SIDEBAR_COLUMNS)?.label, "Quit host",
      `the walk selected the written Quit row\n${driver.currentText()}`);
    assert.equal(settingsSubmenuOnScreen(driver.currentText()), false, "no Settings row survived the walk");
    let exitCode: number | undefined;
    void harness.result.then((code) => { exitCode = code; });
    harness.terminal.emitInput(ENTER);
    for (let turn = 0; turn < 8 && exitCode === undefined; turn += 1) await nextTurn();
    assert.equal(exitCode, 0, "Enter on the written Quit row made Main exit by itself");
  } finally {
    assert.equal(await closeWithSignal(harness), 0, "Main exits cleanly");
  }
});
