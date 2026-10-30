// Real-host regression coverage for the tool-protection audit rows (#547).
//
// The reported shape was a native edit row whose coloured diff was normal
// while the gate's own `Tool protection: PASS` row underneath was unthemed.
// The decoration was running — it drew the annotation itself — but it ignored
// the theme Pi hands to `renderResult`. This file exercises the installed Pi
// host read-only (never modified):
//
// - the real native `Theme` installed by the host's own `initTheme()`,
// - the real `ToolExecutionComponent` row layout (call region first, result
//   region second), so the native edit preview diff and the decorated audit
//   rows are built by production code, not by a fake layout,
// - the installed `editRenderers`, resolved through the production
//   `registerToolRenderer` resolver captured from the coordinator,
// - annotations produced by the production coordinator (real status text),
//   not handcrafted display strings.
//
// The host is discovered with the established pattern from
// tests/tool-result-hints-host.test.ts (an explicit PI_REVIEW_GATE_INSTALLED_AGENT
// pin is the sole candidate; otherwise standard global roots). Without an
// installation the file skips with a reason, or fails under the established
// required-host gate PI_REVIEW_GATE_REQUIRE_PI_HOST=1
// (tests/tool-host-gate.ts).
//
// All fixtures are synthetic and owned: one temporary file with inert text,
// a fake pi host object, and an injected auditor returning fixed JSON. No
// provider request, model call, user file, session, or live runtime is touched.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Terminal } from "@xterm/headless";
import { DEFAULT_CONFIG, type ReviewGateConfig } from "../src/config";
import { createToolProtectionCoordinator } from "../src/tool-protection/coordinator";
import { setNativeExpansionHost } from "../src/presentation-hints";
import type {
  ProtectionAuditorRequest,
  ProtectionAuditorResult,
} from "../src/tool-protection/runner";
import { wrapAtWordBoundaries } from "../src/tool-result-wrap";
import { visibleTerminalText } from "../src/tool-result-text";
import { registerMissingHostPlaceholder } from "./tool-host-gate";

// ── Installed-host discovery (read-only) ─────────────────────────────────

interface RendererResolver {
  (
    toolName: string,
    next: () => unknown,
  ): { renderResult?: (...args: unknown[]) => { render(width: number): string[] } } | undefined;
}

interface HostBundle {
  agentDir: string;
  req: NodeRequire;
  agent: {
    initTheme(themeName: string, enableWatcher?: boolean): void;
    ToolExecutionComponent: new (
      toolName: string,
      toolCallId: string,
      args: unknown,
      options: Record<string, unknown>,
      toolDefinition: unknown,
      ui: { requestRender(): void },
      cwd: string,
    ) => {
      expanded: boolean;
      setArgsComplete(): void;
      updateResult(result: unknown, isPartial?: boolean): void;
      setExpanded(expanded: boolean): void;
      setShowImages(show: boolean): void;
      render(width: number): string[];
    };
  };
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
      if (typeof agent?.initTheme !== "function" || typeof agent?.ToolExecutionComponent !== "function") continue;
      return { agentDir, req, agent } as HostBundle;
    } catch {
      // Unreadable installation: try the next candidate.
    }
  }
  return undefined;
}

const host = discoverInstalledHost();
const SKIP_REASON =
  "installed Pi host not found (set PI_CODING_AGENT_DIR to a node_modules root containing @earendil-works/pi-coding-agent)";

