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
    MouseRegion: new (child: unknown, handler: (event: unknown) => unknown) => unknown;
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
      if (typeof agent?.CustomMessageComponent !== "function" || typeof tui?.MouseRegion !== "function") continue;
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
  ] as { fg(color: string, text: string): string } | undefined;
  assert.ok(realTheme && typeof realTheme.fg === "function", "initTheme installed the real native Theme");

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
      setPiTuiHost({ wrapTextWithAnsi: h.tui.wrapTextWithAnsi, MouseRegion: h.tui.MouseRegion as never });
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
