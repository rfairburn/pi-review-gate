/**
 * Standalone pending-consent alert band and the terminal-default pane ground
 * (#613 audit correction).
 *
 * `renderPeerAlert` is the notification band Main hands the compositor as a
 * banner (the sidebar pane is hidden, or a narrow layout while Main holds
 * focus), so its rows land directly on the operator's terminal instead of inside
 * a host pane that already carries the appearance's explicit foreground. Before
 * this correction the band painted its `notice`, `secondary`, and `hint`
 * foregrounds with NO foreground at all: Dark's yellow/grey became unreadable on
 * a light terminal default, and Light's red/grey/magenta on a dark one.
 *
 * Everything here is the production renderer plus the real `TerminalSurface`
 * parser: the band rows are written to the emulator at absolute rows and read
 * back as terminal CELLS. Every cell of every band row must carry an explicit
 * foreground from the SAME finite palette the rest of the sidebar already uses,
 * while the background stays the terminal default exactly like Pi's own
 * canvas-free chat viewport — no new role, no new palette, no terminal query,
 * detection, or configuration write, and no native/child cell is involved.
 *
 * Geometry (row count, padded width, text, absence of a cursor) and the band's
 * notification-only contract (no consent frame, no action, no focus, selection,
 * or owner change) are asserted alongside the colours, so the fix cannot turn a
 * notification band into a control surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";
import {
  SIDEBAR_GENERATED_SGR_ALLOWLIST,
  SidebarController,
  type SidebarAction,
  type SidebarControllerOptions,
  type SidebarMainOwnerKey,
} from "../src/session-host/sidebar";
import { sidebarPaletteFor, type SidebarThemeId } from "../src/session-host/sidebar-theme";
import { TerminalSurface, type TerminalCellRun } from "../src/session-host/terminal-surface";
import type {
  PeerUiConsent,
  PeerUiSettings,
  PeerUiSnapshot,
} from "../src/session-host/peer-ui-protocol";

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
/** The reserved sidebar toggle (alt+left): shows the pane and takes roster focus. */
const TOGGLE = "\x1b[1;3D";
/** Fixed wall-clock origin; the sidebar only ever uses the injected clock. */
const NOW = 1_700_000_000_000;
const WINDOW_MS = 120_000;

const DEFAULT_SETTINGS: PeerUiSettings = {
  hostingEnabled: false,
  bindHost: "127.0.0.1",
  bindPort: 8443,
  autoReconnect: false,
  bellEnabled: true,
  viewerNativeInputEnabled: true,
  remoteHistoryDeleteEnabled: true,
};

function makeConsent(overrides: Partial<PeerUiConsent> & { id: string }): PeerUiConsent {
  return {
    kind: "incoming",
    label: `studio-${overrides.id}`,
    fingerprint: `SHA256:${overrides.id}`,
    endpoint: "192.0.2.10:51234",
    requestedAt: NOW,
    expiresAt: NOW + WINDOW_MS,
    ...overrides,
  };
}

function makeSnapshot(consents: readonly PeerUiConsent[]): PeerUiSnapshot {
  return {
    revision: 1,
    status: "ready",
    settings: { ...DEFAULT_SETTINGS },
    identityFingerprint: "SHA256:local-identity",
    listener: { state: "off", host: null, port: null, message: null },
    hosts: [],
    trustedPeers: [],
    consents,
    notice: null,
  };
}

/**
 * One controller holding one pending request, at the appearance Main would have
 * loaded for it. The pane stays hidden, which is exactly the layout the
 * compositor places the standalone band for.
 */
function makeHarness(
  theme: SidebarThemeId,
  consents: readonly PeerUiConsent[] = [makeConsent({ id: "A" })],
  options: SidebarControllerOptions = {},
): { controller: SidebarController; actions: SidebarAction[] } {
  const actions: SidebarAction[] = [];
  const controller = new SidebarController({
    initialVisible: false,
    theme,
    now: () => NOW,
    ...options,
    onAction: (action) => actions.push(action),
    getSessionOrder: (): readonly SidebarMainOwnerKey[] => [],
  });
  controller.setPeerUiSnapshot(makeSnapshot(consents));
  actions.length = 0;
  return { controller, actions };
}

