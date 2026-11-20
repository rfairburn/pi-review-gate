/**
 * Standalone review-settings choice catalogs (issue #653).
 *
 * The session host's standalone settings editor needs the same two candidate
 * inventories the in-Pi `/review-settings` menu receives from a live session —
 * scoped MODEL choices (with their reasoning levels) and TOOL names — but it
 * runs without any Pi session. This module builds both from configuration
 * metadata alone:
 *
 * - **Models.** The installed public Pi SDK of the actual resolved Pi
 *   executable (validated by {@link resolveNativeSessionSdk}: official
 *   package, supported stable version, role/settlement guards) supplies
 *   `ModelRuntime`, `SettingsManager`, `parseArgs`, and
 *   `resolveModelScopeWithDiagnostics`. The runtime is created with
 *   `refreshOnCreate: false` and `allowModelNetwork: false`, an explicit
 *   `modelsPath` inside the caller's canonical agent directory, an EMPTY
 *   read-only credential store (no `auth.json` read, no credential write, no
 *   key or env bytes ever surfaced), and an empty in-memory model store (no
 *   cached catalog file is opened or rewritten). Scope patterns come from
 *   explicit host `--models` args when present, else the GLOBAL
 *   `enabledModels` read through a read-only storage port — exactly Pi's own
 *   `parsed.models ?? settingsManager.getEnabledModels()` precedence. Project
 *   settings are never read and no trust is granted. The native resolver
 *   receives a narrow port whose `getAvailable` returns the static
 *   `getModels()` metadata: that is CATALOG ELIGIBILITY, deliberately not
 *   authenticated runtime availability (the real `getAvailable`, auth checks,
 *   and refreshes are never called). The resolved `ScopedModel` entries are
 *   converted by the existing {@link scopedModelChoices}, so model ids, pinned
 *   pattern thinking levels, and supported reasoning levels follow the same
 *   rules as in-Pi; unknown models are never guessed into the catalog.
 * - **Tools.** Every shipped configuration candidate name: the native Pi
 *   builtins whose public `create*ToolDefinition` factories the same SDK
 *   exports (definitions are built for their `name`/`description` only and
 *   never executed), the native codemode tool and reserved discovery loader,
 *   and every review-gate registration name from the canonical constants the
 *   real registrars use. These are configuration names only: listing one
 *   never grants, activates, or claims the runtime currently offers it.
 *   Dynamic MCP/extension tools cannot be discovered without a session; saved
 *   names for them stay retained through the existing pickers. The reserved
 *   `tool_search` loader is listed so the audit picker can show it; the deny
 *   pickers keep excluding it through `readToolChoices`/`deniableToolNames`.
 *
 * Failure is explicit. When the SDK cannot be resolved or lacks the model
 * surface, the returned promise rejects with
 * {@link ReviewSettingsCatalogUnavailableError} — never an empty "success".
 * Recoverable partial problems Pi itself tolerates (unreadable global
 * settings, models.json errors, scope pattern diagnostics, missing native tool
 * definitions) are reported as bounded `warnings` that never quote file
 * contents. An unset or empty model scope also carries one bounded guidance
 * warning saying the Pi pickers have no choices until models are scoped in a
 * real Pi session; it is informational only — nothing is blocked, created,
 * enrolled, or written.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { scopedModelChoices, type ScopedModelChoice } from "../settings/models";
import { CODEMODE_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME, type ToolInventoryEntry } from "../tool-inventory";
import { EXECUTION_TOOL_ACTIONS, EXECUTION_TOOL_NAMES } from "../execution/tool-names";
import { WEB_TOOL_NAMES } from "../web/tool-names";
import { BACKGROUND_SHELL_TOOL_NAMES } from "../background-shell/tool-names";
import { APPLY_PATCH_TOOL_NAME } from "../apply-patch/tool";
import { GIT_READ_TOOL_NAME } from "../git-read/tool";
import { USER_QUESTION_TOOL_NAME } from "../user-question/tool";
import { YOU_SHOULD_KNOW_TOOL_NAME } from "../user-question/notice-tool";
import { SESSION_SPAWN_TOOL_NAME } from "./spawn-tool";
import { SESSION_HOSTS_TOOL_NAME } from "./hosts-tool";
import { resolveNativeSessionSdk } from "./native-session-sdk";
import { isRecord } from "../record-guard";

/** Upper bound for the global settings file read through the read-only port. */
export const MAX_GLOBAL_SETTINGS_BYTES = 4 * 1024 * 1024;

