/**
 * #613 follow-up: the sidebar card's ACTIVITY count row and the remote card's
 * owner hostname get colour, and nothing else changes.
 *
 * The contract these tests pin:
 *
 * 1. Each independent count (`bg tasks`, `shells`) is banded on its own —
 *    0 muted, 1-2 green, 3-6 amber, 7+ red — reusing the palette's existing
 *    status roles. The bands are RPM-style ACTIVITY intensity, never an error:
 *    a red number never reclassifies the row's status, notice, or lifecycle,
 *    and the number is never capped (128 and larger safe integers render whole).
 * 2. ONLY the numeric VALUE is painted. The `bg tasks ` / `shells ` labels and
 *    the ` | ` separator stay ordinary pane text, and an `unknown` value stays
 *    ordinary pane text exactly as it was before this styling existed.
 * 3. The plaintext is byte-identical to the pre-colour row for every input,
 *    including the both-unknown special case, mixed known/unknown, and every
 *    invalid count — the same facts also feed the ANSI-free Network summary.
 * 4. Only the actual sanitized hostname in a remote card's indented owner row
 *    takes Pi's own cyan variable colour, unbolded. The indentation, the `host `
 *    word, and the optional `[stale] ` observation stay ordinary pane text, and
 *    clipping a long or wide name still cannot hide `[stale] ` or leak a style
 *    past its own run.
 *
 * Everything is read from the ACTUAL rendered rows through the real palette for
 * BOTH built-in appearances, and every emitted sequence stays inside the
 * renderer's closed generated-SGR allowlist. Two independent readings are used,
 * because a raw substring cannot prove what a terminal actually shows: the
 * generated sequences, AND the effective cells the real `TerminalSurface`
 * parser resolves after every preceding style — exact 24-bit foreground, bold
 * or not, and the terminal-default background. No terminal, SSH session, Pi
 * configuration, or Pi theme is involved.
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
import { sidebarPaletteFor, type SidebarThemeId } from "../src/session-host/sidebar-theme";
import { TerminalSurface } from "../src/session-host/terminal-surface";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const TOGGLE = "\x1b[1;3D";
const THEMES: readonly SidebarThemeId[] = ["dark", "light"];

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

function makeRemoteRow(overrides: Partial<RemoteSessionMetadata> & { id: string }): RemoteSessionMetadata {
  return {
    label: `remote-${overrides.id}`,
    workspace: `/remote/ws/${overrides.id}`,
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
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

function makeHost(options: {
  readonly id: string;
  readonly label?: string;
  readonly rosterState?: "never" | "current" | "stale";
  readonly rows?: readonly RemoteSessionMetadata[] | null;
}): PeerUiHost {
  return {
    id: options.id,
    label: options.label ?? `host-${options.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: { state: options.rosterState ?? "current", rows: options.rows ?? null },
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

interface Harness {
  controller: SidebarController;
  actions: SidebarAction[];
  /** Host actions emitted since the roster was shown. */
  sinceSetup(): SidebarAction[];
}

function makeHarness(items: readonly SidebarItem[], options: SidebarControllerOptions = {}): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    ...options,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  controller.updateItems([...items]);
  controller.handleInput(TOGGLE); // show -> sidebar focus
  assert.equal(controller.focus, "sidebar");
  const baseline = actions.length;
  return { controller, actions, sinceSetup: () => actions.slice(baseline) };
}

