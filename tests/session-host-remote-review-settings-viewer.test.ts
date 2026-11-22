/**
 * Issue #716: the REQUESTER adapter for remote Review settings.
 *
 * These focused tests pin the behavior the local menu must keep while its Save
 * belongs to another host:
 *
 * - only the shared local menu runs, over the owner's decoded editable opening
 *   and the owner's own model/tool catalogs (including Pi thinking metadata);
 * - Cancel sends nothing, and Save emits exactly the closed
 *   `{ openingId, intent }` envelope with no private worker bytes, local path,
 *   cwd, baseline, provenance, or requester catalog;
 * - success requires the owner's own acceptance: refusals, positively-not-sent
 *   results, and unknown outcomes are truthful, `invalid-draft`/`conflict`
 *   keep the draft, and nothing is retried;
 * - malformed replies and a closed/superseded pane never open or update
 *   settings, and a disconnect discards the draft instead of restoring it on a
 *   later open/reconnect.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { ScopedModelChoice } from "../src/settings/models";
import type { UiContext } from "../src/settings/ui";
import type {
  PeerReviewSettingsLoadOutcome,
  PeerReviewSettingsResult,
  PeerReviewSettingsSaveOutcome,
} from "../src/session-host/network/peer-review-settings";
import { projectRemoteReviewSettingsOpening } from "../src/session-host/remote-review-settings-data";
import {
  openRemoteReviewSettings,
  type OpenRemoteReviewSettingsInput,
} from "../src/session-host/remote-review-settings-viewer";
import type {
  RemoteReviewSettingsLoadEnvelope,
  RemoteReviewSettingsSaveEnvelope,
  RemoteReviewSettingsToolChoice,
} from "../src/session-host/remote-review-settings-owner";

// ---------------------------------------------------------------------------
// Owner fixture and load/save doubles
// ---------------------------------------------------------------------------

const SECRET_COMMAND = "/secret/owner-claude";
const SECRET_ARGV = "--owner-argv-secret";
const SECRET_ENV = "owner-env-secret";
const SECRET_BINARY_COMMAND = "/secret/owner-binary";
const SECRET_BINARY_ENV = "binary-env-secret";
const SECRET_BINARY_ARGV = "--binary-argv-secret";

const SCOPED: ScopedModelChoice[] = [
  { model: "pi/fake-a", label: "fake-a [pi]", supportedThinkingLevels: ["off", "high"] },
  { model: "pi/fake-b", label: "fake-b [pi]", supportedThinkingLevels: ["off"] },
];

const TOOLS: RemoteReviewSettingsToolChoice[] = [
  { name: "Read", description: "read files" },
  { name: "Bash" },
  { name: "OwnerOnlyTool", description: "owner-only tool" },
  { name: "tool_search", description: "discovery loader" },
];

/** One owner config with private worker bytes and legacy reasoning state. */
const OWNER: ReviewGateConfig = normalizeConfig({
  enabled: true,
  operatingMode: "orchestrate",
  modeCycleShortcut: "alt+m",
  reviewerTimeoutMs: 111_000,
  executorTimeoutMs: 222_000,
  maxCorrectionCycles: 2,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "always",
  deleteSpawnedPiSessionsOnCleanup: true,
  externalAgents: {
    legacy: {
      adapter: "claude-cli",
      command: SECRET_COMMAND,
      args: ["--effort", "high", "--effort", "low", SECRET_ARGV],
      env: { OWNER_TOKEN: SECRET_ENV },
      model: "claude-opus-5-5",
      review: { model: "claude-sonnet-5-5" },
      execution: { model: "claude-sonnet-5-5" },
    },
    binary: {
      adapter: "run-as-binary",
      command: SECRET_BINARY_COMMAND,
      args: [SECRET_BINARY_ARGV],
      env: { BINARY_TOKEN: SECRET_BINARY_ENV },
      review: { protocol: "pi-reviewer-json-v1" },
    },
  },
  execution: {
    workerResources: {
      "pi-a": { selection: { source: "pi", model: "pi/fake-a", thinkingLevel: "high" }, maxConcurrent: 2 },
      "legacy-r": { selection: { source: "external", id: "legacy" }, maxConcurrent: 1 },
    },
    routes: {
      execute: [{ resourceId: "pi-a", thinkingLevel: "high" }],
      research: [{ resourceId: "legacy-r" }],
    },
    maxWorkers: 5,
    subtaskNotifications: "noisy",
  },
  scheduledTasks: {
    "task-1a2b3c4d": {
      name: "Nightly",
      cron: "0 2 * * *",
      enabled: true,
      kind: "execute",
      instructions: "Review overnight changes",
      workspace: "/srv/owner/work",
      workerResourceId: "pi-a",
    },
  },
  review: {
    primaryReviewers: [{ source: "pi", model: "pi/fake-a", thinkingLevel: "high" }],
    subtaskReviewers: [],
    primaryEnabled: true,
    subtaskEnabled: false,
    reviewLandedChanges: true,
    evidence: { primaryToolOnly: true, worktreeToolOnly: false, inplaceToolOnly: false, snapshotFailureFallback: true },
  },
  ui: { subtasksViewExpanded: true, showSubtaskTaskIds: true },
  youShouldKnow: { enabled: true, completionGuidance: false },
  tools: { topLevelDeny: ["Bash"], executorDeny: ["Write"] },
  web: {
    browserInteractionApproval: "ask",
    browserIdleExpiryMinutes: 5,
    browserDownloadRetention: 3,
    browserVisible: true,
    browserPermissions: { modelUploads: true },
    urlBlocklist: ["^https://blocked\\.example/"],
    fetch: { maxDownloadBytes: 2 * 1024 * 1024 },
  },
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function loadPayload(overrides: Partial<RemoteReviewSettingsLoadEnvelope> = {}): Uint8Array {
  const envelope: RemoteReviewSettingsLoadEnvelope = {
    openingId: "opening-1",
    opening: projectRemoteReviewSettingsOpening(OWNER),
    scoped: SCOPED,
    tools: TOOLS,
    firstUse: false,
    notices: [],
    ...overrides,
  };
  return encode(envelope);
}

function loadResult(payload: Uint8Array): PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome> {
  return { kind: "owner-result", outcome: { kind: "loaded", payload } };
}

const SAVE_ACCEPTED: PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome> = {
  kind: "owner-result",
  outcome: { kind: "accepted" },
};

function parseSave(payload: Uint8Array): RemoteReviewSettingsSaveEnvelope {
  return JSON.parse(new TextDecoder().decode(payload)) as RemoteReviewSettingsSaveEnvelope;
}

// ---------------------------------------------------------------------------
// Scripted plain-selector harness (the sidebar's plain path)
// ---------------------------------------------------------------------------

interface ScriptedRun {
  ui: UiContext;
  shown: Array<{ title: string; options: string[] }>;
  notices: Array<{ message: string; type?: string }>;
  remaining(): number;
}

function scripted(steps: Array<string | undefined>, texts: Array<string | undefined> = []): ScriptedRun {
  const shown: ScriptedRun["shown"] = [];
  const notices: ScriptedRun["notices"] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (title, options) => {
      shown.push({ title, options: [...options] });
      assert.ok(index < steps.length, `unexpected extra selection (${title}): ${options.join(" | ")}`);
      const step = steps[index++];
      if (step === undefined) return undefined;
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step));
      assert.ok(match !== undefined, `missing selection ${step}: ${options.join(" | ")}`);
      return match;
    },
    editText: async (request) => {
      const next = texts.shift();
      if (next === undefined) assert.fail(`unexpected text field: ${request.title}`);
      return next;
    },
    notify: (message, type) => {
      notices.push({ message, type });
    },
  };
  return { ui, shown, notices, remaining: () => steps.length - index };
}

