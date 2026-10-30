// Real-host coverage for the tool-protection audit rows (#547, #549).
//
// The reported #547 shape was a native edit row whose coloured diff was normal
// while the gate's own `Tool protection: PASS` row underneath was unthemed.
// #549 then moved that routine status out of the acting model's tool result
// entirely: a PASS or NOT AUDITED decision is now user-only presentation state,
// looked up by the host's public `toolCallId`, and only a nested refusal stays
// in the model-visible content. This file exercises the installed Pi host
// read-only (never modified):
//
// - the real native `Theme` installed by the host's own `initTheme()`,
// - the real `ToolExecutionComponent` row layout (call region first, result
//   region second), so the native edit preview diff and the decorated audit rows
//   are built by production code, not by a fake layout,
// - the installed `editRenderers`, resolved through the production
//   `registerToolRenderer` resolver captured from the coordinator,
// - the host's own render context (`toolCallId`, per-row `state`), which is what
//   the gate's display lookup is keyed by,
// - diagnostics produced by the production coordinator (real status text), not
//   handcrafted display strings.
//
// The host is discovered with the established pattern from
// tests/tool-result-hints-host.test.ts (an explicit PI_REVIEW_GATE_INSTALLED_AGENT
// pin is the sole candidate; otherwise standard global roots). Without an
// installation the file skips with a reason, or fails under the established
// required-host gate PI_REVIEW_GATE_REQUIRE_PI_HOST=1
// (tests/tool-host-gate.ts).
//
// All fixtures are synthetic and owned: one temporary file with inert text, a
// fake pi host object, and an injected auditor returning fixed JSON. No provider
// request, model call, user file, session, or live runtime is touched.
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
import {
  normalizeAuditDisplayData,
  TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE,
} from "../src/tool-protection/display";
import type {
  ProtectionAuditorRequest,
  ProtectionAuditorResult,
} from "../src/tool-protection/runner";
import type { AuditorRecordHandle } from "../src/tool-protection/session-record";
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

interface EntryRenderer {
  (entry: unknown, options: Record<string, unknown>, theme: unknown): { render(width: number): string[] } | undefined;
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
  registerMissingHostPlaceholder("real host tool-protection renderer coverage", SKIP_REASON);
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
  // The host's own custom-entry component (an installed internal module, read the
  // same way as the edit renderers above): it is what wraps the gate's entry
  // renderer in a real transcript row.
  const { CustomEntryComponent } = h.req(
    path.join(h.agentDir, "dist", "modes", "interactive", "components", "custom-entry.js"),
  ) as {
    CustomEntryComponent: new (
      entry: Record<string, unknown>,
      renderer: EntryRenderer,
      outputPad?: number,
    ) => {
      hasContent(): boolean;
      setExpanded(expanded: boolean): void;
      render(width: number): string[];
    };
  };
  const ui = { requestRender() {} };

  // ── Production display fixtures (fake host + injected auditor) ─────────

  type HookHandler = (...args: unknown[]) => unknown;