/** Inputs: the actual resolved Pi executable, its canonical agent dir, and forwarded host args. */
export interface ReviewSettingsCatalogInput {
  /** Absolute path of the actual resolved native Pi CLI file (the declared bin or dist/cli.js). */
  piExecutable: string;
  /** Absolute canonical Pi agent directory (holds models.json and the global settings.json). */
  agentDir: string;
  /**
   * The Pi command-line arguments the host forwards to Pi (without the
   * executable). Only `--models` is honored, parsed by Pi's own `parseArgs`.
   */
  args?: readonly string[];
}

/** Where the model scope patterns came from (Pi's own precedence). */
export type ReviewSettingsModelScopeSource = "args" | "enabledModels" | "none";

export interface ReviewSettingsCatalog {
  /** Scoped model choices, converted by the canonical {@link scopedModelChoices}. */
  scoped: ScopedModelChoice[];
  /** Shipped configuration candidate tool names (never authority, never availability). */
  tools: ToolInventoryEntry[];
  /** Bounded, content-free diagnostics for recoverable partial problems. */
  warnings: string[];
  /** The scope patterns that were resolved and their source. */
  modelScope: { source: ReviewSettingsModelScopeSource; patterns: string[] };
}

/** Test seams and injected dependencies. */
export interface ReviewSettingsCatalogDependencies {
  /**
   * Loads the public SDK module of the official Pi package that owns
   * `piExecutable`. Defaults to {@link resolveNativeSessionSdk} validation
   * followed by loading its validated public entry.
   */
  loadSdk?: (piExecutable: string) => Record<string, unknown>;
}

/** The catalog could not be built truthfully; nothing was fabricated. */
export class ReviewSettingsCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSettingsCatalogUnavailableError";
  }
}

/**
 * Every review-gate tool registration name, from the canonical constants the
 * real registrars use (no second copy of any name). Pure configuration
 * candidates: whether a registrar actually registers its tools in a given
 * session (role, mode, `web.enabled`, session-host capability, …) is decided
 * at runtime and is never implied by membership here.
 */
export function shippedReviewGateToolNames(): string[] {
  return [
    ...EXECUTION_TOOL_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]),
    ...Object.values(WEB_TOOL_NAMES),
    ...Object.values(BACKGROUND_SHELL_TOOL_NAMES),
    APPLY_PATCH_TOOL_NAME,
    GIT_READ_TOOL_NAME,
    USER_QUESTION_TOOL_NAME,
    YOU_SHOULD_KNOW_TOOL_NAME,
    SESSION_SPAWN_TOOL_NAME,
    SESSION_HOSTS_TOOL_NAME,
    DEFERRED_TOOL_SEARCH_NAME,
  ];
}

/**
 * Native Pi builtin tool entries from the SDK's own exported public
 * `create<Name>ToolDefinition` factories. Each definition is constructed for
 * its metadata only (construction is lazy in the SDK: no shell probe, no file
 * access) and is never executed. A factory that throws or yields malformed
 * metadata is skipped; the count of usable definitions tells the caller
 * whether native builtins were discoverable at all.
 */
export function nativeBuiltinToolEntries(sdk: Record<string, unknown>, cwd: string): ToolInventoryEntry[] {
  const entries: ToolInventoryEntry[] = [];
  for (const key of Object.keys(sdk).sort()) {
    if (!/^create[A-Z][A-Za-z]*ToolDefinition$/.test(key)) continue;
    const factory = sdk[key];
    if (typeof factory !== "function") continue;
    let definition: unknown;
    try {
      definition = (factory as (cwd: string) => unknown)(cwd);
    } catch {
      continue;
    }
    if (!isRecord(definition)) continue;
    const name = definition.name;
    if (typeof name !== "string" || name.length === 0 || name.trim() !== name) continue;
    const description = definition.description;
    entries.push(typeof description === "string" && description.length > 0 ? { name, description } : { name });
  }
  return entries;
}

