/**
 * Pure frontend regressions for the exited-row deliberate restart intent
 * (resume-row) in SidebarController: Enter on a completely drawn exited card
 * asks the backend to restart that exact row, stays in the sidebar, and is
 * fenced by navigation, hiding, backend selection, a removed/rebound target,
 * wrong request ids, and a held/released key. Also pins the narrow successful
 * replacement fence: the backend removing the old exited placeholder after its
 * replacement child started must not read that one removal as the user's
 * highlight vanishing, while ordinary vanished-row safety is unchanged.
 *
 * Everything here is pure frontend: no process, PTY, filesystem, config, or
 * Git work. Real pinned pi-tui key matching is used for the Kitty packets.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  isKittyProtocolActive,
  setKittyProtocolActive,
  visibleWidth,
} from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
} from "../src/session-host/sidebar";

const SGR = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";
const KITTY_ENTER_RELEASE = "\x1b[13;1:3u";

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
  since(): SidebarAction[];
  focused(): SidebarAction[];
}

function makeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: `label-${overrides.id}`,
    workspace: `/ws/${overrides.id}`,
    agentDir: `/agents/${overrides.id}`,
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: false,
    activity: [],
    ...overrides,
  };
}

function exitedItem(id: string): SidebarItem {
  return makeItem({
    id,
    lifecycle: "exited",
    hasLiveProcess: false,
    busy: null,
    pendingInput: null,
    nativeSession: { sessionId: `session-${id}`, epoch: 1, name: `Old ${id}` },
  });
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
    since: () => actions.slice(harness.baseline),
    focused: () => actions.slice(harness.baseline).filter((action) => action.type !== "forward"),
  };
  return harness;
}

function assertPaneSafe(lines: string[], cols: number): string[] {
  for (const line of lines) {
    for (const sgr of line.match(SGR) ?? []) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `row wider than pane: ${visibleWidth(text)} > ${cols}`);
  }
  return lines;
}

/** Renders the focused pane and returns sanitized text lines. */
function view(harness: Harness, cols = 40, rows = 30): string[] {
  return assertPaneSafe(harness.controller.render(cols, rows).lines, cols).map((line) => line.replace(SGR, ""));
}

/**
 * A visible sidebar holding exactly one exited row, with that row highlighted
 * and completely drawn by the last roster render. Ready for a deliberate
 * Enter; the action baseline is taken after setup.
 */
function exitedRowHarness(id = "old", options: SidebarControllerOptions = {}): Harness {
  const harness = makeController({ initialVisible: false, ...options });
  harness.controller.updateItems([exitedItem(id)]);
  harness.send(ALT_LEFT); // hidden -> show and focus the roster
  assert.equal(harness.controller.focus, "sidebar");
  harness.send(UP); // New session -> Saved conversations
  harness.send(UP); // Saved conversations -> the exited row
  assert.equal(harness.controller.selectedId, id);
  view(harness); // draw the whole row so Enter is allowed
  harness.baseline = harness.actions.length;
  return harness;
}

function resumeRequest(harness: Harness): { requestId: number; id: string } {
  const action = harness.focused().find((candidate) => candidate.type === "resume-row");
  assert.ok(action !== undefined && action.type === "resume-row", `expected resume-row, got ${JSON.stringify(harness.focused())}`);
  return { requestId: action.requestId, id: action.id };
}

// ---------------------------------------------------------------------------
// Deliberate Enter on a drawn exited row
// ---------------------------------------------------------------------------

test("Enter on a fully drawn exited card emits resume-row and stays in the sidebar", () => {
  const harness = exitedRowHarness("old");
  harness.send(ENTER);
  const request = resumeRequest(harness);
  assert.equal(request.id, "old");
  assert.deepEqual(harness.focused(), [{ type: "resume-row", requestId: request.requestId, id: "old" }],
    "exactly one resume request, never a select for an exited row");
  assert.equal(harness.controller.focus, "sidebar", "the picker keeps input ownership while the restart is prepared");
  assert.equal(harness.controller.visible, true);
  assert.ok(view(harness).join(" ").includes("Opening this conversation"), "a truthful bounded notice is shown");
});

test("a held or released Enter on an exited card emits nothing", () => {
  const harness = exitedRowHarness("old");
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    harness.send(KITTY_ENTER_REPEAT);
    harness.send(KITTY_ENTER_RELEASE);
  } finally {
    setKittyProtocolActive(previous);
  }
  assert.deepEqual(harness.focused(), [], "repeat/release never starts a restart");
});

test("Enter on an exited row that the last render could not show is refused", () => {
  const harness = exitedRowHarness("old");
  // A too-small render records that no entry is drawn.
  assert.ok(view(harness, 40, 8).some((line) => line.includes("too small")));
  harness.send(ENTER);
  harness.send(ENTER);
  assert.deepEqual(harness.focused(), [], "an invisible exited card is never restarted");
});