function rootRows(run: ScriptedRun, index = 0): string[] {
  assert.equal(run.shown[index]?.title, "Review settings");
  return run.shown[index]!.options;
}

function noticesText(run: ScriptedRun): string[] {
  return run.notices.map((notice) => notice.message);
}

// ---------------------------------------------------------------------------
// Opening, catalogs, and the local menu
// ---------------------------------------------------------------------------

test("loads the owner opening into the local menu; Cancel sends no save", async () => {
  const run = scripted(["Cancel"]);
  let loads = 0;
  const saves: Uint8Array[] = [];
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => {
      loads += 1;
      return loadResult(loadPayload());
    },
    save: async (payload) => {
      saves.push(payload);
      return SAVE_ACCEPTED;
    },
  });

  assert.equal(ended, false);
  assert.equal(loads, 1);
  assert.equal(saves.length, 0);
  assert.equal(run.shown[0]?.title, "Review settings");
  assert.equal(rootRows(run).includes("Cancel"), true);
  assert.equal(rootRows(run).some((row) => row.startsWith("Host:")), false);
  // The menu opened on the owner's editable values, not requester defaults.
  assert.equal(rootRows(run).some((row) => row.startsWith("Operating mode") && row.includes("Prefer orchestration")), true);
  assert.equal(rootRows(run).some((row) => row.startsWith("External workers") && row.includes("2 defined")), true);
  assert.equal(rootRows(run).some((row) => row.startsWith("Retention") && row.includes("Always")), true);
  assert.equal(
    noticesText(run).some((message) => message.includes("Editing REMOTE review-gate settings for studio-mac")),
    true,
  );
  // No owner-private worker bytes or diagnostics reach any notice.
  for (const notice of run.notices) {
    assert.doesNotMatch(
      notice.message,
      /owner-claude|owner-argv-secret|owner-env-secret|owner-binary|binary-env-secret|binary-argv-secret/,
    );
  }
});

