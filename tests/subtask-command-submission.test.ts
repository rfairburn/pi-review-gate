import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

function executionTool(tools: Array<Record<string, any>>, name: string): Record<string, any> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

function harness(options: { slowExecutor?: boolean; researchCapable?: boolean } = {}) {
  const tools: Array<Record<string, any>> = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notices: string[] = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand(name: string, commandOptions: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.push(name);
      commandHandlers.set(name, commandOptions.handler);
    },
    setToolActive() {},
    getActiveTools: () => ["read", "bash", ...executionToolNames],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "fake": {
        adapter: options.researchCapable ? "codex-cli" : "run-as-binary",
        command: process.execPath,
        execution: {
          ...(options.researchCapable ? {} : { protocol: "pi-review-executor-jsonl-v1" as const }),
          args: options.slowExecutor
            ? ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"]
            : undefined,
        },
      },
    },
    execution: {
      deferredPiTools: undefined,
      workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 4 } },
      routes: {
        execute: [{ resourceId: "default" }],
        research: options.researchCapable ? [{ resourceId: "default" }] : [],
      },
    },
    ui: { subtasksViewExpanded: false },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: (message) => { notices.push(message); },
  });
  manager.sync();
  return { tools, commands, commandHandlers, notices, manager, config };
}

interface ScriptedUi {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean | undefined>;
  input: (title: string) => Promise<string | undefined>;
  editor: (title: string, initial?: string) => Promise<string | undefined>;
  notify: (message: string, level: string) => Promise<void>;
}

interface PromptRecord {
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
}

interface Scripted {
  ui: ScriptedUi;
  prompts: PromptRecord[];
  /** All command notifications, keyed by level: result notices are "info",
   * failures from the command wrapper are "error". */
  notifications: Array<{ message: string; level: string }>;
}

/** A scripted command UI: `answers` maps prompt titles to the staged answer
 * (undefined simulates dismissing the prompt); prompts are recorded so tests
 * can assert the exact staged sequence. */
