/**
 * Production-composition acceptance for Main-to-Main Review settings (#716).
 *
 * Evidence label: paired real WSS (loopback TLS with the real pairing consents,
 * key/trust stores, roster bridges, and coordinators) and real config IO over
 * separate private synthetic HOME/agent directories. Both Mains are the real
 * `main.ts` controller over the focused fake terminal, and every screen is
 * driven by ordinary sidebar keys with the real fake writer's receipts. The
 * session managers remain synthetic stand-ins: this is NOT a two-physical-
 * machine, native Pi-child, Windows, or live-install acceptance test, and no
 * model, provider, or real user file is touched.
 *
 * What this one flow proves together (the focused unit suites already cover the
 * exhaustive matrix):
 *
 * - Settings opens on Local, and the host picker offers Local plus the exact
 *   connected, opted-in owner destination.
 * - The owner's root values and the owner's own model/reasoning choices come
 *   from the owner over the wire, not from this host's Local configuration or
 *   Local catalog (deliberately distinct synthetic catalogs on each Main).
 * - Cancel after a real staged edit leaves the owner's bytes untouched.
 * - An explicit Save persists the owner's destination file only; the requester
 *   file is byte-identical, and a live synthetic session seeded on EACH Main
 *   keeps its exact rows, native tuple, and geometry with no extra create,
 *   write, resize, rename, restart, or shutdown.
 * - Reopening reads the owner's freshly saved value from disk.
 * - Disconnecting the owner and then saving reports the honest disconnected /
 *   nothing-sent refusal and writes nothing.
 *
 * The second flow composes the same wiring around an ABSENT explicit Local
 * config: the Local refusal is unchanged and creates nothing, but the same host
 * picker still opens over it, so a healthy paired owner can be deliberately
 * switched to and its own values are shown. Nothing Local is written, no Local
 * catalog or draft is invented, and the implicit Local config is never
 * substituted. The third flow is the same when the Local settings catalog
 * itself cannot load: the load failure is the visible refusal and the same
 * picker still reaches the owner.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createPeerCoordinator } from "../src/session-host/network/peer-coordinator";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import {
  loadReviewSettingsChoices,
  type ReviewSettingsCatalogInput,
} from "../src/session-host/review-settings-catalog";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import { createSnapshotLog, type SnapshotLog } from "./session-host-network-peer-coordinator-helpers";
import {
  ALT_LEFT,
  ENTER,
  ESC,
  closeWithSignal,
  createHarness,
  fillForm,
  nextTurn,
  plain,
  ready,
  type FakeManager,
  type Harness,
} from "./helpers/session-host-main-harness";

const DOWN = "\x1b[B";
const OWNER_LABEL = "Lab owner";

// ---------------------------------------------------------------------------
// Synthetic per-instance catalogs: real catalog builder, distinct fake SDKs
// ---------------------------------------------------------------------------

interface FakeModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Record<string, string | null>;
}

interface NativeToolSpec {
  /** Must match the SDK's `create<Name>ToolDefinition` public-factory shape. */
  readonly factory: string;
  readonly name: string;
  readonly description: string;
}

interface SideSpec {
  readonly models: readonly FakeModel[];
  readonly native: NativeToolSpec;
  readonly enabledModels: readonly string[];
  readonly config: Record<string, unknown>;
}

const OWNER_SPEC: SideSpec = {
  // Only this owner's catalog offers a reasoning-capable model.
  models: [{ provider: "acme", id: "owner-deep", reasoning: true, thinkingLevelMap: { minimal: null } }],
  native: { factory: "createOwnerMarkToolDefinition", name: "owner_mark", description: "Owner mark tool." },
  enabledModels: ["acme/owner-deep:high"],
  config: {
    enabled: true,
    operatingMode: "execute",
    reviewerTimeoutMs: 111_000,
    execution: { maxWorkers: 7 },
    review: { primaryReviewers: [{ source: "pi", model: "acme/owner-deep", thinkingLevel: "high" }] },
    "x-synthetic-owner-marker": "keep-owner-only",
  },
};

const VIEWER_SPEC: SideSpec = {
  // A deliberately different (non-reasoning) Local catalog.
  models: [{ provider: "beta", id: "local-flat" }],
  native: { factory: "createLocalMarkToolDefinition", name: "local_mark", description: "Local mark tool." },
  enabledModels: ["beta/local-flat"],
  config: {
    enabled: true,
    operatingMode: "orchestrate",
    execution: { maxWorkers: 3 },
    review: { primaryReviewers: [{ source: "pi", model: "beta/local-flat" }] },
    "x-synthetic-local-marker": "keep-local",
  },
};

/**
 * The structural fake public SDK. `loadReviewSettingsChoices` itself is the
 * real production catalog builder; only the installed Pi module and the
 * synthetic `enabledModels` file are fixtures.
 */
