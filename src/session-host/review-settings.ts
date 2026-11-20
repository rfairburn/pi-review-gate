/**
 * Session-host LOCAL review-settings editor composition (issue #653).
 *
 * Opens the shared disk-only `/review-settings` transaction
 * ({@link runPersistedReviewSettings}) over a FRESH disk load of this host's
 * local review-gate configuration, with model/tool choices from the
 * metadata-only {@link loadReviewSettingsChoices} catalog. Every open re-reads
 * the disk; nothing is cached between opens, and no Main startup config, live
 * session config, pending delta, scheduler runtime, or `onSaved` callback is
 * consulted or touched. A Save writes the disk only; the saved result is
 * dropped and running sessions keep their own effective settings.
 *
 * Path resolution matches the child-native loading of managed sessions:
 * `loadConfig` over the Main startup environment snapshot (whose explicit
 * `PI_REVIEW_GATE_CONFIG` was already pinned to one absolute path by
 * `resolveManagedConfigOverride`) with `PI_CODING_AGENT_DIR` set to the same
 * canonical native agent directory managed children receive, and the
 * snapshot's HOME/USERPROFILE for Pi-native defaults and the sole
 * compatibility fallback. The editing target is always this LOCAL host: the
 * API takes no session or remote-row input, and `cwd` only anchors
 * workspace-relative settings fields.
 *
 * First use: when no explicit override is set and neither implicit candidate
 * exists, the editor shows the ordinary zero-model defaults and publishes the
 * canonical `<agentDir>/review-gate.json` ONLY on an explicit Save, through the
 * existing guarded native initializer (which never overwrites a file another
 * launch or editor created meanwhile, and never creates a primary that would
 * shadow a compatibility config that appeared meanwhile — that Save fails and
 * asks for a reopen; the draft is never retargeted). Cancel and root Escape leave the file
 * absent. An explicitly selected config that does not exist is an error and is
 * never created. The `PI_REVIEW_GATE_DISABLED` kill switch keeps the editor
 * unavailable, exactly as it keeps `/review-settings` unregistered in Pi.
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { PI_AGENT_DIR_ENV, REVIEW_GATE_CONFIG_FILENAME } from "../config-path";
import { loadConfig, normalizeConfig, type ReviewGateConfig } from "../config";
import { runPersistedReviewSettings } from "../settings/command";
import type { UiContext } from "../settings/ui";
import { configResolutionForEnv, DEFAULT_REVIEW_GATE_CONFIG_JSON, ensureNativeReviewGateConfig } from "./profiles";
import { loadReviewSettingsChoices, type ReviewSettingsCatalog, type ReviewSettingsCatalogInput } from "./review-settings-catalog";

export interface LocalReviewSettingsInput {
  /**
   * The Main startup environment snapshot (after `resolveManagedConfigOverride`).
   * Never mutated; only `PI_CODING_AGENT_DIR` is overridden for resolution.
   */
  env: NodeJS.ProcessEnv;
  /** The canonical native Pi agent directory managed children launch with. */
  agentDir: string;
  /** Absolute path of the actual resolved native Pi CLI (for the metadata catalog). */
  piExecutable: string;
  /** Forwarded host Pi arguments; only `--models` is honored by the catalog. */
  args?: readonly string[];
  /** Caller workspace: anchors workspace-relative settings fields only. */
  cwd: string;
  /** Host settings UI for this one open; the service sets `ui.cwd = cwd`. */
  ui: UiContext;
}

/** Hermetic test seams. */
export interface LocalReviewSettingsDependencies {
  loadChoices?: (input: ReviewSettingsCatalogInput) => Promise<ReviewSettingsCatalog>;
}

const MAX_NOTICE_CHARS = 400;

/** Open the LOCAL review settings once. Never rejects: failures become bounded UI errors. */
export async function openLocalReviewSettings(
  input: LocalReviewSettingsInput,
  dependencies: LocalReviewSettingsDependencies = {},
): Promise<void> {
  const { ui } = input;
  try {
    await openOnce(input, dependencies);
  } catch (error) {
    notify(ui, `review gate: local review settings failed: ${boundedErrorMessage(error)}`, "error");
  }
}