/** Allowlist + width guard on raw band rows; returns SGR-stripped text rows. */
function assertBandSafe(lines: readonly string[], cols: number, rows: number): string[] {
  for (const line of lines) {
    for (const sgr of line.match(SGR_PATTERN) ?? []) {
      assert.ok(
        SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)),
        `unexpected generated SGR ${JSON.stringify(sgr)} in ${JSON.stringify(line)}`,
      );
    }
    const text = line.replace(SGR_PATTERN, "");
    assert.ok(!text.includes("\x1b"), `raw ESC outside generated SGR: ${JSON.stringify(line)}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), `control byte in ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(text) <= cols, `band row wider than the banner: ${JSON.stringify(line)}`);
  }
  assert.equal(lines.length, rows, "the band fills exactly the compositor's banner geometry");
  return lines.map((line) => line.replace(SGR_PATTERN, ""));
}

/** Write the band at absolute rows so no row is mis-mapped by wrap-pending state. */
async function drawBand(surface: TerminalSurface, lines: readonly string[]): Promise<void> {
  for (let row = 0; row < lines.length; row += 1) {
    surface.write(`\x1b[${row + 1};1H${lines[row]}`);
  }
  await surface.flush();
}

/** Every styled run of every written row, in row order. */
function allRuns(styles: readonly { runs: readonly TerminalCellRun[] }[]): TerminalCellRun[] {
  return styles.flatMap((line) => [...line.runs]);
}

interface ThemeCase {
  readonly theme: SidebarThemeId;
  /** Packed 0xRRGGBB of the appearance's explicit canvas foreground (Pi's body text). */
  readonly canvasFg: number;
  /** Packed 0xRRGGBB of the `notice` heading foreground (Pi's warning colour). */
  readonly noticeFg: number;
}

const THEME_CASES: readonly ThemeCase[] = [
  { theme: "dark", canvasFg: 0xDEE0E1, noticeFg: 0xCD9A22 },
  { theme: "light", canvasFg: 0x3B3F41, noticeFg: 0x8F6802 },
];

test("the standalone pending-consent band keeps the terminal default ground on both appearances", async () => {
  for (const testCase of THEME_CASES) {
    const palette = sidebarPaletteFor(testCase.theme);
    const cols = 60;
    const rows = 6;
    const { controller } = makeHarness(testCase.theme);
    const band = controller.renderPeerAlert(cols, rows);
    const ground = `\x1b[0m\x1b[${palette.canvas}m`;

    // The SAME finite seam every other host pane uses: every row opens on the
    // appearance's foreground/default canvas, and nothing outside the palette's
    // closed set of roles is emitted.
    for (const line of band.lines) {
      assert.ok(line.startsWith(ground), `${testCase.theme}: band row opens on the pane canvas: ${JSON.stringify(line)}`);
    }
    const codes = new Set(band.lines.flatMap((line) => (line.match(SGR_PATTERN) ?? []).map((sgr) => sgr.slice(2, -1))));
    const allowed = new Set(["0", palette.canvas, palette.notice, palette.secondary, palette.hint]);
    for (const code of codes) {
      assert.ok(allowed.has(code), `${testCase.theme}: band uses only existing palette roles, saw ${code}`);
    }
    assert.ok(codes.has(palette.notice), `${testCase.theme}: the heading still uses the notice role`);
    assert.ok(codes.has(palette.canvas), `${testCase.theme}: the band carries the appearance's canvas`);

    const texts = assertBandSafe(band.lines, cols, rows);
    assert.equal(band.cursor, undefined, "the notification band draws no cursor");
    assert.ok(texts[0].includes("! Incoming connection request"));
    assert.ok(texts.join("\n").includes("name: studio-A"));
    assert.ok(texts.join("\n").includes("key: SHA256:A"));
    assert.ok(texts.join("\n").includes("from: 192.0.2.10:51234"));

    // Real terminal cells: the band sets a readable foreground but leaves the
    // operator's terminal background untouched.
    const surface = new TerminalSurface(cols, rows);
    try {
      await drawBand(surface, band.lines);
      const styles = surface.frame().styles ?? [];
      assert.equal(styles.length, rows, `${testCase.theme}: every band row carries attributes`);
      const runs = allRuns(styles);
      assert.ok(runs.length > 0, `${testCase.theme}: the band painted cells`);
      for (const run of runs) {
        assert.ok(run.fg !== undefined, `${testCase.theme}: band cell ${JSON.stringify(run.text)} has an explicit foreground`);
        assert.equal(run.fg.mode, "rgb", `${testCase.theme}: the band foreground is an exact 24-bit Pi colour`);
        assert.equal(run.bg, undefined,
          `${testCase.theme}: every band cell leaves the background on the terminal default`);
      }
      assert.ok(runs.some((run) => run.fg?.value === testCase.canvasFg),
        `${testCase.theme}: the band's ordinary rows carry the appearance's canvas foreground`);
      // The notice heading keeps the palette's own notice foreground on that
      // terminal-default ground, so the band never emits an unstyled run.
      const heading = styles.find((entry) => entry.line === 0);
      assert.ok(heading !== undefined, `${testCase.theme}: the heading row is read back from cells`);
      const headingRuns = heading.runs;
      assert.ok(headingRuns.map((run) => run.text).join("").includes("! Incoming connection request"),
        `${testCase.theme}: the heading row is the row the cell reader sees`);
      for (const run of headingRuns) {
        if (run.text.trim() === "") continue;
        assert.equal(run.fg?.value, testCase.noticeFg,
          `${testCase.theme}: heading cell ${JSON.stringify(run.text)} keeps the notice role's colour`);
      }
    } finally {
      surface.dispose();
    }
  }
});

