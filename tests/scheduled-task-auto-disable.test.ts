import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConfig,
  type ScheduledTaskCatalog,
  type ScheduledTaskEntryConfig,
  type WorkerResourceCatalog,
} from "../src/config";
import { disableUnservableScheduledTasks } from "../src/settings/scheduled-tasks";

// #465 auto-disable: a settings change that unserves an enabled entry's worker
// pin disables exactly that entry in the Save candidate. These are local
// owner-side unit cases: no scheduler runtime, workspace access, or network.

function task(name: string, workerResourceId: string, overrides: Partial<ScheduledTaskEntryConfig> = {}): ScheduledTaskEntryConfig {
  return {
    name,
    cron: "0 2 * * *",
    enabled: true,
    kind: "execute",
    instructions: "Run the check",
    workspace: "/tmp/prg-scheduled-task",
    workerResourceId,
    ...overrides,
  };
}

function resources(ids: string[]): WorkerResourceCatalog {
  // Distinct selections: the config rejects two resources sharing one selection.
  return Object.fromEntries(ids.map((id) => [id, { selection: { source: "pi" as const, model: `openai/gpt-5-${id}` }, maxConcurrent: 2 }]));
}

function configWith(ids: string[]) {
  return normalizeConfig({ execution: { workerResources: resources(ids) } });
}

function draftOf(config: ReturnType<typeof configWith>): WorkerResourceCatalog {
  return config.execution?.workerResources ?? {};
}

test("auto-disable returns the caller's own catalog when no entry is affected", () => {
  const live = configWith(["pi-a"]);
  const draft = configWith(["pi-a"]);
  const staged: ScheduledTaskCatalog = { task: task("Nightly", "pi-a") };
  const result = disableUnservableScheduledTasks(staged, draftOf(draft), draft, live);
  assert.equal(result.catalog, staged, "an untouched pass copies nothing and keeps identity");
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.disabledTaskIds, []);
});

test("ordinary auto-disable disables one entry without mutating the staged catalog or entry", () => {
  const live = configWith(["pi-a"]);
  const draft = configWith([]);
  const staged: ScheduledTaskCatalog = { task: task("Nightly", "pi-a") };
  const snapshot = structuredClone(staged);
  const result = disableUnservableScheduledTasks(staged, draftOf(draft), draft, live);

  assert.notEqual(result.catalog, staged, "the result is a copy, never the caller's object");
  assert.equal(result.catalog.task!.enabled, false);
  assert.equal(result.catalog.task!.workerResourceId, "pi-a", "the pin is kept, never silently replaced");
  assert.equal(staged.task!.enabled, true, "the staged entry is never mutated");
  assert.deepEqual(staged, snapshot, "the supplied catalog is entirely untouched");
  assert.notEqual(result.catalog.task, staged.task, "the disabled entry is a new object");
  assert.equal(result.catalog.task!.name, "Nightly");
  assert.deepEqual(result.disabledTaskIds, ["task"]);
  assert.deepEqual(result.warnings, [
    'Scheduled task "Nightly" was disabled: its worker resource pi-a no longer exists. It will not run until you choose an available worker and enable it again.',
  ]);
});

test("multi-entry auto-disable keeps catalog order, receipt order, and untouched entry identity", () => {
  const live = configWith(["pi-a", "pi-b"]);
  const draft = configWith(["pi-b"]);
  const staged: ScheduledTaskCatalog = {
    first: task("First", "pi-a"),
    second: task("Second", "pi-b"),
    third: task("Third", "pi-a", { kind: "inplace" }),
    fourth: task("Fourth", "pi-a", { enabled: false }),
    fifth: task("Fifth", "pi-a", { destination: "orchestrator-turn" }),
  };
  const snapshot = structuredClone(staged);
  const result = disableUnservableScheduledTasks(staged, draftOf(draft), draft, live);

  assert.deepEqual(result.disabledTaskIds, ["first", "third"], "receipt ids follow catalog order");
  assert.deepEqual(result.warnings, [
    'Scheduled task "First" was disabled: its worker resource pi-a no longer exists. It will not run until you choose an available worker and enable it again.',
    'Scheduled task "Third" was disabled: its worker resource pi-a no longer exists. It will not run until you choose an available worker and enable it again.',
  ]);
  assert.deepEqual(Object.keys(result.catalog), ["first", "second", "third", "fourth", "fifth"], "order is preserved");
  assert.equal(result.catalog.first!.enabled, false);
  assert.equal(result.catalog.third!.enabled, false);
  assert.equal(result.catalog.second, staged.second, "an unaffected entry stays reference-identical");
  assert.equal(result.catalog.fourth, staged.fourth, "an already-disabled entry is not re-copied");
  assert.equal(result.catalog.fifth, staged.fifth, "an orchestrator-turn entry is not pinned and stays untouched");
  assert.deepEqual(staged, snapshot, "the supplied catalog and its entries are never mutated");
});

test("auto-disable keeps a prototype-named id as an own data property", () => {
  const live = configWith(["pi-a"]);
  const draft = configWith([]);
  // JSON.parse creates "__proto__" as an own data property, exactly as a
  // hand-edited config file loads; a plain assignment would hit the setter.
  const staged = JSON.parse([
    '{"__proto__":{"name":"Proto","cron":"0 2 * * *","enabled":true,"kind":"execute",',
    '"instructions":"Run the check","workspace":"/tmp/prg-scheduled-task","workerResourceId":"pi-a"}}',
  ].join("")) as ScheduledTaskCatalog;
  assert.deepEqual(Object.keys(staged), ["__proto__"]);
  const result = disableUnservableScheduledTasks(staged, draftOf(draft), draft, live);

  assert.equal(Object.getPrototypeOf(result.catalog), Object.prototype, "the prototype is never polluted");
  assert.deepEqual(Object.keys(result.catalog), ["__proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(result.catalog, "__proto__")?.value.enabled, false);
  assert.equal(Object.getOwnPropertyDescriptor(staged, "__proto__")?.value.enabled, true);
  assert.deepEqual(result.disabledTaskIds, ["__proto__"]);
});
