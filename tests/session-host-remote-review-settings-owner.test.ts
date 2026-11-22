/**
 * Issue #716: the OWNER composition for remote Review settings.
 *
 * These focused tests pin the owner-only behavior of
 * `src/session-host/remote-review-settings-owner.ts` against the real shared
 * load/decode/commit seams:
 *
 * - a load re-reads the owner's config, writes nothing, publishes only the
 *   projected opening plus the owner's own model/tool catalogs and closed
 *   notice codes, and never leaks a path, diagnostic, worker command, argv, or
 *   environment byte;
 * - the opening token is unguessable and bound to the exact authenticated peer
 *   key id plus the exact owner run (owner A cannot use owner B's token, a
 *   reconnect for the same peer/run can);
 * - the save envelope is exactly `{ openingId, intent }`; every owner baseline
 *   comes from the retained opening, so malformed/forged drafts and wrong
 *   tokens refuse before any write and keep the opening for a retry;
 * - `accepted` requires the shared backend's own `saved` result, a confirmed
 *   save retires its token (replay is `stale`), a real shared external-worker
 *   guard is `conflict`, and any unclassifiable failure is `unknown` with no
 *   raw text exposed;
 * - guarded first use creates the config only through the existing guarded
 *   initializer, and a config that appears meanwhile leaves it absent.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_EXECUTION_RETRY_POLICY,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SUBTASK_NOTIFICATION_MODE,
  cloneScheduledTaskCatalog,
  cloneWorkerCatalog,
  effectiveReviewEvidenceSettings,
  effectiveReviewSettings,
  normalizeConfig,
  type ReviewGateConfig,
} from "../src/config";
import { captureExternalAgentReferenceBaseline, changeExternalAgent, stageExternalAgentOperation, type ExternalAgentOperation } from "../src/settings/external-agent-catalog";
import { ConfigWriteNotAuthorizedError } from "../src/settings/persistence";
import { localPersistedSaveBackend } from "../src/settings/persisted-save";
import type { PersistedSaveBackend, PersistedSaveSelection, PersistedSaveResult, StagedPersistedSave } from "../src/settings/persisted-save";
import { stagedToolProtectionSettings } from "../src/settings/tool-protection";
import type { ScopedModelChoice } from "../src/settings/models";
import type { PeerKey } from "../src/session-host/network/identity";
import type { OwnerReviewSettingsFacts, OwnerReviewSettingsGuard, OwnerReviewSettingsRequest } from "../src/session-host/network/peer-review-settings";
import type { ReviewSettingsCatalog } from "../src/session-host/review-settings-catalog";
import type { OwnedReviewSettingsInput } from "../src/session-host/review-settings";
import {
  encodeRemoteReviewSettingsSaveIntent,
} from "../src/session-host/remote-review-settings-data";
import {
  REMOTE_REVIEW_SETTINGS_MAX_OPENINGS,
  REMOTE_REVIEW_SETTINGS_OPENING_ID_BYTES,
  createOwnerReviewSettingsHandler,
  isRemoteReviewSettingsSaveEnvelope,
  type RemoteReviewSettingsLoadEnvelope,
  type RemoteReviewSettingsSaveEnvelope,
} from "../src/session-host/remote-review-settings-owner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_COMMAND = "/secret/owner-claude";
const SECRET_ARGV = "--owner-argv-secret";
const SECRET_ENV = "owner-env-secret";
const SECRET_REVIEW_ENV = "owner-review-env-secret";

/** One owner config carrying private worker bytes a load must never publish. */
function ownerConfig(): ReviewGateConfig {
  return normalizeConfig({
    enabled: false,
    reviewerTimeoutMs: 111_000,
    externalAgents: {
      w1: {
        adapter: "claude-cli",
        command: SECRET_COMMAND,
        args: [SECRET_ARGV],
        env: { OWNER_TOKEN: SECRET_ENV },
        model: "claude-opus-5-5",
        review: { model: "claude-sonnet-5-5", env: { OWNER_REVIEW_TOKEN: SECRET_REVIEW_ENV } },
        execution: { model: "claude-sonnet-5-5" },
      },
    },
  });
}

const SCOPED: ScopedModelChoice[] = [
  { model: "pi/fake-a", label: "fake-a [pi]", supportedThinkingLevels: ["off", "high"] },
  { model: "pi/fake-b", label: "fake-b [pi]", supportedThinkingLevels: ["off"] },
];

function catalog(options: { warnings?: string[]; scoped?: ScopedModelChoice[]; tools?: { name: string; description?: string }[] } = {}): ReviewSettingsCatalog {
  return {
    scoped: options.scoped ?? SCOPED,
    tools: options.tools ?? [
      { name: "Read", description: "read files" },
      { name: "Bash" },
      { name: "Write" },
      { name: "tool_search", description: "discovery loader" },
    ],
    warnings: options.warnings ?? [],
    modelScope: { source: "none", patterns: [] },
  };
}

interface Owner {
  readonly dir: string;
  readonly agentDir: string;
  readonly configPath: string;
  readonly input: OwnedReviewSettingsInput;
}

