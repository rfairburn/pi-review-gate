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
 *
 * Issue #716: an unavailable Local is still a target of the requester-side host
 * picker. The refusal stays exactly the same and nothing is staged — no file is
 * created and no other config is substituted — but when the caller supplied the
 * picker's `targetControl`, the same picker is offered from that refusal so the
 * operator can deliberately switch to another host. That refusal covers every
 * way this target can fail to open before its editor starts, including a load
 * rejection such as an unavailable settings catalog. A standalone Local open
 * (no `targetControl`) is unchanged, and a declined, same-target, or stale pick
 * simply ends the open with nothing written.
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { PI_AGENT_DIR_ENV, REVIEW_GATE_CONFIG_FILENAME } from "../config-path";
import { loadConfig, normalizeConfig, type ReviewGateConfig } from "../config";
import { runPersistedReviewSettings, type PersistedReviewSettingsInput } from "../settings/command";
import type { UiContext } from "../settings/ui";
import { configResolutionForEnv, DEFAULT_REVIEW_GATE_CONFIG_JSON, ensureNativeReviewGateConfig } from "./profiles";
import { loadReviewSettingsChoices, type ReviewSettingsCatalog, type ReviewSettingsCatalogInput } from "./review-settings-catalog";

export interface OwnedReviewSettingsInput {
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
  /** This host's startup workspace: anchors workspace-relative settings validation. */
  cwd: string;
}

export interface LocalReviewSettingsInput extends OwnedReviewSettingsInput {
  /** Host settings UI for this one open; the service sets `ui.cwd = cwd`. */
  ui: UiContext;
}

/** Hermetic test seams. */
export interface LocalReviewSettingsDependencies {
  loadChoices?: (input: ReviewSettingsCatalogInput) => Promise<ReviewSettingsCatalog>;
}

/** Open the LOCAL review settings once. Never rejects: failures become UI errors. */
export async function openLocalReviewSettings(
  input: LocalReviewSettingsInput,
  dependencies: LocalReviewSettingsDependencies = {},
): Promise<void> {
  await openLocalReviewSettingsForTarget(input, undefined, dependencies);
}

/** Open Local within the host picker; true only when the shared draft switched targets. */
export async function openLocalReviewSettingsForTarget(
  input: LocalReviewSettingsInput,
  targetControl: PersistedReviewSettingsInput["targetControl"],
  dependencies: LocalReviewSettingsDependencies = {},
): Promise<boolean> {
  try {
    return await openOnce(input, dependencies, targetControl);
  } catch (error) {
    notify(input.ui, `review gate: local review settings failed: ${errorMessage(error)}`, "error");
    return false;
  }
}

type OwnedReviewSettingsOpening =
  | { kind: "unavailable"; reason: "disabled" | "missing-explicit"; localMessage: string }
  | {
      kind: "opened";
      config: ReviewGateConfig;
      configPath: string;
      catalog: ReviewSettingsCatalog;
      warnings: readonly string[];
      toolProtectionError?: string;
      beforePersist?: () => void;
    };

/**
 * Resolve and load an owner's persisted settings without opening an editor or
 * creating a file. The returned record is private owner state, not wire data.
 */
