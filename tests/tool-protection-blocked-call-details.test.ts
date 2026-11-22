/**
 * Issue #661 — a project-owned tool call that tool protection refused before
 * execution stays inspectable, in every family that owns a result renderer.
 *
 * Each test runs the production pieces end to end (see ./blocked-call-fixtures):
 * the real admission coordinator refuses the proposal with an injected auditor,
 * the coordinator's own renderer decoration wraps the family's real registered
 * renderer, and the assertions read what the host would draw.
 *
 * The agreed boundary is the recorded, call-bound root-refusal provenance, not a
 * shape guess: a family only takes its blocked-request view when THIS gate
 * refused THIS call. The last group of tests pins that boundary, so an ordinary
 * tool error, a PASS row, a nested child's refusal, and a successful call all
 * keep the presentation they had before.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderExpandedApplyPatchResult, renderApplyPatchResult } from "../src/apply-patch/result-renderer";
import {
  renderShellLogResult,
  renderShellSendResult,
  renderShellStartResult,
  renderShellStopResult,
  shellLogCollapsedView,
  shellSendCollapsedView,
  shellStartCollapsedView,
  shellStopCollapsedView,
} from "../src/background-shell/result-view";
import { renderSubtaskResultCollapsed } from "../src/execution/subtask-result-collapsed";
import { renderSubtaskResultExpanded } from "../src/execution/subtask-result-expanded";
import { EXECUTION_TOOL_NAMES } from "../src/execution/tool-names";
import { browserRenderResult } from "../src/web/browser-renderer";
import { deferredToolSearchRenderResult } from "../src/deferred-tools-result-renderer";
import { renderExpandedWebSearchResult, renderWebSearchResult } from "../src/web/result-renderer";
import { expandableResult } from "../src/tool-result-expansion";
import {
  readToolProtectionRefusal,
  rootRefusalProvenance,
  TOOL_PROTECTION_DISPLAY_VERSION,
  type AuditDisplayData,
  type AuditDisplayRecord,
} from "../src/tool-protection/display";
import {
  blockedContext,
  blockedResult,
  createBlockedCallPipeline,
  PLAIN_THEME,
  renderDecorated,
  renderDecoratedCollapsed,
  type RefusedCall,
} from "./blocked-call-fixtures";

/** The registration wrapper each family's own `registerTool` installs. */
const subtaskRenderer = { renderResult: expandableResult(renderSubtaskResultCollapsed, renderSubtaskResultExpanded) };
const shellSendRenderer = { renderResult: expandableResult(shellSendCollapsedView, renderShellSendResult) };
const shellStartRenderer = { renderResult: expandableResult(shellStartCollapsedView, renderShellStartResult) };
const shellLogRenderer = { renderResult: expandableResult(shellLogCollapsedView, renderShellLogResult) };
const shellStopRenderer = { renderResult: expandableResult(shellStopCollapsedView, renderShellStopResult) };
const webSearchRenderer = { renderResult: expandableResult(renderWebSearchResult, renderExpandedWebSearchResult) };
const applyPatchRenderer = { renderResult: expandableResult(renderApplyPatchResult, renderExpandedApplyPatchResult) };
/** The one shared wrapper all 18 interactive browser tools register. The host
 *  render context these tests build carries no tool-name field at all, so only
 *  the recorded refusal provenance can identify which tool was refused. */
const browserToolRenderer = { renderResult: browserRenderResult };
/** The deferred-discovery tool ships one shared wrapper too. */
const deferredSearchRenderer = { renderResult: deferredToolSearchRenderResult };

const AUDIT_DENIAL = { output: '{"decision":"FAIL"}' };
const AUDIT_UNAVAILABLE = { error: "Auditor timed out after 5000ms." };

/** One refused call, rendered through the production decoration + family renderer. */
async function refusedAndRendered(
  toolName: string,
  baseDefinition: unknown,
  args: Record<string, unknown>,
  auditorReply: { output?: string; error?: string } = AUDIT_DENIAL,
): Promise<{ text: string; collapsed: string; call: RefusedCall }> {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(baseDefinition, toolName);
  const call = await pipeline.refuse({ toolName, callId: `call-${toolName}`, input: args, auditorReply });
  const result = blockedResult(call);
  const context = blockedContext(call);
  const text = renderDecorated(decorated, result, context);
  const collapsed = renderDecoratedCollapsed(decorated, result, context);
  // The decoration must never rewrite the model-facing result object.
  assert.deepEqual(result.details, {}, "the refused call's result details are untouched");
  assert.equal((result.content as unknown[]).length, 1, "the refused call's returned text is untouched");
  return { text, collapsed, call };
}

// ---------------------------------------------------------------------------
// Subtasks family — the reported defect
// ---------------------------------------------------------------------------