async function owner(options: {
  config?: unknown;
  explicit?: boolean;
  warnings?: string[];
  scoped?: ScopedModelChoice[];
  tools?: { name: string; description?: string }[];
  backend?: PersistedSaveBackend;
} = {}): Promise<{ owner: Owner; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(__dirname, "owner-review-settings-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(dir, "review-gate.json");
  if (options.config !== undefined) writeFileSync(configPath, `${JSON.stringify(options.config, null, 2)}\n`, "utf8");
  const env: NodeJS.ProcessEnv = options.explicit === false
    ? { HOME: dir }
    : { HOME: dir, PI_REVIEW_GATE_CONFIG: configPath };
  return {
    owner: { dir, agentDir, configPath, input: { env, agentDir, piExecutable: join(dir, "pi"), cwd: dir } },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function peer(keyId: string): PeerKey {
  return { keyId, fingerprint: `fp:${keyId}` };
}

function loadRequest(keyId: string, hostRunId: string): OwnerReviewSettingsRequest {
  return { kind: "load", hostRunId, peerKey: peer(keyId) };
}

function saveRequest(keyId: string, hostRunId: string, payload: unknown): OwnerReviewSettingsRequest {
  const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload));
  return { kind: "save", hostRunId, peerKey: peer(keyId), payload: bytes };
}

const ALWAYS: OwnerReviewSettingsGuard = () => true;

function payloadOf(facts: OwnerReviewSettingsFacts): Uint8Array {
  assert.equal(facts.kind, "accepted");
  if (facts.kind !== "accepted" || facts.payload === undefined) throw new Error("expected an accepted payload");
  return facts.payload;
}

function loadEnvelope(facts: OwnerReviewSettingsFacts): RemoteReviewSettingsLoadEnvelope {
  return JSON.parse(new TextDecoder().decode(payloadOf(facts))) as RemoteReviewSettingsLoadEnvelope;
}

function saveEnvelope(openingId: string, intent: unknown): RemoteReviewSettingsSaveEnvelope {
  return { openingId, intent: intent as RemoteReviewSettingsSaveEnvelope["intent"] };
}

function encodeSave(envelope: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function refuseReason(facts: OwnerReviewSettingsFacts): string {
  assert.equal(facts.kind, "refused", `expected a refusal, got ${JSON.stringify(facts)}`);
  return facts.kind === "refused" ? facts.reason : "";
}

function fileText(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Staged-save helpers: a real, valid editable intent for the owner opening
// ---------------------------------------------------------------------------

function selectionFor(opening: ReviewGateConfig, staged: ReviewGateConfig, operations: ExternalAgentOperation[] = []): PersistedSaveSelection {
  const review = effectiveReviewSettings(staged);
  const execution = staged.execution;
  const web = staged.web!;
  return {
    operatingMode: staged.operatingMode,
    modeCycleShortcut: staged.modeCycleShortcut,
    workerResources: cloneWorkerCatalog(execution?.workerResources ?? {}),
    executeRoute: (execution?.routes?.execute ?? []).map((entry) => ({ ...entry })),
    researchRoute: (execution?.routes?.research ?? []).map((entry) => ({ ...entry })),
    primaryReviewers: review.primaryReviewers.map((entry) => ({ ...entry })),
    subtaskReviewers: review.subtaskReviewers.map((entry) => ({ ...entry })),
    primaryEnabled: review.primaryEnabled,
    subtaskEnabled: review.subtaskEnabled,
    reviewLandedChanges: review.reviewLandedChanges,
    evidence: { ...effectiveReviewEvidenceSettings(staged) },
    reviewerTimeoutMs: staged.reviewerTimeoutMs,
    executorTimeoutMs: staged.executorTimeoutMs,
    maxCorrectionCycles: staged.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: staged.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: staged.retainBundles,
    deleteSpawnedPiSessionsOnCleanup: staged.deleteSpawnedPiSessionsOnCleanup === true,
    maxWorkers: execution?.maxWorkers ?? DEFAULT_MAX_WORKERS,
    retryPolicy: { ...(execution?.retryPolicy ?? DEFAULT_EXECUTION_RETRY_POLICY) },
    subtaskNotifications: execution?.subtaskNotifications ?? DEFAULT_SUBTASK_NOTIFICATION_MODE,
    deferredPiTools: execution?.deferredPiTools ?? false,
    subtasksViewExpanded: staged.ui?.subtasksViewExpanded === true,
    showSubtaskTaskIds: staged.ui?.showSubtaskTaskIds === true,
    scheduledTasks: cloneScheduledTaskCatalog(staged.scheduledTasks ?? {}),
    scheduledTasksStagedFrom: Object.keys(opening.scheduledTasks ?? {}),
    scheduledTasksAlreadyRunEdited: [],
    externalAgentOperations: operations,
    externalAgentOpening: structuredClone(opening),
    externalAgentReferenceBaselines: Object.fromEntries(
      Object.keys(opening.externalAgents ?? {}).map((id) => [id, captureExternalAgentReferenceBaseline(opening, id)]),
    ),
    webMaxDownloadBytes: web.fetch!.maxDownloadBytes,
    browserInteractionApproval: web.browserInteractionApproval!,
    browserIdleExpiryMinutes: web.browserIdleExpiryMinutes!,
    browserDownloadRetention: web.browserDownloadRetention!,
    browserVisible: web.browserVisible!,
    webBrowserPermissions: { ...web.browserPermissions },
    webUrlBlocklist: [...web.urlBlocklist],
    youShouldKnow: { ...staged.youShouldKnow! },
    tools: { topLevelDeny: [...(staged.tools?.topLevelDeny ?? [])], executorDeny: [...(staged.tools?.executorDeny ?? [])] },
    toolProtection: stagedToolProtectionSettings(staged),
  };
}

function stagedSave(opening: ReviewGateConfig, staged: ReviewGateConfig, operations: ExternalAgentOperation[] = []): StagedPersistedSave {
  return {
    configPath: "/owner/never-used.json",
    cwd: "/owner/never-used",
    config: opening,
    draftConfig: staged,
    scoped: [],
    selection: selectionFor(opening, staged, operations),
    scheduledImageProvenance: new Map(),
  };
}

/** A wire intent an ordinary, unedited owner opening round-trips exactly. */
function intentFor(opening: ReviewGateConfig): RemoteReviewSettingsSaveEnvelope["intent"] {
  return JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, opening))));
}

