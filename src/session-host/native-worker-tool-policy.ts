/**
 * Prelaunch parent tool ceiling for native-owned Pi workers (issue #682).
 *
 * A native-owned session delegates to Pi workers without a running Pi parent,
 * so there is no live Pi registry to ask what the parent may hand down. This
 * module composes, BEFORE any worker launch, the eligible parent ceiling that
 * the existing canonical admission seam consumes in place of a live registry
 * read (`ExecutionToolManager`'s `authorizedTools` input). It is pure
 * composition over owner-trusted facts:
 *
 * - **Candidates** come only from {@link loadNativeWorkerToolCandidates}: the
 *   same offline enumeration as the sidebar Review Settings tool choices (the
 *   installed public Pi SDK's native builtin definitions, the canonical
 *   codemode name, and the shipped review-gate registration names), with
 *   per-name provenance. Nothing else adds a name. Dynamic MCP and extension
 *   tools are absent (follow-up #740), as are saved or retained deny-only
 *   names.
 * - **Host launch restrictions** come from the host's ACTUAL forwarded Pi
 *   launch arguments, parsed by the installed SDK's own `parseArgs` (the
 *   same public parser the sidebar uses for `--models`). See
 *   {@link resolveNativeWorkerLaunchRestrictions} for the exact supported and
 *   refused semantics.
 * - **Availability policy** that is already stable product behavior and is
 *   determinable before launch from the shipped provenance, one request-time
 *   settings snapshot, and the host platform (see {@link composeNativeWorkerToolCeiling}).
 *
 * Inputs are the owner's trusted, host-resolved facts — the resolved Pi
 * executable, its admitted version, the workspace, and the exact arguments
 * the host forwards to Pi — never model or caller data.
 *
 * Nothing here starts Pi, a session, an agent, or extension activation; it
 * reads no MCP configuration, trust, auth, or model catalog; it caches
 * nothing (each call is one request-time snapshot, never a stored grant); it
 * adds no setting, per-tool UI, or native grant; and it enables nothing at
 * runtime. The returned ceiling is eligibility, not discovery and not
 * authority: it is an upper bound for the existing seams below, which may
 * only narrow it.
 *
 * What applies here versus in the remaining canonical owners:
 *
 * | Concern | Owner |
 * | --- | --- |
 * | Offline candidate names and provenance | `loadNativeWorkerToolCandidates` (reused) |
 * | Host `--tools`/`-t`, `--exclude-tools`/`-xt`, `--no-tools`/`-nt` restrictions | here (SDK-parsed; refused when unconfirmed) |
 * | Wildcard or `+`/`-` modifier entries in those lists | here: refused (no supported matcher is reused) |
 * | `--no-extensions`/`-ne` | here: native `codemode` withheld unless `builtin:codemode` is explicitly selected |
 * | Native `codemode` availability beyond host CLI restrictions (Pi `extensions` settings overrides such as `-builtin:codemode`; worker launches do not inherit a host `-e builtin:codemode`) | owner-confirmed for both host and worker (`nativeCodemodeAvailable`); otherwise withheld here |
 * | `--no-builtin-tools`/`-nbt` | here: acknowledged, no ceiling effect (documented initial-activity-only semantics) |
 * | Reserved `tool_search` loader | here: never in the ceiling; refused when the host withholds it |
 * | Host-only capabilities (`SessionSpawn`, `SessionHosts`, `Subtasks*`) | here: never in the ceiling |
 * | Shipped registrations the Pi executor role never registers (`AskUserQuestion`, `YouShouldKnow`) | here: never in the ceiling |
 * | `web.enabled` registration gate | here, from the request-time snapshot |
 * | Native `powershell` builtin host support | here, through the canonical probe |
 * | Kind policy (research intersection, `GitRead`, in-place `Subtasks*`), `SessionSpawn`/`SessionHosts` role filter, executor deny, initial-active subset | `ExecutionToolManager.withParentTools` (unchanged; consumes this ceiling) |
 * | Pi-worker `Subtasks*` strip, `tool_search` CLI append | `createPiWorkerToolCatalog` / Pi executor launch (unchanged) |
 * | Live registry narrowing (absent/hidden names), missing promised initial tool | Pi worker child (unchanged) |
 *
 * The primary role's own `tools.topLevelDeny` is deliberately not applied:
 * like the Pi parent's pre-role-deny authority (#434), the ceiling is the
 * genuine parent authority and executor denials apply once, at admission.
 */