function catalogSdk(spec: SideSpec): Record<string, unknown> {
  return {
    ModelRuntime: {
      async create() {
        return { getModels: () => [...spec.models], getError: () => undefined };
      },
    },
    SettingsManager: {
      fromStorage(storage: { withLock(scope: string, run: (current: string | undefined) => string | undefined): void }) {
        let content: string | undefined;
        storage.withLock("global", (current) => {
          content = current;
          return undefined;
        });
        const settings = content === undefined || content.length === 0
          ? {} as { enabledModels?: unknown }
          : JSON.parse(content) as { enabledModels?: unknown };
        return { drainErrors: () => [], getEnabledModels: () => settings.enabledModels };
      },
    },
    parseArgs: () => ({}),
    async resolveModelScopeWithDiagnostics(
      patterns: readonly string[],
      runtime: { getAvailable(): Promise<readonly FakeModel[]> },
    ) {
      const available = await runtime.getAvailable();
      const scopedModels: Array<{ model: FakeModel; thinkingLevel?: string }> = [];
      const diagnostics: Array<{ type: string; code: string; message: string; pattern: string }> = [];
      for (const pattern of patterns) {
        const [ref, thinking] = pattern.split(":");
        const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === ref);
        if (model === undefined) {
          diagnostics.push({ type: "warning", code: "no-match", message: `No models match pattern "${pattern}"`, pattern });
        } else {
          scopedModels.push(thinking === undefined ? { model } : { model, thinkingLevel: thinking });
        }
      }
      return { scopedModels, diagnostics };
    },
    [spec.native.factory]: (cwd: string) => ({
      name: spec.native.name,
      description: `${spec.native.description} cwd=${cwd}`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Two real Main instances, each with its own private synthetic state
// ---------------------------------------------------------------------------

interface Side {
  readonly harness: Harness;
  readonly coordinator: ReturnType<typeof createPeerCoordinator>;
  readonly log: SnapshotLog;
  readonly agentDir: string;
  readonly configPath: string;
  /** The explicit `PI_REVIEW_GATE_CONFIG` this side was started with, when pinned. */
  readonly explicitConfigPath: string | undefined;
  readonly catalogInputs: ReviewSettingsCatalogInput[];
}

/** Per-side startup shape beyond the synthetic spec. */
interface SideOptions {
  /**
   * Pin `PI_REVIEW_GATE_CONFIG` to an absolute path that does not exist, so this
   * side's Local target refuses instead of loading. The ordinary implicit config
   * is still written, to prove Local never substitutes it either.
   */
  readonly absentExplicitConfig?: boolean;
  /**
   * Make this side's own Local settings-catalog build reject with this message,
   * so its Local target fails to load before any editor opens while every other
   * read (and its owner-side handling) stays normal.
   */
  readonly rejectLocalCatalog?: string;
}

async function mainSide(
  t: TestContext,
  name: string,
  spec: SideSpec,
  passed: () => boolean,
  sideOptions: SideOptions = {},
): Promise<Side> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-review-settings-${name}-`)));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  const configPath = join(agentDir, "review-gate.json");
  writeFileSync(configPath, `${JSON.stringify(spec.config, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(agentDir, "keybindings.json"), "{}", { mode: 0o600 });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ enabledModels: [...spec.enabledModels] })}\n`, { mode: 0o600 });
  // The explicit override is what Local reads; it wins over the implicit file
  // above, so an ABSENT explicit path is exactly the Local refusal this test
  // needs while the implicit file (and every other start-up read) stays normal.
  const explicitConfigPath = sideOptions.absentExplicitConfig === true
    ? join(root, "missing-explicit", "review-gate.json")
    : undefined;

  const log = createSnapshotLog();
  const catalogInputs: ReviewSettingsCatalogInput[] = [];
  let coordinator!: ReturnType<typeof createPeerCoordinator>;
  const harness = createHarness({
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      ...(explicitConfigPath === undefined ? {} : { PI_REVIEW_GATE_CONFIG: explicitConfigPath }),
    },
  }, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("synthetic manager does not prepare profiles"); } },
    }),
    openHostState: ({ hostId }) => ({ status: "opened", state: {
      agentDir, hostId, ownershipPath: join(agentDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    // The Main dependency seam: the real catalog builder over this instance's
    // own synthetic agent settings. The owner and the requester therefore have
    // genuinely distinct model/tool choices without any live Pi install.
    loadReviewSettingsChoices: (input) => {
      catalogInputs.push({ ...input });
      if (sideOptions.rejectLocalCatalog !== undefined && input.agentDir === agentDir) {
        return Promise.reject(new Error(sideOptions.rejectLocalCatalog));
      }
      return loadReviewSettingsChoices(input, { loadSdk: () => catalogSdk(spec) });
    },
    createPeerCoordinator: (options) => {
      coordinator = createPeerCoordinator({
        ...options,
        testHooks: { preferencesPermissions: createPosixTestPolicy(), peerStatePermissions: createPosixTestPolicy() },
        onChange: (snapshot) => {
          options.onChange(snapshot);
          log.onChange(snapshot);
        },
      });
      return coordinator;
    },
  });
  t.after(async () => {
    const status = await closeWithSignal(harness);
    assert.equal(status, 0, "owned Main and network resources settled");
    if (passed()) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`review-settings fixture evidence retained at ${root}`);
  });
  await ready(harness);
  await log.waitFor((snapshot) => snapshot.status === "ready", `${name} coordinator startup`);
  // Roomier than the default: the owner root, the picker, and the reviewer
  // picker are all drawn in one written form pane.
  harness.terminal.setSize(140, 40);
  await press(harness);
  assert.ok(harness.manager, "the synthetic session manager is open");
  return { harness, coordinator, log, agentDir, configPath, explicitConfigPath, catalogInputs };
}

// ---------------------------------------------------------------------------
// Paired real WSS helpers (the established loopback TLS pairing pattern)
// ---------------------------------------------------------------------------

async function listen(side: Side): Promise<number> {
  await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
  const state = side.coordinator.read().listener;
  assert.equal(state.state, "listening", state.message ?? "owned loopback listener unavailable");
  assert.ok(state.port);
  return state.port;
}

async function connect(viewer: Side, owner: Side, label: string, port: number): Promise<string> {
  await viewer.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
  const hostId = viewer.coordinator.read().hosts!.find((host) => host.label === label)!.id;
  const connecting = viewer.coordinator.perform({ type: "peer-connect", hostId });
  const key = await viewer.log.waitFor(
    (snapshot) => snapshot.consents.some((consent) => consent.kind === "server-key"),
    "synthetic first-use key consent",
  );
  assert.equal(viewer.coordinator.decideConsent(key.consents.find((consent) => consent.kind === "server-key")!.id, "approve"), true);
  const incoming = await owner.log.waitFor(
    (snapshot) => snapshot.consents.some((consent) => consent.kind === "incoming"),
    "synthetic directional grant consent",
  );
  assert.equal(owner.coordinator.decideConsent(incoming.consents.find((consent) => consent.kind === "incoming")!.id, "approve"), true);
  await connecting;
  await viewer.log.waitFor(
    (snapshot) => snapshot.hosts?.some((host) => host.id === hostId
      && host.state === "connected" && host.roster.state === "current") === true,
    "current owner roster",
  );
  await nextTurn();
  return hostId;
}

function hostOf(snapshot: PeerUiSnapshot, hostId: string): NonNullable<PeerUiSnapshot["hosts"]>[number] | undefined {
  return snapshot.hosts?.find((host) => host.id === hostId);
}

// ---------------------------------------------------------------------------
// Written-frame driving: ordinary sidebar keys over the real writer receipts
// ---------------------------------------------------------------------------

async function press(harness: Harness, data?: string, turns = 2): Promise<void> {
  if (data !== undefined && data.length > 0) harness.terminal.emitInput(data);
  for (let index = 0; index < turns; index += 1) await nextTurn();
}

function frameText(harness: Harness): string {
  return plain(harness.writer.frames.at(-1)?.frame);
}

/** Prose view of only the form pane's content (right of the roster divider). */
function paneProse(text: string): string {
  return text.split("\n")
    .map((line) => {
      const divider = line.indexOf("│");
      return divider < 0 ? line : line.slice(divider + 1);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whitespace-free view of the form pane. Rendered notices hard-wrap at the
 * pane width with no inserted character, and a long temporary path may break
 * mid-path, so a whole-sentence comparison must ignore wrapping entirely.
 */
function paneCompact(text: string): string {
  return text.split("\n")
    .map((line) => {
      const divider = line.indexOf("│");
      return divider < 0 ? line : line.slice(divider + 1);
    })
    .join("")
    .replace(/\s+/g, "");
}

async function waitFrame(
  harness: Harness,
  predicate: (text: string) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = frameText(harness);
    if (predicate(text)) return text;
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}:\n${frameText(harness)}`);
}

