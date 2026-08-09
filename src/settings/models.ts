import { THINKING_LEVELS, type ThinkingLevel } from "../config";

export interface ScopedModelChoice {
  model: string;
  label: string;
  pinnedThinkingLevel?: ThinkingLevel;
  supportedThinkingLevels: ThinkingLevel[];
}

export function scopedModelChoices(ctx: unknown): ScopedModelChoice[] | undefined {
  if (!isRecord(ctx) || !Array.isArray(ctx.scopedModels)) {
    return undefined;
  }
  return ctx.scopedModels.flatMap((entry): ScopedModelChoice[] => {
    if (!isRecord(entry) || !isRecord(entry.model)) return [];
    const provider = typeof entry.model.provider === "string" ? entry.model.provider : "";
    const id = typeof entry.model.id === "string" ? entry.model.id : "";
    return provider && id ? [{
      model: `${provider}/${id}`,
      label: `${id} [${provider}]`,
      pinnedThinkingLevel: thinkingLevel(entry.thinkingLevel),
      supportedThinkingLevels: supportedThinkingLevels(entry.model),
    }] : [];
  });
}

function supportedThinkingLevels(model: Record<string, unknown>): ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return THINKING_LEVELS.filter((level) => {
    if (map[level] === null) return false;
    if (level === "xhigh" || level === "max") return typeof map[level] === "string";
    return true;
  });
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