test("the ground changes no band geometry: row counts, padded width, and text are unchanged", () => {
  const palette = sidebarPaletteFor("dark");
  const ground = `\x1b[0m\x1b[${palette.canvas}m`;
  for (const cols of [40, 60]) {
    for (let rows = 1; rows <= 8; rows += 1) {
      const { controller } = makeHarness("dark");
      const band = controller.renderPeerAlert(cols, rows);
      const texts = assertBandSafe(band.lines, cols, rows);
      assert.equal(texts.length, rows, `${cols}x${rows}: the band fills its banner geometry`);
      assert.ok(texts[0].includes("! Incoming connection request"), `${cols}x${rows}: heading stays first`);
      // Rows past the band's own content still carry the same foreground/default
      // canvas so the banner's text region stays continuous. The band's own
      // content is at most PEER_CONSENT_ALERT_ROWS (6) rows.
      const contentRows = Math.min(rows, 6);
      for (let row = contentRows; row < rows; row += 1) {
        assert.equal(band.lines[row], `${ground}${" ".repeat(cols)}\x1b[0m`,
          `${cols}x${rows}: padding row ${row} is painted on the canvas`);
        assert.equal(visibleWidth(texts[row]), cols, `${cols}x${rows}: padding row ${row} spans the banner width`);
      }
      // A one-row band still carries no decision control at any width.
      const joined = texts.join("\n");
      assert.ok(!joined.includes("Approve") && !joined.includes("Deny"),
        `${cols}x${rows}: the band still renders no confirmation control`);
    }
  }
});

test("rendering the band still authorizes and changes nothing", () => {
  const { controller, actions } = makeHarness("light");
  const focusBefore = controller.focus;
  const visibleBefore = controller.visible;

  const band = controller.renderPeerAlert(60, 6);
  assert.ok(band.lines.length === 6);

  // No consent frame, no token, no written-frame proof, no action, and no
  // focus/selection/visibility/owner movement: the ground is a colour, not a
  // capability.
  assert.equal(actions.length, 0, "rendering the band emits no action");
  assert.equal(controller.capturePeerConsentPresentation(), undefined, "the band mints no consent frame");
  assert.equal(controller.isPeerConsentRenderCurrent(1), false, "no consent render token exists to be current");
  assert.equal(controller.peerConsentConfirmationActive, false, "no confirmation surface opened");
  assert.equal(controller.focus, focusBefore, "the band never moves focus");
  assert.equal(controller.visible, visibleBefore, "the band never changes pane visibility");
  assert.equal(controller.captureMousePresentation().activateRosterAt(1, 1, 60, 6), false,
    "the band draws no actionable mouse target");
});

test("the roster's reserved band keeps exactly one pane ground (no doubled canvas)", () => {
  const palette = sidebarPaletteFor("dark");
  const { controller } = makeHarness("dark");
  controller.handleInput(TOGGLE);
  assert.equal(controller.visible, true);
  const cols = 60;
  const rows = 24;
  const rendered = controller.renderRoster(cols, rows);
  const raw = rendered.lines.join("\n");
  const texts = assertBandSafe(rendered.lines, cols, rows);
  assert.ok(texts.join("\n").includes("! Incoming connection request"),
    "the roster still reserves its own pending-consent band");
  // The embedded band reads its raw rows and receives the canvas exactly once
  // from its own pane, so the correction cannot stack the ground sequence.
  assert.ok(!raw.includes(`\x1b[${palette.canvas}m\x1b[${palette.canvas}m`),
    "the roster pane applies its canvas to each row once");
});
