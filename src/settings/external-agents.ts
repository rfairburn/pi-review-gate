import { normalizeConfig, resolvedExternalAgent, type ExternalAgentConfig, type ExternalAgentRoleConfig, type ExternalAgentValue, type ReviewGateConfig } from "../config";
import { retainedSelect } from "./menu";
import { editSettingText } from "./text-input";
import { notify, type UiContext } from "./ui";
import { EXTERNAL_AGENT_MODEL_CATALOG, externalAgentModelCapability, type GuidedExternalAgentAdapter } from "./external-agent-models";
import { importNativeReasoning, validateNativeReasoning, type NativeReasoningEffort, type ReasoningLocation } from "../external-agent-reasoning";

/** The automatic native command the edited-definition boundary applies for a guided adapter. */
export function nativeExternalAgentCommand(adapter: GuidedExternalAgentAdapter): string {
  return adapter === "claude-cli" ? "claude" : "codex";
}

/** Presentation-only editor lineage a validated definition carries for remote Save. */
interface ExternalAgentPresentation {
  legacyReasoningInherited?: boolean;
  roleCreatedInSession?: boolean;
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  args?: string[];
}

function presentation(scope: ExternalAgentRoleConfig | ExternalAgentConfig | ExternalAgentValue): ExternalAgentPresentation {
  return scope as ExternalAgentPresentation;
}

function markRoleCreated(role: ExternalAgentRoleConfig): void {
  presentation(role).roleCreatedInSession = true;
}

/**
 * Reattach the editor's content-free lineage markers to the canonical
 * validated definition. They describe choices (explicit inherit, a freshly
 * created role) that must survive Apply for a remote Save, and are never part
 * of the persisted schema.
 */
function carryPresentation(target: ExternalAgentConfig, source: ExternalAgentConfig): void {
  if (presentation(source).legacyReasoningInherited === true) presentation(target).legacyReasoningInherited = true;
  for (const location of ["review", "execution"] as const) {
    const sourceRole = source[location];
    const targetRole = target[location];
    if (!sourceRole || !targetRole) continue;
    if (presentation(sourceRole).legacyReasoningInherited === true) presentation(targetRole).legacyReasoningInherited = true;
    if (presentation(sourceRole).roleCreatedInSession === true) presentation(targetRole).roleCreatedInSession = true;
  }
}

const adapters = [
  { key: "claude-cli", label: "Claude Code (claude-cli)" },
  { key: "codex-cli", label: "Codex (codex-cli)" },
];

async function selectAdapter(ui: UiContext): Promise<GuidedExternalAgentAdapter | undefined> {
  const choice = await retainedSelect(ui, { title: "Application adapter", rows: adapters });
  return choice === "claude-cli" || choice === "codex-cli" ? choice : undefined;
}

async function selectModel(ui: UiContext, adapter: GuidedExternalAgentAdapter, role: boolean, current?: string): Promise<string | undefined | null> {
  const choice = await retainedSelect(ui, {
    title: "Model — availability depends on CLI/account/provider",
    rows: [
      { key: "unset", label: role ? "Inherit shared model" : "Unset (CLI default)" },
      ...(current ? [{ key: "keep-current", label: `Keep current model: ${current}` }] : []),
      ...EXTERNAL_AGENT_MODEL_CATALOG[adapter].models.map((model) => ({ key: model.value, label: model.label })),
    ],
  });
  if (choice === "keep-current") return current;
  if (choice === "unset") return null;
  return EXTERNAL_AGENT_MODEL_CATALOG[adapter].models.some((model) => model.value === choice) ? choice : undefined;
}

const effortLabels: Record<NativeReasoningEffort, string> = {
  default: "CLI default", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra High (xhigh)", max: "Max", ultra: "Ultra — automatic task delegation",
};

