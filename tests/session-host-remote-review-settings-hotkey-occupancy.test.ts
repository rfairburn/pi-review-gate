/**
 * Issue #716 local-review follow-up: the OWNER's hotkey-occupancy wiring for
 * remote Review settings.
 *
 * The in-Pi occupancy check (`findOccupiedHostBindings`) reports itself
 * unresolved in a standalone session host, because no live Pi keybinding
 * manager exists in that process. The owner therefore gets the DESTINATION
 * Pi's own resolved bindings: the app/TUI defaults of the Pi install this host
 * actually launches, plus that destination agent directory's native
 * `keybindings.json` overrides. This suite drives the real
 * `createDestinationHostKeyOccupancy` resolver through the real owner handler
 * (the same arguments `Main` passes) over a synthetic destination Pi install:
 *
 * - a chord occupied only on the destination (by its native keybindings file)
 *   refuses the remote edit and leaves the destination bytes unchanged;
 * - a destination Pi default alone is enough to refuse, and the values come
 *   from the installed package's own manager, never from a table here;
 * - the requester's own bindings never veto an edit the destination accepts,
 *   including through the real remote menu, while malformed syntax is still
 *   rejected there;
 * - unsafe destination keybindings files (directory, symlink, oversized) and
 *   an unrelated/uncontained Pi package boundary stay truthful
 *   (`resolved: false`) instead of being reopened or substituted;
 * - an unavailable destination Pi install stays truthful (`resolved: false`)
 *   exactly like the existing in-Pi fallback, so no occupancy is guessed.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  DEFAULT_DEFERRED_PI_TOOLS,
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
import { createDestinationHostKeyOccupancy, setHostKeybindingLoader } from "../src/host-keybindings";
import type { PeerKey } from "../src/session-host/network/identity";
import type {
  OwnerReviewSettingsFacts,
  OwnerReviewSettingsGuard,
  OwnerReviewSettingsRequest,
  PeerReviewSettingsLoadOutcome,
  PeerReviewSettingsResult,
  PeerReviewSettingsSaveOutcome,
} from "../src/session-host/network/peer-review-settings";
import { openRemoteReviewSettings } from "../src/session-host/remote-review-settings-viewer";
import type { ReviewSettingsCatalog } from "../src/session-host/review-settings-catalog";
import type { OwnedReviewSettingsInput } from "../src/session-host/review-settings";
import {
  encodeRemoteReviewSettingsSaveIntent,
  projectRemoteReviewSettingsOpening,
} from "../src/session-host/remote-review-settings-data";
import {
  createOwnerReviewSettingsHandler,
  type RemoteReviewSettingsLoadEnvelope,
  type RemoteReviewSettingsSaveEnvelope,
} from "../src/session-host/remote-review-settings-owner";
import { captureExternalAgentReferenceBaseline } from "../src/settings/external-agent-catalog";
import { selectModeCycleShortcut } from "../src/settings/controls";
import type { ScopedModelChoice } from "../src/settings/models";
import type { PersistedSaveSelection, StagedPersistedSave } from "../src/settings/persisted-save";
import { stagedToolProtectionSettings } from "../src/settings/tool-protection";
import type { UiContext } from "../src/settings/ui";
import {
  closeWithSignal,
  createHarness,
  FakePeerCoordinator,
  ready,
} from "./helpers/session-host-main-harness";

// ---------------------------------------------------------------------------
// A synthetic destination Pi install and destination agent directory
// ---------------------------------------------------------------------------

interface PiInstall {
  readonly root: string;
  readonly executable: string;
}

/**
 * One synthetic Pi install carrying the public shape the real agent package
 * exposes for keybindings: `migrateKeybindingsConfig`, the value schema, and
 * `KeybindingsManager(userBindings)`. The defaults live in the FIXTURE, so the
 * production resolver has to ask the installed package for them; typebox's
 * `Compile` is simulated by the install's own dependency.
 */
