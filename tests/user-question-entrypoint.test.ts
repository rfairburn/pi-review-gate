import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";
import { setHostKeybindingLoader } from "../src/host-keybindings";
import { safeMarkdownDisplaySource } from "../src/markdown-safety";
import { USER_QUESTION_PANEL_KEY, pendingQuestionPanelLine, questionShortcutLabel } from "../src/user-question";
import { setUserQuestionTuiHost } from "../src/user-question/pi-tui-host";
import {
  setNativeEditorHost,
  __resetActiveNativeEditorFieldForTest,
} from "../src/native-editor-bridge";
import { createBridgeUi, fakeHost, type FakeBridgeEditor } from "./bridge-fakes";

const indexTestConfig = {
  enabled: true,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
} as const;

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRuntimeRole: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  // Hermetic top-level surface: an inherited executor role would divert
  // activate() to the executor runtime branch (orchestrated workers set it).
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
  setHostKeybindingLoader(undefined);
  setNativeEditorHost(undefined);
  setUserQuestionTuiHost(undefined);
  __resetActiveNativeEditorFieldForTest();
});

/** Poll until the condition holds (the custom factory runs after an await hop). */
async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type PublicOverlayMargin = number | { top?: number; right?: number; bottom?: number; left?: number };
type PublicOverlayOptions = { anchor?: string; width?: number | string; maxHeight?: number | string; margin?: PublicOverlayMargin };

function publicOverlayHeight(
  options: PublicOverlayOptions,
  terminalRows: number,
): number {
  const percentage = typeof options.maxHeight === "string" ? options.maxHeight.match(/^(\d+(?:\.\d+)?)%$/u) : null;
  const requested = percentage
    ? Math.floor(terminalRows * Number(percentage[1]) / 100)
    : typeof options.maxHeight === "number" ? options.maxHeight : Number.POSITIVE_INFINITY;
  const margins = typeof options.margin === "number"
    ? { top: options.margin, bottom: options.margin }
    : options.margin ?? {};
  const verticalMargin = Math.max(0, margins.top ?? 0) + Math.max(0, margins.bottom ?? 0);
  const available = Math.max(1, terminalRows - verticalMargin);
  return Math.max(1, Math.min(requested, available));
}

function publicOverlayWidth(options: PublicOverlayOptions, terminalColumns: number): number {
  const percentage = typeof options.width === "string" ? options.width.match(/^(\d+(?:\.\d+)?)%$/u) : null;
  const requested = percentage
    ? Math.floor(terminalColumns * Number(percentage[1]) / 100)
    : typeof options.width === "number" ? options.width : terminalColumns;
  const margins = typeof options.margin === "number"
    ? { left: options.margin, right: options.margin }
    : options.margin ?? {};
  const horizontalMargin = Math.max(0, margins.left ?? 0) + Math.max(0, margins.right ?? 0);
  return Math.max(1, Math.min(requested, terminalColumns - horizontalMargin));
}

/** The live keybinding manager the host passes to the custom/editor factories. */
function liveKeybindings() {
  const table: Record<string, string[]> = {
    "tui.input.submit": ["\r"],
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\x1b", "\x03"],
    "app.interrupt": ["\x1b"],
    "app.exit": ["\x04"],
    "app.clear": ["\x03"],
  };
  return { matches: (data: string, keybinding: string) => (table[keybinding] ?? []).includes(data) };
}

interface EntrypointFixture {
  dir: string;
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  tools: Map<string, any>;
  shortcuts: Map<string, { description?: string; handler: (ctx: unknown) => unknown }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  widgets: Array<{
    key: string;
    lines: string[] | undefined;
    options?: { placement?: string };
  }>;
  notices: string[];
  sent: Array<{ message: string; options?: unknown }>;
  markdownTransformers: Array<(markdown: string, context?: unknown) => string>;
  sessionManager: object;
}

/** The most recent setWidget call for a key (undefined when never called). */
function lastWidget(
  fixture: EntrypointFixture,
  key: string,
): EntrypointFixture["widgets"][number] | undefined {
  return [...fixture.widgets].reverse().find((entry) => entry.key === key);
}

