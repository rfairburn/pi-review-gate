// Real-host integration coverage for the shared native expansion hints (#93).
//
// Unlike tests/tool-result-hints.test.ts (which pins the contract with fakes),
// this file exercises the installed Pi host itself — read-only, never
// modified:
//
// - the real native `Theme` (receiver-dependent `fg()`),
// - the real `keyHint()`/`keyText()` helpers and pi-tui's global
//   KeybindingsManager (defaults + user-override resolution),
// - the real `ToolExecutionComponent` with its native per-card MouseRegion,
//   driven through pi-tui's own Container/Box mouse routing,
// - the native keyboard expansion effect (`setExpanded` on every row, exactly
//   what interactive-mode.js applies for the `app.tools.expand` keypress),
// - the host's regular-vs-fullscreen mouse design (regular mode parses no raw
//   mouse input: keyboard-only).
//
// The installed host is discovered from standard global package roots (or an
// explicit PI_CODING_AGENT_DIR override pointing at a node_modules root that
// contains @earendil-works/pi-coding-agent). When no installation is found the
// whole file skips with a reason instead of fabricating coverage.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandableResult, type ToolResultRenderCallback } from "../src/tool-result-expansion";
import { setNativeExpansionHost, withExpansionHint, type ToolResultViewComponent } from "../src/tool-result-hints";
import { WebToolManager } from "../src/web/tools";
import { normalizeConfig } from "../src/config";

// ── Installed-host discovery (read-only) ─────────────────────────────────

interface HostBundle {
  agentDir: string;
  req: NodeRequire;
  agent: {
    initTheme(themeName: string, enableWatcher?: boolean): void;
    keyHint(keybinding: string, description: string): string;
    keyText(keybinding: string): string;
    ToolExecutionComponent: new (
      toolName: string,
      toolCallId: string,
      args: unknown,
      options: Record<string, unknown>,
      toolDefinition: { name: string; renderResult: ToolResultRenderCallback },
      ui: { requestRender(): void },
      cwd: string,
    ) => {
      expanded: boolean;
      resultRendererComponent?: { handleMouse?: unknown; handleInput?: unknown };
      updateResult(result: unknown, isPartial?: boolean): void;
      setExpanded(expanded: boolean): void;
      invalidate(): void;
      render(width: number): string[];
      handleMouse(event: Record<string, unknown>): { handled?: boolean } | undefined;
    };
  };
  tui: {
    KeybindingsManager: new (definitions: Record<string, unknown>) => {
      setUserBindings(bindings: Record<string, string | string[]>): void;
    };
    setKeybindings(manager: unknown): void;
    getKeybindings(): { getKeys(id: string): string[] };
    visibleWidth(line: string): number;
    wrapTextWithAnsi(text: string, width: number): string[];
    TuiMainScreen: new (...args: unknown[]) => unknown;
    TuiAltScreen: new (...args: unknown[]) => unknown;
  };
  coreKeybindings: { KEYBINDINGS: Record<string, unknown> };
}