import { DEFAULT_CONFIG, type ReviewGateConfig } from "../config";
import { EXECUTION_TOOL_ACTIONS, EXECUTION_TOOL_NAMES } from "../execution/tool-names";
import { NATIVE_POWERSHELL_TOOL_NAME, probeNativePowerShellHostSupport } from "../native-powershell-support";
import { piToolPolicyFlagKind, type PiToolPolicyFlagKind } from "../pi-tool-policy";
import { isRecord } from "../record-guard";
import { CODEMODE_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME } from "../tool-inventory";
import { WEB_TOOL_NAMES } from "../web/tool-names";
import { BACKGROUND_SHELL_TOOL_NAMES } from "../background-shell/tool-names";
import { APPLY_PATCH_TOOL_NAME } from "../apply-patch/tool";
import { GIT_READ_TOOL_NAME } from "../git-read/tool";
import {
  loadNativeWorkerToolCandidates,
  loadValidatedPiSdkModule,
  NativeWorkerToolCandidatesUnavailableError,
  type OfflineToolCandidate,
} from "./review-settings-catalog";
import { SESSION_HOSTS_TOOL_NAME } from "./hosts-tool";
import { SESSION_SPAWN_TOOL_NAME } from "./spawn-tool";

/** Owner-trusted, host-resolved facts for one prelaunch ceiling resolution. */
export interface NativeWorkerToolPolicyInput {
  /** Absolute path of the owner's resolved native Pi CLI file. */
  piExecutable: string;
  /** The owner's admitted Pi version; the installed SDK package version must match exactly. */
  piVersion: string;
  /** Absolute workspace directory (handed to SDK definition factories for metadata only). */
  cwd: string;
  /**
   * The exact arguments the host forwards to Pi (without the executable),
   * after any wrapper-owned token removal — what Pi itself receives.
   */
  launchArgs: readonly string[];
  /**
   * One request-time snapshot of persisted settings. Only the `web.enabled`
   * registration gate is read; nothing is kept.
   */
  settings: Pick<ReviewGateConfig, "web">;
  /**
   * Request-time owner fact: Pi's builtin codemode extension is enabled in
   * BOTH the host and the intended worker. Pi settings can disable it
   * (`extensions: ["-builtin:codemode"]` in global or trusted-project
   * settings, which this offline adapter does not read), and an explicit
   * host extension selection is not forwarded to the worker launch. Unset or
   * anything but `true` withholds codemode; the offline candidate alone never
   * establishes it. Host CLI restrictions still take precedence.
   */
  nativeCodemodeAvailable?: boolean;
}

/** Test seams. */
export interface NativeWorkerToolPolicyDependencies {
  /** Loads the validated public SDK module; defaults to the sidebar/admission loader. */
  loadSdk?: (piExecutable: string, expectedPiVersion?: string) => Record<string, unknown>;
  /** Native `powershell` host support; defaults to the canonical probe. Consulted only when needed. */
  nativePowerShellSupported?: () => boolean;
}

/** Why one offline candidate is not in the eligible parent ceiling. */
export type NativeWorkerToolWithheldReason =
  /** The reserved `tool_search` loader: the Pi worker launch appends it outside any catalog. */
  | "reserved-discovery-loader"
  /** Removed by the host's own `--tools`/`--exclude-tools`/`--no-extensions` restriction. */
  | "launch-restriction"
  /** Depends on the parent's own host capability; never part of a delegated ceiling. */
  | "host-only"
  /** A shipped registration the Pi executor role never registers; not transferable. */
  | "worker-unregistered"
  /** Not registered or not permitted under the request-time settings snapshot. */
  | "feature-disabled"
  /** Native codemode without an owner fact confirming it in both host and worker. */
  | "native-codemode-unavailable"
  /** Pi's native `powershell` builtin on a host that cannot run it. */
  | "platform-unsupported";