function reasoningLabel(draft: ExternalAgentConfig, adapter: GuidedExternalAgentAdapter, location: ReasoningLocation, unresolved: Set<ReasoningLocation>): string {
  const scope = location === "shared" ? draft : draft[location]!;
  const invalid = unresolved.has(location) || (location !== "shared" && scope.reasoningEffort === undefined && unresolved.has("shared"))
    || validateNativeReasoning(adapter, draft).some((issue) => issue.location === location);
  return `${invalid ? "Invalid — resolve explicitly; " : ""}${scope.reasoningEffort === undefined ? (location === "shared" ? "CLI default" : "inherit shared") : effortLabels[scope.reasoningEffort] ?? "invalid effort"}`;
}

async function selectReasoning(ui: UiContext, draft: ExternalAgentConfig, adapter: GuidedExternalAgentAdapter, location: ReasoningLocation, unresolved: Set<ReasoningLocation>): Promise<void> {
  const scope = presentation(location === "shared" ? draft : draft[location]!);
  const model = scope.model ?? (location === "shared" ? undefined : draft.model);
  const levels = model ? externalAgentModelCapability(adapter, model)?.effortLevels ?? [] : [];
  const inheritedEffort = draft.reasoningEffort;
  const canInherit = location !== "shared" && !unresolved.has("shared")
    && (inheritedEffort === undefined || inheritedEffort === "default" || levels.some((level) => level === inheritedEffort));
  const choice = await retainedSelect(ui, { title: "Reasoning — native model capabilities", rows: [
    ...(canInherit ? [{ key: "inherit", label: "Inherit shared reasoning" }] : []),
    { key: "default", label: "CLI default (no app-owned effort flag)" },
    ...levels.map((level) => ({ key: level, label: effortLabels[level] })),
  ], initialKey: scope.reasoningEffort ?? (location === "shared" ? "default" : "inherit") });
  if (choice === "inherit" && canInherit) {
    delete scope.reasoningEffort;
    scope.legacyReasoningInherited = true;
  } else if (choice === "default" || levels.some((level) => level === choice)) {
    scope.reasoningEffort = choice as NativeReasoningEffort;
    delete scope.legacyReasoningInherited;
  } else return;
  delete scope.args;
  unresolved.delete(location);
}

async function editRole(ui: UiContext, adapter: GuidedExternalAgentAdapter, draft: ExternalAgentConfig, location: "execution" | "review", unresolved: Set<ReasoningLocation>): Promise<void> {
  const role = draft[location]!;
  const name = location === "execution" ? "Execution" : "Review";
  let lastKey: string | undefined;
  while (true) {
    const choice = await retainedSelect(ui, { title: `${name} overrides — model/reasoning inherit shared; other omitted fields use schema defaults`, rows: [
      { key: "model", label: `Model: ${role.model ?? "inherit shared"}` },
      { key: "reasoning", label: `Reasoning: ${reasoningLabel(draft, adapter, location, unresolved)}` },
      { key: "timeout", label: `Timeout (ms): ${role.timeoutMs ?? "default"}` },
      { key: "back", label: "Back" },
    ], initialKey: lastKey });
    if (!choice || choice === "back") return;
    lastKey = choice;
    if (choice === "model") {
      const model = await selectModel(ui, adapter, true, role.model);
      if (model !== undefined) { if (model === null) delete role.model; else role.model = model; }
    } else if (choice === "reasoning") await selectReasoning(ui, draft, adapter, location, unresolved);
    else if (choice === "timeout") {
      const value = await editSettingText(ui, "Timeout in milliseconds (blank = default)", String(role.timeoutMs ?? ""));
      if (value === undefined) continue;
      if (!value.trim()) delete role.timeoutMs;
      else if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        await notify(ui, "Timeout must be a positive integer in milliseconds (for example 60000), or blank for the default.", "error");
      } else role.timeoutMs = Number(value);
    }
  }
}

export type ExternalAgentEditResult =
  | { kind: "apply"; agent: ExternalAgentConfig }
  | { kind: "delete"; id: string };

async function withSaveSuspended<T>(ui: UiContext, operation: () => Promise<T>): Promise<T> {
  const control = ui.saveControl;
  if (!control) return operation();
  control.suspended += 1;
  try {
    return await operation();
  } finally {
    control.suspended -= 1;
  }
}