// ---------------------------------------------------------------------------
// Load: projected data only, no write, closed notices
// ---------------------------------------------------------------------------

test("a load re-reads the owner config, writes nothing, and publishes only projected data", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config, warnings: [] });
  try {
    const before = fileText(fixture.configPath);
    const beforeStats = statSync(fixture.configPath);
    const beforeEntries = readdirSync(fixture.dir).sort();
    const handler = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => {
        const choices = catalog();
        return { ...choices, tools: choices.tools.map((tool) => ({ ...tool, description: `Path: ${fixture.agentDir}` })) };
      },
    });

    const facts = await handler(loadRequest("peer-a", "run-1"), ALWAYS);
    const envelope = loadEnvelope(facts);
    const decoded = JSON.parse(new TextDecoder().decode(payloadOf(facts))) as Record<string, unknown>;

    // The exact fixed envelope shape.
    assert.deepEqual(Object.keys(decoded).sort(), ["firstUse", "notices", "opening", "openingId", "scoped", "tools"]);
    assert.match(envelope.openingId, new RegExp(`^[a-f0-9]{${REMOTE_REVIEW_SETTINGS_OPENING_ID_BYTES * 2}}$`));
    assert.equal(envelope.firstUse, false);
    assert.deepEqual(envelope.notices, []);
    assert.deepEqual(envelope.scoped, SCOPED);
    assert.deepEqual(envelope.tools, ["Read", "Bash", "Write", "tool_search"].map((name) => ({ name })));
    assert.equal(envelope.opening.version, 1);
    assert.equal(envelope.opening.config.enabled, false);
    assert.equal(envelope.opening.config.reviewerTimeoutMs, 111_000);
    assert.deepEqual(envelope.opening.config.externalAgents!.w1.review, { model: "claude-sonnet-5-5" });

    // No private byte, path, or diagnostic crosses the boundary.
    const text = JSON.stringify(envelope);
    for (const secret of [SECRET_COMMAND, SECRET_ARGV, SECRET_ENV, SECRET_REVIEW_ENV, fixture.configPath, fixture.agentDir, fixture.dir, "OWNER_TOKEN", "command", "args", "env"]) {
      assert.equal(text.includes(secret), false, `load envelope must not contain ${secret}`);
    }

    // A load never writes: the config bytes, timestamps, and directory are unchanged.
    assert.equal(fileText(fixture.configPath), before);
    assert.equal(statSync(fixture.configPath).mtimeMs, beforeStats.mtimeMs);
    assert.deepEqual(readdirSync(fixture.dir).sort(), beforeEntries);
  } finally {
    await cleanup();
  }
});