  function fakePiHost() {
    const hooks = new Map<string, HookHandler[]>();
    const appended: Array<{ customType: string; data: unknown }> = [];
    const renderers = new Map<string, EntryRenderer>();
    const pi: Record<string, unknown> = {
      on(name: string, handler: HookHandler) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerToolRenderer(resolver: unknown) {
        pi.__rendererResolver = resolver;
      },
      appendEntry(customType: string, data: unknown) {
        appended.push({ customType, data });
      },
      registerEntryRenderer(customType: string, renderer: EntryRenderer) {
        renderers.set(customType, renderer);
      },
    };
    return {
      pi,
      appended,
      renderers,
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
        debug: false,
        ...overrides,
      },
    } as ReviewGateConfig;
  }

  function coordinatorFor(outputs: string[], options: {
    cwd: string;
    config?: ReviewGateConfig;
    /** When set, every auditor-session save fails partially with this warning. */
    recordWarning?: string;
  }) {
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
      ...(options.recordWarning === undefined ? {} : {
        openAuditorRecord: async (): Promise<AuditorRecordHandle> => ({
          complete: () => ({ saved: "partial", detail: "synthetic: entry rejected", warning: options.recordWarning! }),
        }),
      }),
    });
    return { coordinator, calls };
  }

  function hostContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      ...overrides,
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
  const PASS_WITH_REASON = JSON.stringify({ decision: "PASS", reason: "synthetic auditor reason text" });

  async function withEditFixture(run: (cwd: string, details: Record<string, unknown>) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-rg-549-"));
    try {
      await writeFile(path.join(cwd, "fixture.txt"), OLD_TEXT, "utf8");
      const preview = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: NEW_TEXT }], cwd);
      assert.ok(typeof preview.diff === "string", "the owned fixture produced a native edit diff");
      await run(cwd, { diff: preview.diff, firstChangedLine: preview.firstChangedLine });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  function editRow(cwd: string, toolDefinition: unknown, result: unknown, toolCallId = "edit-call") {
    const component = new h.agent.ToolExecutionComponent(
      "edit",
      toolCallId,
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
  const nativeEditContent = [{ type: "text", text: "Successfully edited fixture.txt" }];

  // ── Debug On: one themed reasonless PASS row, native row untouched ────

  test("real host: debug On draws one themed reasonless PASS row and adds nothing to the model result", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: true }) });
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-call", "edit", EDIT_ARGS)), undefined);

      const event = resultEvent("edit-call", "edit", nativeEditContent, {
        details,
        usage: { input: 3, output: 5 },
        structuredContent: { edited: "fixture.txt" },
      });
      const emitted = await pi.emit("tool_result", event);
      assert.deepEqual(emitted, [], "a PASS adds nothing to the acting model's tool result in either debug mode");
      assert.deepEqual(event.content, nativeEditContent, "the native result content is never mutated");

      const appended = pi.appended.filter((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE);
      assert.equal(appended.length, 1, "the PASS diagnostic is published once as ordinary session UI state");
      const data = appended[0]!.data as Record<string, unknown>;
      assert.equal(data.callId, "edit-call");
      assert.equal(data.surface, "row", "the native edit renderer owns the row, so no duplicate entry is drawn");
      assert.ok(!JSON.stringify(data).includes("synthetic auditor reason text"), "no PASS reason is ever stored");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult, "the production resolver decorated the native edit renderers");
      assert.equal((decoratedEdit as { renderShell?: unknown }).renderShell, "self",
        "the decoration keeps the definition's own self shell");

      const decoratedRow = editRow(cwd, decoratedEdit, { content: nativeEditContent, details });
      const nativeRow = editRow(cwd, nativeEditDefinition, { content: nativeEditContent, details });
      const collapsed = await renderWithPreview(decoratedRow);
      const plain = await renderWithPreview(nativeRow);

      // The call region (edit path plus the coloured preview diff) and the
      // native result body are byte-identical; only the gate rows are added.
      assert.deepEqual(
        collapsed.slice(0, plain.length - 1),
        plain.slice(0, -1),
        "the native call preview and coloured diff are unchanged by the decoration",
      );
      const removedRow = collapsed.find((line) => stripAnsi(line).includes("beta"));
      const addedRow = collapsed.find((line) => stripAnsi(line).includes("BETA-CHANGED"));
      assert.ok(removedRow?.includes(theme.getFgAnsi("toolDiffRemoved")), "the removed diff row keeps the native theme colour");
      assert.ok(addedRow?.includes(theme.getFgAnsi("toolDiffAdded")), "the added diff row keeps the native theme colour");

      // Exactly one status line, styled by the real theme's success token after
      // sanitization/wrapping (so the theme escapes are not width), and it is
      // reasonless: the auditor's own reason never reaches the display.
      const statusText = "Tool protection: PASS — the auditor approved this edit call before execution (level \"aligned\", 1 ms). This is an audit decision, not a claim that the tool succeeded.";
      const sanitized = visibleTerminalText(statusText);
      const chunks = wrapAtWordBoundaries(sanitized, 118);
      assert.ok(chunks.length > 1, "the production PASS row wraps at the native content width");
      for (const chunk of chunks) {
        assert.ok(
          collapsed.some((line) => line.includes(theme.fg("success", chunk))),
          `collapsed row carries the real success token for ${JSON.stringify(chunk)}`,
        );
      }
      const flat = stripAnsi(collapsed.join("\n"));
      assert.equal(flat.split("Tool protection: PASS").length - 1, 1, "the collapsed row shows the audit status exactly once");
      assert.ok(!flat.includes("Auditor reason"), "the PASS row states no reason");
      assert.ok(!flat.includes("states no reason") && !flat.includes("not auditor reasoning"),
        "the PASS row adds no replacement-reason footnote in place of the absent reason");
      assert.ok(!flat.includes("synthetic auditor reason text"), "an auditor reason never reaches the display");
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
    });
  });

  // ── Debug Off: the native row is byte-identical ───────────────────────

  test("real host: debug Off draws no positive audit row and leaves the native edit row byte-identical", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: false }) });
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-quiet", "edit", EDIT_ARGS)), undefined);
      assert.deepEqual(await pi.emit("tool_result", resultEvent("edit-quiet", "edit", nativeEditContent, { details })), [],
        "the model-visible result is untouched with debug Off");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => editRenderers);
      assert.ok(decoratedEdit?.renderResult);
      const nativeResult = { content: nativeEditContent, details };
      const decorated = await renderWithPreview(editRow(cwd, { name: "edit", ...decoratedEdit }, nativeResult, "edit-quiet"));
      const plain = await renderWithPreview(editRow(cwd, { name: "edit", ...(editRenderers as Record<string, unknown>) }, nativeResult, "edit-quiet"));
      assert.deepEqual(decorated, plain, "debug Off keeps the native edit row byte-identical, row for row");
    });
  });

  // ── One continuous themed card at every width and toggle state ────────

  test("real host: the audit rows and native body rows form one continuous themed card", async () => {
    await withEditFixture(async (cwd, preview) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor(
        [JSON.stringify({ decision: "PASS", reason: "synthetic call is authorized because it stays inside the owned workspace fixture" })],
        { cwd, config: protectionConfig({ debug: true }) },
      );
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-card", "edit", EDIT_ARGS)), undefined);

      // A result diff that differs from the call preview makes the native edit
      // renderer emit its own body rows (a spacer plus the diff text) below the
      // audit rows; those rows are unpainted by the native renderer, so they
      // used to sit on the terminal's own background.
      const settled = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: "alpha\nBETA-CHANGED\ngamma\ndelta\n" }], cwd);
      const details = { diff: settled.diff, firstChangedLine: settled.firstChangedLine };
      const event = resultEvent("edit-card", "edit", [{ type: "text", text: "Successfully edited fixture.txt" }], { details });
      assert.deepEqual(await pi.emit("tool_result", event), [],
        "a PASS adds no audit text to the acting model's tool result");
      const annotated = event;
      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);

      const successBg = theme.getBgAnsi("toolSuccessBg");
      for (const width of [120, 60, 34]) {
        const row = editRow(cwd, decoratedEdit, annotated, "edit-card");
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
      { cwd: "/work", config: protectionConfig({ debug: true }) },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-call", "YouShouldKnow", { title: "Deployed", body: "shipped" })), undefined);

    const ownContent = [{ type: "text", text: "Notice registered as n-1: \"Deployed\". It stays pending until the user closes it." }];
    const event = resultEvent("notice-call", "YouShouldKnow", ownContent);
    assert.deepEqual(await pi.emit("tool_result", event), [],
      "a PASS adds no audit text to the acting model's tool result");
    const annotated = event;
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
      { cwd: "/work", config: protectionConfig({ debug: true }) },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-image", "YouShouldKnow", { title: "Screenshot", body: "see the image" })), undefined);
    const event = resultEvent(
      "notice-image",
      "YouShouldKnow",
      [{ type: "text", text: "Notice registered as n-2." }, { type: "image", mimeType: "image/png", data: png1x1 }],
    );
    assert.deepEqual(await pi.emit("tool_result", event), [],
      "a PASS adds no audit text to the acting model's tool result");
    const annotated = event;
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
      { cwd: "/work", config: protectionConfig({ debug: true }) },
    );
    coordinator.registerHooks(pi.pi);
    assert.equal(await coordinator.admitToolCall(callArgs("notice-long", "YouShouldKnow", { title: "Long notice", body: "many lines" })), undefined);
    const many = Array.from({ length: 14 }, (_unused, index) => `notice line ${index + 1} carrying several words`).join("\n");
    const event = resultEvent(
      "notice-long",
      "YouShouldKnow",
      [{ type: "text", text: "Notice registered as n-3." }, { type: "text", text: many }],
    );
    assert.deepEqual(await pi.emit("tool_result", event), [],
      "a PASS adds no audit text to the acting model's tool result");
    const annotated = event;
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

  // ── Native error result preserved under the audit row ─────────────────

  test("real host: a native edit error is preserved under the debug-On PASS row", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: true }) });
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-error", "edit", EDIT_ARGS)), undefined);

      const errorText = "synthetic edit failure";
      const emitted = await pi.emit(
        "tool_result",
        resultEvent("edit-error", "edit", [{ type: "text", text: errorText }], { isError: true, details: {} }),
      );
      assert.deepEqual(emitted, [], "an auditor PASS never rewrites a native error result");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);
      const row = editRow(cwd, decoratedEdit, { content: [{ type: "text", text: errorText }], details: {}, isError: true }, "edit-error");
      const collapsed = await renderWithPreview(row);
      const text = stripAnsi(collapsed.join("\n"));
      assert.equal(text.split("Tool protection: PASS").length - 1, 1, "the audit status appears once");
      assert.equal(text.split(errorText).length - 1, 1, "the native error text is preserved exactly once");
      const errorRow = collapsed.find((line) => stripAnsi(line).includes(errorText));
      assert.ok(errorRow?.includes(theme.fg("error", errorText)), "the native edit error keeps the host's own error styling");
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

  // ── NOT AUDITED and nested refusals keep their semantics ──────────────

  test("real host: NOT AUDITED is user-only debug state and never success-styled", async () => {
    await withEditFixture(async (cwd, details) => {
      const notAuditedPi = fakePiHost();
      const notAudited = coordinatorFor(
        [JSON.stringify({ decision: "PASS" })],
        { cwd, config: protectionConfig({ debug: true, scope: "selected", toolNames: ["bash"] }) },
      );
      notAudited.coordinator.registerHooks(notAuditedPi.pi);
      assert.equal(await notAudited.coordinator.admitToolCall(callArgs("edit-not-audited", "edit", EDIT_ARGS)), undefined);
      assert.deepEqual(
        await notAuditedPi.emit("tool_result", resultEvent("edit-not-audited", "edit", nativeEditContent, { details })),
        [],
        "a NOT AUDITED call adds nothing to the acting model's result",
      );

      const resolver = notAuditedPi.pi.__rendererResolver as RendererResolver;
      const baseRenderer = { renderResult: () => ({ render: () => [], invalidate() {} }) };
      const decorated = resolver("edit", () => baseRenderer);
      assert.ok(decorated?.renderResult);
      const rows = decorated.renderResult!(
        { content: nativeEditContent, details },
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, toolCallId: "edit-not-audited", state: {} },
      ).render(400);
      const notAuditedRow = rows.find((line) => stripAnsi(line).includes("Tool protection: NOT AUDITED"));
      assert.ok(notAuditedRow, "the NOT AUDITED row is displayed for the user");
      assert.match(stripAnsi(notAuditedRow), /^Tool protection: NOT AUDITED/);
      assert.ok(notAuditedRow.startsWith(theme.getFgAnsi("warning")), "NOT AUDITED is a warning row, not a success row");
      assert.ok(!notAuditedRow.includes(theme.getFgAnsi("success")), "NOT AUDITED never borrows the success token");

      // With debug Off the same call draws no routine row at all.
      const quietPi = fakePiHost();
      const quiet = coordinatorFor(
        [JSON.stringify({ decision: "PASS" })],
        { cwd, config: protectionConfig({ scope: "selected", toolNames: ["bash"] }) },
      );
      quiet.coordinator.registerHooks(quietPi.pi);
      assert.equal(await quiet.coordinator.admitToolCall(callArgs("edit-quiet-na", "edit", EDIT_ARGS)), undefined);
      await quietPi.emit("tool_result", resultEvent("edit-quiet-na", "edit", nativeEditContent, { details }));
      const quietResolver = quietPi.pi.__rendererResolver as RendererResolver;
      const quietDecorated = quietResolver("edit", () => baseRenderer);
      assert.ok(quietDecorated?.renderResult);
      const quietRows = quietDecorated.renderResult!(
        { content: nativeEditContent, details },
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, toolCallId: "edit-quiet-na", state: {} },
      ).render(400);
      assert.deepEqual(quietRows, [], "debug Off draws no NOT AUDITED row");
    });
  });

  // ── Nested refusals stay model-visible; nested passes do not ──────────

  test("real host: a nested refusal stays model-visible while its sibling PASS is user-only", async () => {
    await withEditFixture(async (cwd) => {
      const pi = fakePiHost();
      const nested = coordinatorFor(
        [
          JSON.stringify({ decision: "PASS", reason: "synthetic outer call is authorized" }),
          JSON.stringify({ decision: "FAIL", reason: "synthetic nested denial" }),
          JSON.stringify({ decision: "PASS", reason: "synthetic nested approval" }),
        ],
        { cwd, config: protectionConfig({ debug: true }) },
      );
      nested.coordinator.registerHooks(pi.pi);
      assert.equal(await nested.coordinator.admitToolCall(callArgs("render-root", "codemode", {})), undefined);
      assert.ok(
        await nested.coordinator.admitToolCall(
          callArgs("render-root/1", "bash", { command: "echo hi" }, { parentToolCallId: "render-root/1" }),
        ),
        "the nested proposal was refused",
      );
      assert.equal(
        await nested.coordinator.admitToolCall(
          callArgs("render-root/2", "read", { path: "fixture.txt" }, { parentToolCallId: "render-root/2" }),
        ),
        undefined,
        "the sibling nested proposal was admitted",
      );
      const [nestedResult] = await pi.emit(
        "tool_result",
        resultEvent("render-root", "codemode", [{ type: "text", text: "outer output" }]),
      ) as Array<Record<string, unknown>>;
      assert.ok(nestedResult, "the outer result carries the refusal aggregate");
      const modelText = (nestedResult.content as Array<Record<string, unknown>>)[0]?.text as string;
      assert.match(modelText, /^Tool protection: 1 nested call\(s\) refused before execution/);
      assert.match(modelText, /- nested bash: FAIL\/BLOCKED before execution — .*synthetic nested denial/);
      assert.ok(!modelText.includes("PASS"), "the acting model is told nothing about the passing calls");
      assert.ok(!modelText.includes("synthetic nested approval"), "no nested PASS reason reaches the acting model");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const baseRenderer = { renderResult: () => ({ render: () => ["outer output"], invalidate() {} }) };
      const decorated = resolver("codemode", () => baseRenderer);
      assert.ok(decorated?.renderResult);
      const rows = decorated.renderResult!(
        nestedResult,
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, toolCallId: "render-root", state: {} },
      ).render(400);
      const flat = stripAnsi(rows.join("\n"));
      const nestedFailRow = rows.find((line) => stripAnsi(line).includes("- nested bash: FAIL/BLOCKED"));
      assert.ok(nestedFailRow, "the nested refusal row is displayed");
      assert.ok(nestedFailRow!.includes(theme.getFgAnsi("error")), "a nested refusal row uses the theme's error token");
      assert.ok(!nestedFailRow!.includes(theme.getFgAnsi("success")), "a nested refusal row is never success-styled");
      const nestedPassRow = rows.find((line) => stripAnsi(line).includes("- nested read: PASS"));
      assert.ok(nestedPassRow, "debug On shows the sibling nested PASS row to the user");
      assert.ok(nestedPassRow!.includes(theme.getFgAnsi("success")), "the nested PASS row is success-styled");
      assert.ok(!flat.includes("synthetic nested approval"), "the nested PASS row states no reason");
      assert.equal(flat.split("- nested bash: FAIL/BLOCKED").length - 1, 1, "the refusal row is not drawn twice");
    });
  });

  test("real host: with debug Off the nested refusal stays visible and the nested PASS row does not", async () => {
    await withEditFixture(async (cwd) => {
      const pi = fakePiHost();
      const nested = coordinatorFor(
        [
          JSON.stringify({ decision: "PASS" }),
          JSON.stringify({ decision: "FAIL", reason: "synthetic nested denial" }),
          JSON.stringify({ decision: "PASS" }),
        ],
        { cwd },
      );
      nested.coordinator.registerHooks(pi.pi);
      assert.equal(await nested.coordinator.admitToolCall(callArgs("quiet-root", "codemode", {})), undefined);
      assert.ok(await nested.coordinator.admitToolCall(
        callArgs("quiet-root/1", "bash", { command: "echo hi" }, { parentToolCallId: "quiet-root/1" }),
      ));
      assert.equal(await nested.coordinator.admitToolCall(
        callArgs("quiet-root/2", "read", { path: "fixture.txt" }, { parentToolCallId: "quiet-root/2" }),
      ), undefined);
      const [nestedResult] = await pi.emit(
        "tool_result",
        resultEvent("quiet-root", "codemode", [{ type: "text", text: "outer output" }]),
      ) as Array<Record<string, unknown>>;
      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decorated = resolver("codemode", () => ({ renderResult: () => ({ render: () => ["outer output"], invalidate() {} }) }));
      assert.ok(decorated?.renderResult);
      const rows = decorated.renderResult!(
        nestedResult,
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, toolCallId: "quiet-root", state: {} },
      ).render(400);
      const flat = stripAnsi(rows.join("\n"));
      assert.ok(flat.includes("- nested bash: FAIL/BLOCKED before execution") && flat.includes("synthetic nested denial"),
        "a refusal stays visible with debug Off");
      assert.ok(!flat.includes("- nested read: PASS"), "debug Off draws no nested PASS row");
    });
  });

  // ── A tool with no result renderer keeps the native fallback ──────────

  test("real host: a tool without a result renderer keeps the native fallback and uses the entry renderer", async () => {
    await withEditFixture(async (cwd) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: true }) });
      coordinator.registerHooks(pi.pi);
      const resolver = pi.pi.__rendererResolver as RendererResolver;
      // The host resolves this tool with no definition record at all: the
      // decoration hands that back untouched, the host's own native result
      // fallback keeps drawing the tool's body, and the gate's rows come from the
      // durable entry renderer. A definition record that merely lacks a result
      // renderer is the other case (#547): the decoration supplies that row's
      // renderer and keeps the host's own fallback conventions for its body.
      assert.equal(resolver("mystery", () => undefined), undefined,
        "the decoration never replaces a tool the host resolves with no definition record");

      assert.equal(await coordinator.admitToolCall(callArgs("mystery-call", "mystery", { q: 1 })), undefined);
      assert.deepEqual(await pi.emit("tool_result", resultEvent("mystery-call", "mystery", [{ type: "text", text: "mystery output" }])), [],
        "the acting model sees only the tool's own output");

      const appended = pi.appended.filter((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE);
      assert.equal(appended.length, 1);
      const data = normalizeAuditDisplayData(appended[0]!.data);
      assert.equal(data?.surface, "entry", "the durable entry is the display surface for this call");
      assert.ok(!JSON.stringify(appended[0]!.data).includes("synthetic auditor reason text"));

      const renderer = pi.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE);
      assert.ok(renderer, "the gate registers a non-context entry renderer, not a raw metadata dump");
      const rows = renderer({ customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data: appended[0]!.data }, { expanded: false }, theme)
        ?.render(200) ?? [];
      const flat = stripAnsi(rows.join("\n"));
      assert.match(flat, /^Tool protection: PASS — the auditor approved this mystery call before execution/);
      assert.ok(rows[0]!.includes(theme.getFgAnsi("success")), "the entry row uses the same existing status styling");

      // Debug Off: the same entry draws nothing at all, rather than a generic
      // metadata fallback.
      const quietPi = fakePiHost();
      const quiet = coordinatorFor([PASS_WITH_REASON], { cwd });
      quiet.coordinator.registerHooks(quietPi.pi);
      const quietResolver = quietPi.pi.__rendererResolver as RendererResolver;
      quietResolver("mystery", () => undefined);
      assert.equal(await quiet.coordinator.admitToolCall(callArgs("quiet-mystery", "mystery", { q: 1 })), undefined);
      await quietPi.emit("tool_result", resultEvent("quiet-mystery", "mystery", [{ type: "text", text: "mystery output" }]));
      const quietEntry = quietPi.appended.find((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
      const quietRenderer = quietPi.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
      assert.equal(quietRenderer({ customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data: quietEntry.data }, { expanded: false }, theme), undefined,
        "a debug-Off positive entry renders nothing");

      // A root refusal for a tool with no result renderer: the host's native
      // result fallback keeps drawing the block reason, and the entry renderer
      // must not repeat it. Both surfaces are rendered together here.
      const refusalWarning = "Tool protection: the auditor session was only partially saved (synthetic: entry rejected); the saved session may be missing its later entries. The gate decision is unchanged.";
      for (const debug of [false, true]) {
        const refusalPi = fakePiHost();
        const refusal = coordinatorFor(['{"decision":"FAIL","reason":"synthetic refusal"}'], {
          cwd,
          config: protectionConfig({ debug, retainAuditorSessions: true }),
          recordWarning: refusalWarning,
        });
        refusal.coordinator.registerHooks(refusalPi.pi);
        const refusalResolver = refusalPi.pi.__rendererResolver as RendererResolver;
        assert.equal(refusalResolver("mystery", () => undefined), undefined,
          `the decoration hands back a tool the host resolves with no definition record (debug ${debug})`);
        const callId = `mystery-refused-${debug}`;
        const refused = await refusal.coordinator.admitToolCall(callArgs(callId, "mystery", { q: 2 }));
        assert.equal(refused?.block, true, "the call was refused");
        assert.ok(refused!.reason.includes(refusalWarning), "the recording failure rides the refusal text");

        const refusalEntry = refusalPi.appended.filter((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE).at(-1)!;
        const normalized = normalizeAuditDisplayData(refusalEntry.data);
        assert.equal(normalized?.surface, "entry", "the refusal's presentation state belongs to the entry surface");
        const refusalRenderer = refusalPi.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
        const entryRows: string[] = refusalRenderer({ customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data: refusalEntry.data }, { expanded: false }, theme)
          ?.render(120) ?? [];
        const entryFlat = stripAnsi(entryRows.join("\n")).replace(/\n/g, "");
        assert.ok(!entryFlat.includes("Tool protection: FAIL"),
          `the entry does not repeat the refusal the native fallback already shows (debug ${debug})`);
        assert.ok(!entryFlat.includes("could not be fully saved") && !entryFlat.includes(refusalWarning),
          `the entry does not repeat the disclosure carried inside that refusal (debug ${debug})`);

        // The real host component for a tool the host gives no renderers for:
        // its native fallback draws the block reason the host produced for the
        // call.
        const component = new h.agent.ToolExecutionComponent(
          "mystery",
          callId,
          { q: 2 },
          {},
          { name: "mystery" },
          ui,
          cwd,
        );
        component.setArgsComplete();
        component.updateResult({ content: [{ type: "text", text: refused!.reason }], isError: true }, false);
        const nativeRows = component.render(120);
        const nativeFlat = stripAnsi(nativeRows.join("\n")).replace(/\n/g, "");
        assert.match(nativeFlat, /Tool protection: FAIL — synthetic refusal/,
          `the untouched native fallback still shows the refusal (debug ${debug})`);

        const combined: string = stripAnsi([...nativeRows, ...entryRows].join("\n")).replace(/\n/g, "");
        assert.equal(combined.split("Tool protection: FAIL").length - 1, 1,
          `the refusal reaches the user exactly once across both surfaces (debug ${debug})`);
        assert.equal(combined.split("only partially saved").length - 1, 1,
          `the save-failure disclosure reaches the user exactly once (debug ${debug})`);
        assert.doesNotMatch(combined, /Tool protection: PASS/, "a refusal is never worded or styled as success");
      }
    });
  });

  // ── Reload restores the rows from the active branch, granting nothing ─

  test("real host: a reload restores user-only rows from the active branch and grants no authority", async () => {
    await withEditFixture(async (cwd, details) => {
      const first = fakePiHost();
      const firstCoordinator = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: true }) });
      firstCoordinator.coordinator.registerHooks(first.pi);
      const resolver = first.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => editRenderers);
      assert.ok(decoratedEdit?.renderResult);
      assert.equal(await firstCoordinator.coordinator.admitToolCall(callArgs("reload-call", "edit", EDIT_ARGS)), undefined);
      await first.emit("tool_result", resultEvent("reload-call", "edit", nativeEditContent, { details }));
      const branch = first.appended.map((row, index) => ({
        type: "custom",
        id: `entry-${index}`,
        customType: row.customType,
        data: row.data,
      }));

      // A fresh runtime for the same session: presentation is rebuilt from the
      // active branch, while admission state starts empty.
      const second = fakePiHost();
      const secondCoordinator = coordinatorFor([JSON.stringify({ decision: "FAIL", reason: "synthetic reload denial" })], { cwd, config: protectionConfig({ debug: true }) });
      secondCoordinator.coordinator.registerHooks(second.pi);
      const secondResolver = second.pi.__rendererResolver as RendererResolver;
      const secondDecorated = secondResolver("edit", () => editRenderers);
      assert.ok(secondDecorated?.renderResult);
      await second.emit("session_start", {}, hostContext({ sessionManager: { getBranch: () => branch } }));

      const rows = secondDecorated.renderResult!(
        { content: nativeEditContent, details },
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, toolCallId: "reload-call", state: {} },
      ).render(120);
      assert.ok(stripAnsi(rows.join("\n")).includes("Tool protection: PASS — the auditor approved this edit call before execution"),
        "the restored branch entry redraws the user-only row");

      // Restored presentation is never an approval: the same call id is audited
      // again and refused on its own merits.
      const blocked = await secondCoordinator.coordinator.admitToolCall(callArgs("reload-call", "edit", EDIT_ARGS));
      assert.ok(blocked, "a replayed row never authorizes a call");
      assert.match(blocked!.reason, /synthetic reload denial/);
    });
  });

  // ── Off: the decoration is byte-identical to the native presentation ──

  test("real host: an unannotated (Off) edit row is byte-identical with and without decoration", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      const { coordinator } = coordinatorFor([], { cwd, config: { ...DEFAULT_CONFIG } as ReviewGateConfig });
      coordinator.registerHooks(pi.pi);
      assert.equal(await coordinator.admitToolCall(callArgs("edit-off", "edit", EDIT_ARGS)), undefined);
      assert.deepEqual(await pi.emit("tool_result", resultEvent("edit-off", "edit", nativeEditContent)), [],
        "Off leaves the native result unannotated");
      assert.deepEqual(pi.appended, [], "Off records no display state at all");

      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const decoratedEdit = resolver("edit", () => nativeEditDefinition);
      assert.ok(decoratedEdit?.renderResult);
      const nativeResult = { content: nativeEditContent, details };

      const decorated = await renderWithPreview(editRow(cwd, decoratedEdit, nativeResult, "edit-off"));
      const plain = await renderWithPreview(
        editRow(cwd, nativeEditDefinition, nativeResult, "edit-off"),
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
   * The user-only status row this gate draws for an admitted call, written out
   * here as the fixture's own expectation (#549): a routine decision adds no
   * text to the acting model's result, so the expected row text cannot be read
   * back from the tool result.
   */
  function expectedStatusText(toolName: string): string {
    return `Tool protection: PASS — the auditor approved this ${toolName} call before execution (level "aligned", 1 ms). This is an audit decision, not a claim that the tool succeeded.`;
  }

  /** The user-only row for a call the configured scope leaves unchecked. */
  function expectedNotAuditedText(toolName: string): string {
    return `Tool protection: NOT AUDITED — ${toolName} is outside the configured toolProtection.scope "selected" audit subset, so the auditor did not evaluate it. The gate did not check this call; only the existing native guards applied.`;
  }

  /**
   * One audited card per family, built entirely by the installed host and the
   * production coordinator: real renderers, real row layout, real call-bound
   * display state. Nothing here runs a shell command, model call, or provider
   * request — the bash fixture is an inert synthetic result handed to the
   * installed shell renderers, and the notice fixture is the project-owned
   * renderer-less tool. A `decision: "FAIL"` fixture is a root refusal: it never
   * reaches `tool_result`, and the host shows the block reason as the row's own
   * result content.
   */
  async function auditedCard(
    family: CardFamily,
    cwd: string,
    options: { details?: Record<string, unknown>; decision?: string; scope?: ReviewGateConfig; reason?: string } = {},
  ): Promise<AuditedCard> {
    const spec = family === "bash"
      ? { toolName: "bash", args: { command: "echo synthetic" }, definition: nativeBashDefinition, content: [{ type: "text", text: BASH_OUTPUT }] }
      : family === "edit"
        ? { toolName: "edit", args: EDIT_ARGS, definition: nativeEditDefinition, content: [{ type: "text", text: "Successfully edited fixture.txt" }] }
        : { toolName: "YouShouldKnow", args: { title: "Deployed", body: "shipped" }, definition: { name: "YouShouldKnow" }, content: [{ type: "text", text: NOTICE_TEXT }] };
    const details = options.details ?? (family === "edit" ? undefined : family === "bash" ? {} : { status: "pending" });
    const callId = `${family}-call`;
    const pi = fakePiHost();
    // These card suites are the presentation surface, so they draw the routine
    // rows (`debug: true`); the quiet `debug: false` behaviour has its own suites.
    const baseConfig = options.scope ?? protectionConfig();
    const config = {
      ...baseConfig,
      toolProtection: { ...baseConfig.toolProtection!, debug: true },
    } as ReviewGateConfig;
    const { coordinator } = coordinatorFor(
      [JSON.stringify({ decision: options.decision ?? "PASS", reason: options.reason ?? AUDIT_REASON })],
      { cwd, config },
    );
    coordinator.registerHooks(pi.pi);
    const refused = options.decision === "FAIL";
    const admission = await coordinator.admitToolCall(callArgs(callId, spec.toolName, spec.args));
    let content = spec.content as Array<Record<string, unknown>>;
    if (refused) {
      assert.ok(admission && (admission as Record<string, unknown>).block === true,
        `${family}: the refused call was blocked before execution for ${spec.toolName}`);
      content = [{ type: "text", text: (admission as { reason: string }).reason }];
    } else {
      assert.equal(admission, undefined, `${family}: the synthetic call was admitted for ${spec.toolName}`);
    }
    // Independent deep snapshots. Nothing handed to the pipeline aliases them,
    // so an in-place mutation of the event array, one of its text blocks, or the
    // structured details changes the actual value only and is caught.
    const snapshotContent = structuredClone(content) as Array<Record<string, unknown>>;
    const snapshotDetails = details === undefined ? undefined : structuredClone(details) as Record<string, unknown>;
    const event: Record<string, unknown> = {
      toolCallId: callId,
      toolName: spec.toolName,
      input: structuredClone(spec.args),
      content: structuredClone(snapshotContent),
      isError: refused,
    };
    if (snapshotDetails !== undefined) event.details = structuredClone(snapshotDetails);
    if (!refused) {
      assert.deepEqual(await pi.emit("tool_result", event), [],
        `${family}: a routine decision adds no audit text to the acting model's tool result`);
    }
    const decorated = (pi.pi.__rendererResolver as RendererResolver)(spec.toolName, () => spec.definition);
    assert.ok(decorated?.renderResult, `${family}: the production resolver decorated this tool`);
    const component = new h.agent.ToolExecutionComponent(
      spec.toolName, callId, spec.args, {}, { ...spec.definition, ...decorated }, ui, cwd,
    );
    component.setArgsComplete();
    component.updateResult(event, false);
    const annotationText = refused
      ? (event.content as Array<Record<string, unknown>>)[0]!.text as string
      : options.scope !== undefined
        ? expectedNotAuditedText(spec.toolName)
        : expectedStatusText(spec.toolName);
    return { component, annotationText, annotated: event, originalContent: snapshotContent, snapshotDetails, event };
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
      // The audit rows are measured with the installed host's own cell widths,
      // which is the measurement a real Pi session uses and under which the
      // annotation's em dash is one cell. Without the alias the decoration runs
      // on its deliberately conservative non-ASCII count, which is not this
      // card's rendering path.
      await withInstalledHostWidths(async () => {
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
            assert.equal(card.annotationText, expectedStatusText(family === "notice" ? "YouShouldKnow" : family),
              `${family} width ${width}: the audit row is this gate's own reasonless status line`);
            // The model-visible result is never rewritten by the decoration, checked
            // after the whole collapsed/expanded/re-collapse sequence against
            // snapshots that share no object graph with the pipeline.
            assert.equal(card.annotated.content, card.event.content,
              `${family} width ${width}: the row is handed the emitted result itself, with no copied annotation`);
            assert.deepEqual(card.event.content, card.originalContent,
              `${family} width ${width}: the emitted tool_result content is never mutated`);
            assert.deepEqual((card.annotated.content as Array<Record<string, unknown>>), card.originalContent,
              `${family} width ${width}: no audit block is prepended to the native result payload`);
            assert.ok(!JSON.stringify(card.event.content).includes("Tool protection:"),
              `${family} width ${width}: the acting model's result carries no audit text`);
            assert.equal(card.annotated.isError, false, `${family} width ${width}: the native result flag is preserved`);
            if (card.snapshotDetails !== undefined) {
              assert.deepEqual(card.annotated.details, card.snapshotDetails,
                `${family} width ${width}: the native structured details are preserved`);
            }
          }
        }
      });
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
        const { coordinator } = coordinatorFor([JSON.stringify({ decision: "PASS", reason: AUDIT_REASON })], { cwd, config: protectionConfig({ debug: true }) });
        coordinator.registerHooks(pi.pi);
        assert.equal(await coordinator.admitToolCall(callArgs("edit-failed", "edit", EDIT_ARGS)), undefined);
        const originalContent = [{ type: "text", text: "synthetic edit failure" }];
        const event = resultEvent("edit-failed", "edit", originalContent, { isError: true, details: {} });
        assert.deepEqual(await pi.emit("tool_result", event), [],
          "a PASS adds no audit text to a native error result either");
        const annotated = event;
        const decorated = (pi.pi.__rendererResolver as RendererResolver)("edit", () => nativeEditDefinition);
        assert.ok(decorated?.renderResult);
        const component = new h.agent.ToolExecutionComponent("edit", "edit-failed", EDIT_ARGS, {}, { ...nativeEditDefinition, ...decorated }, ui, cwd);
        component.setArgsComplete();
        component.updateResult(annotated, false);
        const lines = await renderWithPreview(component);
        const width = 120;
        const annotationText = expectedStatusText("edit");
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

  // ── Wide-emoji audit reasons measured in host cells, not code units ─────

  const CHECK_MARK = "\u2705";
  const FAMILY_GRAPHEME = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const VS16_HEART = "\u2764\uFE0F";
  /** Every one is two host cells per grapheme and appears thirty times. */
  const WIDE_TOKENS = [CHECK_MARK, FAMILY_GRAPHEME, VS16_HEART] as const;

  /**
   * The reported shape: an auditor reason built of three whitespace-free
   * tokens of thirty wide graphemes each. The installed host measures each
   * token at 60 cells — wider than the 44-cell content area of a 46-column
   * card — while a code-point count sees 30 and happily emits a single row the
   * installed TUI rejects outright (`Rendered line N exceeds terminal width`).
   * Each token is oversized, so the ZWJ family and the variation-selector heart
   * go through the oversized-token split itself rather than riding a row whole:
   * a code-point splitter breaks exactly those graphemes in half, which the
   * row-by-row whole-grapheme counts below catch even if only the splitter
   * regresses.
   */
  const WIDE_EMOJI_REASON = `synthetic call stays inside the owned fixture ${CHECK_MARK.repeat(30)} ${FAMILY_GRAPHEME.repeat(30)} ${VS16_HEART.repeat(30)} approved`;

  /**
   * The check the installed host itself performs, run over EVERY emitted row of
   * the card with the installed pi-tui's own `visibleWidth` — never a string
   * length, and never the production wrapper's own measurement.
   */
  function assertInstalledCellWidths(lines: string[], width: number, label: string): void {
    assert.ok(tui && typeof tui.visibleWidth === "function", "the installed pi-tui measures the host's own cell widths");
    const measure = tui!.visibleWidth;
    for (const [index, line] of lines.entries()) {
      const cells = measure(line);
      assert.ok(cells <= width,
        `${label}: installed TUI visibleWidth row ${index + 1} is ${cells} cells for a ${width}-column card: ${JSON.stringify(stripAnsi(line))}`);
    }
  }

  /** Every character of the canonical annotation, in order, across all rows. */
  function assertReasonRetained(lines: string[], annotationText: string, label: string): void {
    const emitted = stripAnsi(lines.join("")).replace(/\s+/g, "");
    assert.ok(emitted.includes(annotationText.replace(/\s+/g, "")),
      `${label}: the audit reason is truncated, dropped, or reordered across the wrapped rows`);
    for (const grapheme of WIDE_TOKENS) {
      const shown = stripAnsi(lines.join("")).split(grapheme).length - 1;
      assert.ok(shown >= 30, `${label}: only ${shown} of the 30 ${JSON.stringify(grapheme)} graphemes reach the display`);
    }
  }

  /**
   * Whole-grapheme occurrences counted row by row. A row that ends half way
   * into a ZWJ sequence or a variation-selector grapheme contributes nothing,
   * so a splitter that breaks graphemes fails here even when the total
   * character count still looks right.
   */
  function assertWholeGraphemesPerRow(lines: string[], grapheme: string, expected: number, label: string): void {
    let whole = 0;
    for (const line of lines) whole += stripAnsi(line).split(grapheme).length - 1;
    assert.equal(whole, expected,
      `${label}: ${whole} whole ${JSON.stringify(grapheme)} graphemes were emitted across the rows, expected ${expected}`);
  }

  /** A row that ends inside an emoji grapheme fails the host's own segmentation. */
  function assertNoBrokenGraphemes(lines: string[], label: string): void {
    for (const [index, line] of lines.entries()) {
      const plain = stripAnsi(line);
      for (const character of plain) {
        const code = character.codePointAt(0)!;
        assert.ok(code < 0xd800 || code > 0xdfff,
          `${label}: row ${index + 1} holds a lone surrogate half — an emoji grapheme was split`);
      }
      assert.ok(!plain.endsWith("\u200d"), `${label}: row ${index + 1} ends inside a ZWJ sequence`);
      assert.ok(!/[\u0300-\u036f\uFE0F]$/.test(plain),
        `${label}: row ${index + 1} carries a combining mark or variation selector separated from its base`);
    }
  }

  /** No card row below the host's own blank row may sit on the terminal background. */
  function assertNoOrdinaryBackgroundHole(lines: string[], allowedBackgrounds: string[], label: string): void {
    for (let index = 1; index < lines.length; index += 1) {
      assert.ok(allowedBackgrounds.some((background) => lines[index]!.includes(background)),
        `${label}: row ${index + 1} is an ordinary-background hole inside the card`);
    }
  }

  test("real host: a wide-emoji audit reason stays inside the installed cell widths at every card width", async () => {
    await withEditFixture(async (cwd) => {
      const settled = await computeEditsDiff("fixture.txt", [{ oldText: OLD_TEXT, newText: "alpha\nBETA-CHANGED\ngamma\ndelta\n" }], cwd);
      await withInstalledHostWidths(async () => {
        // A supplied reason reaches the display through a refusal: a routine PASS
        // shows none (#549), so this suite drives the refusal path, where the
        // auditor's own words stay visible to the user at either `debug` value.
        const rowBg = theme.getBgAnsi("toolErrorBg");
        // A refused native edit row keeps its own preview-derived header/diff
        // background (documented host nuance, asserted per cell in the failed-card
        // suite), so the row background shared by every gate-owned row is checked
        // separately from the native rows above it.
        const nativeRowBg = theme.getBgAnsi("toolSuccessBg");
        for (const family of ["bash", "edit", "notice"] as CardFamily[]) {
          const details = family === "edit"
            ? { diff: settled.diff, firstChangedLine: settled.firstChangedLine }
            : family === "bash" ? {} : { status: "pending" };
          for (const width of [120, 46]) {
            const card = await auditedCard(family, cwd, { details, decision: "FAIL", reason: WIDE_EMOJI_REASON });
            const collapsed = family === "edit" ? await renderWithPreview(card.component, width) : card.component.render(width);
            const label = `${family} collapsed width ${width} wide-emoji reason`;

            // The host's own guard, asserted on every row before anything else.
            assertInstalledCellWidths(collapsed, width, label);
            assertNoOrdinaryBackgroundHole(collapsed, [rowBg, nativeRowBg], label);
            const auditStart = collapsed.findIndex((line) => stripAnsi(line).includes("Tool protection: FAIL"));
            assert.ok(auditStart > 0, `${label}: the audit rows are displayed`);
            assertContinuousBackground(collapsed, rowBg, auditStart, label);
            assertNoBrokenGraphemes(collapsed, label);
            assert.ok(collapsed[auditStart]!.includes(nativeTheme.getFgAnsi("error")),
              `${label}: the wide-emoji audit rows keep the refusal foreground`);
            assertReasonRetained(collapsed, card.annotationText, label);
            for (const grapheme of WIDE_TOKENS) {
              assertWholeGraphemesPerRow(collapsed, grapheme, 30, label);
            }
            const rowsHolding = (grapheme: string) => collapsed.filter((line) => stripAnsi(line).includes(grapheme)).length;
            // Background coverage here is row-level (assertContinuousBackground)
            // rather than cell-by-cell: the pinned headless VT counts `\u2705` as
            // one column unless the repository's own Unicode-11 addon is attached
            // to it, so the existing cell-index helper would measure the harness's
            // width model rather than the card's. Emoji cell coverage is left to
            // the unchanged ASCII card-cell test above.
            if (width === 46) {
              for (const grapheme of WIDE_TOKENS) {
                assert.ok(rowsHolding(grapheme) >= 2,
                  `${label}: the oversized ${JSON.stringify(grapheme)} token is not split across rows but overflows the card`);
              }
            }

            card.component.setExpanded(true);
            const expanded = card.component.render(width);
            const expandedLabel = `${family} expanded width ${width} wide-emoji reason`;
            assertInstalledCellWidths(expanded, width, expandedLabel);
            assertNoOrdinaryBackgroundHole(expanded, [rowBg, nativeRowBg], expandedLabel);
            const expandedAuditStart = expanded.findIndex((line) => stripAnsi(line).includes("Tool protection: FAIL"));
            assert.ok(expandedAuditStart > 0, `${expandedLabel}: the audit rows are still displayed`);
            assertContinuousBackground(expanded, rowBg, expandedAuditStart, expandedLabel);
            assertNoBrokenGraphemes(expanded, expandedLabel);
            assertReasonRetained(expanded, card.annotationText, expandedLabel);
            for (const grapheme of WIDE_TOKENS) {
              assertWholeGraphemesPerRow(expanded, grapheme, 30, expandedLabel);
            }

            // The block reason the host holds for this refused call is never
            // rewritten by the display wrap, before or after rendering.
            const canonical = (card.annotated.content as Array<Record<string, unknown>>)[0]!.text as string;
            assert.equal(canonical, card.annotationText, `${label}: rendering never rewrites the canonical annotation`);
            assert.ok(canonical.includes(WIDE_EMOJI_REASON), `${label}: the canonical reason keeps every emoji code point`);
            assert.deepEqual(card.event.content, card.originalContent,
              `${label}: the emitted tool_result content is never mutated`);
          }
        }
      });
    });
  });
  // ── A root refusal is drawn from recorded provenance, not tool text ─────

  test("real host: every root audit-error refusal reaches a content-ignoring renderer in both debug modes", async () => {
    await withEditFixture(async (cwd) => {
      const outcomes: Array<[string, ReviewGateConfig, string[]]> = [
        // The gate could not even consult an auditor.
        ["unavailable auditor", protectionConfig({ auditor: null }), []],
        // The auditor answered, but with something that is not a decision.
        ["invalid auditor response", protectionConfig({}), ["this is not a protection decision"]],
        // The auditor refused on the merits.
        ["refused decision", protectionConfig({}), ['{"decision":"FAIL","reason":"synthetic refusal"}']],
      ];
      for (const debug of [false, true]) {
        for (const [label, config, outputs] of outcomes) {
          const pi = fakePiHost();
          const { coordinator, calls } = coordinatorFor(outputs, { cwd, config: { ...config, toolProtection: { ...config.toolProtection, debug } } as ReviewGateConfig });
          coordinator.registerHooks(pi.pi);
          const resolver = pi.pi.__rendererResolver as RendererResolver;
          const callId = `refusal-${label.replaceAll(" ", "-")}-${debug}`;
          // A custom renderer that draws neither the content nor anything the
          // gate left in it: without recorded provenance the refusal would be
          // invisible here.
          const ignoring = resolver("edit", () => ({
            renderResult: () => ({ render: () => ["custom renderer view"] }),
          }));
          assert.ok(ignoring?.renderResult);

          const blocked = await coordinator.admitToolCall(callArgs(callId, "edit", EDIT_ARGS));
          assert.equal(blocked?.block, true, `${label} refuses the call (debug ${debug})`);
          if (label === "unavailable auditor") {
            assert.deepEqual(calls, [], "the refusal needed no auditor decision");
            assert.match(blocked!.reason, /^Tool protection: unavailable —/);
          }
          if (label === "invalid auditor response") assert.match(blocked!.reason, /^Tool protection: invalid auditor response —/);

          // The host turns the refusal into this call's error result, and no
          // `tool_result` hook ever runs for it, so the gate never gets a chance
          // to annotate anything: the row must come from the recorded text.
          const rendered = ignoring.renderResult!(
            { content: [{ type: "text", text: blocked!.reason }], details: {}, isError: true },
            { expanded: false, isPartial: false },
            theme,
            { expanded: false, toolCallId: callId, state: {} },
          ).render(120);
          // Display wrapping may split a row mid-word, and the gate's own text is
          // sanitized for display, so compare on the unwrapped rendered text and
          // the refusal's leading clause rather than the whole block reason.
          const flat = stripAnsi(rendered.join("\n")).replace(/\n/g, "");
          const head = blocked!.reason.split(" — ")[0]!;
          assert.ok(flat.includes(head),
            `the ${label} refusal reaches the user through a renderer that ignores content (debug ${debug})`);
          assert.match(flat, /custom renderer view/, "the custom renderer's own body is still drawn");
          assert.doesNotMatch(flat, /Tool protection: PASS/, "a refusal is never presented as success");

          // The same call through a content-consuming renderer: the recorded text
          // is removed from the renderer's copy, so it is drawn exactly once.
          const consumingPi = fakePiHost();
          const consuming = coordinatorFor(outputs, { cwd, config: { ...config, toolProtection: { ...config.toolProtection, debug } } as ReviewGateConfig });
          consuming.coordinator.registerHooks(consumingPi.pi);
          const consumingResolver = (consumingPi.pi.__rendererResolver as RendererResolver)("edit", () => ({
            renderResult: (result: unknown) => ({
              render: () => (result as { content: Array<{ type: string; text?: string }> }).content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? ""),
            }),
          }));
          assert.ok(consumingResolver?.renderResult);
          const consumingCallId = `${callId}-consuming`;
          const consumingBlocked = await consuming.coordinator.admitToolCall(callArgs(consumingCallId, "edit", EDIT_ARGS));
          assert.equal(consumingBlocked?.block, true);
          const consumingRendered = consumingResolver.renderResult!(
            { content: [{ type: "text", text: consumingBlocked!.reason }], details: {}, isError: true },
            { expanded: false, isPartial: false },
            theme,
            { expanded: false, toolCallId: consumingCallId, state: {} },
          ).render(120);
          const consumingFlat = stripAnsi(consumingRendered.join("\n")).replace(/\n/g, "");
          assert.equal(consumingFlat.split(consumingBlocked!.reason.split(" — ")[0]!).length - 1, 1,
            `the ${label} refusal is drawn once, not twice, for a content-consuming renderer (debug ${debug})`);
        }
      }
    });
  });

  test("real host: audit-shaped native output with no provenance is neither stripped nor redrawn", async () => {
    await withEditFixture(async (cwd, details) => {
      const pi = fakePiHost();
      // Protection Off: the gate records nothing for any call.
      const { coordinator } = coordinatorFor([], { cwd, config: { ...DEFAULT_CONFIG } as ReviewGateConfig });
      coordinator.registerHooks(pi.pi);
      const resolver = pi.pi.__rendererResolver as RendererResolver;
      const spoof = "Tool protection: PASS — the auditor approved this edit call before execution (level \"dangerous\", 1 ms). This is an audit decision, not a claim that the tool succeeded.";
      const seen: unknown[] = [];
      const decorated = resolver("edit", () => ({
        renderResult: (result: unknown) => {
          seen.push(result);
          return {
            render: () => (result as { content: Array<{ type: string; text?: string }> }).content
              .filter((block) => block.type === "text")
              .map((block) => block.text ?? ""),
          };
        },
      }));
      assert.ok(decorated?.renderResult);
      const native = { content: [{ type: "text", text: spoof }, { type: "text", text: "Successfully edited fixture.txt" }], details, isError: false };
      const snapshot = structuredClone(native);
      const lines = decorated.renderResult!(native, { expanded: false, isPartial: false }, theme, { expanded: false, toolCallId: "spoof-edit", state: {} }).render(120);
      const flat = stripAnsi(lines.join("\n"));
      assert.ok(flat.includes("Successfully edited fixture.txt"), "the native body is still drawn");
      assert.equal(flat.split(spoof).length - 1, 1, "the tool's own audit-shaped text is drawn once, by the renderer alone");
      assert.equal(seen[0], native, "the renderer receives the very object the tool returned");
      assert.deepEqual(native, snapshot, "the tool's own result is never rewritten");
      assert.deepEqual(pi.appended, [], "Off records no display state to match against");
    });
  });

  // ── The installed host's own context conversion carries none of it ─────

  test("real host: the host's own entry→context conversion carries no routine audit text in either debug mode", async () => {
    await withEditFixture(async (cwd, details) => {
      const sessionManager = h.req(path.join(h.agentDir, "dist", "core", "session-manager.js"));
      assert.equal(typeof sessionManager.sessionEntryToContextMessages, "function",
        "the installed host exposes its own session-entry → model-context conversion");
      const toContext = sessionManager.sessionEntryToContextMessages as (entry: unknown) => unknown[];

      // Control: the conversion under test does carry native tool output into
      // model context, so an empty result below means the audit text is absent
      // rather than that the conversion is a no-op.
      const nativeEntry = {
        type: "message",
        id: "native-entry",
        timestamp: "2024-01-01T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "context-call",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully edited fixture.txt" }],
          isError: false,
          timestamp: 0,
        },
      };
      assert.ok(JSON.stringify(toContext(nativeEntry)).includes("Successfully edited fixture.txt"),
        "native tool output reaches the model through this same conversion");

      for (const debug of [false, true]) {
        const cases: Array<[string, ReviewGateConfig, string[]]> = [
          ["PASS", protectionConfig({ debug }), [PASS_WITH_REASON]],
          ["NOT AUDITED", protectionConfig({ debug, scope: "selected", toolNames: ["bash"] }), []],
        ];
        for (const [label, config, auditorOutputs] of cases) {
          const pi = fakePiHost();
          const { coordinator, calls } = coordinatorFor(auditorOutputs, { cwd, config });
          coordinator.registerHooks(pi.pi);
          // Learn the surface from the host's own renderer resolution: `edit`
          // has a result renderer, so its rows belong to the tool row.
          const resolver = pi.pi.__rendererResolver as RendererResolver;
          const decoratedEdit = resolver("edit", () => editRenderers);
          assert.ok(decoratedEdit?.renderResult);

          const callId = `context-call-${label}-${debug}`;
          assert.equal(await coordinator.admitToolCall(callArgs(callId, "edit", EDIT_ARGS)), undefined);
          const event = resultEvent(callId, "edit", nativeEditContent, { details });
          assert.deepEqual(await pi.emit("tool_result", event), [],
            `${label} (debug ${debug}) adds nothing to the acting model's tool result`);
          assert.deepEqual(event.content, nativeEditContent, "the native result content is never mutated");
          if (label === "NOT AUDITED") {
            assert.deepEqual(calls, [], "a call outside the audit subset never reaches the auditor");
          }

          const entry = pi.appended.find((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE);
          assert.ok(entry, `${label} publishes its diagnostic as one ordinary session entry`);
          assert.equal(normalizeAuditDisplayData(entry.data)?.surface, "row",
            "the durable entry only carries presentation state for a tool that has a result renderer");
          assert.deepEqual(
            toContext({
              type: "custom",
              id: `display-${label}-${debug}`,
              timestamp: "2024-01-01T00:00:00.000Z",
              customType: entry.customType,
              data: entry.data,
            }),
            [],
            `${label} (debug ${debug}) never becomes a model context message`,
          );

          // The same presentation state is what the user's tool row draws.
          const rows = decoratedEdit.renderResult!(
            { content: nativeEditContent, details },
            { expanded: false, isPartial: false },
            theme,
            { expanded: false, toolCallId: callId, state: {} },
          ).render(120);
          const flat = stripAnsi(rows.join("\n"));
          if (debug) {
            assert.match(flat, new RegExp(`Tool protection: ${label}`),
              `debug On draws the ${label} row to the user only`);
          } else {
            assert.doesNotMatch(flat, /Tool protection:/,
              `debug Off draws no routine ${label} row at all`);
          }
          assert.ok(flat.includes("BETA-CHANGED") || flat.includes("fixture.txt"),
            "the native edit row keeps drawing its own body");
        }
      }
    });
  });

  // ── The display route follows the host's current renderer resolution ─────

  test("real host: a result renderer resolved after a refusal draws that refusal once, including after a reload", async () => {
    await withEditFixture(async (cwd, details) => {
      const sessionManager = h.req(path.join(h.agentDir, "dist", "core", "session-manager.js"));
      const toContext = sessionManager.sessionEntryToContextMessages as (entry: unknown) => unknown[];
      for (const debug of [false, true]) {
        const pi = fakePiHost();
        const { coordinator } = coordinatorFor(['{"decision":"FAIL","reason":"synthetic route-change denial"}'], {
          cwd,
          config: protectionConfig({ debug }),
        });
        coordinator.registerHooks(pi.pi);
        const resolver = pi.pi.__rendererResolver as RendererResolver;
        // At refusal time the host resolves this tool with no definition record,
        // so the durable entry records the entry surface and the host's own
        // native result fallback is what shows the block reason.
        assert.equal(resolver("edit", () => undefined), undefined,
          `the decoration hands back a tool the host resolves with no definition record (debug ${debug})`);
        const callId = `route-change-${debug}`;
        const blocked = await coordinator.admitToolCall(callArgs(callId, "edit", EDIT_ARGS));
        assert.equal(blocked?.block, true, `the call is refused (debug ${debug})`);
        const entry = pi.appended.filter((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE).at(-1)!;
        assert.equal(normalizeAuditDisplayData(entry.data)?.surface, "entry",
          `the refusal was recorded while no result renderer existed (debug ${debug})`);

        // The host now resolves the real native edit renderers for that tool: the
        // row is the route drawing this call, and it must draw the recorded
        // refusal exactly once while keeping its own body.
        const decorated = resolver("edit", () => editRenderers);
        assert.ok(decorated?.renderResult, "the production resolver decorated the native edit renderers");
        const row = new h.agent.ToolExecutionComponent(
          "edit", callId, EDIT_ARGS, {}, { name: "edit", ...decorated }, ui, cwd,
        );
        row.setArgsComplete();
        row.updateResult({ content: [{ type: "text", text: blocked!.reason }], details, isError: true }, false);
        const rendered = await renderWithPreview(row);
        const flat = stripAnsi(rendered.join("\n")).replace(/\n/g, "");
        assert.equal(flat.split("Tool protection: FAIL").length - 1, 1,
          `the refusal reaches the user exactly once through the real native row (debug ${debug})`);
        assert.match(flat, /synthetic route-change denial/, "the refusal keeps its supplied reason");
        assert.match(flat, /BETA-CHANGED/, "the native edit row keeps drawing its own preview");
        assert.doesNotMatch(flat, /Tool protection: PASS/, "a refusal is never presented as success");

        // The entry surface stays silent for a call a result renderer owns, and
        // the presentation entry still carries nothing into model context.
        const entryRenderer = pi.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
        const entryRows: string[] = entryRenderer(
          { customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data: entry.data }, { expanded: false }, theme,
        )?.render(120) ?? [];
        assert.deepEqual(entryRows, [], `the entry draws nothing the native row already owns (debug ${debug})`);
        assert.deepEqual(
          toContext({
            type: "custom",
            id: `display-route-change-${debug}`,
            timestamp: "2024-01-01T00:00:00.000Z",
            customType: entry.customType,
            data: entry.data,
          }),
          [],
          "the presentation entry still never becomes a model context message",
        );

        // A reload of the same active branch, in a runtime that resolves the
        // renderer from the start, keeps the same single-route presentation.
        const branch = pi.appended.map((row2, index) => ({
          type: "custom",
          id: `entry-${index}`,
          timestamp: "2024-01-01T00:00:00.000Z",
          customType: row2.customType,
          data: row2.data,
        }));
        const reloaded = fakePiHost();
        const reloadedCoordinator = coordinatorFor([JSON.stringify({ decision: "PASS" })], {
          cwd,
          config: protectionConfig({ debug }),
        });
        reloadedCoordinator.coordinator.registerHooks(reloaded.pi);
        const reloadedResolver = reloaded.pi.__rendererResolver as RendererResolver;
        assert.ok(reloadedResolver("edit", () => editRenderers)?.renderResult);
        await reloaded.emit("session_start", {}, hostContext({ sessionManager: { getBranch: () => branch } }));
        const reloadedRow = new h.agent.ToolExecutionComponent(
          "edit", callId, EDIT_ARGS, {}, { name: "edit", ...(reloadedResolver("edit", () => editRenderers) as Record<string, unknown>) }, ui, cwd,
        );
        reloadedRow.setArgsComplete();
        reloadedRow.updateResult({ content: [{ type: "text", text: blocked!.reason }], details, isError: true }, false);
        const reloadedFlat = stripAnsi((await renderWithPreview(reloadedRow)).join("\n")).replace(/\n/g, "");
        assert.equal(reloadedFlat.split("Tool protection: FAIL").length - 1, 1,
          `a reload with a result renderer still draws the refusal exactly once (debug ${debug})`);
        const reloadedEntryRenderer = reloaded.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
        const reloadedEntry = new CustomEntryComponent(
          { type: "custom", id: "display-reloaded", timestamp: "2024-01-01T00:00:00.000Z", customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE, data: entry.data },
          reloadedEntryRenderer,
        );
        assert.equal(reloadedEntry.hasContent(), false, "the reloaded entry never redraws rows the row surface owns");
      }
    });
  });

  test("real host: a result renderer removed after a call moves its rows to the entry surface exactly once", async () => {
    await withEditFixture(async (cwd) => {
      for (const debug of [false, true]) {
        const pi = fakePiHost();
        const nested = coordinatorFor(
          [
            JSON.stringify({ decision: "PASS" }),
            JSON.stringify({ decision: "FAIL", reason: "synthetic route-change denial" }),
            JSON.stringify({ decision: "PASS" }),
          ],
          { cwd, config: protectionConfig({ debug }) },
        );
        nested.coordinator.registerHooks(pi.pi);
        const resolver = pi.pi.__rendererResolver as RendererResolver;
        // At audit time the host resolves a content-consuming result renderer, so
        // the call is recorded on the row surface.
        const consuming = resolver("codemode", () => ({
          renderResult: (result: unknown) => ({
            render: () => (result as { content: Array<{ type: string; text?: string }> })
              .content.filter((block) => block.type === "text")
              .map((block) => block.text ?? ""),
          }),
        }));
        assert.ok(consuming?.renderResult);
        const callId = `route-lost-${debug}`;
        assert.equal(await nested.coordinator.admitToolCall(callArgs(callId, "codemode", {})), undefined);
        assert.ok(await nested.coordinator.admitToolCall(
          callArgs(`${callId}/1`, "bash", { command: "echo hi" }, { parentToolCallId: `${callId}/1` }),
        ), "the nested proposal is refused");
        assert.equal(await nested.coordinator.admitToolCall(
          callArgs(`${callId}/2`, "read", { path: "fixture.txt" }, { parentToolCallId: `${callId}/2` }),
        ), undefined, "the sibling nested proposal is admitted");
        const [annotated] = await pi.emit(
          "tool_result",
          resultEvent(callId, "codemode", [{ type: "text", text: "outer output" }]),
        ) as Array<Record<string, unknown>>;
        const entry = pi.appended.filter((row) => row.customType === TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE).at(-1)!;
        assert.equal(normalizeAuditDisplayData(entry.data)?.surface, "row", "the call was recorded on the row surface");

        // The host stops resolving a definition record for this tool: its native
        // fallback keeps drawing the call's content untouched, and the durable
        // entry now owns only what that fallback does not already show.
        assert.equal(resolver("codemode", () => undefined), undefined,
          `the decoration hands back a tool the host resolves with no definition record (debug ${debug})`);
        const bareDefinition = { name: "codemode" };
        const component = new h.agent.ToolExecutionComponent("codemode", callId, {}, {}, bareDefinition, ui, cwd);
        component.setArgsComplete();
        component.updateResult(annotated, false);
        const nativeRows = component.render(120);
        assert.match(stripAnsi(nativeRows.join("\n")), /outer output/, "the native fallback still draws the tool's own output");

        const entryRenderer = pi.renderers.get(TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE)!;
        const entryComponent = new CustomEntryComponent(
          {
            type: "custom",
            id: `display-route-lost-${debug}`,
            timestamp: "2024-01-01T00:00:00.000Z",
            customType: TOOL_PROTECTION_DISPLAY_CUSTOM_TYPE,
            data: entry.data,
          },
          entryRenderer,
        );
        const entryRows = entryComponent.hasContent() ? entryComponent.render(120) : [];
        const combined = stripAnsi([...nativeRows, ...entryRows].join("\n")).replace(/\n/g, "");
        assert.equal(combined.split("1 nested call(s) refused before execution").length - 1, 1,
          `the refusal block reaches the user exactly once on the entry surface (debug ${debug})`);
        assert.equal(combined.split("- nested bash: FAIL/BLOCKED").length - 1, 1,
          `the refusal row is not drawn twice (debug ${debug})`);
        assert.equal(combined.split("- nested read: PASS").length - 1, debug ? 1 : 0,
          `the routine nested row is drawn once, and only with debug On (debug ${debug})`);
        // The root call ran and passed, so with debug On the entry also draws its
        // own status row; the refused child is never presented as a pass.
        assert.equal(combined.split("Tool protection: PASS — the auditor approved this codemode call").length - 1, debug ? 1 : 0,
          `the root status row appears once, and only with debug On (debug ${debug})`);
      }
    });
  });

}
