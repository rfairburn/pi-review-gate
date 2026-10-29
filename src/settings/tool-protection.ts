/**
 * Tool protection submenu — `/review-settings` → **Tools** → **Tool protection**
 * (issue #536).
 *
 * This module edits the one canonical `toolProtection` block that already lives
 * in the root configuration (`src/tool-protection/config.ts` plus
 * `ReviewGateConfig.toolProtection`). It deliberately adds no second store, no
 * separate enable flag, no per-scope level, and no auditor catalog: the staged
 * value IS a `ToolProtectionConfig`, `Off` is one of the core levels rather
 * than a toggle, and the auditor is the existing reviewer-selection union, so
 * any configured Pi model or external definition can be selected without
 * copying its model, command, or environment here.
 *
 * What the UI must keep honest (agreed #536 boundaries):
 * - The gate is a pre-effect ADDITIONAL restriction only. It grants no
 *   authority and never bypasses native permissions, roles, tool ceilings,
 *   trust, ownership, duplicate/liveness preflight, review, landing, or
 *   cancellation safeguards.
 * - Selecting an auditor is a disclosure decision: the complete governing
 *   instructions, the exact proposed name and arguments, and bounded recent
 *   evidence go to that auditor. Choosing or changing it therefore warns and,
 *   where the host supports it, asks for an explicit confirmation.
 * - `Selected tool names` is REDUCED coverage. A call outside the list is NOT
 *   AUDITED, never an implied PASS, and there is no automatic read-only,
 *   public-URL, or "safe tool" exemption anywhere in this block. Entering that
 *   scope with no established list CHECKS every name the picker currently
 *   offers that this gate can actually audit, so the user unchecks exemptions
 *   instead of hunting for each tool; an existing nonempty list is never
 *   re-checked for them.
 * - The canonical `tool_search` discovery loader is the one infrastructure
 *   exemption the runtime applies at every scope. The picker therefore shows it
 *   as an explicit "never audited — discovery loader" row rather than a checked
 *   audited candidate, never seeds it into a fresh list, never stages it as a
 *   newly audited name, and never counts it in the audited total.
 * - `Selected tool names` is chosen in the SAME searchable exact-name
 *   multi-select the tool-block (deny) pickers use: a native name query above
 *   the rows, one row per tool, Enter toggles, and a checked row means AUDITED
 *   (never denied). The query is a view filter only, a name hidden by the query
 *   or missing from the live inventory stays checked and stays configured, and
 *   there is no typed or comma-separated name entry.
 * - No timeout or context value here is a promise that a fair decision fits.
 * - Route capability is labelled rather than hidden: an external definition the
 *   decision-only runner cannot launch stays selectable and is marked as
 *   failing, and an unresolvable selection stays stored instead of being
 *   switched to something else or silently turning the gate Off.
 *
 * Nothing here applies anything: the root menu's single staged transaction
 * owns root Escape (session-only apply), Save/Ctrl+S (persist), and Cancel
 * (discard, including choices applied earlier in the session). No provider or
 * model call is ever made from settings.
 */
import {
  resolvedExternalAgent,
  resolvedWorkerCatalog,
  type ActiveReviewerSelection,
  type ExternalAgentConfig,
  type ReviewGateConfig,
} from "../config";
import {
  DEFAULT_TOOL_PROTECTION_CONFIG,
  PROTECTION_LEVELS,
  TOOL_PROTECTION_CONTEXT_MAX_CHARS,
  TOOL_PROTECTION_CONTEXT_MIN_CHARS,
  TOOL_PROTECTION_TIMEOUT_MAX_MS,
  TOOL_PROTECTION_TIMEOUT_MIN_MS,
  effectiveToolProtectionSettings,
  isToolProtectionDiscoveryLoaderExempt,
  normalizeToolProtectionConfig,
  type ProtectionLevel,
  type ToolProtectionConfig,
  type ToolProtectionScope,
} from "../tool-protection/config";
import { protectionPolicyProfile } from "../tool-protection/policy";
import { compactToolPurpose } from "../tool-inventory";
import { reviewerKey } from "./review";
import { selectThinkingLevel, effectiveThinkingLevel, thinkingLevelLabel } from "./thinking";
import { alignedSettingsRows, formatDuration, notify, type UiContext } from "./ui";
import { retainedChoice, retainedSelect } from "./menu";
import { retainedDenySelect, type DenyPickerRow } from "./deny-picker";
import { editSettingText } from "./text-input";
import type { ScopedModelChoice } from "./models";

/** The staged slice: the canonical block itself, never a shadow representation. */
export type ToolProtectionSettingsState = ToolProtectionConfig;