/**
 * Build the standalone settings choice catalogs. See the module comment for
 * the exact no-session, no-network, no-auth, no-write boundaries.
 */
export async function loadReviewSettingsChoices(
  input: ReviewSettingsCatalogInput,
  dependencies: ReviewSettingsCatalogDependencies = {},
): Promise<ReviewSettingsCatalog> {
  const { piExecutable, agentDir } = input;
  if (typeof agentDir !== "string" || !isAbsolute(agentDir)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the Pi agent directory must be an absolute path for the settings catalog");
  }
  if (typeof piExecutable !== "string" || !isAbsolute(piExecutable)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the native pi executable must be an absolute path for the settings catalog");
  }
  const loadSdk = dependencies.loadSdk ?? defaultLoadSdk;
  let sdk: Record<string, unknown>;
  try {
    sdk = loadSdk(piExecutable);
  } catch (error) {
    throw new ReviewSettingsCatalogUnavailableError(
      `pi-review-gate: the installed Pi SDK is unavailable for the settings catalog: ${boundedMessage(error)}`,
    );
  }
  if (!isRecord(sdk)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK did not load a module for the settings catalog");
  }

  const warnings: string[] = [];
  const { patterns, source } = readScopePatterns(sdk, agentDir, input.args ?? [], warnings);
  const scoped = await resolveScopedChoices(sdk, agentDir, patterns, warnings);
  const tools = collectToolCandidates(sdk, agentDir, warnings);
  return { scoped, tools, warnings, modelScope: { source, patterns } };
}

function defaultLoadSdk(piExecutable: string): Record<string, unknown> {
  // Validation (official package, stable supported version, declared bin,
  // contained entry, executor/settlement role guards) and the first load
  // happen in the shared resolver; the validated entry is then read from the
  // Node module cache, so the same module record backs both consumers.
  const resolved = resolveNativeSessionSdk(piExecutable);
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const module = require(resolved.entry) as unknown;
  if (!isRecord(module)) throw new Error("the public SDK entry did not load a module");
  return module;
}

/**
 * Pi's own precedence: explicit `--models` (parsed by the SDK's `parseArgs`)
 * wins, else the GLOBAL `enabledModels`. Project settings are never read.
 */
function readScopePatterns(
  sdk: Record<string, unknown>,
  agentDir: string,
  args: readonly string[],
  warnings: string[],
): { patterns: string[]; source: ReviewSettingsModelScopeSource } {
  if (args.length > 0) {
    const parseArgs = sdk.parseArgs;
    if (typeof parseArgs !== "function") {
      throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK does not export parseArgs; forwarded --models cannot be resolved for the settings catalog");
    }
    let parsed: unknown;
    try {
      parsed = (parseArgs as (args: string[]) => unknown)([...args]);
    } catch (error) {
      throw new ReviewSettingsCatalogUnavailableError(`pi-review-gate: Pi could not parse the forwarded host arguments: ${boundedMessage(error)}`);
    }
    const models = isRecord(parsed) ? parsed.models : undefined;
    if (Array.isArray(models)) {
      return { patterns: models.filter((pattern): pattern is string => typeof pattern === "string"), source: "args" };
    }
  }
  const enabled = readGlobalEnabledModels(sdk, agentDir, warnings);
  if (enabled === undefined) return { patterns: [], source: "none" };
  return { patterns: enabled, source: "enabledModels" };
}

