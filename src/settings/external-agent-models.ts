/** Native CLI values, not Pi thinking levels. In particular, max is not xhigh. */
export type ExternalAgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ExternalAgentModelProvenance {
  readonly source: string;
  readonly resolvedSource?: string;
  readonly effortSource: string;
  readonly verifiedOn: string;
  readonly version?: string;
  readonly release?: string;
  readonly sourceBlob?: string;
}

export interface ExternalAgentModelCapability {
  readonly value: string;
  readonly label: string;
  readonly effortLevels: readonly ExternalAgentEffortLevel[];
  /** Bundled native effort default; does not choose the CLI's default model. */
  readonly defaultEffort: ExternalAgentEffortLevel | undefined;
  readonly provenance: ExternalAgentModelProvenance;
}

const CLAUDE_PROVENANCE = {
  source: "https://code.claude.com/docs/en/model-config",
  effortSource: "https://code.claude.com/docs/en/effort",
  verifiedOn: "2026-10-05",
} as const satisfies ExternalAgentModelProvenance;

const CODEX_PROVENANCE = {
  source: "https://developers.openai.com/codex/models",
  effortSource: "https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/models-manager/models.json",
  verifiedOn: "2026-10-05",
  version: "0.160.0",
  release: "https://github.com/openai/codex/releases/tag/rust-v0.160.0",
  sourceBlob: "https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/models-manager/models.json",
} as const satisfies ExternalAgentModelProvenance;

const LOW_TO_XHIGH = ["low", "medium", "high", "xhigh"] as const;
const LOW_TO_MAX = [...LOW_TO_XHIGH, "max"] as const;
const LOW_TO_ULTRA = [...LOW_TO_MAX, "ultra"] as const;

/** Release-maintained CLI catalog; not discovery, execution, or an account-access check.
 * Provenance on each entry is shared with its catalog. Mutable aliases and CLI
 * default model selection deliberately do not appear as pinned capabilities.
 */
export const EXTERNAL_AGENT_MODEL_CATALOG = {
  "claude-cli": {
    ...CLAUDE_PROVENANCE,
    models: [
      { value: "claude-opus-5-5", label: "Opus 5.5 (claude-opus-5-5)", effortLevels: LOW_TO_MAX, defaultEffort: "medium", provenance: CLAUDE_PROVENANCE },
      { value: "claude-fable-5-1", label: "Fable 5.1 (claude-fable-5-1)", effortLevels: LOW_TO_MAX, defaultEffort: "high", provenance: CLAUDE_PROVENANCE },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5 (claude-sonnet-5-5)", effortLevels: LOW_TO_MAX, defaultEffort: "medium", provenance: CLAUDE_PROVENANCE },
      { value: "claude-haiku-4-5", label: "Haiku 4.5 (claude-haiku-4-5)", effortLevels: [], defaultEffort: undefined, provenance: CLAUDE_PROVENANCE },
    ],
  },
  "codex-cli": {
    ...CODEX_PROVENANCE,
    resolvedSource: "https://learn.chatgpt.com/docs/models",
    models: [
      { value: "gpt-6.1-sol", label: "GPT-6.1-Sol (gpt-6.1-sol)", effortLevels: LOW_TO_ULTRA, defaultEffort: "low", provenance: CODEX_PROVENANCE },
      { value: "gpt-6-astra", label: "GPT-6-Astra (gpt-6-astra)", effortLevels: LOW_TO_ULTRA, defaultEffort: "low", provenance: CODEX_PROVENANCE },
      { value: "gpt-6-sol", label: "GPT-6-Sol (gpt-6-sol)", effortLevels: LOW_TO_ULTRA, defaultEffort: "medium", provenance: CODEX_PROVENANCE },
      { value: "gpt-6-luna", label: "GPT-6-Luna (gpt-6-luna)", effortLevels: LOW_TO_MAX, defaultEffort: "medium", provenance: CODEX_PROVENANCE },
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol (gpt-5.6-sol)", effortLevels: LOW_TO_ULTRA, defaultEffort: "low", provenance: CODEX_PROVENANCE },
      { value: "gpt-5.6-terra", label: "GPT-5.6-Terra (gpt-5.6-terra)", effortLevels: LOW_TO_ULTRA, defaultEffort: "medium", provenance: CODEX_PROVENANCE },
      { value: "gpt-5.6-luna", label: "GPT-5.6-Luna (gpt-5.6-luna)", effortLevels: LOW_TO_MAX, defaultEffort: "medium", provenance: CODEX_PROVENANCE },
      { value: "gpt-5.5", label: "GPT-5.5 (gpt-5.5)", effortLevels: LOW_TO_XHIGH, defaultEffort: "medium", provenance: CODEX_PROVENANCE },
    ],
  },
} as const satisfies Record<string, ExternalAgentModelProvenance & { readonly models: readonly ExternalAgentModelCapability[] }>;

/** Catalog membership never implies availability: CLI/account/provider decide access. */
export type GuidedExternalAgentAdapter = keyof typeof EXTERNAL_AGENT_MODEL_CATALOG;

/** Exact IDs only, with the evidenced dated Haiku API ID as the sole equivalence. */
export function externalAgentModelCapability(adapter: GuidedExternalAgentAdapter, model: string): ExternalAgentModelCapability | undefined {
  const exactId = adapter === "claude-cli" && model === "claude-haiku-4-5-20251001" ? "claude-haiku-4-5" : model;
  return EXTERNAL_AGENT_MODEL_CATALOG[adapter].models.find((entry) => entry.value === exactId);
}
