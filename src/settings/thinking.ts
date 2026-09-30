/**
 * The model thinking-level seam shared by worker resource routes and
 * reviewer selection: the effective-level fallback chain, its display
 * label, and the shared per-model reasoning picker.
 */
import type { ThinkingLevel } from "../config";
import type { ScopedModelChoice } from "./models";
import type { UiContext } from "./ui";

export async function selectThinkingLevel(
  ui: UiContext,
  model: ScopedModelChoice,
  current: ThinkingLevel,
): Promise<ThinkingLevel> {
  const options = model.supportedThinkingLevels.map((level) =>
    `${thinkingLevelLabel(level)}${level === current ? "  current" : ""}`
  );
  const selected = await ui.select(`Reasoning — ${model.label}`, options);
  return model.supportedThinkingLevels.find((level) =>
    selected === `${thinkingLevelLabel(level)}${level === current ? "  current" : ""}`
  ) ?? current;
}

export function effectiveThinkingLevel(value: ThinkingLevel | undefined, model: ScopedModelChoice): ThinkingLevel {
  if (value && model.supportedThinkingLevels.includes(value)) return value;
  if (model.pinnedThinkingLevel && model.supportedThinkingLevels.includes(model.pinnedThinkingLevel)) {
    return model.pinnedThinkingLevel;
  }
  if (model.supportedThinkingLevels.includes("high")) return "high";
  return model.supportedThinkingLevels.at(-1) ?? "off";
}

export function thinkingLevelLabel(value: ThinkingLevel): string {
  return value === "xhigh" ? "X-high" : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