/** The host restrictions the SDK confirmed, as applied. */
export interface NativeWorkerLaunchRestrictions {
  /** The host `--tools` allowlist (trimmed, deduplicated, sorted), or undefined when none. */
  allowlist?: readonly string[];
  /** The host `--exclude-tools` names (trimmed, deduplicated, sorted); matched case-insensitively. */
  excluded: readonly string[];
  /** Whether the host withholds every tool (`--no-tools`). */
  noTools: boolean;
  /**
   * Whether the host disables Pi's builtin extensions (`--no-extensions`)
   * without explicitly selecting `builtin:codemode`, so native codemode is
   * withheld. Review-gate's own registrations stay: the host always loads the
   * review-gate extension through an explicit `--extension`.
   */
  codemodeWithheld: boolean;
  /** Whether `--no-builtin-tools` was given; acknowledged with no ceiling effect. */
  noBuiltinToolsIgnored: boolean;
}

/** The eligible parent ceiling for one prelaunch admission. */
export interface NativeWorkerToolCeiling {
  /**
   * Eligible parent ceiling (sorted, frozen): the value an owner hands to the
   * existing canonical admission seam in place of a live registry read.
   * Eligibility only — never discovery, activation, or a stored grant.
   */
  parentCeiling: readonly string[];
  /** Every other offline candidate with the first reason it was withheld. */
  withheld: readonly { name: string; reason: NativeWorkerToolWithheldReason }[];
  /** The confirmed host restrictions this ceiling applied. */
  launchRestrictions: NativeWorkerLaunchRestrictions;
}

/** Stable refusal codes; a refusal yields no ceiling and launch must not proceed on it. */
export type NativeWorkerToolCeilingRefusalCode =
  /** Missing or malformed trusted input (paths, version, argument array). */
  | "invalid-input"
  /** The offline candidate source could not be resolved truthfully. */
  | "candidates-unavailable"
  /** The installed SDK could not parse the forwarded arguments (absent parser, throw, error diagnostic, bad shape). */
  | "launch-args-unparsable"
  /** A tool-policy token or field whose meaning the SDK did not confirm in a supported shape. */
  | "launch-restriction-unconfirmed"
  /** The host withholds `tool_search`, which the Pi worker launch would append anyway. */
  | "discovery-loader-withheld";

export class NativeWorkerToolCeilingRefusedError extends Error {
  constructor(readonly code: NativeWorkerToolCeilingRefusalCode, message: string) {
    super(message);
    this.name = "NativeWorkerToolCeilingRefusedError";
  }
}

function refuse(code: NativeWorkerToolCeilingRefusalCode, detail: string): never {
  throw new NativeWorkerToolCeilingRefusedError(code, `pi-review-gate: native worker tool ceiling refused (${code}): ${detail}`);
}

/**
 * Capabilities that depend on the parent's own host authority and are never
 * part of a delegated Pi worker ceiling, whatever the restrictions say:
 * `SessionSpawn`/`SessionHosts` need the parent's authenticated session-host
 * capability, and the `Subtasks*` controls are the delegating owner's own
 * control plane (Pi executor roles never register recursive delegation).
 * Built from the canonical registrar constants; no second copy of a name.
 */
const HOST_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  SESSION_SPAWN_TOOL_NAME,
  SESSION_HOSTS_TOOL_NAME,
  ...EXECUTION_TOOL_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]),
]);

/** Names `WebToolManager.register()` registers only while `web.enabled` is on. */
const WEB_REGISTRATION_NAMES: ReadonlySet<string> = new Set(Object.values(WEB_TOOL_NAMES));

/**
 * The shipped review-gate registrations the Pi executor role actually
 * registers (`src/index.ts` executor branch: web tools while `web.enabled`,
 * ApplyPatch, GitRead, the background shell; the loader is handled
 * separately). A positive list: any other shipped registration — today
 * `AskUserQuestion` and `YouShouldKnow`, whose only registrar runs after the
 * executor branch returns — is never transferable to a Pi worker, so it is
 * never promised in the ceiling (a full-active catalog promising it would
 * fail the child's bootstrap).
 */
const PI_WORKER_REVIEW_GATE_REGISTRATIONS: ReadonlySet<string> = new Set([
  ...WEB_REGISTRATION_NAMES,
  ...Object.values(BACKGROUND_SHELL_TOOL_NAMES),
  APPLY_PATCH_TOOL_NAME,
  GIT_READ_TOOL_NAME,
]);

