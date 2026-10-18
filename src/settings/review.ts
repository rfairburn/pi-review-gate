/**
 * Review layer selection for the settings menu: the automatic-review
 * toggles and one reviewer set per layer (primary, subtask), staged as
 * plain draft values, plus the reviewer-selection helpers shared with the
 * scheduled-task review overrides and the save-time validation.
 */
import {
  externalAgentSupportsReview,
  effectiveReviewEvidenceSettings,
  type EffectiveReviewEvidenceSettings,
  type ActiveReviewerSelection,
  type ExternalAgentConfig,
} from "../config";
import { evidenceMethodLabel, TOOLS_ONLY_LABEL, WORKSPACE_CHANGES_LABEL } from "../review-evidence";
import type { ScopedModelChoice } from "./models";
import { alignedSettingsRows, notify, type UiContext } from "./ui";
import { effectiveThinkingLevel, selectThinkingLevel, thinkingLevelLabel } from "./thinking";
import { retainedSelect } from "./menu";

/** Staged state of the Review submenu (issue #175); draft-only until Save. */
export interface ReviewSectionState {
  primaryReviewers: ActiveReviewerSelection[];
  subtaskReviewers: ActiveReviewerSelection[];
  primaryEnabled: boolean;
  subtaskEnabled: boolean;
  reviewLandedChanges: boolean;
  evidence?: EffectiveReviewEvidenceSettings;
}

/**
 * The Review submenu (issue #175): the automatic-review toggles plus one
 * reviewer set per layer, picked from the existing reviewer catalog. Saved
 * choices take effect for automatic reviews after Save; both layers may be
 * Off, and with both Off there is no automatic review. The toggles control
 * automatic review only: manual `/review-now` and `/ask-reviewer` stay usable
 * while reviewers remain selected, and no model-controlled path reaches this
 * menu. Review timing stays model idle — the landed-changes toggle governs
 * which subtask landings are included in the primary review window, never
 * instant review: On adds only unreviewed subtask landings to the primary
 * window, while a subtask landing that passed its own review keeps today's
 * checkpoint/bypass and is not redundantly re-reviewed — and nothing is ever
 * fabricated as a pass.
 */