test("the menu uses the owner's model labels, thinking metadata, and tool catalog", async () => {
  const run = scripted([
    "Reviewers",
    "Primary reviewers",
    "Back",
    "Back",
    "Tools",
    "Top-level tools",
    "Back",
    "Back",
    "Cancel",
  ]);
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  const reviewerPicker = run.shown.find((screen) => screen.title.startsWith("Reviewers —"));
  assert.ok(reviewerPicker, "reviewer picker did not open");
  assert.equal(reviewerPicker.options.some((option) => option.startsWith("fake-a [pi]")), true);
  // The reasoning row exists only when the owner's supported thinking levels
  // reached the shared picker.
  assert.equal(
    reviewerPicker.options.some((option) => option.startsWith("Reasoning · fake-a [pi]  ") && /High/.test(option)),
    true,
  );

  const toolPicker = run.shown.find((screen) => screen.title.startsWith("Top-level tools —"));
  assert.ok(toolPicker, "top-level tool picker did not open");
  assert.equal(toolPicker.options.some((option) => option.startsWith("OwnerOnlyTool")), true);
  assert.equal(toolPicker.options.some((option) => option.startsWith("LocalOnlyTool")), false);
});

test("an unsupported projected adapter still presents its Delete/Back-only role", async () => {
  const run = scripted(["External workers", "binary [run-as-binary]", "Back", "Back", "Cancel"]);
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  const unsupported = run.shown.find((screen) => screen.title === "Worker binary — unsupported adapter");
  assert.ok(unsupported, "unsupported adapter screen did not open");
  assert.deepEqual(unsupported.options, ["Delete", "Back"]);
});

// ---------------------------------------------------------------------------
// Save: exact intent, no private fields, owner-confirmed success
// ---------------------------------------------------------------------------

test("Save emits the exact closed intent and requires the owner's acceptance", async () => {
  const run = scripted([
    "External workers",
    "legacy [claude-cli]",
    "Shared reasoning",
    "High",
    "Apply edit",
    "Back",
    "Save changes",
  ]);
  const saves: Uint8Array[] = [];
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async (payload) => {
      saves.push(payload);
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, false);
  assert.equal(saves.length, 1);

  const text = new TextDecoder().decode(saves[0]);
  const parsed = parseSave(saves[0]!);
  assert.deepEqual(Object.keys(parsed).sort(), ["intent", "openingId"]);
  assert.equal(parsed.openingId, "opening-1");
  assert.equal(parsed.intent.version, 1);
  // The edited definition is the only lineage step; it carries editable values
  // only. Private command/argv/env, local path, cwd, baselines, and catalogs
  // never appear in the outbound bytes.
  assert.equal(parsed.intent.externalAgents.length, 1);
  const step = parsed.intent.externalAgents[0]!;
  assert.equal(step.id, "legacy");
  assert.equal(step.nextId, "legacy");
  assert.equal(step.definition?.adapter, "claude-cli");
  assert.equal(step.definition?.reasoningEffort, "high");
  assert.equal(step.definition?.review?.model, "claude-sonnet-5-5");
  assert.equal(Object.hasOwn(step.definition!, "env"), false);
  assert.equal(Object.hasOwn(step.definition!, "args"), false);
  assert.equal(Object.hasOwn(step.definition!, "command"), false);
  for (const secret of [SECRET_COMMAND, SECRET_ARGV, SECRET_ENV, SECRET_BINARY_COMMAND, SECRET_BINARY_ENV, SECRET_BINARY_ARGV]) {
    assert.equal(text.includes(secret), false, `outbound intent leaked ${secret}`);
  }
  for (const forbidden of ["configPath", "cwd", "scoped", "firstUse", "provenance", "baseline"]) {
    assert.equal(text.includes(forbidden), false, `outbound intent leaked ${forbidden}`);
  }
  // The owner's positive acceptance uses the shared saved-result semantics.
  assert.equal(
    noticesText(run).some((message) => message.includes("Review settings saved to disk.")),
    true,
  );
});

test("a confirmed save renders one retained, bounded auto-disable notice", async () => {
  const run = scripted(["Save changes"]);
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async () => ({
      kind: "owner-result",
      outcome: {
        kind: "accepted",
        // The owner reports only proven task identities, plus an exact count
        // for entries its bounded list could not carry.
        receipt: {
          disabledTaskIds: ["task-1a2b3c4d", "task-remote-only"],
          additionalDisabledCount: 2,
        },
      },
    }),
  });
  assert.equal(ended, false);
  const texts = noticesText(run);
  // The sidebar retains exactly one post-save notice, so every disabled task and
  // the exact remainder must be in the SAME notice.
  const warnings = texts.filter((message) => message.includes("will not run"));
  assert.equal(warnings.length, 1, "one retained notice, not one per task");
  const notice = warnings[0]!;
  assert.equal(texts.at(-1), notice, "this warning is the notice the sidebar keeps");
  // The display name comes from THIS editor's staged draft, not the owner.
  assert.equal(notice.includes('"Nightly"'), true);
  // An identity with no local name is still reported as itself.
  assert.equal(notice.includes('"task-remote-only"'), true);
  // 2 listed tasks + 2 remainder = the exact confirmed total of 4.
  assert.equal(notice.includes("Scheduled tasks will not run"), true);
  assert.equal(notice.includes("and 2 more"), true);
  for (const forbidden of ["/srv/owner/work", "pi-a", "no longer exists"]) {
    assert.equal(notice.includes(forbidden), false, `notice leaked ${forbidden}`);
  }

  // A receipt with more identities than one notice names stays one bounded
  // notice: at most five names, then the exact total's remainder.
  const many = scripted(["Save changes"]);
  const ids = ["task-1a2b3c4d", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7", "t-8"];
  const manyEnded = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: many.ui,
    load: async () => loadResult(loadPayload()),
    save: async () => ({
      kind: "owner-result",
      outcome: { kind: "accepted", receipt: { disabledTaskIds: ids, additionalDisabledCount: 3 } },
    }),
  });
  assert.equal(manyEnded, false);
  const manyWarnings = noticesText(many).filter((message) => message.includes("will not run"));
  assert.equal(manyWarnings.length, 1);
  const bounded = manyWarnings[0]!;
  assert.equal(bounded.includes('"Nightly"'), true);
  assert.equal(bounded.includes('"t-5"'), true);
  assert.equal(bounded.includes('"t-6"'), false, "only the bounded name list is shown");
  // 8 listed + 3 remainder = 11 total; 5 shown, so 6 more.
  assert.equal(bounded.includes("and 6 more"), true);
});