test("opening problems are closed notice codes, never raw diagnostics or paths", async () => {
  const invalidProtection = { enabled: false, toolProtection: { level: "on" } };
  const { owner: fixture, cleanup } = await owner({ config: invalidProtection, warnings: ["catalog-secret-diagnostic"] });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog({ warnings: ["catalog-secret-diagnostic"] }),
    });
    const facts = await handler(loadRequest("peer-a", "run-1"), ALWAYS);
    const envelope = loadEnvelope(facts);
    assert.deepEqual(envelope.notices, ["catalog-warning", "config-warning", "tool-protection-invalid"]);
    const text = JSON.stringify(envelope);
    assert.equal(text.includes("catalog-secret-diagnostic"), false);
    assert.equal(text.includes("toolProtection is invalid"), false);
    assert.equal(text.includes("protected calls stay blocked"), false);
    assert.equal(text.includes(fixture.configPath), false);
  } finally {
    await cleanup();
  }

  const unreadable = await owner({});
  try {
    writeFileSync(unreadable.owner.configPath, "{ not json", "utf8");
    const handler = createOwnerReviewSettingsHandler(unreadable.owner.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.deepEqual(envelope.notices, ["config-warning"]);
    assert.equal(JSON.stringify(envelope).includes("could not be read or parsed"), false);
  } finally {
    await unreadable.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Token scope: one run-bound opening per authenticated peer, bounded total
// ---------------------------------------------------------------------------

test("an opening token cannot cross peers or owner runs, and one load replaces the peer's previous token", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const a1 = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const b1 = loadEnvelope(await handler(loadRequest("peer-b", "run-2"), ALWAYS));
    const a2 = loadEnvelope(await handler(loadRequest("peer-a", "run-2"), ALWAYS));
    assert.notEqual(a1.openingId, b1.openingId);
    assert.notEqual(a1.openingId, a2.openingId);

    const intent = intentFor(config);
    intent.maxWorkers = 4;
    const before = fileText(fixture.configPath);

    // Another peer's token, a mismatched run, and the run-1 token that this
    // peer's later load replaced are all stale and never reach the backend.
    assert.equal(refuseReason(await handler(saveRequest("peer-b", "run-2", saveEnvelope(a2.openingId, intent)), ALWAYS)), "stale");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(a2.openingId, intent)), ALWAYS)), "stale");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(a1.openingId, intent)), ALWAYS)), "stale");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope("f".repeat(64), intent)), ALWAYS)), "stale");
    assert.equal(fileText(fixture.configPath), before);

    // The peer's own current run-bound token still works, after the failures.
    assert.deepEqual(await handler(saveRequest("peer-a", "run-2", saveEnvelope(a2.openingId, intent)), ALWAYS), { kind: "accepted" });
    assert.equal(JSON.parse(fileText(fixture.configPath)).execution.maxWorkers, 4);

    // A fresh load for the same peer and run replaces the token again.
    const a3 = loadEnvelope(await handler(loadRequest("peer-a", "run-2"), ALWAYS));
    assert.notEqual(a3.openingId, a2.openingId);
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-2", saveEnvelope(a2.openingId, intent)), ALWAYS)), "stale");
    assert.deepEqual(await handler(saveRequest("peer-a", "run-2", saveEnvelope(a3.openingId, intent)), ALWAYS), { kind: "accepted" });
  } finally {
    await cleanup();
  }
});

test("a later authenticated connection for the same peer and owner run reuses the current opening", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    // The session host keeps ONE provider across roster connections, so the
    // owner memory is not bound to a channel binding or to one guard instance:
    // after an Auto reconnect the requester's original token is still current
    // for the same authenticated peer key id and owner run.
    const first = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await first(loadRequest("peer-a", "run-1"), ALWAYS));
    const intent = intentFor(config);
    intent.maxWorkers = 6;
    // A NEW live guard instance from the reconnected binding.
    const freshGuard: OwnerReviewSettingsGuard = () => true;
    assert.deepEqual(await first(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), freshGuard), { kind: "accepted" });
    assert.equal(JSON.parse(fileText(fixture.configPath)).execution.maxWorkers, 6);
  } finally {
    await cleanup();
  }
});

test("retained openings are bounded and an evicted token is stale", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const first = loadEnvelope(await handler(loadRequest("peer-0", "run-1"), ALWAYS));
    for (let index = 1; index <= REMOTE_REVIEW_SETTINGS_MAX_OPENINGS; index += 1) {
      await handler(loadRequest(`peer-${index}`, "run-1"), ALWAYS);
    }
    const intent = intentFor(config);
    intent.maxWorkers = 4;
    // The oldest entry was evicted, so its token can no longer publish.
    assert.equal(refuseReason(await handler(saveRequest("peer-0", "run-1", saveEnvelope(first.openingId, intent)), ALWAYS)), "stale");
    const current = loadEnvelope(await handler(loadRequest(`peer-${REMOTE_REVIEW_SETTINGS_MAX_OPENINGS}`, "run-1"), ALWAYS));
    assert.deepEqual(await handler(saveRequest(`peer-${REMOTE_REVIEW_SETTINGS_MAX_OPENINGS}`, "run-1", saveEnvelope(current.openingId, intent)), ALWAYS), { kind: "accepted" });
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Save: owner baselines, retryable refusals, replay protection
// ---------------------------------------------------------------------------

test("a successful save uses owner-held baselines, retires its token, and cannot be replayed", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    writeFileSync(fixture.configPath, `${JSON.stringify({ ...config, "x-owner-raw": "keep-me" }, null, 2)}\n`, "utf8");
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const intent = intentFor(config);
    intent.maxWorkers = 5;
    const save = saveEnvelope(envelope.openingId, intent);

    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", save), ALWAYS), { kind: "accepted" });
    const saved = JSON.parse(fileText(fixture.configPath)) as Record<string, unknown>;
    assert.equal((saved.execution as { maxWorkers: number }).maxWorkers, 5);
    // Unknown/raw owner fields are still the shared merge's business.
    assert.equal(saved["x-owner-raw"], "keep-me");
    // Owner-held private worker bytes are preserved by the merge, never resent.
    const agents = saved.externalAgents as Record<string, { env?: Record<string, string> }>;
    assert.deepEqual(agents.w1.env, { OWNER_TOKEN: SECRET_ENV });

    const bytes = fileText(fixture.configPath);
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", save), ALWAYS)), "stale");
    assert.equal(fileText(fixture.configPath), bytes);
  } finally {
    await cleanup();
  }
});

