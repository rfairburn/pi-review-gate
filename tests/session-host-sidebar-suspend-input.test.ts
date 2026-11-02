/**
 * Sidebar Ctrl+Z must never reach a hosted child (#566).
 *
 * These cases drive the production Main input route end to end inside the host:
 * terminal packet -> `Sidebar` Main-focus forward action -> Main owner routing
 * (`routeForward`) -> the shared child translator -> `manager.write`. They prove
 * the suspend keystroke is refused before any child write in every applicable
 * encoding, and that drafts, ordinary input/editing, focus routing, and the row
 * lifecycle are untouched.
 *
 * These fixtures are the shared Main harness fakes: no real process, PTY, or
 * job control is involved. The real POSIX PTY evidence for the same boundary
 * lives in `tests/session-host-instances.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  closeWithSignal,
  createHarness,
  fillForm,
  nextTurn,
  ready,
  type FakeManager,
  type Harness,
} from "./helpers/session-host-main-harness";

const CSI = "\x1b[";

/** One keystroke, in every applicable terminal spelling. */
const SUSPEND_PACKETS: readonly string[] = [
  "\x1a",              // legacy raw Ctrl+Z byte
  `${CSI}122;5u`,      // Kitty CSI-u press
  `${CSI}90;5u`,       // shifted-Z identity with Ctrl
  `${CSI}122;6u`,      // Ctrl+Shift+Z
  `${CSI}122;7u`,      // Ctrl+Alt+Z (legacy output would carry the raw byte)
  `${CSI}27;5;122~`,   // xterm modifyOtherKeys spelling
  `${CSI}122;5:2u`,    // held repeat
  `${CSI}122;5:3u`,    // release
  `${CSI}1103::122;5u`,   // non-Latin primary over a z base-layout key
  `${CSI}1103::122;5:2u`, // its held repeat
  `${CSI}1103::122;7u`,   // Ctrl+Alt spelling of the same identity
  `${CSI}51::122;5u`,     // digit primary: the binding matcher names this ctrl+z too
  `${CSI}51::122;5:2u`,   // its held repeat
  `${CSI}51::122;5:3u`,   // its release
];

async function hostedMainSession(): Promise<{ harness: Harness; manager: FakeManager }> {
  const harness = createHarness();
  const manager = await ready(harness);
  fillForm(harness.terminal, "/suspend/draft");
  await nextTurn();
  assert.ok(manager.surface("native-1"), "the hosted row owns a surface");
  return { harness, manager };
}

test("the Main-focus route forwards a draft but refuses Ctrl+Z in every spelling", async () => {
  const { harness, manager } = await hostedMainSession();
  const draft = "fix the parser";
  for (const char of draft) harness.terminal.emitInput(char);
  const forwarded = () => manager.writes.map((entry) => entry.data.toString("utf8")).join("");
  assert.equal(forwarded(), draft, "the typed draft reaches the hosted child");
  assert.equal(manager.writes.every((entry) => entry.id === "native-1"), true,
    "every forwarded byte stays addressed to the one hosted row");

  const baseline = manager.writes.length;
  const framesBefore = harness.writer.frames.length;
  for (const packet of SUSPEND_PACKETS) {
    harness.terminal.emitInput(packet);
    assert.equal(manager.writes.length, baseline, `${JSON.stringify(packet)} writes nothing to the child`);
    await nextTurn();
  }
  assert.equal(manager.writes.length, baseline, "no suspend encoding reaches the child");
  assert.equal(harness.writer.frames.length, framesBefore, "refused input submits no speculative host frame");

  // Ordinary input and editing keep working with no resume or restart.
  harness.terminal.emitInput(" now");
  harness.terminal.emitInput("\x7f");
  harness.terminal.emitInput("\r");
  assert.equal(forwarded(), `${draft} now\x7f\r`, "later keystrokes still reach the same running child");

  // A remapped Latin key that merely sits on the z base-layout position is
  // ordinary input and keeps reaching the child.
  const remappedBaseline = manager.writes.length;
  harness.terminal.emitInput(`${CSI}107::122;5u`);
  assert.equal(manager.writes.length, remappedBaseline + 1, "Ctrl+K on a remapped layout is forwarded");
  assert.notEqual(manager.writes[remappedBaseline].data.toString("utf8"), "", "the forwarded keystroke is not emptied");
  assert.equal(manager.writes[remappedBaseline].id, "native-1", "it stays addressed to the same row");
  assert.equal(harness.sidebar?.focus, "main", "Main keeps input ownership");
  assert.equal(harness.sidebar?.visible, true, "the roster stays visible");
  const view = manager.views.find((row) => row.id === "native-1");
  assert.equal(view?.lifecycle, "alive", "the hosted row is never stopped by the refused keystroke");
  assert.equal(view?.hasLiveProcess, true);
  assert.equal(manager.resizeCalls.length, 0, "refused input never reconciles layout");
  assert.equal(await closeWithSignal(harness), 0, "ordinary shutdown still works");
});

