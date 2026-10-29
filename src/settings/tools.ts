/**
 * Tools settings submenu (issue #434): the two exact-name deny selectors and
 * the tool-related controls that live under one root Tools section — Deferred
 * Pi tools, YouShouldKnow notices, Completion guidance, the existing
 * Web/browser subtree, and the Tool protection gate (#536).
 * Everything here is staged into the root menu's single Save/Cancel
 * transaction; this module never persists, applies, or activates anything.
 * The two deny selectors and the protection audit subset are different
 * features with different rules: a DENIED name may never be the reserved
 * discovery loader, while an AUDITED name may be any exact name including
 * that loader.
 *
 * The deny selectors reuse the established retained multi-select mechanism
 * (the same {@link retainedSelect} toggle loop the reviewer picker uses):
 * every row is one tool, Enter toggles it, and a checked row means the tool is
 * DENIED, exactly the opposite of the reviewer picker's allowed marker. The
 * two selectors are independent: a top-level denial never cascades to
 * executors, and an executor denial only governs newly captured executors.
 *
 * Both deny selectors also carry a live tool-NAME search field (issue #463):
 * a native single-line query above the result list, the same
 * saved-conversation search grammar the saved-conversation picker uses, and a
 * truthful no-match state. The query is a pure view filter — it never changes
 * the staged denial set, and a denial hidden by the query stays denied and
 * stays in the saved configuration. It is transient UI state, it belongs to
 * one picker alone, and it is never persisted or staged.
 *
 * The audit subset (#536) uses the SAME searchable multi-select mechanism and
 * the same candidate inventory: one row per tool, Enter toggles it, and a checked
 * row means the tool is AUDITED. The two features stay separate in what they
 * filter: the audit inventory keeps the reserved discovery loader in view (as an
 * explicit never-audited infrastructure row, because this gate exempts it), while
 * both deny selectors keep excluding it outright, and a saved audit name is never
 * dropped by the deny-only validation.
 *
 * The candidate inventory comes from the runtime through the
 * `getToolChoices` callback — the authoritative, otherwise-discoverable
 * pre-deny inventory the host already has — and is used for display only:
 * rendering it neither activates nor authorizes anything. A name that is
 * denied but absent from the current inventory stays as a configurable row
 * (rendered as not currently available and still reversible) so a saved denial
 * is never lost or silently converted into a grant just because the live
 * catalog changed. Inventory entries are never treated as authorization, and
 * an unavailable or malformed provider simply yields no available rows.
 */
import {
  type BrowserInteractionApproval,
  type WebBrowserPermissions,
  type YouShouldKnowConfig,
} from "../config";
import { compactToolPurpose, DEFERRED_TOOL_SEARCH_NAME } from "../tool-inventory";
import { alignedSettingsRows, formatByteSize, type UiContext } from "./ui";
import { retainedSelect } from "./menu";
import { retainedDenySelect, type DenyPickerRow } from "./deny-picker";
import { selectWebSettings } from "./web";
import {
  selectToolProtection,
  toolProtectionSummary,
  type AuditedToolNameSources,
  type ToolProtectionAuditorSources,
  type ToolProtectionSettingsState,
} from "./tool-protection";

/** One candidate tool from the runtime-supplied pre-deny inventory. */
export interface ToolChoice {
  name: string;
  description?: string;
}

/**
 * Issue #434 follow-up: `tool_search` is required discovery infrastructure —
 * the runtime always supplies it — so it is never a deniable candidate.
 * Canonical config validation rejects it in either deny list and startup
 * recovery drops it with a warning; these settings helpers additionally keep
 * it out of every display and staged value, so a raw programmatic config or a
 * malformed runtime inventory can never offer it as a selectable row, retain
 * it as an unavailable row, count it in a summary, or persist it. This is not
 * a grant: the loader is present regardless.
 */
export function isDeniableToolName(name: string): boolean {
  return name !== DEFERRED_TOOL_SEARCH_NAME;
}

/** The canonical deny list with the reserved loader removed; order preserved. */
export function deniableToolNames(names: readonly string[]): string[] {
  return names.filter(isDeniableToolName);
}