/** Every rendered row, with the closed-allowlist fence applied. */
function drawnRows(controller: SidebarController, cols: number, rows: number): string[] {
  const lines = controller.renderRoster(cols, rows).lines;
  assert.equal(lines.length, rows, "the pane fills the supplied geometry");
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`);
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `rendered row wider than the pane: ${JSON.stringify(text)}`);
  }
  return lines;
}

/** One rendered row with every generated sequence and the pane's own border removed. */
function plainText(line: string): string {
  return line.replace(SGR_PATTERN, "").replace(/[\u2502\u2503]\s*$/u, "").trimEnd();
}

/** The raw (still-painted) row directly below the card whose title is `title`. */
function rowBelow(lines: readonly string[], title: string, offset: number): string {
  const index = lines.findIndex((line) => plainText(line) === title);
  assert.ok(index >= 0, `no card titled ${JSON.stringify(title)} in ${JSON.stringify(lines.map(plainText))}`);
  return lines[index + offset] ?? "";
}

const countText = (tasks: string, shells: string): string => `  bg tasks ${tasks} | shells ${shells}`;

/**
 * One count row, asserted exactly: the two labels and the separator carry no
 * generated sequence of their own, each VALUE carries exactly the expected
 * role (or none), and stripping every sequence reproduces the expected
 * plaintext byte for byte.
 */
function assertCountRow(
  raw: string,
  expectedPlaintext: string,
  tasks: { readonly text: string; readonly role: string | null },
  shells: { readonly text: string; readonly role: string | null },
  palette: ReturnType<typeof sidebarPaletteFor>,
  where: string,
): void {
  assert.equal(plainText(raw), expectedPlaintext,
    `${where}: the painted row's plaintext is the exact existing text`);
  if (tasks.text === "background unknown") {
    // The both-unknown special case: one ordinary phrase, no colour inside it.
    assert.ok(raw.includes("  background unknown"),
      `${where}: the unknown special row keeps its exact wording with nothing painted inside`);
    return;
  }
  // The labels and separator never borrow a colour: the sequence for a value
  // begins immediately after its own label, and the separator follows a reset.
  assert.ok(raw.includes("  bg tasks "), `${where}: the tasks label stays ordinary pane text`);
  assert.ok(raw.includes("| shells "), `${where}: the shells label stays ordinary pane text`);
  for (const [label, part] of [["tasks", tasks], ["shells", shells]] as const) {
    if (part.role === null) {
      assert.ok(raw.includes(`${label === "tasks" ? "bg tasks " : "shells "}${part.text}`),
        `${where}: an unknown ${label} value stays ordinary pane text`);
      assert.ok(!raw.includes(`${label === "tasks" ? "bg tasks " : "shells "}\x1b[`),
        `${where}: an unknown ${label} value carries no generated sequence`);
      continue;
    }
    assert.ok(raw.includes(`${label === "tasks" ? "bg tasks " : "shells "}\x1b[${palette[part.role as keyof typeof palette]}m${part.text}\x1b[0m`),
      `${where}: the ${label} value ${part.text} uses the ${part.role} role and closes its own run`);
  }
}

// ---------------------------------------------------------------------------
// 1. The band table, per count, on the ACTUAL local card.
// ---------------------------------------------------------------------------

const BANDS: readonly { readonly count: number; readonly role: string }[] = [
  { count: 0, role: "statusIdle" },
  { count: 1, role: "statusRunning" },
  { count: 2, role: "statusRunning" },
  { count: 3, role: "statusWaiting" },
  { count: 4, role: "statusWaiting" },
  { count: 5, role: "statusWaiting" },
  { count: 6, role: "statusWaiting" },
  { count: 7, role: "statusError" },
  { count: 8, role: "statusError" },
  { count: 128, role: "statusError" },
  { count: 9_007_199_254_740_991, role: "statusError" },
];

test("every activity count band is drawn on the real local card, in both appearances", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    for (const band of BANDS) {
      const harness = makeHarness([
        makeItem({ id: "t", label: "Tasks", activeTasks: band.count, activeShells: 0 }),
        makeItem({ id: "s", label: "Shells", activeTasks: 0, activeShells: band.count }),
      ], { theme });
      const lines = drawnRows(harness.controller, 60, 20);
      const count = String(band.count);
      assertCountRow(rowBelow(lines, "Tasks", 2), countText(count, "0"),
        { text: count, role: band.role }, { text: "0", role: "statusIdle" }, palette, `${theme} tasks ${count}`);
      assertCountRow(rowBelow(lines, "Shells", 2), countText("0", count),
        { text: "0", role: "statusIdle" }, { text: count, role: band.role }, palette, `${theme} shells ${count}`);
    }
  }
});

