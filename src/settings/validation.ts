/**
 * The save-time cross-domain validation for the staged settings selection
 * (reviewer duplicates, scoped Pi models, executor/route constraints,
 * executable availability), kept whole so the root save path and the
 * scheduled-task reviewer overrides resolve reviewers by one shared
 * contract.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";
import {
  MAX_EXECUTION_WORKERS,
  externalAgentCatalog,
  type ExternalAgentConfig,
  externalAgentSupportsExecution,
  externalAgentSupportsReview,
  executorSelectionKey,
  resolvedExternalAgent,
  workerResourceSupportsResearch,
  type ActiveReviewerSelection,
  type ReviewGateConfig,
  type WorkerResourceCatalog,
  type WorkerRouteEntry,
} from "../config";
import type { ScopedModelChoice } from "./models";
import { reviewerKey } from "./review";
import type { ToolProtectionConfig } from "../tool-protection/config";

/**
 * Save/apply-time result for the tool-protection block (#536).
 * `error` blocks the apply or Save; `warnings` are shown after it succeeds.
 */
export interface ToolProtectionValidation {
  error?: string;
  warnings: string[];
}

/**
 * The narrow tool-protection validation the staged transaction needs (#536).
 * Core owns the schema, so this only states core's two hard rules where the
 * user can still act on them, and reports an unavailable auditor as a warning
 * rather than an error: a selection that does not resolve today is saved as
 * the unresolved selection the user chose to keep, and the runtime says the
 * auditor is unavailable instead of reading the gate as Off or substituting
 * another resource. Nothing here turns protection Off, rewrites the selection,
 * or adds a second validity rule.
 */
export function validateToolProtectionSelection(
  staged: ToolProtectionConfig,
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
): ToolProtectionValidation {
  const warnings: string[] = [];
  if (staged.level !== "off" && staged.auditor === null) {
    return {
      error: `Tool protection level "${staged.level}" requires an auditor. Choose an auditor, or set the Protection level to Off to stop the added gate deliberately. Nothing was applied and protection was not silently turned Off.`,
      warnings,
    };
  }
  if (staged.scope === "selected" && staged.toolNames.length === 0) {
    return {
      error: "Audit scope \"Selected tool names\" requires at least one exact tool name, because an empty list would audit nothing. Name at least one tool exactly, or set the audit scope back to All calls. Nothing was applied.",
      warnings,
    };
  }
  if (staged.level !== "off" && staged.auditor !== null) {
    const auditor = staged.auditor;
    if (auditor.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === auditor.model);
      if (!choice) {
        warnings.push(`Tool protection auditor ${auditor.model} is not currently scoped. Its selection is retained; availability is checked against the host model registry when an audit runs.`);
      } else if (auditor.thinkingLevel && !choice.supportedThinkingLevels.includes(auditor.thinkingLevel)) {
        warnings.push(`Tool protection reasoning ${auditor.thinkingLevel} is unsupported for ${auditor.model}. Choose a supported reasoning level; the runner does not silently replace this selection.`);
      }
    } else {
      const agent = resolvedExternalAgent(config, auditor.id);
      if (!agent) {
        warnings.push(`Tool protection auditor ${auditor.id} is not a configured external worker, so it was kept as an unresolved selection at Protection level "${staged.level}". Protected calls stay blocked until you choose an available auditor.`);
      } else if (!agent.execution && !agent.review) {
        warnings.push(`Tool protection auditor ${agent.id} has no configured role, so an audited call would fail until it does.`);
      } else if (agent.adapter === "codex-cli") {
        warnings.push(`Tool protection auditor ${agent.id} uses the Codex CLI, whose decision-only no-tools route is unproven, so an audited call fails closed instead of running with tools.`);
      } else if (agent.adapter === "claude-cli") {
        // Mirrors the runner, which starts no process for a Claude auditor at
        // all until invocation-local API retry disabling is established.
        warnings.push(`Tool protection auditor ${agent.id} uses the Claude CLI, whose auditor route is unsupported: invocation-local API retry disabling has not been established, so every audited call is blocked and no process is started. The choice is kept as selected rather than switched to another worker.`);
      }
    }
  }
  if (staged.scope === "selected") {
    // The ordinary reduced-coverage statement: `selected` audits exactly the
    // configured exact names and nothing else.
    warnings.push(`Tool protection audits only these exact tool names: ${staged.toolNames.join(", ")}. Every other tool is NOT AUDITED, and an unaudited call is never a pass.`);
  }
  return { warnings };
}