/**
 * The shared editor's end returns to the grouped Settings menu (its own form
 * slot), not directly to the roster. This waits for that exact drawn surface.
 */
async function waitSettingsMenu(harness: Harness, what: string): Promise<string> {
  const text = await waitFrame(
    harness,
    (value) => !value.includes("Review settings (local)") && value.includes(" Settings ") && value.includes("theme: Dark"),
    what,
  );
  assert.equal(harness.sidebar?.focus, "form", "the grouped Settings menu owns the form slot after the pane ends");
  return text;
}

/**
 * The wide layout draws the roster left of a divider and the Settings menu /
 * form pane right of it, so a drawn marker is only guaranteed to start its own
 * pane segment.
 */
function paneSegments(line: string): string[] {
  return line.split("│").map((part) => part.trimStart());
}

function hasDrawnRow(text: string, marker: ">" | "→", label: string): boolean {
  return text.split("\n").some((line) => paneSegments(line).some((part) => part.startsWith(`${marker} ${label}`)));
}

async function moveToHostRow(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (hasDrawnRow(frameText(harness), ">", label)) return;
    await press(harness, DOWN);
  }
  assert.fail(`no written highlighted host row ${label}:\n${frameText(harness)}`);
}

async function moveToMenuRow(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step < 80; step += 1) {
    if (hasDrawnRow(frameText(harness), "→", label)) return;
    await press(harness, DOWN);
  }
  assert.fail(`no written highlighted menu row ${label}:\n${frameText(harness)}`);
}

/**
 * Leave the grouped Settings menu for the roster. The roster keeps showing
 * New session behind the menu, so only the sidebar focus and the absent menu
 * header prove the menu actually closed.
 */
async function returnToRoster(harness: Harness): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (harness.sidebar?.focus === "sidebar" && !frameText(harness).includes("theme: Dark")) return;
    await press(harness, ESC, 3);
  }
  assert.fail(`the roster never came back (focus=${String(harness.sidebar?.focus)}):\n${frameText(harness)}`);
}

function rootShown(text: string, label: string): boolean {
  return text.includes(`Host: ${label}`) && text.includes("Operating mode");
}

/**
 * Roster -> Settings -> Review settings. The targeted editor always opens on
 * Local first, exactly as Main composes it.
 */
async function openPane(harness: Harness): Promise<void> {
  if (harness.sidebar?.focus === "main") await press(harness, ALT_LEFT);
  await moveToHostRow(harness, "Settings");
  await press(harness, ENTER);
  await moveToHostRow(harness, "Review settings");
  await press(harness, ENTER);
  await waitFrame(harness, (text) => text.includes("→ Host: Local"), "the targeted root opening on Local");
  assert.equal(harness.sidebar?.focus, "form", "the Review settings pane owns the form slot");
}

