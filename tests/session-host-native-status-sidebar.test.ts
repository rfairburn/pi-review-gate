/**
 * Card-level coverage for native status applicability in the SAME sidebar
 * components every row uses (issue #277 native status slice).
 *
 * Nothing here is a provider, process, transport, or filesystem test: the cards are
 * the display DTOs the manager and the roster bridge already produce. What is pinned
 * is the shared classification, for a LOCAL row and a PAIRED-OWNER remote row alike:
 *
 * - a category the observer declared unreportable renders the literal `N/A`, and a
 *   category it observed as zero renders `0`;
 * - a supported category with nothing observed still renders `unknown`, and an
 *   observer failure after good values renders `unknown` — never a stale Ready,
 *   never `N/A`, never zero;
 * - a positively observed foreground turn end displays as rest WITHOUT the
 *   background categories being invented, while the conservative stop/idle gate is
 *   untouched (`isCompleteIdle` still demands observed ownership zeros);
 * - a Pi row, and any row that carries no declaration, render byte-for-byte as
 *   before, with no new row, field, width, or colour.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarItem,
} from "../src/session-host/sidebar";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  baseline: number;
  send(data: string): void;
}

function makeController(options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    workspaceBasePath: "/prg-native-status-test-missing-workspace",
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  const harness: Harness = {
    controller,
    actions,
    baseline: 0,
    send: (data: string) => controller.handleInput(data),
  };
  return harness;
}

function rosterWith(items: SidebarItem[]): Harness {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems(items);
  harness.send(ALT_LEFT);
  assert.equal(harness.controller.focus, "sidebar");
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

/** The roster pane's text, with every generated SGR stripped and geometry checked. */
function rosterLines(harness: Harness, cols = 40, rows = 30): string[] {
  const lines = harness.controller.renderRoster(cols, rows).lines;
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`);
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `row wider than pane: ${visibleWidth(text)} > ${cols}`);
  }
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

function cardLines(texts: readonly string[], title: string): string[] {
  const start = texts.findIndex((line) => line.includes(title));
  assert.ok(start >= 0, `no drawn card titled ${JSON.stringify(title)}: ${JSON.stringify(texts)}`);
  return texts.slice(start, start + 4).map((line) => line.trimEnd());
}

function nativeItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: "Claude",
    backend: "claude",
    workspace: "/srv/app",
    agentDir: "",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    ...overrides,
  };
}

function piItem(overrides: Partial<SidebarItem> & { id: string }): SidebarItem {
  return {
    label: "Pi conversation",
    workspace: "/srv/pi",
    agentDir: "/agents/pi",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

test("a declared-unreportable category renders N/A while an observed zero renders 0", () => {
  const harness = rosterWith([
    nativeItem({
      id: "na",
      label: "Claude",
      statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
    }),
    nativeItem({
      id: "zeros",
      label: "Codex",
      backend: "codex",
      busy: false,
      pendingInput: false,
      activeTasks: 0,
      activeShells: 0,
      statusSupport: { tasks: "supported", shells: "supported" },
    }),
    nativeItem({
      id: "mixed",
      label: "Mixed",
      backend: "codex",
      activeShells: 2,
      statusSupport: { tasks: "unsupported" },
    }),
  ]);
  const texts = rosterLines(harness);

  // Declared unreportable: N/A, and never a zero or an idle claim.
  const na = cardLines(texts, "Claude").join("\n");
  assert.ok(na.includes("input N/A"), na);
  assert.ok(na.includes("bg tasks N/A | shells N/A"), na);
  assert.ok(!na.includes("bg tasks 0"), na);
  assert.ok(!na.includes("agent idle"), "nothing observed is never rendered as rest");
  assert.ok(!na.includes("shells unknown"), "a positive declaration replaces the unknown wording");

  // Observed zeros: the ordinary numbers, painted through the same banding.
  const zeros = cardLines(texts, "Codex").join("\n");
  assert.ok(zeros.includes("agent idle | input none"), zeros);
  assert.ok(zeros.includes("bg tasks 0 | shells 0"), zeros);

  // One unreportable category and one observed count, side by side.
  const mixed = cardLines(texts, "Mixed").join("\n");
  assert.ok(mixed.includes("bg tasks N/A | shells 2"), mixed);
});

test("an observer failure after good values renders unknown, never a stale Ready or N/A", () => {
  const harness = rosterWith([
    // The row's values were cleared to unknown after the observer lost track of
    // them; its capability declaration stayed.
    nativeItem({
      id: "failed",
      label: "After failure",
      busy: null,
      pendingInput: null,
      activeTasks: null,
      activeShells: null,
      activity: [],
      statusSupport: { input: "unsupported", tasks: "supported", shells: "unsupported" },
    }),
  ]);
  const card = cardLines(rosterLines(harness), "After failure").join("\n");
  assert.ok(card.includes("agent unknown | input N/A"), card);
  assert.ok(card.includes("bg tasks unknown | shells N/A"), card);
  assert.ok(!card.includes("idle"), card);
  // A supported category is never re-labelled N/A because its value went missing.
  assert.ok(!card.includes("bg tasks N/A"), card);
});

test("a positively observed foreground turn end displays without inventing background zeros", () => {
  const harness = rosterWith([
    nativeItem({
      id: "ready",
      label: "Ready native",
      busy: false,
      pendingInput: null,
      activity: ["Ready"],
      // The provider cannot report its background categories at all.
      statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
    }),
    nativeItem({
      id: "working",
      label: "Working native",
      backend: "codex",
      busy: true,
      activity: ["bash · npm test"],
      statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
    }),
  ]);
  const texts = rosterLines(harness);
  const ready = cardLines(texts, "Ready native").join("\n");
  assert.ok(ready.includes("agent idle"), ready);
  assert.ok(ready.includes("Ready"), "the observed activity line is the Ready statement");
  assert.ok(ready.includes("bg tasks N/A | shells N/A"), ready);
  const working = cardLines(texts, "Working native").join("\n");
  assert.ok(working.includes("agent running"), working);
  assert.ok(working.includes("bash · npm test"), working);
});

/* ------------------------------------------------------------------------- *
 * Native foreground Ready is composed from foreground facts only
 * ------------------------------------------------------------------------- */

/** The real Claude acquisition declaration: every category is reportable. */
const CLAUDE_SUPPORT = {
  agent: "supported",
  input: "supported",
  tasks: "supported",
  shells: "supported",
  activity: "supported",
} as const;

/** The real Codex acquisition declaration: its census categories are N/A. */
const CODEX_SUPPORT = {
  agent: "supported",
  input: "unsupported",
  tasks: "unsupported",
  shells: "unsupported",
  activity: "supported",
} as const;

test("a known idle native foreground keeps Ready beside genuine background counts or a lost count source", () => {
  const harness = rosterWith([
    nativeItem({
      id: "claude-bg",
      label: "Claude bg",
      backend: "claude",
      busy: false,
      pendingInput: false,
      activeTasks: 1,
      activeShells: 1,
      activity: ["Ready"],
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "claude-lost",
      label: "Claude lost",
      backend: "claude",
      busy: false,
      pendingInput: false,
      activeTasks: null,
      activeShells: null,
      activity: ["Ready"],
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "codex-idle",
      label: "Codex idle",
      backend: "codex",
      busy: false,
      pendingInput: null,
      activeTasks: null,
      activeShells: null,
      activity: ["Ready"],
      statusSupport: CODEX_SUPPORT,
    }),
  ]);
  const texts = rosterLines(harness, 48, 40);
  const known = cardLines(texts, "Claude bg").join("\n");
  assert.ok(known.includes("agent idle | input none"), known);
  assert.ok(known.includes("bg tasks 1 | shells 1"), `the observed counts stay truthful:\n${known}`);
  assert.ok(known.includes("Ready"), `the existing activity line is the Ready statement:\n${known}`);
  const lost = cardLines(texts, "Claude lost").join("\n");
  assert.ok(lost.includes("agent idle | input none"), lost);
  assert.ok(lost.includes("bg tasks unknown | shells unknown"),
    `a lost count source keeps both unknown cells and is never zeroed:\n${lost}`);
  assert.ok(lost.includes("Ready"), lost);
  const codex = cardLines(texts, "Codex idle").join("\n");
  assert.ok(codex.includes("agent idle | input N/A"), codex);
  assert.ok(codex.includes("bg tasks N/A | shells N/A"), codex);
  assert.ok(codex.includes("Ready"), codex);
});

test("genuine busy, pending input, and unknown foreground facts are never promoted to Ready", () => {
  const harness = rosterWith([
    nativeItem({
      id: "busy",
      label: "Native busy",
      backend: "claude",
      busy: true,
      pendingInput: false,
      activeTasks: 0,
      activeShells: 0,
      activity: ["Working"],
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "pending",
      label: "Native pending",
      backend: "claude",
      busy: false,
      pendingInput: true,
      activeTasks: 0,
      activeShells: 0,
      activity: ["Working"],
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "unknown-busy",
      label: "Unknown busy",
      backend: "claude",
      busy: null,
      pendingInput: false,
      activeTasks: 1,
      activeShells: 1,
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "unknown-busy-zero",
      label: "Unknown busy zero",
      backend: "claude",
      busy: null,
      pendingInput: false,
      activeTasks: 0,
      activeShells: 0,
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "unknown-input",
      label: "Unknown input",
      backend: "claude",
      busy: false,
      pendingInput: null,
      activeTasks: 1,
      activeShells: 1,
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "unknown-input-zero",
      label: "Unknown input zero",
      backend: "claude",
      busy: false,
      pendingInput: null,
      activeTasks: 0,
      activeShells: 0,
      statusSupport: CLAUDE_SUPPORT,
    }),
    nativeItem({
      id: "codex-unknown",
      label: "Codex unknown",
      backend: "codex",
      busy: null,
      pendingInput: null,
      activeTasks: null,
      activeShells: null,
      statusSupport: CODEX_SUPPORT,
    }),
  ]);
  const texts = rosterLines(harness, 48, 52);
  const busy = cardLines(texts, "Native busy").join("\n");
  assert.ok(busy.includes("agent running | input none"), busy);
  assert.ok(!busy.includes("agent idle"), busy);
  const pending = cardLines(texts, "Native pending").join("\n");
  assert.ok(pending.includes("agent waiting | input pending"), pending);
  assert.ok(!pending.includes("agent idle"), pending);
  // Unknown foreground facts are never promoted to Ready, and their existing
  // count-based reading is untouched.
  const unknownBusy = cardLines(texts, "Unknown busy").join("\n");
  assert.ok(unknownBusy.includes("agent running | input none"), unknownBusy);
  assert.ok(!unknownBusy.includes("agent idle"), unknownBusy);
  assert.ok(unknownBusy.includes("bg tasks 1 | shells 1"),
    "a background count keeps its existing display reading here");
  const unknownBusyZero = cardLines(texts, "Unknown busy zero").join("\n");
  assert.ok(unknownBusyZero.includes("agent unknown | input none"), unknownBusyZero);
  assert.ok(!unknownBusyZero.includes("agent idle"), unknownBusyZero);
  const unknownInput = cardLines(texts, "Unknown input").join("\n");
  assert.ok(unknownInput.includes("agent running | input unknown"), unknownInput);
  assert.ok(!unknownInput.includes("agent idle"), unknownInput);
  const unknownInputZero = cardLines(texts, "Unknown input zero").join("\n");
  assert.ok(unknownInputZero.includes("agent unknown | input unknown"), unknownInputZero);
  assert.ok(!unknownInputZero.includes("agent idle"), unknownInputZero);
  const codexUnknown = cardLines(texts, "Codex unknown").join("\n");
  assert.ok(codexUnknown.includes("agent unknown | input N/A"), codexUnknown);
  assert.ok(!codexUnknown.includes("agent idle"), codexUnknown);
});

test("Pi's nonzero and unknown count readings are unchanged and a native rest line grants no Stop authority", () => {
  const piHarness = rosterWith([
    piItem({
      id: "pi-bg",
      label: "Pi bg",
      busy: false,
      pendingInput: false,
      activeTasks: 1,
      activeShells: 1,
      activity: ["Ready"],
    }),
    piItem({ id: "pi-lost", label: "Pi lost", busy: false, pendingInput: false }),
  ]);
  const texts = rosterLines(piHarness, 44, 30);
  const bg = cardLines(texts, "Pi bg").join("\n");
  assert.ok(bg.includes("agent running | input none"),
    `a Pi row keeps its unchanged nonzero-count reading:\n${bg}`);
  assert.ok(bg.includes("bg tasks 1 | shells 1"), bg);
  const lost = cardLines(texts, "Pi lost").join("\n");
  assert.ok(lost.includes("agent unknown | input none"),
    `a Pi row's lost count source still blocks rest:\n${lost}`);
  assert.ok(lost.includes("bg tasks unknown | shells unknown"), lost);

  // The native Ready card is DISPLAY only: stop/remove still needs the existing
  // confirmation because this row carries no positively observed ownership zeros.
  const nativeHarness = rosterWith([
    nativeItem({
      id: "native-idle",
      label: "Native idle",
      backend: "claude",
      busy: false,
      pendingInput: false,
      activeTasks: 1,
      activeShells: 1,
      activity: ["Ready"],
      statusSupport: CLAUDE_SUPPORT,
    }),
  ]);
  void rosterLines(nativeHarness);
  nativeHarness.send("\x1b[A"); // New -> Saved conversations
  nativeHarness.send("\x1b[A"); // -> the native card
  assert.equal(nativeHarness.controller.selectedId, "native-idle");
  nativeHarness.baseline = nativeHarness.actions.length;
  nativeHarness.send("d");
  assert.equal(nativeHarness.controller.focus, "confirm",
    "a displayed native rest line never authorizes an unconfirmed stop");
  assert.deepEqual(nativeHarness.actions.slice(nativeHarness.baseline), [],
    "nothing is stopped before the operator confirms");
});