test("a second Enter while a restart is pending is refused, and navigation cancels it", () => {
  const harness = exitedRowHarness("old");
  harness.send(ENTER);
  const request = resumeRequest(harness);
  harness.send(ENTER);
  assert.deepEqual(harness.focused(), [{ type: "resume-row", requestId: request.requestId, id: "old" }],
    "no duplicate restart request while one is pending");
  assert.ok(view(harness).join(" ").includes("already starting"), "the refusal is a bounded notice");
  harness.send(DOWN); // navigate away
  assert.deepEqual(harness.focused().at(-1), { type: "resume-row-cancel", requestId: request.requestId });
});

// ---------------------------------------------------------------------------
// completeRowResume: only the still-current deliberate intent activates
// ---------------------------------------------------------------------------

test("completeRowResume activates the new child only for the still-current deliberate intent", () => {
  const harness = exitedRowHarness("old");
  harness.controller.updateItems([
    exitedItem("old"),
    makeItem({ id: "replacement", lifecycle: "alive", hasLiveProcess: true }),
  ]);
  view(harness); // the new roster must be drawn before Enter is allowed
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  const activated = harness.controller.completeRowResume(request.requestId, "old", "replacement");
  assert.equal(activated, true);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, "replacement");
  assert.deepEqual(harness.focused().at(-1), { type: "select", id: "replacement" });
});

test("completeRowResume ignores a wrong request id and requires the exact old binding", () => {
  const harness = exitedRowHarness("old");
  harness.controller.updateItems([
    exitedItem("old"),
    makeItem({ id: "replacement", lifecycle: "alive", hasLiveProcess: true }),
  ]);
  view(harness); // draw the two-entry roster before Enter
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  assert.equal(harness.controller.completeRowResume(request.requestId + 999, "old", "replacement"), false,
    "a stale request id never activates");
  assert.equal(harness.controller.completeRowResume(request.requestId, "other", "replacement"), false,
    "a mismatched old id never activates");
  assert.deepEqual(harness.focused().filter((action) => action.type === "select"), []);
  harness.send(ENTER);
  assert.deepEqual(harness.focused().filter((action) => action.type === "resume-row").length, 1,
    "the original pending intent is untouched by stale completions");
  assert.equal(harness.controller.completeRowResume(request.requestId, "old", "replacement"), true);
});

test("completeRowResume refuses after hiding and preserves focus and visibility", () => {
  const harness = exitedRowHarness("old");
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  harness.send(ALT_LEFT); // visible sidebar focus -> hide, return to main
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.completeRowResume(request.requestId, "old", "new"), false);
  assert.equal(harness.controller.visible, false, "activation never reshows a hidden pane");
  assert.equal(harness.controller.focus, "main");
});

test("completeRowResume refuses after a backend selection supersedes the intent", () => {
  const harness = exitedRowHarness("old");
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  harness.controller.select("somewhere-else");
  assert.deepEqual(harness.focused().at(-1), { type: "resume-row-cancel", requestId: request.requestId });
  assert.equal(harness.controller.completeRowResume(request.requestId, "old", "new"), false);
  assert.equal(harness.controller.focus, "sidebar");
});

test("completeRowResume refuses when the old placeholder vanished before completion", () => {
  const harness = exitedRowHarness("old");
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  harness.controller.updateItems([makeItem({ id: "replacement", lifecycle: "alive", hasLiveProcess: true })]);
  assert.deepEqual(harness.focused().at(-1), { type: "resume-row-cancel", requestId: request.requestId },
    "the vanished target cancels the pending intent");
  assert.equal(harness.controller.completeRowResume(request.requestId, "old", "replacement"), false);
  assert.equal(harness.controller.focus, "sidebar");
});

test("completeRowResume refuses a replacement that is not an actual live child", () => {
  const replacements: SidebarItem[] = [
    makeItem({ id: "replacement", lifecycle: "exited", hasLiveProcess: false, busy: null, pendingInput: null }),
    makeItem({ id: "replacement", lifecycle: "starting", hasLiveProcess: false, busy: null, pendingInput: null }),
    makeItem({ id: "replacement", lifecycle: "error", hasLiveProcess: false, busy: null, pendingInput: null }),
    makeItem({ id: "replacement", lifecycle: "alive" }), // alive badge without a confirmed owned process
  ];
  for (const replacement of replacements) {
    const harness = exitedRowHarness("old");
    harness.controller.updateItems([exitedItem("old"), replacement]);
    view(harness); // draw the two-entry roster before Enter
    harness.baseline = harness.actions.length;
    harness.send(ENTER);
    const request = resumeRequest(harness);
    assert.equal(
      harness.controller.completeRowResume(request.requestId, "old", "replacement"),
      false,
      `a ${replacement.lifecycle}${replacement.hasLiveProcess === true ? "" : "/non-live"} replacement never completes`,
    );
    assert.deepEqual(
      harness.focused().filter((action) => action.type === "select"),
      [],
      "a non-live replacement never emits select",
    );
    assert.equal(harness.controller.focus, "sidebar", "a non-live replacement never transfers focus");
    assert.equal(harness.controller.selectedId, "old", "the old exited row stays highlighted");
  }
});