function readGlobalEnabledModels(sdk: Record<string, unknown>, agentDir: string, warnings: string[]): string[] | undefined {
  const SettingsManager = sdk.SettingsManager;
  const fromStorage = isRecord(SettingsManager) || typeof SettingsManager === "function"
    ? (SettingsManager as { fromStorage?: unknown }).fromStorage
    : undefined;
  if (typeof fromStorage !== "function") {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK does not export SettingsManager.fromStorage for the settings catalog");
  }
  const settingsPath = join(agentDir, "settings.json");
  // Read-only storage port: global content only, project scope always empty,
  // and any attempted write (a non-undefined return) refused.
  const storage = {
    withLock(scope: string, fn: (current: string | undefined) => string | undefined): void {
      const current = scope === "global" ? readBoundedGlobalSettings(settingsPath) : undefined;
      if (fn(current) !== undefined) throw new Error("the settings catalog storage is read-only");
    },
  };
  let manager: unknown;
  try {
    manager = (fromStorage as (storage: unknown, options: unknown) => unknown).call(SettingsManager, storage, { projectTrusted: false });
  } catch {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: Pi could not open the global settings for the settings catalog");
  }
  if (!isRecord(manager)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: Pi could not open the global settings for the settings catalog");
  }
  const drain = manager.drainErrors;
  const errors = typeof drain === "function" ? (drain as () => unknown).call(manager) : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    // Pi proceeds with empty settings on a load error; mirror that, and never
    // quote the parser message (it can contain file bytes).
    warnings.push("Pi global settings could not be loaded; enabledModels is treated as unset, as Pi does");
  }
  const getEnabledModels = manager.getEnabledModels;
  if (typeof getEnabledModels !== "function") {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK SettingsManager lacks getEnabledModels for the settings catalog");
  }
  const enabled = (getEnabledModels as () => unknown).call(manager);
  if (enabled === undefined) return undefined;
  if (!Array.isArray(enabled)) {
    warnings.push("Pi global enabledModels is not a list; it is treated as unset");
    return undefined;
  }
  const patterns = enabled.filter((pattern): pattern is string => typeof pattern === "string");
  if (patterns.length !== enabled.length) warnings.push("Pi global enabledModels contains non-text entries; they are ignored");
  return patterns;
}

function readBoundedGlobalSettings(path: string): string | undefined {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("global settings could not be inspected");
  }
  if (!stats.isFile()) throw new Error("global settings is not a regular file");
  if (stats.size > MAX_GLOBAL_SETTINGS_BYTES) throw new Error("global settings exceeds the catalog read bound");
  return readFileSync(path, "utf8");
}

/**
 * Bounded, content-free first-launch guidance for an unset or empty Pi model
 * scope. It is a notice only: nothing is created, enrolled, or refused because
 * of it, and it never quotes configuration bytes. Short enough to survive the
 * consumer's notice bound without truncation.
 */
const NO_SCOPED_PI_MODELS_WARNING =
  "no Pi models are scoped yet, so the Pi model pickers offer no choices; configure Pi's own base settings and scoped models in a real Pi session first (a sidebar New session works with review and subtasks left unset), then reopen: this editor is not Pi's settings editor";

/** Narrow credential store: always empty, never written. */
const EMPTY_READ_ONLY_CREDENTIALS = Object.freeze({
  read: async (): Promise<undefined> => undefined,
  list: async (): Promise<readonly never[]> => [],
  modify: async (): Promise<never> => {
    throw new Error("the settings catalog never writes credentials");
  },
  delete: async (): Promise<never> => {
    throw new Error("the settings catalog never deletes credentials");
  },
});

/** Narrow model store: no cached catalog is read, nothing is persisted. */
const EMPTY_MODELS_STORE = Object.freeze({
  read: async (): Promise<undefined> => undefined,
  write: async (): Promise<never> => {
    throw new Error("the settings catalog never persists model catalogs");
  },
  delete: async (): Promise<never> => {
    throw new Error("the settings catalog never deletes model catalogs");
  },
});