const START_ARGS = {
  kind: "research",
  workspace: "/synthetic/target-checkout",
  tasks: [
    {
      title: "Audit the widget loader",
      instructions: "Read src/loader.ts and report every retry path.\nDo not modify any file.",
      acceptanceCriteria: ["Every retry path is named with its line", "No file is modified"],
      relevantContext: "The reporter saw a double retry after the 30s budget elapsed.",
    },
    {
      title: "Summarise the timeout budget",
      instructions: "Report the configured timeout budget and where it is applied.",
      acceptanceCriteria: ["The budget is quoted with its configuration key"],
    },
  ],
};

/**
 * The complete submitted-request assertions a refused `SubtasksStart` must
 * satisfy — run for EVERY refusal outcome (an audit `FAIL` and an unavailable
 * audit), because the only thing that differs between them is the gate's own row.
 */
function assertBlockedStartRequestIsInspectable(text: string): void {
  assert.match(text, /(?:^|\n)SubtasksStart · not executed/, "the body names the refused tool and says it did not run");
  assert.match(text, /Refused before execution/, "the body states the call never entered the tool");
  assert.match(text, /Original submitted request/, "the original proposed call is presented");
  assert.ok(text.includes("kind: research"), "submitted kind");
  assert.ok(text.includes("workspace: /synthetic/target-checkout"), "submitted workspace");
  assert.ok(text.includes("tasks (2):"), "the submitted task count");
  // Task 1 — every supplied field, including both instruction lines.
  assert.ok(text.includes("title: Audit the widget loader"), "task 1 title");
  assert.ok(text.includes("Read src/loader.ts and report every retry path."), "task 1 instructions, first line");
  assert.ok(text.includes("Do not modify any file."), "task 1 instructions, second line");
  assert.ok(text.includes("- Every retry path is named with its line"), "task 1 acceptance criterion 1");
  assert.ok(text.includes("- No file is modified"), "task 1 acceptance criterion 2");
  assert.ok(text.includes("relevantContext: The reporter saw a double retry after the 30s budget elapsed."), "task 1 relevant context");
  // Task 2 — the same fields, and no invented value for the omitted one.
  assert.ok(text.includes("title: Summarise the timeout budget"), "task 2 title");
  assert.ok(text.includes("instructions: Report the configured timeout budget and where it is applied."), "task 2 instructions");
  assert.ok(text.includes("- The budget is quoted with its configuration key"), "task 2 acceptance criterion");
  assert.ok(!text.includes("relevantContext: ("), "an omitted optional field is never shown as an empty value");
  // Nothing is invented, and the old empty-diagnostic line is gone.
  assert.doesNotMatch(text, /\(no diagnostic returned\)/, "no empty-diagnostic placeholder");
  assert.doesNotMatch(text, /executionId: exec-/, "no invented execution handle");
  assert.doesNotMatch(text, /task [0-9a-f]{8}-/, "no invented task handle");
}

test("a refused SubtasksStart exposes the submitted kind, workspace, and every task field (#661)", async () => {
  const { text, collapsed, call } = await refusedAndRendered("SubtasksStart", subtaskRenderer, START_ARGS);

  // The gate's own row still carries the refusal, exactly once.
  assert.match(text, /^Tool protection: FAIL — the auditor denied this SubtasksStart call\./, "the gate row draws the recorded refusal");
  assert.equal(text.split("Tool protection: FAIL —").length - 1, 1, "the refusal is drawn once, not duplicated");

  assertBlockedStartRequestIsInspectable(text);

  // The collapsed card stays bounded and names the same refused tool.
  assert.match(collapsed, /SubtasksStart · not executed/, "the collapsed card names the refused tool");
  assert.ok(collapsed.includes("Audit the widget loader"), "the collapsed card shows a submitted task title");
  assert.ok(collapsed.includes("No execution result was returned"), "the collapsed card claims no execution result");
  assert.equal((call.args.tasks as unknown[]).length, 2, "the recorded arguments are the submitted ones");
});

test("a SubtasksStart blocked because the audit is unavailable exposes the same submitted request", async () => {
  const { text, collapsed } = await refusedAndRendered("SubtasksStart", subtaskRenderer, START_ARGS, AUDIT_UNAVAILABLE);
  assert.match(text, /^Tool protection: audit unavailable — Auditor timed out after 5000ms\./, "the gate row carries the recorded transport failure");
  // The same complete field-by-field contract as the denial outcome.
  assertBlockedStartRequestIsInspectable(text);
  assert.match(collapsed, /SubtasksStart · not executed/, "the collapsed card names the refused tool");
  assert.ok(collapsed.includes("Summarise the timeout budget"), "the collapsed card shows a submitted task title");
  assert.ok(collapsed.includes("No execution result was returned"), "the collapsed card claims no execution result");
});

