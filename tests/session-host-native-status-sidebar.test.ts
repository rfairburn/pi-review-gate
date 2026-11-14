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
  assert.ok(unknown.includes("background unknown"), unknown);
  const undeclared = cardLines(texts, "Undeclared native").join("\n");
  assert.ok(undeclared.includes("agent unknown | input unknown"), undeclared);
  assert.ok(undeclared.includes("background unknown"), undeclared);
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
  assert.ok(legacy.includes("background unknown"), legacy);
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
  // One observed shell is the only running fact; the unreportable categories say so
  // in the same plain line the palette-free renderer uses.
  assert.ok(summary.includes("agent running | input N/A"), summary);
  assert.ok(summary.includes("bg tasks N/A | shells 1"), summary);
});