test("a Pi row and a row with no declaration render exactly as before", () => {
  const harness = rosterWith([
    piItem({
      id: "pi-idle",
      label: "Pi idle",
      busy: false,
      pendingInput: false,
      backgroundTasks: 0,
      backgroundShells: 0,
      activeTasks: 0,
      activeShells: 0,
      activity: ["Ready"],
    }),
    piItem({ id: "pi-unknown", label: "Pi unknown" }),
    // A hosted row whose observer never declared anything keeps the same wording.
    nativeItem({ id: "undeclared", label: "Undeclared native" }),
  ]);
  const texts = rosterLines(harness);
  const idle = cardLines(texts, "Pi idle").join("\n");
  assert.ok(idle.includes("agent idle | input none"), idle);
  assert.ok(idle.includes("bg tasks 0 | shells 0"), idle);
  const unknown = cardLines(texts, "Pi unknown").join("\n");
  assert.ok(unknown.includes("agent unknown | input unknown"), unknown);
  assert.ok(unknown.includes("bg tasks unknown | shells unknown"), unknown);
  const undeclared = cardLines(texts, "Undeclared native").join("\n");
  assert.ok(undeclared.includes("agent unknown | input unknown"), undeclared);
  assert.ok(undeclared.includes("bg tasks unknown | shells unknown"), undeclared);
  assert.ok(!texts.join("\n").includes("N/A"), "no row gains a not-applicable claim on its own");
});