async function openOnce(input: LocalReviewSettingsInput, dependencies: LocalReviewSettingsDependencies): Promise<void> {
  const { ui, agentDir } = input;
  const configEnv: NodeJS.ProcessEnv = { ...input.env, [PI_AGENT_DIR_ENV]: agentDir };
  const resolution = configResolutionForEnv(input.env);
  const loaded = loadConfig(configEnv, resolution);
  if (loaded.globallyDisabled) {
    notify(ui, `review gate: local review settings are unavailable because ${loaded.disabledReason ?? "the review gate is globally disabled"}.`, "error");
    return;
  }

  const explicit = configEnv.PI_REVIEW_GATE_CONFIG;
  let config: ReviewGateConfig;
  let configPath: string;
  let beforePersist: (() => void) | undefined;
  if (loaded.path !== undefined) {
    if (explicit && loaded.path === explicit && isAbsent(explicit)) {
      notify(ui, `review gate: the explicitly selected review-gate config does not exist and is not created: ${resolve(explicit)}. Create it or change PI_REVIEW_GATE_CONFIG, then reopen.`, "error");
      return;
    }
    config = loaded.config;
    configPath = loaded.path;
  } else {
    // First use: no explicit override and no implicit candidate. The same
    // ordinary zero-model defaults the guarded initializer publishes.
    configPath = join(agentDir, REVIEW_GATE_CONFIG_FILENAME);
    config = normalizeConfig(JSON.parse(DEFAULT_REVIEW_GATE_CONFIG_JSON) as unknown);
    const pinned = configPath;
    beforePersist = () => {
      // The existing guarded initializer keeps any primary or compatibility
      // config that appeared after opening and declines to create a primary
      // that would shadow a new fallback. This draft stays pinned to the
      // primary: it is never retargeted, and nothing is retried.
      ensureNativeReviewGateConfig(agentDir, input.cwd, configEnv);
      if (isAbsent(pinned)) {
        throw new Error(`another review-gate config appeared after these settings were opened, so ${pinned} was not created and nothing was saved. Reopen the settings to edit the current config.`);
      }
    };
  }

  const loadChoices = dependencies.loadChoices ?? ((catalogInput) => loadReviewSettingsChoices(catalogInput));
  const catalog = await loadChoices({
    piExecutable: input.piExecutable,
    agentDir,
    ...(input.args !== undefined ? { args: input.args } : {}),
  });

  const target = resolve(configPath);
  const targetNotice = beforePersist
    ? `Editing LOCAL review-gate settings for this host. No config exists yet; showing defaults. Save creates ${target}; Cancel leaves it absent. Running sessions are not changed.`
    : `Editing LOCAL review-gate settings for this host: ${target}. Saving changes this file for every session that loads it; running sessions are not changed.`;
  // The LOCAL target is the base section of the whole open: a host without the
  // section-help port receives it as the same first (guarded) info notice as
  // before; the sidebar keeps it as the notice every screen outside a deeper
  // section returns to, while the opening diagnostics below are the first
  // screen's result.
  const section = ui.settingsSectionHelp;
  const withTarget = typeof section?.section === "function"
    ? (run: () => Promise<void>) => section.section(targetNotice, run)
    : async (run: () => Promise<void>) => {
      notify(ui, targetNotice, "info");
      await run();
    };
  await withTarget(async () => {
    // Opening diagnostics, ranked by consequence through their explicit type
    // and order (a single-notice host shows the most severe, newest last):
    // routine catalog guidance first, then config-load warnings, then the
    // fail-closed tool-protection error — saved protection that does not load
    // blocks protected calls until a valid apply, so it is an error.
    for (const warning of catalog.warnings) notify(ui, `review gate: settings catalog: ${bounded(warning)}`, "warning");
    for (const warning of loaded.warnings ?? []) notify(ui, `review gate: ${bounded(warning)}`, "warning");
    if (loaded.toolProtectionError !== undefined) {
      notify(ui, `review gate: saved tool-protection settings are invalid: ${bounded(loaded.toolProtectionError)}`, "error");
    }

    ui.cwd = input.cwd;
    const tools = catalog.tools;
    // The outcome (and any saved config) is intentionally dropped: the next
    // open re-reads the disk.
    await runPersistedReviewSettings({
      config,
      configPath,
      ui,
      scoped: catalog.scoped,
      getToolChoices: () => tools,
      getAuditedToolChoices: () => tools,
      ...(beforePersist ? { beforePersist } : {}),
    });
  });
}

function isAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function notify(ui: UiContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ui.notify?.(message, type);
  } catch {
    // A failing notice sink never escapes the service.
  }
}

function bounded(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_NOTICE_CHARS ? `${single.slice(0, MAX_NOTICE_CHARS - 1)}…` : single;
}

/** A JSON parser message can quote file bytes; never surface it. */
function boundedErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "the review-gate config is not valid JSON; nothing was saved.";
  return bounded(error instanceof Error ? error.message : String(error));
}