/** The root's Host row -> the pane's own host picker, settled on Local. */
async function openHostPicker(harness: Harness, current: string): Promise<void> {
  await moveToMenuRow(harness, `Host: ${current}`);
  await press(harness, ENTER);
  await waitFrame(
    harness,
    (text) => paneProse(text).includes("Review settings: host") && text.includes(`→ ${current}`),
    "the host picker",
  );
}

/**
 * Roster -> Settings -> Review settings when this side's Local cannot load.
 * There is no Local root to wait for: the refusal is the carried notice of the
 * SAME host picker, which still opens over it (#716).
 */
async function openPaneWithUnavailableLocal(harness: Harness, refusal: string): Promise<string> {
  if (harness.sidebar?.focus === "main") await press(harness, ALT_LEFT);
  await moveToHostRow(harness, "Settings");
  await press(harness, ENTER);
  await moveToHostRow(harness, "Review settings");
  await press(harness, ENTER);
  const text = await waitFrame(
    harness,
    (value) => paneProse(value).includes("Review settings: host")
      && value.includes("→ Local")
      && paneCompact(value).includes(paneCompact(refusal)),
    "the unavailable Local refusal with its host picker",
  );
  assert.equal(harness.sidebar?.focus, "form", "the Review settings pane owns the form slot");
  return text;
}

/** Pick the connected owner destination by its drawn row. */
async function switchToOwnerRoot(harness: Harness): Promise<void> {
  await moveToMenuRow(harness, OWNER_LABEL);
  await press(harness, ENTER);
  await waitFrame(harness, (text) => text.includes(`→ Host: ${OWNER_LABEL}`), "the owner root menu");
}

function pickerRows(text: string): string[] {
  return text.split("\n")
    .flatMap((line) => paneSegments(line))
    .map((part) => part.replace(/^→\s*/, "").trim())
    .filter((part) => part === "Local" || part === OWNER_LABEL);
}

/**
 * Seed one real live synthetic session on this Main through the ordinary New
 * session form, so a Save/reopen regression that reconfigures, restarts, or
 * writes to an EXISTING session has a real target in this harness.
 */
async function seedLiveSession(harness: Harness, workspace: string): Promise<void> {
  if (harness.sidebar?.focus === "main") await press(harness, ALT_LEFT);
  for (let step = 0; step < 16; step += 1) {
    if (hasDrawnRow(frameText(harness), ">", "New session")) break;
    await press(harness, "\x1b[A");
  }
  assert.ok(hasDrawnRow(frameText(harness), ">", "New session"),
    `the ordinary New session row was never highlighted:\n${frameText(harness)}`);

  const manager = harness.manager;
  assert.ok(manager);
  const before = manager.views.length;
  fillForm(harness.terminal, workspace);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = manager.views.at(-1);
    if (manager.views.length === before + 1 && row?.lifecycle === "alive" && row.hasLiveProcess) break;
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  await press(harness);
  assert.equal(manager.views.length, before + 1, "New created exactly one synthetic session");
  const row = manager.views.at(-1)!;
  assert.equal(row.lifecycle, "alive");
  assert.equal(row.hasLiveProcess, true);
  assert.ok(row.nativeSession, "the seeded row is a live native conversation, not a placeholder");
}

/** The rows and their canonical geometry, so a restart/reconfigure is visible. */
function sessionSnapshot(manager: FakeManager): Record<string, unknown> {
  return {
    rows: manager.views.map((view) => ({
      id: view.id,
      label: view.label,
      workspace: view.workspace,
      lifecycle: view.lifecycle,
      hasLiveProcess: view.hasLiveProcess,
      nativeSession: view.nativeSession === null ? null : { ...view.nativeSession },
      inputSurface: view.inputSurface,
      busy: view.busy,
      pendingInput: view.pendingInput,
      activity: [...(view.activity ?? [])],
    })),
    geometry: [...manager.geometry.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, value]) => [id, { ...value }]),
  };
}

function sessionEffects(manager: FakeManager): Record<string, number> {
  return {
    views: manager.views.length,
    creates: manager.createOptions.length,
    writes: manager.writes.length,
    renames: manager.renameCalls.length,
    resizes: manager.resizeCalls.length,
    exited: manager.closeExitedCalls.length,
    spawns: manager.spawnCount,
    shutdowns: manager.shutdownCalls,
    disposes: manager.disposeCalls,
  };
}