test("the N/A card adds no row, no column, and no colour to the existing card", () => {
  const pi = rosterWith([piItem({ id: "p", label: "Same shape", busy: null, pendingInput: null })]);
  const native = rosterWith([nativeItem({
    id: "n",
    label: "Same shape",
    statusSupport: { agent: "unsupported", input: "unsupported", tasks: "unsupported", shells: "unsupported", activity: "unsupported" },
  })]);
  const piLines = rosterLines(pi, 34, 30);
  const nativeLines = rosterLines(native, 34, 30);
  assert.equal(nativeLines.length, piLines.length, "the same card geometry, row for row");
  // Every N/A value sits on the neutral canvas: the drawn text of the fully
  // unreportable card contains no status word at all.
  const card = cardLines(nativeLines, "Same shape").join("\n");
  for (const word of ["running", "waiting", "idle", "pending", "none", "unknown"]) {
    assert.equal(card.includes(word), false, `${word} leaked into a fully unreportable card: ${card}`);
  }
  assert.ok(card.includes("N/A"), card);
});

/* ------------------------------------------------------------------------- *
 * The SAME classification through the paired-owner roster projection
 * ------------------------------------------------------------------------- */

function makeRemoteRow(
  overrides: Partial<RemoteSessionMetadata> & { id: string },
): RemoteSessionMetadata {
  return {
    label: "owner row",
    workspace: "/owner/work",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    ...overrides,
  };
}