test("no auto-disable notice is rendered unless the owner positively accepted the save", async () => {
  const cases: Array<{ name: string; result: PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome> }> = [
    {
      name: "owner invalid-draft",
      result: { kind: "owner-result", outcome: { kind: "refused", reason: "invalid-draft" } },
    },
    {
      name: "owner unknown",
      result: { kind: "owner-result", outcome: { kind: "unknown" } },
    },
    { name: "transport unknown", result: { kind: "unknown" } },
  ];
  for (const entry of cases) {
    // invalid-draft keeps the menu open, so Cancel ends it; the other outcomes
    // end the editor themselves.
    const run = scripted(["Save changes", "Cancel"]);
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => loadResult(loadPayload()),
      save: async () => entry.result,
    });
    assert.equal(ended, false, entry.name);
    assert.equal(
      noticesText(run).some((message) => message.includes("will not run")),
      false,
      `${entry.name} must never report a confirmed auto-disable`,
    );
  }
});

test("owner refusals, not-sent results, and unknown outcomes are truthful and never retried", async () => {
  const cases: Array<{
    name: string;
    result: PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome>;
    expected: RegExp;
  }> = [
    {
      name: "owner policy refusal",
      result: { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } },
      expected: /did not authorize this Review settings change; nothing was saved/,
    },
    {
      name: "owner stale refusal",
      result: { kind: "owner-result", outcome: { kind: "refused", reason: "stale" } },
      expected: /no longer has this Review settings draft open; nothing was saved/,
    },
    {
      name: "positively not sent",
      result: { kind: "not-sent", reason: "target-unavailable" },
      expected: /disconnected or no longer current; nothing was sent/,
    },
    {
      name: "unknown after a possible send",
      result: { kind: "unknown" },
      expected: /Could not confirm whether studio-mac saved these Review settings/,
    },
  ];
  for (const entry of cases) {
    const run = scripted(["Save changes"]);
    let saves = 0;
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => loadResult(loadPayload()),
      save: async () => {
        saves += 1;
        return entry.result;
      },
    });
    assert.equal(ended, false, entry.name);
    assert.equal(saves, 1, `${entry.name}: save must be sent exactly once`);
    assert.equal(run.shown.length, 1, `${entry.name}: the editor must end after a terminal outcome`);
    assert.equal(noticesText(run).some((message) => entry.expected.test(message)), true, entry.name);
  }
});

test("owner invalid-draft and conflict keep the current draft open", async () => {
  for (const [reason, expected] of [
    ["invalid-draft", /rejected this draft; nothing was saved/],
    ["conflict", /reports external-worker changes on disk; nothing was saved/],
  ] as const) {
    const run = scripted(["Save changes", "Cancel"]);
    let saves = 0;
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => loadResult(loadPayload()),
      save: async () => {
        saves += 1;
        return { kind: "owner-result", outcome: { kind: "refused", reason } };
      },
    });
    assert.equal(ended, false, reason);
    assert.equal(saves, 1, `${reason}: no implicit retry`);
    // The root is shown again with the draft still staged.
    assert.equal(run.shown.filter((screen) => screen.title === "Review settings").length, 2, reason);
    assert.equal(noticesText(run).some((message) => expected.test(message)), true, reason);
  }
});