function writeFakePiInstall(directory: string, defaults: Record<string, string>): PiInstall {
  const root = join(directory, "pi");
  mkdirSync(join(root, "dist", "core"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "1.6.0",
    type: "module",
    main: "index.js",
    bin: { pi: "dist/cli.js" },
  })}\n`, "utf8");
  writeFileSync(join(root, "index.js"), "", "utf8");
  writeFileSync(join(root, "dist", "cli.js"), "", "utf8");
  writeFileSync(join(root, "dist", "core", "keybindings.js"), `
const DEFAULTS = ${JSON.stringify(defaults)};

const LEGACY_NAMES = { cycleModelForward: "app.model.cycleForward" };

export function migrateKeybindingsConfig(rawConfig) {
  const config = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    config[LEGACY_NAMES[key] ?? key] = value;
  }
  return { config, migrated: false };
}

export class KeybindingsManager {
  constructor(userBindings = {}) {
    this.resolved = { ...DEFAULTS, ...userBindings };
  }

  getResolvedBindings() {
    return { ...this.resolved };
  }
}
`, "utf8");
  writeFileSync(join(root, "dist", "core", "keybindings-schema.js"),
    "export const KeybindingValueSchema = { kind: \"fixture-keybinding-value\" };\n", "utf8");
  mkdirSync(join(root, "node_modules", "typebox"), { recursive: true });
  writeFileSync(join(root, "node_modules", "typebox", "compile.js"), `
