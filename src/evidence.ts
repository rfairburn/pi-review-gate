import { isAbsolute, resolve } from "node:path";
import {
  compareFileSnapshots,
  createPathSnapshot,
  type ChangedFile,
  type FileSnapshot,
  type SnapshotOptions,
} from "./capture";

export interface EvidenceState {
  nextSequence: number;
  events: EvidenceEvent[];
  candidates: Map<string, EvidenceCandidate>;
  finalAssistantSummary?: string;
}

export interface EvidenceEvent {
  sequence: number;
  phase: "tool_call" | "tool_result";
  toolName: string;
  summary: string;
  candidatePaths: string[];
  riskSignals: string[];
  isError?: boolean;
}

export interface EvidenceCandidate {
  path: string;
  absolutePath: string;
  sources: string[];
  baseline?: FileSnapshot;
  baselineError?: string;
}

export interface EvidenceBundle {
  events: EvidenceEvent[];
  candidates: Array<{
    path: string;
    absolutePath: string;
    sources: string[];
    baseline: "captured" | "missing" | "error";
  }>;
  finalAssistantSummary?: string;
  changedCandidatePaths: string[];
  markdown: string;
}

export function createEvidenceState(): EvidenceState {
  return {
    nextSequence: 1,
    events: [],
    candidates: new Map(),
  };
}

export async function recordToolCallEvidence(input: {
  state: EvidenceState;
  cwd: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  snapshotOptions: SnapshotOptions;
}): Promise<void> {
  const extracted = extractCandidatePaths(input.toolName, input.toolInput);
  const candidatePaths: string[] = [];

  for (const candidate of extracted.paths) {
    candidatePaths.push(candidate.path);
    await addCandidate(input.state, input.cwd, candidate.path, candidate.source, input.snapshotOptions);
  }

  input.state.events.push({
    sequence: input.state.nextSequence++,
    phase: "tool_call",
    toolName: input.toolName || "unknown",
    summary: summarizeToolInput(input.toolInput),
    candidatePaths: unique(candidatePaths),
    riskSignals: extracted.riskSignals,
  });
}

export function recordToolResultEvidence(input: {
  state: EvidenceState;
  toolName: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}): void {
  const extracted = extractCandidatePaths(input.toolName, input.toolInput);
  input.state.events.push({
    sequence: input.state.nextSequence++,
    phase: "tool_result",
    toolName: input.toolName || "unknown",
    summary: summarizeToolResult(input.result, input.isError),
    candidatePaths: unique(extracted.paths.map((candidate) => candidate.path)),
    riskSignals: input.isError ? ["tool_result_error"] : [],
    isError: input.isError,
  });
}

export async function collectEvidenceChanges(
  state: EvidenceState,
  cwd: string,
  snapshotOptions: SnapshotOptions,
): Promise<ChangedFile[]> {
  const changes: ChangedFile[] = [];
  for (const candidate of state.candidates.values()) {
    if (!candidate.baseline) {
      continue;
    }
    const after = await createPathSnapshot(cwd, candidate.absolutePath, snapshotOptions).catch(() => undefined);
    if (!after) {
      continue;
    }
    const change = compareFileSnapshots(candidate.baseline, after);
    if (change) {
      changes.push(change);
    }
  }
  return changes;
}

export function buildEvidenceBundle(state: EvidenceState, changedCandidatePaths: string[]): EvidenceBundle {
  const candidates = [...state.candidates.values()].map((candidate) => ({
    path: candidate.path,
    absolutePath: candidate.absolutePath,
    sources: candidate.sources,
    baseline: candidate.baselineError
      ? "error" as const
      : candidate.baseline?.exists
        ? "captured" as const
        : "missing" as const,
  }));

  const bundle: Omit<EvidenceBundle, "markdown"> = {
    events: state.events,
    candidates,
    finalAssistantSummary: state.finalAssistantSummary,
    changedCandidatePaths,
  };

  return {
    ...bundle,
    markdown: renderEvidenceMarkdown(bundle),
  };
}

