/**
 * Canonical `toolProtection` configuration for the pre-execution tool-protection
 * gate (issue #536).
 *
 * One optional top-level block on `ReviewGateConfig` is the only durable copy of
 * these settings: no second store, no separate enable flag, and no per-scope or
 * per-task level override. `Off` is one of the selectable levels rather than a
 * distinct toggle, so an absent block and an explicit `{"level":"off"}` both mean
 * "this added gate does not apply" — and nothing else. Existing permissions,
 * roles, tool ceilings, trust, ownership, duplicate/liveness preflight, review,
 * landing, and cancellation safeguards stay independent.
 *
 * This module is a leaf: it imports root configuration types type-only so the
 * root `src/config.ts` can own the runtime integration without a module cycle.
 *
 * The defaults and level names below are product defaults for an opt-in block:
 * nothing here activates the gate for an existing configuration (a config that
 * predates this block stays `off`), and every non-Off level still requires an
 * explicit auditor choice by a human.
 */

import { isRecord } from "../record-guard";
import { DEFERRED_TOOL_SEARCH_NAME } from "../tool-inventory";
import type { ActiveReviewerSelection, ReviewGateConfig, ThinkingLevel } from "../config";

/** Ordered level list; `off` disables only this added gate. */
export const PROTECTION_LEVELS = ["off", "dangerous", "aligned", "workspace"] as const;
export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number];

/**
 * Which proposed calls this gate evaluates.
 *
 * `all` audits every tool proposal. `selected` is a deliberate reduced-coverage
 * audit subset: it audits exactly the listed tool names and nothing else. It is
 * not a classifier and it never implies that a skipped call was checked and
 * found safe — a skipped call is NOT AUDITED, and presentation must say so.
 * Exact-name matching only: never a pattern, prefix, glob, or automatic
 * safe/read-only exemption, and no tool class is exempt for speed. The single
 * exception is the canonical discovery loader, which is infrastructure rather than
 * audited work; that exception is granted by the admission coordinator only after it
 * proves the live loader is the one this extension registered, never by this scope
 * helper, and it is presented as NOT AUDITED, never as a pass.
 */
export const TOOL_PROTECTION_SCOPES = ["all", "selected"] as const;
export type ToolProtectionScope = (typeof TOOL_PROTECTION_SCOPES)[number];

/**
 * The canonical native discovery loader (`tool_search`) is the one proposal this
 * added gate never audits, at any scope and any enabled level.
 *
 * Why this is an infrastructure exemption rather than a PASS: the loader is how
 * an acting model reaches an authorized-but-inactive tool, and its own activation
 * is a prerequisite for the very tool-selection the auditor would otherwise
 * judge. Holding it behind an auditor decision, an auditor's availability, a
 * context budget, or a load error would make discovery depend on the gate that
 * discovery cannot precede. The exemption is limited to that exact canonical
 * name (the same constant the deferred-tool loader registers under and the
 * config validation reserves in both deny lists):
 *
 * - it grants nothing. Every pre-existing native guard still runs before this
 *   gate is reached and stays authoritative — live authorization and mode/role
 *   ceilings, the registry/ownership check that confirms each activation from
 *   Pi's actual tool set, the reserved-name rejection in the deny lists, the
 *   duplicate/liveness preflight, and cancellation. A removed, replaced, or
 *   otherwise unauthorized loader call is still blocked by those guards;
 * - it is never presented as audited, safe, or passed. Presentation says NOT
 *   AUDITED and names discovery infrastructure as the reason;
 * - it is not a template. There is no read-only, network, public-URL,
 *   name-prefix, or glob exemption, and no other tool class is exempt.
 *
 * This is the NAME test only. The runtime grants the treatment solely to the loader
 * this extension actually registered: `ToolProtectionCoordinator` additionally asks
 * the host's deferred-tool manager whether it owns the live entry under this name
 * (`DeferredToolManager.ownsDiscoveryLoader`), which requires both the registration
 * references this extension supplied and the provenance the host assigned to this
 * extension's registration, so a definition that took over the reserved name is audited
 * like any other tool proposal. This predicate is a NAME test
 * used by that coordinator branch and by the settings presentation (the loader row, the
 * seeded audited names, and the validation warnings). It is deliberately NOT consulted
 * by {@link toolProtectionAppliesTo}: configured scope membership stays a pure name
 * lookup, so nothing outside the ownership-verified branch can skip an audit.
 */
export function isToolProtectionDiscoveryLoaderExempt(toolName: string): boolean {
  return toolName === DEFERRED_TOOL_SEARCH_NAME;
}

/** Adjustable decision deadline bounds. */
export const TOOL_PROTECTION_TIMEOUT_MIN_MS = 1_000;
export const TOOL_PROTECTION_TIMEOUT_MAX_MS = 120_000;

