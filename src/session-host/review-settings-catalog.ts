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
 *   key or env bytes ever surfaced), and an empty runtime model store that
 *   refuses every write. Pi's own saved provider catalog in the SAME agent
 *   directory (`models-store.json`, the file Pi's native runtime uses for
 *   dynamic provider catalogs such as the pi.dev overlay) is then restored
 *   offline: the file is read once through a no-follow descriptor (symlinks
 *   and special files refused), bounded, without locks or writes; each entry
 *   whose records carry the field types Pi's resolver and composition assume
 *   is handed to that registered provider's public
 *   cache-only `refreshModels` hook (`allowNetwork: false`, no credential),
 *   exactly the restore phase Pi runs before any auth or network step. The
 *   provider keeps every native rule — freshness against its bundled data,
 *   provider identity, chat-only listing, models.json overrides — and any
 *   publication that asks to persist is refused without applying. A missing
 *   file contributes nothing; an unreadable, oversized, or malformed file or
 *   entry is skipped with one bounded content-free warning and the static
 *   and models.json catalog stays usable; if Pi's resolver still rejects the
 *   restored catalog, the scope is resolved again without any saved catalog.
 *   `ModelRuntime.refresh`, the real
 *   availability pass, and auth checks are never called. Scope patterns come from
 *   explicit host `--models` args when present, else the GLOBAL
 *   `enabledModels` read through a read-only storage port — exactly Pi's own
 *   `parsed.models ?? settingsManager.getEnabledModels()` precedence. Project
 *   settings are never read and no trust is granted. The native resolver
 *   receives a narrow port whose `getAvailable` returns the runtime's
 *   chat-only `getModels()` metadata (static, models.json, and restored
 *   saved catalogs): that is CATALOG ELIGIBILITY, deliberately not
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
 *   The same enumeration ({@link enumerateOfflineToolCandidates}) also backs
 *   the tool-only {@link loadNativeWorkerToolCandidates} entry (issue #682):
 *   native-owned Pi worker admission resolves the SAME offline coverage
 *   before launch, with per-name provenance, without the model catalog,
 *   settings, trust, auth, extensions, or MCP. Dynamic third-party MCP and
 *   extension tools stay out of both surfaces (follow-up #740).
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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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

/** Upper bound for Pi's saved provider catalog (`models-store.json`) snapshot. */
export const MAX_SAVED_PROVIDER_CATALOG_BYTES = 32 * 1024 * 1024;

/** Elapsed bound for the offline restore of every saved provider catalog. */
export const SAVED_PROVIDER_CATALOG_RESTORE_TIMEOUT_MS = 5_000;

/** Pi's native per-agent saved provider catalog file name (beside models.json). */
export const SAVED_PROVIDER_CATALOG_FILE = "models-store.json";

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
      `pi-review-gate: the installed Pi SDK is unavailable for the settings catalog: ${errorLine(error)}`,
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

function defaultLoadSdk(piExecutable: string, expectedPiVersion?: string): Record<string, unknown> {
  // Validation (official package, stable supported version, declared bin,
  // contained entry, executor/settlement role guards) and the first load
  // happen in the shared resolver; the validated entry is then read from the
  // Node module cache, so the same module record backs both consumers.
  const resolved = resolveNativeSessionSdk(piExecutable, expectedPiVersion === undefined ? {} : { expectedPiVersion });
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
      throw new ReviewSettingsCatalogUnavailableError(`pi-review-gate: Pi could not parse the forwarded host arguments: ${errorLine(error)}`);
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

/**
 * The runtime's own model store: never read through and never persisted to.
 * Pi's saved provider catalog is restored separately, read-only, by
 * {@link restoreSavedProviderCatalogs}.
 */
const EMPTY_MODELS_STORE = Object.freeze({
  read: async (): Promise<undefined> => undefined,
  write: async (): Promise<never> => {
    throw new Error("the settings catalog never persists model catalogs");
  },
  delete: async (): Promise<never> => {
    throw new Error("the settings catalog never deletes model catalogs");
  },
});

/**
 * Model types the pinned Pi SDK knows. Mirrors pi-ai's own restore filter
 * (`withKnownModelTypes`: a missing type is a legacy chat model), so a saved
 * entry written by a newer Pi with a type this SDK cannot use is dropped the
 * same way the native runtime drops it.
 */
const KNOWN_SAVED_MODEL_TYPES: ReadonlySet<string> = new Set(["chat", "image", "classifier"]);

const SAVED_CATALOG_FALLBACK = "only built-in and models.json models are offered";

/**
 * Read Pi's saved provider catalog once, descriptor-based like the SDK
 * manifest read: a symlink or special file is refused (lstat, then an
 * O_NOFOLLOW non-blocking read-only open whose fstat identity must match),
 * at most the byte cap plus one detection byte is read from that same
 * descriptor, and nothing is locked or written. A BOM is stripped like Pi's
 * store. Returns undefined when absent or unusable (unusable is reported
 * once, content-free).
 */
function readSavedProviderCatalog(agentDir: string, warnings: string[]): Record<string, unknown> | undefined {
  const path = join(agentDir, SAVED_PROVIDER_CATALOG_FILE);
  const unusable = (reason: string): undefined => {
    warnings.push(`Pi's saved provider catalog ${reason}; ${SAVED_CATALOG_FALLBACK}`);
    return undefined;
  };
  let preStats;
  try {
    preStats = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return unusable("could not be inspected");
  }
  if (preStats.isSymbolicLink() || !preStats.isFile()) return unusable("is not a regular file");
  if (preStats.size > BigInt(MAX_SAVED_PROVIDER_CATALOG_BYTES)) return unusable("exceeds the catalog read bound");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return unusable("could not be read");
  }
  let content: string;
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (stats.dev !== preStats.dev || stats.ino !== preStats.ino || !stats.isFile()) return unusable("changed while it was read");
    // Sized from the descriptor, plus one byte that detects growth past it.
    const buffer = Buffer.alloc(Math.min(Number(stats.size), MAX_SAVED_PROVIDER_CATALOG_BYTES) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SAVED_PROVIDER_CATALOG_BYTES) return unusable("exceeds the catalog read bound");
    if (offset > Number(stats.size)) return unusable("changed while it was read");
    content = buffer.subarray(0, offset).toString("utf8");
  } catch {
    return unusable("could not be read");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask the bounded read result.
    }
  }
  let parsed: unknown;
  try {
    parsed = content.length === 0 ? {} : JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch {
    // Never quote the parser message: it can contain file bytes.
    return unusable("could not be read");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return unusable("is malformed");
  return parsed;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => isRecord(value) && !Array.isArray(value);
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const isText = (value: unknown): boolean => typeof value === "string";
const isFiniteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/**
 * The model fields Pi's scope resolver, models.json override composition,
 * and the canonical choice conversion read, checked for the types they
 * assume. A record failing this would make Pi's matcher or composition throw
 * and take valid static choices down with it.
 */
function isWellFormedSavedModel(model: unknown): boolean {
  if (!isPlainRecord(model)) return false;
  if (typeof model.id !== "string" || model.id.length === 0) return false;
  if (typeof model.provider !== "string" || model.provider.length === 0) return false;
  // Core fields every native record carries (pi-ai's model types; image and
  // classifier models have no reasoning/maxTokens, images no contextWindow).
  // A missing one is never defaulted: e.g. a models.json cost override
  // dereferences `cost`, and the throwing composed provider would silently
  // drop its built-in and custom models too.
  if (!isText(model.name) || !isText(model.baseUrl) || typeof model.api !== "string" || model.api.length === 0) return false;
  const chat = model.type === undefined || model.type === "chat";
  if (chat && (typeof model.reasoning !== "boolean"
    || !isFiniteNumber(model.contextWindow) || !isFiniteNumber(model.maxTokens))) return false;
  if (!optional(model.reasoning, (value) => typeof value === "boolean")) return false;
  if (!optional(model.contextWindow, isFiniteNumber) || !optional(model.maxTokens, isFiniteNumber)) return false;
  if (!optional(model.thinkingLevelMap, (map) => isPlainRecord(map)
    && Object.values(map).every((level) => level === null || typeof level === "string"))) return false;
  if (!Array.isArray(model.input) || !model.input.every(isText)) return false;
  const { cost } = model;
  if (!isPlainRecord(cost) || !["input", "output", "cacheRead", "cacheWrite"].every((key) => isFiniteNumber(cost[key]))) return false;
  for (const key of ["compat", "headers", "inputLimits", "promptCache", "samplingParams", "samplingParamsByThinkingLevel"]) {
    if (!optional(model[key], isPlainRecord)) return false;
  }
  return true;
}

/**
 * A saved entry in Pi's native `ModelsStoreEntry` shape, normalized the way
 * pi-ai normalizes it before restore (unknown model types dropped), or
 * undefined when it is not that shape or any remaining record is malformed
 * (the whole provider entry is then skipped, never partially published).
 */
function savedProviderEntry(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) return undefined;
  for (const key of ["lastModified", "checkedAt"] as const) {
    if (!optional(value[key], isFiniteNumber)) return undefined;
  }
  if (!optional(value.etag, isText)) return undefined;
  const models = value.models.filter((model) => !isPlainRecord(model)
    || model.type === undefined
    || (typeof model.type === "string" && KNOWN_SAVED_MODEL_TYPES.has(model.type)));
  if (!models.every(isWellFormedSavedModel)) return undefined;
  return deepFreeze(structuredClone({ ...value, models }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Restore Pi's saved provider catalogs into the runtime's registered
 * providers through their public offline `refreshModels` hook, the same
 * cache-only phase Pi itself runs before any credential or network step:
 * `allowNetwork: false`, no credential, the immutable stored entry, and a
 * publication port that applies only in-memory updates. A publication that
 * asks to persist (or delete) the saved catalog is refused and not applied,
 * per the hook's contract that an update runs only after its persistence.
 * Only providers the runtime already registered are touched; saved entries
 * for unknown providers are ignored, exactly as Pi ignores them. After a
 * restore, the provider's own public `getModels()` is called directly: Pi's
 * collection accessor would swallow a composition error (for example a
 * models.json entry composed over a restored model) and silently drop the
 * whole provider. On any restore or composition failure that provider's
 * pre-restore model list is recorded in `fallbackModels`, so its static and
 * models.json choices stay while other providers keep their restores.
 */
async function restoreSavedProviderCatalogs(
  runtime: Record<string, unknown>,
  agentDir: string,
  warnings: string[],
  fallbackModels: Map<string, unknown[]>,
): Promise<boolean> {
  const saved = readSavedProviderCatalog(agentDir, warnings);
  if (saved === undefined) return false;
  const getProviders = runtime.getProviders;
  if (typeof getProviders !== "function") {
    warnings.push("the installed Pi SDK model runtime does not list providers; Pi's saved provider catalog is not restored");
    return false;
  }
  let providers: unknown;
  try {
    providers = (getProviders as () => unknown).call(runtime);
  } catch {
    providers = undefined;
  }
  if (!Array.isArray(providers)) {
    warnings.push("the installed Pi SDK model runtime does not list providers; Pi's saved provider catalog is not restored");
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SAVED_PROVIDER_CATALOG_RESTORE_TIMEOUT_MS);
  const { signal } = controller;
  let malformed = 0;
  let failed = 0;
  let restored = false;
  try {
    const restores = providers.map(async (provider: unknown) => {
      if (!isRecord(provider) || typeof provider.id !== "string" || typeof provider.refreshModels !== "function") return;
      if (!Object.prototype.hasOwnProperty.call(saved, provider.id)) return;
      let stored: Record<string, unknown> | undefined;
      try {
        stored = savedProviderEntry(saved[provider.id]);
      } catch {
        stored = undefined;
      }
      if (stored === undefined) {
        malformed += 1;
        return;
      }
      const publish = async (publication: unknown): Promise<boolean> => {
        if (signal.aborted || !isRecord(publication)) return false;
        // Persistence stays Pi's: this catalog never writes or deletes it, so
        // the coupled update is not applied either.
        if (publication.persist !== undefined) return false;
        if (publication.update !== undefined) {
          if (typeof publication.update !== "function") return false;
          (publication.update as () => void)();
          restored = true;
        }
        return true;
      };
      let baseline: unknown;
      try {
        baseline = (runtime.getModels as (providerId: string) => unknown).call(runtime, provider.id);
      } catch {
        baseline = undefined;
      }
      try {
        await (provider.refreshModels as (context: unknown) => Promise<void>).call(provider, {
          credential: undefined,
          stored,
          publish,
          allowNetwork: false,
          signal,
          baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
        });
        // Surface a composition error the collection accessor would suppress.
        if (typeof provider.getModels === "function") (provider.getModels as () => unknown).call(provider);
      } catch {
        fallbackModels.set(provider.id, Array.isArray(baseline) ? [...baseline] : []);
        failed += 1;
      }
    });
    const timedOut = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([Promise.all(restores), timedOut]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (malformed > 0) {
    warnings.push("some entries in Pi's saved provider catalog are malformed; those providers offer only built-in and models.json models");
  }
  if (failed > 0) {
    warnings.push("Pi could not restore some saved provider catalogs; those providers offer only built-in and models.json models");
  }
  return restored;
}

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
  const createRuntime = async (): Promise<Record<string, unknown>> => {
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
    return runtime;
  };
  const runtime = await createRuntime();
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
  // Saved catalogs only matter for resolving a nonempty scope; an empty scope
  // never reads them (no irrelevant cache notice beside the guidance).
  const fallbackModels = new Map<string, unknown[]>();
  const restored = await restoreSavedProviderCatalogs(runtime, agentDir, warnings, fallbackModels);
  let result: unknown;
  try {
    result = await resolveWithCatalog(resolveScope, patterns, runtime, fallbackModels);
  } catch (error) {
    if (!restored) {
      throw new ReviewSettingsCatalogUnavailableError(`pi-review-gate: Pi could not resolve the model scope for the settings catalog: ${errorLine(error)}`);
    }
    // The restored saved catalogs made Pi's resolver fail: drop them all and
    // resolve again over a fresh built-in + models.json runtime, never
    // quoting the failure (it can echo saved catalog bytes).
    warnings.push(`Pi could not use its saved provider catalogs; ${SAVED_CATALOG_FALLBACK}`);
    try {
      result = await resolveWithCatalog(resolveScope, patterns, await createRuntime());
    } catch (retryError) {
      if (retryError instanceof ReviewSettingsCatalogUnavailableError) throw retryError;
      throw new ReviewSettingsCatalogUnavailableError(`pi-review-gate: Pi could not resolve the model scope for the settings catalog: ${errorLine(retryError)}`);
    }
  }
  if (!isRecord(result) || !Array.isArray(result.scopedModels)) {
    throw new ReviewSettingsCatalogUnavailableError("pi-review-gate: Pi returned a malformed model scope for the settings catalog");
  }
  if (Array.isArray(result.diagnostics)) {
    for (const diagnostic of result.diagnostics) {
      if (isRecord(diagnostic) && typeof diagnostic.message === "string" && diagnostic.message.length > 0) {
        warnings.push(singleLine(diagnostic.message));
      }
    }
  }
  return scopedModelChoices({ scopedModels: result.scopedModels }) ?? [];
}

/**
 * Run Pi's native scope resolver over a catalog-eligibility port. The native
 * grammar only calls `getAvailable`, answered here from the runtime's catalog
 * metadata (static, models.json, and restored saved provider catalogs),
 * restricted to chat models (an explicit `chat` type or a legacy record
 * without one): a restored provider list is not guaranteed chat-only by
 * every provider, and image or classifier models are never Pi model choices.
 * This is NOT authenticated availability; the runtime's real getAvailable is
 * never called.
 */
async function resolveWithCatalog(
  resolveScope: unknown,
  patterns: string[],
  runtime: Record<string, unknown>,
  fallbackModels?: ReadonlyMap<string, unknown[]>,
): Promise<unknown> {
  const getModels = runtime.getModels as (providerId?: string) => unknown;
  // Provider by provider in the runtime's own order when a restore failed, so
  // only the failed providers use their recorded pre-restore lists.
  const catalogModels = (): unknown => {
    if (!fallbackModels || fallbackModels.size === 0 || typeof runtime.getProviders !== "function") return getModels.call(runtime);
    const providers = (runtime.getProviders as () => unknown).call(runtime);
    if (!Array.isArray(providers)) return getModels.call(runtime);
    return providers.flatMap((provider: unknown) => {
      if (!isRecord(provider) || typeof provider.id !== "string") return [];
      const fallback = fallbackModels.get(provider.id);
      if (fallback) return fallback;
      const models = getModels.call(runtime, provider.id);
      return Array.isArray(models) ? models : [];
    });
  };
  const catalogEligibility = {
    getAvailable: async (): Promise<unknown> => {
      const models = catalogModels();
      if (!Array.isArray(models)) return models;
      return models.filter((model) => isRecord(model) && (model.type === undefined || model.type === "chat"));
    },
  };
  return (resolveScope as (patterns: string[], runtime: unknown) => Promise<unknown>)([...patterns], catalogEligibility);
}

/**
 * Where one offline tool candidate name comes from. Provenance only — never
 * runtime availability and never authority:
 *
 * - `native-builtin`: the SDK exports a public `create*ToolDefinition`
 *   factory whose metadata yielded this name (evidence the pinned Pi defines
 *   the builtin; whether a launched Pi offers it still depends on its flags).
 * - `native-codemode`: the canonical native Pi codemode name; Pi registers it
 *   itself and the SDK exposes no definition factory, so it is a canonical
 *   constant, not SDK evidence.
 * - `review-gate-registration`: a shipped review-gate registrar name whose
 *   actual registration is decided at runtime (role, mode, settings,
 *   capability).
 * - `reserved-discovery-loader`: the reserved `tool_search` loader; never a
 *   deny candidate, and never a durable worker capability or initial-active
 *   name (the Pi worker launch adds it to the CLI allowlist separately, and
 *   the child rejects a durable catalog that contains it).
 */
export type OfflineToolCandidateSource =
  | "native-builtin"
  | "native-codemode"
  | "review-gate-registration"
  | "reserved-discovery-loader";

/** One offline candidate name with every origin that contributed it. */
export interface OfflineToolCandidate {
  name: string;
  /** First native SDK definition description (else none); display metadata only. */
  description?: string;
  /** Every distinct origin of the name, in {@link OfflineToolCandidateSource} declaration order. */
  sources: readonly OfflineToolCandidateSource[];
}

/** The single offline enumeration shared by the sidebar catalog and worker admission. */
export interface OfflineToolCandidateEnumeration {
  /** Unique names, sorted by code unit; frozen. */
  candidates: readonly OfflineToolCandidate[];
  /** Whether the SDK yielded at least one usable native builtin definition. */
  nativeBuiltinsDiscovered: boolean;
}

const SOURCE_ORDER: readonly OfflineToolCandidateSource[] = [
  "native-builtin",
  "native-codemode",
  "review-gate-registration",
  "reserved-discovery-loader",
];

/**
 * Enumerate the offline tool candidate names from an already loaded public
 * SDK module: the SDK's native builtin definitions (metadata only, never
 * executed), the canonical codemode name, and every shipped review-gate
 * registration name including the reserved loader. Pure over its inputs: no
 * configuration, no saved or retained names, no session, no model catalog,
 * no settings, trust, auth, extension, or MCP access, and no network. This is
 * the ONE enumerator behind both the sidebar Review Settings tool choices and
 * {@link loadNativeWorkerToolCandidates}; neither consumer adds names.
 */
export function enumerateOfflineToolCandidates(sdk: Record<string, unknown>, cwd: string): OfflineToolCandidateEnumeration {
  const native = nativeBuiltinToolEntries(sdk, cwd);
  const byName = new Map<string, { description?: string; sources: Set<OfflineToolCandidateSource> }>();
  const add = (name: string, source: OfflineToolCandidateSource, description?: string): void => {
    const existing = byName.get(name);
    if (existing) {
      existing.sources.add(source);
      return;
    }
    byName.set(name, description === undefined ? { sources: new Set([source]) } : { description, sources: new Set([source]) });
  };
  for (const entry of native) add(entry.name, "native-builtin", entry.description);
  add(CODEMODE_TOOL_NAME, "native-codemode");
  for (const name of shippedReviewGateToolNames()) {
    add(name, name === DEFERRED_TOOL_SEARCH_NAME ? "reserved-discovery-loader" : "review-gate-registration");
  }
  const candidates = [...byName.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, { description, sources }]) => {
      const ordered = Object.freeze(SOURCE_ORDER.filter((source) => sources.has(source)));
      return Object.freeze(description === undefined ? { name, sources: ordered } : { name, description, sources: ordered });
    });
  return Object.freeze({ candidates: Object.freeze(candidates), nativeBuiltinsDiscovered: native.length > 0 });
}

function collectToolCandidates(sdk: Record<string, unknown>, cwd: string, warnings: string[]): ToolInventoryEntry[] {
  const { candidates, nativeBuiltinsDiscovered } = enumerateOfflineToolCandidates(sdk, cwd);
  if (!nativeBuiltinsDiscovered) {
    warnings.push("the installed Pi SDK exposes no native builtin tool definitions; native builtin tool names are not offered");
  }
  // The sidebar's public entries stay name/description only (no provenance).
  return candidates.map(({ name, description }) => (description === undefined ? { name } : { name, description }));
}

/** Inputs for the native-owned Pi worker admission source (issue #682). */
export interface NativeWorkerToolCandidateInput {
  /** Absolute path of the owner's already resolved native Pi CLI file. */
  piExecutable: string;
  /** Absolute workspace directory; only handed to definition factories for metadata. */
  cwd: string;
  /** The owner's admitted Pi version; when set, the SDK package version must match exactly. */
  expectedPiVersion?: string;
}

/** Test seams for {@link loadNativeWorkerToolCandidates}. */
export interface NativeWorkerToolCandidateDependencies {
  /** Loads the validated public SDK module; defaults to the sidebar's loader. */
  loadSdk?: (piExecutable: string, expectedPiVersion?: string) => Record<string, unknown>;
}

/** The admission source could not be resolved truthfully; launch must not proceed on it. */
export class NativeWorkerToolCandidatesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeWorkerToolCandidatesUnavailableError";
  }
}

/**
 * Tool-only admission source for native-owned Pi workers (issue #682): the
 * same offline coverage as the sidebar Review Settings tool choices, from the
 * same {@link enumerateOfflineToolCandidates}, with per-name provenance.
 * Synchronous and prelaunch: it loads only the validated public SDK module of
 * the owner's resolved Pi executable and builds native tool definitions for
 * their metadata. It never starts Pi, a session, an agent, or extension
 * activation, never builds the model catalog, and never reads settings,
 * project trust, auth, `models.json`, extensions, or MCP configuration.
 *
 * Fail-closed where the sidebar degrades: an unloadable SDK or one without
 * any usable native builtin definition throws
 * {@link NativeWorkerToolCandidatesUnavailableError} instead of returning
 * the shipped-only remainder.
 *
 * The result is enumeration, not authority, and it ignores every launch
 * input: a name listed here may still be withheld from the host Pi or from a
 * worker. Handoff for the later owner binding (none of it is done here):
 *
 * 1. Host launch restrictions. The host's own native Pi launch forwards
 *    caller `--tools`/`-t`, `--exclude-tools`/`-xt`, `--no-tools`/`-nt`, and
 *    `--no-builtin-tools`/`-nbt` to Pi untouched, and this enumerator does not
 *    read them: with a host launched under `--exclude-tools bash`, `bash` is
 *    still listed. Before freezing a worker ceiling the owner must account
 *    for the host's actual restrictions, aliases included, and must never let
 *    an omitted, unparsed, or rejected restriction silently widen the
 *    ceiling; if it cannot determine them, it must narrow or refuse, not
 *    guess. `assertNoPiToolPolicyArgs` is a different guard: it refuses
 *    tool-policy flags in EXECUTOR adapter arguments, so a worker's native
 *    `--tools` allowlist stays the only tool flag, and it says nothing about
 *    the host's launch inputs.
 * 2. Owner composition, prelaunch. The owner intersects these names with
 *    the host restrictions above and the existing role, deny, and platform
 *    filters, then freezes the durable worker capability catalog and its
 *    initial-active subset. `reserved-discovery-loader` (`tool_search`) is
 *    excluded from both: the existing Pi worker launch appends it to the
 *    native CLI allowlist outside the durable catalog, and the child refuses
 *    a durable catalog that contains it.
 * 3. Child enforcement, postlaunch. The native `--tools` allowlist is the
 *    hard launch boundary; the child then checks the frozen catalog against
 *    Pi's live registry and may only narrow it (absent or hidden names are
 *    withheld) or reject it (a missing promised initial tool fails closed).
 *    It never widens it.
 *
 * Dynamic MCP and extension tools and saved or retained deny-only names are
 * never included (follow-up #740 covers dynamic discovery).
 */
export function loadNativeWorkerToolCandidates(
  input: NativeWorkerToolCandidateInput,
  dependencies: NativeWorkerToolCandidateDependencies = {},
): readonly OfflineToolCandidate[] {
  const { piExecutable, cwd, expectedPiVersion } = input;
  if (typeof piExecutable !== "string" || !isAbsolute(piExecutable)) {
    throw new NativeWorkerToolCandidatesUnavailableError("pi-review-gate: the native pi executable must be an absolute path for worker tool admission");
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new NativeWorkerToolCandidatesUnavailableError("pi-review-gate: the worker workspace must be an absolute path for worker tool admission");
  }
  if (expectedPiVersion !== undefined && (typeof expectedPiVersion !== "string" || expectedPiVersion.length === 0)) {
    throw new NativeWorkerToolCandidatesUnavailableError("pi-review-gate: the admitted Pi version must be non-empty text for worker tool admission");
  }
  const loadSdk = dependencies.loadSdk ?? defaultLoadSdk;
  let sdk: unknown;
  try {
    sdk = loadSdk(piExecutable, expectedPiVersion);
  } catch (error) {
    throw new NativeWorkerToolCandidatesUnavailableError(
      `pi-review-gate: the installed Pi SDK is unavailable for worker tool admission: ${errorLine(error)}`,
    );
  }
  if (!isRecord(sdk)) {
    throw new NativeWorkerToolCandidatesUnavailableError("pi-review-gate: the installed Pi SDK did not load a module for worker tool admission");
  }
  const { candidates, nativeBuiltinsDiscovered } = enumerateOfflineToolCandidates(sdk, cwd);
  if (!nativeBuiltinsDiscovered) {
    throw new NativeWorkerToolCandidatesUnavailableError("pi-review-gate: the installed Pi SDK exposes no native builtin tool definitions for worker tool admission");
  }
  return candidates;
}

/**
 * One display line of a diagnostic, never shortened (#653): the sidebar wraps
 * a long notice and offers it whole in its read-only notice reader.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function errorLine(error: unknown): string {
  return singleLine(error instanceof Error ? error.message : String(error));
}
