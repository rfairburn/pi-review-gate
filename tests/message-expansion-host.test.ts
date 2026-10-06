// Real-host integration coverage for the notification message renderers (#92 phase 2).
//
// Exercises the installed Pi host itself (read-only, never modified):
//
// - the real native `Theme` (receiver-dependent `fg()`),
// - pi-tui's REAL `MouseRegion` constructor/signature and `wrapTextWithAnsi`,
//   injected through the documented `setPiTuiHost` seam (not a fake shaped to an
//   assumed interface),
// - the host's real `CustomMessageComponent`, which re-invokes the registered
//   renderer on every rebuild with `{ expanded, outputPad }` and routes mouse
//   events to the returned component.
//
// This pins the behaviors the unit file cannot: per-message click independence
// through the real MouseRegion, global-flag reconciliation (the host's
// `setExpanded` → rebuild path), width safety via the real ANSI-aware wrapper,
// and the full-native fallback when the renderer returns undefined. The installed
// host is discovered from standard global package roots (or an explicit
// PI_CODING_AGENT_DIR / PI_REVIEW_GATE_INSTALLED_AGENT pin); when none is found
// the file skips with a reason (or fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  setPiTuiHost,
  registerNotificationMessageRenderers,
  type MessageRendererCallback,
} from "../src/message-expansion";
import { setNativeExpansionHost } from "../src/tool-result-hints";
import { registerMissingHostPlaceholder } from "./tool-host-gate";

interface HostBundle {
  agentDir: string;
  agent: {
    initTheme(themeName: string, enableWatcher?: boolean): void;
    CustomMessageComponent: new (
      message: unknown,
      customRenderer: MessageRendererCallback | undefined,
      markdownTheme?: unknown,
      outputPad?: number,
    ) => {
      render(width: number): string[];
      handleMouse(event: Record<string, unknown>): { handled?: boolean } | undefined;
      setExpanded(expanded: boolean): void;
      invalidate(): void;
    };
  };
  tui: {
    visibleWidth(line: string): number;
    wrapTextWithAnsi(text: string, width: number): string[];
    truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;
    MouseRegion: new (child: unknown, handler: (event: unknown) => unknown) => unknown;
    Box: new (
      paddingX: number,
      paddingY: number,
      bgFn?: (text: string) => string,
    ) => unknown;
    KeybindingsManager: new (definitions: Record<string, unknown>) => {
      setUserBindings(bindings: Record<string, string | string[]>): void;
    };
    setKeybindings(manager: unknown): void;
    getKeybindings(): unknown;
  };
  keyHint(keybinding: string, description: string): string;
  keyText(keybinding: string): string;
  coreKeybindings: { KEYBINDINGS: Record<string, unknown> };
}

function discoverInstalledHost(): HostBundle | undefined {
  const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  const agentDirs = pinned
    ? [path.resolve(pinned)]
    : [
        process.env.PI_CODING_AGENT_DIR,
        "/opt/homebrew/lib/node_modules",
        "/usr/local/lib/node_modules",
        path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
      ]
        .filter((dir): dir is string => typeof dir === "string" && dir.length > 0)
        .map((root) => path.join(root, "@earendil-works", "pi-coding-agent"));
  for (const agentDir of agentDirs) {
    if (!fs.existsSync(path.join(agentDir, "package.json"))) continue;
    try {
      const req = createRequire(path.join(agentDir, "node_modules", "__pi_host_anchor__.js"));
      const agent = req(path.join(agentDir, "dist", "index.js"));
      const tui = req("@earendil-works/pi-tui");
      if (typeof agent?.CustomMessageComponent !== "function" || typeof tui?.MouseRegion !== "function"
    || typeof tui?.Box !== "function") continue;
      const coreKeybindings = req(path.join(agentDir, "dist", "core", "keybindings.js"));
      return { agentDir, agent, tui, keyHint: agent.keyHint, keyText: agent.keyText, coreKeybindings } as HostBundle;
    } catch {
      // Unreadable installation: try the next candidate.
    }
  }
  return undefined;
}

