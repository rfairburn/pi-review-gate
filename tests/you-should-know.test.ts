import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { setHostKeybindingLoader } from "../src/host-keybindings";
import { safeMarkdownDisplaySource } from "../src/markdown-safety";
import { visibleTerminalText } from "../src/tool-result-text";
import { UserQuestionController } from "../src/user-question/controller";
import { createQuestionListComponent, QUESTION_LIST_SHORTCUT_KEY } from "../src/user-question/components";
import {
  registerUserQuestions,
  USER_QUESTION_PANEL_KEY,
  pendingQuestionPanelLine,
  type UserQuestionRegistrationOptions,
  type UserQuestionSurface,
} from "../src/user-question";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CHORD = "\x1b[1;64A";

const bindings: Record<string, string[]> = {
  "tui.select.up": [UP],
  "tui.select.down": [DOWN],
  "tui.select.confirm": [ENTER],
  "tui.select.cancel": [ESCAPE],
  "tui.editor.pageUp": [PAGE_UP],
  "tui.editor.pageDown": [PAGE_DOWN],
};

const keybindings = {
  matches(data: string, keybinding: string): boolean {
    return (bindings[keybinding] ?? []).includes(data);
  },
};

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

interface ToolDefinition {
  name: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { sessionManager?: unknown },
  ): Promise<Record<string, unknown>>;
}

interface Fixture {
  surface: UserQuestionSurface;
  tools: Map<string, ToolDefinition>;
  sent: Array<{ message: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  widgets: Array<{ key: string; lines: string[] | undefined }>;
  identity: object;
}

function makeFixture(
  send?: (message: string, options?: { deliverAs?: "steer" | "followUp" }) => Promise<void> | void,
  registrationOptions: UserQuestionRegistrationOptions = {},
): Fixture {
  const tools = new Map<string, ToolDefinition>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
  const sent: Fixture["sent"] = [];
  const widgets: Fixture["widgets"] = [];
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerShortcut(name: string, options: { handler: (ctx: unknown) => unknown }) { shortcuts.set(name, options); },
    on() { return () => {}; },
    notify() {},
    sendUserMessage(message: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sent.push({ message, options });
      return send?.(message, options);
    },
  };
  const surface = registerUserQuestions(pi, registrationOptions);
  assert.ok(surface);
  surface.setInteractiveUi(true);
  const identity = { id: "you-should-know-session" };
  surface.controller.beginSession(identity);
  surface.noteContext({ ui: { setWidget(key: string, lines: string[] | undefined) { widgets.push({ key, lines }); } } });
  return { surface, tools, sent, widgets, identity };
}

function markdownHost(created: string[], widths: number[] = []) {
  return {
    matchesKey: (data: string, keyId: string) => data === CHORD && keyId === QUESTION_LIST_SHORTCUT_KEY,
    visibleWidth: terminalColumns,
    wrapTextWithAnsi: (text: string, width: number) => {
      if (text.length <= width) return [text];
      const result: string[] = [];
      for (let offset = 0; offset < text.length; offset += width) result.push(text.slice(offset, offset + width));
      return result;
    },
    createMarkdown(source: string) {
      created.push(source);
      return {
        render(width: number) {
          widths.push(width);
          return source.split("\n").map((line) => `native:${line}`);
        },
        invalidate() {},
      };
    },
    createScrollView(content: { render(width: number): string[]; invalidate(): void }) {
      return fakeScrollView(content);
    },
  };
}

function terminalColumns(text: string): number {
  let columns = 0;
  for (const character of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    if (/\p{Mark}/u.test(character)) continue;
    columns += /\p{Emoji_Presentation}/u.test(character) ? 2 : 1;
  }
  return columns;
}

function fakeScrollView(content: { render(width: number): string[]; invalidate(): void }) {
  // This fake custom host does not run ScrollView layout. Its zero viewport
  // exercises the shared component's live terminal-row fallback and paging.
  return {
    viewportHeight: 0,
    render(width: number) { return content.render(width); },
    invalidate() { content.invalidate(); },
    scrollBy(amount: number) { return amount; },
    scrollToStart() {},
  };
}

afterEach(() => {
  setHostKeybindingLoader(undefined);
});