/**
 * Issue #723: the ONE active external-worker form branch.
 *
 * A Create or Edit form keeps its working definition private until the operator
 * presses Create/Apply, and Cancel/Escape must discard it completely — so an
 * unapplied edit is never staged and can never reach a save payload. The
 * operator can still SEE the edit, so the transaction's single dirty comparison
 * reads it while the form is open: the form registers this branch once, with its
 * opening projection and a live reader, and closes it (undefined) on every exit
 * path. One form, one branch, no observer list, and no second comparison — the
 * caller canonicalizes it together with the staged selection.
 */
export type ExternalAgentFormBranchSnapshot = {
  readonly opening: ExternalAgentFormValue;
  /** Reads the form's live state; the caller never gets a second copy. */
  readCurrent(): ExternalAgentFormValue;
};

export interface ExternalAgentFormBranch {
  (branch: ExternalAgentFormBranchSnapshot | undefined): void;
}

/**
 * What one external-worker Create/Edit form contributes to the transaction's
 * dirty comparison (issue #723): the definition it is editing plus the legacy
 * reasoning locations still unresolved. Two rewrites this editor performs
 * without changing any setting are left out of the projection — the
 * content-free "this scope inherits" marker, and an argument list that is empty
 * either way (loading stores an omitted list as `[]`, and choosing a reasoning
 * level drops it). A real argument list, a real level, and a real unresolved
 * legacy conflict all still participate, and Save behavior is untouched.
 */
type ExternalAgentFormValue = {
  definition: ExternalAgentConfig;
  unresolved: ReasoningLocation[];
};

function projectScope<T extends ExternalAgentValue | ExternalAgentRoleConfig>(scope: T, keepRoleLineage: boolean): T {
  const copy = { ...scope } as T;
  delete presentation(copy).legacyReasoningInherited;
  if (!keepRoleLineage) delete presentation(copy).roleCreatedInSession;
  if (copy.args !== undefined && copy.args.length === 0) delete copy.args;
  return copy;
}

/**
 * The same projection for a whole stored definition (issue #723), so the
 * transaction's dirty comparison can read the external workers it already holds
 * in the draft instead of the log of operations that produced them.
 * `keepRoleLineage` keeps a role's "created in this session" marker: inside a
 * form that is an edit, while on a stored definition it is presentation-only
 * metadata no setting depends on.
 */
export function projectExternalAgentValue<T extends ExternalAgentValue>(agent: T, keepRoleLineage: boolean): T {
  const definition = projectScope(agent, keepRoleLineage);
  const roles = definition as Record<string, unknown>;
  for (const location of ["execution", "review"] as const) {
    const role = agent[location];
    if (role !== undefined) roles[location] = projectScope(role, keepRoleLineage);
  }
  return definition;
}

/** Creates a definition only: no catalog mutations, enrollment, activation or CLI calls. */
export async function selectExternalAgentCreation(
  ui: UiContext,
  config: ReviewGateConfig,
  /** See {@link ExternalAgentFormBranch}. */
  formBranch?: ExternalAgentFormBranch,
): Promise<ExternalAgentConfig | undefined> {
  return withSaveSuspended(ui, async () => {
    const adapter = await selectAdapter(ui);
    if (!adapter) return undefined;
    const result = await editExternalAgent(ui, config, { id: "", adapter }, undefined, formBranch);
    return result?.kind === "apply" ? result.agent : undefined;
  });
}

export async function selectExternalAgentEdit(
  ui: UiContext,
  config: ReviewGateConfig,
  existing: ExternalAgentConfig,
  /** See {@link ExternalAgentFormBranch}. */
  formBranch?: ExternalAgentFormBranch,
): Promise<ExternalAgentEditResult | undefined> {
  if (existing.adapter !== "claude-cli" && existing.adapter !== "codex-cli") return undefined;
  return withSaveSuspended(ui, () => editExternalAgent(ui, config, existing, existing.id, formBranch));
}

async function editExternalAgent(
  ui: UiContext,
  config: ReviewGateConfig,
  initial: ExternalAgentConfig,
  originalId?: string,
  formBranch?: ExternalAgentFormBranch,
): Promise<ExternalAgentEditResult | undefined> {
  try {
    return await runExternalAgentForm(ui, config, initial, originalId, formBranch);
  } finally {
    // Whatever the exit — Create/Apply, Cancel, Escape, Delete, or a throw — the
    // branch closes with the form, so no unapplied edit outlives it (issue #723).
    formBranch?.(undefined);
  }
}