/** Pi's flags that disable its builtin extension set (where native codemode comes from). */
const NO_EXTENSIONS_FLAGS: ReadonlySet<string> = new Set(["--no-extensions", "-ne"]);

/** The explicit Pi extension selection that keeps native codemode under `--no-extensions`. */
const CODEMODE_BUILTIN_EXTENSION = `builtin:${CODEMODE_TOOL_NAME}`;

/**
 * A restriction entry this adapter can compare exactly: a plain tool name.
 * Pi matches policy lists with wildcards and accepts `+name`/`-name`
 * modifiers; with no supported public matcher reused here, any entry outside
 * this plain form refuses rather than being compared as a literal.
 */
const PLAIN_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/**
 * Host launch restrictions from the forwarded arguments, parsed by the
 * installed SDK's own public `parseArgs` (operand boundaries, short aliases,
 * value-looking operands, and Pi's literal `--` are Pi's, not ours).
 *
 * Supported (repository-documented native semantics, docs/security-model.md
 * and docs/native-pi-tools.md):
 * - `--tools`/`-t` (`parsed.tools`, string array): Pi keeps only the named
 *   tools registered; the ceiling is intersected with it. Unknown names grant
 *   nothing.
 * - `--exclude-tools`/`-xt` (`parsed.excludeTools`, string array): removed,
 *   compared case-insensitively (only ever narrower than an exact match).
 * - Entries of either list must be plain tool names: a wildcard, a `+`/`-`
 *   modifier, or any other non-plain entry refuses
 *   (`launch-restriction-unconfirmed`), because Pi matches these lists with
 *   its own wildcard and modifier semantics that this adapter does not
 *   reproduce. Allowlist membership stays an exact comparison (narrower than
 *   any case-folding or pattern match Pi may apply).
 * - `--no-extensions`/`-ne` (`parsed.noExtensions` `true`): Pi loads only
 *   explicitly selected extensions, and native codemode comes from its
 *   builtin extension set, so codemode is withheld unless `parsed.extensions`
 *   lists exactly `builtin:codemode`. Review-gate's own registrations are
 *   unaffected (the host always passes its extension explicitly). Nothing is
 *   loaded or activated to decide this.
 * - `--no-tools`/`-nt` (`parsed.noTools` `true` or `"all"`): Pi's registry
 *   keeps no tool at all, so nothing is eligible — and the discovery loader
 *   is withheld, which the caller refuses. Combined with `--tools`, the
 *   narrower empty result is used.
 * - `--no-builtin-tools`/`-nbt` (`parsed.noBuiltinTools` `true`, or
 *   `parsed.noTools` `"builtin"`): only Pi's initial activity; it withholds
 *   no registered name, so it has no ceiling effect.
 *
 * Refused instead of guessed:
 * - no `parseArgs` export while arguments are present, a throw, a non-record
 *   result, or an `error`-typed parse diagnostic (`launch-args-unparsable`);
 * - a restriction field in an unsupported shape (`launch-restriction-unconfirmed`);
 * - an `=`-attached or repeated policy flag spelling (`--tools`, `-t`,
 *   `--exclude-tools`, `-xt`, `--no-tools`, `-nt`, `--no-builtin-tools`,
 *   `-nbt`, `--no-extensions`, `-ne`; a long spelling and its alias count
 *   together), because one SDK field cannot confirm which occurrences were
 *   parsed — Pi records `--exclude-tools=bash` as an unknown extension flag,
 *   and a second occurrence may be consumed as another option's operand
 *   (`launch-restriction-unconfirmed`);
 * - any single policy flag spelling whose corresponding parsed field the SDK
 *   did not confirm, including `--no-builtin-tools`/`-nbt`
 *   (`launch-restriction-unconfirmed`). The token check never derives a
 *   value; a flag word consumed as an operand or appearing after Pi's `--`
 *   therefore refuses rather than silently dropping a restriction.
 */