export async function selectReviewSection(
  ui: UiContext,
  initial: ReviewSectionState,
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ReviewSectionState> {
  const state: ReviewSectionState = {
    primaryReviewers: initial.primaryReviewers.map(cloneReviewerSelection),
    subtaskReviewers: initial.subtaskReviewers.map(cloneReviewerSelection),
    primaryEnabled: initial.primaryEnabled,
    subtaskEnabled: initial.subtaskEnabled,
    reviewLandedChanges: initial.reviewLandedChanges,
    ...(initial.evidence !== undefined ? { evidence: { ...initial.evidence } } : {}),
  };
  const totalChoices = scoped.length + agents.filter(externalAgentSupportsReview).length;
  await notify(
    ui,
    "Automatic primary review covers the primary assistant's own changes (one policy shared by Execute and Orchestrate); automatic subtask review covers subtask results before ordinary accepted landing. The toggles control automatic review only — /review-now and /ask-reviewer stay available while reviewers remain selected, and a saved Off stops automatic review for that layer once saved; with both layers Off there is no automatic review. Reviewing landed changes adds only unreviewed subtask landings to the primary review window instead of checkpointing them out; a subtask landing that passed its own review keeps today's checkpoint/bypass and is not redundantly re-reviewed by the primary review. It is inactive while automatic primary review is off. Review timing stays model idle — the landed toggle governs inclusion in the review window, never instant review. Each layer has its own reviewer set from the same reviewer catalog.",
    "info",
  );
  // Caller-local last selection for this loop only (issue #140).
  let lastKey: string | undefined;
  while (true) {
    const [primaryRow, subtaskRow, landedRow, primaryReviewersRow, subtaskReviewersRow] = alignedSettingsRows([
      ["Automatic primary review", state.primaryEnabled ? "On" : "Off"],
      ["Automatic subtask review", state.subtaskEnabled ? "On" : "Off"],
      ["Review landed changes", state.reviewLandedChanges
        ? state.primaryEnabled ? "On" : "On · inactive (automatic primary review is off)"
        : "Off"],
      ["Primary reviewers", `${state.primaryReviewers.length}/${totalChoices} selected`],
      ["Subtask reviewers", `${state.subtaskReviewers.length}/${totalChoices} selected`],
    ]);
    const choice = await retainedSelect(ui, {
      title: "Review",
      rows: [
        { key: "primaryToggle", label: primaryRow },
        { key: "subtaskToggle", label: subtaskRow },
        { key: "landed", label: landedRow },
        { key: "primaryReviewers", label: primaryReviewersRow },
        { key: "subtaskReviewers", label: subtaskReviewersRow },
        { key: "evidence", label: "Evidence methods" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return state;
    lastKey = choice;
    if (choice === "evidence") {
      state.evidence = await selectReviewEvidence(ui, state.evidence ?? effectiveReviewEvidenceSettings({}));
      continue;
    }
    if (choice === "primaryToggle") {
      state.primaryEnabled = !state.primaryEnabled;
      continue;
    }
    if (choice === "subtaskToggle") {
      state.subtaskEnabled = !state.subtaskEnabled;
      continue;
    }
    if (choice === "landed") {
      if (!state.primaryEnabled) {
        await notify(ui, "Reviewing landed changes is inactive while automatic primary review is off; turn on automatic primary review first.", "info");
        continue;
      }
      state.reviewLandedChanges = !state.reviewLandedChanges;
      continue;
    }
    if (choice === "primaryReviewers") {
      state.primaryReviewers = await selectReviewers(ui, state.primaryReviewers, agents, scoped);
      continue;
    }
    if (choice === "subtaskReviewers") {
      state.subtaskReviewers = await selectReviewers(ui, state.subtaskReviewers, agents, scoped);
      continue;
    }
  }
}

/** Draft-only evidence controls; runtime effects belong to the root apply boundary. */
async function selectReviewEvidence(
  ui: UiContext,
  initial: EffectiveReviewEvidenceSettings,
): Promise<EffectiveReviewEvidenceSettings> {
  const evidence = { ...initial };
  await notify(ui,
    `Evidence methods only — these controls do not disable review, change operating mode, or select reviewers. Each scope is independent. ${WORKSPACE_CHANGES_LABEL} adds whole-workspace snapshot/diff review evidence; ${TOOLS_ONLY_LABEL} omits that whole-workspace evidence. Both retain bounded tool calls/results, observed file content and per-file tool-observation diffs, task/assistant context, and reviewer read access. Mandatory construction, checkpoint, and landing verification is unchanged. Enter cycles the method. Snapshot-failure fallback is a separate opt-in to ${TOOLS_ONLY_LABEL} when snapshot capture fails; Off keeps failure fail-closed. Navigation only stages choices; root Escape applies for the session, Save/Ctrl+S persists, and Cancel discards.`,
    "info");
  let lastKey: string | undefined;
  while (true) {
    const fields = [
      ["primaryToolOnly", "Primary / top-level"],
      ["worktreeToolOnly", "Isolated worktree"],
      ["inplaceToolOnly", "InPlace"],
      ["snapshotFailureFallback", "Snapshot-failure fallback"],
    ] as const;
    const labels = alignedSettingsRows(fields.map(([field, label]) => [label,
      field === "snapshotFailureFallback" ? evidence[field] ? "On" : "Off" : evidenceMethodLabel(evidence[field]),
    ] as const));
    const choice = await retainedSelect(ui, {
      title: "Review evidence methods",
      rows: [...fields.map(([key], index) => ({ key, label: labels[index]! })), { key: "back", label: "Back" }],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return evidence;
    const field = fields.find(([key]) => key === choice)?.[0];
    if (!field) continue;
    lastKey = field;
    evidence[field] = !evidence[field];
    if (field === "primaryToolOnly" && evidence.primaryToolOnly) {
      await notify(ui,
        `WARNING: Applying Primary / top-level ${WORKSPACE_CHANGES_LABEL} → ${TOOLS_ONLY_LABEL} clears accumulated primary review evidence and starts a new evidence window. This is staged only until root Escape or Save/Ctrl+S; Cancel discards it. ${TOOLS_ONLY_LABEL} → ${WORKSPACE_CHANGES_LABEL} retains evidence and establishes a new snapshot baseline.`,
        "warning");
    }
  }
}

export async function selectReviewers(
  ui: UiContext,
  initial: ActiveReviewerSelection[],
  agents: ExternalAgentConfig[],
  scoped: ScopedModelChoice[],
): Promise<ActiveReviewerSelection[]> {
  let selected = initial.map(cloneReviewerSelection);
  // Caller-local last selection for this loop only: keys are the reviewer
  // keys (reasoning rows prefixed), stable across the ✓/✗ label flips, so a
  // toggled row stays highlighted on the re-show (issue #140).
  let lastKey: string | undefined;
  const availableRows = (): Array<{ key: string; value: ActiveReviewerSelection; label: string }> => [
    ...scoped.map((choice) => ({
      key: reviewerKey({ source: "pi", model: choice.model }),
      value: { source: "pi" as const, model: choice.model },
      label: choice.label,
    })),
    ...agents.filter(externalAgentSupportsReview).map((agent) => ({
      key: reviewerKey({ source: "external", id: agent.id }),
      value: { source: "external" as const, id: agent.id },
      label: `${agent.id} [${agent.adapter}]`,
    })),
  ];
  while (true) {
    const rows = availableRows();
    const availableKeys = new Set(rows.map((row) => row.key));
    const unavailable = selected.filter((selection) => !availableKeys.has(reviewerKey(selection)));
    const reasoningRows = rows.flatMap((row) => {
      if (row.value.source !== "pi" || !hasReviewer(selected, row.value)) return [];
      const model = row.value.model;
      const selection = selected.find((candidate) => reviewerKey(candidate) === row.key);
      const choice = scoped.find((candidate) => candidate.model === model);
      if (!selection || selection.source !== "pi" || !choice) return [];
      const level = effectiveThinkingLevel(selection.thinkingLevel, choice);
      return [{ key: row.key, label: `Reasoning · ${row.label}  ${thinkingLevelLabel(level)}`, selection, choice }];
    });
    const choice = await retainedSelect(ui, {
      title: `Reviewers — Enter toggles — ${selected.length}/${rows.length} selected`,
      rows: [
        ...rows.map((row) => ({ key: row.key, label: `${row.label} ${hasReviewer(selected, row.value) ? "✓" : "✗"}` })),
        ...unavailable.map((selection) => ({ key: reviewerKey(selection), label: `${reviewerSelectionLabel(selection)} [unavailable] ✓` })),
        ...reasoningRows.map((row) => ({ key: `reasoning:${row.key}`, label: row.label })),
        { key: "enableAll", label: "Enable all" },
        { key: "clearAll", label: "Clear all" },
        { key: "back", label: "Back" },
      ],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") return selected;
    lastKey = choice;
    if (choice === "enableAll") {
      selected = rows.map((row) => {
        if (row.value.source !== "pi") return cloneReviewerSelection(row.value);
        const model = row.value.model;
        const modelChoice = scoped.find((candidate) => candidate.model === model)!;
        const existing = selected.find((candidate) => reviewerKey(candidate) === row.key);
        const existingLevel = existing?.source === "pi" ? existing.thinkingLevel : undefined;
        return { ...row.value, thinkingLevel: effectiveThinkingLevel(existingLevel, modelChoice) };
      });
      continue;
    }
    if (choice === "clearAll") {
      selected = [];
      continue;
    }
    const row = rows.find((candidate) => candidate.key === choice);
    const unavailableRow = unavailable.find((candidate) => reviewerKey(candidate) === choice);
    const reasoningRow = reasoningRows.find((candidate) => `reasoning:${candidate.key}` === choice);
    if (reasoningRow) {
      const thinkingLevel = await selectThinkingLevel(
        ui,
        reasoningRow.choice,
        effectiveThinkingLevel(reasoningRow.selection.thinkingLevel, reasoningRow.choice),
      );
      selected = selected.map((candidate) => reviewerKey(candidate) === reviewerKey(reasoningRow.selection)
        ? { ...candidate, thinkingLevel }
        : candidate);
      continue;
    }
    const value = row?.value ?? unavailableRow;
    if (value) {
      if (hasReviewer(selected, value)) {
        selected = selected.filter((candidate) => reviewerKey(candidate) !== reviewerKey(value));
      } else if (value.source === "pi") {
        const modelChoice = scoped.find((candidate) => candidate.model === value.model);
        const thinkingLevel = modelChoice
          ? await selectThinkingLevel(ui, modelChoice, effectiveThinkingLevel(value.thinkingLevel, modelChoice))
          : value.thinkingLevel;
        selected = [...selected, { ...value, thinkingLevel }];
      } else {
        selected = [...selected, cloneReviewerSelection(value)];
      }
    }
  }
}

function reviewerSelectionLabel(selection: ActiveReviewerSelection): string {
  return selection.source === "pi" ? selection.model : selection.id;
}

export function reviewerKey(selection: ActiveReviewerSelection): string {
  return selection.source === "pi" ? `pi:${selection.model}` : `external:${selection.id}`;
}

function hasReviewer(values: ActiveReviewerSelection[], target: ActiveReviewerSelection): boolean {
  return values.some((value) => reviewerKey(value) === reviewerKey(target));
}

function cloneReviewerSelection(value: ActiveReviewerSelection): ActiveReviewerSelection {
  return { ...value };
}

export function materializeReviewerThinking(
  values: ActiveReviewerSelection[],
  scoped: ScopedModelChoice[],
): ActiveReviewerSelection[] {
  return values.map((value) => {
    if (value.source !== "pi") return cloneReviewerSelection(value);
    const choice = scoped.find((candidate) => candidate.model === value.model);
    return choice ? { ...value, thinkingLevel: effectiveThinkingLevel(value.thinkingLevel, choice) } : { ...value };
  });
}