test("an owner invalid-draft keeps the staged draft for a corrected save", async () => {
  const run = scripted(["Operating mode", "Prefer execution", "Save changes", "Save changes"]);
  const payloads: Uint8Array[] = [];
  let attempt = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async (payload) => {
      payloads.push(payload);
      attempt += 1;
      return attempt === 1
        ? { kind: "owner-result", outcome: { kind: "refused", reason: "invalid-draft" } }
        : SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, false);
  assert.equal(payloads.length, 2);
  // The corrected Save reuses exactly the still-staged local edit and the same
  // opening token; no implicit retry happened between the user's two Saves.
  assert.equal(parseSave(payloads[0]!).intent.operatingMode, "execute");
  assert.equal(parseSave(payloads[1]!).openingId, "opening-1");
  assert.equal(parseSave(payloads[1]!).intent.operatingMode, "execute");
  assert.equal(noticesText(run).some((message) => message.includes("Review settings saved to disk.")), true);
});

test("a scheduled workspace edit keeps the owner-spelling contract exactly", async () => {
  const run = scripted(
    ["Scheduled tasks", "1.", "Workspace", "Back", "Back", "Save changes"],
    ["~/project"],
  );
  const saves: Uint8Array[] = [];
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload()),
    save: async (payload) => {
      saves.push(payload);
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, false);
  assert.equal(saves.length, 1);
  assert.equal(parseSave(saves[0]!).intent.scheduledTasks["task-1a2b3c4d"]?.workspace, "~/project");
  assert.equal(parseSave(saves[0]!).intent.scheduledTasks["task-1a2b3c4d"]?.kind, "execute");
});

// ---------------------------------------------------------------------------
// Load failures and malformed replies
// ---------------------------------------------------------------------------

test("a valid positive-step schedule still opens through the canonical parser", async () => {
  const valid = JSON.parse(new TextDecoder().decode(loadPayload())) as Record<string, any>;
  valid.opening.config.scheduledTasks["task-1a2b3c4d"].cron = "*/05 2 * * *";
  const run = scripted(["Cancel"]);
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(encode(valid)),
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  assert.equal(run.shown[0]?.title, "Review settings");
  assert.equal(rootRows(run).some((row) => row.startsWith("Scheduled tasks")), true);
});

test("load failures are truthful and never open the menu", async () => {
  const cases: Array<{
    name: string;
    result: PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome>;
    expected: RegExp;
  }> = [
    {
      name: "owner unavailable",
      result: { kind: "owner-result", outcome: { kind: "refused", reason: "unavailable" } },
      expected: /has no editable Review-gate configuration available/,
    },
    {
      name: "not sent",
      result: { kind: "not-sent", reason: "target-unavailable" },
      expected: /disconnected or no longer current; nothing was sent/,
    },
    {
      name: "unknown",
      result: { kind: "unknown" },
      expected: /Could not confirm the Review settings load from studio-mac; nothing was opened/,
    },
    {
      name: "capability unsupported",
      result: { kind: "not-sent", reason: "capability-unsupported" },
      expected: /does not offer remote Review settings editing; nothing was sent/,
    },
  ];
  for (const entry of cases) {
    const run = scripted([]);
    let saves = 0;
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => entry.result,
      save: async () => {
        saves += 1;
        return SAVE_ACCEPTED;
      },
    });
    assert.equal(ended, false, entry.name);
    assert.equal(run.shown.length, 0, `${entry.name}: no menu may open`);
    assert.equal(saves, 0, entry.name);
    assert.equal(noticesText(run).some((message) => entry.expected.test(message)), true, entry.name);
  }
});

test("malformed or forged replies never open or update settings", async () => {
  const valid = JSON.parse(new TextDecoder().decode(loadPayload())) as Record<string, any>;
  const mutations: Array<[string, () => Uint8Array]> = [
    ["not JSON", () => new TextEncoder().encode("{not json")],
    ["unsupported root field", () => encode({ ...valid, extra: true })],
    ["unsupported envelope version", () => encode({ ...valid, opening: { ...valid.opening, version: 2 } })],
    [
      "private worker field",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.externalAgents.legacy.command = SECRET_COMMAND;
        return encode(copy);
      },
    ],
    [
      "unsupported thinking metadata",
      () => {
        const copy = structuredClone(valid);
        copy.scoped[0].supportedThinkingLevels = ["off", "bogus"];
        return encode(copy);
      },
    ],
    [
      "malformed tool catalog",
      () => {
        const copy = structuredClone(valid);
        copy.tools = [{ name: "Read" }, { name: "Read" }];
        return encode(copy);
      },
    ],
    [
      "unknown notice code",
      () => {
        const copy = structuredClone(valid);
        copy.notices = ["owner-diagnostic"];
        return encode(copy);
      },
    ],
    [
      "scheduled entry missing required fields",
      () => {
        const copy = structuredClone(valid);
        delete copy.opening.config.scheduledTasks["task-1a2b3c4d"].enabled;
        delete copy.opening.config.scheduledTasks["task-1a2b3c4d"].kind;
        return encode(copy);
      },
    ],
    [
      "scheduled entry unknown field",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.scheduledTasks["task-1a2b3c4d"].unexpected = true;
        return encode(copy);
      },
    ],
    [
      "reviewer selection missing source",
      () => {
        const copy = structuredClone(valid);
        delete copy.opening.config.review.primaryReviewers[0].source;
        return encode(copy);
      },
    ],
    [
      "worker selection missing source",
      () => {
        const copy = structuredClone(valid);
        delete copy.opening.config.execution.workerResources["pi-a"].selection.source;
        return encode(copy);
      },
    ],
    [
      "worker selection carries resource-level thinking",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.execution.workerResources["pi-a"].selection.thinkingLevel = "high";
        return encode(copy);
      },
    ],
    [
      "route entry missing resourceId",
      () => {
        const copy = structuredClone(valid);
        delete copy.opening.config.execution.routes.execute[0].resourceId;
        return encode(copy);
      },
    ],
    [
      "non-editable byte limit is not a number",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.maxPatchBytes = { unexpected: true };
        return encode(copy);
      },
    ],
    [
      "web search provider would be defaulted from null",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.web.search.provider = null;
        return encode(copy);
      },
    ],
    [
      "web user agent would be defaulted from null",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.web.fetch.userAgent = null;
        return encode(copy);
      },
    ],
    [
      "zero-padded zero cron step would trap the parser",
      () => {
        const copy = structuredClone(valid);
        copy.opening.config.scheduledTasks["task-1a2b3c4d"].cron = "*/00 2 * * *";
        return encode(copy);
      },
    ],
  ];
  for (const [name, payload] of mutations) {
    const run = scripted([]);
    let saves = 0;
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => loadResult(payload()),
      save: async () => {
        saves += 1;
        return SAVE_ACCEPTED;
      },
    });
    assert.equal(ended, false, name);
    assert.equal(run.shown.length, 0, `${name}: no menu may open`);
    assert.equal(saves, 0, name);
    assert.equal(
      noticesText(run).some((message) => /returned Review settings this editor could not read; nothing was opened/.test(message)),
      true,
      name,
    );
  }
});