function makeHost(rows: readonly RemoteSessionMetadata[]): PeerUiHost {
  return {
    id: "h1",
    label: "studio",
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: { state: "current", rows, hostRunId: "run-alpha:1" },
  };
}

function makeSnapshot(hosts: readonly PeerUiHost[]): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: {
      hostingEnabled: false,
      bindHost: "127.0.0.1",
      bindPort: 8443,
      autoReconnect: false,
      bellEnabled: true,
      viewerNativeInputEnabled: true,
      remoteHistoryDeleteEnabled: true,
    },
    identityFingerprint: "SHA256:local-identity",
    listener: { state: "off", host: null, port: null, message: null },
    hosts,
    trustedPeers: [],
    consents: [],
    notice: null,
  };
}

function remoteHarness(rows: readonly RemoteSessionMetadata[]): Harness {
  const harness = makeController({ initialVisible: false });
  harness.controller.updateItems([]);
  harness.controller.setPeerUiSnapshot(makeSnapshot([makeHost(rows)]));
  harness.send(ALT_LEFT);
  void harness.controller.render(40, 30);
  harness.baseline = harness.actions.length;
  return harness;
}

test("a paired-owner row renders the same N/A, zero, and unknown facts as a local row", () => {
  const harness = remoteHarness([
    makeRemoteRow({
      id: "r-na",
      label: "owner native",
      busy: false,
      statusSupport: { input: "unsupported", tasks: "unsupported", shells: "unsupported" },
    }),
    makeRemoteRow({
      id: "r-zeros",
      label: "owner zeros",
      busy: false,
      pendingInput: false,
      activeTasks: 0,
      activeShells: 0,
      statusSupport: { tasks: "supported", shells: "supported" },
    }),
    // A legacy owner row: no declaration at all, so the unchanged unknown wording.
    makeRemoteRow({ id: "r-legacy", label: "owner legacy" }),
  ]);
  const texts = rosterLines(harness, 44, 40);
  const na = cardLines(texts, "owner native").join("\n");
  assert.ok(na.includes("agent idle | input N/A"), na);
  assert.ok(na.includes("bg tasks N/A | shells N/A"), na);
  const zeros = cardLines(texts, "owner zeros").join("\n");
  assert.ok(zeros.includes("agent idle | input none"), zeros);
  assert.ok(zeros.includes("bg tasks 0 | shells 0"), zeros);
  const legacy = cardLines(texts, "owner legacy").join("\n");
  assert.ok(legacy.includes("agent unknown | input unknown"), legacy);
  assert.ok(legacy.includes("bg tasks unknown | shells unknown"), legacy);
});

test("the Network pane's plain activity summary uses the same applicability words", () => {
  const harness = remoteHarness([
    makeRemoteRow({
      id: "r-net",
      label: "plain summary",
      busy: false,
      pendingInput: null,
      activeTasks: null,
      activeShells: 1,
      statusSupport: { input: "unsupported", tasks: "unsupported" },
    }),
  ]);
  harness.controller.openPeerMenu();
  const lines: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    const pane = harness.controller.renderForm(100, 40).lines.map((line) => line.replace(SGR_PATTERN, ""));
    lines.push(...pane);
    if (pane.some((line) => line.includes("plain summary"))) break;
    harness.send("\x1b[B");
  }
  const summary = lines.filter((line) => line.includes("plain summary")).join("\n");
  // The observed shell is a background DISPLAY fact: the foreground is at rest,
  // and the unreportable categories say so in the same plain line.
  assert.ok(summary.includes("agent idle | input N/A"), summary);
  assert.ok(summary.includes("bg tasks N/A | shells 1"), summary);
});
