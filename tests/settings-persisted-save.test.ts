/**
 * Issue #716: the shared non-UI disk-only Review-settings Save boundary.
 *
 * The sidebar/local disk editor and the live /review-settings menu share one
 * staged selection. These tests pin the extracted boundary that a second host
 * must be able to reuse:
 *
 * - `preparePersistedSave` performs workspace expansion, save-time validation,
 *   the unservable-pin disable rule, and the managed-image transaction without
 *   a UI, returning typed failures instead of notices.
 * - `commitPersistedSave` performs the strict on-disk merge, the atomic write,
 *   and the existing rollback/conflict policy without a UI.
 * - The persisted-only Save backend seam is called BEFORE any requester-local
 *   preparation: submitting a staged draft for another host performs no local
 *   path probe, managed image copy, directory check, or config read/write, and
 *   root Escape/Cancel never enter the backend at all.
 *
 * Local behavior itself stays covered by tests/settings-persisted-transaction
 * and the session-only suites; this file adds the extraction and the seam.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  effectiveReviewSettings,
  normalizeConfig,
  type ReviewGateConfig,
} from "../src/config";
import { runPersistedReviewSettings } from "../src/settings/command";
import {
  commitPersistedSave,
  localPersistedSaveBackend,
  preparePersistedSave,
  type PersistedSaveBackend,
  type PersistedSavePreparationInput,
  type PersistedSaveSelection,
  type PreparedPersistedSave,
  type StagedPersistedSave,
} from "../src/settings/persisted-save";
import {
  ConfigWriteNotAuthorizedError,
  persistReviewSettings,
  updateReviewGateConfig,
} from "../src/settings/persistence";
import type { SettingTextEditRequest } from "../src/settings/text-input";
import { stagedToolProtectionSettings } from "../src/settings/tool-protection";
import type { UiContext } from "../src/settings/ui";

/** A genuine minimal PNG (content sniffing only needs the signature). */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-review-persisted-save-"));
}

/** The canonical staged selection these helpers commit, over one config. */
function selectionFor(config: ReviewGateConfig, scheduledTasks = config.scheduledTasks ?? {}): PersistedSaveSelection {
  const review = effectiveReviewSettings(config);
  return {
    operatingMode: config.operatingMode,
    modeCycleShortcut: config.modeCycleShortcut,
    workerResources: {},
    executeRoute: [],
    researchRoute: [],
    primaryReviewers: review.primaryReviewers,
    subtaskReviewers: review.subtaskReviewers,
    primaryEnabled: review.primaryEnabled,
    subtaskEnabled: review.subtaskEnabled,
    primaryClaudeCodeEnabled: review.primaryClaudeCodeEnabled,
    primaryCodexEnabled: review.primaryCodexEnabled,
    reviewLandedChanges: review.reviewLandedChanges,
    reviewerTimeoutMs: config.reviewerTimeoutMs,
    executorTimeoutMs: config.executorTimeoutMs,
    maxCorrectionCycles: config.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: config.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: config.retainBundles,
    maxWorkers: config.execution?.maxWorkers ?? 4,
    retryPolicy: { ...(config.execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) },
    subtaskNotifications: config.execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE,
    deferredPiTools: true,
    subtasksViewExpanded: config.ui?.subtasksViewExpanded === true,
    scheduledTasks,
    toolProtection: stagedToolProtectionSettings(config),
  };
}

/** The non-UI staged input for one preparation, over a caller-owned config. */
function stagingInput(
  config: ReviewGateConfig,
  selection: PersistedSaveSelection,
  overrides: Partial<PersistedSavePreparationInput> = {},
): PersistedSavePreparationInput {
  return {
    configPath: "/nonexistent/review-gate.json",
    config,
    draftConfig: config,
    scoped: [],
    selection,
    scheduledImageProvenance: new Map(),
    ...overrides,
  };
}