test("the two counts are banded independently, and the number is never capped", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const harness = makeHarness([
      makeItem({ id: "a", label: "TwoSeven", activeTasks: 2, activeShells: 7 }),
      makeItem({ id: "b", label: "BigZero", activeTasks: 128, activeShells: 0 }),
      makeItem({ id: "c", label: "SixSeven", activeTasks: 6, activeShells: 7 }),
    ], { theme });
    const lines = drawnRows(harness.controller, 60, 24);

    assertCountRow(rowBelow(lines, "TwoSeven", 2), countText("2", "7"),
      { text: "2", role: "statusRunning" }, { text: "7", role: "statusError" }, palette, `${theme} 2/7`);
    assertCountRow(rowBelow(lines, "BigZero", 2), countText("128", "0"),
      { text: "128", role: "statusError" }, { text: "0", role: "statusIdle" }, palette, `${theme} 128/0`);
    assertCountRow(rowBelow(lines, "SixSeven", 2), countText("6", "7"),
      { text: "6", role: "statusWaiting" }, { text: "7", role: "statusError" }, palette, `${theme} 6/7`);

    // Uncapped and unrounded: the real digits are on screen, never a clamp.
    const bigRow = rowBelow(lines, "BigZero", 2);
    assert.ok(bigRow.includes("128") && !/99\+|\.\.\./.test(bigRow.replace(SGR_PATTERN, "")),
      `${theme}: 128 renders whole:\n${bigRow}`);
    // The two independent facts on one row really are two different colours.
    assert.notEqual(palette.statusRunning, palette.statusError, `${theme}: 2 and 7 read differently`);
    assert.notEqual(palette.statusWaiting, palette.statusError, `${theme}: 6 and 7 read differently`);
  }
});

// ---------------------------------------------------------------------------
// 2. Unknown, mixed, and invalid counts keep their exact existing text and stay
//    ordinary pane text — no new dim colour, no invented zero.
// ---------------------------------------------------------------------------

test("unknown, mixed, and invalid counts keep their exact text and stay unpainted", () => {
  const invalid: readonly { readonly label: string; readonly tasks: unknown; readonly shells: unknown }[] = [
    { label: "Bogus", tasks: -1, shells: 1.5 },
    { label: "Hostile", tasks: "3", shells: Number.MAX_SAFE_INTEGER + 1 },
    { label: "Nonfinite", tasks: Number.NaN, shells: Number.POSITIVE_INFINITY },
  ];
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const harness = makeHarness([
      makeItem({ id: "both", label: "BothUnknown" }),
      makeItem({ id: "mixed", label: "Mixed", activeTasks: null, activeShells: 3 }),
      makeItem({ id: "mixed2", label: "Mixed2", activeTasks: 4, activeShells: null }),
      ...invalid.map((entry, index) => makeItem({
        id: `bad${index}`,
        label: entry.label,
        activeTasks: entry.tasks as number,
        activeShells: entry.shells as number,
      })),
    ], { theme });
    const lines = drawnRows(harness.controller, 60, 44);

    assertCountRow(rowBelow(lines, "BothUnknown", 2), "  background unknown",
      { text: "background unknown", role: null }, { text: "", role: null }, palette, `${theme} both unknown`);
    assertCountRow(rowBelow(lines, "Mixed", 2), countText("unknown", "3"),
      { text: "unknown", role: null }, { text: "3", role: "statusWaiting" }, palette, `${theme} mixed`);
    assertCountRow(rowBelow(lines, "Mixed2", 2), countText("4", "unknown"),
      { text: "4", role: "statusWaiting" }, { text: "unknown", role: null }, palette, `${theme} mixed2`);
    for (const entry of invalid) {
      assertCountRow(rowBelow(lines, entry.label, 2), "  background unknown",
        { text: "background unknown", role: null }, { text: "", role: null }, palette, `${theme} ${entry.label}`);
    }
  }
});