// POSIX test policy inspects real synthetic UID/modes; it makes no Windows ACL claim.
test("paired Main-to-Main Review settings: Local first, owner values and choices, destination-only Save, Cancel and disconnect preservation", { skip: process.platform === "win32" }, async (t) => {
  let passed = false;
  const owner = await mainSide(t, "owner", OWNER_SPEC, () => passed);
  const viewer = await mainSide(t, "viewer", VIEWER_SPEC, () => passed);
  const ownerHarness = owner.harness;
  const viewerHarness = viewer.harness;
  const ownerManager = ownerHarness.manager!;
  const viewerManager = viewerHarness.manager!;

  // Both hosts start with no local child and no session-manager activity.
  const zero = { views: 0, creates: 0, writes: 0, renames: 0, resizes: 0, exited: 0, spawns: 0, shutdowns: 0, disposes: 0 };
  assert.deepEqual(sessionEffects(ownerManager), zero);
  assert.deepEqual(sessionEffects(viewerManager), zero);

  // Seed a LIVE synthetic session on each Main. A regression that reconfigures,
  // restarts, writes to, resizes, or renames an EXISTING session now has a real
  // target, so every later no-effect assertion is meaningful.
  await seedLiveSession(ownerHarness, "/synthetic/owner-workspace");
  await seedLiveSession(viewerHarness, "/synthetic/viewer-workspace");
  assert.equal(ownerManager.views.length, 1, "the owner has one live synthetic session");
  assert.equal(viewerManager.views.length, 1, "the viewer has one live synthetic session");

  // --- Real TLS pairing, then the owner's live opt-in -----------------------
  const port = await listen(owner);
  const hostId = await connect(viewer, owner, OWNER_LABEL, port);
  const connectedHost = hostOf(viewer.coordinator.read(), hostId);
  assert.ok(connectedHost);
  assert.equal(connectedHost.state, "connected");
  // The owner advertises capability, and its own saved opt-in (absent => Off)
  // reaches the connected viewer before this test moves it.
  const optedOut = await viewer.log.waitFor(
    (snapshot) => {
      const host = hostOf(snapshot, hostId);
      return host?.reviewSettings?.supported === true && host.reviewSettings.enabled === false;
    },
    "the owner's described Off opt-in",
  );
  assert.deepEqual(hostOf(optedOut, hostId)?.reviewSettings, { supported: true, enabled: false },
    "the owner is opted out until its own setting says otherwise");

  await owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
  const optedIn = await viewer.log.waitFor(
    (snapshot) => {
      const host = hostOf(snapshot, hostId);
      return host?.reviewSettings?.supported === true && host.reviewSettings.enabled === true
        && typeof host.roster.hostRunId === "string" && host.roster.hostRunId.length > 0;
    },
    "the owner's opted-in Review settings description",
  );
  const observedHost = hostOf(optedIn, hostId);
  assert.ok(observedHost?.roster.hostRunId);
  assert.equal(observedHost.state, "connected", "the opt-in reaches the connected viewer without reconnecting");
  await nextTurn();

  const ownerBytes = readFileSync(owner.configPath, "utf8");
  const viewerBytes = readFileSync(viewer.configPath, "utf8");
  const ownerBefore = JSON.parse(ownerBytes) as { review: { primaryReviewers: unknown } };
  const ownerEntriesBefore = readdirSync(owner.agentDir).sort();
  // Baselines for the existing live sessions on both Mains.
  const effects = sessionEffects(ownerManager);
  const viewerEffects = sessionEffects(viewerManager);
  const ownerSessions = sessionSnapshot(ownerManager);
  const viewerSessions = sessionSnapshot(viewerManager);
  for (const baseline of [ownerSessions, viewerSessions]) {
    const rows = baseline.rows as Array<{ lifecycle: string; hasLiveProcess: boolean; nativeSession: unknown }>;
    assert.equal(rows.length, 1, "the baseline contains the seeded live session");
    assert.equal(rows[0]!.lifecycle, "alive");
    assert.equal(rows[0]!.hasLiveProcess, true);
    assert.ok(rows[0]!.nativeSession, "the baseline row has a real native conversation tuple");
    assert.equal((baseline.geometry as unknown[]).length, 1, "the baseline records the row's canonical geometry");
  }

  // --- Open 1: Local first, owner via the picker, owner choices, Cancel -----
  await openPane(viewerHarness);
  const localRoot = frameText(viewerHarness);
  assert.match(localRoot, /→ Host: Local/, "Settings opens on Local, not on a remembered remote host");
  assert.match(localRoot, /Operating mode\s+Prefer orchestration/, "the Local root shows this host's own mode");
  assert.match(localRoot, /Global concurrency\s+3\b/, "the Local root shows this host's own concurrency");
  const localTarget = `Editing LOCAL review-gate settings for this host: ${viewer.configPath}`;
  assert.ok(paneCompact(localRoot).includes(paneCompact(localTarget)),
    `the Local target names this host's own absolute config:\n${localRoot}`);

  await openHostPicker(viewerHarness, "Local");
  assert.deepEqual(pickerRows(frameText(viewerHarness)), ["Local", OWNER_LABEL],
    "the picker offers exactly Local plus the connected, opted-in owner");
  await switchToOwnerRoot(viewerHarness);

  const remoteRoot = frameText(viewerHarness);
  assert.ok(paneCompact(remoteRoot).includes(paneCompact(`Editing REMOTE review-gate settings for ${OWNER_LABEL}`)),
    `the remote target notice names the owner:\n${remoteRoot}`);
  assert.match(remoteRoot, /Operating mode\s+Prefer execution/, "the remote root shows the OWNER's mode, not Local's");
  assert.match(remoteRoot, /Global concurrency\s+7\b/, "the remote root shows the OWNER's concurrency");
  assert.equal(/Prefer orchestration/.test(remoteRoot), false, "no Local value leaks into the owner's root");
  assert.equal(/Global concurrency\s+3\b/.test(remoteRoot), false);

  // The owner's own scoped model + reasoning metadata reached the picker; the
  // requester's Local model never did.
  await moveToMenuRow(viewerHarness, "Reviewers");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => paneProse(text).includes("Primary reviewers"),
    "the owner's Review submenu");
  await moveToMenuRow(viewerHarness, "Primary reviewers");
  await press(viewerHarness, ENTER);
  const reviewerPicker = await waitFrame(
    viewerHarness,
    (text) => paneProse(text).includes("Reviewers — Enter toggles"),
    "the owner's reviewer picker",
  );
  assert.match(reviewerPicker, /owner-deep \[acme\]\s+✓/, `the owner's selected model is offered:\n${reviewerPicker}`);
  assert.match(reviewerPicker, /Reasoning · owner-deep \[acme\]\s+High/,
    `the owner's thinking metadata drives the Reasoning row:\n${reviewerPicker}`);
  assert.equal(reviewerPicker.includes("local-flat"), false, "the requester's own catalog is not substituted");
  await press(viewerHarness, ESC);
  await waitFrame(viewerHarness, (text) => paneProse(text).includes("Primary reviewers")
    && !paneProse(text).includes("Reviewers —"), "the Review submenu after the picker");
  await press(viewerHarness, ESC);
  await waitFrame(viewerHarness, (text) => rootShown(text, OWNER_LABEL)
    && !paneProse(text).includes("Primary reviewers"), "the owner root after Review");

  // Stage a real edit, then Cancel: the owner's bytes stay exactly as opened.
  await moveToMenuRow(viewerHarness, "Tools");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => text.includes("YouShouldKnow notices"), "the Tools submenu");
  await moveToMenuRow(viewerHarness, "YouShouldKnow notices");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => /YouShouldKnow notices\s+Off/.test(text), "the staged YouShouldKnow Off");
  await press(viewerHarness, ESC);
  await waitFrame(viewerHarness, (text) => rootShown(text, OWNER_LABEL) && text.includes("→ Tools"),
    "the owner root after Back");

  await moveToMenuRow(viewerHarness, "Cancel");
  await press(viewerHarness, ENTER);
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after Cancel");
  assert.equal(readFileSync(owner.configPath, "utf8"), ownerBytes, "Cancel sent and wrote nothing on the owner");
  assert.equal(readFileSync(viewer.configPath, "utf8"), viewerBytes, "Cancel wrote nothing locally either");
  assert.deepEqual(sessionEffects(ownerManager), effects, "Cancel created, wrote, resized, or restarted no owner session");
  assert.deepEqual(sessionEffects(viewerManager), viewerEffects, "Cancel created, wrote, resized, or restarted no local session");
  assert.deepEqual(sessionSnapshot(ownerManager), ownerSessions, "the owner's live session row and geometry are unchanged");
  assert.deepEqual(sessionSnapshot(viewerManager), viewerSessions, "the viewer's live session row and geometry are unchanged");

  // --- Open 2: an explicit Save changes ONLY the owner's destination file ---
  await returnToRoster(viewerHarness);
  await openPane(viewerHarness);
  await openHostPicker(viewerHarness, "Local");
  await switchToOwnerRoot(viewerHarness);

  await moveToMenuRow(viewerHarness, "Operating mode");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => text.includes("Plan/research"), "the owner's operating mode screen");
  await moveToMenuRow(viewerHarness, "Prefer orchestration");
  await press(viewerHarness, ENTER);
  await waitFrame(
    viewerHarness,
    (text) => rootShown(text, OWNER_LABEL) && /Operating mode\s+Prefer orchestration/.test(text),
    "the staged orchestration value in the owner root",
  );
  await moveToMenuRow(viewerHarness, "Save changes");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => paneProse(text).includes("Review settings saved to disk"),
    "the owner's own positive save acceptance");
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after Save");

  const ownerAfterSaveBytes = readFileSync(owner.configPath, "utf8");
  const ownerAfterSave = JSON.parse(ownerAfterSaveBytes) as {
    operatingMode: string;
    execution: { maxWorkers: number };
    review: { primaryReviewers: unknown };
    "x-synthetic-owner-marker"?: string;
  };
  assert.equal(ownerAfterSave.operatingMode, "orchestrate", "the staged value was persisted on the owner");
  assert.notEqual(ownerAfterSaveBytes, ownerBytes, "the owner's destination file really changed");
  assert.equal(ownerAfterSave.execution.maxWorkers, 7, "unrelated owner values are preserved");
  assert.deepEqual(ownerAfterSave.review.primaryReviewers, ownerBefore.review.primaryReviewers,
    "the owner's reviewer choices are preserved");
  assert.equal(ownerAfterSave["x-synthetic-owner-marker"], "keep-owner-only",
    "the owner's own unknown field survives the destination merge");
  assert.equal(readFileSync(viewer.configPath, "utf8"), viewerBytes,
    "the requester's Local config is byte-identical after the owner Save");
  assert.deepEqual(readdirSync(owner.agentDir).sort(), ownerEntriesBefore,
    "no temporary or extra file was left in the owner agent directory");
  assert.deepEqual(sessionEffects(ownerManager), effects,
    "the owner Save created, reconfigured, renamed, resized, or wrote no session");
  assert.deepEqual(sessionEffects(viewerManager), viewerEffects,
    "the requester Save gesture created, reconfigured, renamed, resized, or wrote no session");
  assert.deepEqual(sessionSnapshot(ownerManager), ownerSessions,
    "the owner's live session kept its exact row, native tuple, and geometry through the Save");
  assert.deepEqual(sessionSnapshot(viewerManager), viewerSessions,
    "the viewer's live session kept its exact row, native tuple, and geometry through the Save");

  // --- Open 3: reopen sees the saved owner value; a disconnect stays honest -
  await returnToRoster(viewerHarness);
  await openPane(viewerHarness);
  await openHostPicker(viewerHarness, "Local");
  await switchToOwnerRoot(viewerHarness);
  await waitFrame(
    viewerHarness,
    (text) => rootShown(text, OWNER_LABEL) && /Operating mode\s+Prefer orchestration/.test(text),
    "the owner's freshly read saved mode",
  );

  await moveToMenuRow(viewerHarness, "Operating mode");
  await press(viewerHarness, ENTER);
  await waitFrame(viewerHarness, (text) => text.includes("Plan/research"), "the reopened mode screen");
  await moveToMenuRow(viewerHarness, "Plan/research");
  await press(viewerHarness, ENTER);
  await waitFrame(
    viewerHarness,
    (text) => rootShown(text, OWNER_LABEL) && /Operating mode\s+Plan\/research/.test(text),
    "the staged Plan/research value",
  );

  await viewer.coordinator.perform({ type: "peer-disconnect", hostId });
  await viewer.log.waitFor((snapshot) => hostOf(snapshot, hostId)?.state !== "connected",
    "the deliberately disconnected owner");
  await nextTurn();

  await moveToMenuRow(viewerHarness, "Save changes");
  await press(viewerHarness, ENTER);
  const disconnectedNotice = await waitFrame(
    viewerHarness,
    (text) => paneProse(text).includes("disconnected") && paneProse(text).includes("nothing was sent"),
    "the truthful disconnected Save refusal",
  );
  assert.ok(paneProse(disconnectedNotice).includes(OWNER_LABEL),
    `the refusal names the disconnected owner:\n${disconnectedNotice}`);
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after the disconnected Save");
  assert.equal(readFileSync(owner.configPath, "utf8"), ownerAfterSaveBytes,
    "a disconnected save wrote nothing on the owner");
  assert.equal(readFileSync(viewer.configPath, "utf8"), viewerBytes,
    "a disconnected save wrote nothing locally");
  assert.deepEqual(sessionEffects(ownerManager), effects, "the disconnected attempt reconfigured no owner session");
  assert.deepEqual(sessionEffects(viewerManager), viewerEffects, "the disconnected attempt reconfigured no local session");
  assert.deepEqual(sessionSnapshot(ownerManager), ownerSessions, "the disconnected attempt left the owner session untouched");
  assert.deepEqual(sessionSnapshot(viewerManager), viewerSessions, "the disconnected attempt left the viewer session untouched");

  // Real config IO: each Main built only ITS OWN catalog, once per open; the
  // remote menus used the owner's catalogs, never the requester's.
  assert.equal(owner.catalogInputs.length, 3, "the owner built one catalog for each real remote open");
  assert.equal(viewer.catalogInputs.length, 3, "the requester built only its three Local catalogs");
  for (const input of owner.catalogInputs) assert.equal(input.agentDir, owner.agentDir);
  for (const input of viewer.catalogInputs) assert.equal(input.agentDir, viewer.agentDir);
  assert.equal(viewer.catalogInputs.some((input) => input.agentDir === owner.agentDir), false,
    "the owner's choices never came from the requester's catalog");

  passed = true;
});