test("oversized projected catalogs and aggregate opening work are rejected before the menu", async () => {
  const valid = JSON.parse(new TextDecoder().decode(loadPayload())) as Record<string, any>;
  const tooManyAgents = (): Uint8Array => {
    const copy = structuredClone(valid);
    copy.opening.config.externalAgents = {};
    for (let index = 0; index < 257; index += 1) {
      copy.opening.config.externalAgents[`agent-${index}`] = { adapter: "run-as-binary", review: {} };
    }
    return encode(copy);
  };
  const tooManySchedules = (): Uint8Array => {
    const copy = structuredClone(valid);
    const task = copy.opening.config.scheduledTasks["task-1a2b3c4d"];
    copy.opening.config.scheduledTasks = {};
    for (let index = 0; index < 2_049; index += 1) {
      copy.opening.config.scheduledTasks[`task-${index.toString(16).padStart(8, "0")}`] = structuredClone(task);
    }
    return encode(copy);
  };
  const excessiveAggregateWork = (): Uint8Array => {
    const copy = structuredClone(valid);
    copy.opening.config.externalAgents = {};
    for (let index = 0; index < 200; index += 1) {
      copy.opening.config.externalAgents[`agent-${index}`] = { adapter: "run-as-binary", review: {} };
    }
    copy.opening.config.scheduledTasks = {};
    for (let index = 0; index < 1_000; index += 1) {
      copy.opening.config.scheduledTasks[`task-${index.toString(16).padStart(8, "0")}`] = {
        name: "Nightly",
        cron: "0 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Review overnight changes",
        workspace: "/srv/owner/work",
        review: {
          mode: "selected",
          reviewers: Array.from({ length: 20 }, () => ({ source: "external", id: "agent-0" })),
        },
      };
    }
    return encode(copy);
  };

  for (const [name, payload] of [
    ["too many external workers", tooManyAgents],
    ["too many scheduled tasks", tooManySchedules],
    ["excessive aggregate reference work", excessiveAggregateWork],
  ] as const) {
    const run = scripted([]);
    let saves = 0;
    const ended = await openRemoteReviewSettings({
      label: "studio-mac",
      ui: run.ui,
      load: async () => loadResult(payload()),
      save: async () => {
        saves += 1;
        return SAVE_ACCEPTED;
      },
    });
    assert.equal(ended, false, name);
    assert.equal(run.shown.length, 0, `${name}: no menu may open`);
    assert.equal(saves, 0, name);
    assert.equal(
      noticesText(run).some((message) => /returned Review settings this editor could not read; nothing was opened/.test(message)),
      true,
      name,
    );
  }
});