export interface SettingsValidationPolicy {
  /** Settings Save only; runtime and other callers remain strict by default. */
  allowMissingApplicationCli?: boolean;
  warnings?: Set<string>;
}

function warnMissingApplication(agent: ExternalAgentConfig, policy: SettingsValidationPolicy): boolean {
  if (!policy.allowMissingApplicationCli || (agent.adapter !== "codex-cli" && agent.adapter !== "claude-cli")) return false;
  policy.warnings?.add(`External worker ${agent.id} cannot run until its ${agent.adapter === "codex-cli" ? "Codex" : "Claude"} binary is installed and available.`);
  return true;
}

async function applicationRoleAvailable(agent: ExternalAgentConfig, role: "execution" | "review"): Promise<boolean> {
  return applicationCommandAvailable(agent.command!, { ...process.env, ...agent.env, ...agent[role]?.env });
}

/** Warn for configured application CLIs even when not selected for a role. */
export async function collectExternalAgentAvailabilityWarnings(config: ReviewGateConfig, policy: SettingsValidationPolicy): Promise<void> {
  for (const agent of externalAgentCatalog(config)) {
    if (agent.adapter !== "codex-cli" && agent.adapter !== "claude-cli") continue;
    for (const role of ["execution", "review"] as const) {
      if (agent[role] && !await applicationRoleAvailable(agent, role)) {
        warnMissingApplication(agent, policy);
        break;
      }
    }
  }
}