// The same production wiring when this side's LOCAL target cannot load (#716):
// an absent explicit config is refused exactly as before, but the SAME host
// picker still opens over that refusal, so a healthy paired owner stays reachable
// and the clean switch writes nothing Local.
test("paired Main-to-Main Review settings: an unavailable Local still offers the host picker", { skip: process.platform === "win32" }, async (t) => {
  let passed = false;
  const owner = await mainSide(t, "owner-unavailable-local", OWNER_SPEC, () => passed);
  const viewer = await mainSide(t, "viewer-unavailable-local", VIEWER_SPEC, () => passed, { absentExplicitConfig: true });
  const ownerHarness = owner.harness;
  const viewerHarness = viewer.harness;
  const explicitConfigPath = viewer.explicitConfigPath;
  assert.ok(explicitConfigPath, "the viewer started with an explicit Local config that does not exist");
  assert.equal(existsSync(explicitConfigPath), false, "the explicit Local config really is absent before the open");

  // --- Real TLS pairing, then the owner's live opt-in -----------------------
  const port = await listen(owner);
  const hostId = await connect(viewer, owner, OWNER_LABEL, port);
  await owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
  await viewer.log.waitFor(
    (snapshot) => {
      const host = hostOf(snapshot, hostId);
      return host?.state === "connected" && host.reviewSettings?.supported === true
        && host.reviewSettings.enabled === true
        && typeof host.roster.hostRunId === "string" && host.roster.hostRunId.length > 0;
    },
    "the eligible owner destination",
  );
  await nextTurn();

  const ownerBytes = readFileSync(owner.configPath, "utf8");
  const viewerBytes = readFileSync(viewer.configPath, "utf8");
  const viewerEntries = readdirSync(viewer.agentDir).sort();
  const refusal = `review gate: the explicitly selected review-gate config does not exist and is not created: ${explicitConfigPath}`;

  // --- Open 1: the Local refusal still offers the picker; declining writes nothing
  await openPaneWithUnavailableLocal(viewerHarness, refusal);
  const refusalFrame = frameText(viewerHarness);
  assert.ok(paneProse(refusalFrame).includes("Create it or change PI_REVIEW_GATE_CONFIG, then reopen"),
    `the Local refusal stays whole and actionable:\n${refusalFrame}`);
  assert.deepEqual(pickerRows(refusalFrame), ["Local", OWNER_LABEL],
    "the same picker offers exactly Local plus the eligible paired owner");

  await press(viewerHarness, ESC);
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after the declined pick");
  assert.equal(existsSync(explicitConfigPath), false, "declining the pick created no Local config");
  assert.deepEqual(readdirSync(viewer.agentDir).sort(), viewerEntries, "declining the pick left no Local file behind");
  assert.equal(viewer.catalogInputs.length, 0, "an unavailable Local never built a catalog or a draft");

  // --- Open 2: the clean switch really opens the owner, and nothing Local is made
  await returnToRoster(viewerHarness);
  await openPaneWithUnavailableLocal(viewerHarness, refusal);
  await moveToMenuRow(viewerHarness, OWNER_LABEL);
  await press(viewerHarness, ENTER);
  const ownerRoot = await waitFrame(
    viewerHarness,
    (text) => text.includes(`→ Host: ${OWNER_LABEL}`) && text.includes("Operating mode"),
    "the owner root after a clean switch from an unavailable Local",
  );
  assert.match(ownerRoot, /Operating mode\s+Prefer execution/, "the switched-to root is the OWNER's own config");
  assert.match(ownerRoot, /Global concurrency\s+7\b/, "the owner's values arrived over the wire");
  assert.equal(/Prefer orchestration/.test(ownerRoot), false, "no Local value was substituted for the unavailable target");

  await moveToMenuRow(viewerHarness, "Cancel");
  await press(viewerHarness, ENTER);
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after Cancel");

  assert.equal(existsSync(explicitConfigPath), false, "the clean switch created no Local config");
  assert.deepEqual(readdirSync(viewer.agentDir).sort(), viewerEntries,
    "the clean switch left no Local config or temporary file");
  assert.equal(readFileSync(viewer.configPath, "utf8"), viewerBytes,
    "the viewer's implicit Local config was never substituted or rewritten");
  assert.equal(readFileSync(owner.configPath, "utf8"), ownerBytes, "Cancel wrote nothing on the owner");
  assert.equal(viewer.catalogInputs.length, 0, "the requester built no Local catalog in either open");
  assert.deepEqual(owner.catalogInputs.map((input) => input.agentDir), [owner.agentDir],
    "the owner built exactly one catalog for the one real remote open");

  passed = true;
});