/** Adjustable assembled-context bounds. */
export const TOOL_PROTECTION_CONTEXT_MIN_CHARS = 1_000;
export const TOOL_PROTECTION_CONTEXT_MAX_CHARS = 2_000_000;

/**
 * Defaults for a present block whose optional fields are omitted, and the
 * effective values when no block is stored at all. The timeout and context
 * defaults are starting points, not measured or guaranteed targets, and no
 * context default is a promise that a fair decision fits in it.
 */
export const DEFAULT_TOOL_PROTECTION_CONFIG: ToolProtectionConfig = {
  level: "off",
  auditor: null,
  scope: "all",
  toolNames: [],
  timeoutMs: 10_000,
  maxContextChars: 128_000,
  retainAuditorSessions: false,
  debug: false,
};

export interface ToolProtectionConfig {
  /** Shared Protection level for top-level and delegated calls. */
  level: ProtectionLevel;
  /**
   * The auditing worker, reusing the existing reviewer selection union so any
   * configured Pi or external agent can be selected without a second catalog.
   * A selection is stored as chosen: an external id is not resolved or dropped
   * at load time, so the runtime can explain that the auditor is unavailable
   * instead of silently switching the gate Off.
   */
  auditor: ActiveReviewerSelection | null;
  /** Audit subset selector; `all` is the default and the widest coverage. */
  scope: ToolProtectionScope;
  /** Exact tool names audited when `scope` is `selected`; empty when `all`. */
  toolNames: string[];
  /** Decision deadline in milliseconds. */
  timeoutMs: number;
  /** Variable auditor context budget in UTF-16 code units; fixed instructions are additional. */
  maxContextChars: number;
  /**
   * Optional, default-off retention of each auditor invocation as an ordinary
   * saved Pi session the user can inspect later. It is an explicit opt-in:
   * a missing field — including a configuration or a parent launch pin that
   * predates it — is `false`, and the only accepted values are the JSON
   * booleans, never a truthy coercion.
   *
   * This field changes no decision input, no permission, and no verdict: with
   * `false` nothing is recorded and no session SDK, directory, or file is
   * touched at all. With `true` one fresh record is written per actual auditor
   * invocation (including a timeout, abort, transport error, malformed reply,
   * or an invalidated decision) and a record-write failure keeps the auditor's
   * verdict while disclosing that the session was not fully saved. Recorded
   * histories are never read back as context for a later decision.
   */
  retainAuditorSessions: boolean;
  /**
   * Optional, default-off switch for the additional audit diagnostics this gate
   * can surface (issue #549). It is a presentation switch on information this
   * gate already has: a missing field — including a configuration or a parent
   * launch pin that predates it — is `false`, and the only accepted values are
   * the JSON booleans, never a truthy coercion.
   *
   * This field changes no decision, no coverage, no permission, and no
   * transport. It never enables or disables the gate (`level` alone does that),
   * never records anything (that is `retainAuditorSessions`), never starts a
   * model or provider call, and never widens what the acting model is told: an
   * audited call that was skipped is still NOT AUDITED rather than passed, and a
   * pass never gains an auditor explanation it does not have. With `false` the
   * routine positive and infrastructure-exempt diagnostics stay hidden; the
   * failures and audit errors a call already reports are unaffected by either
   * value.
   *
   * The default is the quieter presentation, not the older one: before this
   * switch existed, every audited call carried its PASS or NOT AUDITED status
   * into the acting model's tool result, and that text is now user-only
   * presentation regardless of this value. A stored block or a parent launch pin
   * that predates the field therefore keeps the same decisions but gets the
   * quiet presentation, which is the point of the change rather than a
   * regression in it.
   */
  debug: boolean;
}

/**
 * Pi thinking levels accepted on a Pi auditor selection. It mirrors
 * `THINKING_LEVELS` in the root configuration; `tests/tool-protection-config.test.ts`
 * fails if the two lists ever diverge, which keeps this module a runtime leaf.
 */
export const TOOL_PROTECTION_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** External-agent id grammar; mirrors the root configuration's configured-id rule. */
const PROTECTION_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Fully specified, always-populated view of the gate settings. Derived in memory
 * on every read; never stored, so there is exactly one durable copy of each
 * field. Returned arrays and selections are fresh copies that callers may mutate.
 */
export interface EffectiveToolProtectionSettings {
  level: ProtectionLevel;
  /** Derived from `level`; there is no separate enable state anywhere. */
  enabled: boolean;
  auditor: ActiveReviewerSelection | null;
  scope: ToolProtectionScope;
  toolNames: string[];
  timeoutMs: number;
  maxContextChars: number;
  /** See {@link ToolProtectionConfig.retainAuditorSessions}. */
  retainAuditorSessions: boolean;
  /** See {@link ToolProtectionConfig.debug}. */
  debug: boolean;
}