export function resolveNativeWorkerLaunchRestrictions(
  sdk: Record<string, unknown>,
  launchArgs: readonly string[],
): NativeWorkerLaunchRestrictions {
  if (!Array.isArray(launchArgs) || launchArgs.some((arg) => typeof arg !== "string")) {
    refuse("invalid-input", "the forwarded Pi launch arguments must be an array of strings");
  }
  if (launchArgs.length === 0) {
    return Object.freeze({ excluded: Object.freeze([]), noTools: false, codemodeWithheld: false, noBuiltinToolsIgnored: false });
  }
  const spelled = new Set<PiToolPolicyFlagKind | "noExtensions">();
  for (const arg of launchArgs) {
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const kind = piToolPolicyFlagKind(arg) ?? (NO_EXTENSIONS_FLAGS.has(flag) ? "noExtensions" : undefined);
    if (kind === undefined) continue;
    if (eq !== -1 || spelled.has(kind)) {
      // Name only the fixed flag, never an attached value.
      refuse("launch-restriction-unconfirmed", `attached or repeated ${flag} policy flags are unsupported`);
    }
    spelled.add(kind);
  }
  const parseArgs = sdk.parseArgs;
  if (typeof parseArgs !== "function") {
    refuse("launch-args-unparsable", "the installed Pi SDK does not export parseArgs; the host launch restrictions cannot be resolved");
  }
  let parsed: unknown;
  try {
    parsed = (parseArgs as (args: string[]) => unknown)([...launchArgs]);
  } catch {
    // The parser's message may quote argument contents; keep it out.
    refuse("launch-args-unparsable", "Pi could not parse the forwarded host arguments");
  }
  if (!isRecord(parsed)) refuse("launch-args-unparsable", "Pi's parseArgs did not return a record");
  const diagnostics = parsed.diagnostics;
  if (diagnostics !== undefined) {
    if (!Array.isArray(diagnostics)) refuse("launch-args-unparsable", "Pi's parse diagnostics are not a list");
    if (diagnostics.some((entry) => !isRecord(entry) || entry.type === "error")) {
      refuse("launch-args-unparsable", "Pi reported an error parsing the forwarded host arguments");
    }
  }

  const allowlist = parsedNameList(parsed.tools, "--tools");
  const excluded = parsedNameList(parsed.excludeTools, "--exclude-tools") ?? [];
  const noToolsField = parsed.noTools;
  if (noToolsField !== undefined && noToolsField !== true && noToolsField !== false && noToolsField !== "all" && noToolsField !== "builtin") {
    refuse("launch-restriction-unconfirmed", "Pi reported --no-tools in an unsupported shape");
  }
  const noBuiltinField = parsed.noBuiltinTools;
  if (noBuiltinField !== undefined && typeof noBuiltinField !== "boolean") {
    refuse("launch-restriction-unconfirmed", "Pi reported --no-builtin-tools in an unsupported shape");
  }
  const noTools = noToolsField === true || noToolsField === "all";
  const noExtensionsField = parsed.noExtensions;
  if (noExtensionsField !== undefined && typeof noExtensionsField !== "boolean") {
    refuse("launch-restriction-unconfirmed", "Pi reported --no-extensions in an unsupported shape");
  }
  const extensionsField = parsed.extensions;
  if (extensionsField !== undefined && (!Array.isArray(extensionsField) || extensionsField.some((entry) => typeof entry !== "string"))) {
    refuse("launch-restriction-unconfirmed", "Pi reported --extension selections in an unsupported shape");
  }
  const codemodeWithheld = noExtensionsField === true
    && !(extensionsField as string[] | undefined ?? []).includes(CODEMODE_BUILTIN_EXTENSION);

  if (spelled.has("allowlist") && allowlist === undefined) {
    refuse("launch-restriction-unconfirmed", "a --tools/-t token was not confirmed as an allowlist by Pi's parser");
  }
  if (spelled.has("exclude") && parsed.excludeTools === undefined) {
    refuse("launch-restriction-unconfirmed", "a --exclude-tools/-xt token was not confirmed as an exclusion by Pi's parser");
  }
  if (spelled.has("noTools") && !noTools) {
    refuse("launch-restriction-unconfirmed", "a --no-tools/-nt token was not confirmed as withholding every tool by Pi's parser");
  }
  if (spelled.has("noExtensions") && noExtensionsField !== true) {
    refuse("launch-restriction-unconfirmed", "a --no-extensions/-ne token was not confirmed as disabling extensions by Pi's parser");
  }
  const noBuiltinToolsIgnored = noBuiltinField === true || noToolsField === "builtin";
  if (spelled.has("noBuiltinTools") && !noBuiltinToolsIgnored) {
    refuse("launch-restriction-unconfirmed", "a --no-builtin-tools/-nbt token was not confirmed by Pi's parser");
  }

  return Object.freeze({
    ...(allowlist === undefined ? {} : { allowlist: Object.freeze(allowlist) }),
    excluded: Object.freeze(excluded),
    noTools,
    codemodeWithheld,
    noBuiltinToolsIgnored,
  });
}

