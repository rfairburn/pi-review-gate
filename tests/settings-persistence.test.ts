import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_BROWSER_PERMISSIONS,
  normalizeConfig,
  type ScheduledTaskCatalog,
  type WorkerResourceCatalog,
} from "../src/config";
import { persistReviewSettings, persistSubtasksViewPreference, updateReviewGateConfig, type ReviewSettingsSelection } from "../src/settings/persistence";

const selection: ReviewSettingsSelection = {
operatingMode: "orchestrate",
modeCycleShortcut: "alt+m",
workerResources: {},
primaryReviewers: [],
subtaskReviewers: [],
primaryEnabled: true,
subtaskEnabled: true,
reviewLandedChanges: false,
reviewerTimeoutMs: 600_000,
executorTimeoutMs: 1_800_000,
maxCorrectionCycles: 3,
implementationGuidanceAfterCorrectionAttempts: 1,
retainBundles: "on-failure",
maxWorkers: 2,
retryPolicy: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
    jitter: true,
    maxSameIncidentRepeats: 2,
  },
subtaskNotifications: "quiet",
deferredPiTools: true,
subtasksViewExpanded: false,
};

test("browser approval persistence round-trips every mode and preserves unrelated Web settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-browser-approval-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ web: { enabled: false, future: "keep", fetch: { timeoutMs: 12345 } } }));
    for (const browserInteractionApproval of ["ask", "automatically-accept", "automatically-deny"] as const) {
      const normalized = await persistReviewSettings(configPath, { ...selection, browserInteractionApproval });
      assert.equal(normalized.web!.browserInteractionApproval, browserInteractionApproval);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(saved.web, { enabled: false, future: "keep", fetch: { timeoutMs: 12345 }, browserInteractionApproval });
      const unchanged = await persistReviewSettings(configPath, { ...selection, webMaxDownloadBytes: 1024 });
      assert.equal(unchanged.web!.browserInteractionApproval, browserInteractionApproval);
      await updateReviewGateConfig(configPath, (config) => { (config.web as any).fetch = { timeoutMs: 12345 }; });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser permissions persist as a complete object and survive unrelated saves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-browser-permissions-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ web: { enabled: false, future: "keep", browserPermissions: { modelUploads: true } } }));
    const normalized = await persistReviewSettings(configPath, {
      ...selection,
      webBrowserPermissions: { ...DEFAULT_BROWSER_PERMISSIONS, modelCredentialEntry: true, yolo: true },
    });
    assert.equal(normalized.web!.browserPermissions.yolo, true);
    assert.equal(normalized.web!.browserPermissions.modelCredentialEntry, true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.web.browserPermissions, { ...DEFAULT_BROWSER_PERMISSIONS, modelCredentialEntry: true, yolo: true });
    assert.equal(saved.web.future, "keep");

    // A save that omits the permissions object preserves the stored values.
    const unchanged = await persistReviewSettings(configPath, selection);
    assert.deepEqual(unchanged.web!.browserPermissions, { ...DEFAULT_BROWSER_PERMISSIONS, modelCredentialEntry: true, yolo: true });

    // YOLO off with preserved individual values round-trips too.
    const restored = await persistReviewSettings(configPath, {
      ...selection,
      webBrowserPermissions: { ...DEFAULT_BROWSER_PERMISSIONS, modelUploads: true },
    });
    assert.equal(restored.web!.browserPermissions.yolo, false);
    assert.equal(restored.web!.browserPermissions.modelUploads, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid browser permission values reject the save before any write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-browser-permissions-invalid-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ web: { browserPermissions: { modelUploads: true } } }));
    const before = await readFile(configPath, "utf8");
    await assert.rejects(
      persistReviewSettings(configPath, {
        ...selection,
        webBrowserPermissions: { ...DEFAULT_BROWSER_PERMISSIONS, yolo: "yes" } as never,
      }),
      /web.browserPermissions.yolo must be a boolean/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle expiry persists safely and omitted or invalid updates preserve existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-idle-expiry-"));
  const configPath = join(dir, "config.json");
  try {
    const web = { enabled: false, future: { keep: true }, browserInteractionApproval: "automatically-deny", search: { maxResults: 7 }, fetch: { timeoutMs: 12345 } };
    await writeFile(configPath, JSON.stringify({ futureRoot: true, web }));
    const normalized = await persistReviewSettings(configPath, { ...selection, browserIdleExpiryMinutes: 42 });
    assert.equal(normalized.web!.browserIdleExpiryMinutes, 42);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.futureRoot, true);
    assert.deepEqual(saved.web, { ...web, browserIdleExpiryMinutes: 42 });
    assert.equal((await persistReviewSettings(configPath, selection)).web!.browserIdleExpiryMinutes, 42);
    const disabled = await persistReviewSettings(configPath, { ...selection, browserIdleExpiryMinutes: 0 });
    assert.equal(disabled.web!.browserIdleExpiryMinutes, 0);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).web.browserIdleExpiryMinutes, 0);
    const before = await readFile(configPath, "utf8");
    for (const minutes of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(persistReviewSettings(configPath, { ...selection, browserIdleExpiryMinutes: minutes }), /web.browserIdleExpiryMinutes/);
      assert.equal(await readFile(configPath, "utf8"), before);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download retention persists safely and omitted or invalid updates preserve existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-download-retention-"));
  const configPath = join(dir, "config.json");
  try {
    const web = { enabled: false, future: { keep: true }, browserIdleExpiryMinutes: 0, fetch: { timeoutMs: 12345 } };
    await writeFile(configPath, JSON.stringify({ futureRoot: true, web }));
    const normalized = await persistReviewSettings(configPath, { ...selection, browserDownloadRetention: 3 });
    assert.equal(normalized.web!.browserDownloadRetention, 3);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.futureRoot, true);
    assert.deepEqual(saved.web, { ...web, browserDownloadRetention: 3 });
    // A save that omits the retention preserves the stored value.
    assert.equal((await persistReviewSettings(configPath, selection)).web!.browserDownloadRetention, 3);
    // 0 (unlimited) round-trips.
    const unlimited = await persistReviewSettings(configPath, { ...selection, browserDownloadRetention: 0 });
    assert.equal(unlimited.web!.browserDownloadRetention, 0);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).web.browserDownloadRetention, 0);
    // Invalid values reject the save before any write.
    const before = await readFile(configPath, "utf8");
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(persistReviewSettings(configPath, { ...selection, browserDownloadRetention: value }), /web.browserDownloadRetention/);
      assert.equal(await readFile(configPath, "utf8"), before);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mode cycle hotkey persists without replacing unrelated settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-persist-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true,"operatingMode":"plan-research","customFutureKey":{"keep":true}}\n', "utf8");
    await persistReviewSettings(configPath, { ...selection, operatingMode: "plan-research", modeCycleShortcut: "ctrl+shift+r" });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.operatingMode, "plan-research");
    assert.equal(saved.modeCycleShortcut, "ctrl+shift+r");
    assert.deepEqual(saved.customFutureKey, { keep: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistReviewSettings preserves restrictive configuration permissions", async (t) => {
  if (process.platform === "win32") t.skip("POSIX modes are required");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-mode-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    await chmod(configPath, 0o600);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const firstSaved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(firstSaved.enabled, true);
    assert.equal(firstSaved.execution.deferredPiTools, true);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
    await chmod(configPath, 0o644);
    await persistReviewSettings(configPath, selection);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subtasks view preference persists globally without replacing unrelated settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-subtasks-view-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true,"customFutureKey":{"keep":true}}\n', "utf8");
    const expanded = await persistSubtasksViewPreference(configPath, true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.ui.subtasksViewExpanded, true);
    assert.deepEqual(saved.customFutureKey, { keep: true });
    assert.equal(expanded.ui?.subtasksViewExpanded, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("global config updates serialize without losing unrelated concurrent changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-config-update-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    await Promise.all([
      updateReviewGateConfig(configPath, (config) => { config.firstUpdate = true; }),
      updateReviewGateConfig(configPath, (config) => { config.secondUpdate = true; }),
    ]);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.firstUpdate, true);
    assert.equal(saved.secondUpdate, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-catalog preference save persists keyed catalogs in normalized canonical form", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-keyed-save-"));
  const configPath = join(dir, "config.json");
  const keyed = JSON.stringify({
    enabled: true,
    customFutureKey: { keep: true },
    externalAgents: { one: { adapter: "generic-cli", command: "node", review: {} } },
    execution: {
      workerResources: { primary: { selection: { source: "external", id: "one" }, maxConcurrent: 2 } },
      routes: { execute: [{ resourceId: "primary", thinkingLevel: "high" }] },
    },
  });
  await writeFile(configPath, keyed);
  try {
    // Loading (parsing + normalizing) never rewrites the file.
    const loaded = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    assert.equal(await readFile(configPath, "utf8"), keyed);

    const normalized = await persistSubtasksViewPreference(configPath, true);
    assert.equal(normalized.ui?.subtasksViewExpanded, true);
    assert.deepEqual(normalized.externalAgents, loaded.externalAgents);
    assert.deepEqual(normalized.execution?.workerResources, loaded.execution?.workerResources);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.externalAgents, {
      one: { adapter: "generic-cli", command: "node", args: [], review: { args: [] } },
    });
    assert.deepEqual(saved.execution.workerResources, {
      primary: { selection: { source: "external", id: "one" }, maxConcurrent: 2 },
    });
    assert.deepEqual(saved.execution.routes, { execute: [{ resourceId: "primary", thinkingLevel: "high" }] });
    // Unrelated raw fields and the new preference both survive.
    assert.deepEqual(saved.customFutureKey, { keep: true });
    assert.equal(saved.ui.subtasksViewExpanded, true);
    assert.deepEqual(normalizeConfig(saved), normalized);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a disabled scheduled research entry saves with a removed worker pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-research-off-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    const disabledResearch: ScheduledTaskCatalog = {
      "task-research-off": {
        name: "Disabled research",
        cron: "0 9 * * *",
        enabled: false,
        kind: "research",
        instructions: "Summarize the release notes",
        workspace: dir,
        workerResourceId: "removed-worker",
      },
    };
    const saved = await persistReviewSettings(configPath, { ...selection, scheduledTasks: disabledResearch });
    assert.deepEqual(saved.scheduledTasks, disabledResearch);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(persisted.scheduledTasks, disabledResearch);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enabled scheduled research entries still refuse missing or incapable worker pins without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-research-enabled-"));
  const configPath = join(dir, "config.json");
  const workerResources: WorkerResourceCatalog = {
    "binary-worker": { selection: { source: "external", id: "binary-only" }, maxConcurrent: 1 },
  };
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      externalAgents: {
        "binary-only": {
          adapter: "run-as-binary",
          command: "runner",
          execution: { protocol: "pi-review-executor-jsonl-v1" },
        },
      },
      execution: { workerResources },
    }));
    const before = await readFile(configPath, "utf8");
    const research: ScheduledTaskCatalog[string] = {
      name: "Enabled research",
      cron: "0 9 * * *",
      enabled: true,
      kind: "research",
      instructions: "Summarize the release notes",
      workspace: dir,
      workerResourceId: "removed-worker",
    };
    await assert.rejects(
      persistReviewSettings(configPath, { ...selection, scheduledTasks: { task: research } }),
      /scheduledTasks\.task references unknown worker resource removed-worker/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);

    const { enabled: _enabled, ...withoutEnabled } = research;
    await assert.rejects(
      persistReviewSettings(configPath, { ...selection, scheduledTasks: { task: withoutEnabled as ScheduledTaskCatalog[string] } }),
      /scheduledTasks\.task references unknown worker resource removed-worker/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);

    await assert.rejects(
      persistReviewSettings(configPath, {
        ...selection,
        workerResources,
        scheduledTasks: { task: { ...research, workerResourceId: "binary-worker" } },
      }),
      /scheduledTasks\.task worker resource is not research-capable: binary-worker/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a disabled scheduled entry still refuses an invalid selected external reviewer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-reviewer-off-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, '{"enabled":true}\n', "utf8");
    const before = await readFile(configPath, "utf8");
    await assert.rejects(
      persistReviewSettings(configPath, {
        ...selection,
        scheduledTasks: {
          "task-review-off": {
            name: "Disabled reviewed research",
            cron: "0 9 * * *",
            enabled: false,
            kind: "research",
            instructions: "Summarize the release notes",
            workspace: dir,
            workerResourceId: "removed-worker",
            review: { mode: "selected", reviewers: [{ source: "external", id: "missing-reviewer" }] },
          },
        },
      }),
      /A selected external reviewer no longer supports review on disk/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings saves preserve the latest on-disk external agent definitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-agents-latest-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      review: { activeReviewers: [] },
      externalAgents: {
        one: { adapter: "generic-cli", command: "node", args: ["original"], review: {} },
      },
    }));
    await persistReviewSettings(configPath, selection);
    // An external edit lands on disk after the in-memory config was loaded.
    await updateReviewGateConfig(configPath, (parsed) => {
      ((parsed.externalAgents as Record<string, { args: string[] }>)["one"]).args = ["updated"];
    });
    const normalized = await persistReviewSettings(configPath, selection);
    assert.deepEqual(normalized.externalAgents!.one.args, ["updated"]);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // The stale in-memory snapshot never clobbers the newer disk definition.
    assert.deepEqual(saved.externalAgents.one.args, ["updated"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("staged external definitions merge with latest keyed catalog and preserve role overrides and adapters", async () => {
  const dir = await mkdtemp(join(__dirname, "external-merge-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      futureRoot: { keep: true },
      externalAgents: {
        old: { adapter: "codex-cli", model: "unknown-existing-model", review: { model: "review-override", args: ["review"], env: { PRIVATE_SETTING: "keep" } }, execution: { model: "execution-override" } },
        generic: { adapter: "generic-cli", command: "custom-tool", review: {} },
        binary: { adapter: "run-as-binary", command: "custom-binary", execution: { protocol: "pi-review-executor-jsonl-v1" } },
      },
      execution: { futureExecution: true },
      review: { futureReview: true },
    }));
    // A different settings instance appends an entry after this menu opened.
    await updateReviewGateConfig(configPath, (raw) => {
      (raw.externalAgents as Record<string, unknown>).concurrent = { adapter: "claude-cli", model: "future-model", review: {} };
    });
    const existing = normalizeConfig(JSON.parse(await readFile(configPath, "utf8"))).externalAgents!;
    const next = await persistReviewSettings(configPath, {
      ...selection,
      externalAgentAdditions: { created: { adapter: "claude-cli", model: "new-model", review: {}, execution: {} } },
      workerResources: { "external-created": { selection: { source: "external", id: "created" }, maxConcurrent: 1 } },
      executeRoute: [{ resourceId: "external-created" }],
      researchRoute: [{ resourceId: "external-created" }],
      primaryReviewers: [{ source: "external", id: "created" }],
      subtaskReviewers: [{ source: "external", id: "created" }],
    });
    for (const [id, definition] of Object.entries(existing)) assert.deepEqual(next.externalAgents![id], definition);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.futureRoot, { keep: true });
    assert.equal(saved.execution.futureExecution, true);
    assert.equal(saved.review.futureReview, true);
    assert.deepEqual(normalizeConfig(saved), next);
    assert.equal(saved.externalAgents.generic.adapter, "generic-cli");
    assert.equal(saved.externalAgents.binary.adapter, "run-as-binary");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("same-ID staged additions reject without overwriting, including identical definitions", async () => {
  const dir = await mkdtemp(join(__dirname, "external-collision-"));
  const configPath = join(dir, "config.json");
  try {
    const definition = { adapter: "codex-cli" as const, review: {}, env: { PRIVATE_SETTING: "do-not-print" } };
    await writeFile(configPath, JSON.stringify({ externalAgents: { concurrent: definition }, futureRoot: true }));
    const before = await readFile(configPath, "utf8");
    for (const addition of [definition, { adapter: "claude-cli" as const, execution: {} }]) {
      await assert.rejects(persistReviewSettings(configPath, { ...selection, externalAgentAdditions: { concurrent: addition } }), (error: Error) => {
        assert.match(error.message, /already exists on disk.*different ID/);
        assert.equal(error.message.includes("do-not-print"), false);
        return true;
      });
      assert.equal(await readFile(configPath, "utf8"), before);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("external addition merges are prototype-safe and final validation rejects invalid references before writing", async () => {
  const dir = await mkdtemp(join(__dirname, "external-validation-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, "{}");
    const additions = JSON.parse('{"__proto__":{"adapter":"codex-cli","review":{},"execution":{}}}');
    const next = await persistReviewSettings(configPath, { ...selection, externalAgentAdditions: additions });
    assert.equal(Object.hasOwn(next.externalAgents!, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(next.externalAgents!), Object.prototype);
    const before = await readFile(configPath, "utf8");
    await assert.rejects(persistReviewSettings(configPath, {
      ...selection,
      externalAgentAdditions: { new: { adapter: "claude-cli", execution: {} } },
      executeRoute: [{ resourceId: "missing" }],
    }));
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(persistReviewSettings(configPath, {
      ...selection,
      externalAgentAdditions: { new: { adapter: "claude-cli", execution: {} } },
      primaryReviewers: [{ source: "external", id: "missing" }],
    }), /no longer supports review/);
    assert.equal(await readFile(configPath, "utf8"), before);
    // Latest disk role changes also fail closed, instead of validating only
    // against the catalog visible when the settings transaction opened.
    await assert.rejects(persistReviewSettings(configPath, {
      ...selection,
      externalAgentAdditions: { executionOnly: { adapter: "claude-cli", execution: {} } },
      subtaskReviewers: [{ source: "external", id: "executionOnly" }],
    }), /no longer supports review/);
    assert.equal(await readFile(configPath, "utf8"), before);
    await assert.rejects(persistReviewSettings(configPath, {
      ...selection, externalAgentAdditions: { invalid: { adapter: "not-an-adapter" } as never },
    }));
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const catalog of ["externalAgents", "workerResources", "both"] as const) test(`a save over a legacy array ${catalog} catalog rejects without converting or writing`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-legacy-reject-"));
  const configPath = join(dir, "config.json");
  const keyedAgents = { one: { adapter: "generic-cli", command: "node", review: {} } };
  const keyedResources = { primary: { selection: { source: "external", id: "one" }, maxConcurrent: 2 } };
  const legacy = JSON.stringify({
    enabled: true,
    customFutureKey: { keep: true },
    externalAgents: catalog === "workerResources" ? keyedAgents : [{ id: "one", adapter: "generic-cli", command: "node", review: {} }],
    execution: {
      workerResources: catalog === "externalAgents"
        ? keyedResources
        : [{ resourceId: "primary", selection: { source: "external", id: "one" }, maxConcurrent: 2 }],
    },
  });
  await writeFile(configPath, legacy);
  try {
    const expected = catalog === "workerResources" ? /execution\.workerResources must be an object/ : /externalAgents must be an object/;
    await assert.rejects(persistSubtasksViewPreference(configPath, true), expected);
    assert.equal(await readFile(configPath, "utf8"), legacy);
    // Staged agent additions also validate the latest keyed catalog rather
    // than importing a legacy array.
    if (catalog !== "workerResources") {
      await assert.rejects(persistReviewSettings(configPath, {
        ...selection,
        externalAgentAdditions: { created: { adapter: "claude-cli", review: {} } },
      }), /externalAgents must be an object/);
      assert.equal(await readFile(configPath, "utf8"), legacy);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
