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
import type {
  ProtectionAuditorRequest,
  ProtectionAuditorResult,
} from "../src/tool-protection/runner";
import { wrapPreserving } from "../src/tool-result-wrap";
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
  } | undefined;
  assert.ok(theme && typeof theme.fg === "function", "initTheme installed the real native Theme");
  const editRenderers = h.req(path.join(h.agentDir, "dist", "core", "tools", "renderers", "edit.js")).editRenderers;
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

  async function renderWithPreview(component: { render(width: number): string[] }): Promise<string[]> {
    await until(
      () => stripAnsi(component.render(120).join("\n")).includes("BETA-CHANGED"),
      "the native edit preview diff",
    );
    return component.render(120);
  }

  function annotationRows(lines: string[], firstStyledChunk: string): number {
    return lines.findIndex((line) => line.includes(firstStyledChunk));
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
      const decoratedEdit = resolver("edit", () => editRenderers);
      assert.ok(decoratedEdit?.renderResult, "the production resolver decorated the native edit renderers");
      const nativeEdit = { name: "edit", ...(editRenderers as Record<string, unknown>) };

      const decoratedRow = editRow(cwd, { name: "edit", ...decoratedEdit }, annotated);
      const nativeRow = editRow(cwd, nativeEdit, { content: nativeContent, details });
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
      const chunks = wrapPreserving(sanitized, 118);
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
      assert.equal(annotationRows(collapsed, firstChunk), plain.length,
        "collapsed: the audit rows follow the native preview after exactly one separator row");
      assert.equal(stripAnsi(collapsed[plain.length - 1]!).trim(), "", "the collapsed-only separator row is preserved");

      decoratedRow.setExpanded(true);
      const expanded = decoratedRow.render(120);
      for (const chunk of chunks) {
        assert.ok(expanded.some((line) => line.includes(theme.fg("success", chunk))),
          "expanded row carries the same real success token");
      }
      assert.equal(stripAnsi(expanded.join("\n")).split("Tool protection: PASS").length - 1, 1,
        "the expanded row shows the audit status exactly once");
      assert.equal(annotationRows(expanded, firstChunk), plain.length - 1,
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
      const decoratedEdit = resolver("edit", () => editRenderers);
      assert.ok(decoratedEdit?.renderResult);
      const row = editRow(cwd, { name: "edit", ...decoratedEdit }, annotated);
      const collapsed = await renderWithPreview(row);
      const text = stripAnsi(collapsed.join("\n"));
      assert.equal(text.split("Tool protection: PASS").length - 1, 1, "the audit status appears once");
      assert.equal(text.split(errorText).length - 1, 1, "the native error text is preserved exactly once");
      const errorRow = collapsed.find((line) => stripAnsi(line).includes(errorText));
      assert.ok(errorRow?.includes(theme.fg("error", errorText)),
        "the native edit error keeps the host's own error styling");
      const passRow = collapsed.find((line) => stripAnsi(line).includes("Tool protection: PASS"));
      assert.ok(passRow?.includes(theme.getFgAnsi("success")), "the audit row stays success-styled");
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
      const decoratedEdit = resolver("edit", () => editRenderers);
      assert.ok(decoratedEdit?.renderResult);
      const nativeResult = { content: [{ type: "text", text: "Successfully edited fixture.txt" }], details };

      const decorated = await renderWithPreview(editRow(cwd, { name: "edit", ...decoratedEdit }, nativeResult));
      const plain = await renderWithPreview(
        editRow(cwd, { name: "edit", ...(editRenderers as Record<string, unknown>) }, nativeResult),
      );
      assert.deepEqual(decorated, plain, "without an annotation the decoration is byte-identical to the native row");
    });
  });
}