test("large repeated reference data is rejected before the menu", async () => {
  const valid = JSON.parse(new TextDecoder().decode(loadPayload())) as Record<string, any>;
  const copy = structuredClone(valid);
  copy.opening.config.externalAgents = {};
  for (let index = 0; index < 200; index += 1) {
    copy.opening.config.externalAgents[`agent-${index}`] = { adapter: "run-as-binary", review: {} };
  }
  const longModel = `model-${"x".repeat(12_000)}`;
  copy.opening.config.scheduledTasks = {};
  for (let index = 0; index < 20; index += 1) {
    copy.opening.config.scheduledTasks[`task-${index.toString(16).padStart(8, "0")}`] = {
      name: "Nightly",
      cron: "0 2 * * *",
      enabled: true,
      kind: "execute",
      instructions: "Review overnight changes",
      workspace: "/srv/owner/work",
      review: {
        mode: "selected",
        reviewers: [
          ...Array.from({ length: 20 }, (_unused, reviewerIndex) => ({
            source: "external",
            id: `agent-${reviewerIndex}`,
          })),
          { source: "pi", model: longModel },
        ],
      },
    };
  }
  const payload = encode(copy);
  assert.ok(payload.length < 4 * 1024 * 1024, "the fixture must stay under the wire byte limit");
  const run = scripted([]);
  let saves = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(payload),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, false);
  assert.equal(run.shown.length, 0);
  assert.equal(saves, 0);
  assert.equal(
    noticesText(run).some((message) => /returned Review settings this editor could not read; nothing was opened/.test(message)),
    true,
  );
});

test("an abort during opening notices never reaches a live screen", async () => {
  const controller = new AbortController();
  const run = scripted([]);
  const notify = run.ui.notify;
  assert.ok(notify);
  run.ui.notify = (message, type) => {
    notify(message, type);
    if (message.includes("Editing REMOTE")) controller.abort();
  };
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    signal: controller.signal,
    load: async () => loadResult(loadPayload({ notices: ["catalog-warning"] })),
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  assert.equal(run.shown.length, 0);
  assert.equal(run.ui.saveControl, undefined, "an aborted opening must not install a Save control");
  const texts = noticesText(run);
  assert.equal(texts.some((message) => message.includes("Editing REMOTE review-gate settings for studio-mac")), true);
  // The later opening warning is suppressed after the abort; only the
  // adapter's own disconnect notice is added.
  assert.equal(texts.some((message) => message.includes("reported a settings catalog warning")), false);
  assert.equal(texts.some((message) => /disconnected or no longer selected/.test(message)), true);
});

test("an abort while a submenu is pending stops further live UI calls", async () => {
  const controller = new AbortController();
  let calls = 0;
  let pending: ((value: string | undefined) => void) | undefined;
  const notices: Array<{ message: string; type?: string }> = [];
  const ui: UiContext = {
    select: (title, options) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(title, "Review settings");
        return Promise.resolve(options.find((option) => option.startsWith("Reviewers"))!);
      }
      assert.equal(title, "Review");
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    notify: (message, type) => {
      notices.push({ message, type });
    },
  };
  let saves = 0;
  const opened = openRemoteReviewSettings({
    label: "studio-mac",
    ui,
    signal: controller.signal,
    load: async () => loadResult(loadPayload()),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  for (let attempt = 0; attempt < 20 && pending === undefined; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(pending, "the submenu did not become pending");
  controller.abort();
  pending(undefined);
  assert.equal(await opened, false);
  assert.equal(calls, 2, "no new live screen may be requested after the abort");
  assert.equal(saves, 0);
  assert.equal(notices.some((notice) => /disconnected or no longer selected/.test(notice.message)), true);
});

test("a target picker result delivered after disconnect is ignored", async () => {
  const controller = new AbortController();
  const run = scripted(["Host: beta"]);
  let resolveSwitch: ((value: boolean) => void) | undefined;
  let requested = false;
  let saves = 0;
  const opened = openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    signal: controller.signal,
    targetControl: {
      label: "beta",
      requestSwitch: () => {
        requested = true;
        return new Promise((resolve) => {
          resolveSwitch = resolve;
        });
      },
    },
    load: async () => loadResult(loadPayload()),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  for (let attempt = 0; attempt < 20 && !requested; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requested, true);
  controller.abort();
  resolveSwitch?.(true);
  assert.equal(await opened, false, "a late switch must not become the switched result");
  assert.equal(saves, 0);
  assert.equal(run.shown.length, 1, "no new live screen may be requested after the abort");
});

// ---------------------------------------------------------------------------
// Disconnects, staleness, and reopening
// ---------------------------------------------------------------------------

test("an already-closed or superseded pane never requests or opens settings", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = scripted([]);
  let loads = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    signal: controller.signal,
    load: async () => {
      loads += 1;
      return loadResult(loadPayload());
    },
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  assert.equal(loads, 0);
  assert.equal(run.shown.length, 0);
  assert.equal(run.notices.length, 0);
});

test("a disconnect during the load never opens settings", async () => {
  const controller = new AbortController();
  const run = scripted([]);
  let resolveLoad: ((result: PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome>) => void) | undefined;
  const opened = openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    signal: controller.signal,
    load: () => new Promise((resolve) => {
      resolveLoad = resolve;
    }),
    save: async () => SAVE_ACCEPTED,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  resolveLoad?.(loadResult(loadPayload()));
  assert.equal(await opened, false);
  assert.equal(run.shown.length, 0);
  assert.equal(
    noticesText(run).some((message) => /disconnected or no longer selected; these Review settings were closed\./.test(message)),
    true,
  );
});

test("a disconnect during Save is unknown, and a later open re-loads the owner instead of restoring the draft", async () => {
  const controller = new AbortController();
  const firstRun = scripted(["Operating mode", "Prefer execution", "Save changes"]);
  let sendStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  let releaseSave: ((result: PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome>) => void) | undefined;
  const first = openRemoteReviewSettings({
    label: "studio-mac",
    ui: firstRun.ui,
    signal: controller.signal,
    load: async () => loadResult(loadPayload()),
    save: () => {
      sendStarted?.();
      return new Promise((resolve) => {
        releaseSave = resolve;
      });
    },
  });
  await started;
  controller.abort();
  releaseSave?.(SAVE_ACCEPTED);
  assert.equal(await first, false);
  assert.equal(
    noticesText(firstRun).some((message) => /Could not confirm whether studio-mac saved these Review settings/.test(message)),
    true,
  );

  // A reopened pane performs a fresh owner load; the discarded "execute" draft
  // is neither restored nor sent.
  const secondRun = scripted(["Cancel"]);
  let loads = 0;
  const second = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: secondRun.ui,
    signal: new AbortController().signal,
    load: async () => {
      loads += 1;
      return loadResult(loadPayload());
    },
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(second, false);
  assert.equal(loads, 1);
  assert.equal(rootRows(secondRun).some((row) => row.startsWith("Operating mode") && row.includes("Prefer orchestration")), true);
  assert.equal(rootRows(secondRun).some((row) => row.startsWith("Operating mode") && row.includes("Prefer execution")), false);
});

// ---------------------------------------------------------------------------
// Host switching and opening semantics
// ---------------------------------------------------------------------------

test("the caller's target switch is the only true result and shares the live save control", async () => {
  const run = scripted(["Host: beta"]);
  const requests: boolean[] = [];
  let suspendedDuringRequest: number | undefined;
  let saves = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    signal: new AbortController().signal,
    targetControl: {
      label: "beta",
      requestSwitch: async (hasUnsavedChanges) => {
        requests.push(hasUnsavedChanges);
        // The host confirmation closures read the ORIGINAL UI's control; the
        // wrapper must forward the shared menu's control to it.
        suspendedDuringRequest = run.ui.saveControl?.suspended;
        return true;
      },
    },
    load: async () => loadResult(loadPayload()),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, true);
  assert.deepEqual(requests, [false]);
  assert.equal(suspendedDuringRequest, 1);
  assert.equal(run.ui.saveControl?.suspended, 0);
  assert.equal(saves, 0);
});