function parsedNameList(value: unknown, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    refuse("launch-restriction-unconfirmed", `Pi reported ${flag} in an unsupported shape`);
  }
  const names = new Set<string>();
  for (const name of value as string[]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (!PLAIN_TOOL_NAME.test(trimmed)) {
      // Never echo the entry: launch arguments are caller-controlled bytes.
      refuse("launch-restriction-unconfirmed", `Pi reported a ${flag} entry that is not a plain tool name (wildcard, +/- modifier, or other pattern); its matching semantics are not reproduced`);
    }
    names.add(trimmed);
  }
  return [...names].sort(compareNames);
}

/**
 * Compose the eligible parent ceiling from already enumerated candidates and
 * confirmed restrictions (pure; exported for the owner binding and tests).
 *
 * Refuses (`discovery-loader-withheld`) when the host's restrictions withhold
 * `tool_search` — `--no-tools`, a `--tools` allowlist without it, or
 * `--exclude-tools tool_search` (any case): the existing Pi worker launch appends the
 * loader to the worker's native allowlist outside the durable catalog, so a
 * worker would gain a loader its host lacked. That restrictive launch mode is
 * unsupported for native-owned Pi workers rather than silently widened.
 *
 * Every other candidate is admitted unless, in this order, it is the reserved
 * loader, removed by a host restriction (including native codemode under
 * `--no-extensions`), native codemode without the owner's confirmed host and
 * worker availability (`nativeCodemodeAvailable !== true`), host-only, a
 * shipped registration the Pi executor role never registers, gated off by the
 * settings snapshot (`web.enabled` off for the Web/browser registrations,
 * mirroring `WebToolManager.register()` with the same default), or Pi's native
 * `powershell` builtin (`native-builtin` provenance only) on a
 * host the canonical probe reports unsupported. Names never come from the
 * restrictions or settings: a restriction or deny entry naming a non-candidate
 * adds nothing.
 */