test("a refused SubtasksStart stays inspectable when the host omits result details", async () => {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(subtaskRenderer, "SubtasksStart");
  const call = await pipeline.refuse({
    toolName: "SubtasksStart", callId: "call-no-details", input: START_ARGS, auditorReply: AUDIT_DENIAL,
  });
  assertBlockedStartRequestIsInspectable(renderDecorated(
    decorated, { content: blockedResult(call).content }, blockedContext(call),
  ));
});

test("a refused SubtasksSteer projects its own submitted arguments, not another tool's", async () => {
  const args = {
    executionId: "exec-aaaaaaaa-0000",
    taskId: "task-bbbbbbbb-1111",
    instructions: "Stop the retry work and report only the timeout budget.",
    interrupt: true,
  };
  const { text } = await refusedAndRendered("SubtasksSteer", subtaskRenderer, args);
  assert.match(text, /(?:^|\n)SubtasksSteer · not executed/, "the body names the refused tool");
  assert.ok(text.includes("executionId: exec-aaaaaaaa-0000"), "the submitted execution id is shown as submitted");
  assert.ok(text.includes("taskId: task-bbbbbbbb-1111"), "the submitted task id is shown as submitted");
  assert.ok(text.includes("instructions: Stop the retry work and report only the timeout budget."), "the submitted instruction is shown in full");
  assert.ok(text.includes("interrupt: true"), "the submitted flag is shown");
  assert.doesNotMatch(text, /tasks \(/, "a steer call is never shown with another tool's fields");
});

test("every Subtasks tool in the family inventory keeps its submitted request inspectable", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [EXECUTION_TOOL_NAMES.start, { kind: "execute", tasks: [{ title: "T", instructions: "I", acceptanceCriteria: ["A"] }] }],
    [EXECUTION_TOOL_NAMES.add, { executionId: "exec-1", tasks: [{ title: "T2", instructions: "I2", acceptanceCriteria: ["A2"] }] }],
    [EXECUTION_TOOL_NAMES.inspect, { executionId: "exec-1", taskId: "task-1", offset: 12, lines: 40 }],
    [EXECUTION_TOOL_NAMES.inspect, { executionId: "exec-1", taskId: "task-1", evidence: { find: "retry budget", filter: "tool_call", limit: 5 } }],
    [EXECUTION_TOOL_NAMES.watch, { executionId: "exec-1", after: "30m" }],
    [EXECUTION_TOOL_NAMES.continue, { executionId: "exec-1", taskId: "task-1", instructions: "Resume", inPlace: true }],
    [EXECUTION_TOOL_NAMES.steer, { executionId: "exec-1", taskId: "task-1", instructions: "Steer", instructionId: "idem-7" }],
    [EXECUTION_TOOL_NAMES.interrupt, { executionId: "exec-1", taskId: "task-1", interruptMode: "interrupt_with_merge" }],
    [EXECUTION_TOOL_NAMES.force_merge, { executionId: "exec-1", taskId: "task-1", mergeAnyhow: true }],
    [EXECUTION_TOOL_NAMES.mark_clean, {}],
  ];
  for (const [toolName, args] of cases) {
    const { text, collapsed } = await refusedAndRendered(toolName, subtaskRenderer, args);
    assert.match(text, new RegExp(`(?:^|\\n)${toolName} · not executed`), `${toolName}: the body names the refused tool`);
    assert.match(collapsed, new RegExp(`${toolName} · not executed`), `${toolName}: the collapsed card names the refused tool`);
    assert.doesNotMatch(text, /\(no diagnostic returned\)/, `${toolName}: no empty-diagnostic placeholder`);
    if (toolName === EXECUTION_TOOL_NAMES.mark_clean) {
      assert.match(text, /no submitted arguments were recorded/, `${toolName}: an argument-free tool says so honestly`);
      continue;
    }
    // Every supplied scalar argument of the tool's own projection survives.
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        assert.ok(text.includes(`${key}: ${value}`), `${toolName}: submitted ${key} is inspectable`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// A representative other project-owned family: Shell (its own submitted rules)
// ---------------------------------------------------------------------------

/**
 * The complete submitted-request assertions a refused `ShellSend` must satisfy —
 * run for EVERY refusal outcome, because the tool never ran in either one. The
 * stdin text is the ORIGINAL argument: the tool appends a newline only when it
 * prepares a write, and a refused call never prepared one.
 */
function assertShellSendRequestIsInspectable(text: string): void {
  assert.match(text, /ShellSend — expanded view limited: no structured details were recorded/, "the family keeps its honest legacy disclosure");
  assert.ok(text.includes("Job submitted:"), "the submitted job identity is inspectable");
  assert.ok(text.includes('"job-42"'), "the submitted id is shown in its exact quoted form");
  assert.ok(text.includes("Input submitted:"), "the submitted stdin text is inspectable");
  assert.match(text, /Input submitted:\n"y"/m, "the stdin text is shown exactly as submitted");
  assert.doesNotMatch(text, /"y\\n"/, "no newline is synthesized for a write that never happened");
  assert.doesNotMatch(text, /Job (started|running|accepted)/, "no delivery or execution claim is added");
}

const SHELL_OUTCOMES: Array<[string, { output?: string; error?: string }, RegExp]> = [
  ["denied by the auditor", AUDIT_DENIAL, /^Tool protection: FAIL —/],
  ["blocked because the audit is unavailable", AUDIT_UNAVAILABLE, /^Tool protection: audit unavailable — Auditor timed out after 5000ms\./],
];

for (const [label, auditorReply, rowPattern] of SHELL_OUTCOMES) {
  test(`a refused ShellSend ${label} keeps the submitted job id and stdin text under its existing rules`, async () => {
    const { text, collapsed } = await refusedAndRendered("ShellSend", shellSendRenderer, { id: "job-42", text: "y" }, auditorReply);
    assert.match(text, rowPattern, "the gate row draws this outcome's recorded refusal");
    assertShellSendRequestIsInspectable(text);
    assert.ok(collapsed.length > 0, "the collapsed arm still renders");
  });
}

test("a refused ShellStart shows the submitted command, job label, and wake rules", async () => {
  const { text } = await refusedAndRendered("ShellStart", shellStartRenderer, {
    command: "python train.py --epochs 3",
    label: "finetune",
    wake_on: { exit: false, match: ["Traceback", "val_loss="], silence: "10m", every_n_matches: 5 },
  });
  assert.match(text, /ShellStart — expanded view limited/, "honest legacy disclosure is kept");
  assert.ok(text.includes("Command submitted:"), "the submitted command is inspectable");
  assert.ok(text.includes("python train.py --epochs 3"), "the submitted command value survives");
  assert.ok(text.includes("Label submitted:"), "the submitted job label is inspectable, not derived from the command");
  assert.ok(text.includes('"finetune"'), "the submitted label value survives");
  assert.ok(text.includes("Wake rules submitted:"), "the submitted wake rules are inspectable");
  assert.ok(text.includes("exit: false"), "an explicitly false wake setting is shown, not dropped as falsy");
  assert.ok(text.includes('match: ["Traceback","val_loss="]'), "the submitted match list is shown as submitted");
  assert.ok(text.includes('silence: "10m"'), "the submitted silence window survives");
  assert.ok(text.includes("every_n_matches: 5"), "the submitted throttle survives");
  assert.doesNotMatch(text, /Job (started|running|exited)/, "no execution claim is added");
});

test("a refused ShellStart that submitted no label or wake rules invents neither", async () => {
  const { text } = await refusedAndRendered("ShellStart", shellStartRenderer, { command: "sleep 5" });
  assert.ok(text.includes("sleep 5"), "the submitted command is still shown");
  assert.doesNotMatch(text, /Label submitted:/, "no label is invented for a call that sent none");
  assert.doesNotMatch(text, /Wake rules submitted:/, "no wake rules are invented for a call that sent none");
});

test("a refused ShellLog shows the submitted range selectors and the exact job id", async () => {
  const { text } = await refusedAndRendered("ShellLog", shellLogRenderer, { id: " job-77 ", offset: 0, lines: 200 });
  assert.match(text, /ShellLog — expanded view limited/, "honest legacy disclosure is kept");
  assert.ok(text.includes("Job submitted:"), "the submitted job identity is inspectable");
  assert.ok(text.includes('" job-77 "'), "the id is shown exactly, with its surrounding whitespace");
  assert.ok(text.includes("Requested range submitted:"), "the submitted read selectors are inspectable");
  assert.ok(text.includes("offset: 0"), "a submitted zero offset is shown, not dropped as falsy");
  assert.ok(text.includes("lines: 200"), "the nondefault line count is shown");
});

test("a refused ShellLog that submitted no range substitutes no default", async () => {
  const { text } = await refusedAndRendered("ShellLog", shellLogRenderer, { id: "job-77" });
  assert.ok(text.includes('"job-77"'), "the exact id is still shown");
  assert.doesNotMatch(text, /Requested range submitted/, "an omitted selector is simply absent");
  assert.doesNotMatch(text, /offset: 60|lines: 60/, "no default is invented for a value the model never sent");
});

test("a refused ShellStop shows a whitespace-sensitive target exactly", async () => {
  const { text } = await refusedAndRendered("ShellStop", shellStopRenderer, { id: " all " });
  assert.ok(text.includes("Job submitted:"), "the submitted target is inspectable");
  assert.ok(/" all "/.test(text), "the exact target is shown, quotes and all");
  assert.doesNotMatch(text, /^all$/m, "the target is never presented as the different id 'all'");
});

test("a legacy Shell row with no refusal provenance gains no submitted-request line", async () => {
  // Same result shape, no gate provenance: the pre-existing legacy view is unchanged.
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(shellLogRenderer, "ShellLog");
  const context = blockedContext({ reason: "restored row", callId: "call-never-audited", args: { id: "job-77" } });
  const text = renderDecorated(decorated, { content: [{ type: "text", text: "restored row" }], details: {} }, context);
  assert.match(text, /ShellLog — expanded view limited/, "the legacy disclosure still renders");
  assert.doesNotMatch(text, /Job submitted:/, "no request line appears without a recorded refusal");
});

// ---------------------------------------------------------------------------
// Families whose blocked path already projects the request: pinned, unchanged
// ---------------------------------------------------------------------------

test("a refused BrowserFill keeps its existing recorded-request projection", async () => {
  const args = { session: "s-1", tab: "t1", ref: "e17", value: "synthetic secret-shaped token" };
  const { text } = await refusedAndRendered("BrowserFill", browserToolRenderer, args);
  assert.match(text, /^BrowserFill$/m, "the header is the refused tool itself");
  assert.match(text, /Browser result failed; no additional retained detail is available/, "the family's existing failure framing is unchanged");
  assert.match(text, /Recorded request \(dispatch not established\):/, "the existing recorded-request rule still applies");
  assert.ok(text.includes("Requested target: e17"), "the submitted ref is shown");
  assert.ok(text.includes("synthetic secret-shaped token"), "the submitted value is shown as recorded, with no second redaction pass");
});

// ---------------------------------------------------------------------------
// The interactive Browser family where the host context cannot identify the call:
// the installed host supplies `args` and `toolCallId` but no tool name, and this
// gate's own rows strip the refusal text from the renderer's copy, so only the
// recorded refusal provenance names the tool and selects its projection.
// ---------------------------------------------------------------------------

test("a refused BrowserConsole names itself and shows its recorded cursor and maximum", async () => {
  const { text } = await refusedAndRendered("BrowserConsole", browserToolRenderer, {
    session: "s-1", tab: "t1", cursor: "cur-4242", maxEvents: 250,
  });
  assert.match(text, /^BrowserConsole$/m, "the header is the refused tool, not an argument-shape guess");
  assert.doesNotMatch(text, /^BrowserTabs$/m, "a console read is never labeled a tab operation");
  assert.match(text, /Recorded request \(dispatch not established\):/, "the recorded-request rule applies");
  assert.ok(text.includes("Requested session: s-1"), "the submitted session is shown");
  assert.ok(text.includes("Requested tab: t1"), "the submitted tab is shown");
  assert.ok(text.includes("cursor cur-4242"), "the nondefault submitted cursor is shown");
  assert.ok(text.includes("maximum 250 events"), "the nondefault submitted maximum is shown");
});

test("a refused BrowserClick shows a submitted x of 0 and its submitted y", async () => {
  const { text } = await refusedAndRendered("BrowserClick", browserToolRenderer, {
    session: "s-1", tab: "t1", x: 0, y: 480,
  });
  assert.match(text, /^BrowserClick$/m, "the header is the refused tool");
  assert.ok(text.includes("Requested X: 0"), "a submitted x of 0 is shown, not dropped as falsy");
  assert.ok(text.includes("Requested Y: 480"), "the submitted y is shown");
});

test("a refused BrowserDownloadSave shows its submitted handle and destination", async () => {
  const { text } = await refusedAndRendered("BrowserDownloadSave", browserToolRenderer, {
    session: "s-1", tab: "t1", download: "dl-7f3a", destination: "/tmp/synthetic/report.csv",
  });
  assert.match(text, /^BrowserDownloadSave$/m, "the header is the refused tool");
  assert.match(text, /Recorded request \(dispatch not established\):/, "the recorded-request rule applies");
  assert.ok(text.includes("Requested download: dl-7f3a"), "the submitted pending-download handle is shown");
  assert.ok(text.includes("Requested destination: /tmp/synthetic/report.csv"), "the submitted destination is shown");
});

test("a refused BrowserUpload shows the target and the file count, never the source paths", async () => {
  const { text } = await refusedAndRendered("BrowserUpload", browserToolRenderer, {
    session: "s-1", tab: "t1", ref: "e9",
    files: ["/tmp/synthetic/private-a.bin", "/tmp/synthetic/private-b.bin", "/tmp/synthetic/private-c.bin"],
  });
  assert.match(text, /^BrowserUpload$/m, "the header is the refused tool");
  assert.ok(text.includes("Requested target: e9"), "the submitted file-input ref is shown");
  assert.ok(text.includes("Files: 3 requested"), "the submitted file count is shown, count-only as in the successful view");
  assert.doesNotMatch(text, /private-a\.bin|private-b\.bin|private-c\.bin/, "upload source paths are never rendered");
});

test("a refused BrowserHistory is not mislabeled when its arguments are ambiguous", async () => {
  const { text } = await refusedAndRendered("BrowserHistory", browserToolRenderer, {
    session: "s-1", tab: "t1", operation: "back",
  });
  assert.match(text, /^BrowserHistory$/m, "the header is the refused tool, not the tab operation its shape suggests");
  assert.doesNotMatch(text, /^BrowserTabs$/m, "a history call is never labeled a tab operation");
  assert.ok(text.includes("Requested operation: back"), "the submitted history operation is shown");
});

test("the refused Browser projection inherits the family's single display-encoding boundary", async () => {
  const { text, collapsed } = await refusedAndRendered("BrowserDownloadSave", browserToolRenderer, {
    session: "s\u001b[31m-1", download: "dl\u007f-7f3a", destination: "/tmp/c1\u0085/report\u0007.csv",
  });
  assert.ok(text.includes("Requested session: s\\u001b[31m-1"), "an ESC in a submitted session renders as notation");
  assert.ok(text.includes("dl\\u007f-7f3a"), "a DEL in a submitted handle renders as notation");
  assert.ok(text.includes("/tmp/c1\\u0085/report\\u0007.csv"), "a C1 control and a BEL in a submitted path render as notation");
  assert.ok(!RAW_CONTROL_PATTERN.test(text), "the refused Browser view carries no raw terminal control byte");
  assert.ok(!RAW_CONTROL_PATTERN.test(collapsed), "the collapsed refused Browser card carries no raw terminal control byte");
});

test("a refused WebSearch keeps the submitted query inspectable", async () => {
  const args = { query: "widget retry budget documentation", maxResults: 3, region: "us-en" };
  const { text } = await refusedAndRendered("WebSearch", webSearchRenderer, args);
  assert.match(text, /(?:^|\n)WebSearch/, "the family names the refused tool");
  assert.ok(text.includes("widget retry budget documentation"), "the submitted query survives");
});

test("a refused ApplyPatch still shows the requested patch from the recorded call", async () => {
  const patch = "*** Begin Patch\n*** Add File: notes/todo.txt\n+inspect the blocked call view\n*** End Patch";
  const { text } = await refusedAndRendered("ApplyPatch", applyPatchRenderer, { patch });
  assert.match(text, /Requested patch:/, "the existing requested-patch projection still applies");
  assert.ok(text.includes("*** Add File: notes/todo.txt"), "the submitted envelope survives");
});

test("a refused tool_search keeps the submitted query inspectable", async () => {
  const { text } = await refusedAndRendered("tool_search", deferredSearchRenderer, { query: "background shell job" });
  assert.match(text, /(?:^|\n)tool_search/, "the family names the refused tool itself");
  assert.ok(text.includes("Query: background shell job"), "the submitted query is shown from the recorded call");
  assert.doesNotMatch(text, /activated \d+ tool/, "no discovery outcome is invented for a call that never ran");
});

// ---------------------------------------------------------------------------
// Display safety: a submitted terminal control is shown, never executed
// ---------------------------------------------------------------------------

/** Every byte the installed host would act on if it reached the terminal raw.
 *  LF and TAB are structural whitespace and stay as-is (the shared encoding's
 *  own rule), so they are deliberately not in this set. */
const RAW_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const CONTROL_ARGS = {
  kind: "execute",
  workspace: "/work/\u001b[31mred\u0007",
  tasks: [{
    title: "title \u001b]0;window-title\u0007 end",
    instructions: "first line\r\nsecond line with \u0000 nul",
    acceptanceCriteria: [
      "criterion \u001b[1mbold\u001b[0m",
      "multiline criterion first row\nits continuation row",
      "del\u007fc1\u009b end",
    ],
    relevantContext: "tab\there",
  }],
  "\u0007unprojected": "a value this view must not render",
};

test("a refused call shows submitted terminal controls as visible notation, never as live controls", async () => {
  const { text, collapsed } = await refusedAndRendered("SubtasksStart", subtaskRenderer, CONTROL_ARGS);

  // The escape notation is visible, so the user sees what was really submitted.
  assert.ok(text.includes("\\u001b[31mred\\u0007"), "an ESC/BEL in the submitted workspace renders as notation");
  assert.ok(text.includes("\\u001b]0;window-title\\u0007"), "an OSC control in a task title renders as notation");
  assert.ok(text.includes("first line\\r"), "a submitted CR renders as \\r notation");
  assert.ok(text.includes("second line with \\u0000 nul"), "a NUL renders as notation");
  assert.ok(text.includes("criterion \\u001b[1mbold\\u001b[0m"), "an acceptance criterion's controls render as notation");
  assert.ok(text.includes("del\\u007fc1\\u009b end"), "DEL and a C1 control render as notation, not literal bytes");
  // Multiline structure survives the encoding: each submitted line is still its
  // own rendered row, and a submitted TAB becomes visible notation.
  assert.match(text, /first line\\r\n\s+second line with/, "multiline instructions keep their line structure");
  assert.ok(text.includes("relevantContext: tab\\there"), "a submitted TAB renders as \\t notation");
  assert.ok(!text.includes("\t"), "no raw TAB reaches the expanded row (its width must be unambiguous)");
  // One bullet per submitted item: a multiline criterion is one item, not three.
  const criterionRows = text.split("\n").filter((row) => row.includes("multiline criterion first row") || row.includes("its continuation row"));
  assert.equal(criterionRows.length, 2, "both submitted lines of one criterion are rendered");
  assert.match(criterionRows[0], /^\s*-\s+multiline criterion first row$/, "only the item's first row carries the bullet");
  assert.match(criterionRows[1], /^\s{4,}its continuation row$/, "the continuation row is indented under the same item, not a new bullet");
  // An unprojected recorded field names itself in notation; its value stays hidden.
  assert.ok(text.includes("\\u0007unprojected"), "an unprojected field name is encoded too");
  assert.doesNotMatch(text, /a value this view must not render/, "an unprojected value is never rendered");
  // And neither arm emits a raw terminal control byte.
  assert.ok(!RAW_CONTROL_PATTERN.test(text), "the expanded refused view carries no raw terminal control byte");
  assert.ok(!RAW_CONTROL_PATTERN.test(collapsed), "the collapsed refused card carries no raw terminal control byte");

  // The Shell family's refused view follows the same rule for its job target,
  // including the code points JSON quoting leaves literal.
  const shell = await refusedAndRendered("ShellLog", shellLogRenderer, { id: "job\u001b[2J\u007f\u0085 end", offset: 7 });
  assert.ok(shell.text.includes('"job\\u001b[2J\\u007f\\u0085 end"'), "DEL and a C1 control render as notation inside the exact quoted id");
  assert.ok(!RAW_CONTROL_PATTERN.test(shell.text), "the refused Shell view carries no raw terminal control byte");
  assert.ok(!shell.text.includes("\t"), "the refused Shell view carries no raw TAB");
});

// ---------------------------------------------------------------------------
// The boundary: only a recorded root refusal changes a family's view
// ---------------------------------------------------------------------------

test("an ordinary tool error with no provenance keeps the diagnostic view unchanged", async () => {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(subtaskRenderer, "SubtasksInspect");
  const result = {
    content: [{ type: "text", text: "SubtasksInspect failed: no such task." }],
    details: { action: "inspect", diagnostic: "no such task." },
  };
  const context = blockedContext(
    { reason: "SubtasksInspect failed: no such task.", callId: "call-ordinary-error", args: { executionId: "exec-1", taskId: "task-9" } },
  );
  const text = renderDecorated(decorated, result, context);
  assert.match(text, /diagnostic: no such task\./, "a real diagnostic still renders as before");
  assert.doesNotMatch(text, /not executed/, "no never-ran claim is made without provenance");
  assert.doesNotMatch(text, /Original submitted request/, "no blocked-request view is invented");
});

test("a call the auditor passed keeps its own result view unchanged", async () => {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(subtaskRenderer, "SubtasksSteer");
  const allowed = await pipeline.submit({
    toolName: "SubtasksSteer",
    callId: "call-passed",
    input: { executionId: "exec-1", taskId: "task-1", instructions: "Carry on" },
    auditorReply: { output: '{"decision":"PASS"}' },
  });
  assert.equal(allowed, undefined, "a PASS is not a refusal");
  const result = {
    content: [{ type: "text", text: "Steering delivered." }],
    details: { action: "steer", executionId: "exec-1", taskId: "task-1", delivery: "accepted" },
  };
  const text = renderDecorated(
    decorated,
    result,
    blockedContext({ reason: "Steering delivered.", callId: "call-passed", args: { executionId: "exec-1", taskId: "task-1", instructions: "Carry on" } }, { isError: false, executionStarted: true }),
  );
  assert.doesNotMatch(text, /not executed|Original submitted request/, "a passed call is never shown as refused");
});

test("a nested child's refusal never marks its root call as never executed", async () => {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(subtaskRenderer, "SubtasksStart");
  const child = await pipeline.refuse({
    toolName: "SubtasksSteer",
    callId: "child-of-root",
    parentToolCallId: "root-call",
    input: { executionId: "exec-1", taskId: "task-1", instructions: "Stop" },
    auditorReply: AUDIT_DENIAL,
  });
  assert.ok(child.reason.length > 0, "the nested child's own call is refused");
  // The root ran: its row aggregates the nested refusal, and nothing here may
  // claim the root never executed.
  const rootResult = {
    content: [{ type: "text", text: "Dispatched 1 task." }],
    details: {
      action: "start", executionId: "exec-1", kind: "execute", cwd: "/work/target", revision: 2,
      tasks: [{ taskId: "task-1", state: "running", definition: { title: "Keep working" } }],
    },
  };
  const text = renderDecorated(
    decorated,
    rootResult,
    blockedContext({ reason: "Dispatched 1 task.", callId: "root-call", args: { kind: "execute", tasks: [{ title: "Keep working", instructions: "I", acceptanceCriteria: ["A"] }] } }, { isError: false, executionStarted: true }),
  );
  assert.doesNotMatch(text, /SubtasksStart · not executed/, "the root is never shown as refused");
  assert.ok(text.includes("Keep working"), "the root's own card renders unchanged");
});

test("the provenance predicate is exact about what counts as a root refusal", () => {
  const record = (overrides: Partial<AuditDisplayRecord> = {}): AuditDisplayRecord => ({
    kind: "pass",
    toolName: "SubtasksStart",
    level: "aligned",
    nested: false,
    ...overrides,
  });
  const base: Omit<AuditDisplayData, "records"> = {
    version: TOOL_PROTECTION_DISPLAY_VERSION,
    callId: "c",
    toolName: "SubtasksStart",
    surface: "row" as const,
    nestedTotal: 0,
    refusalTotal: 0,
    nestedWarningCount: 0,
    nestedRefusalWarningCount: 0,
  };
  assert.deepEqual(
    rootRefusalProvenance({ ...base, rootRefusalText: "Tool protection: FAIL — no.", records: [record({ kind: "blocked" })] }),
    { toolName: "SubtasksStart" },
    "a recorded root refusal carries the exact tool name",
  );
  assert.equal(
    rootRefusalProvenance({ ...base, refusalTotal: 1, records: [record({ kind: "blocked", nested: true })] }),
    undefined,
    "a nested child's refusal is not the root's",
  );
  assert.equal(rootRefusalProvenance({ ...base, records: [record({})] }), undefined, "a PASS row is not a refusal");
  assert.equal(
    rootRefusalProvenance({ ...base, records: [record({ kind: "not-audited", recordWarning: "save failed" })] }),
    undefined,
    "a NOT AUDITED row or a save warning is not a refusal",
  );
  assert.equal(rootRefusalProvenance(undefined), undefined, "no provenance at all stays no provenance");
  assert.equal(readToolProtectionRefusal({}), undefined, "a context without the key reads as no provenance");
  assert.equal(readToolProtectionRefusal({ toolProtectionRefusal: { toolName: "  " } }), undefined, "a blank name is never a tool name");
  assert.deepEqual(
    readToolProtectionRefusal({ toolProtectionRefusal: { toolName: "ShellSend" } }),
    { toolName: "ShellSend" },
    "a renderer reads the provenance back unchanged",
  );
});

test("a successful call keeps its dispatch card in both arms (#661 regression)", async () => {
  const pipeline = createBlockedCallPipeline();
  const decorated = pipeline.decorate(subtaskRenderer, "SubtasksStart");
  const result = {
    content: [{ type: "text", text: "Dispatched 1 task." }],
    details: {
      action: "start",
      executionId: "exec-1",
      kind: "execute",
      cwd: "/work/target",
      revision: 1,
      tasks: [{ taskId: "task-1", state: "running", definition: { title: "Keep working" } }],
    },
  };
  const context = blockedContext(
    { reason: "Dispatched 1 task.", callId: "call-success", args: { kind: "execute", tasks: [{ title: "Keep working", instructions: "I", acceptanceCriteria: ["A"] }] } },
    { isError: false, executionStarted: true },
  );
  const expanded = renderDecorated(decorated, result, context);
  const collapsed = renderDecoratedCollapsed(decorated, result, context);
  assert.doesNotMatch(expanded, /not executed/, "a successful call is never shown as refused");
  assert.doesNotMatch(collapsed, /not executed/, "a successful collapsed card is unchanged");
  assert.ok(expanded.includes("exec-1") && expanded.includes("Keep working"), "the successful card still renders its data");
});
