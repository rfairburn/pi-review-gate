import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ReviewMode = "single-decider" | "quorum";
export type RetainBundles = "never" | "on-failure" | "always";

export interface GenericCliDeciderConfig {
  id: string;
  adapter: "generic-cli";
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface CodexCliDeciderConfig {
  id: string;
  adapter: "codex-cli";
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeCliDeciderConfig {
  id: string;
  adapter: "claude-cli";
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface LittleCoderDeciderConfig {
  id: string;
  adapter: "little-coder-model";
  model: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export type DeciderConfig = GenericCliDeciderConfig | CodexCliDeciderConfig | ClaudeCliDeciderConfig | LittleCoderDeciderConfig;

export interface ReviewGateConfig {
  enabled: boolean;
  mode: ReviewMode;
  maxCorrectionCycles: number;
  reviewWhen: "changed-files";
  maxPatchBytes: number;
  maxFileBytes: number;
  maxSnapshotBytes: number;
  retainBundles: RetainBundles;
  decider?: DeciderConfig;
  reviewers?: DeciderConfig[];
}

export interface LoadedConfig {
  config: ReviewGateConfig;
  path?: string;
  disabledReason?: string;
}

export const DEFAULT_CONFIG: ReviewGateConfig = {
  enabled: true,
  mode: "single-decider",
  maxCorrectionCycles: 1,
  reviewWhen: "changed-files",
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "on-failure",
};

const DEFAULT_REVIEWER_TIMEOUT_MS = 300_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const disabledVar = firstTruthyEnv(env, ["PI_REVIEW_GATE_DISABLED", "LITTLE_CODER_REVIEW_GATE_DISABLED"]);
  if (disabledVar) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      disabledReason: `${disabledVar} is set`,
    };
  }

  const path = findConfigPath(env);
  if (!path) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      disabledReason: "No review gate config file found",
    };
  }

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return {
    config: normalizeConfig(parsed),
    path,
  };
}

export function normalizeConfig(value: unknown): ReviewGateConfig {
  if (!isRecord(value)) {
    throw new Error("review gate config must be a JSON object");
  }

  const config: ReviewGateConfig = {
    ...DEFAULT_CONFIG,
    ...value,
    enabled: value.enabled === undefined ? DEFAULT_CONFIG.enabled : Boolean(value.enabled),
    mode: value.mode === "quorum" ? "quorum" : "single-decider",
    maxCorrectionCycles: numberOrDefault(value.maxCorrectionCycles, DEFAULT_CONFIG.maxCorrectionCycles),
    reviewWhen: "changed-files",
    maxPatchBytes: numberOrDefault(value.maxPatchBytes, DEFAULT_CONFIG.maxPatchBytes),
    maxFileBytes: numberOrDefault(value.maxFileBytes, DEFAULT_CONFIG.maxFileBytes),
    maxSnapshotBytes: numberOrDefault(value.maxSnapshotBytes, DEFAULT_CONFIG.maxSnapshotBytes),
    retainBundles: normalizeRetainBundles(value.retainBundles),
    decider: value.decider === undefined ? undefined : normalizeDecider(value.decider),
    reviewers: Array.isArray(value.reviewers) ? value.reviewers.map(normalizeDecider) : undefined,
  };

  if (config.reviewers) {
    validateUniqueReviewerIds(config.reviewers);
  }

  if (config.enabled && !config.decider && (!config.reviewers || config.reviewers.length === 0)) {
    throw new Error("enabled review gate config requires decider or reviewers");
  }

  return config;
}

function findConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PI_REVIEW_GATE_CONFIG) {
    return env.PI_REVIEW_GATE_CONFIG;
  }
  if (env.LITTLE_CODER_REVIEW_CONFIG) {
    return env.LITTLE_CODER_REVIEW_CONFIG;
  }

  const candidates = [
    join(homedir(), ".config", "pi-review-gate", "config.json"),
    join(homedir(), ".config", "pi", "review-gate.json"),
    join(homedir(), ".config", "little-coder", "review-gate.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeDecider(value: unknown): DeciderConfig {
  if (!isRecord(value)) {
    throw new Error("decider must be an object");
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error("decider requires id");
  }
  if (value.adapter === "generic-cli") {
    if (typeof value.command !== "string" || !value.command.trim()) {
      throw new Error("generic-cli decider requires command");
    }
    return {
      id: value.id,
      adapter: "generic-cli",
      command: value.command,
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      timeoutMs: numberOrDefault(value.timeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    };
  }
  if (value.adapter === "codex-cli") {
    return {
      id: value.id,
      adapter: "codex-cli",
      command: typeof value.command === "string" ? value.command : "codex",
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      model: typeof value.model === "string" ? value.model : undefined,
      timeoutMs: numberOrDefault(value.timeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    };
  }
  if (value.adapter === "claude-cli") {
    return {
      id: value.id,
      adapter: "claude-cli",
      command: typeof value.command === "string" ? value.command : "claude",
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      model: typeof value.model === "string" ? value.model : undefined,
      timeoutMs: numberOrDefault(value.timeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    };
  }
  if (value.adapter === "little-coder-model") {
    if (typeof value.model !== "string" || !value.model.trim()) {
      throw new Error("little-coder-model decider requires model");
    }
    return {
      id: value.id,
      adapter: "little-coder-model",
      model: value.model,
      command: typeof value.command === "string" ? value.command : "little-coder",
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      timeoutMs: numberOrDefault(value.timeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS),
    };
  }
  throw new Error("unsupported decider adapter");
}

function normalizeRetainBundles(value: unknown): RetainBundles {
  return value === "never" || value === "always" || value === "on-failure" ? value : DEFAULT_CONFIG.retainBundles;
}

function validateUniqueReviewerIds(reviewers: DeciderConfig[]): void {
  const seen = new Set<string>();
  for (const reviewer of reviewers) {
    if (seen.has(reviewer.id)) {
      throw new Error(`reviewer id must be unique: ${reviewer.id}`);
    }
    seen.add(reviewer.id);
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function firstTruthyEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  return names.find((name) => isTruthy(env[name]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