/** What the auditor picker may offer, all of it existing configuration. */
export interface ToolProtectionAuditorSources {
  /** The staged draft config, used only to resolve existing references. */
  config: ReviewGateConfig;
  /** Every configured external definition (no reviewer/executor filtering). */
  agents: ExternalAgentConfig[];
  /** The session's scoped Pi models. */
  scoped: ScopedModelChoice[];
}

/**
 * What the audited-NAME picker may offer (issue #536): the same display-only
 * runtime inventory the deny selectors use, and the transaction-opening audit
 * names.
 *
 * The inventory is NOT filtered by the deny rules here: an audited name may be
 * any exact name, and the picker still renders the reserved `tool_search`
 * discovery loader when the runtime offers it — but as an explicit
 * never-audited infrastructure row rather than a selectable audited candidate
 * (see {@link isToolProtectionDiscoveryLoaderExempt}). Rendering an entry
 * neither activates nor authorizes it. `retainedNames` is UI-only row identity
 * (never persisted, never staged, never treated as authorization): it keeps a
 * saved audit name the live inventory no longer offers visible and reversible
 * for the whole menu session, exactly like the deny pickers' retained rows.
 */
export interface AuditedToolNameSources {
  choices: readonly { name: string; description?: string }[];
  retainedNames: readonly string[];
}

/**
 * The names an established-empty `Selected tool names` scope starts with
 * (issue #536): EVERY exact name the audit picker currently offers that this
 * gate can actually audit, in offered order, duplicates and empty names dropped.
 * The reserved `tool_search` discovery loader is NEVER seeded, even when the
 * runtime offers it: the runtime never audits it, so seeding it would present
 * an exempt tool as an audited candidate.
 *
 * This is UI initialization only — the result is an ordinary exact-name subset
 * the user then edits by unchecking rows. It is not a stored "all
 * except"/exclusion schema, not a runtime coverage rule, and not a live
 * re-derivation of coverage: nothing outside the picker re-runs it, and an
 * existing nonempty subset is never replaced by it, so a name the user unchecked
 * stays unchecked across Back, reopening, and scope navigation. An empty
 * inventory yields an empty list, which keeps the existing "at least one exact
 * name required" path truthful instead of fabricating a name or falling back to
 * `All calls` or Off.
 */