test("a switch whose pane goes stale while section help unwinds is not returned", async () => {
  const controller = new AbortController();
  const run = scripted(["Host: beta"]);
  let pickerAccepted = false;
  let saves = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: {
      ...run.ui,
      settingsSectionHelp: {
        section: async <T>(_summary: string, runMenu: () => Promise<T>): Promise<T> => {
          const result = await runMenu();
          controller.abort();
          return result;
        },
      },
    },
    signal: controller.signal,
    targetControl: {
      label: "beta",
      requestSwitch: async () => {
        pickerAccepted = true;
        return true;
      },
    },
    load: async () => loadResult(loadPayload()),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(pickerAccepted, true);
  assert.equal(ended, false);
  assert.equal(saves, 0);
  assert.equal(noticesText(run).some((message) => /disconnected or no longer selected/.test(message)), true);
});

test("the caller's declined target switch keeps the menu and draft open", async () => {
  const run = scripted(["Host: beta", "Cancel"]);
  let saves = 0;
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    targetControl: {
      label: "beta",
      requestSwitch: async () => false,
    },
    load: async () => loadResult(loadPayload()),
    save: async () => {
      saves += 1;
      return SAVE_ACCEPTED;
    },
  });
  assert.equal(ended, false);
  assert.equal(saves, 0);
  assert.equal(run.shown.filter((screen) => screen.title === "Review settings").length, 2);
});

test("first-use and owner notice codes are fixed, ranked, and path-free", async () => {
  const run = scripted(["Cancel"]);
  const ended = await openRemoteReviewSettings({
    label: "studio-mac",
    ui: run.ui,
    load: async () => loadResult(loadPayload({
      firstUse: true,
      notices: ["catalog-warning", "config-warning", "tool-protection-invalid"],
    })),
    save: async () => SAVE_ACCEPTED,
  });
  assert.equal(ended, false);
  const texts = noticesText(run);
  assert.equal(texts.some((message) => /No config exists there yet; showing defaults/.test(message)), true);
  assert.equal(texts.some((message) => /reported a settings catalog warning/.test(message)), true);
  assert.equal(texts.some((message) => /reported a configuration warning/.test(message)), true);
  const toolProtection = run.notices.find((notice) => /invalid saved tool-protection settings/.test(notice.message));
  assert.equal(toolProtection?.type, "error");
  assert.equal(run.notices.at(-1), toolProtection);
  for (const message of texts) {
    assert.equal(message.includes("/srv/owner/work"), false, "owner path leaked into a notice");
    assert.equal(message.includes("review-gate.json"), false, "owner path leaked into a notice");
  }
});