function discoverInstalledHost(): HostBundle | undefined {
  const candidates = [
    process.env.PI_CODING_AGENT_DIR,
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
  ].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  for (const root of candidates) {
    const agentDir = path.join(root, "@earendil-works", "pi-coding-agent");
    if (!fs.existsSync(path.join(agentDir, "package.json"))) continue;
    // Anchor inside the agent package so both the agent and its own nested
    // pi-tui resolve to the installed host's copies (same module instances).
    const req = createRequire(path.join(agentDir, "node_modules", "__pi_host_anchor__.js"));
    try {
      // The package exports map has no require condition for ".", so the main
      // entry is loaded by file path; subpaths likewise.
      const agent = req(path.join(agentDir, "dist", "index.js"));
      const tui = req("@earendil-works/pi-tui");
      if (typeof agent?.keyHint !== "function" || typeof tui?.visibleWidth !== "function") continue;
      const coreKeybindings = req(path.join(agentDir, "dist", "core", "keybindings.js"));
      return { agentDir, req, agent, tui, coreKeybindings } as HostBundle;
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
  test("real-host integration coverage", { skip: SKIP_REASON }, () => {});
} else {
  // ── One-time real-host setup (this file runs in its own process) ───────
  const h = host; // narrowed for the closures below
  h.agent.initTheme("dark", false); // built-in theme JSON, no watcher
  const manager = new h.tui.KeybindingsManager(h.coreKeybindings.KEYBINDINGS);
  h.tui.setKeybindings(manager); // the global slot keyText()/keyHint() read
  // Inside Pi the extension loader aliases these packages; in this test
  // process the documented seam receives the installed host's own helpers.
  setNativeExpansionHost({
    keyHint: h.agent.keyHint,
    keyText: h.agent.keyText,
    visibleWidth: h.tui.visibleWidth,
    wrapTextWithAnsi: h.tui.wrapTextWithAnsi,
  });

  const ui = { requestRender() {} };
  const toolA: ToolResultRenderCallback = expandableResult(
    () => ({ render: () => ["Card A header", "collapsed body A"], invalidate() {} }),
    () => ({ render: () => ["Card A header", "full detail A"], invalidate() {} }),
  );
  const toolB: ToolResultRenderCallback = expandableResult(
    () => ({ render: () => ["Card B header", "collapsed body B"], invalidate() {} }),
    () => ({ render: () => ["Card B header", "full detail B"], invalidate() {} }),
  );
  const valueA = { content: [{ type: "text", text: "summary A" }], isError: false, details: {} };
  const valueB = { content: [{ type: "text", text: "summary B" }], isError: false, details: {} };

  function makeRow(label: string, tool: ToolResultRenderCallback, value: unknown, args: unknown = { command: `echo ${label}` }) {
    const comp = new h.agent.ToolExecutionComponent(
      label,
      `call-${label}`,
      args,
      {},
      { name: label, renderResult: tool },
      ui,
      os.tmpdir(),
    );
    comp.updateResult(value, false);
    return comp;
  }

  // Click the rendered line containing `marker` through the component's own
  // native mouse routing (Container/Box -> MouseRegion), exactly as the
  // fullscreen host dispatches a pointer event at that row.
  function clickOnLine(comp: ReturnType<typeof makeRow>, marker: string) {
    const lines = comp.render(100);
    const y = lines.findIndex((line) => stripAnsi(line).includes(marker));
    assert.ok(y >= 0, `a rendered line containing "${marker}" exists`);
    return comp.handleMouse({
      type: "click",
      button: "left",
      x: 3,
      y,
      screenX: 3,
      screenY: y,
      width: 100,
      height: lines.length,
    });
  }

  test("the real native Theme works end-to-end (receiver-dependent fg preserved)", () => {
    const themeInstance = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@earendil-works/pi-coding-agent:theme")
    ] as { fg(color: string, text: string): string } | undefined;
    assert.ok(themeInstance && typeof themeInstance.fg === "function", "initTheme installed the real native Theme");
    // The production bug shape: the raw method without its receiver throws.
    const rawFg = themeInstance!.fg as unknown as (color: string, text: string) => string;
    assert.throws(() => rawFg("muted", "("));
    // Through expandableResult the hint resolves and styles correctly.
    const comp = toolA(valueA, { expanded: false, isPartial: false }, themeInstance) as ToolResultViewComponent;
    const line = comp.render(200)[0]!;
    assert.equal(stripAnsi(line), "Card A header (ctrl+o to expand)");
    assert.ok(line.includes("\x1b["), "the host-styled hint carries ANSI styling from the real theme/keyHint");
  });

  test("real ToolExecutionComponent: per-card click toggles only that card; re-click contracts", () => {
    const compA = makeRow("Card A", toolA, valueA);
    const compB = makeRow("Card B", toolB, valueB);

    const initialA = compA.render(100);
    assert.ok(initialA.some((line) => stripAnsi(line).includes("Card A header (ctrl+o to expand)")));
    // No competing handler: the native per-card MouseRegion owns the click.
    assert.equal(typeof compA.resultRendererComponent?.handleMouse, "undefined");

    const resA = clickOnLine(compA, "Card A header");
    assert.equal(resA?.handled, true, "the native region handled the click");
    assert.equal(compA.expanded, true);
    assert.equal(compB.expanded, false, "clicking A must not change neighboring card B");

    const aExpanded = compA.render(100).map(stripAnsi);
    assert.ok(aExpanded.some((line) => line.includes("Card A header (ctrl+o to collapse)")));
    // The native Box pads every line, so match by containment.
    assert.ok(aExpanded.some((line) => line.includes("full detail A")), "the expanded detail renders through the real component");

    // Re-click: contracts back to the identical initial presentation.
    const resAgain = clickOnLine(compA, "Card A header");
    assert.equal(resAgain?.handled, true);
    assert.equal(compA.expanded, false);
    assert.deepEqual(compA.render(100), initialA);

    // Click B: only B toggles; A stays contracted.
    const resB = clickOnLine(compB, "Card B header");
    assert.equal(resB?.handled, true);
    assert.equal(compB.expanded, true);
    assert.deepEqual(compA.render(100), initialA);

    // Non-click mouse events never toggle through the native region.
    const lines = compA.render(100);
    const y = lines.findIndex((line) => stripAnsi(line).includes("Card A header"));
    const moved = compA.handleMouse({ type: "move", button: "left", x: 3, y, screenX: 3, screenY: y, width: 100, height: lines.length });
    assert.equal(moved, undefined);
    assert.equal(compA.expanded, false);
  });

  test("native keyboard semantics: the app.tools.expand keypress flips every row together", () => {
    // interactive-mode.js (pi 0.85.1): the `app.tools.expand` action runs
    // toggleToolOutputExpansion() -> setToolsExpanded(expanded), which applies
    // child.setExpanded(expanded) to every expandable row in lockstep. This
    // reproduces that exact per-row effect on real components.
    const isExpandable = (value: unknown): boolean =>
      typeof value === "object" && value !== null
      && "setExpanded" in value
      && typeof (value as { setExpanded?: unknown }).setExpanded === "function";

    const compA = makeRow("Card A", toolA, valueA);
    const compB = makeRow("Card B", toolB, valueB);
    for (const target of [true, false]) {
      for (const comp of [compA, compB]) if (isExpandable(comp)) comp.setExpanded(target);
      const expected = target ? "(ctrl+o to collapse)" : "(ctrl+o to expand)";
      assert.ok(compA.render(100).some((line) => stripAnsi(line).includes(`Card A header ${expected}`)));
      assert.ok(compB.render(100).some((line) => stripAnsi(line).includes(`Card B header ${expected}`)));
    }
  });

  test("a user keybinding override is honored through the real host helpers", () => {
    const compA = makeRow("Card A", toolA, valueA);
    manager.setUserBindings({ "app.tools.expand": "alt+shift+x" });
    try {
      // The native formatter maps alt -> option on macOS in all forms.
      const alt = process.platform === "darwin" ? "option+shift+x" : "alt+shift+x";
      assert.equal(h.agent.keyText("app.tools.expand"), alt);
      // A binding change re-displays through invalidate() -> updateDisplay(),
      // which re-runs renderResult and therefore re-resolves the hint.
      compA.invalidate();
      assert.ok(
        compA.render(100).some((line) => stripAnsi(line).includes(`(${alt} to expand)`)),
        "the header hint shows the configured binding, not the default",
      );
    } finally {
      manager.setUserBindings({}); // restore built-in defaults
    }
    assert.equal(h.agent.keyText("app.tools.expand"), "ctrl+o");
    compA.invalidate();
    assert.ok(compA.render(100).some((line) => stripAnsi(line).includes("(ctrl+o to expand)")));
  });

  test("registered Browser tool under the real host: exactly one native hint in both states", () => {
    // Regression for the double-hint finding: the Browser family once emitted
    // its own header hint, so a real host showed it twice (and a third time
    // in the collapsed overflow marker). Render one registered Browser tool
    // through the real ToolExecutionComponent and count the hints.
    const tools: Array<Record<string, any>> = [];
    new WebToolManager(
      { registerTool: (tool: Record<string, any>) => { tools.push(tool); } },
      normalizeConfig({}),
      undefined,
      undefined,
      { shutdown: async () => {}, updateConfig: () => {} } as unknown as never,
    ).register();
    const tool = tools.find((candidate) => candidate.name === "BrowserOpen");
    assert.ok(tool, "BrowserOpen was registered");
    const value = {
      content: [{ type: "text", text: "opened" }],
      isError: false,
      details: {
        response: {
          session: "browser1", tab: "tab1", generation: "generation1",
          url: "https://example.com/", title: "Example", status: 200, limits: {},
        },
      },
    };
    const comp = makeRow("BrowserOpen", tool.renderResult as ToolResultRenderCallback, value, { url: "https://example.com/" });
    const collapsed = comp.render(100).map(stripAnsi);
    assert.equal(
      collapsed.join("\n").split("(ctrl+o to expand)").length - 1,
      1,
      "exactly one collapsed hint in the real host render",
    );
    assert.ok(collapsed.some((line) => line.includes("BrowserOpen · opened · Example (ctrl+o to expand)")));

    comp.setExpanded(true);
    const expanded = comp.render(100).map(stripAnsi);
    assert.equal(
      expanded.join("\n").split("(ctrl+o to collapse)").length - 1,
      1,
      "exactly one expanded hint in the real host render",
    );
    assert.ok(expanded.some((line) => line.includes("Requested URL: https://example.com/")));

    comp.setExpanded(false);
    assert.deepEqual(comp.render(100).map(stripAnsi), collapsed, "re-collapse restores the identical card");
  });

  test("registered Browser tool honors a real-host binding override", () => {
    const tools: Array<Record<string, any>> = [];
    new WebToolManager(
      { registerTool: (tool: Record<string, any>) => { tools.push(tool); } },
      normalizeConfig({}),
      undefined,
      undefined,
      { shutdown: async () => {}, updateConfig: () => {} } as unknown as never,
    ).register();
    const tool = tools.find((candidate) => candidate.name === "BrowserOpen");
    assert.ok(tool, "BrowserOpen was registered");
    const value = {
      content: [{ type: "text", text: "opened" }],
      isError: false,
      details: {
        response: {
          session: "browser1", tab: "tab1", generation: "generation1",
          url: "https://example.com/", title: "Example", status: 200, limits: {},
        },
      },
    };
    const comp = makeRow("BrowserOpen", tool.renderResult as ToolResultRenderCallback, value, { url: "https://example.com/" });
    manager.setUserBindings({ "app.tools.expand": "alt+shift+x" });
    try {
      comp.invalidate();
      const alt = process.platform === "darwin" ? "option+shift+x" : "alt+shift+x";
      const lines = comp.render(100).map(stripAnsi);
      assert.ok(
        lines.some((line) => line.includes(`(${alt} to expand)`)),
        "the registered Browser card shows the configured binding, not the default",
      );
      assert.equal(lines.join("\n").includes("ctrl+o"), false, "no hard-coded default binding remains");
      assert.equal(lines.join("\n").split("to expand").length - 1, 1, "still exactly one hint");
    } finally {
      manager.setUserBindings({}); // restore built-in defaults
    }
    comp.invalidate();
    assert.ok(comp.render(100).map(stripAnsi).some((line) => line.includes("(ctrl+o to expand)")));
  });

  test("fallback hint rows fit degenerate widths through the real host ANSI-aware wrapper", () => {
    // pi-tui's own wrapTextWithAnsi hard-wraps oversized hint tokens (long
    // bindings, tiny widths) with styling tracked across the split, so no
    // fallback row can exceed the terminal width.
    const inner: ToolResultViewComponent = { render: () => ["x"], invalidate() {} };
    for (const expanded of [false, true]) {
      const wrapped = withExpansionHint(inner, expanded);
      for (const width of [1, 5]) {
        const rows = wrapped.render(width).map(stripAnsi);
        assert.ok(rows.length > 1, `width ${width}: hint rendered on wrapped rows`);
        assert.ok(rows.join("").includes("(ctrl+o"), `width ${width}: hint stays visible`);
        for (const row of rows) {
          assert.ok(h.tui.visibleWidth(row) <= width, `width ${width}: row fits via real host wrap: ${JSON.stringify(row)}`);
        }
      }
    }
  });

  test("regular mode is keyboard-only by host design; fullscreen owns mouse dispatch", () => {
    // pi-tui (0.85.1): TuiMainScreen (regular mode) has no raw-mouse input
    // path at all, while TuiAltScreen (fullscreen) parses mouse events and
    // dispatches them to the per-card regions. Nothing in this extension adds
    // or removes that behavior: the wrapper registers no handlers of its own.
    assert.equal(
      typeof (h.tui.TuiMainScreen.prototype as { handleMouseEvent?: unknown }).handleMouseEvent,
      "undefined",
      "regular mode parses no raw mouse input",
    );
    assert.equal(
      typeof (h.tui.TuiAltScreen.prototype as { handleMouseEvent?: unknown }).handleMouseEvent,
      "function",
      "fullscreen parses mouse input for per-card dispatch",
    );
    const compA = makeRow("Card A", toolA, valueA);
    const inner = compA.resultRendererComponent as { handleInput?: unknown; handleMouse?: unknown };
    assert.equal(typeof inner?.handleMouse, "undefined");
    assert.equal(typeof inner?.handleInput, "undefined");
  });
}