export function initialAuditedToolNames(choices: readonly { name: string }[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    const name = choice.name;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    // The exempt discovery loader is never an audited candidate, so a fresh
    // all-checked start never implies that it was.
    if (isToolProtectionDiscoveryLoaderExempt(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The right-hand marker of one audit-picker row. A normal name reports its
 * checked state; the exempt discovery loader reports the truth instead — that
 * this gate never audits it — so no presentation can imply it was checked, and
 * no count includes it.
 */
function auditRowMarker(name: string, checked: boolean): string {
  if (isToolProtectionDiscoveryLoaderExempt(name)) return "· never audited — discovery loader";
  return checked ? "✓ audited" : "✗ not audited";
}

/** Names that actually request an audit, i.e. every staged name minus exemptions. */
function auditableNameCount(names: readonly string[]): number {
  return names.filter((name) => !isToolProtectionDiscoveryLoaderExempt(name)).length;
}

/**
 * Open a settings session on the canonical block. An absent block displays the
 * core defaults; this derivation is the same one the runtime reads, so no
 * second default set exists. It is deliberately described as the EFFECTIVE
 * defaults: an absent block, an explicit `"level":"off"`, and a stored block
 * that failed startup validation (whose normalized value is unavailable) all
 * display identically, so the menu never claims the stored configuration said
 * Off.
 */
export function stagedToolProtectionSettings(config: Pick<ReviewGateConfig, "toolProtection">): ToolProtectionSettingsState {
  const settings = effectiveToolProtectionSettings(config);
  return {
    level: settings.level,
    auditor: settings.auditor === null ? null : { ...settings.auditor },
    scope: settings.scope,
    toolNames: [...settings.toolNames],
    timeoutMs: settings.timeoutMs,
    maxContextChars: settings.maxContextChars,
    retainAuditorSessions: settings.retainAuditorSessions,
  };
}

/**
 * True when the staged owned fields differ from the stored block, including
 * when an invalid block needs replacement. Unchanged defaults over an absent
 * block do not invent a new stored block.
 */
export function toolProtectionStagedWriteNeeded(raw: unknown, staged: ToolProtectionSettingsState): boolean {
  // An absent block means the core defaults, and writing them would invent a
  // protection block an older configuration never had.
  if (raw === undefined) return !toolProtectionBlockIsDefault(staged);
  let stored: ToolProtectionConfig;
  try {
    // Core owns the schema, so core decides whether a present block is
    // comparable at all. A block core rejects — a missing `level` (which core
    // requires whenever the block is present), a `null` tool-name list, an
    // out-of-range bound — is NOT equal to any staged value, including the
    // defaults the menu displays for it. Treating it as "already says this"
    // would skip the write and leave the invalid block in place, so Save would
    // fail on the unchanged stored block instead of recovering from the startup
    // error the way this menu advertises.
    stored = normalizeToolProtectionConfig(raw);
  } catch {
    return true;
  }
  return stored.level !== staged.level
    || JSON.stringify(stored.auditor ?? null) !== JSON.stringify(staged.auditor ?? null)
    || stored.scope !== staged.scope
    || JSON.stringify(stored.toolNames) !== JSON.stringify(staged.toolNames)
    || stored.timeoutMs !== staged.timeoutMs
    || stored.maxContextChars !== staged.maxContextChars
    || stored.retainAuditorSessions !== staged.retainAuditorSessions;
}

/** True when the staged block equals the core defaults an absent block yields. */
function toolProtectionBlockIsDefault(staged: ToolProtectionSettingsState): boolean {
  return staged.level === DEFAULT_TOOL_PROTECTION_CONFIG.level
    && staged.auditor === null
    && staged.scope === DEFAULT_TOOL_PROTECTION_CONFIG.scope
    && staged.toolNames.length === 0
    && staged.timeoutMs === DEFAULT_TOOL_PROTECTION_CONFIG.timeoutMs
    && staged.maxContextChars === DEFAULT_TOOL_PROTECTION_CONFIG.maxContextChars
    && staged.retainAuditorSessions === DEFAULT_TOOL_PROTECTION_CONFIG.retainAuditorSessions;
}

/** The Tools-row / submenu label for one level, taken from the core profiles. */
export function protectionLevelLabel(level: ProtectionLevel): string {
  if (level === "off") return "Off";
  return protectionPolicyProfile(level)?.title ?? level;
}

function protectionLevelOption(level: ProtectionLevel): string {
  if (level === "off") return "Off — this added gate does not apply";
  const profile = protectionPolicyProfile(level);
  return `${profile?.title ?? level} (${level})`;
}

/** One-line identity of an auditor selection, with truthful availability. */
export function auditorSelectionLabel(selection: ActiveReviewerSelection | null, sources: ToolProtectionAuditorSources): string {
  if (selection === null) return "No auditor selected";
  if (selection.source === "pi") {
    const choice = sources.scoped.find((candidate) => candidate.model === selection.model);
    const reasoning = choice ? ` · reasoning ${thinkingLevelLabel(effectiveThinkingLevel(selection.thinkingLevel, choice))}` : "";
    return `${choice?.label ?? selection.model}${reasoning}${choice ? "" : " [not currently scoped]"}`;
  }
  const agent = resolvedExternalAgent(sources.config, selection.id);
  if (!agent) return `${selection.id} [unavailable]`;
  return `${agent.id} [${agent.adapter}]${externalAuditorRouteNote(agent)}`;
}

/**
 * Honest route note for one external definition. It mirrors the fail-closed
 * decision-only route contract already implemented in
 * `src/tool-protection/runner.ts` (no usable role, or the Codex CLI, which has
 * no proven supplied-context-only/no-tools launch contract). The choice stays
 * selectable and Save is not blocked: the label says an audited call would
 * fail, instead of hiding the definition or substituting another one.
 */
function externalAuditorRouteNote(agent: ExternalAgentConfig): string {
  if (!agent.execution && !agent.review) return " · no configured role — audits would fail";
  if (agent.adapter === "codex-cli") return " · no-tools route unproven — audits would fail";
  // The runner refuses every Claude auditor today: invocation-local API retry
  // disabling has not been established, so no process is started and each
  // audited call fails closed (src/tool-protection/runner.ts). The definition
  // stays selectable and Save is not blocked — the label says so plainly
  // instead of leaving an apparently usable auditor that always blocks.
  if (agent.adapter === "claude-cli") return " · Claude route unsupported (retry disabling unproven) — audits would fail";
  return "";
}

/** The Tools-submenu summary for the Tool protection row. */
export function toolProtectionSummary(state: ToolProtectionSettingsState, sources: ToolProtectionAuditorSources): string {
  const parts = [protectionLevelLabel(state.level)];
  if (state.auditor === null) {
    parts.push(state.level === "off" ? "no auditor" : "NO AUDITOR — required");
  } else {
    parts.push(auditorSelectionLabel(state.auditor, sources));
  }
  parts.push(state.scope === "all"
    ? state.level === "off" ? "scope: all calls · auditing disabled" : "all calls audited"
    : `${auditableNameCount(state.toolNames)} named tool(s) · reduced coverage`);
  return parts.join(" · ");
}

/**
 * The privacy and reduced-coverage statement shown before an auditor is
 * chosen or changed, and before a level is enabled. It is the same text for
 * confirm and for the no-confirm-dialog fallback so no host silently gets a
 * shorter disclosure.
 */
function auditorBoundaryWarning(next: ActiveReviewerSelection | null, current: ActiveReviewerSelection | null, state: ToolProtectionSettingsState, sources: ToolProtectionAuditorSources, replacing = true): string {
  const target = next === null ? "no auditor (Off)" : auditorSelectionLabel(next, sources);
  const replacement = current === null || !replacing ? "" : `This replaces the current auditor ${auditorSelectionLabel(current, sources)}; nothing is sent to the previous one afterwards.`;
  const auditable = state.toolNames.filter((name) => !isToolProtectionDiscoveryLoaderExempt(name));
  const coverage = state.scope === "all"
    ? "Audit scope is All calls, so every proposed tool call is sent — except the tool-discovery loader, which this gate never audits."
    : `Audit scope is Selected tool names (${auditable.length > 0 ? auditable.join(", ") : "none named yet"}): every OTHER tool is NOT AUDITED, a skipped call is never a pass, and nothing is sent about it. There is no automatic read-only, public-URL, or safe-tool exemption.`;
  return `Choosing ${target} as the tool-protection auditor sends, for each audited call, the complete governing system instructions, the exact proposed tool name and arguments, and bounded recent session evidence including refusals and genuine approvals. ${replacement}${coverage} The auditor runs decision-only with no tools, no file, command, browser, or subtask access, and a PASS grants no authority: it only means this added gate does not block. Existing permissions, roles, tool ceilings, trust, ownership, preflight, review, landing, and cancellation safeguards stay exactly as they are, and approval text quoted inside evaluated material never waives the protection floor. Nothing takes effect until root Escape (this session) or Save/Ctrl+S (disk); Cancel discards.`;
}

/** One info notice on entry: what this gate is, and what the display means. */
async function explainToolProtection(ui: UiContext): Promise<void> {
  await notify(ui,
    "Tool protection: an optional pre-effect auditor that may BLOCK a proposed tool call before it runs. It is an additional restriction only — it grants no authority and bypasses no existing safeguard — and Off removes only this added gate. The tool-discovery loader (tool_search) is never audited at any level or scope: its calls are reported as NOT AUDITED infrastructure, and every existing native authorization and permission check still applies to them. The rows below start from the effective defaults of the one canonical toolProtection block: an absent block, an explicit Off, and a stored block that failed startup validation all display the same defaults, so this menu does not claim the stored configuration said Off. A block that failed startup validation keeps protected calls blocked until a valid block is saved; saving a valid one here clears that startup error through the existing save path. Native editing of the config file stays an explicit human act. Nothing applies until root Escape (this session) or Save/Ctrl+S (disk); Cancel discards, including choices you applied earlier in this session. No provider or model call is made from this menu.",
    "info");
}

/**
 * The Tool protection submenu. Returns only the staged block; the root menu
 * owns Save / Ctrl+S / root Escape / Cancel and the persistence boundary.
 */
export async function selectToolProtection(
  ui: UiContext,
  initial: ToolProtectionSettingsState,
  sources: ToolProtectionAuditorSources,
  auditedNames: AuditedToolNameSources,
): Promise<ToolProtectionSettingsState> {
  const state: ToolProtectionSettingsState = {
    ...initial,
    auditor: initial.auditor === null ? null : { ...initial.auditor },
    toolNames: [...initial.toolNames],
  };
  await explainToolProtection(ui);
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    // Each row keeps its own dispatch key; the aligned text is display-only.
    const rows: Array<{ key: string; label: string; value: string }> = [
      { key: "level", label: "Protection level", value: protectionLevelLabel(state.level) },
      {
        key: "auditor",
        label: "Auditor",
        value: state.auditor === null
          ? state.level === "off" ? "None · allowed while Off" : "NONE SELECTED · required to enable"
          : auditorSelectionLabel(state.auditor, sources),
      },
      {
        key: "scope",
        label: "Audit scope",
        value: state.scope === "all" ? "All calls" : `Selected tool names · ${auditableNameCount(state.toolNames)} named · REDUCED COVERAGE`,
      },
    ];
    if (state.scope === "selected") {
      // Only names this gate can actually audit are listed; the exempt loader
      // never counts among them.
      const auditable = state.toolNames.filter((name) => !isToolProtectionDiscoveryLoaderExempt(name));
      rows.push({
        key: "toolNames",
        label: "Audited tool names",
        value: auditable.length > 0 ? auditable.join(", ") : "none — at least one exact name required",
      });
    }
    rows.push({ key: "timeout", label: "Decision timeout", value: `${formatDuration(state.timeoutMs)} (entered in seconds)` });
    rows.push({ key: "context", label: "Context budget", value: `${state.maxContextChars} characters` });
    rows.push({
      key: "retention",
      label: "Save auditor sessions",
      value: state.retainAuditorSessions
        ? "On — each audit is saved as a session you can browse"
        : "Off — audits are not saved",
    });
    const aligned = alignedSettingsRows(rows.map((row) => [row.label, row.value] as const));
    const choice = await retainedSelect(ui, {
      title: "Tool protection",
      rows: [
        ...rows.map((row, index) => ({ key: row.key, label: aligned[index]! })),
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return state;
    lastKey = choice;
    if (choice === "level") {
      const next = await selectProtectionLevel(ui, state, sources);
      if (next === undefined) continue;
      if (next !== state.level) {
        state.level = next;
        if (next !== "off" && state.auditor === null) {
          await notify(ui, "Protection level staged as enabled with no auditor. Choose an auditor: the auditor is required for every level except Off, and nothing is applied or saved while it is missing — protection is never silently switched Off to get around that.", "warning");
        }
      }
      continue;
    }
    if (choice === "auditor") {
      const next = await selectAuditor(ui, state, sources);
      if (next === undefined) continue;
      state.auditor = next;
      continue;
    }
    if (choice === "scope") {
      const next = await selectAuditScope(ui, state.scope);
      if (next === undefined || next === state.scope) continue;
      state.scope = next;
      if (next === "selected") {
        await notify(ui, "Selected tool names is deliberately REDUCED coverage: only the exact names you list are audited, every other tool is NOT AUDITED, and a call outside the list is never a pass. The list is exact names only — no patterns, prefixes, globs, and no automatic read-only, public-URL, or safe-tool exemption. Off remains the only way to stop this added gate.", "warning");
        if (state.toolNames.length === 0) {
          // Reduced coverage starts CHECKED so the user unchecks exemptions
          // instead of finding and checking every tool one by one. Only a scope
          // with no established names is seeded; a saved or staged subset stays
          // exactly as it is, so unchecking is the only way a tool leaves the
          // audit list, and nothing here changes what the runtime audits.
          const seeded = initialAuditedToolNames(auditedNames.choices);
          if (seeded.length > 0) {
            state.toolNames = seeded;
            // The exempt discovery loader is not in the seeded list, so say why:
            // the display must not leave the impression that it is audited.
            const exemptOffered = auditedNames.choices
              .map((choice) => choice.name)
              .filter((name) => isToolProtectionDiscoveryLoaderExempt(name));
            const exemption = exemptOffered.length > 0
              ? ` ${exemptOffered.join(", ")} is not in the list because this gate never audits the tool-discovery loader: its calls are reported as NOT AUDITED infrastructure, and its existing native guards still apply.`
              : "";
            await notify(ui, `All ${seeded.length} currently available auditable tool name(s) are checked to start (${seeded.join(", ")}): uncheck the tools you want NOT audited. A tool you uncheck leaves the audit list, its calls are NOT AUDITED rather than passed, and only names the runtime offers today are checked — nothing is invented.${exemption} A saved or previously chosen subset is never re-checked for you. Nothing applies until root Escape (this session) or Save/Ctrl+S (disk).`, "info");
          } else {
            await notify(ui, "No tool named yet: at least one exact tool name is required before this can be applied or saved.", "warning");
          }
        }
      }
      continue;
    }
    if (choice === "toolNames") {
      const names = await selectAuditedToolNames(ui, state.toolNames, auditedNames);
      if (names !== undefined) state.toolNames = names;
      continue;
    }
    if (choice === "timeout") {
      const timeoutMs = await selectDecisionTimeout(ui, state.timeoutMs);
      if (timeoutMs !== undefined) state.timeoutMs = timeoutMs;
      continue;
    }
    if (choice === "context") {
      const maxContextChars = await selectContextBudget(ui, state.maxContextChars);
      if (maxContextChars !== undefined) state.maxContextChars = maxContextChars;
      continue;
    }
    if (choice === "retention") {
      if (!state.retainAuditorSessions) {
        const disclosure = "Turning this on saves every auditor invocation as an ordinary saved Pi session in your normal session store: the exact auditor request and the reply that came back, one session per audit, including timeouts, cancellations, transport errors and malformed replies. Saved audit sessions are records you browse — they are never read back into a later decision, and opening one grants the auditor no tools or authority. Because a record keeps the exact request, it contains whatever the audited context contained, and sessions are kept until you delete them. If a save fails you keep the auditor's verdict and see a warning. Nothing is written while this is Off. Nothing applies until root Escape (this session) or Save/Ctrl+S (disk).";
        if (ui.confirm) {
          if (!await ui.confirm("Save every auditor session?", disclosure)) continue;
        } else {
          await notify(ui, `WARNING: ${disclosure}`, "warning");
        }
        state.retainAuditorSessions = true;
      } else {
        state.retainAuditorSessions = false;
      }
      continue;
    }
  }
}

async function selectProtectionLevel(ui: UiContext, state: ToolProtectionSettingsState, sources: ToolProtectionAuditorSources): Promise<ProtectionLevel | undefined> {
  const options = PROTECTION_LEVELS.map((level) => `${protectionLevelOption(level)}${level === state.level ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Protection level — one shared level for top-level and delegated calls", options);
  if (selected === undefined) return undefined;
  const index = options.indexOf(selected);
  const next = index >= 0 ? PROTECTION_LEVELS[index] : undefined;
  if (next === undefined || next === state.level) return next;
  const profile = protectionPolicyProfile(next);
  if (next === "off") {
    await notify(ui, "Off stops only this added gate. Every existing permission, role, tool ceiling, trust, ownership, preflight, review, landing, and cancellation safeguard stays exactly as it is. Nothing changes until root Escape (this session) or Save/Ctrl+S (disk).", "info");
    return next;
  }
  const warning = `Enabling Protection level "${next}" — ${profile?.title ?? next}: ${profile?.summary ?? ""} ${auditorBoundaryWarning(state.auditor, state.auditor, state, sources, false)}`;
  if (ui.confirm) {
    if (!await ui.confirm("Enable tool protection?", warning)) return undefined;
  } else {
    await notify(ui, `WARNING: ${warning}`, "warning");
  }
  return next;
}

async function selectAuditScope(ui: UiContext, current: ToolProtectionScope): Promise<ToolProtectionScope | undefined> {
  const options = ["all", "selected"].map((value) => `${value === "all" ? "All calls — every proposed tool call is audited" : "Selected tool names — REDUCED coverage, only the listed exact names"}${value === current ? "  current" : ""}`);
  const selected = await retainedChoice(ui, "Audit scope", options);
  if (selected === undefined) return undefined;
  const index = options.indexOf(selected);
  return index >= 0 ? TOOL_PROTECTION_SCOPE_OPTIONS[index] : undefined;
}

const TOOL_PROTECTION_SCOPE_OPTIONS: readonly ToolProtectionScope[] = ["all", "selected"];

/**
 * The auditor picker: the session's scoped Pi models, every configured
 * external definition regardless of reviewer/executor role or route
 * membership, and any Pi model an existing worker resource pins that is not
 * currently scoped (labelled truthfully as such). A stored selection that
 * resolves to nothing stays as a retained `[unavailable]` row so a rename or
 * deletion never discards it or silently picks a substitute.
 */
async function selectAuditor(
  ui: UiContext,
  state: ToolProtectionSettingsState,
  sources: ToolProtectionAuditorSources,
): Promise<ActiveReviewerSelection | null | undefined> {
  const rows = auditorRows(state, sources);
  const currentKey = state.auditor === null ? "none" : reviewerKey(state.auditor);
  while (true) {
    const selected = await retainedChoice(ui, "Tool protection auditor — Enter selects", [
      ...rows.map((row) => `${row.label}${row.key === currentKey ? "  current" : ""}`),
      "Back",
    ]);
    if (selected === undefined || selected === "Back") return undefined;
    const index = rows.findIndex((row) => `${row.label}${row.key === currentKey ? "  current" : ""}` === selected);
    if (index < 0) return undefined;
    const row = rows[index]!;
    const next = row.selection;
    const label = next === null ? "no auditor" : auditorSelectionLabel(next, sources);
    const warning = auditorBoundaryWarning(next, state.auditor, state, sources);
    if (!sameAuditor(next, state.auditor)) {
      if (ui.confirm) {
        if (!await ui.confirm("Send audited tool calls to this auditor?", `${label}: ${warning}`)) {
          await notify(ui, `Auditor unchanged — ${auditorSelectionLabel(state.auditor, sources)}. Tool protection was not enabled or redirected.`, "info");
          return undefined;
        }
      } else {
        await notify(ui, `WARNING: ${label}: ${warning}`, "warning");
      }
    }
    if (next === null) return null;
    if (next.source !== "pi") return { ...next };
    const choice = sources.scoped.find((candidate) => candidate.model === next.model);
    if (!choice) {
      await notify(ui, `${next.model} is not currently scoped, so no reasoning level can be chosen here. The selection is stored as chosen; availability is checked against the host model registry when an audit runs.`, "warning");
      return { ...next };
    }
    const thinkingLevel = await selectThinkingLevel(ui, choice, effectiveThinkingLevel(next.thinkingLevel, choice));
    return { source: "pi", model: next.model, thinkingLevel };
  }
}

interface AuditorRow {
  key: string;
  label: string;
  selection: ActiveReviewerSelection | null;
}

function auditorRows(state: ToolProtectionSettingsState, sources: ToolProtectionAuditorSources): AuditorRow[] {
  const rows: AuditorRow[] = [];
  if (state.level === "off") {
    // Clearing the auditor is only legitimate while Off; core rejects a null
    // auditor at any enabled level, so the row is simply not offered there.
    rows.push({ key: "none", label: "No auditor — valid only while Protection level is Off", selection: null });
  }
  const seen = new Set<string>();
  for (const choice of sources.scoped) {
    const selection: ActiveReviewerSelection = { source: "pi", model: choice.model };
    const key = reviewerKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    // A row for the Pi identity that is ALREADY the auditor carries that
    // selection, reasoning level included. An identity-only row would reopen
    // the reasoning dialog at the model default (commonly High), so merely
    // re-selecting the current auditor — or cancelling that dialog — would
    // silently replace a saved Low choice and change the auditor's cost.
    const stored = state.auditor !== null && state.auditor.source === "pi" && reviewerKey(state.auditor) === key
      ? state.auditor
      : undefined;
    rows.push({ key, label: choice.label, selection: stored === undefined ? selection : { ...stored } });
  }
  // Pi models an existing worker resource pins but the session does not scope
  // are shown as unavailable-but-real, never silently dropped.
  for (const { selection: resource } of Object.values(resolvedWorkerCatalog(sources.config))) {
    if (resource.source !== "pi") continue;
    if (sources.scoped.some((choice) => choice.model === resource.model)) continue;
    const selection: ActiveReviewerSelection = { source: "pi", model: resource.model };
    const key = reviewerKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    const stored = state.auditor !== null && state.auditor.source === "pi" && reviewerKey(state.auditor) === key
      ? state.auditor
      : undefined;
    rows.push({ key, label: `${resource.model} [worker resource · not currently scoped]`, selection: stored === undefined ? selection : { ...stored } });
  }
  for (const agent of sources.agents) {
    const selection: ActiveReviewerSelection = { source: "external", id: agent.id };
    const key = reviewerKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label: `${agent.id} [${agent.adapter}]${externalAuditorRouteNote(agent)}`, selection });
  }
  if (state.auditor !== null && !seen.has(reviewerKey(state.auditor))) {
    rows.push({
      key: reviewerKey(state.auditor),
      label: `${state.auditor.source === "pi" ? state.auditor.model : state.auditor.id} [unavailable · retained]`,
      selection: { ...state.auditor },
    });
  }
  return rows;
}

/**
 * The audited-name list, chosen in the SAME searchable multi-select the tool
 * block (deny) pickers use (issue #536 correction): a native single-line name
 * query above the rows, the shared saved-conversation search grammar, a truthful
 * no-match state, one row per tool with Enter toggling it, and a checked row
 * meaning AUDITED. There is no typed or comma-separated name entry: a name is
 * only ever staged by toggling a row, so a raw configured name is retained
 * rather than silently dropped by a text parser.
 *
 * The rules that differ from a deny picker are the meaning of a check and the
 * inventory, never the interaction:
 * - The inventory is the runtime's discoverable list WITHOUT the deny-only
 *   filter, so the reserved `tool_search` loader is still a row when the runtime
 *   offers it — but an explicit "never audited — discovery loader" row, never a
 *   checked audited candidate, never staged by pressing Enter, and never counted
 *   in the audited total.
 * - A saved audit name the live inventory does not offer stays a configured row
 *   marked `[not currently available]`, in its current checked state, and stays
 *   reversible across toggles and Back/re-entry for the whole menu session.
 * - The query is a pure view filter: it never changes the staged audit set, a
 *   name hidden by the query stays audited, and the query is transient,
 *   per-picker, and never persisted.
 * - An audit subset with NO names is invalid while the scope is `Selected tool
 *   names`, so leaving the picker with nothing checked changes nothing and says
 *   why, instead of staging an empty list core would reject. Off and `All calls`
 *   stay the ways to widen or stop the gate.
 *
 * Nothing here applies or saves anything: the root menu's staged transaction
 * owns Save/Ctrl+S, root Escape, and Cancel.
 */
async function selectAuditedToolNames(
  ui: UiContext,
  current: readonly string[],
  sources: AuditedToolNameSources,
): Promise<string[] | undefined> {
  let names = [...current];
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  // The transient search query for THIS picker only: carried across the toggle
  // redraws, never shared with the deny pickers, never staged or persisted.
  let query = "";
  while (true) {
    const available = new Set(sources.choices.map((choice) => choice.name));
    // The transaction-opening audit names and any staged name stay configured
    // rows while the inventory does not offer them — rendered in their CURRENT
    // checked/unchecked state rather than derived from the audit list, so
    // unchecking an unavailable name never makes its row disappear.
    const absent: string[] = [];
    const seenAbsent = new Set<string>();
    for (const name of [...sources.retainedNames, ...names]) {
      if (name.length === 0 || available.has(name) || seenAbsent.has(name)) continue;
      seenAbsent.add(name);
      absent.push(name);
    }
    const rows: DenyPickerRow[] = [
      ...sources.choices.map((choice) => ({
        key: `tool:${choice.name}`,
        label: `${choice.name}${choice.description ? ` (${compactToolPurpose(choice.description)})` : ""}  ${auditRowMarker(choice.name, names.includes(choice.name))}`,
        searchText: choice.name,
      })),
      ...absent.map((name) => ({
        key: `tool:${name}`,
        label: `${name} [not currently available]  ${auditRowMarker(name, names.includes(name))}`,
        searchText: name,
      })),
      // The Back row is never filtered away: the nested navigation out of the
      // picker stays available under any query.
      { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
    ];
    const result = await retainedDenySelect(ui, {
      title: `Audited tool names (tools outside the list are NOT AUDITED) — Enter toggles — ${auditableNameCount(names)} audited`,
      rows,
      query,
      initialKey: lastKey,
    });
    // The query is view state only: carried into the next presentation of THIS
    // picker, never staged into the settings draft.
    query = result.query;
    if (result.key !== undefined && result.key !== "back") {
      lastKey = result.key;
      if (result.key.startsWith("tool:")) {
        const name = result.key.slice("tool:".length);
        if (isToolProtectionDiscoveryLoaderExempt(name)) {
          // Pressing Enter never marks the discovery loader audited: this gate
          // never audits it, so staging the name would put a tool in the list
          // that the runtime ignores. The row stays an informational
          // infrastructure row and nothing else changes.
          await notify(ui, `${name} is the tool-discovery loader: this gate never audits it, so it cannot be added to the audit list. Its calls stay reported as NOT AUDITED infrastructure, and every existing native authorization, permission, and liveness guard still applies to them. Nothing changed.`, "info");
          continue;
        }
        names = names.includes(name)
          ? names.filter((candidate) => candidate !== name)
          : [...names, name];
      }
      continue;
    }
    // Back or cancel leaves the picker with whatever is checked — except that a
    // subset with nothing left to audit is never staged: core requires at least
    // one exact name for `selected`, and an exempt loader name audits nothing,
    // so the previous names stay and the reason is said. Off and `All calls`
    // stay the ways to widen or stop the gate.
    if (auditableNameCount(names) === 0) {
      await notify(ui, "Scope \"Selected tool names\" requires at least one exact tool name that this gate can audit, so nothing changed. The tool-discovery loader is never audited and does not count. Choose Audit scope → All calls to audit every call instead.", "error");
      return [...current];
    }
    return names;
  }
}

async function selectDecisionTimeout(ui: UiContext, currentMs: number): Promise<number | undefined> {
  const minSeconds = TOOL_PROTECTION_TIMEOUT_MIN_MS / 1000;
  const maxSeconds = TOOL_PROTECTION_TIMEOUT_MAX_MS / 1000;
  const entered = await editSettingText(
    ui,
    `Decision timeout in SECONDS (${minSeconds}-${maxSeconds} seconds) — stored in milliseconds`,
    String(currentMs / 1000),
    "This UI does not support numeric input.",
  );
  if (entered === undefined) return undefined;
  const seconds = Number(entered.trim());
  const timeoutMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TOOL_PROTECTION_TIMEOUT_MIN_MS || timeoutMs > TOOL_PROTECTION_TIMEOUT_MAX_MS) {
    await notify(ui, `Enter a number of seconds from ${minSeconds} to ${maxSeconds} (stored in whole milliseconds). This deadline bounds one decision; it is not a guarantee that a decision arrives within it.`, "error");
    return undefined;
  }
  return timeoutMs;
}

async function selectContextBudget(ui: UiContext, currentChars: number): Promise<number | undefined> {
  const entered = await editSettingText(
    ui,
    `Auditor context budget in CHARACTERS (${TOOL_PROTECTION_CONTEXT_MIN_CHARS}-${TOOL_PROTECTION_CONTEXT_MAX_CHARS}) — the assembled prompt ceiling, not a token count`,
    String(currentChars),
    "This UI does not support numeric input.",
  );
  if (entered === undefined) return undefined;
  const chars = Number(entered.trim());
  if (!Number.isSafeInteger(chars) || chars < TOOL_PROTECTION_CONTEXT_MIN_CHARS || chars > TOOL_PROTECTION_CONTEXT_MAX_CHARS) {
    await notify(ui, `Enter a whole number of characters between ${TOOL_PROTECTION_CONTEXT_MIN_CHARS} and ${TOOL_PROTECTION_CONTEXT_MAX_CHARS}. When the mandatory context plus required refusal/approval evidence does not fit, the call is blocked rather than decided on a truncated brief.`, "error");
    return undefined;
  }
  return chars;
}

function sameAuditor(a: ActiveReviewerSelection | null, b: ActiveReviewerSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return reviewerKey(a) === reviewerKey(b);
}