test("a confirmed save reports exactly the scheduled tasks its own rule auto-disabled", async () => {
  const { owner: fixture, cleanup } = await owner();
  try {
    // One workspace-pinned execute task, one already manually disabled task on
    // the same pin, and one on a second worker. Only the first is auto-disabled
    // by the shared rule when the remote edit removes that worker.
    const config = normalizeConfig({
      execution: {
        workerResources: {
          "pi-a": { selection: { source: "pi", model: "pi/fake-a", thinkingLevel: "high" }, maxConcurrent: 2 },
          "pi-b": { selection: { source: "pi", model: "pi/fake-b" }, maxConcurrent: 1 },
        },
        routes: {
          execute: [{ resourceId: "pi-a", thinkingLevel: "high" }],
          research: [{ resourceId: "pi-b" }],
        },
      },
      scheduledTasks: {
        pinned: {
          name: "Nightly",
          cron: "0 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Run the overnight check",
          workspace: fixture.dir,
          workerResourceId: "pi-a",
        },
        "manual-off": {
          name: "Already off",
          cron: "0 3 * * *",
          enabled: false,
          kind: "execute",
          instructions: "Never dispatched",
          workspace: fixture.dir,
          workerResourceId: "pi-a",
        },
        kept: {
          name: "Keep",
          cron: "0 4 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Stays runnable",
          workspace: fixture.dir,
          workerResourceId: "pi-b",
        },
      },
    });
    writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));

    const intent = intentFor(config);
    // The remote editor removes the worker resource "pinned" points at.
    delete intent.workerResources["pi-a"];
    intent.executeRoute = [];
    const save = saveEnvelope(envelope.openingId, intent);

    const facts = await handler(saveRequest("peer-a", "run-1", save), ALWAYS);
    // Exactly one structured identity, and no task name, worker id, path, or
    // message text: only the id of the entry THIS save auto-disabled.
    assert.deepEqual(facts, {
      kind: "accepted",
      receipt: { disabledTaskIds: ["pinned"], additionalDisabledCount: 0 },
    });
    const saved = JSON.parse(fileText(fixture.configPath)) as {
      scheduledTasks: Record<string, { enabled: boolean }>;
    };
    assert.equal(saved.scheduledTasks.pinned!.enabled, false, "the shared rule disabled the pinned task");
    assert.equal(saved.scheduledTasks["manual-off"]!.enabled, false, "a manual disable is never reported as auto-disabled");
    assert.equal(saved.scheduledTasks.kept!.enabled, true, "an unaffected task stays enabled");
  } finally {
    await cleanup();
  }
});

test("malformed and unauthorized drafts publish nothing and keep the opening for a retry", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const before = fileText(fixture.configPath);
    const intent = intentFor(config);
    intent.maxWorkers = 3;

    // A forged extra field the envelope schema cannot express.
    const forged = structuredClone(intent) as unknown as Record<string, unknown>;
    forged.path = "/owner/secret/review-gate.json";
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, forged)), ALWAYS)), "invalid-draft");

    // A changed web download cap that is not a whole number of MiB.
    const badCap = structuredClone(intent);
    badCap.webMaxDownloadBytes = 3_000_000;
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, badCap)), ALWAYS)), "invalid-draft");

    // Exercise the destination's shared cron validation without a network request.
    const invalidSchedule = structuredClone(intent);
    const taskId = "task-0123abcd";
    invalidSchedule.scheduledTasks[taskId] = {
      name: "Fixture schedule", cron: "*/00 * * * *", enabled: true,
      kind: "execute", destination: "orchestrator-turn", instructions: "Check the fixture.", workspace: "",
    };
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, invalidSchedule)), ALWAYS)), "invalid-draft");
    assert.equal(fileText(fixture.configPath), before);
    intent.scheduledTasks[taskId] = { ...invalidSchedule.scheduledTasks[taskId], cron: "*/05 * * * *" };

    // A denied reserved discovery loader is not offered by the deny pickers.
    const loaderDenied = structuredClone(intent);
    loaderDenied.tools.topLevelDeny = ["tool_search"];
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, loaderDenied)), ALWAYS)), "invalid-draft");

    // Malformed envelopes are refused without touching the opening.
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", { openingId: envelope.openingId }), ALWAYS)), "invalid-draft");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", { intent }), ALWAYS)), "invalid-draft");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", { openingId: 7, intent }), ALWAYS)), "invalid-draft");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", new Uint8Array([0xff])), ALWAYS)), "invalid-draft");
    assert.equal(fileText(fixture.configPath), before);

    // The same opening is still current, so a corrected draft succeeds.
    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS), { kind: "accepted" });
    const saved = JSON.parse(fileText(fixture.configPath));
    assert.equal(saved.execution.maxWorkers, 3);
    assert.equal(saved.scheduledTasks[taskId].cron, "*/05 * * * *");
  } finally {
    await cleanup();
  }
});