test("owner-local preparation and commit need no UI: expansion, unservable disable, strict merge", async () => {
  const dir = await tempDir();
  try {
    const configPath = join(dir, "review-gate.json");
    const original = JSON.stringify({
      enabled: true,
      unrelatedFutureField: { keep: true },
      execution: {
        workerResources: {
          "pi-1": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 2 },
        },
      },
    }, null, 2);
    await writeFile(configPath, original, "utf8");
    const baseline = normalizeConfig(JSON.parse(original));
    const draft = normalizeConfig({ enabled: true });
    const staged = {
      task: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute" as const,
        instructions: "Run the check",
        workspace: "~",
        workerResourceId: "pi-1",
      },
    };

    // Preparation alone: no UI, no write, and the editable draft still holds
    // the caller's catalog until the caller takes the returned expansion.
    const stagedSelection = selectionFor(baseline, staged);
    const preparation = await preparePersistedSave(stagingInput(baseline, stagedSelection, {
      configPath,
      cwd: dir,
      draftConfig: draft,
    }));
    assert.deepEqual(stagedSelection.scheduledTasks, staged, "preparation never mutates the staged selection");
    assert.equal(preparation.kind, "prepared");
    assert.equal(await readFile(configPath, "utf8"), original, "preparation writes nothing");
    const prepared = preparation as PreparedPersistedSave;
    assert.equal(prepared.scheduledTasks.task!.workspace, homedir(), "the editable draft takes the expanded spelling");
    assert.equal(prepared.catalogForApply.task!.workspace, homedir());
    assert.equal(prepared.catalogForApply.task!.enabled, false, "a pin its own resource removal unserves is disabled");
    assert.equal(prepared.catalogForApply.task!.workerResourceId, "pi-1", "the pin is kept, never silently replaced");
    assert.equal(prepared.scheduleDisableWarnings.length, 1);
    assert.match(prepared.scheduleDisableWarnings[0]!, /Scheduled task "Nightly" was disabled/);
    // The structured form names exactly the entry the shared rule disabled, so
    // a non-UI caller can report it without the user-facing text.
    assert.deepEqual(prepared.scheduleDisableTaskIds, ["task"]);

    // Commit alone: the strict merge over the latest disk config, preserving
    // unknown keys and persisting the staged catalog. No UI seam participates.
    const commit = await commitPersistedSave({
      configPath,
      selection: selectionFor(baseline, prepared.catalogForApply),
    });
    assert.equal(commit.kind, "saved");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(written.unrelatedFutureField, { keep: true }, "unknown fields survive");
    assert.equal(written.scheduledTasks.task.enabled, false);
    assert.equal(written.scheduledTasks.task.workspace, homedir());
    assert.equal(written.scheduledTasks.task.workerResourceId, "pi-1");
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "no managed image store is created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preparation returns the shared validation failure and copies no staged image", async () => {
  const dir = await tempDir();
  const imagePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await writeFile(imagePath, PNG_BYTES);
  try {
    const config = normalizeConfig({ enabled: true });
    const selection: PersistedSaveSelection = {
      ...selectionFor(config, {
        task: {
          name: "Nightly",
          cron: "0 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: `Run the check ${imagePath}`,
          workspace: "~",
        },
      }),
      // The duplicate reviewer fails the shared validation before the image
      // transaction runs, exactly as the menu's Save always did.
      primaryReviewers: [
        { source: "pi", model: "openai/gpt-5" },
        { source: "pi", model: "openai/gpt-5" },
      ],
    };
    const preparation = await preparePersistedSave(stagingInput(config, selection, {
      configPath: join(dir, "review-gate.json"),
      scheduledImageProvenance: new Map([["task", [imagePath]]]),
    }));
    assert.equal(preparation.kind, "invalid");
    assert.equal(preparation.error, "Duplicate enabled reviewer: pi:openai/gpt-5");
    // The expanded spelling is still returned for the editable draft, even on
    // a validation failure (the menu's existing retry behavior).
    assert.equal(preparation.scheduledTasks.task!.workspace, homedir());
    assert.deepEqual(await readdir(dir), [], "nothing was copied or written");
    assert.deepEqual(await readFile(imagePath), PNG_BYTES, "the pasted source is untouched");
  } finally {
    await rm(imagePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("the local backend commits the prepared catalog, never the staged one: a pasted image persists as its managed copy", async () => {
  // A space in the fixture directory proves the full managed path survives
  // the instruction prefix extraction below.
  const dir = await mkdtemp(join(tmpdir(), "pi-review persisted-save-"));
  const imagePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await writeFile(imagePath, PNG_BYTES);
  try {
    const configPath = join(dir, "review-gate.json");
    const config = normalizeConfig({ enabled: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    const rawInstructions = `Run the check ${imagePath}`;
    // The caller stages the RAW catalog: a home-relative workspace and the
    // temporary pasted path. The backend must persist the PREPARED catalog.
    const stagedSelection = selectionFor(config, {
      task: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: rawInstructions,
        workspace: "~",
      },
    });
    const result = await localPersistedSaveBackend.saveStaged({
      configPath,
      cwd: dir,
      config,
      draftConfig: config,
      scoped: [],
      selection: stagedSelection,
      scheduledImageProvenance: new Map([["task", [imagePath]]]),
    });
    assert.equal(result.kind, "saved");
    assert.equal(
      stagedSelection.scheduledTasks.task!.instructions,
      rawInstructions,
      "the caller's staged selection is never mutated",
    );
    const written = JSON.parse(await readFile(configPath, "utf8"));
    const savedInstructions = written.scheduledTasks.task.instructions as string;
    assert.ok(!savedInstructions.includes(imagePath), "the temporary path is never persisted");
    const prefix = "Run the check ";
    assert.ok(savedInstructions.startsWith(prefix));
    const managedPath = savedInstructions.slice(prefix.length);
    assert.equal(dirname(managedPath), join(dir, "scheduled-image-assets", "task"), "the managed store path is persisted");
    assert.deepEqual(await readFile(managedPath), PNG_BYTES, "the managed copy carries the exact image bytes");
    assert.equal(written.scheduledTasks.task.workspace, homedir(), "the persisted workspace is the expanded spelling");
    // The editable result keeps the staged temp path so a later retry stages
    // from the same draft, exactly as the menu's own Save did.
    assert.equal(result.kind === "saved" && result.scheduledTasks.task!.instructions, rawInstructions);
  } finally {
    await rm(imagePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("commit keeps the existing rollback and external-worker conflict policy", async () => {
  const dir = await tempDir();
  try {
    const configPath = join(dir, "review-gate.json");
    // The empty catalog makes the rollback-unless-persisted read decisive: a
    // readable config that references no managed copy keeps none of them.
    const original = JSON.stringify({ enabled: true, scheduledTasks: {} }, null, 2);
    await writeFile(configPath, original, "utf8");
    const config = normalizeConfig({ enabled: true });
    const copy = async (name: string): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, PNG_BYTES);
      return path;
    };
    const preparedWith = (createdFile: string) => ({
      catalog: {},
      createdFiles: [createdFile],
      createdDirs: [],
    });

    // A rejected caller step reclaims this Save's prepared copies and rethrows
    // when the staged payload has no external-worker changes.
    const first = await copy("first.png");
    await assert.rejects(
      commitPersistedSave({
        configPath,
        selection: selectionFor(config),
        prepared: preparedWith(first),
        beforePersist: () => { throw new Error("initializer failed"); },
      }),
      /initializer failed/,
    );
    await assert.rejects(stat(first), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), original);

    // A rejected strict merge reclaims the copies too (the config never came
    // to reference them) and rethrows unchanged.
    const second = await copy("second.png");
    await assert.rejects(
      commitPersistedSave({
        configPath,
        selection: {
          ...selectionFor(config),
          scheduledTasks: {
            bad: { name: "Bad", cron: "nope", enabled: true, kind: "execute", instructions: "x", workspace: dir },
          },
        },
        prepared: preparedWith(second),
      }),
      /scheduledTasks\.bad\.cron/,
    );
    await assert.rejects(stat(second), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), original);

    // The existing external-worker policy: a caller-step rejection with staged
    // worker changes keeps the menu open with the exact notice text.
    const third = await copy("third.png");
    const conflict = await commitPersistedSave({
      configPath,
      selection: { ...selectionFor(config), externalAgentOperations: [{ id: "agent" }] },
      prepared: preparedWith(third),
      beforePersist: () => { throw new Error("initializer failed"); },
    });
    assert.deepEqual(conflict, {
      kind: "conflict",
      error: "Cannot save external worker changes: initializer failed",
    });
    await assert.rejects(stat(third), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), original);

    // The same policy on a rejected strict merge (external-worker changes),
    // not only on the caller step.
    const fourth = await copy("fourth.png");
    const mergeConflict = await commitPersistedSave({
      configPath,
      selection: {
        ...selectionFor(config),
        externalAgentOperations: [{ id: "agent" }],
        scheduledTasks: {
          bad: { name: "Bad", cron: "nope", enabled: true, kind: "execute", instructions: "x", workspace: dir },
        },
      },
      prepared: preparedWith(fourth),
    });
    assert.equal(mergeConflict.kind, "conflict");
    assert.match(mergeConflict.kind === "conflict" ? mergeConflict.error : "", /^Cannot save external worker changes: .*scheduledTasks\.bad\.cron/);
    await assert.rejects(stat(fourth), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The persisted-only Save backend seam
// ---------------------------------------------------------------------------

type Step = string | undefined | { ctrlS: true };

interface ScriptedUi {
  ui: UiContext;
  notices: Array<{ message: string; kind: string }>;
  textRequests: SettingTextEditRequest[];
}

/** One scripted menu run; `edits` supplies host text-field results in order. */
function scriptedUi(steps: Step[], edits: Array<{ value: string | undefined; inserts?: string[] }> = []): ScriptedUi {
  const notices: Array<{ message: string; kind: string }> = [];
  const textRequests: SettingTextEditRequest[] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (_title, options) => {
      assert.ok(index < steps.length, `unexpected extra selection: ${options.join(" | ")}`);
      const step = steps[index++];
      if (step === undefined) return undefined;
      if (typeof step === "object") {
        assert.ok(ui.saveControl, "the settings transaction attaches a save control");
        ui.saveControl.saveRequested = true;
        return undefined;
      }
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step));
      assert.ok(match !== undefined, `missing selection ${step}: ${options.join(" | ")}`);
      return match;
    },
    editText: async (request) => {
      textRequests.push(request);
      const edit = edits.shift();
      assert.ok(edit, "unexpected text field");
      for (const insert of edit.inserts ?? []) request.options.onHostInsert?.(insert);
      return edit.value;
    },
    confirm: async () => false,
    notify: (message, kind) => { notices.push({ message, kind: kind ?? "info" }); },
  };
  return { ui, notices, textRequests };
}

test("a custom backend receives the staged draft before any requester-local preparation or write", async () => {
  const dir = await tempDir();
  const imagePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await writeFile(imagePath, PNG_BYTES);
  try {
    const config = normalizeConfig({
      enabled: true,
      youShouldKnow: { enabled: true, completionGuidance: true },
      scheduledTasks: {
        task: {
          name: "Nightly",
          cron: "0 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Run the check",
          workspace: "~",
        },
      },
    });
    const configPath = join(dir, "review-gate.json");
    const seen: StagedPersistedSave[] = [];
    const backend: PersistedSaveBackend = {
      async saveStaged(request) {
        seen.push(request);
        return {
          kind: "saved",
          config,
          scheduledTasks: request.selection.scheduledTasks,
          warnings: [],
          scheduleDisableWarnings: [],
          scheduleDisableTaskIds: [],
          toolProtectionWarnings: [],
        };
      },
    };

    // Save: the user edits the scheduled instructions through the host field
    // and its observation-only insert seam.
    const first = scriptedUi(
      ["Scheduled tasks", "1. ", "Instructions", "Back", "Back", "Save changes"],
      [{ value: `Run the check ${imagePath}`, inserts: [imagePath] }],
    );
    let beforePersistCalls = 0;
    const outcome = await runPersistedReviewSettings({
      config,
      configPath,
      ui: first.ui,
      scoped: [],
      backend,
      beforePersist: () => { beforePersistCalls += 1; },
    });
    assert.equal(outcome.kind, "saved");
    assert.equal(seen.length, 1, "Save reaches the backend once");
    const request = seen[0]!;
    assert.equal(request.config, config, "the staged base is the caller's loaded config");
    assert.equal(typeof request.beforePersist, "function", "the owner-local step travels with the payload");
    assert.equal(beforePersistCalls, 0, "the requester never runs the owner-local step itself");
    assert.equal(request.selection.scheduledTasks.task!.workspace, "~", "no requester-local workspace expansion ran");
    assert.ok(
      request.selection.scheduledTasks.task!.instructions.includes(imagePath),
      "no requester-local image copy ran; the staged temp path is unsubstituted",
    );
    assert.deepEqual([...(request.scheduledImageProvenance.get("task") ?? [])], [imagePath]);
    assert.deepEqual(await readdir(dir), [], "no local config, managed image store, or directory was created");
    assert.deepEqual(await readFile(imagePath), PNG_BYTES, "the requester's pasted source is untouched");
    // The staged selection is plain data, captured before preparation.
    assert.ok(request.selection.scheduledTasks.task!.instructions.includes(imagePath));
    assert.equal(first.textRequests.length, 1);
    assert.ok(!first.notices.some((notice) => notice.kind === "error"));
    assert.ok(first.notices.some((notice) => /saved to disk/.test(notice.message)));

    // Ctrl+S shares that one Save path through the same backend seam.
    const second = scriptedUi(["Tools", "YouShouldKnow notices", { ctrlS: true }]);
    await runPersistedReviewSettings({ config, configPath, ui: second.ui, scoped: [], backend });
    assert.equal(seen.length, 2, "Ctrl+S reaches the same backend entry point");
    assert.equal(second.ui.saveControl?.saveRequested, false, "the latch is consumed");
    const secondRequest = seen[1]!;
    assert.equal(secondRequest.selection.youShouldKnow?.enabled, false, "the staged toggle is in the payload");
    assert.deepEqual(await readdir(dir), [], "still no requester-local IO");

    // Root Escape and Cancel never enter the backend at all.
    for (const steps of [[undefined], ["Cancel"]] as Step[][]) {
      const discard = scriptedUi(steps);
      assert.deepEqual(
        await runPersistedReviewSettings({ config, configPath, ui: discard.ui, scoped: [], backend }),
        { kind: "discarded" },
      );
      assert.equal(seen.length, 2, "discard runs no validation, preparation, or persistence");
    }
  } finally {
    await rm(imagePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The optional destination-publication guard (issue #716)
//
// The standard local sidebar and every existing writer pass no guard, so their
// behavior is unchanged (pinned by the tests above). A destination that accepts
// the staged payload from an editor whose eligibility can be withdrawn supplies
// `stillAuthorized: () => boolean`; it is a synchronous, fresh recheck, never a
// lease. These tests pin each checkpoint and that a late refusal can never
// publish staged settings.
// ---------------------------------------------------------------------------

test("a queued destination refusal reads and writes nothing, even when the target is absent", async () => {
  const dir = await tempDir();
  try {
    // A missing target proves the refusal happens BEFORE the config read:
    // reading first would fail with ENOENT instead of the typed refusal.
    const missing = join(dir, "review-gate.json");
    let calls = 0;
    await assert.rejects(
      persistReviewSettings(missing, selectionFor(normalizeConfig({ enabled: true })), {
        stillAuthorized: () => { calls += 1; return false; },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigWriteNotAuthorizedError, "a false guard result is the typed refusal");
        assert.equal(error.name, "ConfigWriteNotAuthorizedError");
        return true;
      },
    );
    assert.equal(calls, 1, "the guard is read once, after the queue wait and before the read");
    assert.deepEqual(await readdir(dir), [], "no config, staged temp, or managed-image store was created");

    // A guard fault at the same checkpoint fails closed and keeps the fault as
    // the refusal cause instead of escaping as an ordinary write failure.
    const configPath = join(dir, "queued.json");
    const original = JSON.stringify({ enabled: true }, null, 2);
    await writeFile(configPath, original, "utf8");
    const fault = new Error("destination binding retired while queued");
    await assert.rejects(
      persistReviewSettings(configPath, selectionFor(normalizeConfig({ enabled: true })), {
        stillAuthorized: () => { throw fault; },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigWriteNotAuthorizedError);
        assert.equal((error as Error).cause, fault, "the guard fault is retained as the refusal cause");
        return true;
      },
    );
    assert.equal(await readFile(configPath, "utf8"), original, "a queued refusal publishes nothing");
    assert.deepEqual(await readdir(dir), ["queued.json"], "no staged temp is left behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued update re-reads the guard only after earlier writes to the same config finish", async () => {
  const dir = await tempDir();
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({ enabled: true }, null, 2), "utf8");
    const first = updateReviewGateConfig(configPath, (parsed) => { parsed.first = "committed"; });
    let calls = 0;
    let firstCommittedWhenGuardRan: boolean | undefined;
    const second = updateReviewGateConfig(configPath, (parsed) => { parsed.second = "must-not-publish"; }, {
      stillAuthorized: () => {
        calls += 1;
        firstCommittedWhenGuardRan = (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>).first === "committed";
        return false;
      },
    });
    await first;
    await assert.rejects(second, (error: unknown) => error instanceof ConfigWriteNotAuthorizedError);
    assert.equal(calls, 1, "the guard runs once, after the earlier write settled");
    assert.equal(firstCommittedWhenGuardRan, true, "the earlier queued write had already published when the guard ran");
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(written.first, "committed", "the earlier queued write still completes");
    assert.equal(Object.hasOwn(written, "second"), false, "the refused update performs no part of its write");
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "the refused update leaves no temp file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a destination refusal with the temp file already staged removes it and never publishes", async () => {
  const dir = await tempDir();
  try {
    const configPath = join(dir, "review-gate.json");
    const original = JSON.stringify({ enabled: true, marker: "prior" }, null, 2);
    await writeFile(configPath, original, "utf8");
    const config = normalizeConfig(JSON.parse(original) as Record<string, unknown>);

    // Checkpoint 1 is the per-config queue wait; checkpoint 2 is immediately
    // before the publishing rename, with this invocation's own temp already
    // staged. Returning true then false refuses only the late checkpoint.
    const falseSnapshots: string[][] = [];
    let calls = 0;
    await assert.rejects(
      persistReviewSettings(configPath, selectionFor(config), {
        stillAuthorized: () => {
          calls += 1;
          falseSnapshots.push(readdirSync(dir));
          return calls < 2;
        },
      }),
      (error: unknown) => error instanceof ConfigWriteNotAuthorizedError,
    );
    assert.equal(calls, 2, "the guard is re-read at the publication boundary");
    assert.ok(
      falseSnapshots[1]!.some((name) => name.startsWith(".review-gate.json.") && name.endsWith(".tmp")),
      "the publication check runs after the owned temp was staged and before the rename",
    );
    assert.equal(await readFile(configPath, "utf8"), original, "prior committed bytes stay byte-identical");
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "the owned staged temp is removed on refusal");

    // A throw at the same late checkpoint also refuses and retains its cause.
    let throwCalls = 0;
    const throwSnapshots: string[][] = [];
    const fault = new Error("remote opt-in disabled before rename");
    await assert.rejects(
      persistReviewSettings(configPath, selectionFor(config), {
        stillAuthorized: () => {
          throwCalls += 1;
          throwSnapshots.push(readdirSync(dir));
          if (throwCalls === 2) throw fault;
          return true;
        },
      }),
      (error: unknown) => error instanceof ConfigWriteNotAuthorizedError && (error as Error).cause === fault,
    );
    assert.equal(throwCalls, 2, "the throwing guard is also re-read at the publication boundary");
    assert.ok(
      throwSnapshots[1]!.some((name) => name.startsWith(".review-gate.json.") && name.endsWith(".tmp")),
      "the throwing publication check also runs with the owned temp staged",
    );
    assert.equal(await readFile(configPath, "utf8"), original, "the throwing refusal publishes nothing");
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "the owned staged temp is removed on the throw");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preparation refuses before it writes any managed image copy", async () => {
  const dir = await tempDir();
  const imagePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await writeFile(imagePath, PNG_BYTES);
  try {
    const config = normalizeConfig({ enabled: true });
    const selection = selectionFor(config, {
      task: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: `Run the check ${imagePath}`,
        workspace: "~",
      },
    });
    await assert.rejects(
      preparePersistedSave(stagingInput(config, selection, {
        configPath: join(dir, "review-gate.json"),
        scheduledImageProvenance: new Map([["task", [imagePath]]]),
        stillAuthorized: () => false,
      })),
      (error: unknown) => error instanceof ConfigWriteNotAuthorizedError,
      "a refused destination is a typed refusal, never an invalid staged draft",
    );
    assert.deepEqual(await readdir(dir), [], "no managed store or directory was prepared");
    assert.deepEqual(await readFile(imagePath), PNG_BYTES, "the pasted source is untouched");
  } finally {
    await rm(imagePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("an already-refused destination performs no workspace expansion or directory probe", async () => {
  const dir = await tempDir();
  try {
    const config = normalizeConfig({ enabled: true });
    // A home-relative workspace that genuinely does not exist: without the
    // early check, expansion would spell out the destination's home path and
    // scheduled validation would stat it, returning an invalid-draft result
    // that names the expanded path.
    const missingName = `.pi-review-guard-missing-${randomUUID()}`;
    const missingWorkspace = join(homedir(), missingName);
    await assert.rejects(stat(missingWorkspace), { code: "ENOENT" }, "the fixture workspace must genuinely not exist");
    const selection = selectionFor(config, {
      task: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run the check",
        workspace: `~/${missingName}`,
      },
    });
    let calls = 0;
    const outcome = await preparePersistedSave(stagingInput(config, selection, {
      configPath: join(dir, "review-gate.json"),
      cwd: dir,
      stillAuthorized: () => { calls += 1; return false; },
    })).then(() => undefined, (error: unknown) => error);
    assert.ok(
      outcome instanceof ConfigWriteNotAuthorizedError,
      "a refused destination is the typed refusal, never an invalid workspace-validation result",
    );
    assert.equal(calls, 1, "the guard refuses before validation can probe anything");
    assert.deepEqual(await readdir(dir), [], "no config, temp, or managed-image store is created");

    // Revocation across the reviewer-validation awaits: the entry guard and
    // the first reviewer check pass, the destination is withdrawn while those
    // awaits yield, and the scheduled-workspace probe must then be refused
    // rather than stat the missing directory and return an invalid draft.
    let authorized = true;
    let rechecks = 0;
    const revoked = await preparePersistedSave(stagingInput(config, selection, {
      configPath: join(dir, "review-gate.json"),
      cwd: dir,
      stillAuthorized: () => {
        rechecks += 1;
        if (rechecks === 1) queueMicrotask(() => { authorized = false; });
        return authorized;
      },
    })).then(() => undefined, (error: unknown) => error);
    assert.ok(
      revoked instanceof ConfigWriteNotAuthorizedError,
      "revocation across the reviewer-validation awaits refuses before the workspace probe",
    );
    assert.equal(rechecks, 2, "the pre-scheduled-validation guard is the recheck that refuses");
    assert.deepEqual(await readdir(dir), [], "the in-flight revocation still writes nothing");

    // Revocation while the first of two workspace probes is pending: the
    // second entry's probe must not start. `first` points at the existing
    // fixture directory; `task` still names the missing home-relative path.
    authorized = true;
    rechecks = 0;
    const betweenProbes = selectionFor(config, {
      first: { ...selection.scheduledTasks.task!, workspace: dir },
      ...selection.scheduledTasks,
    });
    const lateProbe = await preparePersistedSave(stagingInput(config, betweenProbes, {
      configPath: join(dir, "review-gate.json"),
      cwd: dir,
      stillAuthorized: () => {
        rechecks += 1;
        if (rechecks === 2) queueMicrotask(() => { authorized = false; });
        return authorized;
      },
    })).then(() => undefined, (error: unknown) => error);
    assert.ok(
      lateProbe instanceof ConfigWriteNotAuthorizedError,
      "revocation during the first probe refuses before the second missing workspace is probed",
    );
    assert.equal(rechecks, 3, "the guard rechecks before each entry's workspace probe and refuses the second");
    assert.deepEqual(await readdir(dir), [], "no destination writes for the refused catalog");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the local backend's late refusal rolls back the managed image copies it prepared and publishes nothing", async () => {
  const dir = await tempDir();
  const imagePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await writeFile(imagePath, PNG_BYTES);
  try {
    const configPath = join(dir, "review-gate.json");
    const original = JSON.stringify({ enabled: true, scheduledTasks: {} }, null, 2);
    await writeFile(configPath, original, "utf8");
    const config = normalizeConfig(JSON.parse(original) as Record<string, unknown>);
    const stagedSelection = selectionFor(config, {
      task: {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: `Run the check ${imagePath}`,
        workspace: "~",
      },
    });
    // Six checkpoints in the owner-local Save: before workspace expansion,
    // before scheduled workspace probes, before the managed-image transaction,
    // before the owner initializer hook, after the per-config queue wait, and
    // immediately before the rename. Refuse only the last.
    const checkpoints: string[][] = [];
    let calls = 0;
    const refusal = await localPersistedSaveBackend.saveStaged({
      configPath,
      cwd: dir,
      config,
      draftConfig: config,
      scoped: [],
      selection: stagedSelection,
      scheduledImageProvenance: new Map([["task", [imagePath]]]),
      stillAuthorized: () => {
        calls += 1;
        checkpoints.push(readdirSync(dir));
        return calls < 6;
      },
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(refusal instanceof ConfigWriteNotAuthorizedError, "the late refusal rejects as the typed refusal");
    assert.equal(calls, 6, "all six destination checkpoints ran and the publication boundary refused");
    assert.deepEqual(checkpoints[0], ["review-gate.json"], "the earliest checkpoint runs before any destination-side path work");
    assert.deepEqual(checkpoints[1], ["review-gate.json"], "the pre-probe checkpoint runs before any workspace directory is stat");
    assert.ok(
      !checkpoints[2]!.includes("scheduled-image-assets"),
      "the pre-image checkpoint runs before the managed-image transaction prepares anything",
    );
    assert.ok(
      checkpoints[3]!.includes("scheduled-image-assets"),
      "the initializer checkpoint runs after the managed-image transaction",
    );
    assert.ok(
      checkpoints[5]!.some((name) => name.startsWith(".review-gate.json.") && name.endsWith(".tmp")),
      "the final checkpoint runs after the temp was staged and before the rename",
    );
    assert.equal(await readFile(configPath, "utf8"), original, "no staged settings were published");
    assert.deepEqual(
      await readdir(dir),
      ["review-gate.json"],
      "the prepared managed copies and their private directory were rolled back",
    );
    assert.deepEqual(await readFile(imagePath), PNG_BYTES, "the pasted source is untouched");
  } finally {
    await rm(imagePath, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refusal before the owner initializer never runs it and is not reported as an external-worker conflict", async () => {
  const dir = await tempDir();
  try {
    const configPath = join(dir, "review-gate.json");
    const original = JSON.stringify({ enabled: true }, null, 2);
    await writeFile(configPath, original, "utf8");
    const config = normalizeConfig({ enabled: true });
    const preparedWith = async (name: string) => {
      const path = join(dir, name);
      await writeFile(path, PNG_BYTES);
      return { catalog: {}, createdFiles: [path], createdDirs: [] };
    };

    // External-worker changes would normally convert every failure into a
    // menu-preserving conflict; a destination refusal must stay distinct.
    const firstAsset = await preparedWith("first-prepared.png");
    let hookCalls = 0;
    await assert.rejects(
      commitPersistedSave({
        configPath,
        selection: { ...selectionFor(config), externalAgentOperations: [{ id: "agent" }] },
        prepared: firstAsset,
        beforePersist: () => { hookCalls += 1; },
        stillAuthorized: () => false,
      }),
      (error: unknown) => error instanceof ConfigWriteNotAuthorizedError,
    );
    assert.equal(hookCalls, 0, "the owner initializer never runs for a refused destination");
    await assert.rejects(stat(firstAsset.createdFiles[0]!), { code: "ENOENT" }, "the prepared copy is rolled back");
    assert.equal(await readFile(configPath, "utf8"), original);

    // A throwing guard at the same checkpoint is refused too, with its cause.
    const secondAsset = await preparedWith("second-prepared.png");
    const fault = new Error("destination connection revoked before initializer");
    await assert.rejects(
      commitPersistedSave({
        configPath,
        selection: selectionFor(config),
        prepared: secondAsset,
        beforePersist: () => { hookCalls += 1; },
        stillAuthorized: () => { throw fault; },
      }),
      (error: unknown) => error instanceof ConfigWriteNotAuthorizedError && (error as Error).cause === fault,
    );
    assert.equal(hookCalls, 0, "a throwing guard also skips the owner initializer");
    await assert.rejects(stat(secondAsset.createdFiles[0]!), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "refusals leave no staged temp or store");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
