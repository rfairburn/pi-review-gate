/** Release-maintained CLI catalog; not a discovery or account-access check. */
export const EXTERNAL_AGENT_MODEL_CATALOG = {
  "claude-cli": {
    source: "https://code.claude.com/docs/en/model-config",
    verifiedOn: "2026-10-04",
    models: [
      { value: "sonnet", label: "Sonnet (sonnet)" },
      { value: "opus", label: "Opus (opus)" },
      { value: "haiku", label: "Haiku (haiku)" },
      { value: "fable", label: "Fable (fable)" },
      { value: "best", label: "Best (best)" },
    ],
  },
  "codex-cli": {
    source: "https://developers.openai.com/codex/models",
    resolvedSource: "https://learn.chatgpt.com/docs/models",
    verifiedOn: "2026-10-04",
    models: [
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol (gpt-6.1-sol)" },
      { value: "gpt-6-astra", label: "GPT-6 Astra (gpt-6-astra)" },
      { value: "gpt-6-luna", label: "GPT-6 Luna (gpt-6-luna)" },
    ],
  },
} as const;

/** Catalog membership never implies availability: CLI/account/provider decide access. */
export type GuidedExternalAgentAdapter = keyof typeof EXTERNAL_AGENT_MODEL_CATALOG;