const host = discoverInstalledHost();
const SKIP_REASON =
  "installed Pi host not found (set PI_CODING_AGENT_DIR to a node_modules root containing @earendil-works/pi-coding-agent)";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

if (!host) {
  registerMissingHostPlaceholder("real-host notification renderer coverage", SKIP_REASON);
} else {
  const h = host; // narrowed for the closures below
  h.agent.initTheme("dark", false); // built-in theme JSON, no watcher
  // Inject the installed host's REAL pi-tui helpers (MouseRegion + wrapTextWithAnsi)
  // and the real native keybinding helpers so the shared core's header hint
  // resolves exactly as it does for tool rows.
  setPiTuiHost({
    wrapTextWithAnsi: h.tui.wrapTextWithAnsi,
    MouseRegion: h.tui.MouseRegion as never,
    // The real pi-tui Box: the notification card's native boundary component.
    Box: h.tui.Box as never,
    // The real ANSI-aware cell truncator used by the degenerate-width path.
    truncateToWidth: h.tui.truncateToWidth as never,
  });
  // The native hint resolves the configured `app.tools.expand` binding through
  // pi-tui's global KeybindingsManager; install it (defaults) so keyText/keyHint
  // resolve exactly as in the interactive host.
  const manager = new h.tui.KeybindingsManager(h.coreKeybindings.KEYBINDINGS);
  h.tui.setKeybindings(manager);
  setNativeExpansionHost({
    keyHint: h.keyHint,
    keyText: h.keyText,
    visibleWidth: h.tui.visibleWidth,
    wrapTextWithAnsi: h.tui.wrapTextWithAnsi,
  });

  const registered = new Map<string, MessageRendererCallback>();
  assert.equal(
    registerNotificationMessageRenderers({
      registerMessageRenderer: (type: string, cb: MessageRendererCallback) => { registered.set(type, cb); },
    }),
    true,
    "registration succeeds against a host with the API",
  );

  const realTheme = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ] as {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
  } | undefined;
  assert.ok(realTheme && typeof realTheme.fg === "function" && typeof realTheme.bg === "function", "initTheme installed the real native Theme with fg/bg");

  // The CURRENT ANSI for one theme token, resolved through the real native
  // theme at assertion time (never a constant copied from earlier work).
  function tokenFgOpen(color: string): string {
    const styled = realTheme!.fg(color, "");
    return styled.slice(0, styled.length - "\x1b[39m".length);
  }
  function tokenBgOpen(color: string): string {
    const styled = realTheme!.bg(color, "");
    return styled.slice(0, styled.length - "\x1b[49m".length);
  }

  // Each scenario gets its OWN message object: the per-message expansion state
  // is keyed by the message object (by design a clicked message stays expanded
  // across re-renders), so scenarios must not share an object or they inherit
  // each other's clicked state.
  function bgShellMessage(label = "build", id = "job-42") {
    return {
      role: "custom",
      customType: "pi-review-bg-shell",
      content: [
        `background job "${label}" (${id}) — exit`,
        "command: npm run build",
        "running: 12s · exit 1",
        "",
        "last 1 of 3 lines:",
        "```",
        "error TS2304: cannot find name",
        "```",
      ].join("\n"),
      display: true,
      details: { id, kind: "exit" },
    };
  }

  function makeRow(type: string, message: unknown) {
    const renderer = registered.get(type);
    assert.ok(renderer, `a renderer was registered for ${type}`);
    return new h.agent.CustomMessageComponent(message, renderer);
  }

  function clickOnLine(comp: ReturnType<typeof makeRow>, marker: string) {
    const lines = comp.render(100);
    const y = lines.findIndex((line) => stripAnsi(line).includes(marker));
    assert.ok(y >= 0, `a rendered line containing "${marker}" exists`);
    return comp.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 100, height: lines.length });
  }

  test("real theme receiver preserved: the renderer styles through the native Theme without throwing", () => {
    // The production bug shape: a standalone fg() call (receiver lost) throws.
    const rawFg = realTheme!.fg as unknown as (color: string, text: string) => string;
    assert.throws(() => rawFg("muted", "("));
    // Through the registered renderer the real theme styles the collapsed row.
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    const rendered = comp.render(100);
    assert.ok(rendered.some((line) => stripAnsi(line).includes("[bg-shell] build (job-42)")), "collapsed row renders");
    assert.ok(rendered.some((line) => line.includes("\x1b[")), "the real theme applies ANSI styling");
  });

  // ── Native card boundary (#92 styling correction) ─────────────────────
  // These assertions establish the ACTUAL card background — the real Box fill,
  // padding rows, and width filling — not merely stripped text.

  /**
   * The host's `CustomMessageComponent` renders its own native Spacer row above
   * the card (inter-message spacing, OUTSIDE the card boundary): the leading
   * empty row of every render. Everything after it is the themed card.
   */
  function cardRowsOf(comp: ReturnType<typeof makeRow>): string[] {
    const rows = comp.render(80);
    assert.ok(rows.length > 1 && rows[0] === "", "the native Spacer row precedes the card");
    return rows.slice(1);
  }

  const compactSubtaskMessage = {
    role: "custom", customType: "pi-review-subtask-event",
    content: "Task: t-1 · Do the styled work · landed\nExecution exec-1 COMPLETE: 1/1 tasks landed.\nFull report: /tmp/reports/styled.md",
    display: true, details: { state: "landed", executionId: "exec-1" },
  };

  test("native card: every row of BOTH states fills the width with the REAL customMessageBg token and 1-cell padding", () => {
    const comp = makeRow("pi-review-subtask-event", compactSubtaskMessage);
    for (const state of [false, true]) {
      comp.setExpanded(state);
      const rows = cardRowsOf(comp);
      assert.ok(rows.length > 2, `state ${state}: card has content rows plus the blank padding rows`);
      for (const row of rows) {
        // Width fill: the Box pads EVERY row (content, hint, and blank padding)
        // to the full terminal width with the background applied.
        assert.equal(h.tui.visibleWidth(row), 80, `state ${state}: row fills the width: ${JSON.stringify(row)}`);
        // The background is the real theme's customMessageBg token (not a
        // hard-coded color): the row opens with it and closes its reset last.
        assert.ok(row.startsWith(tokenBgOpen("customMessageBg")), `state ${state}: row carries the customMessageBg token: ${JSON.stringify(row.slice(0, 40))}`);
        assert.ok(row.endsWith("\x1b[49m"), `state ${state}: background reset closes the row`);
      }
      // The original native one-cell horizontal/vertical padding: the first and
      // last rows are blank background rows, and content starts at column 2.
      assert.equal(stripAnsi(rows[0]!).trim(), "", `state ${state}: blank top padding row`);
      assert.equal(stripAnsi(rows[rows.length - 1]!).trim(), "", `state ${state}: blank bottom padding row`);
    }
  });

  test("native card: label and body follow the customMessageLabel/customMessageText fg tokens", () => {
    const comp = makeRow("pi-review-subtask-event", compactSubtaskMessage);
    const rows = cardRowsOf(comp).map(stripAnsi);
    const headerIndex = rows.findIndex((line) => line.includes("[subtask] Do the styled work"));
    assert.ok(headerIndex >= 0, "compact header present");
    const reportIndex = rows.findIndex((line) => line.includes("Full report: /tmp/reports/styled.md"));
    assert.ok(reportIndex >= 0, "report line present");
    // Header card label: the native customMessageLabel token (bold label), and
    // the report line: the native customMessageText body token — both resolved
    // through the REAL theme (verified against its own token output).
    const labelOpen = tokenFgOpen("customMessageLabel");
    const textOpen = tokenFgOpen("customMessageText");
    const styledRows = cardRowsOf(comp);
    const bgOpen = tokenBgOpen("customMessageBg");
    assert.ok(styledRows[headerIndex]!.startsWith(`${bgOpen} ${labelOpen}`), "header label opens with the real customMessageLabel token");
    assert.ok(styledRows[reportIndex]!.startsWith(`${bgOpen} ${textOpen}`), "body row opens with the real customMessageText token");
  });

  test("native card: expansion keeps the themed card; a re-click contracts to the identical card", () => {
    const comp = makeRow("pi-review-subtask-event", compactSubtaskMessage);
    const collapsed = cardRowsOf(comp);
    clickOnLine(comp, "[subtask] Do the styled work");
    // Expanded stays in the SAME themed boundary (full text on the card).
    const expanded = cardRowsOf(comp);
    assert.ok(expanded.some((row) => stripAnsi(row).includes("Task: t-1 · Do the styled work · landed")), "expanded shows the full retained text");
    for (const row of expanded) {
      assert.ok(row.startsWith(tokenBgOpen("customMessageBg")) && h.tui.visibleWidth(row) === 80, "expanded row keeps the themed full-width card");
    }
    clickOnLine(comp, "Task: t-1 · Do the styled work");
    assert.deepEqual(cardRowsOf(comp), collapsed, "re-click contracts to the byte-identical collapsed card");
  });

  test("native card: blank card padding rows and card edges still toggle ONLY that message", () => {
    const comp = makeRow("pi-review-subtask-event", compactSubtaskMessage);
    const rows = cardRowsOf(comp);
    // A click on the blank TOP PADDING row (card edge, not content) toggles it.
    // (y is in the FULL render: the leading native Spacer row is y=0, so the
    // card's own top padding row is y=1.)
    const top = comp.handleMouse({ type: "click", button: "left", x: 0, y: 1, screenX: 0, screenY: 1, width: 80, height: rows.length + 1 });
    assert.equal(top?.handled, true, "card padding-row click is handled by the card");
    assert.ok(cardRowsOf(comp).some((line) => stripAnsi(line).includes("Task: t-1 · Do the styled work · landed")), "padding click expanded that card");
    // A click on the bottom blank padding row contracts it again.
    const bottomY = cardRowsOf(comp).length; // last card row index in the full render
    const bottom = comp.handleMouse({ type: "click", button: "left", x: 79, y: bottomY, screenX: 79, screenY: bottomY, width: 80, height: bottomY + 1 });
    assert.equal(bottom?.handled, true, "bottom padding-row click is handled by the card");
    assert.ok(!cardRowsOf(comp).some((line) => stripAnsi(line).includes("Task: t-1 · Do the styled work · landed")), "padding click contracted that card");
  });

  test("native card: width-correct at narrow widths in both states", () => {
    const comp = makeRow("pi-review-subtask-event", compactSubtaskMessage);
    for (const width of [0, 1, 2, 3, 10, 20, 40]) {
      for (const state of [false, true]) {
        comp.setExpanded(state);
        // Skip the native Spacer row: only the card rows are width-filled.
        const rows = comp.render(width).slice(1);
        if (width === 0) {
          assert.equal(rows.length, 0, `width 0/${state ? "expanded" : "collapsed"}: no cell to render into`);
          continue;
        }
        for (const row of rows) {
          assert.equal(h.tui.visibleWidth(row), width, `width ${width}/${state ? "expanded" : "collapsed"}: row fills exactly: ${JSON.stringify(row)}`);
          assert.ok(row.startsWith(tokenBgOpen("customMessageBg")), `width ${width}/${state ? "expanded" : "collapsed"}: themed row`);
        }
      }
    }
    // The ordinary widths keep the native one-cell padding (blank rows around
    // the content); the degenerate widths keep the same background without the
    // impossible horizontal padding.
    comp.setExpanded(false);
    assert.equal(stripAnsi(comp.render(40).slice(1)[0]!).trim(), "", "width 40: blank top padding row (native padding kept)");
    assert.equal(stripAnsi(comp.render(3).slice(1)[0]!).trim(), "", "width 3: blank top padding row still rendered");
  });

  test("native card: degenerate widths stay cell-safe with wide-glyph retained content in compact, expanded, and historical-fallback states", () => {
    // Wide graphemes cannot fit one cell: the row must clip rather than
    // overflow (the box padding must also collapse, never spill). Covers the
    // compact recognized event, the expanded full text of the same message,
    // and the full-text historical fallback (unrecognized content).
    const wide = { role: "custom", customType: "pi-review-subtask-event",
      content: "Task: t-你 · 宽 task title · reported\nFull report: /tmp/你.md",
      display: true, details: { state: "reported", executionId: "exec-你" } };
    const historical = { role: "custom", customType: "pi-review-subtask-event",
      content: "unrecognized 你 historical shape 你 here 😀",
      display: true };
    const comps = [
      makeRow("pi-review-subtask-event", wide),
      makeRow("pi-review-subtask-event", historical),
    ];
    for (const comp of comps) {
      for (const state of [false, true]) {
        comp.setExpanded(state);
        for (const width of [0, 1, 2, 3]) {
          for (const row of comp.render(width)) {
            assert.ok(h.tui.visibleWidth(row) <= width, `width ${width}/${state ? "expanded" : "collapsed"}: row never exceeds (got ${JSON.stringify(row)})`);
          }
          if (width >= 1) {
            const rows = comp.render(width).slice(1);
            assert.equal(rows.every((row) => h.tui.visibleWidth(row) === width), true, `width ${width}/${state ? "expanded" : "collapsed"}: themed rows fill exactly`);
          } else {
            assert.equal(comp.render(width).slice(1).length, 0, "width 0 renders no card rows");
          }
        }
      }
    }
  });

  test("native card: padded path clips graphemes wider than two cells", () => {
    const glyph = "क्षि";
    assert.equal(h.tui.visibleWidth(glyph), 3, "real host measures this Indic grapheme as three cells");
    const messages = [
      {
        role: "custom", customType: "pi-review-subtask-event",
        content: [`Task: t-1 · ${glyph} · reported`, "Full report: /tmp/report.md"].join("\n"),
        display: true, details: { state: "reported", executionId: "exec-1" },
      },
      {
        role: "custom", customType: "pi-review-subtask-event",
        content: `unrecognized ${glyph} historical shape`, display: true,
      },
    ];
    for (const message of messages) {
      const comp = makeRow("pi-review-subtask-event", message);
      for (const expanded of [false, true]) {
        comp.setExpanded(expanded);
        for (const width of [1, 2, 3, 4, 10]) {
          for (const row of comp.render(width).slice(1)) {
            assert.equal(h.tui.visibleWidth(row), width,
              `state ${expanded ? "expanded" : "compact"}, width ${width}: ${JSON.stringify(row)}`);
            assert.ok(row.includes(tokenBgOpen("customMessageBg")), "clipped row retains the themed background");
            assert.ok(row.endsWith("\x1b[49m"), "card background closes at the row boundary");
          }
        }
      }
    }
  });

  test("native card: clipped wide glyph restores the background before the padding cell", () => {
    const comp = makeRow("pi-review-subtask-event", {
      role: "custom", customType: "pi-review-subtask-event",
      content: "你", display: true,
    });
    for (const expanded of [false, true]) {
      comp.setExpanded(expanded);
      const rows = comp.render(1).slice(1);
      assert.ok(rows.some((row) => row.includes("\x1b[0m")),
        "real host truncator emitted a reset for the clipped glyph");
      assert.ok(rows.some((row) => row.includes(
        `\x1b[0m${tokenBgOpen("customMessageBg")} `)),
        "background is restored before the padding cell is painted");
    }
  });

  test("native card: colors follow the ACTIVE theme — in-place token change restyles the same component, rebuild rebinds", () => {
    // A live token table the renderers resolve through — never a snapshot.
    const table: Record<string, string> = {
      customMessageBg: "\x1b[48;5;17m",
      customMessageText: "\x1b[38;5;51m",
      customMessageLabel: "\x1b[38;5;201m",
      muted: "",
      success: "",
      error: "",
      warning: "",
      accent: "",
    };
    const liveTheme = {
      bold: (text: string): string => text,
      fg: (color: string, text: string): string => (table[color] === undefined ? text : `${table[color]}${text}\x1b[39m`),
      bg: (color: string, text: string): string => (table[color] === undefined ? text : `${table[color]}${text}\x1b[49m`),
    };
    const renderer = registered.get("pi-review-bg-shell")!;
    const comp = renderer(bgShellMessage(), { expanded: false, outputPad: 1 }, liveTheme) as { render(width: number): string[] };
    const before = comp.render(80);
    assert.ok(before.every((row) => row.startsWith("\x1b[48;5;17m")), "initial rows use theme variant A's customMessageBg");
    // In-place theme change (the way a theme switch updates token tables):
    // the SAME component restyles on the next render — no ANSI snapshot.
    table.customMessageBg = "\x1b[48;5;18m";
    table.customMessageText = "\x1b[38;5;87m";
    const after = comp.render(80);
    assert.ok(after.every((row) => row.startsWith("\x1b[48;5;18m")), "rows restyle with theme variant B's customMessageBg");
    assert.ok(after.some((row) => row.includes("\x1b[38;5;87m")), "body text restyles with theme variant B's customMessageText");
    assert.ok(!after.some((row) => row.includes("\x1b[48;5;17m")), "variant A's background ANSI is gone");
    // A rebuild with a DIFFERENT theme object rebinds: a fresh renderer call
    // with theme C produces its own colors (and keeps the same message state).
    const themeC = { ...liveTheme, bg: (color: string, text: string): string => `\x1b[48;5;19m${text}\x1b[49m` };
    const rebuilt = (registered.get("pi-review-bg-shell")!)((bgShellMessage("build", "job-c")), { expanded: false, outputPad: 1 }, themeC) as { render(width: number): string[] };
    assert.ok(rebuilt.render(80).every((row) => row.startsWith("\x1b[48;5;19m")), "a rebuilt row follows the new theme object's customMessageBg");
  });

  test("shared core adds exactly one native header hint to a message row (both states)", () => {
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    const collapsed = comp.render(100).map(stripAnsi);
    assert.equal(collapsed.join("\n").split("to expand").length - 1, 1, "exactly one collapsed hint");
    comp.setExpanded(true);
    const expanded = comp.render(100).map(stripAnsi);
    assert.equal(expanded.join("\n").split("to collapse").length - 1, 1, "exactly one expanded hint");
  });

  test("real MouseRegion: a left click expands only that message; re-click contracts", () => {
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    const collapsed = comp.render(100).map(stripAnsi);
    assert.ok(collapsed.some((line) => line.includes("[bg-shell] build (job-42)")), "collapsed summary present");
    // The collapsed view is the concise summary + bounded excerpt, not the full
    // body (the raw head line is replaced by the [bg-shell] header).
    assert.equal(collapsed.some((line) => line.includes("background job")), false, "raw payload head hidden when collapsed");
    assert.ok(collapsed.some((line) => line.includes("error TS2304: cannot find name")), "failed-job diagnostic excerpt is visible when collapsed");

    const res = clickOnLine(comp, "[bg-shell] build (job-42)");
    assert.equal(res?.handled, true, "the real MouseRegion handled the click");
    const expanded = comp.render(100).map(stripAnsi);
    assert.ok(expanded.some((line) => line.includes("background job")), "expanded view shows the complete notification text");

    // Re-click contracts back to the identical collapsed presentation. The
    // expanded view is the full content (no collapsed header), so click a marker
    // present in the expanded text — the region owns the whole row in both states.
    const resAgain = clickOnLine(comp, "background job");
    assert.equal(resAgain?.handled, true);
    assert.deepEqual(comp.render(100).map(stripAnsi), collapsed, "re-click restores the identical collapsed row");
  });

  test("real MouseRegion: clicking one message does not toggle a neighbor", () => {
    const compA = makeRow("pi-review-bg-shell", bgShellMessage("build", "job-42"));
    const compB = makeRow("pi-review-bg-shell", bgShellMessage("test", "job-43"));
    const initialB = compB.render(100).map(stripAnsi);

    clickOnLine(compA, "[bg-shell] build (job-42)");
    assert.ok(compA.render(100).some((line) => stripAnsi(line).includes("error TS2304")), "A expanded by its own click");
    assert.deepEqual(compB.render(100).map(stripAnsi), initialB, "neighbor B is byte-identical to before A's click");
  });

  test("global-flag reconciliation: the host setExpanded path flips the message", () => {
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    const collapsed = comp.render(100).map(stripAnsi);
    comp.setExpanded(true); // the host's app.tools.expand effect (setToolsExpanded -> rebuild)
    const expanded = comp.render(100).map(stripAnsi);
    assert.ok(expanded.some((line) => line.includes("error TS2304: cannot find name")), "global expand shows full text");
    comp.setExpanded(false);
    assert.deepEqual(comp.render(100).map(stripAnsi), collapsed, "global collapse restores the identical row");
  });

  test("width safety: no custom row exceeds the terminal width via the real ANSI-aware wrapper", () => {
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    for (const width of [10, 20, 40]) {
      for (const state of [false, true]) {
        comp.setExpanded(state);
        const rows = comp.render(width).map(stripAnsi);
        for (const row of rows) {
          assert.ok(h.tui.visibleWidth(row) <= width, `width ${width}/${state ? "expanded" : "collapsed"}: row fits: ${JSON.stringify(row)}`);
        }
      }
    }
  });

  test("full-native fallback: a renderer returning undefined hands back to the host default box", () => {
    // With no pi-tui wrap helper the registered renderer returns undefined, so
    // the host's default label + full-Markdown box renders (no over-width custom output).
    setPiTuiHost({}); // clear the wrap helper; keep nothing
    try {
      const comp = makeRow("pi-review-bg-shell", bgShellMessage());
      const rendered = comp.render(100).map(stripAnsi);
      assert.ok(rendered.some((line) => line.includes("background job")), "the host default box shows the full content");
    } finally {
      // Restore the real helpers for any later tests in this process.
      setPiTuiHost({
        wrapTextWithAnsi: h.tui.wrapTextWithAnsi,
        MouseRegion: h.tui.MouseRegion as never,
        Box: h.tui.Box as never,
        truncateToWidth: h.tui.truncateToWidth as never,
      });
    }
  });

  test("global expand/collapse after local clicks reconciles per-message state", () => {
    const compA = makeRow("pi-review-bg-shell", bgShellMessage("build", "job-42"));
    const compB = makeRow("pi-review-bg-shell", bgShellMessage("test", "job-43"));
    // A local click expands only A (the full body, including the raw head line).
    clickOnLine(compA, "[bg-shell] build (job-42)");
    assert.ok(compA.render(100).some((l) => stripAnsi(l).includes("background job")), "A locally expanded (full body)");
    assert.ok(!compB.render(100).some((l) => stripAnsi(l).includes("background job")), "B still collapsed");
    // Global expand: both A and B expand.
    compA.setExpanded(true);
    compB.setExpanded(true);
    assert.ok(compA.render(100).some((l) => stripAnsi(l).includes("background job")), "A expanded (global)");
    assert.ok(compB.render(100).some((l) => stripAnsi(l).includes("background job")), "B expanded (global)");
    // Global collapse reconciles A's local click back to the global flag.
    compA.setExpanded(false);
    compB.setExpanded(false);
    assert.ok(!compA.render(100).some((l) => stripAnsi(l).includes("background job")), "A collapsed (global reconciliation)");
    assert.ok(!compB.render(100).some((l) => stripAnsi(l).includes("background job")), "B collapsed (global)");
  });

  test("repeated invalidate/rebuild preserves the clicked expansion state", () => {
    const comp = makeRow("pi-review-bg-shell", bgShellMessage());
    clickOnLine(comp, "[bg-shell] build (job-42)");
    assert.ok(comp.render(100).some((l) => stripAnsi(l).includes("error TS2304")), "expanded after click");
    for (let i = 0; i < 5; i++) comp.invalidate();
    assert.ok(comp.render(100).some((l) => stripAnsi(l).includes("error TS2304")), "still expanded after repeated invalidations");
  });

  test("a reconstructed (restored) message object starts collapsed and expands cleanly", () => {
    // Simulate session restore: a fresh object with the same stored data.
    const restored = JSON.parse(JSON.stringify(bgShellMessage("build", "job-42")));
    const comp = makeRow("pi-review-bg-shell", restored);
    const collapsed = comp.render(100).map(stripAnsi);
    assert.ok(collapsed.some((l) => l.includes("[bg-shell] build (job-42)")), "restored message renders collapsed");
    clickOnLine(comp, "[bg-shell] build (job-42)");
    assert.ok(comp.render(100).some((l) => stripAnsi(l).includes("error TS2304")), "restored message expands on click");
  });

  test("a nondefault app.tools.expand binding is reflected in the hint", () => {
    const previous = h.tui.getKeybindings();
    try {
      const custom = { ...h.coreKeybindings.KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+e", description: "Toggle expansion" } };
      h.tui.setKeybindings(new h.tui.KeybindingsManager(custom));
      const comp = makeRow("pi-review-bg-shell", bgShellMessage());
      const collapsed = comp.render(100).map(stripAnsi).join("\n");
      assert.ok(collapsed.includes("ctrl+e"), `hint reflects the custom binding: ${collapsed}`);
    } finally {
      if (previous) h.tui.setKeybindings(previous);
      else h.tui.setKeybindings(new h.tui.KeybindingsManager(h.coreKeybindings.KEYBINDINGS));
    }
  });

  test("long research completion: collapsed keeps the full report reference; expanded is byte-complete", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: a detailed observation about the system under test that runs on for a while.`).join("\n");
    const message = {
      role: "custom", customType: "pi-review-subtask-event",
      content: `Task: t-3 · Research topic · reported\nExecution exec-1 COMPLETE: 1/2 tasks reported.\nFull report: /tmp/reports/deep-dive.md\n\n${body}`,
      display: true, details: { state: "reported", executionId: "exec-1" },
    };
    const comp = makeRow("pi-review-subtask-event", message);
    const collapsed = comp.render(100).map(stripAnsi).join("\n");
    assert.ok(collapsed.includes("Full report: /tmp/reports/deep-dive.md"), "collapsed keeps the full report reference (unshortened)");
    assert.ok(!collapsed.includes("Finding 40:"), "collapsed does not inline the long report body");
    clickOnLine(comp, "[subtask] Research topic");
    const expanded = comp.render(100).map(stripAnsi).join("\n");
    for (const needle of ["Task: t-3 · Research topic · reported", "Finding 1:", "Finding 40: a detailed observation about the system under test that runs on for a while."]) {
      assert.ok(expanded.includes(needle), `expanded contains: ${needle.slice(0, 40)}`);
    }
  });
}