test("registered YouShouldKnow shares admission, controller state, and the existing pending widget", async () => {
  setHostKeybindingLoader(() => ({}));
  const fixture = makeFixture();
  fixture.surface.syncPanel();
  assert.deepEqual([...fixture.tools.keys()], ["AskUserQuestion", "YouShouldKnow"]);

  const noticeTool = fixture.tools.get("YouShouldKnow")!;
  const schema = noticeTool.parameters as {
    required: string[];
    properties: Record<string, { type: string }>;
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.required, ["title", "body"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties, {
    title: { type: "string", minLength: 1, description: "A compact identifier for the notice, shown in the pending list and popup title." },
    body: { type: "string", minLength: 1, description: "The complete substantive notice content as Markdown. It is retained and rendered in full, without truncation." },
    context: { type: "string", description: "Optional complete relevant context, retained and delivered with the body if the user chooses More details." },
  });

  fixture.surface.setInteractiveUi(false);
  const unavailable = await noticeTool.execute("n-call-unavailable", { title: "T", body: "B" }, undefined, undefined, {
    sessionManager: fixture.identity,
  });
  assert.deepEqual(unavailable.details, { status: "rejected", reason: "unavailable" });
  fixture.surface.setInteractiveUi(true);

  const wrongSession = await noticeTool.execute("n-call-stale", { title: "T", body: "B" }, undefined, undefined, {
    sessionManager: { id: "other" },
  });
  assert.deepEqual(wrongSession.details, { status: "rejected", reason: "identity-mismatch" });
  assert.equal(fixture.surface.controller.listPending().length, 0);

  const result = await noticeTool.execute("n-call-1", {
    title: "Build note",
    body: "## Complete notice\n\nFull Markdown **content**.",
    context: "The full retained context.",
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.deepEqual(result.details, { status: "pending", id: "n1", kind: "notice" });
  assert.deepEqual(fixture.widgets.at(-1), {
    key: USER_QUESTION_PANEL_KEY,
    lines: [pendingQuestionPanelLine()],
  });
  assert.equal(fixture.widgets.at(-1)?.key, "review-gate-pending-questions", "no new status channel or widget key is introduced");
});

test("feature-off rejects only new notices and preserves existing More details, Close, and questions", async () => {
  let featureEnabled = true;
  const fixture = makeFixture(undefined, {
    isNoticeFeatureEnabled: () => featureEnabled,
  });
  const noticeTool = fixture.tools.get("YouShouldKnow")!;
  const notice = await noticeTool.execute("n-call-gated", {
    title: "Retained notice",
    body: "The notice stays pending when new notice admission is disabled.",
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.equal((notice.details as { status: string }).status, "pending");
  const noticeId = (notice.details as { id: string }).id;

  featureEnabled = false;
  const disabledNotice = await noticeTool.execute("n-call-disabled", {
    title: "Not admitted",
    body: "New notices are rejected while the feature is disabled.",
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.deepEqual(disabledNotice.details, { status: "rejected", reason: "feature-disabled" });
  assert.equal(fixture.surface.controller.listPending().length, 1, "the rejected registration does not disturb the existing notice");

  assert.equal(await fixture.surface.controller.requestNoticeDetails(noticeId), true, "feature-off does not block More details for an existing notice");
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.surface.controller.listPending().length, 1, "More details leaves the notice pending");

  const question = await fixture.tools.get("AskUserQuestion")!.execute("q-call-independent", {
    question: "Is AskUserQuestion still available?",
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.equal((question.details as { status: string }).status, "pending", "the notice feature gate does not disable questions");
  assert.equal(fixture.surface.controller.listPending().length, 2);
  assert.equal(fixture.surface.controller.closeNotice(noticeId), true, "feature-off still allows explicitly closing an existing notice");
  assert.equal(fixture.surface.controller.listPending()[0]!.id, "q1", "closing the notice does not touch the question");
});

test("the shared popup renders rich questions and notices; More details closes it before delivery and retains the notice", async () => {
  setHostKeybindingLoader(() => ({}));
  const created: string[] = [];
  const widths: number[] = [];
  const fixture = makeFixture();
  const questionText = "# Retention choices\n\nUse **these** settings?\n\n- Keep the owning session.\n\n```text\nkind=question\n```";
  const question = await fixture.tools.get("AskUserQuestion")!.execute("q-call-1", {
    question: questionText,
    choices: ["yes"],
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.deepEqual(question.details, { status: "pending", id: "q1", mode: "async" });

  const body = `## Full notice\n\n${Array.from({ length: 18 }, (_, index) => `Body paragraph ${index + 1} contains the complete detail.`).join("\n\n")}\n\nBODY-END`;
  const context = `Context beginning\n${Array.from({ length: 12 }, (_, index) => `Context detail ${index + 1}.`).join("\n")}\nCONTEXT-END`;
  const noticeResult = await fixture.tools.get("YouShouldKnow")!.execute("n-call-1", {
    title: "Deployment status",
    body,
    context,
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.deepEqual(noticeResult.details, { status: "pending", id: "n1", kind: "notice" });

  let terminalRows = 12;
  const viewportRows = () => Math.max(1, terminalRows - 2);
  const outcomes: unknown[] = [];
  const component = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme,
    tuiHost: markdownHost(created, widths),
    shortcutLabel: "Ctrl+Alt+Up",
    getViewportRows: viewportRows,
    onDone(result) { outcomes.push(result); },
  });
  const list = component.render(48).join("\n");
  assert.match(list, /Pending questions and notices \(2\)/);
  assert.match(list, /q1: # Retention choices/);
  assert.match(list, /n1: Deployment status \[notice\]/);

  component.handleInput(ENTER); // open the question detail first
  component.handleInput(PAGE_UP); // read the opening Markdown before navigating answer rows
  const questionFrame = component.render(48).join("\n");
  assert.ok(created.includes(questionText), "the complete unprefixed question body uses the same Markdown renderer");
  assert.match(questionFrame, /native:# Retention choices/, "a leading question heading stays structural Markdown");
  assert.match(questionFrame, /native:- Keep the owning session\./);
  assert.match(questionFrame, /native:kind=question/);
  component.handleInput(ESCAPE); // return without answering
  component.handleInput(DOWN); // select the notice
  component.handleInput(ENTER);

  const firstNoticeFrame = component.render(48).join("\n");
  assert.ok(firstNoticeFrame.split("\n").length <= viewportRows(), "notice details respect their current bounded viewport");
  assert.match(firstNoticeFrame, /native:## Full notice/);
  assert.doesNotMatch(firstNoticeFrame, /Native Markdown unavailable/);
  assert.ok(created.includes(body), "the exact full Markdown body is sent to native Markdown");
  assert.ok(created.includes(context), "the complete context is also rendered, not summarized");
  assert.ok(widths.includes(48), "the Markdown component receives the current render width");

  // The shared custom surface pages the complete body/context through its
  // common viewport, including after a live resize.
  terminalRows = 7;
  const resizedFrame = component.render(48).join("\n");
  assert.ok(resizedFrame.split("\n").length <= viewportRows(), "resize clamps to the new shared popup allocation");
  const frames: string[] = [firstNoticeFrame, resizedFrame];
  for (let index = 0; index < 100; index += 1) {
    component.handleInput(PAGE_DOWN);
    const frame = component.render(48).join("\n");
    frames.push(frame);
    if (frame === frames[frames.length - 2]) break;
  }
  const completeView = frames.join("\n");
  const normalizedView = completeView.replace(/\s+/gu, " ");
  for (let index = 1; index <= 18; index += 1) {
    assert.ok(completeView.includes(`Body paragraph ${index} contains the complete detail.`), `shared popup scrolling reaches body paragraph ${index}`);
  }
  assert.match(completeView, /BODY-END/);
  for (let index = 1; index <= 12; index += 1) {
    assert.ok(completeView.includes(`Context detail ${index}.`), `shared popup scrolling reaches context detail ${index}`);
  }
  assert.match(completeView, /CONTEXT-END/);
  assert.match(completeView, /More details/);
  assert.match(completeView, /Close/);
  assert.ok(
    normalizedView.replace(/\s+/gu, "").includes("Shift+Alt+Up/DownorCtrl+Alt+PageUp/PageDownscroll"),
    "the approved page and laptop scroll shortcuts appear in the reachable footer",
  );

  component.setSourceProbe({ isIdle: () => false });
  component.handleInput(ENTER); // More details closes this custom surface first.
  assert.deepEqual(outcomes, [{ kind: "notice-details", noticeId: "n1" }]);
  assert.deepEqual(component.render(48), [], "the normal chat/editor view is restored before owner delivery");
  assert.equal(fixture.sent.length, 0, "the component only reports the deliberate request; delivery follows custom close");
  assert.equal(fixture.surface.controller.listPending().length, 2, "More details leaves both items pending");
  assert.equal(await fixture.surface.controller.requestNoticeDetails("n1", { isIdle: () => false }), true);
  assert.equal(fixture.sent.length, 1);
  assert.deepEqual(fixture.sent[0]!.options, { deliverAs: "steer" });
  assert.equal(
    fixture.sent[0]!.message,
    `More details requested for "Deployment status":\n\n${body}\n\nRelevant context:\n${context}\n\nPlease elaborate on these details in your normal conversation reply.`,
    "the ordinary owner request preserves the complete body/context and explicitly asks for elaboration",
  );

  const closeComponent = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme,
    tuiHost: markdownHost(created, widths),
    shortcutLabel: "Ctrl+Alt+Up",
    getViewportRows: viewportRows,
    onDone() {},
  });
  closeComponent.handleInput(DOWN); // select the retained notice in the same list flow
  closeComponent.handleInput(ENTER);
  closeComponent.handleInput(DOWN); // Close
  closeComponent.handleInput(ENTER);
  assert.equal(fixture.sent.length, 1, "Close sends no explanation request");
  assert.equal(fixture.surface.controller.listPending().length, 1, "closing the notice preserves the question");
  assert.equal(fixture.surface.controller.listPending()[0]!.id, "q1");
});

test("question Markdown fallback discloses and preserves the complete safe question separately from its ID", async () => {
  const fixture = makeFixture();
  const question = "# Full question heading\n\n- Preserve every choice.\n\n```text\nraw=\u001b[31mQUESTION-END\n```";
  await fixture.tools.get("AskUserQuestion")!.execute("q-call-fallback", {
    question,
    choices: ["One", "Two"],
  }, undefined, undefined, { sessionManager: fixture.identity });

  const component = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme,
    tuiHost: { visibleWidth: terminalColumns },
    shortcutLabel: "Ctrl+Alt+Up",
    getViewportRows: () => 1000,
    onDone() {},
  });
  const list = component.render(4096).join("\n");
  assert.ok(list.includes("q1: # Full question heading"));
  assertNoRawTerminalControls(list);
  component.handleInput(ENTER);
  const detail = component.render(4096).join("\n");
  assert.match(detail, /Native Markdown unavailable; showing the complete question as plain text\./);
  assert.equal(detail.split("\n")[0], "q1:", "question ID metadata stays outside Markdown content");
  assert.ok(detail.includes("# Full question heading"));
  assert.ok(detail.includes("- Preserve every choice."));
  assert.ok(detail.includes("raw=\\u001b[31mQUESTION-END"));
  assert.match(detail, /QUESTION-END/);
  assertNoRawTerminalControls(detail);
});

test("notice details use normal idle delivery, preserve failures, and reject reentrant requests", async () => {
  const identity = { id: "delivery-session" };
  let fail = true;
  let calls = 0;
  const deliveryOptions: Array<{ deliverAs?: "steer" | "followUp" } | undefined> = [];
  const controller = new UserQuestionController({
    uiAvailable: () => true,
    pi: {
      sendUserMessage(_message: string, options?: { deliverAs?: "steer" | "followUp" }) {
        calls += 1;
        deliveryOptions.push(options);
        return fail ? Promise.reject(new Error("send failed")) : Promise.resolve();
      },
    },
  });
  controller.beginSession(identity);
  const registered = controller.registerNotice({
    toolCallId: "n1",
    title: "Build status",
    body: "## All content\n\nDo not truncate this body.",
    context: "Context remains verbatim.",
  }, identity);
  assert.ok(registered.ok);
  if (!registered.ok) return;

  // The first request is initiated synchronously and owns the reentrancy lock;
  // a concurrent second click cannot dispatch a duplicate message.
  const first = controller.requestNoticeDetails(registered.notice.id, { isIdle: () => true });
  const duplicate = await controller.requestNoticeDetails(registered.notice.id, { isIdle: () => false });
  assert.equal(duplicate, false);
  assert.equal(calls, 1);
  assert.equal(await first, false, "a failed host delivery is reported internally as a failure");
  assert.equal(controller.listPending().length, 1, "failure leaves the notice pending");

  fail = false;
  assert.equal(await controller.requestNoticeDetails(registered.notice.id, { isIdle: () => true }), true);
  assert.equal(calls, 2);
  assert.deepEqual(deliveryOptions, [undefined, undefined], "idle requests use ordinary non-steering delivery");
  assert.equal(controller.listPending().length, 1, "successful More details still does not dismiss the notice");
});

test("stale notice contexts cannot deliver or close an item in a replacement session", async () => {
  const identity = { id: "source-session" };
  const sent: string[] = [];
  const controller = new UserQuestionController({
    uiAvailable: () => true,
    pi: { sendUserMessage(message: string) { sent.push(message); } },
  });
  controller.beginSession(identity);
  const registered = controller.registerNotice({ toolCallId: "n1", title: "Notice", body: "Full body." }, identity);
  assert.ok(registered.ok);
  if (!registered.ok) return;

  const replacement = { id: "replacement-session" };
  const result = await controller.requestNoticeDetails(registered.notice.id, {
    isIdle: () => {
      controller.beginSession(replacement);
      return true;
    },
  });
  assert.equal(result, false, "identity is rechecked after the live idle probe");
  assert.equal(controller.closeNotice(registered.notice.id), false, "a stale close cannot act in the replacement session");
  assert.deepEqual(sent, []);
  assert.equal(controller.listPending().length, 0, "the ordinary session reset fence clears old pending input");
});

test("component resizing and theme invalidation rebuild native Markdown at the new width", () => {
  const created: string[] = [];
  const widths: number[] = [];
  const identity = { id: "render-session" };
  const controller = new UserQuestionController({ uiAvailable: () => true, pi: {} });
  controller.beginSession(identity);
  const registration = controller.registerNotice({
    toolCallId: "n1",
    title: "Resize",
    body: "## A long **Markdown** body\n\nRendered using the host component.",
  }, identity);
  assert.ok(registration.ok);
  if (!registration.ok) return;
  const component = createQuestionListComponent({
    controller,
    keybindings,
    theme,
    tuiHost: markdownHost(created, widths),
    shortcutLabel: "Ctrl+Alt+Up",
    onDone() {},
  });
  component.handleInput(ENTER);
  component.render(70);
  component.render(32);
  assert.deepEqual(widths.slice(0, 2), [70, 32], "a resize rerenders native Markdown with the current width");
  const before = created.length;
  component.invalidate(); // host theme invalidation
  component.render(32);
  assert.equal(created.length, before + 1, "theme invalidation creates a fresh Markdown component/theme");
});

test("an unavailable native Markdown peer is disclosed and shows the complete wrapped notice", () => {
  const identity = { id: "plain-fallback-session" };
  const controller = new UserQuestionController({ uiAvailable: () => true, pi: {} });
  controller.beginSession(identity);
  const emojiCombiningSequence = "😀e\u0301".repeat(24);
  const bodySequence = "0123456789".repeat(9);
  const body = `# Full **notice**\n\n${emojiCombiningSequence}\n\n${bodySequence}\n\nBODY-END`;
  const context = "Context starts here\nEmoji and combining: 😀e\u0301\nContext is still complete.\nCONTEXT-END";
  const registration = controller.registerNotice({ toolCallId: "n1", title: "Offline Markdown", body, context }, identity);
  assert.ok(registration.ok);
  if (!registration.ok) return;

  // No createMarkdown provider is present: the notice uses plain wrapping,
  // not a custom Markdown parser, and explicitly discloses the degradation.
  let fallbackViewportRows = 5;
  const component = createQuestionListComponent({
    controller,
    keybindings,
    theme,
    tuiHost: { visibleWidth: terminalColumns },
    shortcutLabel: "Ctrl+Alt+Up",
    getViewportRows: () => fallbackViewportRows,
    onDone() {},
  });
  component.handleInput(ENTER);
  const frames: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    frames.push(component.render(14).join("\n"));
    const previous = frames[frames.length - 1];
    component.handleInput(PAGE_DOWN);
    const next = component.render(14).join("\n");
    if (next === previous) break;
  }
  const fullView = frames.join("\n");
  fallbackViewportRows = 10_000;
  const normalizedView = component.render(14).join("\n").replace(/\s+/gu, " ");
  const flattened = fullView.replace(/\n/g, "");
  const visibleLines = fullView.split("\n");
  assert.match(normalizedView, /Native Markdown unavailable; showing the complete notice as plain text\./);
  assert.match(normalizedView, /# Full \*\*notice\*\*/);
  assert.ok(visibleLines.some((line) => line.includes("😀")), "complete emoji graphemes remain visible");
  assert.ok(visibleLines.some((line) => line.includes("e\u0301")), "combining sequences stay together");
  assert.ok(!visibleLines.some((line) => line.startsWith("\u0301")), "a wrap never separates a combining mark");
  for (let offset = 0; offset < bodySequence.length; offset += 30) {
    assert.ok(flattened.includes(bodySequence.slice(offset, offset + 30)), `plain fallback retains body segment ${offset}`);
  }
  assert.match(fullView, /BODY-END/);
  assert.match(normalizedView, /Context starts here/);
  assert.match(normalizedView, /Context is still complete\./);
  assert.match(fullView, /CONTEXT-END/);
  assert.match(normalizedView, /Relevant context/);
  assert.match(normalizedView, /More details/);
  assert.match(normalizedView, /Close/);
  for (const line of visibleLines) {
    assert.ok(terminalColumns(line) <= 14, `plain fallback line fits the requested terminal width: ${JSON.stringify(line)}`);
  }
});

test("notice tool result visibly encodes title controls while canonical and More details payloads stay exact", async () => {
  const fixture = makeFixture();
  const title = "Build \u001b]0;notice-title\u0007 \u001b[31mred\u001b[0m\r C1:\u009b31m literal \\u001b";
  const body = "## Complete 😀\n\nOSC: \u001b]52;c;clipboard\u0007 CSI: \u001b[2J C1: \u009d52;c;clipboard\u009c CR:\r literal \\u001b[31m BODY-END";
  const context = "Context stays exact: \u0085, \u009b32m, \u001b]0;context\u0007 CONTEXT-END";
  const result = await fixture.tools.get("YouShouldKnow")!.execute("n-call-terminal", {
    title,
    body,
    context,
  }, undefined, undefined, { sessionManager: fixture.identity });

  const resultText = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  assert.equal(
    resultText,
    `Notice registered as n1: "${visibleTerminalText(title)}". It stays pending until the user closes it from the pending-item list.`,
  );
  assert.ok(!resultText.includes(body), "the compact tool result must not echo substantive notice content");
  assert.ok(!resultText.includes("\u001b]"));
  assert.ok(!resultText.includes("\u009b"));

  const notice = fixture.surface.controller.getPending("n1");
  if (!notice || !("kind" in notice) || notice.kind !== "notice") assert.fail("registered notice remains canonical");
  assert.deepEqual({ title: notice.title, body: notice.body, context: notice.context }, { title, body, context });
  assert.equal(await fixture.surface.controller.requestNoticeDetails("n1"), true);
  assert.equal(
    fixture.sent[0]!.message,
    `More details requested for "${title}":\n\n${body}\n\nRelevant context:\n${context}\n\nPlease elaborate on these details in your normal conversation reply.`,
    "More details preserves the retained raw title/body/context and adds only the natural-language elaboration request",
  );
});

test("notice Markdown converts only control bytes and keeps theme ANSI and Markdown escapes intact", async () => {
  const fixture = makeFixture();
  const title = "Native \u001b]0;title\u0007 \u001b[31mCSI\r C1:\u009b and literal \\u001b";
  const bodyMarkdown = "## Keep \\*literal emphasis\\* and **real bold**\r\n\r\n```ts\r\nconst fence = 1;\r\n```\r\n\r\nBackslashes: \\\\ path; ";
  const expectedBodyMarkdown = "## Keep \\*literal emphasis\\* and **real bold**\n\n```ts\nconst fence = 1;\n```\n\nBackslashes: \\\\ path; ";
  const body = `${bodyMarkdown}\u001b[31mred\u001b[0m\r, C1 \u009b32m, OSC \u001b]52;c;clipboard\u0007 / C1 OSC \u009d52;c;clipboard\u009c 😀 BODY-END`;
  const expectedBody = `${expectedBodyMarkdown}\\u001b[31mred\\u001b[0m\\r, C1 \\u009b32m, OSC \\u001b]52;c;clipboard\\u0007 / C1 OSC \\u009d52;c;clipboard\\u009c 😀 BODY-END`;
  const contextMarkdown = "Context \\[escaped link\\] and *real emphasis*.\r\n\r\nLiteral slash: \\ stays literal; ";
  const expectedContextMarkdown = "Context \\[escaped link\\] and *real emphasis*.\n\nLiteral slash: \\ stays literal; ";
  const context = `${contextMarkdown}\r C1 CSI: \u009b33m and C1 OSC: \u009d0;context\u009c CONTEXT-END`;
  const expectedContext = `${expectedContextMarkdown}\\r C1 CSI: \\u009b33m and C1 OSC: \\u009d0;context\\u009c CONTEXT-END`;
  const registered = await fixture.tools.get("YouShouldKnow")!.execute("n-call-native-controls", {
    title,
    body,
    context,
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.equal((registered.details as { id: string }).id, "n1");

  const nativeInputs: string[] = [];
  const ansiTheme = {
    fg: (_color: string, text: string) => `\u001b[92m${text}\u001b[39m`,
    bold: (text: string) => `\u001b[95m${text}\u001b[39m`,
  };
  const component = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme: ansiTheme,
    tuiHost: {
      visibleWidth: terminalColumns,
      wrapTextWithAnsi: (text) => [text],
      createMarkdown(source) {
        nativeInputs.push(source);
        return {
          render() { return source.split("\n"); },
          invalidate() {},
        };
      },
    },
    shortcutLabel: "Ctrl+Alt+Up",
    onDone() {},
  });

  const list = component.render(1000).join("\n");
  const safeTitle = visibleTerminalText(title);
  assert.ok(list.includes(safeTitle), "the list title is reversibly encoded before styling");
  assert.ok(list.includes("\u001b[92m"), "generated theme ANSI remains intact");
  assert.ok(!list.includes("\u001b]0;title"));
  assert.ok(!list.includes("\u009b"));
  component.handleInput(ENTER);

  const nativeView = component.render(1000).join("\n");
  assert.deepEqual(nativeInputs, [expectedBody, expectedContext]);
  assert.ok(nativeInputs[0]!.includes("## Keep \\*literal emphasis\\* and **real bold**\n"));
  assert.ok(nativeInputs[0]!.includes("```ts\nconst fence = 1;\n```"), "CRLF closing fences stay structural Markdown newlines");
  const canonical = fixture.surface.controller.getPending("n1");
  if (!canonical || !("kind" in canonical) || canonical.kind !== "notice") assert.fail("registered notice remains canonical");
  assert.equal(canonical.body, body, "native CRLF normalization never changes the retained original");
  assert.equal(canonical.context, context, "native input preprocessing never changes retained context");
  assert.ok(nativeView.includes(expectedBody));
  assert.ok(nativeView.includes(expectedContext));
  assert.ok(nativeView.includes(`\u001b[95mn1: ${safeTitle}\u001b[39m`), "the title is encoded before native theme styling");
  assert.ok(nativeView.includes("\u001b[92m"), "action styling is neither stripped nor encoded");
  for (const hostileControl of ["\u001b]0;title", "\u001b[31m", "\u009b", "\u009d", "\u009c", "\r", "\u0007"]) {
    assert.ok(!nativeView.includes(hostileControl), `native display excludes raw ${JSON.stringify(hostileControl)}`);
  }
  assert.equal(await fixture.surface.controller.requestNoticeDetails("n1"), true);
  assert.equal(
    fixture.sent[0]!.message,
    `More details requested for "${title}":\n\n${body}\n\nRelevant context:\n${context}\n\nPlease elaborate on these details in your normal conversation reply.`,
    "native display normalization leaves the original delivery content unchanged",
  );
});

test("the shared safe Markdown adapter protects same-source question and notice content", async () => {
  const fixture = makeFixture();
  const cachedMarkdownSource = "# Cached \u001b[31mMarkdown\u001b[0m with \\*literal emphasis\\*";
  const question = await fixture.tools.get("AskUserQuestion")!.execute("q-call-cache", {
    question: cachedMarkdownSource,
  }, undefined, undefined, { sessionManager: fixture.identity });
  assert.equal((question.details as { id: string }).id, "q1");
  await fixture.tools.get("YouShouldKnow")!.execute("n-call-cache", {
    title: "Cache collision",
    body: cachedMarkdownSource,
  }, undefined, undefined, { sessionManager: fixture.identity });

  const nativeInputs: string[] = [];
  const component = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme,
    tuiHost: {
      createMarkdown(source) {
        nativeInputs.push(source);
        return {
          render() { return source.split("\n"); },
          invalidate() {},
        };
      },
    },
    shortcutLabel: "Ctrl+Alt+Up",
    onDone() {},
  });

  component.handleInput(ENTER); // question detail caches the original source
  component.render(1000);
  component.handleInput(ESCAPE);
  component.handleInput(DOWN);
  component.handleInput(ENTER); // notice body is the exact same source string
  const noticeView = component.render(1000).join("\n");

  assert.deepEqual(nativeInputs, [
    "# Cached \\u001b[31mMarkdown\\u001b[0m with \\*literal emphasis\\*",
    "# Cached \\u001b[31mMarkdown\\u001b[0m with \\*literal emphasis\\*",
  ]);
  assert.ok(noticeView.includes("# Cached \\u001b[31mMarkdown\\u001b[0m with \\*literal emphasis\\*"));
  assert.ok(!noticeView.includes("\u001b[31m"), "a cached question component cannot bypass notice preprocessing");
  assert.equal(nativeInputs[0], safeMarkdownDisplaySource(cachedMarkdownSource));
});

test("plain notice fallback visibly encodes hostile controls once and keeps complete Unicode title, body, and context", async () => {
  const fixture = makeFixture();
  const title = "Plain \u001b]0;fallback\u0007\r\u009b31m 😀 literal \\u001b";
  const body = "# Full **notice** 😀\n\nOSC \u001b]52;c;clipboard\u0007; CSI \u001b[2J; CR\r; C1 \u009b31m / \u009d0;osc\u009c; literal \\u001b[31m BODY-END";
  const context = "Context 😀\n\nC1 NEL \u0085; C1 CSI \u009b32m; OSC \u001b]0;context\u0007 CONTEXT-END";
  await fixture.tools.get("YouShouldKnow")!.execute("n-call-plain-controls", {
    title,
    body,
    context,
  }, undefined, undefined, { sessionManager: fixture.identity });

  const component = createQuestionListComponent({
    controller: fixture.surface.controller,
    keybindings,
    theme,
    tuiHost: { visibleWidth: terminalColumns },
    shortcutLabel: "Ctrl+Alt+Up",
    getViewportRows: () => 1000,
    onDone() {},
  });
  component.handleInput(ENTER);
  const displayed = component.render(4096).join("\n");
  const encodedBody = visibleTerminalText(body);
  assert.match(displayed, /Native Markdown unavailable; showing the complete notice as plain text\./);
  const encodedTitle = visibleTerminalText(title);
  assert.ok(displayed.includes(encodedTitle));
  assert.ok(!displayed.includes(visibleTerminalText(encodedTitle)), "the title is not encoded twice");
  assert.ok(displayed.includes(encodedBody), "the complete body appears with one reversible encoding pass");
  assert.ok(!displayed.includes(visibleTerminalText(encodedBody)), "the body is not encoded twice");
  assert.ok(displayed.includes(visibleTerminalText(context)), "the complete context appears with one reversible encoding pass");
  assert.ok(displayed.includes("😀"));
  assert.match(displayed, /BODY-END/);
  assert.match(displayed, /CONTEXT-END/);
  assert.match(displayed, /More details/);
  assert.match(displayed, /Close/);
  assert.notEqual(encodedBody, visibleTerminalText(encodedBody), "the encoder is intentionally not idempotent");
  assertNoRawTerminalControls(displayed);
});

function assertNoRawTerminalControls(text: string): void {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(
      character === "\n" || character === "\t" || !(code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)),
      `unexpected raw terminal control in ${JSON.stringify(text)}`,
    );
  }
}