test("the suspend refusal does not depend on the child's keyboard modes", async () => {
  const { harness, manager } = await hostedMainSession();
  const surface = manager.surface("native-1")!;
  for (const modes of [
    { kittyFlags: 1, modifyOtherKeys: 0 },
    { kittyFlags: 2, modifyOtherKeys: 1 },
    { kittyFlags: 7, modifyOtherKeys: 2 },
  ] as const) {
    surface.modes = { ...surface.modes, ...modes };
    manager.notify("native-input-modes");
    await nextTurn();
    const baseline = manager.writes.length;
    for (const packet of SUSPEND_PACKETS) {
      harness.terminal.emitInput(packet);
      assert.equal(manager.writes.length, baseline,
        `${JSON.stringify(packet)} stays refused with child modes ${JSON.stringify(modes)}`);
    }
    harness.terminal.emitInput("z");
    assert.deepEqual(manager.writes.slice(baseline).map((entry) => entry.data.toString("utf8")), ["z"],
      "ordinary Z still reaches a child in these modes");
  }
  assert.equal(await closeWithSignal(harness), 0);
});

test("a configured Ctrl+Z host chord stays host-owned and still writes nothing to the child", async () => {
  const harness = createHarness({}, {
    readHostShortcutConfig: () => ({
      status: "loaded",
      bindings: { toggle: "ctrl+z", returnToMain: "alt+right" },
    }),
  });
  const manager = await ready(harness);
  fillForm(harness.terminal, "/suspend/chord");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main");

  const baseline = manager.writes.length;
  harness.terminal.emitInput("\x1a");
  assert.equal(manager.writes.length, baseline, "the host chord is consumed before any child write");
  assert.equal(harness.sidebar?.focus, "sidebar", "the configured toggle still moves focus to the roster");

  // With the roster focused, the same byte is the configured chord again. It stays
  // host-owned: nothing is forwarded, and the chord still performs its toggle.
  const rosterBaseline = manager.writes.length;
  harness.terminal.emitInput("\x1a");
  assert.equal(manager.writes.length, rosterBaseline, "roster-focused suspend input is never forwarded");
  assert.equal(harness.sidebar?.visible, false, "the configured chord still hides the roster from the roster side");
  const hostedRow = manager.views.find((row) => row.id === "native-1");
  assert.equal(hostedRow?.lifecycle, "alive", "the chord never stops the hosted row");
  harness.terminal.emitInput("\x1a");
  assert.equal(manager.writes.length, rosterBaseline, "the second chord press is also never forwarded");
  await nextTurn();
  assert.equal(harness.sidebar?.visible, true, "the chord brings the roster back");

  // The return chord still hands input back to the hosted session.
  harness.terminal.emitInput("\x1b[1;3C");
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "main", "return-to-Main routing is preserved");
  harness.terminal.emitInput("still typing");
  assert.equal(manager.writes.slice(-1).map((entry) => entry.data.toString("utf8")).join(""), "still typing",
    "the hosted session keeps receiving ordinary keystrokes");
  assert.equal(await closeWithSignal(harness), 0);
});