export function composeNativeWorkerToolCeiling(
  candidates: readonly OfflineToolCandidate[],
  restrictions: NativeWorkerLaunchRestrictions,
  settings: NativeWorkerToolPolicyInput["settings"],
  nativePowerShellSupported: () => boolean = probeNativePowerShellHostSupport,
  nativeCodemodeAvailable = false,
): NativeWorkerToolCeiling {
  const allow = restrictions.allowlist === undefined ? undefined : new Set(restrictions.allowlist);
  const exclude = new Set(restrictions.excluded.map((name) => name.toLowerCase()));
  const hostRemoves = (name: string): boolean => restrictions.noTools
    || (allow !== undefined && !allow.has(name))
    || exclude.has(name.toLowerCase());
  if (hostRemoves(DEFERRED_TOOL_SEARCH_NAME)) {
    refuse(
      "discovery-loader-withheld",
      "the host launch restrictions withhold tool_search, which the Pi worker launch appends outside the catalog; this restrictive launch mode is unsupported for native-owned Pi workers",
    );
  }
  const webEnabled = (settings?.web ?? DEFAULT_CONFIG.web!).enabled !== false;
  let powerShellSupported: boolean | undefined;
  const powerShellHostSupported = (): boolean => {
    if (powerShellSupported === undefined) {
      try {
        powerShellSupported = nativePowerShellSupported() === true;
      } catch {
        powerShellSupported = false;
      }
    }
    return powerShellSupported;
  };

  const parentCeiling: string[] = [];
  const withheld: { name: string; reason: NativeWorkerToolWithheldReason }[] = [];
  for (const candidate of candidates) {
    const { name, sources } = candidate;
    let reason: NativeWorkerToolWithheldReason | undefined;
    if (name === DEFERRED_TOOL_SEARCH_NAME || sources.includes("reserved-discovery-loader")) reason = "reserved-discovery-loader";
    else if (hostRemoves(name)) reason = "launch-restriction";
    else if (restrictions.codemodeWithheld && name === CODEMODE_TOOL_NAME) reason = "launch-restriction";
    else if (name === CODEMODE_TOOL_NAME && nativeCodemodeAvailable !== true) reason = "native-codemode-unavailable";
    else if (HOST_ONLY_TOOL_NAMES.has(name)) reason = "host-only";
    else if (isShippedOnly(sources) && !PI_WORKER_REVIEW_GATE_REGISTRATIONS.has(name)) reason = "worker-unregistered";
    else if (!webEnabled && WEB_REGISTRATION_NAMES.has(name)) reason = "feature-disabled";
    else if (name === NATIVE_POWERSHELL_TOOL_NAME && sources.includes("native-builtin") && !powerShellHostSupported()) {
      reason = "platform-unsupported";
    }
    if (reason === undefined) parentCeiling.push(name);
    else withheld.push(Object.freeze({ name, reason }));
  }
  return Object.freeze({
    parentCeiling: Object.freeze([...new Set(parentCeiling)].sort(compareNames)),
    withheld: Object.freeze(withheld),
    launchRestrictions: restrictions,
  });
}

/**
 * Resolve the eligible parent ceiling for one native-owned Pi worker
 * admission, before launch. Loads the validated installed SDK once (exact
 * admitted version required), enumerates the shared offline candidates, parses
 * the host's actual launch restrictions with that same SDK module, and
 * composes the ceiling. Throws {@link NativeWorkerToolCeilingRefusedError}
 * instead of returning a partial or widened ceiling.
 */
export function resolveNativeWorkerToolCeiling(
  input: NativeWorkerToolPolicyInput,
  dependencies: NativeWorkerToolPolicyDependencies = {},
): NativeWorkerToolCeiling {
  if (!isRecord(input)) refuse("invalid-input", "the ceiling input must be a record");
  const { piExecutable, piVersion, cwd, launchArgs, settings, nativeCodemodeAvailable } = input;
  if (typeof piVersion !== "string" || piVersion.trim().length === 0 || piVersion.trim() !== piVersion) {
    refuse("invalid-input", "the admitted Pi version is required");
  }
  if (!Array.isArray(launchArgs) || launchArgs.some((arg) => typeof arg !== "string")) {
    refuse("invalid-input", "the forwarded Pi launch arguments must be an array of strings");
  }
  if (!isRecord(settings)) refuse("invalid-input", "a request-time settings snapshot is required");
  const loadSdk = dependencies.loadSdk ?? loadValidatedPiSdkModule;
  let sdk: Record<string, unknown> | undefined;
  let candidates: readonly OfflineToolCandidate[];
  try {
    candidates = loadNativeWorkerToolCandidates(
      { piExecutable, cwd, expectedPiVersion: piVersion },
      {
        loadSdk: (executable, expectedPiVersion) => {
          const loaded = loadSdk(executable, expectedPiVersion);
          sdk = loaded;
          return loaded;
        },
      },
    );
  } catch (error) {
    if (error instanceof NativeWorkerToolCandidatesUnavailableError) refuse("candidates-unavailable", error.message);
    throw error;
  }
  if (!isRecord(sdk)) refuse("candidates-unavailable", "the installed Pi SDK module was not retained for argument parsing");
  const restrictions = resolveNativeWorkerLaunchRestrictions(sdk, launchArgs);
  return composeNativeWorkerToolCeiling(
    candidates,
    restrictions,
    settings,
    dependencies.nativePowerShellSupported,
    nativeCodemodeAvailable === true,
  );
}

/** A name only the shipped review-gate registrars contribute (no native provenance). */
function isShippedOnly(sources: OfflineToolCandidate["sources"]): boolean {
  return sources.length > 0 && sources.every((source) => source === "review-gate-registration");
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
