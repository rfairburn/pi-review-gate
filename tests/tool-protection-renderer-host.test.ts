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
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { shellResultDetails } from "../src/background-shell/result-view";
import { APPLY_PATCH_TOOL_NAME, registerApplyPatchTool } from "../src/apply-patch/tool";
import { DeferredToolManager } from "../src/deferred-tools";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
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
  // CSI parameters may carry colon sub-parameters (`\x1b[0;38:2::255:0:0m`),
  // which the terminal, the host width guard, and the Shell family's own wrap
  // all treat as zero-width; the helper has to measure the same way.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "");
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
  // The installed write renderers (`core/tools/renderers/write.js`), spread into
  // a definition the same way the shipped write tool does. `write` declares no
  // `renderShell`, so the host's own `Box` frames it — and unlike the shell
  // renderers it never runs retained text through `stripAnsi`, which is why it
  // is the native card #677 has to repair.
  const nativeWriteRenderers = h.req(path.join(h.agentDir, "dist", "core", "tools", "renderers", "write.js")) as {
    writeRenderers: {
      renderCall(args: unknown, theme: unknown, context: unknown): unknown;
      renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): unknown;
    };
  };
  const nativeWriteDefinition = { name: "write", ...nativeWriteRenderers.writeRenderers };
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
      assert.ok(admission && (admission as { block?: boolean }).block === true,
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


  // ── #677: Shell family rows keep the themed background across resets ────
  //
  // The reported #677 shape is a Shell card whose own row content carries a
  // full reset: the host pads the row and paints it with ONE background span,
  // so the reset cancels that span for the rest of the row and the card's own
  // right padding falls back to the terminal background. Both Shell triggers
  // are witnessed here through the REAL registrations and the REAL host row:
  // the family's wrap closing a continued styled row, and retained child
  // output that already carries resets (mid-row and at the end of a short
  // row). The repair may only re-open the live theme's background after the
  // reset: same glyphs, same rows, same foregrounds, nothing painted past the
  // card.

  /** The five Shell registrations, taken from the production registrar. */
  function registerShellTools(): Record<string, Record<string, unknown>> {
    const tools: Record<string, Record<string, unknown>> = {};
    registerBackgroundShell({
      registerTool: (tool: Record<string, unknown>) => {
        tools[String(tool.name)] = tool;
      },
      on: () => ({}),
      sendMessage: () => ({}),
    } as never);
    return tools;
  }

  const RESET_BEARING_DIFF = "retained diff context alpha beta gamma delta epsilon zeta eta theta iota kappa lambda \x1b[0m tail after a full reset mu nu xi omicron pi rho";
  const RESET_BEARING_BG_RESET = "retained context with a background reset \x1b[49m and more retained text alpha beta gamma delta epsilon";
  const LONG_SHELL_TEXT = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon";
  const RETAINED_RESET_MID = `retained output ${LONG_SHELL_TEXT} \x1b[0m continues after a full reset ${LONG_SHELL_TEXT}`;
  const RETAINED_RESET_TRAILING = "short retained line \x1b[0m";
  const RETAINED_BG_RESET = `retained line with a background reset \x1b[49m and more ${LONG_SHELL_TEXT}`;
  const RETAINED_COLOURED = `\x1b[38;5;208mkept foreground ${LONG_SHELL_TEXT}\x1b[39m tail`;
  // A reset combined with a foreground in ONE sequence: the background is
  // still unset at the end of it, while the red foreground must survive.
  const RETAINED_RESET_PLUS_FG = `reset then red ${LONG_SHELL_TEXT} \x1b[0;38;5;196m red after a reset ${LONG_SHELL_TEXT}`;
  // The same with a colon-form (sub-parameter) foreground: the sequence has to
  // be inspected despite its colons, and the truecolour red must survive.
  const RETAINED_RESET_PLUS_COLON_FG = `reset then colon red ${LONG_SHELL_TEXT} \x1b[0;38:2::255:0:0m colon red after a reset ${LONG_SHELL_TEXT}`;
  // The colon-form (sub-parameter) foreground of a combined reset is asserted
  // in the dedicated own-background test below, which loops over the indexed,
  // zero-padded, and colon forms of a reset combined with a background.

  function shellLogCard(bodyLines: string[]): Record<string, unknown> {
    return {
      content: [{ type: "text", text: `job1 "view" running\n\`\`\`\n${bodyLines.join("\n")}\n\`\`\`` }],
      isError: false,
      details: shellResultDetails("ShellLog", {
        id: "job1", label: "view", status: "running",
        totalLines: bodyLines.length, droppedLines: 0, from: 0, nextOffset: bodyLines.length,
        requestOffset: 0, requestLimit: bodyLines.length,
      }),
    };
  }

  /** The shell-family fixtures that carry a reset into the card: one per
   *  registered tool, each long enough to wrap at both tested widths. */
  function shellResetFixtures(): Array<{ tool: string; result: Record<string, unknown> }> {
    return [
      {
        tool: "ShellStart",
        result: {
          content: [{ type: "text", text: `Started "view" as job1 (pid 1234); currently running.` }],
          isError: false,
          details: shellResultDetails("ShellStart", {
            event: "started", id: "job1", label: LONG_SHELL_TEXT,
            command: `echo ${LONG_SHELL_TEXT} ${LONG_SHELL_TEXT}`,
            state: "running", pid: 1234, startedAt: 1_700_000_000_000, watching: "exit",
          }),
        },
      },
      {
        tool: "ShellList",
        result: {
          content: [{ type: "text", text: `1 background job(s):\n  job1 "${LONG_SHELL_TEXT}" running (pid 1234)` }],
          isError: false,
          details: shellResultDetails("ShellList", {
            jobs: [{
              id: "job1", label: LONG_SHELL_TEXT, status: "running", pid: 1234,
              command: `sleep ${LONG_SHELL_TEXT}`, watching: "exit",
              totalLines: 3, droppedCount: 0, elapsedMs: 5000, lastOutputAgoMs: 1000,
            }],
          }),
        },
      },
      // The asserted retained lines sit at the END of the returned range: the
      // collapsed card truthfully shows the tail of that range, so a line in
      // the middle is legitimately omitted there (and asserted expanded only).
      { tool: "ShellLog", result: shellLogCard([RETAINED_RESET_MID, RETAINED_RESET_TRAILING, RETAINED_BG_RESET, RETAINED_RESET_PLUS_FG, RETAINED_RESET_PLUS_COLON_FG, RETAINED_COLOURED]) },
      {
        tool: "ShellSend",
        result: {
          content: [{ type: "text", text: `Sent 40 bytes to job1 stdin (delivery confirmed).` }],
          isError: false,
          details: shellResultDetails("ShellSend", {
            event: "stdin-write", id: "job1", label: LONG_SHELL_TEXT, bytes: 40, delivery: "confirmed",
          }),
        },
      },
      {
        tool: "ShellStop",
        result: {
          content: [{ type: "text", text: "Stopping 2 job(s)." }],
          isError: false,
          details: shellResultDetails("ShellStop", {
            target: "all", count: 2, outcome: "stopping",
            targets: [{ id: "job1", label: LONG_SHELL_TEXT }, { id: "job2", label: `two ${LONG_SHELL_TEXT}` }],
          }),
        },
      },
    ];
  }

  /** One real host row around a registered Shell renderer. */
  function shellHostRow(tool: string, renderResult: unknown, result: unknown, isPartial = false) {
    const component = new h.agent.ToolExecutionComponent(
      tool, `${tool}-call`, {}, {}, { name: tool, renderResult }, ui, "/work",
    );
    component.setArgsComplete();
    component.updateResult(result, isPartial);
    return component;
  }

  const shellBgToken = (isPartial: boolean, isError: boolean): string =>
    isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";

  test("real host: registered Shell rows keep the themed background across every reset (#677)", async () => {
    const shellTools = registerShellTools();
    for (const fixture of shellResetFixtures()) {
      const renderResult = shellTools[fixture.tool]!.renderResult;
      assert.ok(renderResult, `${fixture.tool} registers a result renderer`);
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          for (const state of ["success", "error", "pending"] as const) {
            const isPartial = state === "pending";
            // The host's own row state: a failed result paints the error
            // background, a partial result the pending one. (The legacy
            // `result.isError` fallback the renderers keep is covered in
            // tests/background-shell-result-view.test.ts.)
            const result = state === "error" ? { ...fixture.result, isError: true } : fixture.result;
            const row = shellHostRow(fixture.tool, renderResult, result, isPartial);
            row.setExpanded(expanded);
            const lines = row.render(width);
            const label = `${fixture.tool} ${state} ${expanded ? "expanded" : "collapsed"} width ${width}`;
            // The trigger itself: unless the card really carries a reset, this
            // case would pass vacuously. (A pending card renders only a short
            // status line, so it cannot carry one.)
            if (!isPartial) {
              assert.ok(/\x1b\[(?:0+m|49m)/.test(lines.join("")),
                `${label}: the fixture no longer produces a background-clearing reset (the case would pass vacuously)`);
            }

            // The card is one continuous themed band, measured CELL BY CELL in
            // the pinned headless VT: every cell of every card row — text,
            // gap, and the host's own padding to the right of the last glyph —
            // carries the live theme's row background. (The string-level
            // `assertContinuousBackground` cannot see this seam: a row keeps
            // its opening sequence even after a reset cancels it.)
            const backgroundAnsi = theme.getBgAnsi(shellBgToken(isPartial, state !== "success"));
            await assertEveryCardCellBackground(lines, width, backgroundAnsi, label);
            assertFitsWidth(lines, width, label);

            // Nothing is painted outside the card: the guard column and the
            // first row after the card keep the terminal's own background.
            const cells = await cardCells(lines, width + 1);
            for (const [index, cellRow] of cells.entries()) {
              if (index === 0) continue;
              // Not merely "not the theme colour": the column past the card
              // carries NO background at all, so nothing the repaired row
              // holds — the theme re-open or a retained own-background
              // sequence — paints outside the card.
              assert.equal(cellRow[width]!.bgMode, 0,
                `${label}: the guard column past the card carries a background`);
            }
            const pastCard = await cardCells([...lines, ""], width);
            const afterCard = pastCard.at(-1)!;
            assert.ok(afterCard.every((cell) => cell.bgMode === 0),
              `${label}: a row outside the card is painted`);

            // The reset itself survives (nothing is stripped or normalized),
            // and the retained text and the family's own foreground stay.
            const joined = lines.join("\n");
            if (fixture.tool === "ShellLog" && state === "success") {
              // Nothing is stripped or normalized: a retained reset still
              // reaches the row, and the retained text is still shown.
              const clearsBackground = /\x1b\[(?:0+m|49m)/.test(joined);
              // The family's wrap breaks on cell boundaries and the host pads
              // every row, so compare the displayed characters with styling,
              // padding, and line breaks removed: nothing may be dropped.
              const flatten = (text: string): string => stripAnsi(text).replace(/\s+/g, "");
              const displayed = flatten(lines.join(""));
              assert.ok(clearsBackground, `${label}: the retained reset was removed`);
              if (expanded) {
                // Expansion renders the complete returned range.
                for (const text of [RETAINED_RESET_MID, RETAINED_RESET_TRAILING, RETAINED_BG_RESET, RETAINED_COLOURED]) {
                  const wanted = flatten(text);
                  assert.ok(wanted.length > 0 && displayed.includes(wanted),
                    `${label}: retained text ${JSON.stringify(stripAnsi(text).trim())} was lost`);
                }
              } else {
                // Collapsed keeps the truthful bounded tail of the returned
                // range and says how many earlier lines it omitted.
                assert.ok(joined.includes("earlier returned line"), `${label}: the collapsed tail note was lost`);
              }
              const kept = packedColor("\x1b[38;5;208m", "fg");
              const keptCells = cells.slice(1).flat().filter((cell) => cellHasColor(cell, "fg", kept)).length;
              assert.ok(keptCells > 0, `${label}: retained foreground was not kept`);
              // A reset combined with a foreground keeps that foreground while
              // the row background is re-opened, and a reset combined with its
              // own background keeps that background.
              if (expanded) {
                // The combined reset+foreground lines are asserted where the
                // complete returned range is rendered; the collapsed card
                // truthfully shows only the tail of that range.
                const redFg = packedColor("\x1b[38;5;196m", "fg");
                const redCells = cells.slice(1).flat().filter((cell) => cellHasColor(cell, "fg", redFg)).length;
                assert.ok(redCells > 0, `${label}: the foreground of a combined reset sequence was not kept`);
                // The colon-form (sub-parameter) truecolour red of
                // `\x1b[0;38:2::255:0:0m` survives as the same RGB colour.
                const colonRedFg: PackedColor = { kind: "rgb", value: 0xff0000 };
                const colonRedCells = cells.slice(1).flat().filter((cell) => cellHasColor(cell, "fg", colonRedFg)).length;
                assert.ok(colonRedCells > 0, `${label}: the colon-form foreground of a combined reset sequence was not kept`);
              }
            }
            const header = lines.find((line) => stripAnsi(line).includes(fixture.tool));
            assert.ok(header, `${label}: the card still names its tool`);
          }
        }
      }
    }
    reapAll();
  });

  test("real host: a wrapped Shell row reopens the background after the wrap's own reset (#677)", async () => {
    const shellTools = registerShellTools();
    // A themed line long enough to wrap: the family's wrap closes every
    // continued styled row with a full reset of its own, which is the second
    // way the reported card loses its background.
    const result = {
      content: [{ type: "text", text: `Started "view" as job1 (pid 1234); currently running.` }],
      isError: false,
      details: shellResultDetails("ShellStart", {
        event: "started", id: "job1", label: "view",
        command: `echo ${LONG_SHELL_TEXT} ${LONG_SHELL_TEXT} ${LONG_SHELL_TEXT}`,
        state: "running", pid: 1234, startedAt: 1_700_000_000_000, watching: "exit, silence 10m",
      }),
    };
    for (const width of [40, 80]) {
      for (const expanded of [false, true]) {
        const row = shellHostRow("ShellStart", shellTools.ShellStart!.renderResult, result);
        row.setExpanded(expanded);
        const lines = row.render(width);
        const label = `wrapped ShellStart ${expanded ? "expanded" : "collapsed"} width ${width}`;
        const backgroundAnsi = theme.getBgAnsi("toolSuccessBg");
        // The trigger itself: the wrap really did close a row with a reset.
        assert.ok(/\x1b\[(?:0+m|49m)/.test(lines.join("")),
          `${label}: the fixture no longer produces the wrap's own reset (the case would pass vacuously)`);
        // Every cell of every row still reaches the card edge painted with the
        // themed background (cell-level, through the pinned headless VT).
        await assertEveryCardCellBackground(lines, width, backgroundAnsi, label);
        assertFitsWidth(lines, width, label);
        const cells = await cardCells(lines, width);
        const glyphText = cells.map((cellRow) => rowGlyphs(cellRow).replace(/\s+$/, "")).join("\n");
        assert.ok(glyphText.includes("alpha beta gamma"), `${label}: the wrapped glyphs changed`);
        assert.ok(!glyphText.includes("\x1b"), `${label}: an escape leaked into the buffer glyphs`);
      }
    }
    reapAll();
  });

  test("real host: other custom tool families keep the themed background across retained resets (#677)", async () => {
    // The same seam is not Shell-specific: every custom tool-result row goes
    // through the shared adapter, and retained content in these families keeps
    // its live SGR (unlike the web families, which display control characters
    // through visibleTerminalText, and the native renderers/fallback, which
    // strip SGR before painting). Each case below is witnessed through the real
    // host row and the real registrations.
    const cases: Array<{ label: string; tool: string; renderResult: unknown; result: Record<string, unknown>; token: string }> = [];

    // ApplyPatch: the partial-failure diagnostic and the retained final diff
    // are rendered unfiltered.
    {
      const tools: Array<Record<string, any>> = [];
      registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => { tools.push(tool); } });
      const applyPatch = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
      assert.ok(applyPatch, "ApplyPatch was not registered");
      cases.push({
        label: "ApplyPatch failure",
        tool: APPLY_PATCH_TOOL_NAME,
        renderResult: applyPatch.renderResult,
        result: {
          content: [{ type: "text", text: `ApplyPatch partial failure ${RESET_BEARING_DIFF}` }],
          isError: true,
          details: { requestedDiff: `${RESET_BEARING_DIFF}\n${RESET_BEARING_BG_RESET}`, finalDiff: `${RESET_BEARING_DIFF}\n${RESET_BEARING_BG_RESET}` },
        },
        token: "toolErrorBg",
      });
    }

    // tool_search: the expanded view renders the raw query and outcome.
    {
      const deferredTools: Array<Record<string, any>> = [];
      new DeferredToolManager({
        registerTool: (tool: Record<string, any>) => { deferredTools.push(tool); },
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => {},
      } as never).register();
      const search = deferredTools.find((candidate) => candidate.name === "tool_search")!;
      assert.ok(search, "tool_search was not registered");
      cases.push({
        label: "tool_search expanded",
        tool: "tool_search",
        renderResult: search.renderResult,
        result: {
          content: [{ type: "text", text: `Discovery ${RESET_BEARING_DIFF}` }],
          details: {
            query: `${RESET_BEARING_DIFF} ${RESET_BEARING_BG_RESET}`,
            activated: ["BrowserClick"], alreadyActive: [], refused: [], omitted: 0,
          },
        },
        token: "toolSuccessBg",
      });
    }

    // Subtasks*: the expanded detail view renders retained task records.
    {
      const executionTools: Array<Record<string, any>> = [];
      const pi: Record<string, any> = {
        registerTool(tool: Record<string, any>) { executionTools.push(tool); },
        registerCommand(_name: string, _options: unknown) {},
        setToolActive() {},
        getActiveTools: () => [...Object.values(EXECUTION_TOOL_NAMES), "read", "bash"],
      };
      new ExecutionToolManager({
        pi,
        config: normalizeConfig({
          enabled: true,
          review: { activeReviewers: [] },
          externalAgents: {
            synthetic: {
              adapter: "run-as-binary",
              command: process.execPath,
              execution: { protocol: "pi-review-executor-jsonl-v1" as const },
            },
          },
          execution: {
            workerResources: { default: { selection: { source: "external", id: "synthetic" }, maxConcurrent: 4 } },
            routes: { execute: [{ resourceId: "default" }], research: [] },
          },
        }),
        state: createState(),
        cwd: () => process.cwd(),
        notify: () => {},
      }).sync();
      const inspect = executionTools.find((candidate) => candidate.name === "SubtasksInspect")!;
      assert.ok(inspect, "SubtasksInspect was not registered");
      cases.push({
        label: "SubtasksInspect expanded",
        tool: "SubtasksInspect",
        renderResult: inspect.renderResult,
        result: {
          // The family's expanded detail view wraps its own retained lines
          // with a plain-text wrap (src/execution/subtask-result-expanded.ts
          // `wrapByDisplayCells`). These fixtures keep each retained value on
          // one row, which is what proves the SHARED adapter reaches this
          // family. A reset that lands ON a wrap boundary there is split by
          // that plain-text wrap (`\x1b[` / `49m` on two rows) — a separate
          // escape-splitting defect in that wrap, not the reset seam, and out
          // of this change's boundary.
          content: [{ type: "text", text: `inspect: outcome \x1b[0m after a full reset` }],
          details: {
            action: "inspect",
            tasks: [{
              taskId: "task-a", state: "running",
              definition: { title: `work alpha \x1b[0m after a full reset` },
              summary: "outcome beta \x1b[49m after a background reset",
            }],
          },
        },
        token: "toolSuccessBg",
      });
    }

    for (const one of cases) {
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          const row = shellHostRow(one.tool, one.renderResult, one.result);
          row.setExpanded(expanded);
          const lines = row.render(width);
          const label = `${one.label} ${expanded ? "expanded" : "collapsed"} width ${width}`;
          // The trigger: the card really carries a background-clearing reset.
          assert.ok(/\x1b\[(?:0+m|49m)/.test(lines.join("")),
            `${label}: the fixture no longer produces a background-clearing reset (the case would pass vacuously)`);
          const backgroundAnsi = theme.getBgAnsi(one.token);
          await assertEveryCardCellBackground(lines, width, backgroundAnsi, label);
          assertFitsWidth(lines, width, label);
          const cells = await cardCells(lines, width + 1);
          for (const [index, cellRow] of cells.entries()) {
            if (index === 0) continue;
            // No background of any colour — the theme re-open or a retained
            // own-background sequence — may reach the column past the card.
            assert.equal(cellRow[width]!.bgMode, 0,
              `${label}: the guard column past the card carries a background`);
          }
        }
      }
    }
  });

  test("real host: a retained background combined with a reset keeps its own colour and still paints the row (#677)", async () => {
    // Each form below resets and then sets the row's OWN background in one
    // sequence. The theme re-open must not override that colour, while the rest
    // of the card keeps the themed background and nothing is left unpainted
    // inside the card. The zero-padded and colon forms are the ones a purely
    // string comparison of the extended-colour mode gets wrong.
    const shellTools = registerShellTools();
    const forms: Array<{ label: string; sequence: string; expected: PackedColor }> = [
      { label: "indexed", sequence: "\x1b[0;48;5;22m", expected: packedColor("\x1b[48;5;22m", "bg") },
      { label: "zero-padded indexed", sequence: "\x1b[0;48;05;0m", expected: { kind: "palette", value: 0 } },
      { label: "colon truecolour", sequence: "\x1b[0;48:2::0:0:0m", expected: { kind: "rgb", value: 0x000000 } },
      // A colon colour carries its payload inside one parameter, so the `2`
      // (dim) after it is another attribute and the `41` after that still sets
      // the row's own background (SGR 41 is palette entry 1 in the VT).
      { label: "colon foreground followed by dim and background", sequence: "\x1b[0;38:2::255:0:0;2;41m", expected: { kind: "palette", value: 1 } },
    ];
    for (const form of forms) {
      const ownRow = `reset then own background ${LONG_SHELL_TEXT} ${form.sequence} kept background ${LONG_SHELL_TEXT}`;
      const result = shellLogCard([
        `plain retained row ${LONG_SHELL_TEXT}`,
        `another plain retained row ${LONG_SHELL_TEXT}`,
        ownRow,
      ]);
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          const row = shellHostRow("ShellLog", shellTools.ShellLog!.renderResult, result);
          row.setExpanded(expanded);
          const lines = row.render(width);
          const label = `${form.label} own-background ShellLog ${expanded ? "expanded" : "collapsed"} width ${width}`;
          assert.ok(lines.join("").includes(form.sequence),
            `${label}: the fixture no longer carries a reset combined with its own background`);
          const backgroundAnsi = theme.getBgAnsi("toolSuccessBg");
          const cells = await cardCells(lines, width + 1);
          const card = cells.slice(1);
          for (const [index, cellRow] of card.entries()) {
            for (let column = 0; column < width; column += 1) {
              assert.ok(cellRow[column]!.bgMode !== 0,
                `${label}: cell ${column} of card row ${index + 2} has no background — an ordinary terminal-background hole inside the card`);
            }
            // The row's own background stops at the card edge too: the guard
            // column keeps no background of any colour.
            assert.equal(cellRow[width]!.bgMode, 0,
              `${label}: the guard column past the card carries a background`);
          }
          const flat = card.flat();
          assert.ok(flat.some((cell) => cellHasColor(cell, "bg", form.expected)),
            `${label}: the row's own combined background was overridden by the theme re-open`);
          assert.ok(flat.some((cell) => cellHasColor(cell, "bg", packedColor(backgroundAnsi, "bg"))),
            `${label}: the rest of the card lost the themed row background`);
        }
      }
    }
    reapAll();
  });

  test("real host: native bash keeps its own background across reset-bearing output (#677 control)", () => {
    // The native shell renderers (shared by bash and powershell) strip SGR
    // from retained output before painting, so no reset can reach the Box row:
    // the same reset-bearing text that cut a Shell card apart leaves a native
    // bash card continuous.
    for (const width of [40, 80]) {
      const component = new h.agent.ToolExecutionComponent(
        "bash", "bash-677", { command: "printf ..." }, {}, nativeBashDefinition, ui, "/work",
      );
      component.setArgsComplete();
      component.updateResult({
        content: [{ type: "text", text: `${RETAINED_RESET_MID}\n${RETAINED_RESET_TRAILING}\n${RETAINED_BG_RESET}` }],
        details: undefined,
        isError: false,
      }, false);
      const lines = component.render(width);
      assertContinuousBackground(lines, theme.getBgAnsi("toolSuccessBg"), 1, `native bash width ${width}`);
      assertFitsWidth(lines, width, `native bash width ${width}`);
    }
  });

  // ── #677: the native write card's own rows keep the themed background ────
  //
  // `write` is the host renderer whose rows carry this seam on the host's own
  // default shell: `formatWriteCall` reprints the submitted `content` argument
  // with carriage-return normalization only, and `formatWriteResult` emits the
  // failed result's own text verbatim, so a full or background reset inside
  // either region cancels the host `Box`'s single background span for the rest
  // of the row. The repair is the shared rule applied at the gate's renderer
  // seam, so every case below runs the production resolver against the real host
  // row and compares with the same host row WITHOUT the decoration: the native
  // renderer, its wrapping, its highlighting, its colours, and its glyphs have
  // to come through untouched, and only the theme's own bare background open may
  // differ. No write is executed and no file is written by these fixtures.

  const WRITE_CONTENT_RESET = [
    `first line ${LONG_SHELL_TEXT}`,
    `second line with a full reset \x1b[0m and more retained text ${LONG_SHELL_TEXT}`,
    `third line with a background reset \x1b[49m and more retained text ${LONG_SHELL_TEXT}`,
    `last short line \x1b[0m`,
  ].join("\n");
  const WRITE_CONTENT_CLEAN = [
    `first line ${LONG_SHELL_TEXT}`,
    `second line with no escape at all ${LONG_SHELL_TEXT}`,
    "last short line",
  ].join("\n");
  const WRITE_ERROR_RESET = `write refused ${LONG_SHELL_TEXT} \x1b[0m tail after a full reset ${LONG_SHELL_TEXT}`;
  const WRITE_ERROR_CLEAN = `write refused ${LONG_SHELL_TEXT} tail with no escape at all`;
  const RESET_BEARING_EDIT_ERROR = `edit refused ${LONG_SHELL_TEXT} \x1b[0m tail after a full reset ${LONG_SHELL_TEXT}`;
  const RESET_FREE_EDIT_ERROR = `edit refused ${LONG_SHELL_TEXT} tail with no escape at all`;

  type WriteRowState = "pending-call" | "pending-partial" | "success" | "error";
  const writeBgToken = (state: WriteRowState): string =>
    state === "success" ? "toolSuccessBg" : state === "error" ? "toolErrorBg" : "toolPendingBg";

  /** One real host `write` row, rendered once at `width`. */
  function writeCardLines(
    definition: unknown,
    args: Record<string, unknown>,
    state: WriteRowState,
    width: number,
    expanded: boolean,
    errorText: string,
  ): string[] {
    const component = new h.agent.ToolExecutionComponent("write", "write-677", args, {}, definition, ui, "/work");
    component.setArgsComplete();
    if (state !== "pending-call") {
      component.updateResult(state === "error"
        ? { content: [{ type: "text", text: errorText }], details: undefined, isError: true }
        : { content: [{ type: "text", text: "Successfully wrote /work/fixture.txt" }], details: undefined, isError: false },
      state === "pending-partial");
    }
    component.setExpanded(expanded);
    return component.render(width);
  }

  const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  /**
   * The decorated card is one continuous themed band to the card edge, cell by
   * cell, with nothing painted past it; the only difference from the undecorated
   * native card is an inserted copy of the theme's own bare background open.
   */
  async function assertWriteCardRepaired(
    decorated: string[],
    native: string[],
    width: number,
    backgroundAnsi: string,
    label: string,
  ): Promise<void> {
    assert.equal(decorated.length, native.length, `${label}: the repair changed the number of card rows`);
    const stripOpen = (line: string): string => line.split(backgroundAnsi).join("");
    for (const [index, line] of decorated.entries()) {
      assert.equal(stripOpen(line), stripOpen(native[index]!),
        `${label}: card row ${index + 1} differs from the native row by more than the re-opened background`);
      assert.equal(stripAnsi(line), stripAnsi(native[index]!),
        `${label}: card row ${index + 1} changed its displayed text`);
    }
    assertFitsWidth(decorated, width, label);
    const cells = await cardCells(decorated, width + 1);
    const expected = packedColor(backgroundAnsi, "bg");
    for (const [index, cellRow] of cells.entries()) {
      if (index === 0) continue; // the host's own blank row above the card
      for (let column = 0; column < width; column += 1) {
        assert.ok(cellRow[column]!.bgMode !== 0,
          `${label}: cell ${column} of card row ${index + 1} has no background — an ordinary terminal-background hole inside the card`);
        assert.ok(cellHasColor(cellRow[column]!, "bg", expected),
          `${label}: cell ${column} of card row ${index + 1} is not painted with the themed row background`);
      }
      // Not merely "not the theme colour": the column past the card carries no
      // background at all, so a re-open can never paint outside the card.
      assert.equal(cellRow[width]!.bgMode, 0, `${label}: the guard column past the card carries a background`);
    }
    const pastCard = await cardCells([...decorated, ""], width);
    assert.ok(pastCard.at(-1)!.every((cell) => cell.bgMode === 0), `${label}: a row outside the card is painted`);
  }

  /** Ordinary-background cells INSIDE the card only: the guard column past the
   *  card is intentionally unpainted and never counts as a hole. */
  async function cardHoles(lines: string[], width: number): Promise<number> {
    const cells = await cardCells(lines, width + 1);
    return cells.slice(1).flatMap((row) => row.slice(0, width)).filter((cell) => cell.bgMode === 0).length;
  }

  test("real host: a native write card keeps the themed background across its own resets (#677)", async () => {
    const pi = fakePiHost();
    // Debug Off keeps this matrix on the native presentation alone: the gate
    // draws no audit rows, so the decorated card and the native card have to
    // agree row for row apart from the re-opened background.
    const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd: "/work", config: protectionConfig({ debug: false }) });
    coordinator.registerHooks(pi.pi);
    const decoratedWrite = (pi.pi.__rendererResolver as RendererResolver)("write", () => nativeWriteDefinition);
    assert.ok(decoratedWrite?.renderResult && typeof (decoratedWrite as { renderCall?: unknown }).renderCall === "function",
      "the production resolver decorated the native write call and result renderers");
    assert.equal((decoratedWrite as { renderShell?: unknown }).renderShell, undefined,
      "the decoration keeps the write definition on the host's default shell");
    for (const extension of ["txt", "js"] as const) {
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          for (const state of ["pending-call", "pending-partial", "success", "error"] as WriteRowState[]) {
            const args = { file_path: `/work/fixture.${extension}`, content: WRITE_CONTENT_RESET };
            const label = `native write .${extension} ${state} ${expanded ? "expanded" : "collapsed"} width ${width}`;
            const decorated = writeCardLines({ ...nativeWriteDefinition, ...decoratedWrite }, args, state, width, expanded, WRITE_ERROR_RESET);
            const native = writeCardLines(nativeWriteDefinition, args, state, width, expanded, WRITE_ERROR_RESET);
            // The trigger: the undecorated native card really does lose its
            // background, so this case would not pass vacuously. Only the card's
            // own columns count — the guard column is unpainted by design.
            const nativeHoles = await cardHoles(native, width);
            assert.ok(nativeHoles > 0,
              `${label}: the undecorated native write card no longer loses its background (the case would pass vacuously)`);
            await assertWriteCardRepaired(decorated, native, width, theme.getBgAnsi(writeBgToken(state)), label);
            // Nothing is stripped or normalized: the retained resets still reach
            // the terminal, in both the call rows and (for a failed result) the
            // result rows.
            const joined = decorated.join("");
            const nativeJoined = native.join("");
            assert.ok(countOf(joined, "\x1b[0m") > 0
              && countOf(joined, "\x1b[0m") === countOf(nativeJoined, "\x1b[0m"),
            `${label}: a retained full reset was stripped or duplicated`);
            assert.equal(countOf(joined, "\x1b[49m"), countOf(nativeJoined, "\x1b[49m"),
              `${label}: a retained background reset was stripped or duplicated`);
            if (state === "error") {
              assert.ok(stripAnsi(joined).includes("tail after a full reset"),
                `${label}: the failed result text was lost`);
            }
            const header = decorated.find((line) => stripAnsi(line).includes("write"));
            assert.ok(header, `${label}: the card no longer names its tool`);
          }
        }
      }
    }
  });

  test("real host: each native write region loses its own background before the repair (#677)", async () => {
    // The call region and the result region are repaired independently, so each
    // is witnessed on its own: a reset only in the submitted `content` argument,
    // a reset only in the failed result's text, and neither. Each dirty case
    // differs from the clean baseline in ONE region while the other region's
    // text is byte-identical, and a hole can only come from a reset inside its
    // own row, so the holes a dirty case adds belong to the region it changed.
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd: "/work", config: protectionConfig({ debug: false }) });
    coordinator.registerHooks(pi.pi);
    const decoratedWrite = (pi.pi.__rendererResolver as RendererResolver)("write", () => nativeWriteDefinition);
    assert.ok(decoratedWrite?.renderResult, "the production resolver decorated the native write renderers");
    const cases = [
      { label: "clean call + clean error", content: WRITE_CONTENT_CLEAN, errorText: WRITE_ERROR_CLEAN, dirty: false },
      { label: "dirty call + clean error", content: WRITE_CONTENT_RESET, errorText: WRITE_ERROR_CLEAN, dirty: true },
      { label: "clean call + dirty error", content: WRITE_CONTENT_CLEAN, errorText: WRITE_ERROR_RESET, dirty: true },
    ];
    for (const extension of ["txt", "js"] as const) {
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          for (const one of cases) {
            const args = { file_path: `/work/fixture.${extension}`, content: one.content };
            const label = `native write .${extension} ${one.label} ${expanded ? "expanded" : "collapsed"} width ${width}`;
            const decorated = writeCardLines({ ...nativeWriteDefinition, ...decoratedWrite }, args, "error", width, expanded, one.errorText);
            const native = writeCardLines(nativeWriteDefinition, args, "error", width, expanded, one.errorText);
            const holes = await cardHoles(native, width);
            if (one.dirty) {
              assert.ok(holes > 0,
                `${label}: this region no longer loses its background on its own (the case would pass vacuously)`);
            } else {
              assert.equal(holes, 0, `${label}: the reset-free baseline card lost its background`);
            }
            await assertWriteCardRepaired(decorated, native, width, theme.getBgAnsi("toolErrorBg"), label);
          }
        }
      }
    }
  });

  test("real host: a reset-free native write card is byte-identical with the decoration (#677 control)", async () => {
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd: "/work", config: protectionConfig({ debug: false }) });
    coordinator.registerHooks(pi.pi);
    const decoratedWrite = (pi.pi.__rendererResolver as RendererResolver)("write", () => nativeWriteDefinition);
    assert.ok(decoratedWrite?.renderResult, "the production resolver decorated the native write renderers");
    for (const extension of ["txt", "js"] as const) {
      for (const width of [40, 80]) {
        for (const expanded of [false, true]) {
          for (const state of ["success", "error"] as WriteRowState[]) {
            const args = { file_path: `/work/fixture.${extension}`, content: WRITE_CONTENT_CLEAN };
            const label = `clean native write .${extension} ${state} ${expanded ? "expanded" : "collapsed"} width ${width}`;
            const decorated = writeCardLines({ ...nativeWriteDefinition, ...decoratedWrite }, args, state, width, expanded, WRITE_ERROR_CLEAN);
            const native = writeCardLines(nativeWriteDefinition, args, state, width, expanded, WRITE_ERROR_CLEAN);
            // Byte-for-byte: a card with no background-clearing reset inside a
            // row gains no escape of any kind, so the repair is provably inert.
            assert.deepEqual(decorated, native, `${label}: a reset-free native write card was rewritten`);
            assert.ok(!decorated.join("").includes("\x1b[0m"), `${label}: the fixture gained a reset`);
            const backgroundAnsi: string = theme.getBgAnsi(writeBgToken(state));
            // One open per painted row, exactly what the host's own `Box` emits.
            for (const line of decorated.slice(1)) {
              assert.ok(line.includes(backgroundAnsi), `${label}: a card row lost the themed row background`);
              assert.equal(countOf(line, backgroundAnsi), 1, `${label}: a row gained a background re-open`);
            }
            await assertWriteCardRepaired(decorated, native, width, backgroundAnsi, label);
          }
        }
      }
    }
  });

  test("real host: the decorated native write card keeps the native renderer's own component and cache (#677)", async () => {
    // The repair wraps what the host receives, so the native renderer must keep
    // receiving its OWN component as `context.lastComponent`: `write`'s call
    // renderer writes its incremental highlighting cache onto that component and
    // calls `setText` on it, neither of which the wrapper carries. The call
    // region and the result region share one per-row `state`, so they must also
    // keep separate slots.
    const passes: Array<{ region: "call" | "result"; lastComponent: unknown; returned: unknown }> = [];
    const nativeRenderers = nativeWriteRenderers.writeRenderers;
    const spyDefinition = {
      name: "write",
      ...nativeWriteRenderers.writeRenderers,
      renderCall(args: unknown, spyTheme: unknown, spyContext: unknown): unknown {
        const returned = nativeRenderers.renderCall(args, spyTheme, spyContext);
        passes.push({ region: "call", lastComponent: (spyContext as { lastComponent?: unknown }).lastComponent, returned });
        return returned;
      },
      renderResult(spyResult: unknown, options: unknown, spyTheme: unknown, spyContext: unknown): unknown {
        const returned = nativeRenderers.renderResult(spyResult, options, spyTheme, spyContext);
        passes.push({ region: "result", lastComponent: (spyContext as { lastComponent?: unknown }).lastComponent, returned });
        return returned;
      },
    };
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd: "/work", config: protectionConfig({ debug: false }) });
    coordinator.registerHooks(pi.pi);
    const decoratedWrite = (pi.pi.__rendererResolver as RendererResolver)("write", () => spyDefinition);
    assert.ok(decoratedWrite?.renderResult && typeof (decoratedWrite as { renderCall?: unknown }).renderCall === "function",
      "the production resolver decorated the spied native write renderers");
    const args = { file_path: "/work/fixture.js", content: "const alpha = 1;\n" };
    const component = new h.agent.ToolExecutionComponent("write", "write-677-cache", args, {}, { ...spyDefinition, ...decoratedWrite }, ui, "/work");
    // A streaming call: this is the pass where the native renderer keeps an
    // incremental highlighting cache, so it is the one a handed-back wrapper
    // would break.
    component.render(40);
    const callPasses = (): Array<{ lastComponent: unknown; returned: unknown }> => passes.filter((one) => one.region === "call");
    assert.equal(callPasses()[0]!.lastComponent, undefined, "the first call pass hands the native renderer no previous component");
    const callComponent = callPasses()[0]!.returned as Record<string, unknown>;
    assert.equal(typeof callComponent.setText, "function", "the native call renderer returned its own Text component");
    // A streamed argument delta, then an unchanged redraw, then both expansion
    // toggles, then a settled result: the native component is reused every time.
    (component as unknown as { updateArgs(next: unknown): void }).updateArgs({ file_path: "/work/fixture.js", content: "const alpha = 1;\nconst beta = 2;\n" });
    component.render(40);
    const cache = (callComponent as { cache?: { highlightedLines?: string[] } }).cache;
    assert.ok(cache && Array.isArray(cache.highlightedLines) && cache.highlightedLines.length > 0,
      "the native incremental highlighting cache survived the decoration");
    component.render(40);
    assert.equal((callComponent as { cache?: unknown }).cache, cache,
      "the native highlighting cache object was rebuilt across redraws");
    component.setExpanded(true);
    component.render(40);
    component.setExpanded(false);
    component.render(40);
    // Settling the call is the host's own transition (its renderer stops
    // maintaining the incremental cache for a complete call); the reused
    // component and the result region's separate slot still hold.
    component.setArgsComplete();
    component.updateResult({ content: [{ type: "text", text: WRITE_ERROR_RESET }], details: undefined, isError: true }, false);
    component.render(40);
    // Expansion re-runs both regions, so the result region's own component has
    // to be reused there exactly as the call region's is here.
    component.setExpanded(true);
    component.render(40);
    component.setExpanded(false);
    component.render(40);
    for (const [index, pass] of callPasses().slice(1).entries()) {
      assert.equal(pass.lastComponent, callComponent,
        `call pass ${index + 2}: the native renderer was handed something other than its own component, breaking its incremental reuse`);
    }
    const resultPasses = passes.filter((one) => one.region === "result");
    assert.ok(resultPasses.length >= 2, "the result region rendered after the settled result");
    assert.equal(resultPasses[0]!.lastComponent, undefined, "the first result pass hands the native renderer no previous component");
    const resultComponent = resultPasses[0]!.returned;
    for (const [index, pass] of resultPasses.entries()) {
      assert.notEqual(pass.lastComponent, callComponent,
        `result pass ${index + 1}: the result region was handed the call region's component (the two share one row state)`);
      if (index > 0) {
        assert.equal(pass.lastComponent, resultComponent,
          `result pass ${index + 1}: the native result renderer was handed something other than its own component`);
      }
    }    // The repair still holds on every redraw, including the settled error card.
    const decorated = component.render(40);
    const cells = await cardCells(decorated, 41);
    for (const [index, cellRow] of cells.entries()) {
      if (index === 0) continue;
      for (let column = 0; column < 40; column += 1) {
        assert.ok(cellRow[column]!.bgMode !== 0,
          `write redraw: cell ${column} of card row ${index + 1} has no background — an ordinary terminal-background hole inside the card`);
      }
      assert.equal(cellRow[40]!.bgMode, 0, "write redraw: the guard column past the card carries a background");
    }
  });

  test("real host: a state-less write context keeps the native write component unwrapped (#677)", () => {
    // A lightweight host context with no per-row `state` has nowhere to remember
    // the native component, so BOTH regions have to keep handing the native
    // renderer its own component: the write call renderer writes its
    // highlighting cache onto it and calls `setText` on it, and the result
    // renderer calls `setText` (a failed result) or `clear` (no output) on
    // whatever `context.lastComponent` holds. Neither method exists on the
    // background wrapper, so wrapping without a slot would push the host onto
    // its own fallback renderer instead of the native presentation.
    const observed: Array<{ region: "call" | "result"; lastComponent: unknown; returned: unknown }> = [];
    const nativeRenderers = nativeWriteRenderers.writeRenderers;
    const spyDefinition = {
      name: "write",
      ...nativeWriteRenderers.writeRenderers,
      renderCall(args: unknown, spyTheme: unknown, spyContext: unknown): unknown {
        const returned = nativeRenderers.renderCall(args, spyTheme, spyContext);
        observed.push({
          region: "call",
          lastComponent: (spyContext as { lastComponent?: unknown }).lastComponent,
          returned,
        });
        return returned;
      },
      renderResult(spyResult: unknown, options: unknown, spyTheme: unknown, spyContext: unknown): unknown {
        const returned = nativeRenderers.renderResult(spyResult, options, spyTheme, spyContext);
        observed.push({
          region: "result",
          lastComponent: (spyContext as { lastComponent?: unknown }).lastComponent,
          returned,
        });
        return returned;
      },
    };
    const pi = fakePiHost();
    const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd: "/work", config: protectionConfig({ debug: false }) });
    coordinator.registerHooks(pi.pi);
    const decorated = (pi.pi.__rendererResolver as RendererResolver)("write", () => spyDefinition) as unknown as {
      renderCall(args: unknown, theme: unknown, context: unknown): { render(width: number): string[] } & Record<string, unknown>;
      renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): { render(width: number): string[] } & Record<string, unknown>;
    };
    assert.ok(typeof decorated.renderResult === "function" && typeof decorated.renderCall === "function",
      "the production resolver decorated the spied native write renderers");
    const args = { file_path: "/work/fixture.js", content: "const alpha = 1;\n" };
    // No `state` key anywhere, and a call id this gate has no provenance for, so
    // the decoration has neither a per-row slot nor an annotation of its own.
    const context = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      toolCallId: "write-stateless",
      args,
      cwd: "/work",
      ui: {},
      argsComplete: true,
      isPartial: false,
      expanded: false,
      isError: false,
      outputPad: 1,
      ...over,
    });
    const passes = (region: "call" | "result") => observed.filter((one) => one.region === region);

    // Two consecutive call passes, the second handed the first component back.
    const firstCall = decorated.renderCall(args, nativeTheme, context({ isPartial: true, argsComplete: false }));
    decorated.renderCall(args, nativeTheme, context({ isPartial: true, argsComplete: false, lastComponent: firstCall }));
    assert.equal(passes("call")[1]!.lastComponent, firstCall,
      "the state-less call pass was handed the component the previous pass returned");
    assert.equal(passes("call")[1]!.returned, firstCall,
      "the state-less call fallback returned the native component itself, not the background wrapper");
    assert.equal(typeof firstCall.setText, "function",
      "the reused call component is the native Text the call renderer writes its text and cache onto");

    // Two consecutive failed-result renders.
    const errorResult = { content: [{ type: "text", text: WRITE_ERROR_RESET }], details: undefined };
    const firstError = decorated.renderResult(errorResult, { expanded: false, isPartial: false }, nativeTheme, context({ isError: true }));
    const secondError = decorated.renderResult(errorResult, { expanded: false, isPartial: false }, nativeTheme, context({ isError: true, lastComponent: firstError }));
    assert.equal(passes("result")[0]!.lastComponent, undefined, "the first state-less result pass hands the native renderer no previous component");
    assert.equal(passes("result")[1]!.lastComponent, firstError,
      "the state-less result pass was handed the component the previous result pass returned, not the background wrapper");
    assert.equal(passes("result")[1]!.returned, firstError,
      "the state-less result fallback returned the native component itself, not the background wrapper");
    assert.equal(secondError, firstError, "the failed result reuses one native component across renders");
    assert.equal(typeof firstError.setText, "function",
      "the reused failed-result component is the native Text the error path calls setText on");

    // Two consecutive success renders: the no-output path calls `clear()`.
    const successResult = { content: [{ type: "text", text: "Successfully wrote /work/fixture.txt" }], details: undefined };
    const firstSuccess = decorated.renderResult(successResult, { expanded: false, isPartial: false }, nativeTheme, context());
    decorated.renderResult(successResult, { expanded: false, isPartial: false }, nativeTheme, context({ lastComponent: firstSuccess }));
    assert.equal(passes("result").at(-1)!.lastComponent, firstSuccess,
      "the second state-less success pass was handed the same native component");
    assert.equal(typeof firstSuccess.clear, "function",
      "the reused empty-output component is the native Container the result path calls clear on");

    // And the state-less fallback really is the unchanged native presentation:
    // nothing gained a theme background of its own.
    const errorBg = theme.getBgAnsi("toolErrorBg");
    assert.ok(!secondError.render(38).join("").includes(errorBg),
      "the state-less fallback painted a row background the native renderer does not emit");
  });

  test("real host: a gate-painted annotated edit error keeps its background across a retained reset (#677)", async () => {
    // A self-shell row is painted by this gate, not by the host's `Box`, so the
    // same seam lives in `paintAnnotationRow`: a reset surviving inside a body
    // row cancels the gate's own background span for the rest of the row. Only
    // annotated rows are affected — an unannotated native edit keeps the host's
    // own unpainted presentation, which this change does not touch.
    await withEditFixture(async (cwd) => {
      await withInstalledHostWidths(async () => {
        const errorBgAnsi = theme.getBgAnsi("toolErrorBg");
        const errorBg = packedColor(errorBgAnsi, "bg");
        const errorFg = packedColor(theme.getFgAnsi("error"), "fg");
        for (const fixture of [
          { label: "reset-bearing", text: RESET_BEARING_EDIT_ERROR, inserted: true },
          { label: "reset-free", text: RESET_FREE_EDIT_ERROR, inserted: false },
        ]) {
          for (const width of [40, 80]) {
            for (const expanded of [false, true]) {
              const pi = fakePiHost();
              const { coordinator } = coordinatorFor([PASS_WITH_REASON], { cwd, config: protectionConfig({ debug: true }) });
              coordinator.registerHooks(pi.pi);
              assert.equal(await coordinator.admitToolCall(callArgs("edit-677-error", "edit", EDIT_ARGS)), undefined);
              const event = resultEvent("edit-677-error", "edit", [{ type: "text", text: fixture.text }], { isError: true, details: {} });
              assert.deepEqual(await pi.emit("tool_result", event), [],
                "a PASS adds no audit text to a native error result either");
              const decorated = (pi.pi.__rendererResolver as RendererResolver)("edit", () => nativeEditDefinition);
              assert.ok(decorated?.renderResult, "the production resolver decorated the native edit renderers");
              const component = new h.agent.ToolExecutionComponent(
                "edit", "edit-677-error", EDIT_ARGS, {}, { ...nativeEditDefinition, ...decorated }, ui, cwd,
              );
              component.setArgsComplete();
              component.updateResult(event, false);
              let lines = await renderWithPreview(component, width);
              if (expanded) {
                component.setExpanded(true);
                lines = component.render(width);
              }
              const label = `annotated edit error ${fixture.label} ${expanded ? "expanded" : "collapsed"} width ${width}`;
              const cells = await cardCells(lines, width + 1);
              for (const [index, cellRow] of cells.entries()) {
                if (index === 0) continue; // the host's own blank row above the card
                for (let column = 0; column < width; column += 1) {
                  assert.ok(cellRow[column]!.bgMode !== 0,
                    `${label}: cell ${column} of card row ${index + 1} has no background — an ordinary terminal-background hole inside the card`);
                }
                assert.equal(cellRow[width]!.bgMode, 0, `${label}: the guard column past the card carries a background`);
              }
              const auditStart = lines.findIndex((line) => stripAnsi(line).includes("Tool protection: PASS"));
              assert.ok(auditStart > 0, `${label}: the gate's own audit row is drawn`);
              assertFitsWidth(lines, width, label);
              if (fixture.inserted) {
                const joined = lines.join("");
                assert.ok(joined.includes("\x1b[0m"),
                  `${label}: the fixture no longer renders a retained reset (the case would pass vacuously)`);
                const seam = lines
                  .map((line, index) => ({ line, index }))
                  .filter((one) => stripAnsi(one.line).includes("tail after a full reset"));
                assert.ok(seam.length > 0, `${label}: the reset-bearing error text was not rendered`);
                for (const one of seam) {
                  for (let column = 0; column < width; column += 1) {
                    assert.ok(cellHasColor(cells[one.index]![column]!, "bg", errorBg),
                      `${label}: cell ${column} of the reset-bearing card row ${one.index + 1} is not on the error row background`);
                  }
                  // The row keeps its own foreground through the reset.
                  assert.ok(cells[one.index]!.some((cell) => cell.chars.length > 0 && cell.chars !== " "
                    && cellHasColor(cell, "fg", errorFg)),
                  `${label}: the reset-bearing row lost its error foreground`);
                }
              } else {
                // Reset-free control: every gate-painted row keeps exactly the
                // one open and one close the paint itself emits — the repair
                // inserted nothing anywhere.
                for (const line of lines.slice(auditStart)) {
                  assert.ok(!line.includes("\x1b[0m") && !line.includes("\x1b[49m\x1b[49m"),
                    `${label}: the reset-free fixture gained a reset`);
                  assert.equal(countOf(line, errorBgAnsi), 1, `${label}: a gate-painted row gained a background re-open`);
                  assert.equal(countOf(line, "\x1b[49m"), 1, `${label}: a gate-painted row gained a background close`);
                }
              }
            }
          }
        }
      });
    });
  });

}