export function rememberFinalAssistantSummary(state: EvidenceState, args: unknown[]): void {
  const summary = extractFinalAssistantText(args);
  if (summary) {
    state.finalAssistantSummary = truncate(summary, 4000);
  }
}

export function extractCandidatePaths(
  toolName: string,
  input?: Record<string, unknown>,
): { paths: Array<{ path: string; source: string }>; riskSignals: string[] } {
  const paths: Array<{ path: string; source: string }> = [];
  const riskSignals: string[] = [];
  if (!input) {
    return { paths, riskSignals };
  }

  for (const key of ["path", "file_path", "filePath", "target", "dest", "destination"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      paths.push({ path: value.trim(), source: `${toolName}:${key}` });
    }
  }

  for (const key of ["paths", "files"]) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          paths.push({ path: item.trim(), source: `${toolName}:${key}` });
        }
      }
    }
  }

  const command = commandText(input);
  if (command) {
    const shellPaths = extractShellCandidatePaths(command);
    paths.push(...shellPaths.paths.map((path) => ({ path, source: `${toolName}:command` })));
    riskSignals.push(...shellPaths.riskSignals);
  }

  return {
    paths: dedupePathSources(paths),
    riskSignals: unique(riskSignals),
  };
}

async function addCandidate(
  state: EvidenceState,
  cwd: string,
  path: string,
  source: string,
  snapshotOptions: SnapshotOptions,
): Promise<void> {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const key = absolutePath;
  const existing = state.candidates.get(key);
  if (existing) {
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    return;
  }

  const candidate: EvidenceCandidate = {
    path,
    absolutePath,
    sources: [source],
  };
  try {
    candidate.baseline = await createPathSnapshot(cwd, absolutePath, snapshotOptions);
  } catch (error) {
    candidate.baselineError = error instanceof Error ? error.message : "snapshot_failed";
  }
  state.candidates.set(key, candidate);
}

function extractShellCandidatePaths(command: string): { paths: string[]; riskSignals: string[] } {
  const paths: string[] = [];
  const riskSignals: string[] = [];

  const redirectionPattern = /(?:^|[\s;])(?:[0-9]?>|>>|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/g;
  for (const match of command.matchAll(redirectionPattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path) {
      paths.push(path);
      riskSignals.push("shell_redirection");
    }
  }

  const appendHerePattern = /(?:^|[\s;])tee\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s|;&<>]+))/g;
  for (const match of command.matchAll(appendHerePattern)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path && !path.startsWith("-")) {
      paths.push(path);
      riskSignals.push("tee_write");
    }
  }

  for (const tool of ["touch", "rm", "mkdir"]) {
    const pattern = new RegExp(`(?:^|[\\s;])${tool}\\s+(?:-[a-zA-Z]+\\s+)*(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))`, "g");
    for (const match of command.matchAll(pattern)) {
      const path = match[1] ?? match[2] ?? match[3];
      if (path) {
        paths.push(path);
        riskSignals.push(`shell_${tool}`);
      }
    }
  }

  for (const tool of ["cp", "mv"]) {
    const pattern = new RegExp(`(?:^|[\\s;])${tool}\\s+(?:-[a-zA-Z]+\\s+)*(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))\\s+(?:"([^"]+)"|'([^']+)'|([^\\s|;&<>]+))`, "g");
    for (const match of command.matchAll(pattern)) {
      const source = match[1] ?? match[2] ?? match[3];
      const dest = match[4] ?? match[5] ?? match[6];
      if (source) {
        paths.push(source);
      }
      if (dest) {
        paths.push(dest);
      }
      riskSignals.push(`shell_${tool}`);
    }
  }

  if (/\b(?:sed|perl)\b[^|;&]*\s-(?:[a-zA-Z]*i|[a-zA-Z]*p[a-zA-Z]*i)\b/.test(command)) {
    riskSignals.push("in_place_shell_edit");
  }
  if (/<<\s*['"]?[A-Za-z0-9_.-]+['"]?/.test(command)) {
    riskSignals.push("heredoc");
  }

  return {
    paths: unique(paths.filter(isUsefulPathToken)),
    riskSignals: unique(riskSignals),
  };
}