// The same production wiring when the Local target's own settings catalog cannot
// load (#716 review): the load failure is the visible Local refusal and the same
// host picker still opens, so an eligible paired owner remains reachable and no
// Local settings are written.
test("paired Main-to-Main Review settings: a failing Local catalog still offers the host picker", { skip: process.platform === "win32" }, async (t) => {
  let passed = false;
  const catalogFailure = "pi-review-gate: the installed Pi SDK is unavailable for the settings catalog";
  const owner = await mainSide(t, "owner-local-catalog-failure", OWNER_SPEC, () => passed);
  const viewer = await mainSide(t, "viewer-local-catalog-failure", VIEWER_SPEC, () => passed, { rejectLocalCatalog: catalogFailure });
  const ownerHarness = owner.harness;
  const viewerHarness = viewer.harness;

  // --- Real TLS pairing, then the owner's live opt-in -----------------------
  const port = await listen(owner);
  const hostId = await connect(viewer, owner, OWNER_LABEL, port);
  await owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
  await viewer.log.waitFor(
    (snapshot) => {
      const host = hostOf(snapshot, hostId);
      return host?.state === "connected" && host.reviewSettings?.supported === true
        && host.reviewSettings.enabled === true
        && typeof host.roster.hostRunId === "string" && host.roster.hostRunId.length > 0;
    },
    "the eligible owner destination",
  );
  await nextTurn();

  const ownerBytes = readFileSync(owner.configPath, "utf8");
  const viewerBytes = readFileSync(viewer.configPath, "utf8");
  const viewerEntries = readdirSync(viewer.agentDir).sort();
  // The existing outer refusal text, carrying the real load failure unchanged.
  const refusal = `review gate: local review settings failed: ${catalogFailure}`;

  await openPaneWithUnavailableLocal(viewerHarness, refusal);
  const refusalFrame = frameText(viewerHarness);
  assert.ok(paneProse(refusalFrame).includes("the installed Pi SDK is unavailable for the settings catalog"),
    `the original catalog failure stays visible:\n${refusalFrame}`);
  assert.deepEqual(pickerRows(refusalFrame), ["Local", OWNER_LABEL],
    "the same picker offers exactly Local plus the eligible paired owner");
  assert.deepEqual(viewer.catalogInputs.map((input) => input.agentDir), [viewer.agentDir],
    "the Local open made exactly one failed catalog attempt and no editor ran");

  // Choosing the owner reaches its own editor: the failed Local load is not a
  // dead end and nothing Local is read, staged, or written in its place.
  await moveToMenuRow(viewerHarness, OWNER_LABEL);
  await press(viewerHarness, ENTER);
  const ownerRoot = await waitFrame(
    viewerHarness,
    (text) => text.includes(`→ Host: ${OWNER_LABEL}`) && text.includes("Operating mode"),
    "the owner root after switching past the failed Local catalog",
  );
  assert.match(ownerRoot, /Operating mode\s+Prefer execution/, "the switched-to root is the OWNER's own config");
  assert.match(ownerRoot, /Global concurrency\s+7\b/, "the owner's values arrived over the wire");
  assert.equal(/Prefer orchestration/.test(ownerRoot), false, "no Local value was substituted for the failed target");

  await moveToMenuRow(viewerHarness, "Cancel");
  await press(viewerHarness, ENTER);
  await waitSettingsMenu(viewerHarness, "the grouped Settings menu after Cancel");

  assert.equal(readFileSync(viewer.configPath, "utf8"), viewerBytes, "the failed Local load and the switch wrote no Local settings");
  assert.deepEqual(readdirSync(viewer.agentDir).sort(), viewerEntries,
    "no Local config or temporary file appeared");
  assert.equal(readFileSync(owner.configPath, "utf8"), ownerBytes, "Cancel wrote nothing on the owner");
  assert.equal(viewer.catalogInputs.length, 1, "the requester never retried the Local catalog or built a remote one");
  assert.deepEqual(owner.catalogInputs.map((input) => input.agentDir), [owner.agentDir],
    "the owner built exactly one catalog for the one real remote open");

  passed = true;
});
