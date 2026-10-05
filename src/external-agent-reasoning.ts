import { externalAgentModelCapability, type ExternalAgentEffortLevel, type GuidedExternalAgentAdapter } from "./settings/external-agent-models";

export type NativeReasoningEffort = "default" | ExternalAgentEffortLevel;
export type ReasoningImport =
  | { kind: "absent" }
  | { kind: "value"; value: ExternalAgentEffortLevel }
  | { kind: "unresolved"; reason: "conflicting" | "malformed-or-unknown" };
export type ReasoningWarning = "identical-duplicates" | "conflicting-effort" | "malformed-or-unknown-effort" | "stale-literal-effort";
export interface LiteralReasoningImport {
  reasoning: ReasoningImport;
  /** Unrecognized argv, unchanged and in order. No shell splitting is performed. */
  remainingArgs: string[];
  recognizedSettingCount: number;
  removedTokenCount: number;
  warnings: ReasoningWarning[];
}

export function isNativeReasoningEffort(adapter: GuidedExternalAgentAdapter, value: unknown): value is NativeReasoningEffort {
  return typeof value === "string" && ["default", "low", "medium", "high", "xhigh", "max", ...(adapter === "codex-cli" ? ["ultra"] : [])].includes(value);
}

/** Diagnostics contain codes/counts only, never unknown values or literal argv. */
export function parseLiteralReasoning(adapter: GuidedExternalAgentAdapter, args: readonly string[] = []): LiteralReasoningImport {
  const remainingArgs: string[] = [];
  const levels: ExternalAgentEffortLevel[] = [];
  let malformed = false;
  let recognizedSettingCount = 0;
  let removedTokenCount = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let recognized = false;
    let value: string | undefined;
    let tokens = 1;
    if (adapter === "claude-cli") {
      if (arg === "--effort") {
        recognized = true;
        if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) {
          value = args[i + 1];
          tokens = 2;
        }
      } else if (arg.startsWith("--effort=")) {
        recognized = true;
        value = arg.slice("--effort=".length);
      }
    } else {
      const separate = arg === "-c" || arg === "--config";
      const config = separate ? args[i + 1] : arg.startsWith("-c=") ? arg.slice(3) : arg.startsWith("--config=") ? arg.slice(9) : undefined;
      if (config !== undefined) {
        const separator = config.indexOf("=");
        const key = (separator < 0 ? config : config.slice(0, separator)).trim();
        if (key === "model_reasoning_effort") {
          recognized = true;
          tokens = separate ? 2 : 1;
          if (separator >= 0) {
            value = config.slice(separator + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
          }
        }
      }
    }
    if (!recognized) { remainingArgs.push(arg); continue; }
    recognizedSettingCount++;
    removedTokenCount += tokens;
    i += tokens - 1;
    if (isNativeReasoningEffort(adapter, value) && value !== "default") levels.push(value);
    else malformed = true;
  }
  const distinct = new Set(levels);
  const warnings: ReasoningWarning[] = [];
  if (malformed) warnings.push("malformed-or-unknown-effort");
  if (distinct.size > 1) warnings.push("conflicting-effort");
  if (!malformed && distinct.size === 1 && levels.length > 1) warnings.push("identical-duplicates");
  const reasoning: ReasoningImport = malformed ? { kind: "unresolved", reason: "malformed-or-unknown" }
    : distinct.size > 1 ? { kind: "unresolved", reason: "conflicting" }
    : levels.length ? { kind: "value", value: levels[0]! } : { kind: "absent" };
  return { reasoning, remainingArgs, recognizedSettingCount, removedTokenCount, warnings };
}

export function encodeNativeReasoning(adapter: GuidedExternalAgentAdapter, effort: NativeReasoningEffort): string[] {
  if (!isNativeReasoningEffort(adapter, effort)) throw new Error("invalid native reasoning effort");
  if (effort === "default") return [];
  return adapter === "claude-cli" ? ["--effort", effort] : ["-c", `model_reasoning_effort="${effort}"`];
}

/** Only use when a structured setting applies; absent settings retain exact legacy concatenation. */
export function nativeReasoningArgs(adapter: GuidedExternalAgentAdapter, sharedArgs: readonly string[], roleArgs: readonly string[], effort: NativeReasoningEffort | undefined): string[] {
  if (effort === undefined) return [...sharedArgs, ...roleArgs];
  return [...parseLiteralReasoning(adapter, [...sharedArgs, ...roleArgs]).remainingArgs, ...encodeNativeReasoning(adapter, effort)];
}

export interface ReasoningScope {
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  args?: string[];
}
export interface NativeReasoningDefinition extends ReasoningScope {
  review?: ReasoningScope;
  execution?: ReasoningScope;
}
export type ReasoningLocation = "shared" | "review" | "execution";
export interface ReasoningValidationIssue {
  location: ReasoningLocation;
  reason: "unverified-model" | "unsupported-effort";
}
/** Edited-UI validation only: never called by global config normalization. */
export function validateNativeReasoning(adapter: GuidedExternalAgentAdapter, definition: NativeReasoningDefinition): ReasoningValidationIssue[] {
  const issues: ReasoningValidationIssue[] = [];
  const validate = (location: ReasoningLocation, model: string | undefined, effort: NativeReasoningEffort | undefined) => {
    if (effort === undefined || effort === "default") return;
    const capability = model === undefined ? undefined : externalAgentModelCapability(adapter, model);
    if (!capability) issues.push({ location, reason: "unverified-model" });
    else if (!capability.effortLevels.includes(effort)) issues.push({ location, reason: "unsupported-effort" });
  };
  validate("shared", definition.model, definition.reasoningEffort);
  for (const location of ["review", "execution"] as const) {
    const role = definition[location];
    if (role) validate(location, role.model ?? definition.model, role.reasoningEffort ?? definition.reasoningEffort);
  }
  return issues;
}

export interface ScopeReasoningImport {
  location: ReasoningLocation;
  /** Typed settings (including inherited shared settings) are authoritative.
   * Absent remains absent (shared CLI default / role inheritance), never a stale override.
   */
  reasoning: ReasoningImport | { kind: "structured"; value: NativeReasoningEffort };
  recognizedSettingCount: number;
  droppedOtherTokenCount: number;
  warnings: ReasoningWarning[];
}
/** Editor extraction: counts all argv that an edited native definition will discard.
 * Conflicts remain unresolved; caller must resolve each scope before staging edits.
 * This does not mutate or construct a saved definition.
 */
export function importNativeReasoning(adapter: GuidedExternalAgentAdapter, definition: NativeReasoningDefinition): ScopeReasoningImport[] {
  const result: ScopeReasoningImport[] = [];
  for (const location of ["shared", "review", "execution"] as const) {
    const scope = location === "shared" ? definition : definition[location];
    if (!scope) continue;
    const parsed = parseLiteralReasoning(adapter, scope.args);
    const typed = scope.reasoningEffort;
    const inheritsStructured = location !== "shared" && typed === undefined && definition.reasoningEffort !== undefined;
    const structuredApplies = typed !== undefined || inheritsStructured;
    result.push({ location, reasoning: typed !== undefined ? { kind: "structured", value: typed } : inheritsStructured ? { kind: "absent" } : parsed.reasoning, recognizedSettingCount: parsed.recognizedSettingCount,
      droppedOtherTokenCount: parsed.remainingArgs.length,
      warnings: structuredApplies && parsed.recognizedSettingCount ? ["stale-literal-effort"] : parsed.warnings });
  }
  return result;
}