/**
 * Removes terminal styling for text/width assertions: CSI SGR sequences and the
 * OSC 8 hyperlinks the native edit header emits around file paths (whose target
 * is not rendered, so it must not count toward the row width).
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

if (!host) {
  registerMissingHostPlaceholder("real-host tool-protection renderer coverage", SKIP_REASON);
} else {
  const h = host;
  h.agent.initTheme("dark", false); // the built-in theme JSON, no watcher
  const theme = (globalThis as Record<symbol, unknown>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ] as {
    fg(color: string, text: string): string;
    getFgAnsi(color: string): string;
    getBgAnsi(color: string): string;
  } | undefined;
  assert.ok(theme && typeof theme.fg === "function" && typeof theme.getBgAnsi === "function",
    "initTheme installed the real native Theme");
  const editRenderers = h.req(path.join(h.agentDir, "dist", "core", "tools", "renderers", "edit.js")).editRenderers;
  // The host resolves renderers from the tool DEFINITION
  // (agent-session.js getToolRenderers → getToolDefinition), and that definition
  // is what carries `renderShell: "self"` for edit (core/tools/edit.js). The
  // fixture hands the resolver the same shape, so the production decoration sees
  // the same shell the installed host renders — the reported #547 card is a
  // self-shell row, where the host paints nothing around the rows.
  const nativeEditDefinition = { name: "edit", renderShell: "self", ...(editRenderers as Record<string, unknown>) };
  // The installed pi-tui the running host itself uses: its capability record,
  // indicator text, dimension decoder and ANSI-aware wrapper are what the
  // fallback must match, so the image and hint regressions use them directly.
  const tuiRoot = path.join(h.agentDir, "..", "pi-tui", "dist", "index.js");
  const tui = fs.existsSync(tuiRoot)
    ? (h.req(tuiRoot) as {
        getCapabilities(): { images?: string | null };
        setCapabilities(caps: Record<string, unknown>): void;
        getImageDimensions(data: string, mimeType: string): { widthPx: number; heightPx: number } | null;
        imageFallback(mimeType: string, dimensions?: { widthPx: number; heightPx: number }): string;
        visibleWidth(line: string): number;
        wrapTextWithAnsi(text: string, width: number): string[];
      })
    : undefined;
  const { computeEditsDiff } = h.req(path.join(h.agentDir, "dist", "core", "tools", "edit-diff.js"));
  // The installed shell renderers. The shipped bash tool definition spreads
  // `createShellRenderers(config.prompt)` with the bash prompt "$" and declares
  // no `renderShell`, so the host's own `Box` (padding plus row background)
  // frames this family — the other half of the #547 card shape.
  const nativeBashDefinition = {
    name: "bash",
    ...(h.req(path.join(h.agentDir, "dist", "core", "tools", "renderers", "bash.js")) as {
      createShellRenderers(prompt: string): Record<string, unknown>;
    }).createShellRenderers("$"),
  };
  const ui = { requestRender() {} };

  // ── Production annotation fixtures (fake host + injected auditor) ──────

  type HookHandler = (...args: unknown[]) => unknown;

  function fakePiHost() {
    const hooks = new Map<string, HookHandler[]>();
    const pi: Record<string, unknown> = {
      on(name: string, handler: HookHandler) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerToolRenderer(resolver: unknown) {
        pi.__rendererResolver = resolver;
      },
    };
    return {
      pi,
      async emit(name: string, ...args: unknown[]) {
        const results: unknown[] = [];
        for (const handler of hooks.get(name) ?? []) results.push(await handler(...args));
        return results.filter((value) => value !== undefined);
      },
    };
  }

  function protectionConfig(overrides: Record<string, unknown> = {}): ReviewGateConfig {
    return {
      ...DEFAULT_CONFIG,
      toolProtection: {
        level: "aligned",
        auditor: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
        scope: "all",
        toolNames: [],
        timeoutMs: 5_000,
        maxContextChars: 200_000,
        retainAuditorSessions: false,
        ...overrides,
      },
    } as ReviewGateConfig;
  }

  function coordinatorFor(outputs: string[], options: { cwd: string; config?: ReviewGateConfig }) {
    const calls: ProtectionAuditorRequest[] = [];
    let index = 0;
    const coordinator = createToolProtectionCoordinator({
      config: () => options.config ?? protectionConfig(),
      cwd: () => options.cwd,
      role: "primary",
      now: () => 1_000,
      runAuditor: (async (request: ProtectionAuditorRequest): Promise<ProtectionAuditorResult> => {
        calls.push(request);
        const output = outputs[Math.min(index, outputs.length - 1)];
        index += 1;
        return { output, durationMs: 1 };
      }) as unknown as typeof import("../src/tool-protection/runner").runProtectionAuditor,
    });
    return { coordinator, calls };
  }

  function hostContext(): Record<string, unknown> {
    return {
      ui: {},
      cwd: "/work",
      getSystemPrompt: () => "GOVERNING: complete the bounded synthetic rendering task.",
      modelRegistry: {
        find(provider: string, modelId: string) {
          return { id: modelId, provider };
        },
        getAll() {
          return [{ id: "model", provider: "synthetic" }];
        },
        streamSimple() {
          throw new Error("the injected auditor runner never uses the registry stream");
        },
      },
      sessionManager: { buildContextEntries: () => [] },
    };
  }

  function callArgs(callId: string, toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return [{ toolCallId: callId, toolName, input, ...extra }, hostContext()];
  }

  function resultEvent(
    callId: string,
    toolName: string,
    content: unknown[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { toolCallId: callId, toolName, input: { path: "fixture.txt" }, content, isError: false, ...overrides };
  }

  /** Bounded observable wait for the renderer's asynchronous diff preview. */
  async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  // ── Owned synthetic edit fixture ───────────────────────────────────────

  const OLD_TEXT = "alpha\nbeta\ngamma\n";
  const NEW_TEXT = "alpha\nBETA-CHANGED\ngamma\n";
  const EDIT_ARGS = { path: "fixture.txt", oldText: OLD_TEXT, newText: NEW_TEXT };

  async function withEditFixture(run: (cwd: string, details: Record<string, unknown>) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-rg-547-"));
    try {
      await writeFile(path.join(cwd, "fixture.txt"), OLD_TEXT, "utf8");
      const preview = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: NEW_TEXT }], cwd);
      assert.ok(typeof preview.diff === "string", "the owned fixture produced a native edit diff");
      await run(cwd, { diff: preview.diff, firstChangedLine: preview.firstChangedLine });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  function editRow(cwd: string, toolDefinition: unknown, result: unknown) {
    const component = new h.agent.ToolExecutionComponent(
      "edit",
      "edit-call",
      EDIT_ARGS,
      {},
      toolDefinition,
      ui,
      cwd,
    );
    component.setArgsComplete();
    component.updateResult(result, false);
    return component;
  }

  async function renderWithPreview(component: { render(width: number): string[] }, width = 120): Promise<string[]> {
    await until(
      () => stripAnsi(component.render(width).join("\n")).includes("BETA-CHANGED"),
      "the native edit preview diff",
    );
    return component.render(width);
  }

  function annotationRows(lines: string[], firstStyledChunk: string): number {
    return lines.findIndex((line) => line.includes(firstStyledChunk));
  }

  /**
   * Every row of the card from `from` to the end — the native call header and
   * diff, the gate rows, the blank gap row, and the native result rows — has to
   * carry the themed row background, or the card is cut apart by an
   * ordinary-background band (#547).
   */
  function assertContinuousBackground(lines: string[], bgAnsi: string, from: number, label: string): void {
    for (let index = from; index < lines.length; index += 1) {
      assert.ok(lines[index]!.includes(bgAnsi), `${label}: row ${index + 1} keeps the themed row background`);
    }
  }

  /** No rendered row may exceed the width the host supplied. */
  function assertFitsWidth(lines: string[], width: number, label: string): void {
    for (const line of lines) {
      assert.ok(stripAnsi(line).length <= width, `${label}: a rendered row exceeds the ${width}-column width: ${JSON.stringify(stripAnsi(line))}`);
    }
  }

  // ── PASS + native diff (the reported shape) ───────────────────────────

  test("real host: the PASS audit row is themed once and the native diff is unchanged", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor(
        [JSON.stringify({ decision: "PASS", reason: "synthetic call is authorized" })],
        { cwd },
      );
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-call", "edit", EDIT_ARGS)), undefined);

      const nativeContent = [{ type: "text", text: "Successfully edited fixture.txt" }];
      const event = resultEvent("edit-call", "edit", nativeContent, { details });
      const [annotated] = await pi.emit("tool_result", event) as Array<Record<string, unknown>>;
      assert.ok(annotated, "the production coordinator annotated the tool result");
      const content = annotated.content as Array<Record<string, unknown>>;
      const passText = content[0]?.text as string;
      assert.match(passText, /^Tool protection: PASS — the auditor approved this edit call before execution/);
      assert.deepEqual(content[1], nativeContent[0], "the native result content is preserved after the annotation");
      assert.equal(annotated.isError, false);
      assert.deepEqual(annotated.details, details, "the native structured details are preserved");
      assert.deepEqual(event.content, nativeContent, "the original tool result is never mutated");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult, "the production resolver decorated the native edit renderers");
      assert.equal((decoratedEdit as { renderShell?: unknown }).renderShell, "self",
        "the decoration keeps the definition's own self shell");

      const decoratedRow = editRow(cwd, decoratedEdit, annotated);
      const nativeRow = editRow(cwd, nativeEditDefinition, { content: nativeContent, details });
      const collapsed = await renderWithPreview(decoratedRow);
      const plain = await renderWithPreview(nativeRow);

      // The call region (edit path plus the coloured preview diff) is
      // byte-identical with and without the decoration.
      assert.deepEqual(
        collapsed.slice(0, plain.length - 1),
        plain.slice(0, -1),
        "the native call preview and coloured diff are unchanged by the decoration",
      );
      const removedRow = collapsed.find((line) => stripAnsi(line).includes("beta"));
      const addedRow = collapsed.find((line) => stripAnsi(line).includes("BETA-CHANGED"));
      assert.ok(removedRow?.includes(theme.getFgAnsi("toolDiffRemoved")), "the removed diff row keeps the native theme colour");
      assert.ok(addedRow?.includes(theme.getFgAnsi("toolDiffAdded")), "the added diff row keeps the native theme colour");

      // Exactly one status line, styled by the real theme's success token
      // after sanitization/wrapping (so the theme escapes are not width).
      const sanitized = visibleTerminalText(passText);
      const chunks = wrapAtWordBoundaries(sanitized, 118);
      assert.ok(chunks.length > 1, "the production PASS row wraps at the native content width");
      for (const chunk of chunks) {
        assert.ok(
          collapsed.some((line) => line.includes(theme.fg("success", chunk))),
          `collapsed row carries the real success token for ${JSON.stringify(chunk)}`,
        );
      }
      assert.equal(stripAnsi(collapsed.join("\n")).split("Tool protection: PASS").length - 1, 1,
        "the collapsed row shows the audit status exactly once");
      const firstChunk = theme.fg("success", chunks[0]!);
      assert.equal(annotationRows(collapsed, firstChunk), plain.length + 1,
        "collapsed: the audit rows follow the native preview after exactly one separator row");
      assert.equal(stripAnsi(collapsed[plain.length]!).trim(), "", "the collapsed-only separator row is preserved");

      decoratedRow.setExpanded(true);
      const expanded = decoratedRow.render(120);
      for (const chunk of chunks) {
        assert.ok(expanded.some((line) => line.includes(theme.fg("success", chunk))),
          "expanded row carries the same real success token");
      }
      assert.equal(stripAnsi(expanded.join("\n")).split("Tool protection: PASS").length - 1, 1,
        "the expanded row shows the audit status exactly once");
      assert.equal(annotationRows(expanded, firstChunk), plain.length,
        "expanded: no collapsed-only separator row is added");
      assert.deepEqual(
        expanded.slice(0, plain.length - 1),
        plain.slice(0, -1),
        "expanding the audit rows leaves the native edit preview untouched",
      );

      assert.equal(content[0]?.text, passText, "rendering never rewrites the model-visible annotation");
      assert.deepEqual(content[1], nativeContent[0]);
    });
  });

  // ── One continuous themed card at every width and toggle state ────────

  test("real host: the audit rows and native body rows form one continuous themed card", async () => {
    await withEditFixture(async (cwd, preview) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor(
        [JSON.stringify({ decision: "PASS", reason: "synthetic call is authorized because it stays inside the owned workspace fixture" })],
        { cwd },
      );
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-card", "edit", EDIT_ARGS)), undefined);

      // A result diff that differs from the call preview makes the native edit
      // renderer emit its own body rows (a spacer plus the diff text) below the
      // audit rows; those rows are unpainted by the native renderer, so they
      // used to sit on the terminal's own background.
      const settled = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: "alpha\nBETA-CHANGED\ngamma\ndelta\n" }], cwd);
      const details = { diff: settled.diff, firstChangedLine: settled.firstChangedLine };
      const [annotated] = await pi.emit(
        "tool_result",
        resultEvent("edit-card", "edit", [{ type: "text", text: "Successfully edited fixture.txt" }], { details }),
      ) as Array<Record<string, unknown>>;
      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);

      const successBg = theme.getBgAnsi("toolSuccessBg");
      for (const width of [120, 60, 34]) {
        const row = editRow(cwd, decoratedEdit, annotated);
        const collapsed = await renderWithPreview(row, width);
        // The self-shell row starts with the host's own blank row above the
        // card; from the first card row down, nothing may lose the background.
        assertContinuousBackground(collapsed, successBg, 1, `collapsed width ${width}`);
        assertFitsWidth(collapsed, width, `collapsed width ${width}`);
        const auditRow = collapsed.find((line) => stripAnsi(line).includes("Tool protection: PASS"))!;
        assert.ok(auditRow.includes(theme.getFgAnsi("success")), `collapsed width ${width}: the audit row keeps its own foreground`);
        assert.ok(auditRow.includes(successBg), `collapsed width ${width}: the audit row is painted to the full width`);
        // The native diff keeps its own colours and gains no audit colouring.
        const diffRow = collapsed.find((line) => stripAnsi(line).includes("delta"))!;
        assert.ok(diffRow.includes(theme.getFgAnsi("toolDiffAdded")), `collapsed width ${width}: the native diff keeps its added colour`);
        assert.ok(diffRow.includes(successBg), `collapsed width ${width}: the native body rows are painted to the full width too`);
        assert.ok(!diffRow.includes(auditRow), `collapsed width ${width}: no audit row lands inside the diff`);
        // Every gap row inside the card is painted too.
        const gap = collapsed.filter((line, index) => index > 0 && stripAnsi(line).trim() === "");
        assert.ok(gap.length >= 2, `collapsed width ${width}: the card keeps its gap rows`);
        for (const gapRow of gap) assert.ok(gapRow.includes(successBg), `collapsed width ${width}: a gap row keeps the background`);

        row.setExpanded(true);
        const expanded = row.render(width);
        assertContinuousBackground(expanded, successBg, 1, `expanded width ${width}`);
        assertFitsWidth(expanded, width, `expanded width ${width}`);
        assert.equal(
          stripAnsi(expanded.join("\n")).split("Tool protection: PASS").length - 1,
          1,
          `expanded width ${width}: the audit status still appears exactly once`,
        );
      }
    });
  });

  // ── Renderer-less audited tool: native fallback rows, semantic audit rows ──

  test("real host: a renderer-less audited tool keeps native fallback rows with semantic audit colours", async () => {
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor(
      [JSON.stringify({ decision: "PASS", reason: "synthetic notice is authorized" })],
      { cwd: "/work" },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-call", "YouShouldKnow", { title: "Deployed", body: "shipped" })), undefined);

    const ownContent = [{ type: "text", text: "Notice registered as n-1: \"Deployed\". It stays pending until the user closes it." }];
    const [annotated] = await pi.emit("tool_result", resultEvent("notice-call", "YouShouldKnow", ownContent)) as Array<Record<string, unknown>>;
    const plainDefinition = { name: "YouShouldKnow" };
    const resolver = pi.pi.__rendererResolver as RendererResolver;
    const decorated = resolver("YouShouldKnow", () => plainDefinition);
    assert.ok(decorated?.renderResult, "the decoration supplies the renderer this definition does not declare");

    const noticeRow = new h.agent.ToolExecutionComponent(
      "YouShouldKnow",
      "notice-call",
      { title: "Deployed", body: "shipped" },
      {},
      { ...plainDefinition, ...decorated },
      ui,
      "/work",
    );
    noticeRow.updateResult(annotated, false);
    const rows = noticeRow.render(100);
    const text = stripAnsi(rows.join("\n"));
    assert.equal(text.split("Tool protection: PASS").length - 1, 1, "the audit status appears exactly once");
    const auditRow = rows.find((line) => stripAnsi(line).includes("Tool protection: PASS"))!;
    assert.ok(auditRow.includes(theme.getFgAnsi("success")), "the audit row uses the success token, not the muted tool-output colour");
    const contentRow = rows.find((line) => stripAnsi(line).includes("Notice registered as n-1"))!;
    assert.ok(contentRow.includes(theme.getFgAnsi("toolOutput")), "the tool's own content keeps the native tool-output colour");
    const successBg = theme.getBgAnsi("toolSuccessBg");
    assertContinuousBackground(rows, successBg, 1, "renderer-less notice");
    assertFitsWidth(rows, 100, "renderer-less notice");

    // An unannotated (Off) renderer-less result keeps the host's own fallback
    // byte-for-byte.
    const offPi = fakePiHost();
    const off = coordinatorFor([], { cwd: "/work", config: { ...DEFAULT_CONFIG } as ReviewGateConfig });
    off.coordinator.registerHooks(offPi.pi);
    const offResolver = offPi.pi.__rendererResolver as RendererResolver;
    const offDecorated = offResolver("YouShouldKnow", () => plainDefinition);
    assert.ok(offDecorated?.renderResult);
    const offResult = { content: ownContent, details: { status: "pending" } };
    const decoratedRows = new h.agent.ToolExecutionComponent(
      "YouShouldKnow", "notice-off", { title: "Deployed", body: "shipped" }, {}, { ...plainDefinition, ...offDecorated }, ui, "/work",
    );
    decoratedRows.updateResult(offResult, false);
    const nativeRows = new h.agent.ToolExecutionComponent(
      "YouShouldKnow", "notice-off", { title: "Deployed", body: "shipped" }, {}, plainDefinition, ui, "/work",
    );
    nativeRows.updateResult(offResult, false);
    assert.deepEqual(decoratedRows.render(100), nativeRows.render(100),
      "an unannotated renderer-less row is byte-identical to the host's own fallback");
  });

  // ── Image disclosure and narrow-preview wrapping of the fallback ───────

  test("real host: a renderer-less audited result discloses images the terminal cannot draw", async () => {
    assert.ok(tui && typeof tui.imageFallback === "function", "the installed pi-tui supplies its own image indicator");
    const host = tui!;
    // Owned 1x1 PNG fixture with real, decodable dimensions.
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const dimensions = host.getImageDimensions(png1x1, "image/png");
    assert.deepEqual(dimensions, { widthPx: 1, heightPx: 1 }, "the owned fixture image carries decodable dimensions");
    const indicator = host.imageFallback("image/png", dimensions ?? undefined);
    assert.equal(indicator, "[Image: [image/png] 1x1]", "the host's own indicator names the block and its dimensions");

    const pi = fakePiHost();
    const { coordinator } = coordinatorFor(
      [JSON.stringify({ decision: "PASS", reason: "synthetic notice is authorized" })],
      { cwd: "/work" },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-image", "YouShouldKnow", { title: "Screenshot", body: "see the image" })), undefined);
    const [annotated] = await pi.emit(
      "tool_result",
      resultEvent("notice-image", "YouShouldKnow", [{ type: "text", text: "Notice registered as n-2." }, { type: "image", mimeType: "image/png", data: png1x1 }]),
    ) as Array<Record<string, unknown>>;
    const plainDefinition = { name: "YouShouldKnow" };
    const decorated = (pi.pi.__rendererResolver as RendererResolver)("YouShouldKnow", () => plainDefinition);
    assert.ok(decorated?.renderResult);

    const noticeRows = (showImages: boolean) => {
      const component = new h.agent.ToolExecutionComponent(
        "YouShouldKnow", "notice-image", { title: "Screenshot", body: "see the image" }, {}, { ...plainDefinition, ...decorated }, ui, "/work",
      );
      component.setShowImages(showImages);
      component.updateResult(annotated, false);
      return component.render(100);
    };
    const savedCapabilities = host.getCapabilities();
    setNativeExpansionHost({
      visibleWidth: (line) => host.visibleWidth(line),
      wrapTextWithAnsi: (text, width) => host.wrapTextWithAnsi(text, width),
      getCapabilities: () => host.getCapabilities(),
      getImageDimensions: (data, mimeType) => host.getImageDimensions(data, mimeType),
      imageFallback: (mimeType, dims) => host.imageFallback(mimeType, dims),
    });
    try {
      // A terminal with no inline-image protocol: the host draws nothing for
      // the block, so the fallback has to name it (with dimensions).
      host.setCapabilities({ ...savedCapabilities, images: null });
      const unsupported = noticeRows(true);
      assert.ok(unsupported.some((line) => stripAnsi(line).includes(indicator)),
        "an image-capability-less terminal still gets the audited image block named, dimensions included");
      host.setCapabilities({ ...savedCapabilities, images: "kitty" });
      const supported = noticeRows(true);
      assert.ok(!supported.some((line) => stripAnsi(line).includes("[Image:")),
        "the host draws the image itself, so the fallback never names it twice");
      const hidden = noticeRows(false);
      assert.ok(hidden.some((line) => stripAnsi(line).includes(indicator)),
        "turning inline images off keeps the native indicator");
    } finally {
      host.setCapabilities(savedCapabilities);
      setNativeExpansionHost(undefined);
    }
  });

  test("real host: a renderer-less collapsed preview and its omission hint fit the available width", async () => {
    assert.ok(tui && typeof tui.wrapTextWithAnsi === "function", "the installed pi-tui supplies its own ANSI-aware wrapper");
    const host = tui!;
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor(
      [JSON.stringify({ decision: "PASS", reason: "synthetic notice is authorized" })],
      { cwd: "/work" },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-long", "YouShouldKnow", { title: "Long notice", body: "many lines" })), undefined);
    const many = Array.from({ length: 14 }, (_unused, index) => `notice line ${index + 1} carrying several words`).join("\n");
    const [annotated] = await pi.emit(
      "tool_result",
      resultEvent("notice-long", "YouShouldKnow", [{ type: "text", text: "Notice registered as n-3." }, { type: "text", text: many }]),
    ) as Array<Record<string, unknown>>;
    const plainDefinition = { name: "YouShouldKnow" };
    const decorated = (pi.pi.__rendererResolver as RendererResolver)("YouShouldKnow", () => plainDefinition);
    assert.ok(decorated?.renderResult);
    const noticeRows = (width: number) => {
      const component = new h.agent.ToolExecutionComponent(
        "YouShouldKnow", "notice-long", { title: "Long notice", body: "many lines" }, {}, { ...plainDefinition, ...decorated }, ui, "/work",
      );
      component.updateResult(annotated, false);
      return component.render(width);
    };
    // A deliberately long configured binding: the hint row must still reflow.
    setNativeExpansionHost({
      keyText: () => "ctrl+shift+alt+super+hyper+long+binding",
      keyHint: (_keybinding, description) => `ctrl+shift+alt+super+hyper+long+binding ${description}`,
      visibleWidth: (line) => host.visibleWidth(line),
      wrapTextWithAnsi: (text, width) => host.wrapTextWithAnsi(text, width),
    });
    try {
      const wide = noticeRows(200);
      const hintRow = stripAnsi(wide.find((line) => stripAnsi(line).includes("more lines"))!);
      assert.equal(
        wide.filter((line) => /notice line \d+|Notice registered/.test(stripAnsi(line))).length,
        10,
        "the collapsed fallback preview keeps Pi's ten-line bound",
      );
      assert.match(hintRow, /\.\.\. \(5 more lines\) \(ctrl\+shift\+alt\+super\+hyper\+long\+binding to expand\)/,
        "the collapsed omission line carries one matching parenthesis pair plus the configured-key hint");
      assert.equal(hintRow.split("(").length, hintRow.split(")").length, "the omission line has no unmatched parenthesis");
      for (const width of [60, 32, 20]) {
        const rows = noticeRows(width);
        assertFitsWidth(rows, width, `renderer-less collapsed width ${width}`);
        const visible = stripAnsi(rows.join(" "));
        assert.ok(visible.includes("(5 more lines)"), `collapsed width ${width}: the omission count survives the wrap`);
        assert.ok(visible.includes("to expand"), `collapsed width ${width}: the expansion affordance survives the wrap`);
        assert.equal(
          stripAnsi(rows.filter((line) => stripAnsi(line).includes("notice line 10")).join("")),
          "",
          `collapsed width ${width}: line 11 of the retained text stays outside the ten-line preview`,
        );
      }
    } finally {
      setNativeExpansionHost(undefined);
    }
  });

  // ── Native error result preserved below the audit row ─────────────────

  test("real host: a native edit error is preserved beneath the themed PASS row", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor(
        [JSON.stringify({ decision: "PASS", reason: "synthetic call is authorized" })],
        { cwd },
      );
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-error", "edit", EDIT_ARGS)), undefined);

      const errorText = "synthetic edit failure";
      const [annotated] = await pi.emit(
        "tool_result",
        resultEvent("edit-error", "edit", [{ type: "text", text: errorText }], { isError: true, details: {} }),
      ) as Array<Record<string, unknown>>;
      assert.equal(annotated.isError, true, "the native error flag is preserved");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);
      const row = editRow(cwd, decoratedEdit, annotated);
      const collapsed = await renderWithPreview(row);
      const text = stripAnsi(collapsed.join("\n"));
      assert.equal(text.split("Tool protection: PASS").length - 1, 1, "the audit status appears once");
      assert.equal(text.split(errorText).length - 1, 1, "the native error text is preserved exactly once");
      const errorRow = collapsed.find((line) => stripAnsi(line).includes(errorText));
      assert.ok(errorRow?.includes(theme.fg("error", errorText)),
        "the native edit error keeps the host's own error styling");
      const passRow = collapsed.find((line) => stripAnsi(line).includes("Tool protection: PASS"));
      assert.ok(passRow?.includes(theme.getFgAnsi("success")), "the audit row stays success-styled");
      // The row background follows the host's own row state: a failed result
      // paints the gate rows and the body rows below them with the error
      // background, while the PASS line keeps its success foreground — an audit
      // decision is never the same claim as a successful execution. The native
      // edit header keeps its own preview-derived background (its
      // getEditHeaderBg prefers a successful preview over the settled error),
      // which is the host's pre-existing behaviour and is left untouched here.
      const errorBg = theme.getBgAnsi("toolErrorBg");
      assert.ok(passRow?.includes(errorBg), "the gate rows use the host's error row background for a failed result");
      assert.ok(errorRow?.includes(errorBg), "the native error body row is painted to the full width as well");
      const headerRow = collapsed.find((line) => stripAnsi(line).trimStart().startsWith("edit "));
      assert.ok(headerRow !== undefined && headerRow.includes(theme.getBgAnsi("toolSuccessBg")) && !headerRow.includes(errorBg),
        "observed host nuance: the native edit header keeps its own preview-derived background for a settled error, which this change does not touch");
    });
  });

  // ── NOT AUDITED and nested FAIL rows are never success ────────────────

  test("real host: NOT AUDITED and nested FAIL audit rows use non-success semantics", async () => {
    await withEditFixture(async (cwd, details) => {
      const nativeContent = [{ type: "text", text: "Successfully edited fixture.txt" }];

      const notAuditedPi = fakePiHost();
      const notAudited = coordinatorFor(
        [JSON.stringify({ decision: "PASS" })],
        { cwd, config: protectionConfig({ scope: "selected", toolNames: ["bash"] }) },
      );
      notAudited.coordinator.registerHooks(notAuditedPi.pi);
      assert.equal(await notAudited.coordinator.admitToolCall(callArgs("edit-not-audited", "edit", EDIT_ARGS)), undefined);
      const [notAuditedResult] = await notAuditedPi.emit(
        "tool_result",
        resultEvent("edit-not-audited", "edit", nativeContent, { details }),
      ) as Array<Record<string, unknown>>;
      const notAuditedText = (notAuditedResult.content as Array<Record<string, unknown>>)[0]?.text as string;
      assert.match(notAuditedText, /^Tool protection: NOT AUDITED/);

      const resolver = notAuditedPi.pi.__rendererResolver as RendererResolver;
      const baseRenderer = { renderResult: () => ({ render: () => [], invalidate() {} }) };
      const decorated = resolver("edit", () => baseRenderer);
      assert.ok(decorated?.renderResult);
      const notAuditedRow = decorated.renderResult!(notAuditedResult, { expanded: false }, theme, { expanded: false })
        .render(400).find((line) => stripAnsi(line).includes("Tool protection: NOT AUDITED"));
      assert.ok(notAuditedRow, "the NOT AUDITED row is displayed");
      assert.match(stripAnsi(notAuditedRow), /^Tool protection: NOT AUDITED/);
      assert.ok(notAuditedRow.startsWith(theme.getFgAnsi("warning")),
        "NOT AUDITED is a warning row, not a success row");
      assert.ok(!notAuditedRow.includes(theme.getFgAnsi("success")),
        "NOT AUDITED never borrows the success token");

      // A nested blocked child is aggregated into the outer result by the
      // production coordinator; its FAIL row must not read as success merely
      // because the outer tool completed.
      const nestedPi = fakePiHost();
      const nested = coordinatorFor(
        [
          JSON.stringify({ decision: "PASS", reason: "synthetic outer call is authorized" }),
          JSON.stringify({ decision: "FAIL", reason: "synthetic nested denial" }),
        ],
        { cwd },
      );
      nested.coordinator.registerHooks(nestedPi.pi);
      assert.equal(await nested.coordinator.admitToolCall(callArgs("render-root", "codemode", {})), undefined);
      assert.ok(
        await nested.coordinator.admitToolCall(
          callArgs("render-root/1", "bash", { command: "echo hi" }, { parentToolCallId: "render-root/1" }),
        ),
        "the nested proposal was refused",
      );
      const [nestedResult] = await nestedPi.emit(
        "tool_result",
        resultEvent("render-root", "codemode", nativeContent),
      ) as Array<Record<string, unknown>>;
      const nestedText = (nestedResult.content as Array<Record<string, unknown>>)[0]?.text as string;
      assert.match(nestedText, /^Tool protection: PASS/);
      assert.match(nestedText, /- nested bash: FAIL\/BLOCKED before execution/);

      const nestedResolver = nestedPi.pi.__rendererResolver as RendererResolver;
      const nestedDecorated = nestedResolver("codemode", () => baseRenderer);
      assert.ok(nestedDecorated?.renderResult);
      const rows = nestedDecorated.renderResult!(nestedResult, { expanded: false }, theme, { expanded: false })
        .render(400);
      const nestedFailRow = rows.find((line) => stripAnsi(line).includes("- nested bash: FAIL/BLOCKED"));
      assert.ok(nestedFailRow, "the nested FAIL row is displayed");
      assert.ok(nestedFailRow!.includes(theme.getFgAnsi("error")),
        "a nested FAIL row uses the theme's error token");
      assert.ok(!nestedFailRow!.includes(theme.getFgAnsi("success")),
        "a nested FAIL row is never success-styled");
      const nestedPassRow = rows.find((line) => stripAnsi(line).includes("- nested "));
      assert.ok(nestedPassRow, "at least one nested row is displayed");
    });
  });

  // ── Off: the decoration is byte-identical to the native presentation ──

  test("real host: an unannotated (Off) edit row is byte-identical with and without decoration", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([], { cwd, config: { ...DEFAULT_CONFIG } as ReviewGateConfig });
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-off", "edit", EDIT_ARGS)), undefined);
      assert.deepEqual(await pi.emit("tool_result", resultEvent("edit-off", "edit", [{ type: "text", text: "ok" }])), [],
        "Off leaves the native result unannotated");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);
      const nativeResult = { content: [{ type: "text", text: "Successfully edited fixture.txt" }], details };

      const decorated = await renderWithPreview(editRow(cwd, decoratedEdit, nativeResult));
      const plain = await renderWithPreview(
        editRow(cwd, nativeEditDefinition, nativeResult),
      );
      assert.deepEqual(decorated, plain, "without an annotation the decoration is byte-identical to the native row");
    });
  });

  // ── Shared fixtures for the three native card families ────────────────

  type CardFamily = "bash" | "edit" | "notice";
  type CardRow = InstanceType<HostBundle["agent"]["ToolExecutionComponent"]>;
  /** The real native Theme, held in a local the helpers below can name directly. */
  const nativeTheme = theme!;

  const AUDIT_REASON = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
  const BASH_OUTPUT = [
    "synthetic line one", "synthetic line two", "synthetic line three",
    "synthetic line four", "synthetic line five", "synthetic line six", "synthetic line seven",
  ].join("\n");
  const NOTICE_TEXT = [
    "Notice registered as n-1: \"Deployed\". It stays pending until the user closes it.",
    "notice body line one", "notice body line two", "notice body line three",
    "notice body line four", "notice body line five", "notice body line six", "notice body line seven",
  ].join("\n");
  /** Single-cell markers each family's own native rows have to keep. */
  const FAMILY_MARKERS: Record<CardFamily, string[]> = {
    bash: ["$ echo synthetic", "synthetic line seven"],
    edit: ["edit fixture.txt", "BETA-CHANGED", "delta"],
    notice: ["YouShouldKnow", "Notice registered as n-1", "notice body line seven"],
  };

  interface AuditedCard {
    component: CardRow;
    annotationText: string;
    annotated: Record<string, unknown>;
    originalContent: Array<Record<string, unknown>>;
    snapshotDetails?: Record<string, unknown>;
    event: Record<string, unknown>;
  }

  /**
   * One audited card per family, built entirely by the installed host and the
   * production coordinator: real renderers, real row layout, real annotation
   * text. Nothing here runs a shell command, model call, or provider request —
   * the bash fixture is an inert synthetic result handed to the installed shell
   * renderers, and the notice fixture is the project-owned renderer-less tool.
   */
  async function auditedCard(
    family: CardFamily,
    cwd: string,
    options: { details?: Record<string, unknown>; decision?: string; scope?: ReviewGateConfig } = {},
  ): Promise<AuditedCard> {
    const spec = family === "bash"
      ? { toolName: "bash", args: { command: "echo synthetic" }, definition: nativeBashDefinition, content: [{ type: "text", text: BASH_OUTPUT }] }
      : family === "edit"
        ? { toolName: "edit", args: EDIT_ARGS, definition: nativeEditDefinition, content: [{ type: "text", text: "Successfully edited fixture.txt" }] }
        : { toolName: "YouShouldKnow", args: { title: "Deployed", body: "shipped" }, definition: { name: "YouShouldKnow" }, content: [{ type: "text", text: NOTICE_TEXT }] };
    const details = options.details ?? (family === "edit" ? undefined : family === "bash" ? {} : { status: "pending" });
    const callId = `${family}-call`;
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor(
      [JSON.stringify({ decision: options.decision ?? "PASS", reason: AUDIT_REASON })],
      { cwd, ...(options.scope === undefined ? {} : { config: options.scope }) },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs(callId, spec.toolName, spec.args)), undefined,
      `${family}: the synthetic call was admitted for ${spec.toolName}`);
    // Independent deep snapshots. Nothing handed to the pipeline aliases them,
    // so an in-place mutation of the event array, one of its text blocks, or the
    // structured details changes the actual value only and is caught.
    const snapshotContent = structuredClone(spec.content) as Array<Record<string, unknown>>;
    const snapshotDetails = details === undefined ? undefined : structuredClone(details) as Record<string, unknown>;
    const event: Record<string, unknown> = {
      toolCallId: callId,
      toolName: spec.toolName,
      input: structuredClone(spec.args),
      content: structuredClone(snapshotContent),
      isError: false,
    };
    if (snapshotDetails !== undefined) event.details = structuredClone(snapshotDetails);
    const [annotated] = await pi.emit("tool_result", event) as Array<Record<string, unknown>>;
    assert.ok(annotated, `${family}: the production coordinator annotated the tool result`);
    const decorated = (pi.pi.__rendererResolver as RendererResolver)(spec.toolName, () => spec.definition);
    assert.ok(decorated?.renderResult, `${family}: the production resolver decorated this tool`);
    const component = new h.agent.ToolExecutionComponent(
      spec.toolName, callId, spec.args, {}, { ...spec.definition, ...decorated }, ui, cwd,
    );
    component.setArgsComplete();
    component.updateResult(annotated, false);
    const annotationText = (annotated.content as Array<Record<string, unknown>>)[0]!.text as string;
    return { component, annotationText, annotated, originalContent: snapshotContent, snapshotDetails, event };
  }

  /**
   * The installed host aliases its own pi-tui width helpers; the decoration's
   * row padding measures with them. Without that alias the decoration falls back
   * to a deliberately conservative non-ASCII count, which is not the rendering
   * path a real Pi session uses, so the card assertions install the installed
   * host's own helpers for their duration.
   */
  async function withInstalledHostWidths(run: () => Promise<void>): Promise<void> {
    assert.ok(tui, "the installed pi-tui peer supplies the host's own cell-width helpers");
    const peer = tui!;
    setNativeExpansionHost({
      visibleWidth: (line) => peer.visibleWidth(line),
      wrapTextWithAnsi: (text, width) => peer.wrapTextWithAnsi(text, width),
      getCapabilities: () => peer.getCapabilities(),
      getImageDimensions: (data, mimeType) => peer.getImageDimensions(data, mimeType),
      imageFallback: (mimeType, dimensions) => peer.imageFallback(mimeType, dimensions),
    });
    try {
      await run();
    } finally {
      setNativeExpansionHost(undefined);
    }
  }

  /**
   * Expected audit rows, computed WITHOUT the production wrapper under test: a
   * plain greedy fill that breaks only at spaces, never exceeds the content
   * width, never starts a continuation row with whitespace, and drops nothing.
   * The fixture text is single-cell, so its length is its cell width.
   */
  function expectedAuditRowTexts(value: string, width: number): string[] {
    const rows: string[] = [];
    let current = "";
    for (const word of value.split(" ")) {
      assert.ok(word.length <= width, `the fixture token ${JSON.stringify(word)} fits the ${width}-column audit width`);
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else { rows.push(current); current = word; }
    }
    if (current.length > 0) rows.push(current);
    return rows;
  }

  /** The rendered audit rows must equal those independent rows, styled by the gate's own token. */
  function assertAuditRowsRendered(
    lines: string[],
    annotationText: string,
    contentWidth: number,
    token: "success" | "warning" | "error",
    label: string,
  ): number {
    assert.ok(!annotationText.includes("\n"), `${label}: the annotation is one logical line`);
    const expected = expectedAuditRowTexts(annotationText, contentWidth);
    assert.ok(expected.length > 1, `${label}: the audit text is long enough to wrap at ${contentWidth} columns`);
    const visible = lines.map((line) => stripAnsi(line).trim());
    assert.equal(visible.filter((row) => row === expected[0]!.trim()).length, 1,
      `${label}: the first audit row appears exactly once`);
    const start = visible.indexOf(expected[0]!.trim());
    for (let index = 0; index < expected.length; index += 1) {
      assert.ok(expected[index]!.length <= contentWidth, `${label}: audit row ${index + 1} fits the ${contentWidth}-column content width`);
      assert.equal(visible[start + index], expected[index]!.trim(),
        `${label}: audit row ${index + 1} reflows at word boundaries`);
      const styled = lines[start + index]!;
      assert.ok(styled.includes(nativeTheme.getFgAnsi(token)), `${label}: audit row ${index + 1} carries the ${token} token`);
      // The #547 failure mode was the gate's own line drawn in the ordinary
      // tool-output colour. (The dark theme maps the diff tokens to the same
      // RGB as the verdict tokens, so the distinction asserted here is the
      // semantic one the card actually has to keep.)
      assert.ok(!styled.includes(nativeTheme.getFgAnsi("toolOutput")),
        `${label}: audit row ${index + 1} is not drawn in the ordinary tool-output colour`);
    }
    assert.equal(stripAnsi(lines.join("\n")).split("Tool protection:").length - 1, 1,
      `${label}: the audit status and reason are displayed exactly once`);
    return start;
  }

  // ── Cell-level background coverage through the pinned headless VT ─────

  /** xterm 6 color-mode flags, as the repository's own TerminalSurface reads them. */
  const VT_RGB = 50331648;
  const VT_PALETTE = [16777216, 33554432];

  interface VtCell {
    readonly chars: string;
    readonly fgMode: number;
    readonly fgValue: number;
    readonly bgMode: number;
    readonly bgValue: number;
  }

  type PackedColor = { kind: "rgb"; value: number } | { kind: "palette"; value: number };

  /** The concrete colour behind one of the real theme's own escape sequences. */
  function packedColor(ansi: string, kind: "fg" | "bg"): PackedColor {
    const code = kind === "bg" ? 48 : 38;
    const match = new RegExp(`\\x1b\\[${code};(2|5);(\\d+)(?:;(\\d+);(\\d+))?m`).exec(ansi);
    assert.ok(match, `${kind} token ${JSON.stringify(ansi)} is an extended colour the VT can compare`);
    if (match[1] === "2") {
      return { kind: "rgb", value: (Number(match[2]) << 16) | (Number(match[3]) << 8) | Number(match[4]) };
    }
    return { kind: "palette", value: Number(match[2]) };
  }

  function cellColor(cell: VtCell, kind: "fg" | "bg"): { mode: number; value: number } {
    return kind === "fg" ? { mode: cell.fgMode, value: cell.fgValue } : { mode: cell.bgMode, value: cell.bgValue };
  }

  function cellHasColor(cell: VtCell, kind: "fg" | "bg", color: PackedColor): boolean {
    const actual = cellColor(cell, kind);
    if (color.kind === "rgb") return actual.mode === VT_RGB && actual.value === color.value;
    return VT_PALETTE.includes(actual.mode) && actual.value === color.value;
  }

  /**
   * Feed the rendered card rows to the pinned @xterm/headless terminal (the same
   * VT the repository's own TerminalSurface wraps, configured the same way) and
   * read back every cell of every row, so background coverage is asserted on
   * actual cells rather than on the presence of an escape sequence in a row.
   */
  async function cardCells(lines: string[], width: number): Promise<VtCell[][]> {
    // cols is one wider than the card: a row of exactly `width` cells would arm
    // the VT's deferred wrap and shift later buffer rows out of alignment with
    // the rendered rows. Columns 0..width-1 are unaffected by that guard.
    const terminal = new Terminal({ cols: width + 1, rows: lines.length + 2, scrollback: 0, allowProposedApi: true });
    try {
      // The headless VT parses writes asynchronously; the callback lands only
      // once every row is in the buffer.
      await new Promise<void>((resolve) => { terminal.write(lines.join("\r\n"), () => resolve()); });
      const buffer = terminal.buffer.active;
      const rows: VtCell[][] = [];
      for (let row = 0; row < lines.length; row += 1) {
        const line = buffer.getLine(row);
        const cells: VtCell[] = [];
        const nullCell = buffer.getNullCell();
        for (let column = 0; column < width; column += 1) {
          const cell = (line?.getCell(column, nullCell)) ?? nullCell;
          cells.push({ chars: cell.getChars(), fgMode: cell.getFgColorMode(), fgValue: cell.getFgColor(), bgMode: cell.getBgColorMode(), bgValue: cell.getBgColor() });
        }
        rows.push(cells);
      }
      return rows;
    } finally {
      terminal.dispose();
    }
  }

  /** Every cell of every card row (below the host's own blank row above it). */
  async function assertEveryCardCellBackground(lines: string[], width: number, backgroundAnsi: string, label: string): Promise<void> {
    const expected = packedColor(backgroundAnsi, "bg");
    const cells = await cardCells(lines, width);
    assert.equal(cells.length, lines.length, `${label}: the VT received every rendered card row`);
    for (let row = 1; row < lines.length; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const cell = cells[row]![column]!;
        assert.ok(cell.bgMode !== 0,
          `${label}: cell ${column} of card row ${row + 1} has no background — an ordinary terminal-background hole inside the card`);
        assert.ok(cellHasColor(cell, "bg", expected),
          `${label}: cell ${column} of card row ${row + 1} is not painted with the themed row background`);
      }
    }
  }

  /** Foreground assertions on the same cells: the gate's own text, and the native rows' own colours. */
  function assertCellForeground(rows: VtCell[][], row: number, width: number, token: string, label: string): void {
    const color = packedColor(nativeTheme.getFgAnsi(token), "fg");
    const painted = rows[row]!.filter((cell, column) => column < width && cellHasColor(cell!, "fg", color)).length;
    assert.ok(painted > 0, `${label}: card row ${row + 1} carries no ${token} cell`);
  }

  function assertNoCellForeground(rows: VtCell[][], row: number, tokens: string[], label: string): void {
    for (const token of tokens) {
      const color = packedColor(nativeTheme.getFgAnsi(token), "fg");
      assert.ok(!rows[row]!.some((cell) => cellHasColor(cell!, "fg", color)),
        `${label}: card row ${row + 1} must not use the ${token} colour`);
    }
  }

  /** The glyphs the VT actually holds for one row, for alignment checks. */
  function rowGlyphs(cells: VtCell[]): string {
    return cells.map((cell) => cell.chars).join("");
  }

  /**
   * The gate's own audit text, cell by cell: every non-blank cell of every
   * independently expected audit row, including wrapped continuations, has to
   * carry the semantic foreground token. A row that paints one cell and leaves
   * the rest default-coloured fails here, which the weaker helpers above
   * (kept for intentionally multicoloured native rows) would not catch.
   */
  function assertAuditCellsForeground(
    rows: VtCell[][],
    auditStart: number,
    expectedRows: string[],
    width: number,
    token: "success" | "warning" | "error",
    label: string,
  ): void {
    const color = packedColor(nativeTheme.getFgAnsi(token), "fg");
    for (let index = 0; index < expectedRows.length; index += 1) {
      const row = auditStart + index;
      assert.equal(rowGlyphs(rows[row]!).trim(), expectedRows[index]!.trim(),
        `${label}: VT buffer row ${row + 1} does not hold audit row ${index + 1}`);
      let textCells = 0;
      let unpainted = 0;
      for (let column = 0; column < width; column += 1) {
        const cell = rows[row]![column]!;
        if (cell.chars.length === 0 || cell.chars === " ") continue;
        textCells += 1;
        if (!cellHasColor(cell, "fg", color)) unpainted += 1;
      }
      // Blank cells carry the row background but no glyph, so the count that has
      // to match is the expected row's non-space characters.
      const expectedGlyphs = expectedRows[index]!.replace(/ /g, "").length;
      assert.equal(textCells, expectedGlyphs,
        `${label}: audit row ${index + 1} renders ${textCells} text cells for ${expectedGlyphs} expected glyphs`);
      assert.equal(unpainted, 0,
        `${label}: ${unpainted} of ${textCells} audit text cells in row ${index + 1} are not drawn with the ${token} foreground`);
    }
  }

  // ── The three families: status once, independent wrap, native body kept ──

  test("real host: native bash, native edit, and renderer-less notice cards each show one word-wrapped audit status", async () => {
    await withEditFixture(async (cwd) => {
      const settled = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: "alpha\nBETA-CHANGED\ngamma\ndelta\n" }], cwd);
      for (const family of ["bash", "edit", "notice"] as CardFamily[]) {
        for (const width of [120, 46]) {
          const details = family === "edit"
            ? { diff: settled.diff, firstChangedLine: settled.firstChangedLine }
            : family === "bash" ? {} : { status: "pending" };
          const card = await auditedCard(family, cwd, { details });
          const collapsed = family === "edit" ? await renderWithPreview(card.component, width) : card.component.render(width);
          const label = `${family} collapsed width ${width}`;
          assertAuditRowsRendered(collapsed, card.annotationText, width - 2, "success", label);
          for (const marker of FAMILY_MARKERS[family]) {
            assert.ok(stripAnsi(collapsed.join("\n")).includes(marker), `${label}: the native ${JSON.stringify(marker)} row is retained`);
          }

          card.component.setExpanded(true);
          const expanded = card.component.render(width);
          const expandedLabel = `${family} expanded width ${width}`;
          assertAuditRowsRendered(expanded, card.annotationText, width - 2, "success", expandedLabel);
          for (const marker of FAMILY_MARKERS[family]) {
            assert.ok(stripAnsi(expanded.join("\n")).includes(marker), `${expandedLabel}: the native ${JSON.stringify(marker)} row is retained`);
          }

          card.component.setExpanded(false);
          assert.deepEqual(card.component.render(width), collapsed,
            `${family} width ${width}: collapsing again reproduces the collapsed card exactly`);
          assert.equal(card.annotationText, (card.annotated.content as Array<Record<string, unknown>>)[0]!.text,
            `${family} width ${width}: rendering never rewrites the model-visible annotation`);
          // The model-visible result is never rewritten by the decoration, checked
          // after the whole collapsed/expanded/re-collapse sequence against
          // snapshots that share no object graph with the pipeline.
          assert.notEqual(card.annotated.content, card.event.content,
            `${family} width ${width}: the annotated payload is not the emitted array itself`);
          assert.deepEqual(card.event.content, card.originalContent,
            `${family} width ${width}: the emitted tool_result content is never mutated`);
          assert.deepEqual((card.annotated.content as Array<Record<string, unknown>>).slice(1), card.originalContent,
            `${family} width ${width}: the native result payload is preserved after the annotation`);
          assert.equal(card.annotated.isError, false, `${family} width ${width}: the native result flag is preserved`);
          if (card.snapshotDetails !== undefined) {
            assert.deepEqual(card.annotated.details, card.snapshotDetails,
              `${family} width ${width}: the native structured details are preserved`);
          }
        }
      }
    });
  });

  // ── Whole-card cell coverage: no ordinary-background hole anywhere ─────

  test("real host: every cell of the integrated audit card keeps the themed row background", async () => {
    await withEditFixture(async (cwd) => {
      const settled = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: "alpha\nBETA-CHANGED\ngamma\ndelta\n" }], cwd);
      await withInstalledHostWidths(async () => {
        const successBg = theme.getBgAnsi("toolSuccessBg");
        for (const family of ["bash", "edit", "notice"] as CardFamily[]) {
          for (const width of [120, 46]) {
            for (const expanded of [false, true]) {
              const details = family === "edit"
                ? { diff: settled.diff, firstChangedLine: settled.firstChangedLine }
                : family === "bash" ? {} : { status: "pending" };
              const card = await auditedCard(family, cwd, { details });
              let lines = family === "edit" ? await renderWithPreview(card.component, width) : card.component.render(width);
              if (expanded) {
                card.component.setExpanded(true);
                lines = card.component.render(width);
              }
              const label = `${family} ${expanded ? "expanded" : "collapsed"} width ${width}`;
              // Cell level, not "the row contains the escape sequence": title,
              // diff/body, audit, gap and padded right-edge cells alike. This runs
              // first so a background hole is reported as a background hole.
              await assertEveryCardCellBackground(lines, width, successBg, label);
              const auditStart = assertAuditRowsRendered(lines, card.annotationText, width - 2, "success", label);
              const cells = await cardCells(lines, width);
              const auditRows = expectedAuditRowTexts(card.annotationText, width - 2);
              assertAuditCellsForeground(cells, auditStart, auditRows, width, "success", label);
              for (let index = 0; index < auditRows.length; index += 1) {
                assertNoCellForeground(cells, auditStart + index, ["toolOutput"], label);
              }
              if (family === "edit") {
                const added = lines.findIndex((line) => stripAnsi(line).includes("BETA-CHANGED"));
                const removed = lines.findIndex((line) => stripAnsi(line).includes("beta"));
                assert.ok(added > 0 && removed > 0, `${label}: the native diff rows are present`);
                assertCellForeground(cells, added, width, "toolDiffAdded", label);
                assertCellForeground(cells, removed, width, "toolDiffRemoved", label);
                assertCellForeground(cells, lines.findIndex((line) => stripAnsi(line).includes("fixture.txt")), width, "toolTitle", label);
              }
            }
          }
        }
      });
    });
  });

  // ── Failed and unaudited cards: row background and text colour differ ──

  test("real host: a failed card keeps gate cells on the error background with success text, and an unaudited card warns", async () => {
    await withEditFixture(async (cwd) => {
      await withInstalledHostWidths(async () => {
        const errorBg = theme.getBgAnsi("toolErrorBg");
        const successBg = theme.getBgAnsi("toolSuccessBg");
        const pi = fakePiHost();
        const { coordinator } = coordinatorFor([JSON.stringify({ decision: "PASS", reason: AUDIT_REASON })], { cwd });
        coordinator.registerHooks(pi.pi);
        assert.equal(await coordinator.admitToolCall(callArgs("edit-failed", "edit", EDIT_ARGS)), undefined);
        const originalContent = [{ type: "text", text: "synthetic edit failure" }];
        const [annotated] = await pi.emit(
          "tool_result",
          resultEvent("edit-failed", "edit", originalContent, { isError: true, details: {} }),
        ) as Array<Record<string, unknown>>;
        const decorated = (pi.pi.__rendererResolver as RendererResolver)("edit", () => nativeEditDefinition);
        assert.ok(decorated?.renderResult);
        const component = new h.agent.ToolExecutionComponent("edit", "edit-failed", EDIT_ARGS, {}, { ...nativeEditDefinition, ...decorated }, ui, cwd);
        component.setArgsComplete();
        component.updateResult(annotated, false);
        const lines = await renderWithPreview(component);
        const width = 120;
        const annotationText = (annotated.content as Array<Record<string, unknown>>)[0]!.text as string;
        const auditStart = assertAuditRowsRendered(lines, annotationText, width - 2, "success", "failed edit card");
        const cells = await cardCells(lines, width);
        const headerBg = packedColor(successBg, "bg");
        const expectedErrorBg = packedColor(errorBg, "bg");
        // No ordinary-background hole anywhere on the failed card, and only the
        // two semantic row backgrounds the host knows about.
        for (let row = 1; row < lines.length; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const cell = cells[row]![column]!;
            assert.ok(cell.bgMode !== 0, `failed edit card: cell ${column} of row ${row + 1} is an ordinary-background hole`);
            assert.ok(cellHasColor(cell, "bg", headerBg) || cellHasColor(cell, "bg", expectedErrorBg),
              `failed edit card: cell ${column} of row ${row + 1} is on neither the preview nor the error row background`);
          }
        }
        // Documented host nuance, asserted per cell rather than changed: the
        // native edit header keeps its own preview-derived background even
        // though the settled result failed, while the gate-owned rows from the
        // collapsed separator down are on the error background.
        const titleRow = lines.findIndex((line) => stripAnsi(line).includes("fixture.txt"));
        assert.ok(titleRow > 0 && titleRow < auditStart, "the native edit title row sits above the audit rows");
        for (let column = 0; column < width; column += 1) {
          assert.ok(cellHasColor(cells[titleRow]![column]!, "bg", headerBg),
            `failed edit card: native header cell ${column} keeps its own preview background`);
        }
        const gateOwnedAbove = cells.slice(1, auditStart).filter((row) => cellHasColor(row[0]!, "bg", expectedErrorBg)).length;
        assert.ok(gateOwnedAbove > 0, "the gate-owned rows above the audit text already use the error background");
        for (let row = auditStart; row < lines.length; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const cell = cells[row]![column]!;
            assert.ok(cell.bgMode !== 0, `failed edit card: cell ${column} of row ${row + 1} is an ordinary-background hole`);
            assert.ok(cellHasColor(cell, "bg", expectedErrorBg),
              `failed edit card: cell ${column} of row ${row + 1} is not on the error row background`);
          }
        }
        assertCellForeground(cells, auditStart, width, "success", "failed edit card");
        const auditRows = expectedAuditRowTexts(annotationText, width - 2);
        assertAuditCellsForeground(cells, auditStart, auditRows, width, "success", "failed edit card");
        for (let index = 0; index < auditRows.length; index += 1) {
          assertNoCellForeground(cells, auditStart + index, ["error"], `failed edit card: audit row ${index + 1}`);
        }
        const errorRow = lines.findIndex((line) => stripAnsi(line).includes("synthetic edit failure"));
        assert.ok(errorRow > auditStart, "the native error body row sits below the audit rows");
        assertCellForeground(cells, errorRow, width, "error", "failed edit card");

        // An unaudited card is a warning, never success, on the same painted card.
        const notice = await auditedCard("notice", cwd, {
          details: { status: "pending" },
          scope: protectionConfig({ scope: "selected", toolNames: ["bash"] }),
        });
        const noticeLines = notice.component.render(46);
        const noticeStart = assertAuditRowsRendered(noticeLines, notice.annotationText, 44, "warning", "unaudited notice card");
        await assertEveryCardCellBackground(noticeLines, 46, successBg, "unaudited notice card");
        assertAuditCellsForeground(await cardCells(noticeLines, 46), noticeStart,
          expectedAuditRowTexts(notice.annotationText, 44), 46, "warning", "unaudited notice card");
      });
    });
  });
}