test("owner model and tool inventories are authoritative for the draft", async () => {
  const config = normalizeConfig({
    enabled: false,
    toolProtection: {
      level: "aligned",
      auditor: { source: "pi", model: "pi/fake-a", thinkingLevel: "high" },
      scope: "selected",
      toolNames: ["Read"],
    },
  });
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.deepEqual(envelope.notices, []);
    assert.equal(envelope.tools.some((tool) => tool.name === "tool_search"), true);

    const intent = intentFor(config);

    // An owner-offered audit name is accepted.
    const offered = structuredClone(intent);
    offered.toolProtection.toolNames = ["Read", "Write"];
    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, offered)), ALWAYS), { kind: "accepted" });
    // A confirmed save retires that token, so each further attempt reopens.
    const reopened = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));

    // An auditor outside the owner's scoped models is not offered.
    const foreignAuditor = structuredClone(intent);
    foreignAuditor.toolProtection.auditor = { source: "pi", model: "pi/not-offered" } as never;
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(reopened.openingId, foreignAuditor)), ALWAYS)), "invalid-draft");

    // A tool name the owner does not offer is refused.
    const foreignTool = structuredClone(intent);
    foreignTool.tools.executorDeny = ["NotOffered"];
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(reopened.openingId, foreignTool)), ALWAYS)), "invalid-draft");
  } finally {
    await cleanup();
  }
});

test("a live guard refusal is policy before any owner work, and a shared destination refusal is policy too", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    let loads = 0;
    const handler = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => {
        loads += 1;
        return catalog();
      },
    });
    // A revoked destination performs no owner read at all.
    assert.equal(refuseReason(await handler(loadRequest("peer-a", "run-1"), () => false)), "policy");
    assert.equal(loads, 0);
    const throwing: OwnerReviewSettingsGuard = () => {
      throw new Error("guard fault");
    };
    assert.equal(refuseReason(await handler(loadRequest("peer-a", "run-1"), throwing)), "policy");
    assert.equal(loads, 0);

    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const before = fileText(fixture.configPath);
    const intent = intentFor(config);
    intent.maxWorkers = 7;

    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), () => false)), "policy");
    assert.equal(fileText(fixture.configPath), before);

    // The shared backend's own destination refusal is the same closed policy
    // reason, with no exception text exposed.
    const refusing = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: { saveStaged: async () => { throw new ConfigWriteNotAuthorizedError("secret destination text"); } },
    });
    const refusedEnvelope = loadEnvelope(await refusing(loadRequest("peer-a", "run-1"), ALWAYS));
    const facts = await refusing(saveRequest("peer-a", "run-1", saveEnvelope(refusedEnvelope.openingId, intent)), ALWAYS);
    assert.deepEqual(facts, { kind: "refused", reason: "policy" });
    assert.equal(fileText(fixture.configPath), before);

    // A load whose authorization is revoked after its token was minted but
    // before the opening is retained must publish nothing and retain nothing.
    // Submitting that EXACT issued token (not an unrelated one) proves it.
    const token = "a".repeat(64);
    let minted = false;
    const revoking = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      createOpeningId: () => {
        minted = true;
        return token;
      },
    });
    const factsAfterRevocation = await revoking(loadRequest("peer-b", "run-1"), () => !minted);
    assert.equal(minted, true, "the opening token was generated before retention");
    assert.equal(refuseReason(factsAfterRevocation), "policy");
    assert.equal(refuseReason(await revoking(saveRequest("peer-b", "run-1", saveEnvelope(token, intent)), ALWAYS)), "stale");
    assert.equal(fileText(fixture.configPath), before);
  } finally {
    await cleanup();
  }
});

test("a shared conflict is reported only for a fixed external-worker guard; everything else is unknown", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const intent = intentFor(config);
    intent.maxWorkers = 4;
    const results: PersistedSaveResult[] = [
      {
        kind: "conflict",
        scheduledTasks: {},
        error: "Cannot save external worker changes: An edited external worker changed or disappeared on disk. Reopen settings before saving.",
      },
    ];
    const conflicted = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: { saveStaged: async () => results[0]! },
    });
    const conflictOpening = loadEnvelope(await conflicted(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.equal(refuseReason(await conflicted(saveRequest("peer-a", "run-1", saveEnvelope(conflictOpening.openingId, intent)), ALWAYS)), "conflict");

    // A post-rename fault shares the conflict kind but is not a fixed guard
    // message: it must stay unknown, never a definite no-write claim.
    const unknown = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: {
        saveStaged: async () => ({
          kind: "conflict",
          scheduledTasks: {},
          error: "Cannot save external worker changes: EACCES: /owner/secret/review-gate.json",
        }),
      },
    });
    const unknownOpening = loadEnvelope(await unknown(loadRequest("peer-a", "run-1"), ALWAYS));
    const unknownFacts = await unknown(saveRequest("peer-a", "run-1", saveEnvelope(unknownOpening.openingId, intent)), ALWAYS);
    assert.deepEqual(unknownFacts, { kind: "unknown" });

    // A throwing shared backend is unknown, and its raw text never escapes.
    const throwing = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: { saveStaged: async () => { throw new Error("EACCES: /owner/secret/review-gate.json"); } },
    });
    const throwingOpening = loadEnvelope(await throwing(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.deepEqual(await throwing(saveRequest("peer-a", "run-1", saveEnvelope(throwingOpening.openingId, intent)), ALWAYS), { kind: "unknown" });

    // The shared backend's invalid-draft result is the owner's invalid-draft.
    const invalid = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: { saveStaged: async () => ({ kind: "invalid", scheduledTasks: {}, error: "review gate: cron must not be empty" }) },
    });
    const invalidOpening = loadEnvelope(await invalid(loadRequest("peer-a", "run-1"), ALWAYS));
    const invalidFacts = await invalid(saveRequest("peer-a", "run-1", saveEnvelope(invalidOpening.openingId, intent)), ALWAYS);
    assert.deepEqual(invalidFacts, { kind: "refused", reason: "invalid-draft" });
  } finally {
    await cleanup();
  }
});