export async function validateSelection(
  workerResources: WorkerResourceCatalog,
  reviewers: ActiveReviewerSelection[],
  config: ReviewGateConfig,
  scoped: ScopedModelChoice[],
  executeRoute: WorkerRouteEntry[] = [],
  researchRoute: WorkerRouteEntry[] = [],
  policy: SettingsValidationPolicy = {},
): Promise<string | undefined> {
  const duplicateReviewer = duplicate(reviewers.map(reviewerKey));
  if (duplicateReviewer) return `Duplicate enabled reviewer: ${duplicateReviewer}`;
  const scopedModels = new Set(scoped.map((choice) => choice.model));
  const duplicateExecutor = duplicate(Object.values(workerResources).map((entry) => executorSelectionKey(entry.selection)));
  if (duplicateExecutor) return `Duplicate executor pool selection: ${duplicateExecutor}`;
  for (const [kind, route] of [["Execution", executeRoute], ["Research", researchRoute]] as const) {
    const duplicateResource = duplicate(route.map((entry) => entry.resourceId));
    if (duplicateResource) return `${kind} priority contains duplicate resource: ${duplicateResource}`;
    for (const entry of route) {
      const resource = Object.prototype.hasOwnProperty.call(workerResources, entry.resourceId)
        ? workerResources[entry.resourceId]
        : undefined;
      if (!resource) return `${kind} priority references missing worker resource: ${entry.resourceId}`;
      if (kind === "Research" && !workerResourceSupportsResearch(config, resource.selection)) {
        return `Research priority resource is not research-capable: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source !== "pi") {
        return `${kind} priority cannot override thinking for external resource: ${entry.resourceId}`;
      }
      if (entry.thinkingLevel && resource.selection.source === "pi") {
        const selection = resource.selection;
        const model = scoped.find((candidate) => candidate.model === selection.model);
        if (!model?.supportedThinkingLevels.includes(entry.thinkingLevel)) {
          return `${kind} priority reasoning is unsupported for ${selection.model}: ${entry.thinkingLevel}`;
        }
      }
    }
  }
  for (const [resourceId, entry] of Object.entries(workerResources)) {
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1 || entry.maxConcurrent > MAX_EXECUTION_WORKERS) {
      return `Executor maximum concurrency must be between 1 and ${MAX_EXECUTION_WORKERS}: ${resourceId}`;
    }
    const selection = entry.selection;
    if (selection.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === selection.model);
      if (!choice) return `Pi executor model is not currently scoped: ${selection.model}`;
      if (selection.thinkingLevel && !choice.supportedThinkingLevels.includes(selection.thinkingLevel)) {
        return `Pi executor reasoning is unsupported for ${selection.model}: ${selection.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Executor executable is unavailable: pi";
      continue;
    }
    const agent = resolvedExternalAgent(config, selection.id);
    if (!agent || !externalAgentSupportsExecution(agent)) return `External executor is unavailable: ${selection.id}`;
    const available = policy.allowMissingApplicationCli && (agent.adapter === "codex-cli" || agent.adapter === "claude-cli")
      ? await applicationRoleAvailable(agent, "execution") : await commandAvailable(agent.command!);
    if (!available && !warnMissingApplication(agent, policy)) return `Executor executable is unavailable: ${agent.command}`;
  }
  for (const reviewer of reviewers) {
    if (reviewer.source === "pi") {
      const choice = scoped.find((candidate) => candidate.model === reviewer.model);
      if (!scopedModels.has(reviewer.model) || !choice) return `Pi reviewer model is not currently scoped: ${reviewer.model}`;
      if (reviewer.thinkingLevel && !choice.supportedThinkingLevels.includes(reviewer.thinkingLevel)) {
        return `Pi reviewer reasoning is unsupported for ${reviewer.model}: ${reviewer.thinkingLevel}`;
      }
      if (config.enabled && !await commandAvailable("pi")) return "Reviewer executable is unavailable: pi";
      continue;
    }
    const agent = resolvedExternalAgent(config, reviewer.id);
    if (!agent || !externalAgentSupportsReview(agent)) return `External reviewer is unavailable: ${reviewer.id}`;
    if (config.enabled) {
      const available = policy.allowMissingApplicationCli && (agent.adapter === "codex-cli" || agent.adapter === "claude-cli")
        ? await applicationRoleAvailable(agent, "review") : await commandAvailable(agent.command!);
      if (!available && !warnMissingApplication(agent, policy)) return `Reviewer executable is unavailable: ${agent.command} (${agent.id})`;
    }
  }
  return undefined;
}

/** Application-only availability probe; platform/environment injection keeps tests hermetic. */
export async function applicationCommandAvailable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const windows = platform === "win32";
  // Match Node's first case-insensitive environment key on Windows when
  // shared/role overrides produce a plain object (rather than process.env).
  const environmentValue = (name: string): string | undefined => {
    if (!windows) return environment[name];
    const key = Object.keys(environment).sort().find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : environment[key];
  };
  const suffixes = windows && !extname(command)
    ? ["", ...(environmentValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => /^\.[a-z0-9]+$/i.test(suffix)).map((suffix) => suffix.toLowerCase())]
    : [""];
  const explicitPath = isAbsolute(command) || (windows && win32.isAbsolute(command)) || command.includes("/") || (windows && command.includes("\\"));
  const locations = explicitPath ? [command] : (environmentValue("PATH") ?? "").split(windows ? ";" : delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const location of locations) {
    for (const suffix of suffixes) {
      const candidate = location + suffix;
      if (await stat(candidate).then((entry) => entry.isFile(), () => false)
        && await access(candidate, constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

async function commandAvailable(command: string): Promise<boolean> {
  if (isAbsolute(command) || command.includes("/")) {
    return access(command, constants.X_OK).then(() => true, () => false);
  }
  for (const path of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await access(join(path, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => seen.has(value) || !seen.add(value));
}