export async function loadOwnedReviewSettings(
  input: OwnedReviewSettingsInput,
  dependencies: LocalReviewSettingsDependencies = {},
): Promise<OwnedReviewSettingsOpening> {
  const { agentDir } = input;
  const configEnv: NodeJS.ProcessEnv = { ...input.env, [PI_AGENT_DIR_ENV]: agentDir };
  const resolution = configResolutionForEnv(input.env);
  const loaded = loadConfig(configEnv, resolution);
  if (loaded.globallyDisabled) {
    return {
      kind: "unavailable", reason: "disabled",
      localMessage: `review gate: local review settings are unavailable because ${loaded.disabledReason ?? "the review gate is globally disabled"}.`,
    };
  }

  const explicit = configEnv.PI_REVIEW_GATE_CONFIG;
  let config: ReviewGateConfig;
  let configPath: string;
  let beforePersist: (() => void) | undefined;
  if (loaded.path !== undefined) {
    if (explicit && loaded.path === explicit && isAbsent(explicit)) {
      return {
        kind: "unavailable", reason: "missing-explicit",
        localMessage: `review gate: the explicitly selected review-gate config does not exist and is not created: ${resolve(explicit)}. Create it or change PI_REVIEW_GATE_CONFIG, then reopen.`,
      };
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

  return {
    kind: "opened", config, configPath, catalog, warnings: loaded.warnings ?? [],
    ...(loaded.toolProtectionError === undefined ? {} : { toolProtectionError: loaded.toolProtectionError }),
    ...(beforePersist === undefined ? {} : { beforePersist }),
  };
}

async function openOnce(
  input: LocalReviewSettingsInput,
  dependencies: LocalReviewSettingsDependencies,
  targetControl: PersistedReviewSettingsInput["targetControl"],
): Promise<boolean> {
  const { ui } = input;
  let opening: OwnedReviewSettingsOpening;
  try {
    opening = await loadOwnedReviewSettings(input, dependencies);
  } catch (error) {
    // A Local target whose own data cannot load never reaches an editor, so it
    // is refused exactly like an unavailable one: same error text, same
    // no-write/no-substitute behavior, and the same picker when the caller has
    // one. Failures after the editor started are not routed here.
    return await refuseLocal(input, targetControl, `review gate: local review settings failed: ${errorMessage(error)}`);
  }
  if (opening.kind === "unavailable") {
    return await refuseLocal(input, targetControl, opening.localMessage);
  }
  const { config, configPath, catalog, beforePersist } = opening;
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
    ? (run: () => Promise<boolean>) => section.section(targetNotice, run)
    : async (run: () => Promise<boolean>) => {
      notify(ui, targetNotice, "info");
      return await run();
    };
  return await withTarget(async () => {
    // Opening diagnostics, ranked by consequence through their explicit type
    // and order (a single-notice host shows the most severe, newest last):
    // routine catalog guidance first, then config-load warnings, then the
    // fail-closed tool-protection error — saved protection that does not load
    // blocks protected calls until a valid apply, so it is an error.
    for (const warning of catalog.warnings) notify(ui, `review gate: settings catalog: ${singleLine(warning)}`, "warning");
    for (const warning of opening.warnings) notify(ui, `review gate: ${singleLine(warning)}`, "warning");
    if (opening.toolProtectionError !== undefined) {
      notify(ui, `review gate: saved tool-protection settings are invalid: ${singleLine(opening.toolProtectionError)}`, "error");
    }

    ui.cwd = input.cwd;
    const tools = catalog.tools;
    // Drop any saved config: the next open re-reads the disk. Only the
    // explicit target switch needs to cross back to the picker controller.
    const outcome = await runPersistedReviewSettings({
      config,
      configPath,
      ui,
      scoped: catalog.scoped,
      getToolChoices: () => tools,
      getAuditedToolChoices: () => tools,
      ...(beforePersist ? { beforePersist } : {}),
      ...(targetControl === undefined ? {} : { targetControl }),
    });
    return outcome.kind === "switched";
  });
}

/**
 * Refuse this Local target without opening an editor (issue #716). The message
 * is the target's whole result and it is never retargeted: nothing is created,
 * staged, or substituted. With a picker (`targetControl`) the refusal stays on
 * the frame and the SAME host picker opens over it, so one broken Local does
 * not also hide every other host. There is no draft to re-show, so a declined
 * pick, a pick of Local itself, or a stale route just ends the open; `true`
 * means the shared loop accepted a real switch.
 */
async function refuseLocal(
  input: LocalReviewSettingsInput,
  targetControl: PersistedReviewSettingsInput["targetControl"],
  message: string,
): Promise<boolean> {
  notify(input.ui, message, "error");
  if (targetControl === undefined) return false;
  // Nothing is staged on this path, and the picker is told exactly that. The
  // same explicit no-draft state is what this open publishes through the
  // host's single draft-status slot while the picker is up (#723), so a host
  // that leaves the pane meanwhile knows there is nothing to discard. No
  // transaction runs here, so the slot is not shared with another predicate.
  const hasUnsavedChanges = false;
  const port = input.ui.settingsDraftStatus;
  let detach: (() => void) | undefined;
  try {
    detach = typeof port?.attach === "function" ? port.attach(() => hasUnsavedChanges) : undefined;
  } catch {
    detach = undefined;
  }
  let switched: boolean;
  try {
    switched = await targetControl.requestSwitch(hasUnsavedChanges);
  } finally {
    if (typeof detach === "function") detach();
  }
  // A declined, same-target, or stale pick ends the open with nothing staged,
  // and the refusal is reported again so the Settings menu still shows why
  // Local did not open (a closed pane ignores this).
  if (!switched) notify(input.ui, message, "error");
  return switched;
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

/**
 * One display line of a diagnostic, never shortened (#653): the sidebar wraps
 * a long notice and offers it whole in its read-only notice reader, and it
 * sanitizes terminal text itself.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A JSON parser message can quote file bytes; never surface it. */
function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "the review-gate config is not valid JSON; nothing was saved.";
  return singleLine(error instanceof Error ? error.message : String(error));
}
