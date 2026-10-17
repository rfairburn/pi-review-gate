/**
 * Tools settings submenu (issue #434): the two exact-name deny selectors and
 * the tool-related controls that live under one root Tools section — Deferred
 * Pi tools, YouShouldKnow notices, Completion guidance, and the existing
 * Web/browser subtree. Everything here is staged into the root menu's single
 * Save/Cancel transaction; this module never persists, applies, or activates
 * anything.
 *
 * The deny selectors reuse the established retained multi-select mechanism
 * (the same {@link retainedSelect} toggle loop the reviewer picker uses):
 * every row is one tool, Enter toggles it, and a checked row means the tool is
 * DENIED, exactly the opposite of the reviewer picker's allowed marker. The
 * two selectors are independent: a top-level denial never cascades to
 * executors, and an executor denial only governs newly captured executors.
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
import { selectWebSettings } from "./web";

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

/**
 * Defensive read of the runtime-supplied candidate inventory. Only exact,
 * non-empty, whitespace-consistent names are rendered; duplicates collapse to
 * their first occurrence and order is preserved. A missing, throwing, or
 * malformed provider yields an empty inventory — never a fabricated or
 * pattern-expanded one, and never an authorization.
 */
export function readToolChoices(
  provider: (() => readonly { name: string; description?: string }[]) | undefined,
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
    if (!isDeniableToolName(name)) continue;
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
    const rows = [
      ...choices.map((choice) => ({
        key: `tool:${choice.name}`,
        label: `${choice.name}${choice.description ? ` (${compactToolPurpose(choice.description)})` : ""}  ${denied.includes(choice.name) ? "✓ denied" : "✗ allowed"}`,
      })),
      ...absent.map((name) => ({
        key: `tool:${name}`,
        label: `${name} [not currently available]  ${denied.includes(name) ? "✓ denied" : "✗ allowed"}`,
      })),
      { key: "back", label: "Back" },
    ];
    const choice = await retainedSelect(ui, {
      title: `${title} — Enter toggles — ${denied.length} denied`,
      rows,
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return denied;
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
 * for the whole menu session.
 */
export async function selectToolSettings(
  ui: UiContext,
  initial: ToolSettingsState,
  choices: readonly ToolChoice[],
  retained: RetainedToolDenials,
): Promise<ToolSettingsState> {
  const state: ToolSettingsState = {
    topLevelDeny: deniableToolNames(initial.topLevelDeny),
    executorDeny: deniableToolNames(initial.executorDeny),
    deferredPiTools: initial.deferredPiTools,
    youShouldKnow: { ...initial.youShouldKnow },
    web: { ...initial.web, browserPermissions: { ...initial.web.browserPermissions } },
  };
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [topLevelRow, executorRow, deferredRow, noticesRow, guidanceRow, webRow] = alignedSettingsRows([
      ["Top-level tools", `${state.topLevelDeny.length} denied`],
      ["Executor tools", `${state.executorDeny.length} denied`],
      ["Deferred Pi tools", `${state.deferredPiTools ? "On" : "Off"} · local now, new subtasks`],
      ["YouShouldKnow notices", state.youShouldKnow.enabled ? "On" : "Off"],
      ["Completion guidance", state.youShouldKnow.completionGuidance ? "On" : "Off"],
      ["Web", webToolSummary(state.web)],
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