// ---------------------------------------------------------------------------
// failRowResume fences by request id
// ---------------------------------------------------------------------------

test("failRowResume notices only its own request id and keeps the exited row", () => {
  const harness = exitedRowHarness("old");
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  const request = resumeRequest(harness);
  harness.controller.failRowResume(request.requestId + 1, "stale failure");
  assert.ok(!view(harness).join(" ").includes("stale failure"), "a stale failure is fenced");
  harness.controller.failRowResume(request.requestId, "This session could not be restarted; the previous row was kept.");
  assert.equal(harness.controller.items.map((item) => item.id).join(","), "old", "the exited placeholder is kept");
  assert.ok(view(harness).join(" ").includes("could not be restarted"));
});

// ---------------------------------------------------------------------------
// Successful-replacement removal fence versus ordinary vanished-row safety
// ---------------------------------------------------------------------------

test("a successful replacement removal does not steal focus from a hidden main pane", () => {
  const harness = makeController({ initialVisible: true });
  harness.controller.updateItems([exitedItem("old")]);
  harness.controller.select("old");
  harness.send(ALT_LEFT); // hide -> focus main with the exited row still highlighted
  assert.equal(harness.controller.visible, false);
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, "old");
  harness.baseline = harness.actions.length;
  harness.controller.noteRowReplacement("old");
  harness.controller.updateItems([]); // the backend removed the replaced placeholder
  assert.equal(harness.controller.visible, false, "the replacement removal must not reshow the picker");
  assert.equal(harness.controller.focus, "main");
  assert.equal(harness.controller.selectedId, undefined);
  assert.deepEqual(harness.focused(), [], "no visibility action for a fenced replacement removal");
});

test("ordinary vanished-row safety is unchanged without the fence", () => {
  const harness = makeController({ initialVisible: true });
  harness.controller.updateItems([exitedItem("gone")]);
  harness.controller.select("gone");
  harness.send(ALT_LEFT); // hide
  harness.baseline = harness.actions.length;
  harness.controller.updateItems([]);
  assert.equal(harness.controller.visible, true, "a vanished highlight still reshows the picker");
  assert.equal(harness.controller.focus, "sidebar");
  assert.deepEqual(harness.focused(), [{ type: "visibility", visible: true }]);
});

test("the replacement fence is scoped to exactly its row", () => {
  const harness = makeController({ initialVisible: true });
  harness.controller.updateItems([exitedItem("replaced"), exitedItem("gone")]);
  harness.controller.select("gone");
  harness.send(ALT_LEFT); // hide
  harness.controller.noteRowReplacement("replaced");
  harness.controller.updateItems([]); // both rows removed; the selected one was "gone"
  assert.equal(harness.controller.visible, true, "fencing another row does not mask the selected row's vanish");
  assert.equal(harness.controller.focus, "sidebar");
});

test("an open form keeps its draft across a fenced replacement removal", () => {
  const harness = makeController({
    initialVisible: true,
    workspaceBasePath: join(process.cwd(), ".pi-session-host-test-missing-workspace"),
  });
  harness.controller.updateItems([exitedItem("old")]);
  harness.controller.select("old");
  // Navigate Old -> Saved -> New and open the form, then type a draft.
  harness.send(DOWN);
  harness.send(DOWN);
  view(harness); // New must actually be drawn before a deliberate Enter can act.
  harness.send(ENTER);
  assert.equal(harness.controller.focus, "form");
  harness.send("retained draft");
  harness.controller.noteRowReplacement("old");
  harness.controller.updateItems([]);
  assert.equal(harness.controller.focus, "form", "a backend replacement removal never closes an open form");
  assert.ok(view(harness).join(" ").includes("retained draft"), "the form draft is preserved");
});

// ---------------------------------------------------------------------------
// Ordinary live-row Enter is unchanged
// ---------------------------------------------------------------------------

test("Enter on a live row still selects it and transfers input ownership", () => {
  const harness = makeController({ initialVisible: true });
  harness.controller.updateItems([makeItem({ id: "live", hasLiveProcess: true })]);
  harness.controller.select("live");
  view(harness);
  harness.baseline = harness.actions.length;
  harness.send(ENTER);
  assert.deepEqual(harness.focused(), [{ type: "select", id: "live" }]);
  assert.equal(harness.controller.focus, "main");
  harness.send("x");
  assert.deepEqual(harness.since().at(-1), { type: "forward", data: "x" });
});