test("a real shared external-worker guard is reported as conflict and writes nothing", async () => {
  const config = normalizeConfig({
    enabled: false,
    externalAgents: {
      w1: { adapter: "claude-cli", model: "claude-opus-5-5", review: { model: "claude-sonnet-5-5" } },
    },
  });
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const before = fileText(fixture.configPath);
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));

    // Build a real external-worker edit over the projected opening, exactly as
    // the remote menu does, then change the agent on disk after the open.
    const projected = envelope.opening.config;
    const edited = normalizeConfig({
      externalAgents: { w1: { adapter: "claude-cli", model: "claude-haiku-4-5", review: { model: "claude-haiku-4-5" } } },
    }).externalAgents!.w1!;
    const draft = changeExternalAgent(projected, "w1", "w1", edited).config;
    const operations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(operations, projected, "w1", "w1", edited);
    const intent = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(config, draft, operations))));

    const changedOnDisk = structuredClone(config);
    changedOnDisk.externalAgents!.w1!.model = "claude-sonnet-5-5";
    writeFileSync(fixture.configPath, `${JSON.stringify(changedOnDisk, null, 2)}\n`, "utf8");
    const diskBytes = fileText(fixture.configPath);

    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS)), "conflict");
    assert.equal(fileText(fixture.configPath), diskBytes);
    assert.notEqual(diskBytes, before);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Guarded first use
// ---------------------------------------------------------------------------

test("guarded first use publishes the config only on an explicit save", async () => {
  const { owner: fixture, cleanup } = await owner({ explicit: false });
  try {
    const primary = join(fixture.agentDir, "review-gate.json");
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.equal(envelope.firstUse, true);
    assert.deepEqual(envelope.notices, []);
    // Opening and cancelling never create the file.
    assert.equal(existsSync(primary), false);

    const intent = intentFor(normalizeConfig({}));
    intent.maxWorkers = 5;
    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS), { kind: "accepted" });
    assert.equal(existsSync(primary), true);
    assert.equal(JSON.parse(fileText(primary)).execution.maxWorkers, 5);
  } finally {
    await cleanup();
  }
});

test("guarded first use refuses when another config appeared after the open", async () => {
  const { owner: fixture, cleanup } = await owner({ explicit: false });
  try {
    const primary = join(fixture.agentDir, "review-gate.json");
    const compatibility = join(fixture.dir, ".config", "pi-review-gate", "config.json");
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.equal(envelope.firstUse, true);

    // The compatibility fallback appears while the menu is open: the draft is
    // never retargeted and the primary is never created.
    mkdirSync(join(fixture.dir, ".config", "pi-review-gate"), { recursive: true });
    writeFileSync(compatibility, `${JSON.stringify(normalizeConfig({ enabled: false }), null, 2)}\n`, "utf8");
    const compatibilityBytes = fileText(compatibility);

    const intent = intentFor(normalizeConfig({}));
    intent.maxWorkers = 5;
    const facts = await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS);
    assert.deepEqual(facts, { kind: "unknown" });
    assert.equal(existsSync(primary), false);
    assert.equal(fileText(compatibility), compatibilityBytes);
  } finally {
    await cleanup();
  }
});

/** A save backend that parks inside `saveStaged` until the test releases it. */
function gatedBackend(): { backend: PersistedSaveBackend; entered: Promise<void>; release: () => void; calls: () => number } {
  let enter: () => void = () => undefined;
  let open: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let calls = 0;
  return {
    backend: {
      saveStaged: async (request) => {
        calls += 1;
        enter();
        await gate;
        return localPersistedSaveBackend.saveStaged(request);
      },
    },
    entered,
    release: () => open(),
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Single-use claims across authenticated bindings
// ---------------------------------------------------------------------------

test("a save claims its opening: an overlapping save is busy and the loser publishes nothing", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const gate = gatedBackend();
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog(), backend: gate.backend });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const first = intentFor(config);
    first.maxWorkers = 4;
    const second = intentFor(config);
    second.maxWorkers = 7;
    const before = fileText(fixture.configPath);

    const pending = handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, first)), ALWAYS);
    await gate.entered;
    assert.equal(gate.calls(), 1, "the first save entered the shared backend");

    // The same token presented by a SECOND authenticated binding while the
    // first save is inside the shared backend.
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, second)), ALWAYS)), "busy");
    assert.equal(gate.calls(), 1, "the second save never reached the shared backend");
    assert.equal(fileText(fixture.configPath), before);

    gate.release();
    assert.deepEqual(await pending, { kind: "accepted" });
    assert.equal((JSON.parse(fileText(fixture.configPath)) as { execution: { maxWorkers: number } }).execution.maxWorkers, 4);
    // The winner retired the exact token, so a later replay is stale, not busy.
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, second)), ALWAYS)), "stale");
  } finally {
    await cleanup();
  }
});