/** The staged Web/browser slice moved under Tools (unchanged semantics). */
export interface ToolSettingsWebState {
  maxDownloadBytes: number;
  browserInteractionApproval: BrowserInteractionApproval;
  browserIdleExpiryMinutes: number;
  browserDownloadRetention: number;
  browserVisible: boolean;
  browserPermissions: WebBrowserPermissions;
}

/** Staged state of the Tools submenu; draft-only until the root Save. */
export interface ToolSettingsState {
  topLevelDeny: string[];
  executorDeny: string[];
  deferredPiTools: boolean;
  youShouldKnow: YouShouldKnowConfig;
  web: ToolSettingsWebState;
  /** The staged canonical `toolProtection` block (#536), never a copy of it. */
  toolProtection: ToolProtectionSettingsState;
}

/**
 * The transaction-opening deny names for both selectors, captured once when
 * the settings menu session opened (issue #434 review pass 1). They are the
 * UI-only identities that keep a saved name which the live inventory no longer
 * offers visible and reversible for the whole menu session — independent of
 * the staged checkbox state, so unchecking it does not delete its row and
 * Back/re-entry does not lose it. They are never persisted, never copied into
 * the draft config, and never treated as authorization: the live canonical
 * config remains the single store, and the runtime inventory remains the only
 * authority on which tools exist.
 */
export interface RetainedToolDenials {
  topLevelDeny: readonly string[];
  executorDeny: readonly string[];
}

/** How one inventory read treats the reserved discovery loader. */
export interface ReadToolChoicesOptions {
  /**
   * Keep the reserved `tool_search` loader in the list when the runtime offers
   * it.
   *
   * The DENY selectors must never present it — canonical config validation
   * rejects it in either deny list — so they read the inventory without this
   * option. The tool-protection audit picker reads WITH it, so the loader is
   * visible instead of silently missing: it renders as an explicit
   * never-audited infrastructure row, because this gate exempts discovery
   * activation at every scope. This is a display difference only: it grants
   * nothing, activates nothing, never turns the loader deniable, and never
   * presents the loader as an audited candidate.
   */
  includeReservedDiscoveryLoader?: boolean;
}

/**
 * Defensive read of the runtime-supplied candidate inventory. Only exact,
 * non-empty, whitespace-consistent names are rendered; duplicates collapse to
 * their first occurrence and order is preserved. A missing, throwing, or
 * malformed provider yields an empty inventory — never a fabricated or
 * pattern-expanded one, and never an authorization.
 *
 * By default the reserved discovery loader is omitted (the deny-rule
 * invariant); see {@link ReadToolChoicesOptions} for the audit picker's
 * loader-inclusive read.
 */
export function readToolChoices(
  provider: (() => readonly { name: string; description?: string }[]) | undefined,
  options: ReadToolChoicesOptions = {},
): ToolChoice[] {
  if (typeof provider !== "function") return [];
  let raw: unknown;
  try {
    raw = provider();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const choices: ToolChoice[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0 || name.trim() !== name || seen.has(name)) continue;
    if (options.includeReservedDiscoveryLoader !== true && !isDeniableToolName(name)) continue;
    const description = (entry as { description?: unknown }).description;
    seen.add(name);
    choices.push(typeof description === "string" ? { name, description } : { name });
  }
  return choices;
}

/**
 * The one-line Web/browser summary shared by the root Tools row and the moved
 * Web row, preserving the previous root Web row's wording exactly.
 */
export function webToolSummary(web: {
  maxDownloadBytes: number;
  browserVisible: boolean;
  browserPermissions: Pick<WebBrowserPermissions, "yolo">;
}): string {
  return `${formatByteSize(web.maxDownloadBytes)} max download · ${web.browserVisible ? "headed" : "headless"} browser${web.browserPermissions.yolo ? " · YOLO ON" : ""}`;
}

/** The root Tools row summary: both deny counts, the deferred-tool state, and the Web summary. */
export function toolsRootSummary(state: {
  topLevelDeny: readonly string[];
  executorDeny: readonly string[];
  deferredPiTools: boolean;
  web: Parameters<typeof webToolSummary>[0];
}): string {
  const topLevelDenied = deniableToolNames(state.topLevelDeny).length;
  const executorDenied = deniableToolNames(state.executorDeny).length;
  return `${topLevelDenied} top-level denied · ${executorDenied} executor denied · deferred ${state.deferredPiTools ? "On" : "Off"} · ${webToolSummary(state.web)}`;
}