function commandText(input: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "script", "chars"]) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function summarizeToolInput(input?: Record<string, unknown>): string {
  if (!input) {
    return "(no input captured)";
  }
  const command = commandText(input);
  if (command) {
    return truncate(command.replace(/\s+/g, " ").trim(), 1000);
  }
  const compact = JSON.stringify(redactLargeValues(input));
  return truncate(compact, 1000);
}

function summarizeToolResult(result: unknown, isError: boolean | undefined): string {
  const prefix = isError ? "error: " : "";
  if (typeof result === "string") {
    return prefix + truncate(result.replace(/\s+/g, " ").trim(), 1000);
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      if (text) {
        return prefix + truncate(text.replace(/\s+/g, " ").trim(), 1000);
      }
    }
  }
  return prefix + truncate(JSON.stringify(redactLargeValues(result)), 1000);
}

function renderEvidenceMarkdown(bundle: Omit<EvidenceBundle, "markdown">): string {
  const lines: string[] = ["## Session Evidence", ""];

  if (bundle.finalAssistantSummary) {
    lines.push("### Agent final summary", "", bundle.finalAssistantSummary, "");
  }

  if (bundle.candidates.length > 0) {
    lines.push("### Pre-captured candidate files");
    for (const candidate of bundle.candidates.slice(0, 50)) {
      lines.push(`- ${candidate.path} (${candidate.baseline}; ${candidate.sources.join(", ")})`);
    }
    if (bundle.candidates.length > 50) {
      lines.push(`- ... ${bundle.candidates.length - 50} more candidates omitted`);
    }
    lines.push("");
  }

  if (bundle.changedCandidatePaths.length > 0) {
    lines.push("### Evidence candidates changed");
    for (const path of bundle.changedCandidatePaths.slice(0, 50)) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  if (bundle.events.length > 0) {
    lines.push("### Tool event digest");
    for (const event of bundle.events.slice(-80)) {
      const risks = event.riskSignals.length > 0 ? ` risks=${event.riskSignals.join(",")}` : "";
      const paths = event.candidatePaths.length > 0 ? ` paths=${event.candidatePaths.join(",")}` : "";
      lines.push(`- #${event.sequence} ${event.phase} ${event.toolName}${event.isError ? " ERROR" : ""}${paths}${risks}: ${event.summary}`);
    }
    if (bundle.events.length > 80) {
      lines.push(`- ... ${bundle.events.length - 80} earlier events omitted`);
    }
  }

  return lines.join("\n");
}

function extractFinalAssistantText(args: unknown[]): string {
  for (const arg of args) {
    if (!isRecord(arg) || !Array.isArray(arg.messages)) {
      continue;
    }
    for (const message of [...arg.messages].reverse()) {
      if (!isRecord(message) || message.role !== "assistant") {
        continue;
      }
      const text = textFromContent(message.content);
      if (text.trim()) {
        return text.trim();
      }
    }
  }
  return "";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function redactLargeValues(value: unknown): unknown {
  if (typeof value === "string") {
    return truncate(value, 500);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(redactLargeValues);
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      result[key] = redactLargeValues(item);
    }
    return result;
  }
  return value;
}

function isUsefulPathToken(path: string): boolean {
  if (!path || path === "-" || path.startsWith("$")) {
    return false;
  }
  return !/^[0-9]+$/.test(path);
}

function dedupePathSources(paths: Array<{ path: string; source: string }>): Array<{ path: string; source: string }> {
  const seen = new Set<string>();
  const result: Array<{ path: string; source: string }> = [];
  for (const item of paths) {
    const key = `${item.source}\0${item.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[... truncated ...]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