test("a red count band is activity only: the card's status stays truthful", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const harness = makeHarness([
      makeItem({ id: "hot", label: "Hot", busy: true, activeTasks: 9, activeShells: 40 }),
    ], { theme });
    const lines = drawnRows(harness.controller, 60, 20);
    const status = rowBelow(lines, "Hot", 1);
    const counts = rowBelow(lines, "Hot", 2);
    // The status row is untouched by the count colours: still a running agent.
    assert.equal(plainText(status), "  agent running | input none");
    assert.ok(status.includes(`\x1b[${palette.statusRunning}mrunning\x1b[0m`),
      "the agent status keeps the running role, not the count's red");
    // The error-family sequence appears ONLY around the two numbers.
    const errorPaints = counts.match(new RegExp(`\\x1b\\[${palette.statusError}m`, "gu")) ?? [];
    assert.equal(errorPaints.length, 2, `both hot counts use the red activity band:\n${counts}`);
    assert.ok(!status.includes(`\x1b[${palette.statusError}m`),
      "a hot count never turns the card into an error state");
    assert.equal(harness.sinceSetup().length, 0, "painting counts emits no host action");
  }
});

// ---------------------------------------------------------------------------
// 3. The remote card shares the count formatter, and only its hostname is cyan.
// ---------------------------------------------------------------------------

function remoteHarness(theme: SidebarThemeId, host: PeerUiHost): Harness {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    theme,
    onAction: (action: SidebarAction) => actions.push(action),
  });
  controller.updateItems([]);
  controller.setPeerUiSnapshot(makeSnapshot([host]));
  controller.handleInput(TOGGLE);
  assert.equal(controller.focus, "sidebar");
  const baseline = actions.length;
  return { controller, actions, sinceSetup: () => actions.slice(baseline) };
}

test("the remote card's counts use the same bands as the local card", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const harness = remoteHarness(theme, makeHost({
      id: "h1",
      label: "studio",
      rows: [makeRemoteRow({ id: "r1", label: "Remote build", activeTasks: 7, activeShells: 1 })],
    }));
    const lines = drawnRows(harness.controller, 60, 20);
    assertCountRow(rowBelow(lines, "Remote build", 3), countText("7", "1"),
      { text: "7", role: "statusError" }, { text: "1", role: "statusRunning" }, palette, `${theme} remote counts`);
    // The row above is the owner row, and the row above that is the title: the
    // card keeps its exact existing 6-row expanded grammar.
    assert.equal(plainText(rowBelow(lines, "Remote build", 1)), "  host studio");
    assert.equal(plainText(rowBelow(lines, "Remote build", 2)), "  agent running | input none",
      "the activity counts keep the remote card honestly running, exactly as before");
  }
});

test("only the remote hostname is cyan; the prefix, indentation, and [stale] stay ordinary", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const cyan = `\x1b[${palette.remoteHost}m`;
    // The cyan really is the palette's own remote-host role, and it is neither
    // the ordinary pane text nor any status the card can be mistaken for.
    assert.notEqual(palette.remoteHost, palette.canvas, `${theme}: the host name is not ordinary text`);
    assert.notEqual(palette.remoteHost, palette.secondary, `${theme}: the host name is not secondary text`);
    assert.notEqual(palette.remoteHost, palette.statusError, `${theme}: the host name is not an error`);
    assert.equal(/^1;/.test(palette.remoteHost), false, `${theme}: the host name stays unbolded`);

    const plain = remoteHarness(theme, makeHost({
      id: "h1",
      label: "studio",
      rows: [makeRemoteRow({ id: "r1", label: "Remote build" })],
    }));
    let lines = drawnRows(plain.controller, 60, 20);
    let hostRow = rowBelow(lines, "Remote build", 1);
    assert.ok(hostRow.includes(`  host ${cyan}studio\x1b[0m`),
      `${theme}: the indentation and host word are ordinary, the name alone is cyan:\n${hostRow}`);
    assert.equal(plainText(hostRow), "  host studio");

    const stale = remoteHarness(theme, makeHost({
      id: "h2",
      label: "studio",
      rosterState: "stale",
      rows: [makeRemoteRow({ id: "r1", label: "Remote build" })],
    }));
    lines = drawnRows(stale.controller, 60, 20);
    hostRow = rowBelow(lines, "Remote build", 1);
    assert.ok(hostRow.includes(`  host [stale] ${cyan}studio\x1b[0m`),
      `${theme}: [stale] stays ordinary text ahead of the cyan name:\n${hostRow}`);
    assert.equal(plainText(hostRow), "  host [stale] studio");
    assert.equal(stale.sinceSetup().length, 0, "colouring a host name emits no host action");
  }
});