async function makeFixture(options: {
  withShortcutApi?: boolean;
  withMarkdownTransformer?: boolean;
  onSend?: () => void;
} = {}): Promise<EntrypointFixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-questions-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ ...indexTestConfig, review: { activeReviewers: [] } }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;

  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: unknown) => unknown }>();
  const statuses: EntrypointFixture["statuses"] = [];
  const widgets: EntrypointFixture["widgets"] = [];
  const notices: string[] = [];
  const sent: EntrypointFixture["sent"] = [];
  const markdownTransformers: EntrypointFixture["markdownTransformers"] = [];
  const sessionManager = { id: "entrypoint-session" };
  const pi: Record<string, unknown> = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, deliveryOptions?: unknown) { sent.push({ message, options: deliveryOptions }); options.onSend?.(); return Promise.resolve(); },
    // Faithful to the installed host: the extension API object carries no ui
    // surface (only ctx.ui does), so setWidget is deliberately absent here —
    // any code path that targets the API object leaves nothing recorded.
    ui: {
      setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
    },
  };
  if (options.withShortcutApi !== false) {
    pi.registerShortcut = (shortcut: string, options: { description?: string; handler: (ctx: unknown) => unknown }) => {
      shortcuts.set(shortcut, options);
    };
  }
  if (options.withMarkdownTransformer) {
    pi.registerMarkdownTransformer = function (this: unknown, transformer: (markdown: string, context?: unknown) => string) {
      assert.equal(this, pi, "the optional native hook receives its ExtensionAPI receiver");
      markdownTransformers.push(transformer);
    };
  }
  await activate(pi);
  return { dir, hooks, tools, shortcuts, statuses, widgets, notices, sent, markdownTransformers, sessionManager };
}

async function trigger(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of hooks.get(name) ?? []) {
    await handler(...args);
  }
}

/** The interactive TUI host's session context — the only mode that accepts questions. */
function tuiContext(fixture: EntrypointFixture): Record<string, unknown> {
  return {
    cwd: fixture.dir,
    ui: {
      setWidget(key: string, lines: string[] | undefined, options?: { placement?: string }) {
        fixture.widgets.push({ key, lines, options });
      },
    },
    sessionManager: fixture.sessionManager,
    mode: "tui",
  };
}