/**
 * One deny multi-select. Rows are the authoritative candidates plus every
 * transaction-opening saved name / staged denial the current inventory does
 * not offer; Enter toggles the selected tool between denied (checked) and
 * allowed. An unavailable row is retained by its display-only identity no
 * matter its checkbox state, so it can be unchecked and rechecked (and
 * survives Back/re-entry into this picker) without discarding the transaction.
 * Rows are keyed by the literal tool name (prefixed so a tool named `back`
 * cannot collide with the Back row), which keeps the toggled row highlighted
 * across the checked/unchecked re-show.
 *
 * The picker is the same searchable multi-select the tool-protection audit
 * picker reuses (#536), with the opposite checked meaning.
 *
 * The picker also carries a live NAME search field (issue #463): a native
 * single-line query above the result list, the same saved-conversation search
 * grammar, and a truthful no-match state. The query is a pure view filter —
 * it never changes the staged denial set, and a denial hidden by the query
 * stays denied and stays in the saved configuration. The query is transient
 * and belongs to THIS picker alone: the Top-level and Executor pickers never
 * share it, and it is never persisted or staged.
 */
async function selectDeniedTools(
  ui: UiContext,
  title: "Top-level tools" | "Executor tools",
  initial: readonly string[],
  choices: readonly ToolChoice[],
  retained: readonly string[],
): Promise<string[]> {
  let denied = deniableToolNames(initial);
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  // The transient search query for THIS picker only (issue #463). It is
  // retained across the toggle redraws so a narrowed view survives a
  // toggle, and it is never shared with the other picker.
  let query = "";
  while (true) {
    const available = new Set(choices.map((choice) => choice.name));
    // The transaction-opening names and any staged denial stay configured rows
    // while the inventory does not offer them — rendered in their CURRENT
    // checked/unchecked state rather than derived from the deny list, so
    // unchecking an unavailable name never makes its row disappear.
    const absent: string[] = [];
    const seenAbsent = new Set<string>();
    for (const name of [...deniableToolNames(retained), ...denied]) {
      if (available.has(name) || seenAbsent.has(name)) continue;
      seenAbsent.add(name);
      absent.push(name);
    }
    const rows: DenyPickerRow[] = [
      ...choices.map((choice) => ({
        key: `tool:${choice.name}`,
        label: `${choice.name}${choice.description ? ` (${compactToolPurpose(choice.description)})` : ""}  ${denied.includes(choice.name) ? "✓ denied" : "✗ allowed"}`,
        searchText: choice.name,
      })),
      ...absent.map((name) => ({
        key: `tool:${name}`,
        label: `${name} [not currently available]  ${denied.includes(name) ? "✓ denied" : "✗ allowed"}`,
        searchText: name,
      })),
      // The Back row is never filtered away: the nested navigation out of the
      // picker stays available under any query.
      { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
    ];
    const result = await retainedDenySelect(ui, {
      title: `${title} — Enter toggles — ${denied.length} denied`,
      rows,
      query,
      initialKey: lastKey,
    });
    // The query is view state only: it is carried into the next presentation
    // of THIS picker and never staged into the settings draft.
    query = result.query;
    if (result.key === undefined) return denied;
    const choice = result.key;
    if (choice === "back") return denied;
    lastKey = choice;
    if (!choice.startsWith("tool:")) continue;
    const name = choice.slice("tool:".length);
    if (!isDeniableToolName(name)) continue;
    denied = denied.includes(name)
      ? denied.filter((candidate) => candidate !== name)
      : [...denied, name];
  }
}

/**
 * The Tools submenu. Returns only its own staged slice: the two deny lists,
 * the moved toggles, and the moved Web/browser values. The root menu keeps
 * those locals and remains the sole owner of the Save/Cancel transaction.
 * `retained` carries the transaction-opening deny names so the two deny
 * pickers keep every unavailable saved name as a reversible display-only row
 * for the whole menu session. `protection` supplies the existing configuration
 * the auditor picker lists (every external definition and the scoped models); it
 * is read for display and reference resolution only and never mutated here.
 * `auditedNames` supplies the same display-only inventory for the audit subset
 * (reserved loader kept when offered) plus the transaction-opening audit names,
 * retained by the same rule as the deny rows and never filtered by the deny
 * rules.
 */
export async function selectToolSettings(
  ui: UiContext,
  initial: ToolSettingsState,
  choices: readonly ToolChoice[],
  retained: RetainedToolDenials,
  protection: ToolProtectionAuditorSources,
  auditedNames: AuditedToolNameSources,
): Promise<ToolSettingsState> {
  const state: ToolSettingsState = {
    topLevelDeny: deniableToolNames(initial.topLevelDeny),
    executorDeny: deniableToolNames(initial.executorDeny),
    deferredPiTools: initial.deferredPiTools,
    youShouldKnow: { ...initial.youShouldKnow },
    web: { ...initial.web, browserPermissions: { ...initial.web.browserPermissions } },
    toolProtection: {
      ...initial.toolProtection,
      auditor: initial.toolProtection.auditor === null ? null : { ...initial.toolProtection.auditor },
      toolNames: [...initial.toolProtection.toolNames],
    },
  };
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [topLevelRow, executorRow, deferredRow, noticesRow, guidanceRow, webRow, protectionRow] = alignedSettingsRows([
      ["Top-level tools", `${state.topLevelDeny.length} denied`],
      ["Executor tools", `${state.executorDeny.length} denied`],
      ["Deferred Pi tools", `${state.deferredPiTools ? "On" : "Off"} · local now, new subtasks`],
      ["YouShouldKnow notices", state.youShouldKnow.enabled ? "On" : "Off"],
      ["Completion guidance", state.youShouldKnow.completionGuidance ? "On" : "Off"],
      ["Web", webToolSummary(state.web)],
      // The label stays short ("Tool protection") so this section's established
      // label alignment is unchanged.
      ["Tool protection", toolProtectionSummary(state.toolProtection, protection)],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Tools",
      rows: [
        { key: "topLevelDeny", label: topLevelRow },
        { key: "executorDeny", label: executorRow },
        { key: "deferredTools", label: deferredRow },
        { key: "youShouldKnow", label: noticesRow },
        { key: "completionGuidance", label: guidanceRow },
        { key: "web", label: webRow },
        { key: "toolProtection", label: protectionRow },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return state;
    lastKey = choice;
    if (choice === "topLevelDeny") {
      state.topLevelDeny = await selectDeniedTools(ui, "Top-level tools", state.topLevelDeny, choices, retained.topLevelDeny);
      continue;
    }
    if (choice === "executorDeny") {
      state.executorDeny = await selectDeniedTools(ui, "Executor tools", state.executorDeny, choices, retained.executorDeny);
      continue;
    }
    if (choice === "deferredTools") {
      state.deferredPiTools = !state.deferredPiTools;
      continue;
    }
    if (choice === "youShouldKnow") {
      state.youShouldKnow = { ...state.youShouldKnow, enabled: !state.youShouldKnow.enabled };
      continue;
    }
    if (choice === "completionGuidance") {
      state.youShouldKnow = { ...state.youShouldKnow, completionGuidance: !state.youShouldKnow.completionGuidance };
      continue;
    }
    if (choice === "toolProtection") {
      // Issue #536: the pre-effect gate. Only the canonical block
      // is staged; the auditor, level, scope, and budgets stay in core's shape.
      state.toolProtection = await selectToolProtection(ui, state.toolProtection, protection, auditedNames);
      continue;
    }
    // choice === "web": the existing Web/browser subtree, unchanged, staged
    // through the same shared transaction.
    const web = await selectWebSettings(
      ui,
      state.web.maxDownloadBytes,
      state.web.browserInteractionApproval,
      state.web.browserIdleExpiryMinutes,
      state.web.browserDownloadRetention,
      state.web.browserVisible,
      state.web.browserPermissions,
    );
    state.web = {
      maxDownloadBytes: web.maxDownloadBytes,
      browserInteractionApproval: web.browserInteractionApproval,
      browserIdleExpiryMinutes: web.browserIdleExpiryMinutes,
      browserDownloadRetention: web.browserDownloadRetention,
      browserVisible: web.browserVisible,
      browserPermissions: web.browserPermissions,
    };
  }
}