function scriptedUi(answers: Record<string, string | undefined>): Scripted {
  const prompts: PromptRecord[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const answer = (title: string): string | undefined => {
    if (!(title in answers)) throw new Error(`unexpected prompt: ${title}`);
    return answers[title];
  };
  return {
    prompts,
    notifications,
    ui: {
      select: async (title: string, options: string[]) => {
        prompts.push({ kind: "select", title, options });
        return answer(title);
      },
      confirm: async (title: string, message: string) => {
        prompts.push({ kind: "confirm", title, message });
        const staged = answer(title);
        if (staged !== undefined && staged !== "submit" && staged !== "cancel") {
          throw new Error(`confirm answer for "${title}" must be "submit", "cancel", or undefined`);
        }
        return staged === "submit" ? true : staged === "cancel" ? false : undefined;
      },
      input: async (title: string) => {
        prompts.push({ kind: "input", title });
        return answer(title);
      },
      editor: async (title: string) => {
        prompts.push({ kind: "editor", title });
        return answer(title);
      },
      notify: async (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };
}

/** A UI that must never be prompted: plain-text submission requests no input. */
function noPromptUi(): Scripted {
  const prompts: PromptRecord[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const refuse = (kind: string, title: string): never => {
    throw new Error(`plain-text submission must not prompt, but ${kind} was opened: ${title}`);
  };
  return {
    prompts,
    notifications,
    ui: {
      select: async (title: string) => refuse("select", title),
      confirm: async (title: string) => refuse("confirm", title),
      input: async (title: string) => refuse("input", title),
      editor: async (title: string) => refuse("editor", title),
      notify: async (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };
}

async function cleanup(manager: ExecutionToolManager, roots: string[]): Promise<void> {
  await manager.shutdown();
  await manager.detach();
  for (const root of roots) await rm(root, { recursive: true, force: true });
}

/** Extract the single execution handle from the command's formatted result. */
function executionIdOf(message: string | undefined): string {
  const match = message?.match(/exec-[0-9a-f-]+/);
  assert.ok(match, `expected an execution handle in: ${message}`);
  return match[0];
}

function taskIdOf(message: string | undefined, index: number): string {
  const matches = message?.match(/task-[0-9a-f-]+/g) ?? [];
  assert.ok(matches.length > index, `expected task handle ${index} in: ${message}`);
  return matches[index]!;
}

function infoMessages(scripted: Scripted): string[] {
  return scripted.notifications.filter((entry) => entry.level === "info").map((entry) => entry.message);
}

function lastError(scripted: Scripted): { message: string; level: string } | undefined {
  return scripted.notifications.filter((entry) => entry.level === "error").at(-1);
}

const PROMPT = "investigate why the notification appears twice";
const DEFAULT_CRITERION = "The task instructions are completed as written.";

test("plain-text /subtask-add submits exactly one task in one new default execution group without prompting", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  let root: string | undefined;
  try {
    const scripted = noPromptUi();
    await commandHandlers.get("subtask-add")!(`  ${PROMPT}  `, { ui: scripted.ui });
    const [resultNotice] = infoMessages(scripted);
    assert.match(resultNotice ?? "", /execute group exec-/);
    assert.match(resultNotice ?? "", /1 active/);
    const executionId = executionIdOf(resultNotice);
    const taskId = taskIdOf(resultNotice, 0);
    assert.match(resultNotice ?? "", new RegExp(PROMPT.slice(0, 40)));

    // The durable definition carries the prompt as the instructions (only the
    // established surrounding-whitespace command trim applied — the argument
    // was passed with padding on purpose) and defaults for everything else — no invented task requirements.
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const inspection = (await inspect("plain-text-inspect", { executionId, taskId }, undefined, undefined, {})).details;
    assert.equal(inspection.kind, "execute");
    assert.equal(inspection.tasks.length, 1);
    assert.equal(inspection.cwd, process.cwd());
    assert.equal(inspection.tasks[0].definition.title, PROMPT);
    assert.equal(inspection.tasks[0].definition.instructions, PROMPT);
    assert.deepEqual(inspection.tasks[0].definition.acceptanceCriteria, [DEFAULT_CRITERION]);
    assert.equal(inspection.tasks[0].definition.relevantContext, undefined);
    assert.equal(inspection.tasks[0].definition.backgroundKind, "execute");
    // Role routing is the established execute policy, not a research demotion.
    assert.ok(inspection.tasks[0].definition.executorToolCatalog.allowedToolCatalog.includes("bash"));
    assert.equal(lastError(scripted)?.level, undefined);
    root = inspection.root as string;
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the former explicit /subtask-add <executionId> <task-json> syntax is now a plain-text prompt that creates one new group and never modifies the named group", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  const roots: string[] = [];
  try {
    const scripted = noPromptUi();
    // Establish a named group to prove the former explicit syntax cannot
    // reach it.
    await commandHandlers.get("subtask-add")!(PROMPT, { ui: scripted.ui });
    const startNotice = infoMessages(scripted).at(-1);
    const existingId = executionIdOf(startNotice);
    const existingTaskId = taskIdOf(startNotice, 0);
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const before = (await inspect("existing-before", { executionId: existingId, taskId: existingTaskId }, undefined, undefined, {})).details;
    if (before.root) roots.push(before.root as string);
    assert.equal(before.tasks.length, 1);

    const explicitText = `${existingId} [{"title":"Batched follow-up","instructions":"Continue the work","acceptanceCriteria":["Follow-up is complete"]}]`;
    await commandHandlers.get("subtask-add")!(explicitText, { ui: scripted.ui });
    // One NEW group is created; the submission is not an error and the named
    // group is untouched.
    const submissionNotice = infoMessages(scripted).at(-1);
    assert.match(submissionNotice ?? "", /execute group exec-/);
    const newGroupId = executionIdOf(submissionNotice);
    assert.notEqual(newGroupId, existingId);
    const after = (await inspect("existing-after", { executionId: existingId, taskId: existingTaskId }, undefined, undefined, {})).details;
    assert.equal(after.tasks.length, 1);
    assert.equal(after.historicalCount, 1);
    // The full former-syntax text is the raw instructions of exactly one new
    // default task; the derived title is the established 80-column clip of it.
    const added = (await inspect("new-group-inspect", { executionId: newGroupId, taskId: taskIdOf(submissionNotice, 0) }, undefined, undefined, {})).details;
    assert.equal(added.tasks.length, 1);
    assert.equal(added.tasks[0].definition.instructions, explicitText);
    const expectedTitle = explicitText.replace(/\s+/g, " ").trim();
    assert.equal(added.tasks[0].definition.title, expectedTitle.length <= 80 ? expectedTitle : `${expectedTitle.slice(0, 79)}\u2026`);
    assert.deepEqual(added.tasks[0].definition.acceptanceCriteria, [DEFAULT_CRITERION]);
    assert.equal(lastError(scripted)?.level, undefined);
    if (added.root) roots.push(added.root as string);
  } finally {
    await cleanup(manager, roots);
  }
});

test("former malformed explicit subtask-add requests are plain prompts: JSON text becomes instructions with default metadata, never interpreted metadata", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  const roots: string[] = [];
  try {
    const scripted = noPromptUi();
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;

    // A bare JSON task object is raw prompt text: one new group whose task
    // instructions are the literal JSON, with default metadata — NOT an
    // interpretation of the JSON's title/instructions fields and not a
    // rejection.
    const objectJson = '{"title":"example","instructions":"quoted sample"}';
    await commandHandlers.get("subtask-add")!(objectJson, { ui: scripted.ui });
    const objectNotice = infoMessages(scripted).at(-1);
    assert.match(objectNotice ?? "", /execute group exec-/);
    const objectGroup = executionIdOf(objectNotice);
    const objectTask = (await inspect("bare-object", { executionId: objectGroup, taskId: taskIdOf(objectNotice, 0) }, undefined, undefined, {})).details;
    if (objectTask.root) roots.push(objectTask.root as string);
    assert.equal(objectTask.tasks.length, 1);
    assert.equal(objectTask.tasks[0].definition.instructions, objectJson);
    assert.equal(objectTask.tasks[0].definition.title, objectJson);
    assert.deepEqual(objectTask.tasks[0].definition.acceptanceCriteria, [DEFAULT_CRITERION]);

    // A bare JSON task array is equally raw prompt text.
    const arrayJson = '[{"title":"X","instructions":"Y","acceptanceCriteria":["Z"]}]';
    await commandHandlers.get("subtask-add")!(arrayJson, { ui: scripted.ui });
    const arrayNotice = infoMessages(scripted).at(-1);
    assert.match(arrayNotice ?? "", /execute group exec-/);
    const arrayGroup = executionIdOf(arrayNotice);
    assert.notEqual(arrayGroup, objectGroup);
    const arrayTask = (await inspect("bare-array", { executionId: arrayGroup, taskId: taskIdOf(arrayNotice, 0) }, undefined, undefined, {})).details;
    if (arrayTask.root) roots.push(arrayTask.root as string);
    assert.equal(arrayTask.tasks.length, 1);
    assert.equal(arrayTask.tasks[0].definition.instructions, arrayJson);

    // A full-format but unknown execution handle followed by task JSON is
    // likewise a plain prompt: no error, one new group, and no group with
    // that handle exists to be modified.
    const staleText = 'exec-123e4567-e89b-42d3-a456-426614174000 {"title":"X","instructions":"Y","acceptanceCriteria":["Z"]}';
    await commandHandlers.get("subtask-add")!(staleText, { ui: scripted.ui });
    const staleNotice = infoMessages(scripted).at(-1);
    assert.match(staleNotice ?? "", /execute group exec-/);
    const staleGroup = executionIdOf(staleNotice);
    assert.notEqual(staleGroup, "exec-123e4567-e89b-42d3-a456-426614174000");
    const staleTask = (await inspect("stale-handle", { executionId: staleGroup, taskId: taskIdOf(staleNotice, 0) }, undefined, undefined, {})).details;
    assert.equal(staleTask.tasks.length, 1);
    assert.equal(staleTask.tasks[0].definition.instructions, staleText);

    // Every submission created its own new default group; no errors at all.
    assert.equal(lastError(scripted)?.level, undefined);
    assert.equal(new Set(infoMessages(scripted).map((entry) => entry.match(/exec-[0-9a-f-]+/)?.[0])).size, 3);
    if (staleTask.root) roots.push(staleTask.root as string);
  } finally {
    await cleanup(manager, roots);
  }
});

test("ordinary text beginning with exec-, {, or [ forwards as a plain-text prompt", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  const roots: string[] = [];
  try {
    const scripted = noPromptUi();
    const prompts = [
      "exec-related failures need investigation",
      "[frontend] fix the layout",
      "{example} explain this notation",
      "exec-abc123 not json at all",
      'explain this sample {"a":1} from the pasted code',
      'check {"a": [1, 2]} against {"b": 3}',
    ];
    for (const text of prompts) {
      const before = infoMessages(scripted).length;
      await commandHandlers.get("subtask-add")!(text, { ui: scripted.ui });
      const notices = infoMessages(scripted);
      assert.equal(notices.length, before + 1, `expected a submission for: ${text}`);
      assert.match(notices.at(-1) ?? "", /execute group exec-/);
      // The full text is the prompt of the created task, unmodified beyond
      // the established surrounding-whitespace trim.
      const executionId = (notices.at(-1)?.match(/exec-[0-9a-f-]+/) ?? [])[0];
      assert.ok(executionId);
      const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
      const inspection = (await inspect(`prose-${notices.length}`, { executionId, taskId: taskIdOf(notices.at(-1), 0) }, undefined, undefined, {})).details;
      if (inspection.root) roots.push(inspection.root as string);
      assert.equal(inspection.tasks.length, 1);
      assert.equal(inspection.tasks[0].definition.instructions, text);
    }
    assert.equal(lastError(scripted)?.level, undefined);
    assert.equal(new Set(infoMessages(scripted).map((entry) => entry.match(/exec-[0-9a-f-]+/)?.[0])).size, prompts.length);
  } finally {
    await cleanup(manager, roots);
  }
});

test("the no-argument staged form creates a new group with kind and workspace choices", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  let root: string | undefined;
  try {
    const scripted = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Check duplicate notification",
      "Task instructions": "Find why the notification renders twice and report back",
      "Acceptance criteria (one per line)": "root cause identified\nduplicate rendering explained",
      "Relevant context (optional; leave blank to omit)": "",
      "Execution kind": "execute",
      "Target workspace (optional; leave blank to use the current session workspace)": "",
      "Submit staged subtask?": "submit",
    });
    await commandHandlers.get("subtask-add")!("", { ui: scripted.ui });
    // The staged form opened the expected prompts in order, ending with the
    // explicit submission step showing the staged destination, kind, and
    // workspace (blank workspace disclosed as the current session cwd).
    assert.deepEqual(scripted.prompts.map((entry) => entry.title), [
      "Submit a subtask",
      "Task title",
      "Task instructions",
      "Acceptance criteria (one per line)",
      "Relevant context (optional; leave blank to omit)",
      "Execution kind",
      "Target workspace (optional; leave blank to use the current session workspace)",
      "Submit staged subtask?",
    ]);
    assert.deepEqual(scripted.prompts[0]?.options, ["Create a new execution group", "Add to an existing execution group"]);
    const submission = scripted.prompts.at(-1)!;
    assert.equal(submission.kind, "confirm");
    assert.match(submission.message ?? "", /destination: a new execution group/);
    assert.match(submission.message ?? "", /kind: execute/);
    assert.match(submission.message ?? "", new RegExp(`workspace: ${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(submission.message ?? "", /title: Check duplicate notification/);
    assert.match(submission.message ?? "", /instructions: Find why the notification renders twice and report back/);
    assert.match(submission.message ?? "", /acceptance criteria \(2\): root cause identified; duplicate rendering explained/);
    assert.doesNotMatch(submission.message ?? "", /relevant context/);
    assert.equal(lastError(scripted)?.level, undefined);
    const [resultNotice] = infoMessages(scripted);
    assert.match(resultNotice ?? "", /execute group exec-/);
    assert.match(resultNotice ?? "", /1 active/);
    const executionId = executionIdOf(resultNotice);
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const inspection = (await inspect("form-new-inspect", { executionId, taskId: taskIdOf(resultNotice, 0) }, undefined, undefined, {})).details;
    assert.equal(inspection.kind, "execute");
    assert.equal(inspection.cwd, process.cwd());
    assert.equal(inspection.tasks.length, 1);
    assert.equal(inspection.tasks[0].definition.title, "Check duplicate notification");
    assert.equal(inspection.tasks[0].definition.instructions, "Find why the notification renders twice and report back");
    assert.deepEqual(inspection.tasks[0].definition.acceptanceCriteria, ["root cause identified", "duplicate rendering explained"]);
    assert.equal(inspection.tasks[0].definition.relevantContext, undefined);
    root = inspection.root as string;
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the staged form can submit research with an explicit target workspace", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true, researchCapable: true });
  let root: string | undefined;
  try {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "prg-form-workspace-")));
    const scripted = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Survey recovery docs",
      "Task instructions": "Read the recovery documentation and report the flow",
      "Acceptance criteria (one per line)": "report returned",
      "Relevant context (optional; leave blank to omit)": "recovery semantics changed recently",
      "Execution kind": "research",
      "Target workspace (optional; leave blank to use the current session workspace)": scratch,
      "Submit staged subtask?": "submit",
    });
    await commandHandlers.get("subtask-add")!("", { ui: scripted.ui });
    assert.equal(lastError(scripted)?.level, undefined);
    const [resultNotice] = infoMessages(scripted);
    assert.match(resultNotice ?? "", /research group exec-/);
    const executionId = executionIdOf(resultNotice);
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const inspection = (await inspect("form-research-inspect", { executionId, taskId: taskIdOf(resultNotice, 0) }, undefined, undefined, {})).details;
    assert.equal(inspection.kind, "research");
    assert.equal(inspection.cwd, scratch);
    assert.equal(inspection.tasks[0].definition.backgroundKind, "research");
    assert.equal(inspection.tasks[0].definition.relevantContext, "recovery semantics changed recently");
    const catalog = inspection.tasks[0].definition.executorToolCatalog;
    assert.equal(catalog.allowedToolCatalog.includes("bash"), false, "research routing stays read-only");
    assert.equal(catalog.allowedToolCatalog.includes("write"), false, "research routing stays read-only");
    root = inspection.root as string;
    await rm(scratch, { recursive: true, force: true });
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the staged form adds to an existing group and inherits its immutable kind and workspace", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true, researchCapable: true });
  let root: string | undefined;
  try {
    // Start a research group targeting an explicit workspace through the
    // established model-facing path, then add to it through the form.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "prg-form-existing-")));
    const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
    const started = await start("form-existing-start", {
      kind: "research",
      workspace: scratch,
      tasks: [{ title: "Existing research", instructions: "stay active", acceptanceCriteria: ["eventually report"] }],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    root = started.details.root as string;

    const scripted = scriptedUi({});
    const textAnswers: Record<string, string | undefined> = {
      "Task title": "Added research task",
      "Task instructions": "Read another area and report",
      "Acceptance criteria (one per line)": "second report returned",
      "Relevant context (optional; leave blank to omit)": "",
    };
    let offeredLabels: string[] | undefined;
    let confirmMessage: string | undefined;
    scripted.ui.select = async (title: string, options: string[]) => {
      scripted.prompts.push({ kind: "select", title, options });
      if (title === "Submit a subtask") return "Add to an existing execution group";
      if (title === "Existing execution group") {
        offeredLabels = options;
        return options.find((label) => label.startsWith(executionId));
      }
      throw new Error(`unexpected prompt: ${title}`);
    };
    scripted.ui.confirm = async (title: string, message: string) => {
      scripted.prompts.push({ kind: "confirm", title, message });
      confirmMessage = message;
      return true;
    };
    scripted.ui.editor = async (title: string) => {
      scripted.prompts.push({ kind: "editor", title });
      if (!(title in textAnswers)) throw new Error(`unexpected prompt: ${title}`);
      return textAnswers[title];
    };
    await commandHandlers.get("subtask-add")!("", { ui: scripted.ui });
    assert.equal(lastError(scripted)?.level, undefined);
    // Destination first, then the group picker (before task fields), then the
    // staged task fields, then the explicit submission step.
    assert.deepEqual(scripted.prompts.map((entry) => entry.title), [
      "Submit a subtask",
      "Existing execution group",
      "Task title",
      "Task instructions",
      "Acceptance criteria (one per line)",
      "Relevant context (optional; leave blank to omit)",
      "Submit staged subtask?",
    ]);
    // The staged summary discloses the inherited destination, kind, and
    // target workspace of the existing group.
    assert.match(confirmMessage ?? "", new RegExp(`destination: existing execution group ${executionId}`));
    assert.match(confirmMessage ?? "", /kind: research/);
    assert.match(confirmMessage ?? "", new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(confirmMessage ?? "", /title: Added research task/);
    // The offered label discloses the group's kind and target workspace.
    assert.ok(offeredLabels, "the existing-group picker offered labels");
    assert.equal(offeredLabels.length, 1);
    assert.match(offeredLabels[0]!, new RegExp(executionId));
    assert.match(offeredLabels[0]!, /research/);
    assert.match(offeredLabels[0]!, new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const [resultNotice] = infoMessages(scripted);
    assert.match(resultNotice ?? "", new RegExp(executionId));
    const inspection = (await inspect("form-existing-inspect", { executionId, taskId: taskIdOf(resultNotice, 1) }, undefined, undefined, {})).details;
    // The added task was admitted to the existing group (the add result lists
    // both tasks) and inherits its kind and target, never retargeted.
    assert.equal(inspection.tasks.length, 1);
    assert.equal(inspection.cwd, scratch);
    assert.equal(inspection.tasks[0].definition.title, "Added research task");
    assert.equal(inspection.tasks[0].definition.backgroundKind, "research");
    assert.equal(inspection.tasks[0].definition.executorToolCatalog.allowedToolCatalog.includes("bash"), false);
    await rm(scratch, { recursive: true, force: true });
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the staged form cancels without creating a task or a group at any stage", async () => {
  const { commandHandlers, manager } = harness({ slowExecutor: true });
  try {
    // Cancel at the destination picker.
    const destination = scriptedUi({ "Submit a subtask": undefined });
    await commandHandlers.get("subtask-add")!("", { ui: destination.ui });
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(destination.notifications.length, 0);

    // Cancel mid-form after staging some fields.
    const midForm = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Staged title",
      "Task instructions": undefined,
    });
    await commandHandlers.get("subtask-add")!("", { ui: midForm.ui });
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(midForm.notifications.length, 0);

    // Cancel on the kind picker after staging all task fields.
    const kindCancel = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Staged title",
      "Task instructions": "Staged instructions",
      "Acceptance criteria (one per line)": "criterion",
      "Relevant context (optional; leave blank to omit)": "",
      "Execution kind": undefined,
    });
    await commandHandlers.get("subtask-add")!("", { ui: kindCancel.ui });
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(kindCancel.notifications.length, 0);

    // Cancel at the explicit final submission step after staging ALL fields
    // and settings (new-group destination): neither a task nor a group.
    const submitCancel = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Staged title",
      "Task instructions": "Staged instructions",
      "Acceptance criteria (one per line)": "criterion",
      "Relevant context (optional; leave blank to omit)": "",
      "Execution kind": "research",
      "Target workspace (optional; leave blank to use the current session workspace)": "",
      "Submit staged subtask?": "cancel",
    });
    await commandHandlers.get("subtask-add")!("", { ui: submitCancel.ui });
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(submitCancel.notifications.length, 0);

    // Dismissing the final confirmation (undefined) cancels identically.
    const submitDismiss = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Staged title",
      "Task instructions": "Staged instructions",
      "Acceptance criteria (one per line)": "criterion",
      "Relevant context (optional; leave blank to omit)": "",
      "Execution kind": "execute",
      "Target workspace (optional; leave blank to use the current session workspace)": "",
      "Submit staged subtask?": undefined,
    });
    await commandHandlers.get("subtask-add")!("", { ui: submitDismiss.ui });
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(submitDismiss.notifications.length, 0);
  } finally {
    await cleanup(manager, []);
  }
});

test("the staged existing-group destination cancels at the final submission step after all fields", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true, researchCapable: true });
  let root: string | undefined;
  try {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "prg-form-cancel-")));
    const start = executionTool(tools, "SubtasksStart").execute as ExecuteTool;
    const started = await start("form-cancel-start", {
      kind: "research",
      workspace: scratch,
      tasks: [{ title: "Existing research", instructions: "stay active", acceptanceCriteria: ["eventually report"] }],
    }, undefined, undefined, {});
    const executionId = started.details.executionId as string;
    root = started.details.root as string;
    const startedTaskId = (started.details.tasks as Array<Record<string, unknown>>)[0]!.taskId as string;
    const inspect = executionTool(tools, "SubtasksInspect").execute as ExecuteTool;
    const beforeCount = ((await inspect("form-cancel-before", { executionId, taskId: startedTaskId }, undefined, undefined, {})).details.tasks as unknown[]).length;

    // Cancel at the explicit final submission step after staging every task
    // field: the existing group gains no task.
    const scripted = scriptedUi({});
    scripted.ui.select = async (title: string, options: string[]) => {
      scripted.prompts.push({ kind: "select", title, options });
      if (title === "Submit a subtask") return "Add to an existing execution group";
      if (title === "Existing execution group") return options.find((label) => label.startsWith(executionId));
      throw new Error(`unexpected prompt: ${title}`);
    };
    scripted.ui.confirm = async (title: string, message: string) => {
      scripted.prompts.push({ kind: "confirm", title, message });
      return false;
    };
    scripted.ui.editor = async (title: string) => {
      scripted.prompts.push({ kind: "editor", title });
      return ({
        "Task title": "Cancelled addition",
        "Task instructions": "Never dispatched",
        "Acceptance criteria (one per line)": "would have been criterion",
        "Relevant context (optional; leave blank to omit)": "",
      })[title];
    };
    await commandHandlers.get("subtask-add")!("", { ui: scripted.ui });
    assert.equal(lastError(scripted)?.level, undefined);
    assert.equal(scripted.prompts.at(-1)?.title, "Submit staged subtask?");
    const inspection = (await inspect("form-cancel-after", { executionId, taskId: startedTaskId }, undefined, undefined, {})).details;
    assert.equal(inspection.tasks.length, beforeCount);
    assert.equal(infoMessages(scripted).length, 0);
    await rm(scratch, { recursive: true, force: true });
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the staged form fails closed when the host has no confirmation dialog", async () => {
  const { tools, commandHandlers, manager } = harness({ slowExecutor: true });
  let root: string | undefined;
  try {
    // A UI without confirm: after all fields are staged the form fails closed
    // with guidance and nothing is submitted.
    const scripted = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Staged title",
      "Task instructions": "Staged instructions",
      "Acceptance criteria (one per line)": "criterion",
      "Relevant context (optional; leave blank to omit)": "",
      "Execution kind": "execute",
      "Target workspace (optional; leave blank to use the current session workspace)": "",
    });
    (scripted.ui as unknown as { confirm?: unknown }).confirm = undefined;
    await commandHandlers.get("subtask-add")!("", { ui: scripted.ui });
    assert.equal(lastError(scripted)?.level, "error");
    assert.match(lastError(scripted)?.message ?? "", /interactive confirmation is unavailable; nothing was submitted/);
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(infoMessages(scripted).length, 0);
  } finally {
    await cleanup(manager, root ? [root] : []);
  }
});

test("the staged form validates required fields before submitting anything", async () => {
  const { commandHandlers, manager } = harness({ slowExecutor: true });
  try {
    const blankInstructions = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Incomplete submission",
      "Task instructions": "   ",
    });
    await commandHandlers.get("subtask-add")!("", { ui: blankInstructions.ui });
    assert.equal(lastError(blankInstructions)?.level, "error");
    assert.match(lastError(blankInstructions)?.message ?? "", /instructions are required; nothing was submitted/);
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(infoMessages(blankInstructions).length, 0);

    const emptyCriteria = scriptedUi({
      "Submit a subtask": "Create a new execution group",
      "Task title": "Incomplete submission",
      "Task instructions": "Instructions present",
      "Acceptance criteria (one per line)": "\n \n",
    });
    await commandHandlers.get("subtask-add")!("", { ui: emptyCriteria.ui });
    assert.equal(lastError(emptyCriteria)?.level, "error");
    assert.match(lastError(emptyCriteria)?.message ?? "", /at least one acceptance criterion is required; nothing was submitted/);
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(infoMessages(emptyCriteria).length, 0);
  } finally {
    await cleanup(manager, []);
  }
});

test("the staged form and its fallbacks fail with actionable guidance", async () => {
  const { commandHandlers, manager } = harness();
  try {
    // No destination groups exist yet: choosing the existing-group destination
    // fails closed with the established diagnostic before collecting fields.
    const noGroups = scriptedUi({ "Submit a subtask": "Add to an existing execution group" });
    await commandHandlers.get("subtask-add")!("", { ui: noGroups.ui });
    assert.equal(lastError(noGroups)?.level, "error");
    assert.match(lastError(noGroups)?.message ?? "", /no execution groups are available/);
    assert.deepEqual(manager.reviewReadiness(), []);
    assert.equal(infoMessages(noGroups).length, 0);

    // Without interactive UI the command explains the available modes.
    await commandHandlers.get("subtask-add")!("", {});
    assert.deepEqual(manager.reviewReadiness(), []);
  } finally {
    await cleanup(manager, []);
  }
});