/**
 * Strict validation of one `toolProtection` block. Explicit writes fail loudly;
 * startup recovery turns a failure here into a derived load error rather than an
 * implicit `off` (see `recoverConfig` in the root configuration).
 *
 * Rules worth stating plainly:
 * - A present block must state its `level`. Absence of the whole block is the
 *   only thing that defaults to `off`, so a half-written safety block can never
 *   be read as "protection disabled".
 * - An enabled level must carry an auditor. `null` is valid only with `off`;
 *   an enabled level with no auditor would fail closed on every call without
 *   saying why, so it is rejected where the user can see and fix it.
 * - `scope: "selected"` must name at least one tool, so a typo'd or emptied
 *   list cannot quietly turn the gate into an audit of nothing.
 * - Unknown keys inside the block are ignored (the established convention for
 *   forward-compatible blocks); every known field is validated strictly, with
 *   no coercion of strings to numbers or of truthy values to enums.
 */
export function normalizeToolProtectionConfig(value: unknown): ToolProtectionConfig {
  if (!isRecord(value)) {
    throw new Error("toolProtection must be an object");
  }
  const level = normalizeProtectionLevel(value.level);
  const auditor = normalizeProtectionAuditor(value.auditor);
  if (level !== "off" && auditor === null) {
    throw new Error("toolProtection.auditor is required when level is not \"off\"");
  }
  const scope = normalizeProtectionScope(value.scope);
  const toolNames = normalizeProtectionToolNames(value.toolNames);
  if (scope === "selected" && toolNames.length === 0) {
    throw new Error("toolProtection.toolNames must name at least one exact tool name when scope is \"selected\"");
  }
  return {
    level,
    auditor,
    scope,
    toolNames,
    timeoutMs: boundedIntegerOrDefault(
      value.timeoutMs,
      DEFAULT_TOOL_PROTECTION_CONFIG.timeoutMs,
      TOOL_PROTECTION_TIMEOUT_MIN_MS,
      TOOL_PROTECTION_TIMEOUT_MAX_MS,
      "toolProtection.timeoutMs",
    ),
    maxContextChars: boundedIntegerOrDefault(
      value.maxContextChars,
      DEFAULT_TOOL_PROTECTION_CONFIG.maxContextChars,
      TOOL_PROTECTION_CONTEXT_MIN_CHARS,
      TOOL_PROTECTION_CONTEXT_MAX_CHARS,
      "toolProtection.maxContextChars",
    ),
    retainAuditorSessions: normalizeProtectionRetention(value.retainAuditorSessions),
    debug: normalizeProtectionDebug(value.debug),
  };
}

/**
 * The single derivation seam for consumers (settings display, the future
 * admission coordinator, and diagnostics). An absent block yields the defaults
 * with `enabled: false`; no stored value is invented or rewritten.
 */
export function effectiveToolProtectionSettings(
  config: Pick<ReviewGateConfig, "toolProtection">,
): EffectiveToolProtectionSettings {
  const stored = config.toolProtection;
  if (!stored) {
    return {
      level: DEFAULT_TOOL_PROTECTION_CONFIG.level,
      enabled: false,
      auditor: null,
      scope: DEFAULT_TOOL_PROTECTION_CONFIG.scope,
      toolNames: [],
      timeoutMs: DEFAULT_TOOL_PROTECTION_CONFIG.timeoutMs,
      maxContextChars: DEFAULT_TOOL_PROTECTION_CONFIG.maxContextChars,
      retainAuditorSessions: DEFAULT_TOOL_PROTECTION_CONFIG.retainAuditorSessions,
      debug: DEFAULT_TOOL_PROTECTION_CONFIG.debug,
    };
  }
  return {
    level: stored.level,
    enabled: stored.level !== "off",
    auditor: stored.auditor === null ? null : { ...stored.auditor },
    scope: stored.scope,
    toolNames: [...stored.toolNames],
    timeoutMs: stored.timeoutMs,
    maxContextChars: stored.maxContextChars,
    retainAuditorSessions: stored.retainAuditorSessions,
    // A stored block built before this field existed (or any hand-assembled
    // object that omits it) is Off, never `undefined` treated as truthy.
    debug: stored.debug === true,
  };
}

/**
 * Whether one proposed tool name falls inside the configured audit subset.
 * Exact-name matching only: a name outside a `selected` list is NOT AUDITED
 * (never an implied PASS and never an automatic safe/read-only exemption), and
 * `all` audits every name. This helper answers configured scope membership and
 * nothing else: it grants no infrastructure exemption, not even for the reserved
 * discovery-loader name, because an unrelated definition could otherwise inherit the
 * exemption of a name it does not own. The infrastructure treatment for the loader
 * this extension registered lives solely in the coordinator's ownership-verified
 * branch, which runs before this helper and never reports a pass.
 */