test("activate registers AskUserQuestion and the pending-question shortcut", async () => {
  const fixture = await makeFixture();
  try {
    const tool = fixture.tools.get("AskUserQuestion");
    const noticeTool = fixture.tools.get("YouShouldKnow");
    assert.ok(tool, "AskUserQuestion is registered at the top level");
    assert.ok(noticeTool, "YouShouldKnow is registered beside the question tool");
    assert.equal(fixture.shortcuts.has("ctrl+alt+up"), true, "the approved chord is registered");
    const shortcut = fixture.shortcuts.get("ctrl+alt+up")!;
    assert.match(shortcut.description ?? "", /pending input list/i);

    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));

    // A registered question shows the persistent collapsed panel above the
    // editor — notification and platform chord only, never question text.
    const result = await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((result.details as { status: string }).status, "pending");
    const panel = lastWidget(fixture, USER_QUESTION_PANEL_KEY);
    assert.ok(panel, "the pending-question panel is set through the event context's widget surface");
    assert.equal(panel!.options?.placement, "aboveEditor", "the panel is pinned above the chat editor");
    assert.deepEqual(panel!.lines, [pendingQuestionPanelLine()]);
    assert.equal(
      panel!.lines![0],
      `Pending input · Press ${questionShortcutLabel()}`,
      "the collapsed line names the approved chord",
    );
    assert.ok(!panel!.lines!.join("\n").includes("database"), "no question text while collapsed");
    const noticeResult = await noticeTool.execute("n1", {
      title: "Build status",
      body: "## Full status\n\nThe complete notice stays in the shared list.",
    }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((noticeResult.details as { status: string }).status, "pending");
    assert.equal((noticeResult.details as { kind: string }).kind, "notice");
    assert.deepEqual(lastWidget(fixture, USER_QUESTION_PANEL_KEY)?.lines, [pendingQuestionPanelLine()], "notices reuse the existing pending widget");
    // The old status-line indicator is replaced, not duplicated.
    assert.ok(
      !fixture.statuses.some((entry) => /pending question/i.test(entry.text ?? "")),
      "no status-line pending indicator remains",
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("activation connects the optional native Markdown hook to the shared display-only adapter", async () => {
  const fixture = await makeFixture({ withMarkdownTransformer: true });
  try {
    assert.equal(fixture.markdownTransformers.length, 1, "activation registers one native display transformer");
    const source = "# Native transcript\r\n\u001b[31munsafe\u001b[0m \u009b31m";
    const transformed = fixture.markdownTransformers[0]!(source, {
      messageType: "user",
      isStreaming: false,
      availableWidth: 80,
    });
    assert.equal(transformed, safeMarkdownDisplaySource(source));
    assert.equal(transformed, "# Native transcript\n\\u001b[31munsafe\\u001b[0m \\u009b31m");
    assert.equal(source, "# Native transcript\r\n\u001b[31munsafe\u001b[0m \u009b31m", "native rendering does not rewrite the model source");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the collapsed panel stays a single notification line for many questions", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database should the migration target?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    await tool.execute("c2", { question: "Should the report include raw counts?" }, undefined, undefined, { sessionManager: fixture.sessionManager });

    const panel = lastWidget(fixture, USER_QUESTION_PANEL_KEY);
    assert.ok(panel, "the panel is set while questions are pending");
    assert.equal(panel!.options?.placement, "aboveEditor", "reconciles stay above the editor");
    assert.deepEqual(panel!.lines, [pendingQuestionPanelLine()], "one line regardless of the pending count");
    const collapsed = panel!.lines!.join("\n");
    assert.ok(!collapsed.includes("database"), "never shows question text (1)");
    assert.ok(!collapsed.includes("counts"), "never shows question text (2)");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("resolving every pending question removes the panel", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database?", choices: ["SQLite", "Postgres"] }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.ok(lastWidget(fixture, USER_QUESTION_PANEL_KEY)?.lines, "panel visible while pending");

    let openedComponent: any;
    let customOptions: {
      overlay?: boolean;
      overlayOptions?: PublicOverlayOptions;
    } | undefined;
    const popupTui = { terminal: { rows: 40 }, requestRender() {} };
    const backgroundTokens: string[] = [];
    const custom = (factory: (...args: unknown[]) => unknown, options?: typeof customOptions) => {
      customOptions = options;
      openedComponent = factory(popupTui, {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
        bg: (color: string, text: string) => {
          backgroundTokens.push(color);
          return `\x1b[48;5;236m${text}\x1b[49m`;
        },
      }, fakeKeybindings(), () => undefined);
      return Promise.resolve();
    };
    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler;
    await handler({ ui: { custom }, sessionManager: fixture.sessionManager, isIdle: () => true });
    assert.ok(openedComponent, "the shortcut opens the question list over the persistent panel");
    assert.equal(customOptions?.overlay, true, "the question list uses the public custom overlay");
    // #413: the overlay has zero margins so its public mouse hit rectangle can
    // cover the whole viewport in fullscreen; the component keeps the frame's
    // one-row vertical inset itself (regular mode: a shorter centered frame).
    assert.deepEqual(customOptions?.overlayOptions, {
      width: "100%", anchor: "center", margin: { top: 0, right: 0, bottom: 0, left: 0 }, maxHeight: "100%",
    }, "the public overlay fills the conversation viewport with no margins");
    assert.equal(publicOverlayHeight(customOptions!.overlayOptions!, 40), 40);
    assert.equal(publicOverlayWidth(customOptions!.overlayOptions!, 80), 80,
      "the full-width public overlay leaves no exposed conversation columns at either side");
    const firstRows = openedComponent.render(80);
    assert.ok(backgroundTokens.length > 0 && backgroundTokens.every((color) => color === "customMessageBg"),
      "the public custom-component Theme.bg reaches the shared popup as its opaque native message surface");
    assert.ok(firstRows.every((line: string) => line.startsWith("\x1b[48;5;236m")),
      "the public native surface background wraps all list rows, including rules and padding");

    openedComponent.handleInput("\r"); // open answer view (first question selected)
    openedComponent.handleInput("\x1b[B"); // row 2: Postgres
    openedComponent.handleInput("\r"); // confirm the choice
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(fixture.sent.length, 1, "the answer is delivered through the host path");
    const panel = lastWidget(fixture, USER_QUESTION_PANEL_KEY);
    assert.ok(panel, "a widget update follows the resolution");
    assert.equal(panel!.lines, undefined, "the panel is removed when no questions remain");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the shared custom overlay pages native Markdown within its responsive public geometry", async () => {
  let customActive = false;
  const fixture = await makeFixture({ onSend: () => assert.equal(customActive, false, "owner delivery follows custom close") });
  try {
    let terminalRows = 40;
    let terminalColumns = 80;
    const markdownSources: string[] = [];
    const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, "");
    const terminalVisibleWidth = (text: string): number => stripSgr(text).length;
    const popupInteriorRows = (frame: readonly string[], width: number): string[] => {
      const rows = frame.map(stripSgr);
      assert.equal(rows[0], "─".repeat(width), "projection uses the popup's actual full-width top rule");
      assert.equal(rows.at(-1), "─".repeat(width), "projection uses the popup's actual full-width bottom rule");
      return rows.slice(1, -1).map((row) => {
        assert.equal(terminalVisibleWidth(row), width, "every projected row keeps its measured width");
        assert.equal(row[0], " ", `one padding cell occupies the left column, with no side border: ${row}`);
        assert.equal(row[row.length - 1], " ", `one padding cell occupies the right column, with no side border: ${row}`);
        return row.slice(1, -1).replace(/ +$/u, ""); // Trim only right-side cell fill after slicing the known padding.
      }).filter((row) => row.length > 0);
    };
    setUserQuestionTuiHost({
      visibleWidth: terminalVisibleWidth,
      wrapTextWithAnsi: (text) => [text],
      createMarkdown(source) {
        markdownSources.push(source);
        return { render: () => source.split("\n").map((line) => `native:${line}`), invalidate() {} };
      },
    });
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const questionText = "# Keep the pending question\n\nWhich lane?\n\n- Canary preserves scope.\n\n```text\nowner=A\n```";
    await fixture.tools.get("AskUserQuestion")!.execute("q-background", {
      question: questionText,
    }, undefined, undefined, { sessionManager: fixture.sessionManager });
    const body = `## Full deployment status\n\n${Array.from({ length: 18 }, (_, index) => `Body paragraph ${index + 1} contains the complete detail.`).join("\n\n")}\n\nBODY-END`;
    const context = `Context beginning\n${Array.from({ length: 12 }, (_, index) => `Context detail ${index + 1}.`).join("\n")}\nCONTEXT-END`;
    const noticeTool = fixture.tools.get("YouShouldKnow")!;
    const notice = await noticeTool.execute("n1", {
      title: "Deployment status",
      body,
      context,
    }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((notice.details as { status: string }).status, "pending");
    const closeOnlyNotice = await noticeTool.execute("n2", {
      title: "Follow-up status",
      body: "Close this notice without sending a request.",
    }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((closeOnlyNotice.details as { status: string }).status, "pending");

    const components: any[] = [];
    type PopupCustomOptions = { overlay?: boolean; overlayOptions?: PublicOverlayOptions };
    const options: Array<PopupCustomOptions | undefined> = [];
    const tui = {
      requestRender() {},
      terminal: { get rows() { return terminalRows; }, get columns() { return terminalColumns; } },
    };
    const custom = (factory: (...args: unknown[]) => unknown, customOptions?: PopupCustomOptions) => {
      options.push(customOptions);
      customActive = true;
      return new Promise((resolve) => {
        components.push(factory(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, fakeKeybindings(), (result: unknown) => {
          customActive = false;
          resolve(result);
        }));
      });
    };
    const uiContext = { ui: { custom }, sessionManager: fixture.sessionManager, isIdle: () => true };
    const opening = fixture.shortcuts.get("ctrl+alt+up")!.handler(uiContext) as Promise<unknown>;
    await until(() => components.length === 1);
    const sharedList = components[0];
    assert.ok(sharedList, "the existing shortcut opens the shared list in its custom overlay");
    assert.equal(options[0]?.overlay, true, "the shared question/notice factory opens as an overlay");
    assert.deepEqual(options[0]?.overlayOptions, {
      width: "100%", anchor: "center", margin: { top: 0, right: 0, bottom: 0, left: 0 }, maxHeight: "100%",
    });
    // Regular mode keeps the frame one row inside the top and bottom edges.
    const framedRows = (rows: number): number => publicOverlayHeight(options[0]!.overlayOptions!, rows) - 2;
    assert.ok(sharedList.render(terminalColumns).length <= framedRows(terminalRows),
      "the component render fits the inset frame inside the maxHeight the public overlay compositor receives");
    assert.equal(publicOverlayWidth(options[0]!.overlayOptions!, terminalColumns), terminalColumns);
    assert.ok(sharedList.render(terminalColumns).every((line: string) => terminalVisibleWidth(line) === terminalColumns),
      "every list row fills the conversation viewport sent to the public overlay");

    assert.ok(lastWidget(fixture, USER_QUESTION_PANEL_KEY)?.lines, "the persistent pending widget remains visible behind the overlay");
    sharedList.handleInput("\r"); // open the rich question detail in the shared component
    const questionFrame = sharedList.render(80).join("\n");
    assert.ok(markdownSources.includes(questionText));
    assert.match(questionFrame, /native:# Keep the pending question/);
    assert.match(questionFrame, /native:- Canary preserves scope\./);
    assert.match(questionFrame, /native:owner=A/);
    sharedList.handleInput("\x1b"); // return to the list
    sharedList.handleInput("\x1b[B"); // select the notice after the pending question
    sharedList.handleInput("\r"); // switch modes in the same component
    assert.equal(components.length, 1, "notice detail stays in the one shared custom overlay");
    assert.equal(options.length, 1);
    assert.equal(options[0]?.overlay, true, "question and notice details share the same overlay interaction");

    const noticeView = sharedList;
    const initialNoticeRows = noticeView.render(terminalColumns);
    assert.ok(markdownSources.includes(body), "the complete notice still uses native Markdown");
    assert.ok(markdownSources.includes(context), "the complete context still uses native Markdown");
    assert.equal(initialNoticeRows.length, framedRows(terminalRows),
      "the long notice viewport fills, but never exceeds, the inset frame inside the overlay's initial maxHeight");
    terminalRows = 7;
    terminalColumns = 55;
    assert.equal(framedRows(terminalRows), 5,
      "the percentage maxHeight resolves against the resized terminal, keeping the one-row inset");
    assert.equal(publicOverlayWidth(options[0]!.overlayOptions!, terminalColumns), terminalColumns,
      "the percentage width resolves again after horizontal resize");
    const resizedRows = noticeView.render(terminalColumns);
    assert.ok(resizedRows.every((line: string) => terminalVisibleWidth(line) === terminalColumns),
      "all notice rows fill the resized conversation viewport width");
    const resizedFrame = resizedRows.join("\n");
    assert.equal(resizedFrame.split("\n").length, framedRows(terminalRows),
      "resize keeps the manual viewport within the same inset public overlay maxHeight");
    const scrollFrames: string[][] = [resizedRows];
    for (let index = 0; index < 100; index += 1) {
      noticeView.handleInput("\x1b[6~"); // PageDown advances one body row in the shared custom component.
      scrollFrames.push(noticeView.render(terminalColumns));
    }
    // The keyboard hint is laid out in a fixed area below the scrolled body
    // (#413); drop it from each frame so successive body rows join directly.
    const noticeHint = "arrows select · Enter choose · Shift+Alt+Up/Down or Ctrl+Alt+PageUp/PageDown scroll · Esc back";
    const scrolledBodyRows = (frame: readonly string[]): string[] => {
      const rows = popupInteriorRows(frame, terminalColumns);
      let end = rows.length;
      while (end > 0 && noticeHint.includes(rows[end - 1]!.trim())) end -= 1;
      assert.ok(end < rows.length, "every short-viewport frame keeps the fixed keyboard hint visible");
      return rows.slice(0, end);
    };
    const projectedText = scrollFrames
      .flatMap(scrolledBodyRows)
      .map((row) => row.startsWith("native:") ? row.slice("native:".length) : row)
      .join(" "); // Join visual wrap continuations after removing only the fixture's native-render marker.
    const completeView = projectedText;
    const expectedLines = [...body.split("\n"), ...context.split("\n")].filter((line) => line.length > 0);
    let contentOffset = 0;
    for (const line of expectedLines) {
      const found = projectedText.indexOf(line, contentOffset);
      assert.notEqual(found, -1, `ordered popup rows include the complete native Markdown line: ${line}`);
      contentOffset = found + line.length;
    }
    for (let index = 1; index <= 12; index += 1) {
      assert.ok(completeView.includes(`Context detail ${index}\.`), `shared popup scrolling reaches context detail ${index}`);
    }
    assert.match(completeView, /CONTEXT-END/);
    assert.match(completeView, /More details/);
    assert.match(completeView, /Close/);

    terminalRows = 40; // restore enough rows to inspect both pending entries after the short-viewport scroll proof
    terminalColumns = 80;
    noticeView.render(terminalColumns);
    noticeView.handleInput("\x1b"); // return to the list without consuming the first notice
    noticeView.handleInput("\x1b[B"); // select the separate notice
    noticeView.handleInput("\r"); // open its details
    assert.match(noticeView.render(terminalColumns).join("\n"), /Follow-up status/);
    noticeView.handleInput("\x1b[B"); // select Close
    noticeView.handleInput("\r");
    const afterClose = noticeView.render(80).join("\n");
    assert.match(afterClose, /Pending input \(2\)/);
    assert.match(afterClose, /q1: # Keep the pending question/);
    assert.match(afterClose, /n1: Deployment status \[notice\]/);
    assert.doesNotMatch(afterClose, /n2: Follow-up status/, "Close removes only the selected notice");

    noticeView.handleInput("\x1b[B"); // the removed selection falls back to q1; select the first notice
    noticeView.handleInput("\r"); // reopen its details
    assert.match(noticeView.render(80).join("\n"), /Deployment status/);
    noticeView.handleInput("\r"); // More details consumes and closes the shared component
    await opening;
    assert.equal(customActive, false, "the normal chat/editor view is restored before delivery");
    assert.deepEqual(noticeView.render(80), [], "closed UI cannot remain as a notice viewer");
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.sent[0]!.message,
      `More details requested for "Deployment status":\n\n${body}\n\nRelevant context:\n${context}\n\nPlease elaborate on these details in your normal conversation reply.`);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a new session clears a stale panel even when its identity is unusable", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.ok(lastWidget(fixture, USER_QUESTION_PANEL_KEY)?.lines, "panel visible for the first session");

    // A session_start without a usable session identity cannot bind the
    // controller; the stale panel must be cleared rather than carried over.
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, { cwd: fixture.dir, ui: {}, mode: "tui" });
    const panel = lastWidget(fixture, USER_QUESTION_PANEL_KEY);
    assert.equal(panel?.lines, undefined, "no other session's questions are presented in the new one");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the shortcut handler opens only for questions of its own session", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });

    // A stale context (another session's identity) must not open the list.
    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler;
    await handler({ ui: {}, sessionManager: { id: "other" } });
    assert.equal(fixture.sent.length, 0);
    assert.ok(!fixture.notices.some((notice) => /no pending input/.test(notice)), "stale contexts are ignored silently");

    // The current session with no pending input gets a notice instead of an empty list.
    await trigger(fixture.hooks, "session_shutdown", { cwd: fixture.dir }, tuiContext(fixture));
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    await handler({ ui: {}, sessionManager: fixture.sessionManager, isIdle: () => true });
    assert.ok(fixture.notices.some((notice) => /no pending input/.test(notice)));
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("an occupied chord is not registered and the tool fails closed", async () => {
  setHostKeybindingLoader(() => ({
    "app.message.dequeue": ["alt+up"],
    "some.builtin": ["ctrl+alt+up"],
  }));
  const fixture = await makeFixture();
  try {
    assert.equal(fixture.shortcuts.has("ctrl+alt+up"), false, "the colliding chord is never registered");
    assert.ok(fixture.notices.some((notice) => /pending-question shortcut/.test(notice) && /some\.builtin/.test(notice)));
    const tool = fixture.tools.get("AskUserQuestion");
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await tool.execute("c1", { question: "Which database?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((result.details as { status: string; reason: string }).status, "rejected");
    assert.equal((result.details as { reason: string }).reason, "unavailable");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("hosts without the shortcut API keep the tool but fail closed per question", async () => {
  const fixture = await makeFixture({ withShortcutApi: false });
  try {
    assert.ok(fixture.tools.has("AskUserQuestion"));
    assert.ok(fixture.tools.has("YouShouldKnow"));
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await fixture.tools.get("AskUserQuestion").execute(
      "c1",
      { question: "Which database?" },
      undefined,
      undefined,
      { sessionManager: fixture.sessionManager },
    );
    assert.equal((result.details as { status: string; reason: string }).status, "rejected");
    assert.equal((result.details as { reason: string }).reason, "unavailable");
    const noticeResult = await fixture.tools.get("YouShouldKnow").execute(
      "n1",
      { title: "Info", body: "Full notice body." },
      undefined,
      undefined,
      { sessionManager: fixture.sessionManager },
    );
    assert.equal((noticeResult.details as { reason: string }).reason, "unavailable");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("non-TUI host modes fail closed for every question, sync included", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const fixture = await makeFixture();
    try {
      assert.ok(fixture.tools.has("AskUserQuestion"), `${mode}: the tool still registers`);
      // The host exposes a session identity and UI surface, but not key input:
      // only mode "tui" may accept questions.
      const context = { cwd: fixture.dir, ui: {}, sessionManager: fixture.sessionManager, mode };
      await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, context);
      const tool = fixture.tools.get("AskUserQuestion");

      const asyncResult = await tool.execute(
        "c1",
        { question: "Which database?" },
        undefined,
        undefined,
        { sessionManager: fixture.sessionManager, mode },
      );
      assert.equal((asyncResult.details as { status: string }).status, "rejected", `${mode}: async`);
      assert.equal((asyncResult.details as { reason: string }).reason, "unavailable", `${mode}: async`);

      // A sync call must be rejected up front — never create a wait that no
      // one can ever answer or decline.
      const syncResult = await tool.execute(
        "c2",
        { question: "Which database?", mode: "sync" },
        undefined,
        undefined,
        { sessionManager: fixture.sessionManager, mode },
      );
      assert.equal((syncResult.details as { status: string }).status, "rejected", `${mode}: sync`);
      assert.equal((syncResult.details as { reason: string }).reason, "unavailable", `${mode}: sync`);
      const noticeResult = await fixture.tools.get("YouShouldKnow").execute(
        "n3",
        { title: "Info", body: "Full notice body." },
        undefined,
        undefined,
        { sessionManager: fixture.sessionManager, mode },
      );
      assert.equal((noticeResult.details as { reason: string }).reason, "unavailable", `${mode}: notice`);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("session shutdown settles a pending sync question and clears the panel", async () => {
  const fixture = await makeFixture();
  try {
    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    const running = tool.execute("c1", { question: "Which database?", mode: "sync" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.ok(lastWidget(fixture, USER_QUESTION_PANEL_KEY)?.lines, "panel visible while the sync wait is open");
    await trigger(fixture.hooks, "session_shutdown", { cwd: fixture.dir }, tuiContext(fixture));
    const result = await running;
    assert.equal((result.details as { status: string }).status, "interrupted");
    const panel = lastWidget(fixture, USER_QUESTION_PANEL_KEY);
    assert.ok(panel, "the panel is reconciled on shutdown");
    assert.equal(panel!.lines, undefined, "the panel is cleared for the settled session");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

function fakeKeybindings() {
  const bindings: Record<string, string[]> = {
    "tui.select.up": ["\x1b[A"],
    "tui.select.down": ["\x1b[B"],
    "tui.select.confirm": ["\r"],
    "tui.select.cancel": ["\x1b"],
    "tui.editor.pageUp": ["\x1b[5~"],
    "tui.editor.pageDown": ["\x1b[6~"],
  };
  return { matches(data: string, keybinding: string): boolean { return (bindings[keybinding] ?? []).includes(data); } };
}

/**
 * End-to-end through the production wiring: shortcut handler → ui.custom
 * factory → question list component → controller → host sendUserMessage.
 */
test("an answer submitted from the opened list is delivered through the host user-message path", async () => {
  const fixture = await makeFixture();
  try {
    // The production free-text path: the host-wired native editor acquired
    // through the shared bridge before the custom slot opens.
    const instances: FakeBridgeEditor[] = [];
    setNativeEditorHost(fakeHost(instances));
    setUserQuestionTuiHost({ matchesKey: () => false });

    await trigger(fixture.hooks, "session_start", { cwd: fixture.dir }, tuiContext(fixture));
    const tool = fixture.tools.get("AskUserQuestion");
    const firstQuestion = await tool.execute("c1", { question: "Which database?", choices: ["SQLite", "Postgres"] }, undefined, undefined, { sessionManager: fixture.sessionManager });
    assert.equal((firstQuestion.details as { status: string }).status, "pending");

    const handler = fixture.shortcuts.get("ctrl+alt+up")!.handler;
    // Busy at submission time → steering delivery. The fake's driver hook
    // captures the component once the slot's factory has run.
    let openedComponent: any;
    const firstUi = createBridgeUi({
      keybindings: liveKeybindings(),
      draft: "chat draft",
      drivers: [(component) => {
        openedComponent = component;
      }],
    });
    const openedFirst = handler({ ui: firstUi.ui, sessionManager: fixture.sessionManager, isIdle: () => false }) as Promise<void>;
    await until(() => instances.length >= 1);
    assert.equal(instances.length, 1, "only the host-owned native field is created for the overlay");
    assert.equal(instances[0]!.getText(), "", "prepare(\"\") emptied the field after the host's draft capture");
    assert.deepEqual(instances[0]!.render(80), [], "the ordinary prompt is suppressed while the overlay owns the field");
    await until(() => openedComponent !== undefined);
    const rendered = openedComponent.render(80).join("\n");
    assert.match(rendered, /Pending input \(1\)/);

    openedComponent.handleInput!("\r"); // open answer view (first question selected)
    openedComponent.handleInput!("\x1b[B"); // row 2: Postgres
    openedComponent.handleInput!("\r"); // confirm the choice
    await openedFirst;
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0]!.message, /Answer to pending question "Which database\?": Postgres/);
    assert.deepEqual(fixture.sent[0]!.options, { deliverAs: "steer" }, "busy delivery uses steering");
    assert.equal(firstUi.state.draft, "chat draft", "the chat draft survived the round trip exactly once");
    assert.equal(instances[0]!.getText(), "chat draft", "the original editor regains the chat draft after busy delivery");
    assert.deepEqual(instances[0]!.render(80), ["─".repeat(80), "[field:chat draft]"],
      "ordinary rendering returns after the busy overlay closes");

    // A second question answered while idle uses the plain path — free text
    // through the embedded native field.
    await tool.execute("c2", { question: "Include raw counts?" }, undefined, undefined, { sessionManager: fixture.sessionManager });
    let openedSecond: any;
    const secondUi = createBridgeUi({
      keybindings: liveKeybindings(),
      draft: "",
      drivers: [(component) => {
        openedSecond = component;
      }],
    });
    const openedSecondPromise = handler({ ui: secondUi.ui, sessionManager: fixture.sessionManager, isIdle: () => true }) as Promise<void>;
    await until(() => instances.length >= 2);
    await until(() => openedSecond !== undefined);
    assert.equal(instances.length, 2, "the second overlay also creates only one host-owned editor");
    assert.equal(instances[1]!.getText(), "", "the second field instance starts empty too");
    openedSecond.handleInput!("\r"); // open answer view (no choices → Type row selected)
    openedSecond.handleInput!("\r"); // start editing the native field
    for (const ch of "yes") openedSecond.handleInput!(ch); // one keypress per call
    assert.equal(instances[1]!.getText(), "yes", "the active host editor owns the free-text answer");
    assert.deepEqual(instances[1]!.render(80), [], "the ordinary prompt render stays suppressed during free-text input");
    assert.equal(secondUi.state.draft, "", "free-text answer typing leaves the underlying chat draft empty");
    openedSecond.handleInput!("\r"); // submit the whole answer
    await openedSecondPromise;
    assert.equal(fixture.sent.length, 2);
    assert.match(fixture.sent[1]!.message, /Answer to pending question "Include raw counts\?": yes/);
    assert.equal(fixture.sent[1]!.options, undefined, "idle delivery uses the plain path");
    assert.deepEqual(secondUi.state.chatSubmits, [], "no chat message was sent from the field");
    assert.equal(instances[1]!.getText(), "", "the original editor restores its empty chat draft after idle delivery");
    assert.deepEqual(instances[1]!.render(80), ["─".repeat(80), "[field:]"],
      "ordinary editor rendering returns after the idle overlay closes");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the shortcut label is platform-specific", () => {
  const label = questionShortcutLabel();
  assert.ok(["Ctrl+Alt+Up", "Ctrl+Option+Up"].includes(label));
});