export function Compile(_schema) {
  return {
    Check(value) {
      return typeof value === "string"
        || (Array.isArray(value) && value.every((key) => typeof key === "string"));
    },
  };
}
`, "utf8");
  return { root, executable: join(root, "dist", "cli.js") };
}

interface Side {
  readonly agentDir: string;
  readonly configPath: string;
  readonly input: OwnedReviewSettingsInput;
}

function side(root: string, name: string, install: PiInstall): Side {
  const agentDir = join(root, `${name}-agent`);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const configPath = join(root, `${name}-review-gate.json`);
  writeFileSync(configPath, `${JSON.stringify(normalizeConfig({ enabled: true }), null, 2)}\n`, { mode: 0o600 });
  return {
    agentDir,
    configPath,
    input: {
      env: { HOME: root, PI_REVIEW_GATE_CONFIG: configPath },
      agentDir,
      piExecutable: install.executable,
      cwd: root,
    },
  };
}

function writeNativeKeybindings(agentDir: string, bindings: Record<string, string>): void {
  writeFileSync(join(agentDir, "keybindings.json"), `${JSON.stringify(bindings)}\n`, { mode: 0o600 });
}

/** The owner wiring `Main` composes: the real resolver plus the default factory. */
function wireOwner(owner: Side, install: PiInstall | undefined): ReturnType<typeof createOwnerReviewSettingsHandler> {
  return createOwnerReviewSettingsHandler(owner.input, {
    loadChoices: async () => catalog(),
    hostKeyOccupancy: createDestinationHostKeyOccupancy({
      agentDir: owner.agentDir,
      piExecutable: install?.executable,
    }),
  });
}

const SCOPED: ScopedModelChoice[] = [
  { model: "pi/fake-a", label: "fake-a [pi]", supportedThinkingLevels: ["off"] },
];

function catalog(): ReviewSettingsCatalog {
  return {
    scoped: SCOPED,
    tools: [{ name: "Read" }, { name: "Bash" }],
    warnings: [],
    modelScope: { source: "none", patterns: [] },
  };
}

// ---------------------------------------------------------------------------
// Owner exchange helpers (the existing closed load/save envelopes)
// ---------------------------------------------------------------------------

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

function refuseReason(facts: OwnerReviewSettingsFacts): string {
  assert.equal(facts.kind, "refused", `expected a refusal, got ${JSON.stringify(facts)}`);
  return facts.kind === "refused" ? facts.reason : "";
}

function fileText(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// A complete editable intent over the owner opening
// ---------------------------------------------------------------------------

function selectionFor(opening: ReviewGateConfig, staged: ReviewGateConfig): PersistedSaveSelection {
  const review = effectiveReviewSettings(staged);
  const execution = staged.execution;
  const web = staged.web ?? DEFAULT_CONFIG.web!;
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
    primaryClaudeCodeEnabled: review.primaryClaudeCodeEnabled,
    primaryCodexEnabled: review.primaryCodexEnabled,
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
    deferredPiTools: execution?.deferredPiTools ?? DEFAULT_DEFERRED_PI_TOOLS,
    subtasksViewExpanded: staged.ui?.subtasksViewExpanded === true,
    showSubtaskTaskIds: staged.ui?.showSubtaskTaskIds === true,
    scheduledTasks: cloneScheduledTaskCatalog(staged.scheduledTasks ?? {}),
    scheduledTasksStagedFrom: Object.keys(opening.scheduledTasks ?? {}),
    scheduledTasksAlreadyRunEdited: [],
    externalAgentOperations: [],
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
    youShouldKnow: { ...(staged.youShouldKnow ?? DEFAULT_CONFIG.youShouldKnow!) },
    tools: { topLevelDeny: [...(staged.tools?.topLevelDeny ?? [])], executorDeny: [...(staged.tools?.executorDeny ?? [])] },
    toolProtection: stagedToolProtectionSettings(staged),
  };
}

function stagedSave(opening: ReviewGateConfig, staged: ReviewGateConfig): StagedPersistedSave {
  return {
    configPath: "/owner/never-used.json",
    cwd: "/owner/never-used",
    config: opening,
    draftConfig: staged,
    scoped: [],
    selection: selectionFor(opening, staged),
    scheduledImageProvenance: new Map(),
  };
}

/** One wire intent changing only the mode-cycle shortcut. */
function shortcutIntent(opening: ReviewGateConfig, shortcut: string): RemoteReviewSettingsSaveEnvelope["intent"] {
  const projected = projectRemoteReviewSettingsOpening(opening).config;
  const intent = JSON.parse(JSON.stringify(encodeRemoteReviewSettingsSaveIntent(stagedSave(opening, projected)))) as {
    modeCycleShortcut: string;
  };
  intent.modeCycleShortcut = shortcut;
  return intent as RemoteReviewSettingsSaveEnvelope["intent"];
}

function withFixture(action: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-remote-hotkey-")));
  return action(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------
// Scripted requester menu (the remote viewer's plain-selector path)
// ---------------------------------------------------------------------------

interface ScriptedMenu {
  readonly ui: UiContext;
  readonly shown: Array<{ title: string; options: string[] }>;
  readonly notices: Array<{ message: string; type?: string }>;
}

function scriptedMenu(
  steps: Array<string | undefined>,
  texts: Array<string | undefined> = [],
): ScriptedMenu {
  const shown: ScriptedMenu["shown"] = [];
  const notices: ScriptedMenu["notices"] = [];
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
  return { ui, shown, notices };
}

// ---------------------------------------------------------------------------
// Destination occupancy through the real owner wiring
// ---------------------------------------------------------------------------

test("a destination-only occupied chord is refused and leaves the destination bytes unchanged", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    // A legacy id exercises the admitted Pi package's own migration API.
    writeNativeKeybindings(destination.agentDir, { cycleModelForward: "alt+k" });

    // The requester's own Pi does not occupy the chord at all.
    const requesterInstall = writeFakePiInstall(join(root, "requester"), {
      "app.model.cycleForward": "alt+p",
    });
    const requester = side(root, "requester", requesterInstall);
    writeNativeKeybindings(requester.agentDir, {});

    const destinationOccupancy = createDestinationHostKeyOccupancy({
      agentDir: destination.agentDir,
      piExecutable: destinationInstall.executable,
    });
    const requesterOccupancy = createDestinationHostKeyOccupancy({
      agentDir: requester.agentDir,
      piExecutable: requesterInstall.executable,
    });
    assert.deepEqual(destinationOccupancy("alt+k"), { resolved: true, bindings: ["app.model.cycleForward"] });
    assert.deepEqual(requesterOccupancy("alt+k"), { resolved: true, bindings: [] });

    const handler = wireOwner(destination, destinationInstall);
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const before = fileText(destination.configPath);
    const intent = shortcutIntent(envelope.opening.config, "alt+k");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS)), "invalid-draft");
    assert.equal(fileText(destination.configPath), before, "a refused remote edit never writes the destination");
  });
});

test("a destination Pi default alone refuses the remote edit, so no table is copied here", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    assert.equal(existsSync(join(destination.agentDir, "keybindings.json")), false);

    const handler = wireOwner(destination, destinationInstall);
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const before = fileText(destination.configPath);
    const intent = shortcutIntent(envelope.opening.config, "alt+p");
    assert.equal(refuseReason(await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS)), "invalid-draft");
    assert.equal(fileText(destination.configPath), before);
  });
});

test("the requester's occupied bindings never veto an edit the destination accepts", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    writeNativeKeybindings(destination.agentDir, {});

    const requesterInstall = writeFakePiInstall(join(root, "requester"), {
      "app.model.cycleForward": "alt+p",
    });
    const requester = side(root, "requester", requesterInstall);
    writeNativeKeybindings(requester.agentDir, { "app.model.cycleForward": "alt+j" });

    const requesterOccupancy = createDestinationHostKeyOccupancy({
      agentDir: requester.agentDir,
      piExecutable: requesterInstall.executable,
    });
    assert.deepEqual(requesterOccupancy("alt+j"), { resolved: true, bindings: ["app.model.cycleForward"] });

    const requesterBefore = fileText(requester.configPath);
    const handler = wireOwner(destination, destinationInstall);
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const intent = shortcutIntent(envelope.opening.config, "alt+j");
    const facts = await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS);
    assert.deepEqual(facts, { kind: "accepted" });
    assert.equal(JSON.parse(fileText(destination.configPath)).modeCycleShortcut, "alt+j");
    assert.equal(fileText(requester.configPath), requesterBefore, "the requester's configuration is untouched");
  });
});

test("an unavailable destination Pi install reports unresolved and does not guess", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    // A path that resolves to no Pi package at all.
    const missing = join(root, "absent-pi", "cli.js");
    const unavailable = createDestinationHostKeyOccupancy({ agentDir: destination.agentDir, piExecutable: missing });
    assert.deepEqual(unavailable("alt+p"), { resolved: false, bindings: [] });

    const handler = createOwnerReviewSettingsHandler(destination.input, {
      loadChoices: async () => catalog(),
      hostKeyOccupancy: unavailable,
    });
    const envelope = loadEnvelope(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const intent = shortcutIntent(envelope.opening.config, "alt+p");
    // The unchanged existing semantics: an unresolved host cannot refuse.
    assert.deepEqual(
      await handler(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS),
      { kind: "accepted" },
    );
    assert.equal(JSON.parse(fileText(destination.configPath)).modeCycleShortcut, "alt+p");
  });
});

test("the remote menu validates shortcut syntax only, so a requester-occupied chord reaches the owner", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    writeNativeKeybindings(destination.agentDir, {});

    // The owner accepts the exact envelope the requester menu sends.
    const handler = wireOwner(destination, destinationInstall);
    const openingBytes = payloadOf(await handler(loadRequest("peer-a", "run-1"), ALWAYS));
    const opening = JSON.parse(new TextDecoder().decode(openingBytes)) as RemoteReviewSettingsLoadEnvelope;

    const run = scriptedMenu(["Mode cycle hotkey", "Save changes"], ["not a chord", "alt+k"]);
    let occupancyChecks = 0;
    setHostKeybindingLoader(() => {
      occupancyChecks += 1;
      return { "app.model.cycleForward": "alt+k" };
    });
    try {
      const saves: Uint8Array[] = [];
      const ended = await openRemoteReviewSettings({
        label: "studio-mac",
        ui: run.ui,
        load: async (): Promise<PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome>> =>
          ({ kind: "owner-result", outcome: { kind: "loaded", payload: openingBytes } }),
        save: async (payload): Promise<PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome>> => {
          saves.push(payload);
          return { kind: "owner-result", outcome: { kind: "accepted" } };
        },
      });
      assert.equal(ended, false);
      assert.equal(occupancyChecks, 0, "the remote menu never consults the requester's own bindings");
      assert.equal(saves.length, 1, "the occupied chord reached Save");
      const envelope = JSON.parse(new TextDecoder().decode(saves[0]!)) as RemoteReviewSettingsSaveEnvelope;
      assert.equal((envelope.intent as { modeCycleShortcut: string }).modeCycleShortcut, "alt+k");
      // Malformed syntax was still rejected locally before the save.
      assert.ok(
        run.notices.some((notice) => notice.type === "error" && /modeCycleShortcut|shortcut|modifier/i.test(notice.message)),
        `expected a local syntax notice, got ${JSON.stringify(run.notices)}`,
      );
      assert.equal(
        run.notices.some((notice) => notice.message.includes("built-in Pi binding")),
        false,
        "the requester never vetoed with its own occupancy",
      );

      // The destination owner applies its own occupancy (free here) and saves
      // the same opening; the requester's occupied binding is irrelevant.
      assert.equal(envelope.openingId, opening.openingId);
      assert.deepEqual(await handler(saveRequest("peer-a", "run-1", saves[0]!), ALWAYS), { kind: "accepted" });
      assert.equal(JSON.parse(fileText(destination.configPath)).modeCycleShortcut, "alt+k");
    } finally {
      setHostKeybindingLoader(undefined);
    }
  });
});

test("the Local and in-Pi shortcut editor still refuses an occupied host binding", async () => {
  const run = scriptedMenu([], ["alt+k", "alt+j"]);
  setHostKeybindingLoader(() => ({ "app.model.cycleForward": "alt+k" }));
  try {
    assert.equal(await selectModeCycleShortcut(run.ui, "alt+m"), "alt+j");
  } finally {
    setHostKeybindingLoader(undefined);
  }
  assert.ok(run.notices.some((notice) => notice.message.includes("built-in Pi binding")));
});

test("unsafe destination keybindings files report unresolved instead of being reopened", async () => {
  await withFixture(async (root) => {
    const install = writeFakePiInstall(join(root, "destination"), { "app.model.cycleForward": "alt+p" });

    const directorySide = side(root, "directory", install);
    mkdirSync(join(directorySide.agentDir, "keybindings.json"));

    const oversizedSide = side(root, "oversized", install);
    writeFileSync(join(oversizedSide.agentDir, "keybindings.json"), Buffer.alloc(256 * 1024 + 1, 0x20));

    const malformedSide = side(root, "malformed", install);
    writeFileSync(join(malformedSide.agentDir, "keybindings.json"), "{invalid json", "utf8");

    const occupancyFor = (agentDir: string) => createDestinationHostKeyOccupancy({
      agentDir,
      piExecutable: install.executable,
    });
    assert.deepEqual(occupancyFor(directorySide.agentDir)("alt+p"), { resolved: false, bindings: [] });
    assert.deepEqual(occupancyFor(oversizedSide.agentDir)("alt+p"), { resolved: false, bindings: [] });
    // Pi's own loader treats malformed JSON as no overrides: the admitted
    // defaults still resolve (and are reported truthfully).
    assert.deepEqual(occupancyFor(malformedSide.agentDir)("alt+p"), {
      resolved: true,
      bindings: ["app.model.cycleForward"],
    });

    if (process.platform !== "win32") {
      const symlinkSide = side(root, "symlink", install);
      const target = join(root, "foreign-keybindings.json");
      writeFileSync(target, JSON.stringify({ "app.model.cycleForward": "alt+k" }), "utf8");
      symlinkSync(target, join(symlinkSide.agentDir, "keybindings.json"));
      assert.deepEqual(occupancyFor(symlinkSide.agentDir)("alt+k"), { resolved: false, bindings: [] });
      assert.equal(readFileSync(target, "utf8"), JSON.stringify({ "app.model.cycleForward": "alt+k" }));
    }
  });
});

test("destination decoding matches Pi for safely read native config bytes", async () => {
  await withFixture(async (root) => {
    const install = writeFakePiInstall(join(root, "destination"), { "app.model.cycleForward": "alt+p" });
    const destination = side(root, "destination", install);
    const path = join(destination.agentDir, "keybindings.json");
    const occupancy = createDestinationHostKeyOccupancy({
      agentDir: destination.agentDir,
      piExecutable: install.executable,
    });

    // Pi replaces invalid UTF-8 bytes, so an ignored `$schema` string with an
    // invalid byte still parses and the real override is active.
    writeFileSync(path, Buffer.concat([
      Buffer.from('{"$schema":"'), Buffer.from([0xff]), Buffer.from('","app.model.cycleForward":"alt+k"}'),
    ]));
    assert.deepEqual(occupancy("alt+k"), { resolved: true, bindings: ["app.model.cycleForward"] });

    // Pi strips exactly one BOM; a double BOM stays malformed to Pi, which
    // therefore applies its defaults rather than the override.
    writeFileSync(path, "\uFEFF\uFEFF{\"app.model.cycleForward\":\"alt+k\"}", "utf8");
    assert.deepEqual(occupancy("alt+k"), { resolved: true, bindings: [] });
    assert.deepEqual(occupancy("alt+p"), { resolved: true, bindings: ["app.model.cycleForward"] });
  });
});

test("destination occupancy refuses unadmitted Pi package metadata redirection", async () => {
  await withFixture(async (root) => {
    const install = writeFakePiInstall(join(root, "destination"), { "app.model.cycleForward": "alt+p" });
    const destination = side(root, "destination", install);
    const occupancy = createDestinationHostKeyOccupancy({
      agentDir: destination.agentDir,
      piExecutable: install.executable,
    });
    const previous = process.env.PI_PACKAGE_DIR;
    try {
      // Pi's config import would synchronously read this redirected
      // package.json; the resolver refuses before loading any Pi module.
      process.env.PI_PACKAGE_DIR = join(root, "foreign");
      assert.deepEqual(occupancy("alt+p"), { resolved: false, bindings: [] });
      // path.resolve() cancels the literal ~/.., but Pi expands ~ first.
      process.env.PI_PACKAGE_DIR = `~/../${relative(process.cwd(), install.root)}`;
      assert.deepEqual(occupancy("alt+p"), { resolved: false, bindings: [] });
      process.env.PI_PACKAGE_DIR = install.root;
      assert.deepEqual(occupancy("alt+p"), { resolved: true, bindings: ["app.model.cycleForward"] });
    } finally {
      if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = previous;
    }
  });
});

test("an unrelated package boundary or an escaping keybinding module is never substituted", async () => {
  await withFixture(async (root) => {
    const validInstall = writeFakePiInstall(join(root, "destination"), { "app.model.cycleForward": "alt+p" });
    const destination = side(root, "destination", validInstall);
    writeNativeKeybindings(destination.agentDir, {});

    // An unrelated package owns this CLI; the sibling valid Pi install must
    // never be used instead.
    const unrelated = join(root, "unrelated");
    mkdirSync(join(unrelated, "dist"), { recursive: true });
    writeFileSync(join(unrelated, "package.json"), `${JSON.stringify({
      name: "some-other-package",
      version: "1.6.0",
      bin: { pi: "dist/cli.js" },
    })}\n`, "utf8");
    writeFileSync(join(unrelated, "dist", "cli.js"), "", "utf8");
    assert.deepEqual(createDestinationHostKeyOccupancy({
      agentDir: destination.agentDir,
      piExecutable: join(unrelated, "dist", "cli.js"),
    })("alt+p"), { resolved: false, bindings: [] });

    if (process.platform !== "win32") {
      // A keybinding module symlinked OUTSIDE the admitted package must be
      // rejected by canonical containment, even though its lexical path sits
      // under `dist/core`.
      const escapingInstall = writeFakePiInstall(join(root, "escaping"), { "app.model.cycleForward": "alt+p" });
      const escapingSide = side(root, "escaping", escapingInstall);
      const foreignModule = join(root, "foreign-keybindings.js");
      writeFileSync(foreignModule, "export const KeybindingsManager = class {};\n", "utf8");
      unlinkSync(join(escapingInstall.root, "dist", "core", "keybindings.js"));
      symlinkSync(foreignModule, join(escapingInstall.root, "dist", "core", "keybindings.js"));
      assert.deepEqual(createDestinationHostKeyOccupancy({
        agentDir: escapingSide.agentDir,
        piExecutable: escapingInstall.executable,
      })("alt+p"), { resolved: false, bindings: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// The production Main composition itself
// ---------------------------------------------------------------------------

test("Main constructs its owner provider with the destination Pi occupancy resolver", async () => {
  await withFixture(async (root) => {
    const destinationInstall = writeFakePiInstall(join(root, "destination"), {
      "app.model.cycleForward": "alt+p",
    });
    const destination = side(root, "destination", destinationInstall);
    writeNativeKeybindings(destination.agentDir, { "app.model.cycleForward": "alt+k" });
    // Main resolves this destination's config from its own agent directory.
    const mainConfigPath = join(destination.agentDir, "review-gate.json");
    writeFileSync(mainConfigPath, `${JSON.stringify(normalizeConfig({ enabled: true }), null, 2)}\n`, { mode: 0o600 });

    const peer = new FakePeerCoordinator();
    const harness = createHarness({
      piExecutable: destinationInstall.executable,
      env: { PATH: process.env.PATH, HOME: root },
    }, {
      createSessionSetup: () => ({
        nativeSetup: true,
        nativeAgentDir: destination.agentDir,
        profileRegistry: { prepare: () => { throw new Error("the synthetic Main prepares no profiles"); } },
      }),
      openHostState: ({ agentDir: ownedDir, hostId }) => ({
        status: "opened",
        state: {
          agentDir: ownedDir,
          hostId,
          ownershipPath: join(ownedDir, "synthetic-owner"),
          roster: undefined,
          problem: undefined,
          persist: () => true,
          release: () => true,
        },
      }),
      loadReviewSettingsChoices: async () => catalog(),
      createPeerCoordinator: (options) => {
        peer.options = options;
        return peer;
      },
    });
    try {
      await ready(harness);
      const provider = peer.options?.reviewSettingsProvider;
      assert.equal(typeof provider, "function", "Main installs the owner-side review-settings provider");
      if (provider === undefined) return;

      const envelope = loadEnvelope(await provider(loadRequest("peer-a", "run-1"), ALWAYS));
      const before = fileText(mainConfigPath);
      const intent = shortcutIntent(envelope.opening.config, "alt+k");
      assert.equal(
        refuseReason(await provider(saveRequest("peer-a", "run-1", saveEnvelope(envelope.openingId, intent)), ALWAYS)),
        "invalid-draft",
      );
      assert.equal(fileText(mainConfigPath), before, "Main's wired owner refuses the destination-only occupied chord");
    } finally {
      await closeWithSignal(harness);
    }
  });
});