async function resolveScopedChoices(
  sdk: Record<string, unknown>,
  agentDir: string,
  patterns: string[],
  warnings: string[],
): Promise<ScopedModelChoice[]> {
  const ModelRuntime = sdk.ModelRuntime;
  const create = isRecord(ModelRuntime) || typeof ModelRuntime === "function"
    ? (ModelRuntime as { create?: unknown }).create
    : undefined;
  const resolveScope = sdk.resolveModelScopeWithDiagnostics;
  if (typeof create !== "function" || typeof resolveScope !== "function") {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK does not export ModelRuntime.create and resolveModelScopeWithDiagnostics for the settings catalog");
  }
  let runtime: unknown;
  try {
    runtime = await (create as (options: unknown) => Promise<unknown>).call(ModelRuntime, {
      credentials: EMPTY_READ_ONLY_CREDENTIALS,
      modelsPath: join(agentDir, "models.json"),
      modelsStore: EMPTY_MODELS_STORE,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  } catch {
    // The SDK's message is not quoted: it may echo configuration bytes.
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: Pi could not build the model metadata catalog");
  }
  if (!isRecord(runtime) || typeof runtime.getModels !== "function") {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: the installed Pi SDK model runtime lacks getModels for the settings catalog");
  }
  const getError = runtime.getError;
  const runtimeError = typeof getError === "function" ? (getError as () => unknown).call(runtime) : undefined;
  if (typeof runtimeError === "string" && runtimeError.length > 0) {
    // The SDK's text can quote models.json bytes; report only the fact.
    warnings.push("Pi reported errors in models.json; affected custom models are omitted from the catalog");
  }
  // Pi resolves no scope at all when there are no patterns, so no Pi model
  // choice can be offered. That is stated informationally (issue #653): the
  // scope comes from Pi's own configuration, which this editor never writes.
  // The notice blocks nothing — the host, the sidebar's New session, this
  // editor, and every other persisted section stay usable, and a session
  // started for Pi setup may leave review and subtasks unset. Configuring the
  // whole first-run setup from the sidebar itself is separate future work.
  if (patterns.length === 0) {
    warnings.push(NO_SCOPED_PI_MODELS_WARNING);
    return [];
  }
  const getModels = runtime.getModels as () => unknown;
  // Catalog-eligibility port: the native scope grammar only calls
  // `getAvailable`, answered here from static metadata. This is NOT
  // authenticated availability, and the runtime's real getAvailable is never
  // called.
  const catalogEligibility = {
    getAvailable: async (): Promise<unknown> => getModels.call(runtime),
  };
  let result: unknown;
  try {
    result = await (resolveScope as (patterns: string[], runtime: unknown) => Promise<unknown>)([...patterns], catalogEligibility);
  } catch (error) {
    throw new ReviewSettingsCatalogUnavailableError(`pi-review-gate: Pi could not resolve the model scope for the settings catalog: ${boundedMessage(error)}`);
  }
  if (!isRecord(result) || !Array.isArray(result.scopedModels)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: Pi returned a malformed model scope for the settings catalog");
  }
  if (Array.isArray(result.diagnostics)) {
    for (const diagnostic of result.diagnostics) {
      if (isRecord(diagnostic) && typeof diagnostic.message === "string" && diagnostic.message.length > 0) {
        warnings.push(boundedText(diagnostic.message));
      }
    }
  }
  return scopedModelChoices({ scopedModels: result.scopedModels }) ?? [];
}

function collectToolCandidates(sdk: Record<string, unknown>, cwd: string, warnings: string[]): ToolInventoryEntry[] {
  const native = nativeBuiltinToolEntries(sdk, cwd);
  if (native.length === 0) {
    warnings.push("the installed Pi SDK exposes no native builtin tool definitions; native builtin tool names are not offered");
  }
  const byName = new Map<string, ToolInventoryEntry>();
  for (const entry of native) if (!byName.has(entry.name)) byName.set(entry.name, entry);
  for (const name of [CODEMODE_TOOL_NAME, ...shippedReviewGateToolNames()]) {
    if (!byName.has(name)) byName.set(name, { name });
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

const MAX_DIAGNOSTIC_CHARS = 400;

function boundedText(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_DIAGNOSTIC_CHARS ? `${single.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…` : single;
}

function boundedMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error));
}