async function runExternalAgentForm(
  ui: UiContext,
  config: ReviewGateConfig,
  initial: ExternalAgentConfig,
  originalId?: string,
  formBranch?: ExternalAgentFormBranch,
): Promise<ExternalAgentEditResult | undefined> {
  let adapter = initial.adapter as GuidedExternalAgentAdapter;
  // Environment entries are deliberately not GUI-editable: manually configured
  // shared/role env (including empty maps) passes through Apply unchanged.
  const draft = structuredClone(initial);
  // Import every scope from the original before installing shared imported effort.
  const imports = importNativeReasoning(adapter, initial);
  const unresolved = new Set<ReasoningLocation>();
  for (const entry of imports) {
    const scope = entry.location === "shared" ? draft : draft[entry.location]!;
    if (entry.reasoning.kind === "unresolved") unresolved.add(entry.location);
    else if (entry.reasoning.kind === "value" || entry.reasoning.kind === "structured") scope.reasoningEffort = entry.reasoning.value;
  }
  let lastKey: string | undefined;
  // The form's contribution to the transaction's one dirty comparison (issue
  // #723): a live reader, registered once, so the answer always matches what is
  // on screen without a second publish path. The opening value it reports is
  // what a Cancel discards back to; taking it here, after the reasoning import
  // above and not from the stored record, is what keeps an opened form clean —
  // the imported reasoning representation is not an edit.
  const readCurrent = (): ExternalAgentFormValue => ({
    definition: projectExternalAgentValue(draft, true),
    unresolved: [...unresolved].sort(),
  });
  formBranch?.({ opening: readCurrent(), readCurrent });
  while (true) {
    const choice = await retainedSelect(ui, { title: originalId === undefined ? "Create external agent definition" : "Edit external worker definition", rows: [
      { key: "id", label: `Identifier: ${draft.id || "required"}` },
      { key: "adapter", label: `Adapter: ${adapter}` },
      { key: "roles", label: `Roles: ${[draft.execution && "execution", draft.review && "review"].filter(Boolean).join(" + ") || "required"}` },
      { key: "model", label: `Shared model: ${draft.model ?? "CLI default"}` },
      { key: "reasoning", label: `Shared reasoning: ${reasoningLabel(draft, adapter, "shared", unresolved)}` },
      ...(draft.execution ? [{ key: "execution", label: `Advanced execution overrides${reasoningLabel(draft, adapter, "execution", unresolved).startsWith("Invalid") ? " — invalid reasoning" : ""}` }] : []),
      ...(draft.review ? [{ key: "review", label: `Advanced review overrides${reasoningLabel(draft, adapter, "review", unresolved).startsWith("Invalid") ? " — invalid reasoning" : ""}` }] : []),
      { key: "create", label: originalId === undefined ? "Create" : "Apply edit" },
      ...(originalId !== undefined ? [{ key: "delete", label: `Delete ${originalId}` }] : []),
      { key: "cancel", label: "Cancel" },
    ], initialKey: lastKey });
    if (!choice || choice === "cancel") return undefined;
    // Delete the selected definition, not any unapplied identity or field edits.
    // This action intentionally bypasses Apply validation.
    if (choice === "delete" && originalId !== undefined) return { kind: "delete", id: originalId };
    lastKey = choice;
    if (choice === "id") {
      // The identifier is one strict line by schema: a host-owned field
      // presents it single-line so an unchanged external-editor save does not
      // append a final newline the unchanged validator below would reject.
      const value = await editSettingText(
        ui, "Unique identifier (letters, numbers, underscores, periods, hyphens)", draft.id,
        undefined, { multiline: false },
      );
      if (value !== undefined) {
        try {
          normalizeConfig({ externalAgents: Object.fromEntries([[value, { adapter, execution: {} }]]) });
          if (value !== originalId && Object.prototype.hasOwnProperty.call(config.externalAgents ?? {}, value)) throw new Error("duplicate");
          draft.id = value;
        } catch {
          await notify(ui, "Identifier must be unique and contain only letters, numbers, underscores, periods, hyphens; '.' and '..' are not allowed.", "error");
        }
      }
    } else if (choice === "adapter") {
      const selected = await selectAdapter(ui);
      if (selected && selected !== adapter) {
        adapter = selected; draft.adapter = adapter;
        draft.command = nativeExternalAgentCommand(adapter);
      }
    } else if (choice === "roles") {
      const roles = await retainedSelect(ui, { title: "Supported roles", rows: [
        { key: "execution", label: "Execution only" }, { key: "review", label: "Review only" }, { key: "both", label: "Execution and review" },
      ] });
      if (roles === "execution" || roles === "review" || roles === "both") {
        if (roles !== "review") {
          if (draft.execution === undefined) { draft.execution = {}; markRoleCreated(draft.execution); }
        } else { delete draft.execution; unresolved.delete("execution"); }
        if (roles !== "execution") {
          if (draft.review === undefined) { draft.review = {}; markRoleCreated(draft.review); }
        } else { delete draft.review; unresolved.delete("review"); }
      }
    } else if (choice === "model") {
      const model = await selectModel(ui, adapter, false, draft.model);
      if (model !== undefined) { if (model === null) delete draft.model; else draft.model = model; }
    } else if (choice === "reasoning") await selectReasoning(ui, draft, adapter, "shared", unresolved);
    else if (choice === "execution" && draft.execution) await editRole(ui, adapter, draft, "execution", unresolved);
    else if (choice === "review" && draft.review) await editRole(ui, adapter, draft, "review", unresolved);
    else if (choice === "create") {
      const unresolvedEnabled = [...unresolved].filter((location) => location === "shared" || draft[location]);
      const issues = validateNativeReasoning(adapter, draft);
      if (unresolvedEnabled.length || issues.length) {
        await notify(ui, `Cannot apply: resolve invalid reasoning in ${[...new Set([...unresolvedEnabled, ...issues.map((issue) => issue.location)])].join(", ")}; choose a compatible model/level, CLI default, or compatible inheritance.`, "error");
        continue;
      }
      if (draft.id !== originalId && Object.prototype.hasOwnProperty.call(config.externalAgents ?? {}, draft.id)) {
        await notify(ui, "Identifier already exists; choose a unique identifier before Create.", "error"); continue;
      }
      try {
        const candidate = structuredClone(draft);
        candidate.command = nativeExternalAgentCommand(adapter);
        delete candidate.args;
        for (const location of ["review", "execution"] as const) {
          if (candidate[location]) { delete candidate[location]!.args; delete candidate[location]!.protocol; }
        }
        const { id, ...definition } = candidate;
        const validated = normalizeConfig({ externalAgents: Object.fromEntries([[id, definition]]) });
        // Diagnostics use original adapter/counts, never secret-bearing values.
        for (const entry of imports) {
          if (entry.recognizedSettingCount || entry.droppedOtherTokenCount || entry.warnings.length) {
            await notify(ui, `Definition ${id}, ${entry.location}: normalized/cleared legacy reasoning settings ${entry.recognizedSettingCount}; removed other argument tokens ${entry.droppedOtherTokenCount}${entry.warnings.length ? `; ${entry.warnings.join(", ")}` : ""}.`, "warning");
          }
        }
        for (const location of ["review", "execution"] as const) {
          if (initial[location]?.protocol !== undefined) await notify(ui, `Definition ${id}, ${location}: removed protocol override (1).`, "warning");
        }
        if (initial.command && initial.command !== nativeExternalAgentCommand(initial.adapter as GuidedExternalAgentAdapter)) {
          await notify(ui, `Definition ${id}, shared: removed custom executable (1); using automatic native command.`, "warning");
        }
        const agent = resolvedExternalAgent(validated, id)!;
        carryPresentation(agent, draft);
        return { kind: "apply", agent };
      } catch {
        // Never echo validation input: arguments/environment may contain secrets.
        await notify(ui, "Cannot apply: supply a valid unique identifier and at least one explicit role.", "error");
      }
    }
  }
}