test("clipping a long, wide, or hostile host label keeps [stale], the width fence, and the style fence", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const cyan = `\x1b[${palette.remoteHost}m`;
    const cases: readonly { readonly name: string; readonly label: string }[] = [
      { name: "long ascii", label: `build-${"x".repeat(80)}` },
      { name: "wide unicode", label: `studio-${"界".repeat(40)}` },
      { name: "hostile", label: "\x1b[31mEVIL\x1b]0;pwned\x07tail" },
    ];
    for (const testCase of cases) {
      const harness = remoteHarness(theme, makeHost({
        id: "h1",
        label: testCase.label,
        rosterState: "stale",
        rows: [makeRemoteRow({ id: "r1", label: "Remote build" })],
      }));
      const lines = drawnRows(harness.controller, 32, 20);
      const hostRow = lines.find((line) => plainText(line).includes("[stale]")) ?? "";
      assert.notEqual(hostRow, "", `${theme} ${testCase.name}: the stale observation stays visible`);
      const text = plainText(hostRow);
      assert.ok(text.trimStart().startsWith("host [stale]"),
        `${theme} ${testCase.name}: the row still leads with the honest marker:\n${text}`);
      assert.ok(!text.includes("pwned") && !text.includes("\x1b"),
        `${theme} ${testCase.name}: control bytes never reach the row`);
      // The name's own run closes: between the cyan and the next reset there is
      // no other generated sequence, so the colour can only ever cover the
      // (possibly clipped) name and its own trailing padding, never a status,
      // the stale marker, or the next row.
      const at = hostRow.indexOf(cyan);
      assert.ok(at >= 0, `${theme} ${testCase.name}: the name carries the remote-host colour`);
      const after = hostRow.slice(at + cyan.length);
      const reset = after.indexOf("\x1b[0m");
      assert.ok(reset >= 0, `${theme} ${testCase.name}: the row closes its style`);
      assert.equal(after.slice(0, reset).includes("\x1b["), false,
        `${theme} ${testCase.name}: no other generated sequence joins the name's run`);
      assert.equal(after.slice(0, reset).includes("[stale]"), false,
        `${theme} ${testCase.name}: the stale marker is never inside the name's colour`);
      const name = text.replace(/^\s*host \[stale\] /u, "").trimEnd();
      assert.ok(name.length > 0, `${theme} ${testCase.name}: a clipped label still leaves a name`);
      assert.equal((hostRow.match(new RegExp(cyan.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu")) ?? []).length, 1,
        `${theme} ${testCase.name}: the cyan belongs to the (possibly clipped) name only:\n${hostRow}`);
    }
  }
});

test("the count and host colours stay inside the closed generated set", () => {
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(palette.remoteHost),
      `${theme}: the remote-host foreground is an allowed generated sequence`);
    const harness = makeHarness([
      makeItem({ id: "hot", label: "Hot", busy: true, activeTasks: 9, activeShells: 40 }),
    ], { theme });
    for (const line of drawnRows(harness.controller, 60, 20)) {
      for (const sgr of line.match(SGR_PATTERN) ?? []) {
        assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
          `${theme}: ${JSON.stringify(sgr)} is outside the closed set`);
      }
    }
    // The set is still closed against invented colours, including a hand-picked
    // cyan: the host name's colour comes from the copied Pi token only.
    for (const refused of ["36", "1;36", "38;2;0;255;255", "38;5;39", "44", "100", "48;2;0;0;0"]) {
      assert.equal(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(refused), false,
        `${theme}: ${refused} stays refused`);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The EFFECTIVE cells. A raw substring cannot prove what a terminal actually
//    shows: an earlier active style could colour a label, a separator, or an
//    unknown phrase while those substring checks still pass. These tests write
//    the renderer's own rows through the real `TerminalSurface` parser and read
//    the resolved cell attributes — exact 24-bit foreground, bold or not, and
//    the terminal-default background — for both appearances.
// ---------------------------------------------------------------------------

type PaletteRole = keyof ReturnType<typeof sidebarPaletteFor>;

/**
 * Write the renderer's own pane rows at absolute rows, so no line is mis-mapped
 * by the emulator's wrap-pending state after a full-width row.
 */
async function drawPane(surface: TerminalSurface, lines: readonly string[]): Promise<void> {
  for (let row = 0; row < lines.length; row += 1) {
    surface.write(`\x1b[${row + 1};1H${lines[row]}`);
  }
  await surface.flush();
}

/** One palette value's 24-bit foreground, as the emulator records it. */
function paletteForegroundRgb(sgr: string): number {
  const match = /38;2;(\d{1,3});(\d{1,3});(\d{1,3})/.exec(sgr);
  assert.ok(match, `${JSON.stringify(sgr)} carries an exact 24-bit foreground`);
  return ((Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3])) >>> 0;
}

/** The 0-based pane row that carries the card titled `title`. */
function titleRow(lines: readonly string[], title: string): number {
  const index = lines.findIndex((line) => plainText(line) === title);
  assert.ok(index >= 0, `no card titled ${JSON.stringify(title)} in ${JSON.stringify(lines.map(plainText))}`);
  return index;
}

/** The emulator's resolved cell runs for the row `offset` below a card title. */
function cellRuns(surface: TerminalSurface, lines: readonly string[], title: string, offset: number) {
  const target = titleRow(lines, title) + offset;
  const row = (surface.frame().styles ?? []).find((line) => line.line === target);
  assert.ok(row !== undefined, `the emulator styled pane row ${target}`);
  assert.ok(row.runs.length > 0, `pane row ${target} carries drawn runs`);
  return row.runs;
}

/** Draw one roster through the real parser and hand back the surface plus its rows. */
async function cellsOf(controller: SidebarController, cols: number, rows: number) {
  const lines = controller.renderRoster(cols, rows).lines;
  const surface = new TerminalSurface(cols, rows);
  await drawPane(surface, lines);
  return { surface, lines };
}

test("the terminal's effective cells band each activity count and leave labels, separators, and unknown on the canvas", async () => {
  const cases: readonly {
    readonly label: string;
    readonly tasks: number | null;
    readonly shells: number | null;
    readonly painted: readonly { readonly text: string; readonly role: PaletteRole; readonly bold: boolean }[];
  }[] = [
    { label: "Zero", tasks: 0, shells: 0, painted: [{ text: "0", role: "statusIdle", bold: false }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "One", tasks: 1, shells: 0, painted: [{ text: "1", role: "statusRunning", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Two", tasks: 2, shells: 0, painted: [{ text: "2", role: "statusRunning", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Three", tasks: 3, shells: 0, painted: [{ text: "3", role: "statusWaiting", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Four", tasks: 4, shells: 0, painted: [{ text: "4", role: "statusWaiting", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Five", tasks: 5, shells: 0, painted: [{ text: "5", role: "statusWaiting", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Six", tasks: 6, shells: 0, painted: [{ text: "6", role: "statusWaiting", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Seven", tasks: 7, shells: 0, painted: [{ text: "7", role: "statusError", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Eight", tasks: 8, shells: 0, painted: [{ text: "8", role: "statusError", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "Uncapped", tasks: 128, shells: 0, painted: [{ text: "128", role: "statusError", bold: true }, { text: "0", role: "statusIdle", bold: false }] },
    { label: "MaxSafe", tasks: 9_007_199_254_740_991, shells: 9_007_199_254_740_991, painted: [{ text: "9007199254740991", role: "statusError", bold: true }, { text: "9007199254740991", role: "statusError", bold: true }] },
    { label: "TwoSeven", tasks: 2, shells: 7, painted: [{ text: "2", role: "statusRunning", bold: true }, { text: "7", role: "statusError", bold: true }] },
    { label: "SixSeven", tasks: 6, shells: 7, painted: [{ text: "6", role: "statusWaiting", bold: true }, { text: "7", role: "statusError", bold: true }] },
    { label: "UnknownTasks", tasks: null, shells: 3, painted: [{ text: "3", role: "statusWaiting", bold: true }] },
    { label: "UnknownShells", tasks: 4, shells: null, painted: [{ text: "4", role: "statusWaiting", bold: true }] },
    { label: "BothUnknown", tasks: null, shells: null, painted: [] },
  ];
  const cols = 60;
  const rows = 92;
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const canvasRgb = paletteForegroundRgb(palette.canvas);
    const harness = makeHarness(cases.map((testCase) => makeItem({
      id: testCase.label,
      label: testCase.label,
      activeTasks: testCase.tasks,
      activeShells: testCase.shells,
    })), { theme });
    const { surface, lines } = await cellsOf(harness.controller, cols, rows);
    try {
      for (const testCase of cases) {
        const runs = cellRuns(surface, lines, testCase.label, 2);
        const where = `${theme} ${testCase.label}`;
        const drawn = runs.map((run) => run.text).join("");
        const shown = (value: number | null): string => value === null ? "unknown" : String(value);
        const expected = testCase.label === "BothUnknown"
          ? "  background unknown"
          : countText(shown(testCase.tasks), shown(testCase.shells));
        assert.equal(drawn.trimEnd(), expected, `${where}: the drawn row's plaintext is unchanged`);
        // Every cell on the row: an explicit 24-bit foreground and the terminal's
        // own default background, never a painted ground.
        for (const run of runs) {
          assert.equal(run.fg?.mode, "rgb", `${where}: every cell keeps an exact 24-bit foreground`);
          assert.equal(run.bg, undefined, `${where}: every cell keeps the terminal-default background`);
        }
        // Exactly the numbers carry colour, each in its own band and emphasis;
        // nothing else on the row — label, spaces, separator, or `unknown` — is
        // pulled into any of them by a preceding style.
        const painted = runs.filter((run) => run.fg?.value !== canvasRgb);
        assert.deepEqual(painted.map((run) => ({ text: run.text, bold: run.bold === true })),
          testCase.painted.map((part) => ({ text: part.text, bold: part.bold })),
          `${where}: only the numbers are painted, with the agreed emphasis`);
        painted.forEach((run, index) => {
          const part = testCase.painted[index];
          assert.ok(part, `${where}: a painted cell has an agreed band`);
          assert.equal(run.fg?.value, paletteForegroundRgb(palette[part.role]),
            `${where}: ${part.text} resolves to Pi's ${part.role} foreground`);
        });
        for (const run of runs.filter((cell) => cell.fg?.value === canvasRgb)) {
          assert.notEqual(run.bold, true, `${where}: canvas cells stay unemphasized`);
        }
        assert.ok(drawn.includes("  bg tasks ") && drawn.includes(" | shells ") || testCase.label === "BothUnknown",
          `${where}: the labels and separator are drawn as ordinary text`);
      }
      // The red band changes nothing about the status row's own cells: the same
      // running/none pair as any other running card, and no cell on that row
      // resolves to the palette's error foreground.
      const hotRuns = cellRuns(surface, lines, "Seven", 1);
      const hotPainted = hotRuns.filter((run) => run.fg?.value !== canvasRgb);
      assert.deepEqual(hotPainted.map((run) => ({ text: run.text, fg: run.fg?.value, bold: run.bold === true })),
        [
          { text: "running", fg: paletteForegroundRgb(palette.statusRunning), bold: true },
          { text: "none", fg: paletteForegroundRgb(palette.statusIdle), bold: false },
        ],
        `${theme}: a 7-task card still resolves to a plain running agent, never an error state`);
      const errorRgb = paletteForegroundRgb(palette.statusError);
      for (const run of hotRuns) {
        assert.notEqual(run.fg?.value, errorRgb, `${theme}: no status cell borrows the count's red band`);
      }
    } finally {
      surface.dispose();
    }
  }
});

test("the terminal's effective cells paint only the remote hostname cyan, never the prefix, marker, or padding", async () => {
  const cases: readonly {
    readonly name: string;
    readonly label: string;
    readonly rosterState: "current" | "stale";
    readonly clipped: boolean;
  }[] = [
    { name: "plain", label: "studio", rosterState: "current", clipped: false },
    { name: "stale", label: "studio", rosterState: "stale", clipped: false },
    { name: "hostile", label: "\x1b[31mEVIL\x1b]0;pwned\x07tail", rosterState: "stale", clipped: false },
    { name: "long ascii", label: `build-${"x".repeat(80)}`, rosterState: "stale", clipped: true },
    { name: "wide unicode", label: `studio-${"界".repeat(40)}`, rosterState: "stale", clipped: true },
  ];
  const cols = 32;
  const rows = 20;
  for (const theme of THEMES) {
    const palette = sidebarPaletteFor(theme);
    const canvasRgb = paletteForegroundRgb(palette.canvas);
    const cyanRgb = paletteForegroundRgb(palette.remoteHost);
    assert.notEqual(cyanRgb, canvasRgb, `${theme}: the host cyan is not the ordinary pane text colour`);
    for (const role of ["statusIdle", "statusRunning", "statusWaiting", "statusError", "secondary", "title"] as const) {
      assert.notEqual(cyanRgb, paletteForegroundRgb(palette[role]),
        `${theme}: the host cyan is not the ${role} colour`);
    }
    for (const testCase of cases) {
      const harness = remoteHarness(theme, makeHost({
        id: "h1",
        label: testCase.label,
        rosterState: testCase.rosterState,
        rows: [makeRemoteRow({ id: "r1", label: "Remote build" })],
      }));
      const { surface, lines } = await cellsOf(harness.controller, cols, rows);
      try {
        const runs = cellRuns(surface, lines, "Remote build", 1);
        const where = `${theme} ${testCase.name}`;
        const drawn = runs.map((run) => run.text).join("");
        assert.ok(drawn.startsWith("  host "), `${where}: the owner row keeps its indentation and word:\n${drawn}`);
        assert.ok(testCase.rosterState === "stale" ? drawn.startsWith("  host [stale] ") : !drawn.includes("[stale]"),
          `${where}: the stale observation stays exactly where it was`);
        for (const run of runs) {
          assert.equal(run.fg?.mode, "rgb", `${where}: every cell keeps an exact 24-bit foreground`);
          assert.equal(run.bg, undefined, `${where}: every cell keeps the terminal-default background`);
        }
        const painted = runs.filter((run) => run.fg?.value !== canvasRgb);
        assert.equal(painted.length, 1, `${where}: exactly one painted cell run on the owner row:\n${drawn}`);
        const nameRun = painted[0];
        assert.equal(nameRun.fg?.value, cyanRgb, `${where}: the drawn name resolves to Pi's cyan variable colour`);
        assert.notEqual(nameRun.bold, true, `${where}: the host name keeps its unbolded weight`);
        assert.equal(nameRun.text.includes("host"), false, `${where}: the host word is never inside the cyan`);
        assert.equal(nameRun.text.includes("[stale]"), false, `${where}: the stale marker is never inside the cyan`);
        for (const run of runs.filter((cell) => cell.fg?.value === canvasRgb)) {
          assert.notEqual(run.bold, true, `${where}: the prefix and marker stay unemphasized`);
        }
        if (!testCase.clipped) {
          // The name's own run closes before the row's padding: the padding is
          // ordinary canvas text, so no style leaks across the card.
          const tail = runs[runs.length - 1];
          assert.match(tail.text, /^ +$/u, `${where}: the row ends in plain padding`);
          assert.equal(tail.fg?.value, canvasRgb, `${where}: the padding is not painted by the name's colour`);
        } else {
          // Clipped: the honest marker and prefix are still canvas cells, and
          // the cyan covers nothing but the ellipsized name and its padding.
          const expectedPrefix = testCase.name === "long ascii" ? "build-" : "studio-";
          assert.ok(nameRun.text.startsWith(expectedPrefix),
            `${where}: the cyan run starts at the name itself, not at the prefix:\n${nameRun.text}`);
          assert.ok(nameRun.text.trimEnd().endsWith("...") || !nameRun.text.includes("界".repeat(40)),
            `${where}: a clipped name is ellipsized, never widened past the card`);
        }
      } finally {
        surface.dispose();
      }
    }
  }
});
