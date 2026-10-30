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
}