export function toolProtectionAppliesTo(settings: EffectiveToolProtectionSettings, toolName: string): boolean {
  if (!settings.enabled) return false;
  if (settings.scope === "all") return true;
  return settings.toolNames.includes(toolName);
}

function normalizeProtectionLevel(value: unknown): ProtectionLevel {
  if (value === undefined) {
    throw new Error("toolProtection.level is required when toolProtection is present");
  }
  if (typeof value === "string" && (PROTECTION_LEVELS as readonly string[]).includes(value)) {
    return value as ProtectionLevel;
  }
  throw new Error(`toolProtection.level must be one of: ${PROTECTION_LEVELS.join(", ")}`);
}

function normalizeProtectionScope(value: unknown): ToolProtectionScope {
  if (value === undefined) return DEFAULT_TOOL_PROTECTION_CONFIG.scope;
  if (typeof value === "string" && (TOOL_PROTECTION_SCOPES as readonly string[]).includes(value)) {
    return value as ToolProtectionScope;
  }
  throw new Error(`toolProtection.scope must be one of: ${TOOL_PROTECTION_SCOPES.join(", ")}`);
}

/**
 * Exact-name audit subset. Names are matched literally, so an empty or
 * whitespace-padded name is rejected rather than quietly matching nothing, and
 * duplicates collapse to their first occurrence.
 */
function normalizeProtectionToolNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("toolProtection.toolNames must be an array of exact tool names");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.trim() !== item) {
      throw new Error(`toolProtection.toolNames[${index}] must be an exact non-empty tool name`);
    }
    if (seen.has(item)) return;
    seen.add(item);
    names.push(item);
  });
  return names;
}

/**
 * Auditor selection, validated against the same discriminated union the review
 * layers use. Deliberately no catalog cross-check: an external id that does not
 * resolve today stays stored so the runtime can report the auditor as
 * unavailable, and so a rename or a partially written file never discards a
 * reference or silently switches the gate Off.
 */
function normalizeProtectionAuditor(value: unknown): ActiveReviewerSelection | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error("toolProtection.auditor must be null or a selection object");
  }
  if (value.source === "pi") {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error("toolProtection.auditor pi selection requires model");
    }
    if (value.thinkingLevel !== undefined
      && !(TOOL_PROTECTION_THINKING_LEVELS as readonly string[]).includes(value.thinkingLevel as string)) {
      throw new Error(`toolProtection.auditor.thinkingLevel must be one of: ${TOOL_PROTECTION_THINKING_LEVELS.join(", ")}`);
    }
    return {
      source: "pi",
      model: value.model.trim(),
      ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel as ThinkingLevel }),
    };
  }
  if (value.source === "external") {
    if (typeof value.id !== "string" || !value.id.trim()) {
      throw new Error("toolProtection.auditor external selection requires id");
    }
    if (!PROTECTION_ID_PATTERN.test(value.id) || value.id === "." || value.id === "..") {
      throw new Error("toolProtection.auditor external id may contain only letters, numbers, underscores, periods, and hyphens");
    }
    return { source: "external", id: value.id };
  }
  throw new Error("toolProtection.auditor source must be \"pi\" or \"external\"");
}

/**
 * Auditor-session retention. Absent means Off, so an older stored block or an
 * older parent launch pin keeps the pre-retention behavior exactly. A present
 * value must be a real JSON boolean: `"true"`, `1`, and `null` are rejected
 * rather than coerced, because a half-written safety-adjacent setting must not
 * silently acquire a new side effect.
 */
function normalizeProtectionRetention(value: unknown): boolean {
  if (value === undefined) return DEFAULT_TOOL_PROTECTION_CONFIG.retainAuditorSessions;
  if (typeof value === "boolean") return value;
  throw new Error("toolProtection.retainAuditorSessions must be true or false");
}

/**
 * Audit-diagnostic verbosity. Absent means Off, so a stored block or a parent
 * launch pin that predates the field gets the quiet presentation rather than the
 * older per-call status text. A present value must be a real JSON boolean:
 * `"true"`, `1`, and `null` are rejected rather than coerced, because a
 * half-written setting beside a protection control must not silently change what
 * the user sees.
 */
function normalizeProtectionDebug(value: unknown): boolean {
  if (value === undefined) return DEFAULT_TOOL_PROTECTION_CONFIG.debug;
  if (typeof value === "boolean") return value;
  throw new Error("toolProtection.debug must be true or false");
}

function boundedIntegerOrDefault(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a whole number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