test("an in-flight save cannot publish after a new load replaced its opening", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const gate = gatedBackend();
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog(), backend: gate.backend });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const intent = intentFor(config);
    intent.maxWorkers = 4;
    const before = fileText(fixture.configPath);

    const pending = handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS);
    await gate.entered;
    // A newer load for the same peer+run replaces the opening while the save is
    // parked, so the shared backend's guard no longer names the claimed one.
    const replacement = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.notEqual(replacement.openingId, envelope.openingId);

    gate.release();
    assert.equal(refuseReason(await pending), "stale");
    assert.equal(fileText(fixture.configPath), before);

    // The replacement opening is unaffected and can still publish.
    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saveEnvelope(replacement.openingId, intent)), ALWAYS), { kind: "accepted" });
    assert.equal((JSON.parse(fileText(fixture.configPath)) as { execution: { maxWorkers: number } }).execution.maxWorkers, 4);
  } finally {
    await cleanup();
  }
});

test("an in-flight save cannot publish after bounded-memory eviction removed its opening", async () => {
  const config = ownerConfig();
  const { owner: fixture, cleanup } = await owner({ config });
  try {
    const gate = gatedBackend();
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog(), backend: gate.backend });
    const envelope = loadEnvelope(await handler(loadRequest("peer-0", "run-1"), ALWAYS));
    const intent = intentFor(config);
    intent.maxWorkers = 4;
    const before = fileText(fixture.configPath);

    const pending = handler(saveRequest("peer-0", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS);
    await gate.entered;
    // Fill the bounded memory so the parked save's opening is the evicted one.
    for (let index = 1; index <= REMOTE_REVIEW_SETTINGS_MAX_OPENINGS; index += 1) {
      await handler(loadRequest(`peer-${index}`, "run-1"), ALWAYS);
    }

    gate.release();
    assert.equal(refuseReason(await pending), "stale");
    assert.equal(fileText(fixture.configPath), before);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// First use: the initializer's own publication is never reported as a no-write
// ---------------------------------------------------------------------------

test("a first-use save whose initializer published the default is not reported as a definite no-write", async () => {
  const { owner: fixture, cleanup } = await owner({ explicit: false });
  try {
    const primary = join(fixture.agentDir, "review-gate.json");
    const handler = createOwnerReviewSettingsHandler(fixture.input, { loadChoices: async () => catalog() });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.equal(envelope.firstUse, true);
    assert.equal(existsSync(primary), false);
    const intent = intentFor(normalizeConfig({}));
    intent.maxWorkers = 5;

    // Live authorization is revoked the moment the guarded initializer has
    // created the destination, so the shared write refuses after publication.
    const guard: OwnerReviewSettingsGuard = () => !existsSync(primary);
    const facts = await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), guard);

    // Not a definite no-write refusal: the default config DID appear.
    assert.deepEqual(facts, { kind: "unknown" });
    assert.equal(existsSync(primary), true);
    const written = JSON.parse(fileText(primary)) as { execution?: { maxWorkers?: number } };
    assert.notEqual(written.execution?.maxWorkers, 5, "the staged edit was never saved");
  } finally {
    await cleanup();
  }
});

test("replacement after first-use publication leaves the save outcome unknown", async () => {
  const { owner: fixture, cleanup } = await owner({ explicit: false });
  try {
    const primary = join(fixture.agentDir, "review-gate.json");
    let replacement: RemoteReviewSettingsLoadEnvelope | undefined;
    // The real backend and the real guarded initializer run; the wrapper only
    // replaces this peer's opening once the destination has been published.
    // Nothing is asserted inside the hook: the owner converts a hook error into
    // the same `unknown` result this test expects, so the checks below run after
    // the save returns.
    const handler: ReturnType<typeof createOwnerReviewSettingsHandler> = createOwnerReviewSettingsHandler(fixture.input, {
      loadChoices: async () => catalog(),
      backend: {
        saveStaged: (request) => localPersistedSaveBackend.saveStaged({
          ...request,
          beforePersist: async () => {
            await request.beforePersist?.();
            replacement = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
          },
        }),
      },
    });
    const opening = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    assert.equal(opening.firstUse, true);
    const intent = intentFor(normalizeConfig({}));
    intent.maxWorkers = 5;

    // The destination changed (absent → default) even though the staged write
    // could not proceed, so the outcome must not claim a definite no-write.
    assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saveEnvelope(opening.openingId, intent)), ALWAYS), { kind: "unknown" });
    assert.ok(replacement, "the replacement load completed");
    assert.equal(replacement.firstUse, false);
    assert.notEqual(replacement.openingId, opening.openingId);
    assert.equal(existsSync(primary), true);
    const written = JSON.parse(fileText(primary)) as { execution?: { maxWorkers?: number } };
    assert.notEqual(written.execution?.maxWorkers, 5);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

test("the save envelope is exactly one opening token plus one decoded intent", () => {
  assert.equal(isRemoteReviewSettingsSaveEnvelope({ openingId: "a".repeat(64), intent: {} }), true);
  for (const value of [
    null,
    "x",
    [],
    { openingId: "a".repeat(64) },
    { intent: {} },
    { openingId: "", intent: {} },
    { openingId: 1, intent: {} },
    { openingId: "a".repeat(64), intent: {}, path: "/owner/x.json" },
  ]) {
    assert.equal(isRemoteReviewSettingsSaveEnvelope(value), false, `${JSON.stringify(value)} must be refused`);
  }
});
