/// ApplyPatch tool registration and argument parsing.
///
/// The advertised contract is the canonical OpenAI/Codex apply_patch envelope
/// carried in a single `patch` string (Pi's JSON tool transport carries one
/// argument value, so the whole multi-file envelope travels as that string —
/// the minimal transport difference from Codex's stdin/heredoc delivery). The
/// legacy single-file structured `operation` object remains accepted for
/// compatibility but is deliberately not part of the model-facing guidance.
/// Execution is delegated to the sequential request engine (request.ts),
/// which applies file operations in envelope order, stops at the first
/// failure, retains earlier successes, and reports applied / failed /
/// not-attempted operations plus any uncertain effects of the failed one.

import { isAbsolute } from "node:path";
import { parseApplyPatchEnvelope, type ApplyPatchFileOp } from "./envelope";
import { normalizeApplyPatchPath, normalizeApplyPatchPathMarker } from "./paths";
import { performApplyPatchRequest, type AppliedOperation, type ApplyPatchFailure, type ApplyPatchOperationType } from "./request";

export const APPLY_PATCH_TOOL_NAME = "ApplyPatch";

export type { AppliedOperation, ApplyPatchFailure, ApplyPatchOperationType };
export { normalizeApplyPatchPathMarker };

// ---------------------------------------------------------------------------
// Legacy structured operation (compatibility)
// ---------------------------------------------------------------------------

export interface ApplyPatchCreateOperation {
  type: "create_file";
  path: string;
  diff: string;
}

export interface ApplyPatchUpdateOperation {
  type: "update_file";
  path: string;
  diff: string;
  moveTo?: string;
}

export interface ApplyPatchDeleteOperation {
  type: "delete_file";
  path: string;
}

export type ParsedApplyPatchOperation = ApplyPatchCreateOperation | ApplyPatchUpdateOperation | ApplyPatchDeleteOperation;

const OPERATION_TYPES: readonly ApplyPatchOperationType[] = ["create_file", "update_file", "delete_file"];

/**
 * File-level V4A header lines. The engine treats them as section terminators,
 * so a body that still carries one would silently apply zero or partial
 * chunks; they are rejected up front with an informative diagnostic.
 */
const FORBIDDEN_DIFF_HEADERS = /^\*\*\* (Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/;

function rejectDiffHeaders(diff: string): void {
  for (const line of diff.split(/\r?\n/)) {
    if (FORBIDDEN_DIFF_HEADERS.test(line)) {
      throw new Error(
        `operation.diff must be headerless; remove the line "${line.trim()}" — the operation type and paths are structured fields`,
      );
    }
  }
}

/**
 * Validates the strict legacy structured `operation` argument. Kept for
 * compatibility with earlier sessions; the canonical `patch` envelope is the
 * preferred contract. Paths are normalized (a single leading `@` convention
 * marker is stripped) but not yet confined to the workspace; confinement
 * happens during request preflight.
 */
export function parseApplyPatchOperation(params: unknown): ParsedApplyPatchOperation {
  if (!isRecord(params)) throw new Error("request must be an object with an operation argument");
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== "operation") {
    throw new Error(`ApplyPatch takes exactly one argument, operation; got ${keys.length === 0 ? "none" : keys.join(", ")}`);
  }
  const operation = params.operation;
  if (!isRecord(operation)) throw new Error("operation must be an object");

  const type = operation.type;
  if (typeof type !== "string" || !OPERATION_TYPES.includes(type as ApplyPatchOperationType)) {
    throw new Error(`operation.type must be one of ${OPERATION_TYPES.join(", ")}`);
  }
  const operationType = type as ApplyPatchOperationType;

  const allowedKeys = operationType === "delete_file"
    ? new Set(["type", "path"])
    : new Set(["type", "path", "diff", ...(operationType === "update_file" ? ["moveTo"] : [])]);
  for (const key of Object.keys(operation)) {
    if (!allowedKeys.has(key)) throw new Error(`operation.${key} is not valid for operation type ${operationType}`);
  }

  const path = normalizeApplyPatchPath(operation.path, "operation.path");
  if (operationType === "delete_file") {
    return { type: operationType, path };
  }

  const diff = operation.diff;
  if (typeof diff !== "string" || !diff.trim()) {
    throw new Error(`operation.diff is required for ${operationType} and must be a non-empty headerless V4A diff body`);
  }
  rejectDiffHeaders(diff);
  if (operationType === "create_file") {
    return { type: operationType, path, diff };
  }

  const moveToRaw = operation.moveTo;
  if (moveToRaw === undefined) return { type: operationType, path, diff };
  const moveTo = normalizeApplyPatchPath(moveToRaw, "operation.moveTo");
  if (moveTo === path) throw new Error("operation.moveTo must differ from operation.path");
  return { type: operationType, path, diff, moveTo };
}

// ---------------------------------------------------------------------------
// Request parsing (canonical envelope preferred, legacy operation accepted)
// ---------------------------------------------------------------------------

export interface ParsedApplyPatchRequest {
  operations: ApplyPatchFileOp[];
  /** Raw canonical envelope text (legacy structured requests carry none). */
  patch?: string;
}

/**
 * Validates the tool arguments and returns the ordered file operations of the
 * request. Exactly one of `patch` (canonical multi-file envelope) or
 * `operation` (legacy single-file object) may be present.
 */
export function parseApplyPatchRequest(params: unknown): ParsedApplyPatchRequest {
  if (!isRecord(params)) throw new Error("request must be an object with a patch or operation argument");
  const keys = Object.keys(params);
  const hasPatch = keys.includes("patch");
  const hasOperation = keys.includes("operation");
  if (hasPatch === hasOperation) {
    throw new Error(
      `ApplyPatch takes exactly one argument, either the canonical patch envelope or the legacy operation object; got ${keys.length === 0 ? "none" : keys.join(", ")}`,
    );
  }
  if (hasOperation) {
    const operation = parseApplyPatchOperation(params);
    return { operations: [legacyOperationToFileOp(operation)] };
  }
  const operations = parseApplyPatchEnvelope(params.patch);
  if (operations.length === 0) {
    throw new Error("patch contains no file operations; every ApplyPatch request must modify at least one file");
  }
  return { operations, patch: typeof params.patch === "string" ? params.patch : undefined };
}

function legacyOperationToFileOp(operation: ParsedApplyPatchOperation): ApplyPatchFileOp {
  if (operation.type === "delete_file") return { type: "delete_file", path: operation.path };
  if (operation.type === "create_file") return { type: "create_file", path: operation.path, diff: operation.diff };
  return { type: "update_file", path: operation.path, diff: operation.diff, ...(operation.moveTo ? { moveTo: operation.moveTo } : {}) };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function applyPatchToolSchema(): Record<string, unknown> {
  const path = {
    type: "string",
    minLength: 1,
    description: "File path relative to the current workspace. A leading '@' is tolerated and stripped.",
  };
  const diff = {
    type: "string",
    minLength: 1,
    description:
      "Headerless V4A diff body (no *** Begin/Update/Add/Delete markers, no path header). For update_file: '@@' anchor lines plus ' ' context, '-' removal, and '+' addition lines; '*** End of File' anchors a section at end-of-file. For create_file: every line must start with '+'; a final '+' line yields a trailing newline.",
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      patch: {
        type: "string",
        minLength: 1,
        description:
          "Canonical OpenAI/Codex apply_patch envelope: '*** Begin Patch', then one or more file operations — " +
          "'*** Add File: <path>' (each following line starts with '+'), " +
          "'*** Update File: <path>' with an optional '*** Move to: <path>' rename followed by '@@ [anchor]' hunks of ' ' context, '-' removal, and '+' addition lines (optionally ending a chunk with '*** End of File'), or " +
          "'*** Delete File: <path>' — then '*** End Patch'. " +
          "A single request may mix operations across multiple files. Operations are applied sequentially in order and the request stops at the first failure: earlier operations remain applied, later ones are not attempted, and the error reports which operations applied, failed, and were skipped.",
      },
      operation: {
        description:
          "Legacy single-file structured operation, kept for compatibility with earlier sessions. Prefer the canonical patch envelope.",
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path", "diff"],
            properties: {
              type: { type: "string", enum: ["create_file"], description: "Create a new file from the diff body." },
              path,
              diff,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path", "diff"],
            properties: {
              type: { type: "string", enum: ["update_file"], description: "Patch an existing file; optionally rename it via moveTo." },
              path,
              diff,
              moveTo: {
                type: "string",
                minLength: 1,
                description:
                  "Optional new workspace-relative path. The patched content is committed at the destination before the source is removed, so a failed move leaves the source unchanged; the destination must not already exist.",
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "path"],
            properties: {
              type: { type: "string", enum: ["delete_file"], description: "Delete an existing file." },
              path,
            },
          },
        ],
      },
    },
    oneOf: [
      { type: "object", required: ["patch"] },
      { type: "object", required: ["operation"] },
    ],
  };
}

export interface ApplyPatchToolOptions {
  cwd?: () => string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type ApplyPatchThemeColor =
  | "accent"
  | "error"
  | "muted"
  | "success"
  | "toolDiffAdded"
  | "toolDiffContext"
  | "toolDiffRemoved"
  | "toolTitle";

export interface ApplyPatchRendererTheme {
  bold(text: string): string;
  fg(color: ApplyPatchThemeColor, text: string): string;
}

export function renderApplyPatchCall(args: unknown, theme: ApplyPatchRendererTheme): unknown {
  if (isRecord(args) && typeof args.patch === "string") {
    const suffix = ` · ${summarizeEnvelopeForCall(args.patch)}`;
    return textComponent((width) => [
      clip(theme.fg("toolTitle", theme.bold(APPLY_PATCH_TOOL_NAME)) + theme.fg("accent", suffix), width),
    ]);
  }
  const operation = isRecord(args) && isRecord(args.operation) ? args.operation : undefined;
  const type = typeof operation?.type === "string" ? operation.type : "operation";
  const path = typeof operation?.path === "string" ? operation.path : "";
  const moveTo = typeof operation?.moveTo === "string" ? ` → ${operation.moveTo}` : "";
  const suffix = path ? ` · ${type} · ${path}${moveTo}` : ` · ${type}`;
  return textComponent((width) => [
    clip(theme.fg("toolTitle", theme.bold(APPLY_PATCH_TOOL_NAME)) + theme.fg("accent", suffix), width),
  ]);
}

/** Compact header scan for the call renderer: counts and first few paths. */
function summarizeEnvelopeForCall(patch: string): string {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("*** Add File: ") || t.startsWith("*** Update File: ") || t.startsWith("*** Delete File: ")) {
      const p = t.slice(t.indexOf(": ") + 2).trim();
      if (p) paths.push(p);
    }
  }
  if (paths.length === 0) return "patch";
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? `, … +${paths.length - 3} more` : "";
  return `${paths.length} file operation(s) · ${shown}${more}`;
}

const MAX_RENDERED_FINAL_DIFF_LINES = 16;
const MAX_RENDERED_REQUESTED_DIFF_LINES = 8;

export function renderApplyPatchResult(value: unknown, _options: unknown, theme: ApplyPatchRendererTheme): unknown {
  const isError = isRecord(value) && value.isError === true;
  const summary = isRecord(value) && Array.isArray(value.content) && isRecord(value.content[0]) && typeof value.content[0].text === "string"
    ? value.content[0].text
    : "No ApplyPatch result.";
  const details = isRecord(value) && isRecord(value.details) ? value.details : undefined;
  const requestedDiff = details && typeof details.requestedDiff === "string" ? details.requestedDiff : "";
  const finalDiff = details && typeof details.finalDiff === "string" ? details.finalDiff : "";
  return textComponent((width) => {
    const lines = [clip(theme.fg(isError ? "error" : "success", summary), width)];
    if (!isError) {
      // The final diff shows what actually landed (including rename from/to
      // for moves and the full deletion for deletes); the requested diff is
      // the shorter V4A body or envelope the model sent.
      lines.push(...renderDiffBlock(finalDiff, MAX_RENDERED_FINAL_DIFF_LINES, "Final diff:", width, theme));
      lines.push(...renderDiffBlock(requestedDiff, MAX_RENDERED_REQUESTED_DIFF_LINES, "Requested diff:", width, theme));
    }
    return lines;
  });
}

function renderDiffBlock(diff: string, maxLines: number, label: string, width: number, theme: ApplyPatchRendererTheme): string[] {
  const diffLines = diff.split("\n").filter((line) => line.length > 0);
  if (diffLines.length === 0) return [];
  const lines = [clip(theme.fg("muted", theme.bold(label)), width)];
  const shown = diffLines.slice(0, maxLines);
  for (const line of shown) {
    const color = line.startsWith("+")
      ? "toolDiffAdded"
      : line.startsWith("-")
        ? "toolDiffRemoved"
        : "toolDiffContext";
    lines.push(clip(theme.fg(color, line), width));
  }
  if (diffLines.length > shown.length) {
    lines.push(clip(theme.fg("muted", `… ${diffLines.length - shown.length} more diff line(s)`), width));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Registration and execution
// ---------------------------------------------------------------------------

export interface ApplyPatchHost {
  registerTool(tool: Record<string, unknown>): unknown;
}

/**
 * Registers the model-visible ApplyPatch tool. Active-by-default under Pi's
 * normal registered-tool policy; never force-enabled through setActiveTools,
 * so an explicit Pi launch `--tools` allowlist remains authoritative.
 */
export function registerApplyPatchTool(pi: unknown, options: ApplyPatchToolOptions = {}): boolean {
  if (!isRecord(pi) || typeof pi.registerTool !== "function") return false;
  pi.registerTool({
    name: APPLY_PATCH_TOOL_NAME,
    label: APPLY_PATCH_TOOL_NAME,
    description:
      "Apply a canonical OpenAI/Codex apply_patch envelope to the current workspace. One request carries '*** Begin Patch' ... '*** End Patch' and may mix " +
      "'*** Add File:' (plus-prefixed lines), '*** Update File:' (with optional '*** Move to:' rename and '@@ [anchor]' hunks of ' '/'-'/'+' lines, optionally anchored with '*** End of File'), " +
      "and '*** Delete File:' operations across multiple files; disjoint hunks per file are supported. The complete envelope is parsed before any mutation, then operations are applied sequentially in order and the request stops at the first failure: earlier operations remain applied, later ones are not attempted, and the error reports which operations applied, failed, and were skipped (including any uncertain effects of the failed operation). A legacy single-file structured 'operation' argument remains accepted for compatibility; prefer the patch envelope.",
    promptSnippet:
      "Use ApplyPatch with the canonical apply_patch envelope ('*** Begin Patch' ... '*** End Patch') for precise multi-file create/update/rename/delete mutations; the whole envelope is parsed before mutation, operations are applied sequentially and stop at the first failure (earlier successes stay applied), and every path is confined to the current workspace.",
    promptGuidelines: [
      "Send one canonical patch envelope per ApplyPatch call: '*** Begin Patch', then '*** Add File: <path>' (+ lines), '*** Update File: <path>' (optional '*** Move to: <path>', '@@ [anchor]' hunks, optional '*** End of File'), or '*** Delete File: <path>', then '*** End Patch'. Mix operations for multiple files in one envelope; disjoint hunks per file are supported.",
      "ApplyPatch applies operations sequentially in envelope order and stops at the first failure: earlier operations stay applied, later ones are skipped, and the error lists the applied, failed, and not-attempted operations. Fix the diagnostic and resubmit only the remaining operations rather than working around a failed patch with shell commands.",
      "Paths are workspace-relative (a leading '@' is stripped). The legacy single-file 'operation' argument is still accepted but the patch envelope is the preferred contract.",
    ],
    executionMode: "sequential",
    parameters: applyPatchToolSchema(),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) =>
      executeApplyPatch(params, signal, ctx, options),
    renderCall: (args: unknown, theme: ApplyPatchRendererTheme) => renderApplyPatchCall(args, theme),
    renderResult: (value: unknown, renderOptions: unknown, theme: ApplyPatchRendererTheme) =>
      renderApplyPatchResult(value, renderOptions, theme),
  });
  return true;
}

/**
 * Tool entry point. Per Pi's extension contract, failures throw so Pi marks
 * the tool result as an error and the model can recover from the diagnostic.
 * Like Pi's built-in edit/write tools, foreground patches do not wait for
 * background landing leases or conflict gates. A partial failure throws with
 * an explicit applied / failed / not-attempted report so review evidence and
 * the model both see which earlier operations remain applied.
 */
async function executeApplyPatch(
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: unknown,
  options: ApplyPatchToolOptions,
): Promise<Record<string, unknown>> {
  const request = parseApplyPatchRequest(params);
  const cwd = resolveToolCwd(options, ctx);
  // The landing gate blocks automatic integration, not foreground recovery.
  // Match built-in edit/write: callers must be able to resolve gated conflicts.
  const result = await performApplyPatchRequest(cwd, request.operations, signal);
  const { applied, failed, notAttempted } = result;
  if (failed !== undefined) {
    throw new Error(failureMessage(applied, failed, notAttempted));
  }
  const requestedDiff = clipText(request.patch ?? request.operations[0]!.diff ?? "", MAX_REQUESTED_DIFF_CHARS);
  // Canonical envelope calls get the upstream Codex print_summary text; legacy
  // structured calls keep the familiar per-operation summaries.
  const summary = request.patch !== undefined ? canonicalSuccessSummary(applied) : requestSummary(applied);
  const details: Record<string, unknown> = {
    operations: applied.map(outcomeDetails),
    requestedDiff,
    ...(result.finalDiff !== undefined ? { finalDiff: result.finalDiff } : {}),
    mutated: applied.some((outcome) => outcome.mutated),
  };
  if (applied.length === 1) {
    // Single-operation requests keep the familiar flat details shape.
    Object.assign(details, outcomeDetails(applied[0]!), { requestedDiff });
  }
  return textResult(summary, details);
}

/**
 * Model-facing success text for canonical envelope calls, following the
 * upstream Codex print_summary format: "Success. Updated the following
 * files:" followed by git-style A/M/D lines grouped by status (application
 * order within a group), using the patch's path spelling. A moved file is
 * reported under its source path, exactly like upstream. Pi's structured
 * details remain additive.
 */
function canonicalSuccessSummary(applied: AppliedOperation[]): string {
  const markFor = (operation: ApplyPatchOperationType): "A" | "M" | "D" =>
    operation === "create_file" ? "A" : operation === "delete_file" ? "D" : "M";
  const lines = ["Success. Updated the following files:"];
  for (const mark of ["A", "M", "D"] as const) {
    for (const outcome of applied) {
      if (markFor(outcome.operation) === mark) lines.push(`${mark} ${outcome.path}`);
    }
  }
  return lines.join("\n");
}

const MAX_REQUESTED_DIFF_CHARS = 4_000;

/**
 * Builds the explicit partial-failure diagnostic. The message names every
 * applied operation, the failed one with its error and uncertain effects, and
 * every operation that was not attempted, so review capture and the model see
 * the accumulated delta even though the call itself is an error.
 */
function failureMessage(applied: AppliedOperation[], failed: ApplyPatchFailure, notAttempted: string[]): string {
  const parts = [
    `ApplyPatch failed at operation ${failed.index + 1} (${displayOf(failed)}) with ${applied.length} earlier operation(s) still applied.`,
  ];
  if (applied.length > 0) {
    parts.push(`Applied: ${applied.map(summaryClause).join("; ")}.`);
  } else {
    parts.push("No earlier operations were applied.");
  }
  parts.push(`Failed: ${failed.error}`);
  if (failed.uncertainEffects.length > 0) {
    parts.push(`Uncertain effects of the failed operation: ${failed.uncertainEffects.join("; ")}.`);
  }
  if (notAttempted.length > 0) {
    parts.push(`Not attempted: ${notAttempted.join(", ")}.`);
  }
  return parts.join(" ");
}

function displayOf(failed: ApplyPatchFailure): string {
  const label = `${failed.operation} ${failed.path}`;
  return failed.moveTo !== undefined ? `${label} (moveTo ${failed.moveTo})` : label;
}

/** Familiar per-operation summaries, kept for legacy structured calls. */
function requestSummary(outcomes: AppliedOperation[]): string {
  if (outcomes.length === 1) return successSummary(outcomes[0]!);
  return `ApplyPatch applied ${outcomes.length} file operation(s): ${outcomes.map(summaryClause).join("; ")}.`;
}

function successSummary(outcome: AppliedOperation): string {
  return `ApplyPatch ${summaryClause(outcome)}.`;
}

function summaryClause(outcome: AppliedOperation): string {
  switch (outcome.operation) {
    case "create_file":
      return `created ${outcome.path} (${outcome.bytes} bytes)`;
    case "delete_file":
      return `deleted ${outcome.path}`;
    case "update_file": {
      const moved = outcome.moveTo ? ` and moved it to ${outcome.moveTo}` : "";
      if (!outcome.changed) return `updated ${outcome.path}${moved} with no content change`;
      return `updated ${outcome.path}${moved} (+${outcome.addedLines} −${outcome.removedLines} lines)`;
    }
  }
}

function outcomeDetails(outcome: AppliedOperation): Record<string, unknown> {
  return {
    operation: outcome.operation,
    path: outcome.path,
    ...(outcome.moveTo ? { moveTo: outcome.moveTo } : {}),
    absolutePath: outcome.absolutePath,
    changed: outcome.changed,
    addedLines: outcome.addedLines,
    removedLines: outcome.removedLines,
    bytes: outcome.bytes,
    requestedDiff: outcome.requestedDiff,
    ...(outcome.finalDiff !== undefined ? { finalDiff: outcome.finalDiff } : {}),
    mutated: outcome.mutated,
  };
}

function resolveToolCwd(options: ApplyPatchToolOptions, ctx: unknown): string {
  const provided = options.cwd?.();
  if (typeof provided === "string" && isAbsolute(provided)) return provided;
  if (isRecord(ctx) && typeof ctx.cwd === "string" && isAbsolute(ctx.cwd)) return ctx.cwd;
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Bounded rendering helpers
// ---------------------------------------------------------------------------

function textResult(text: string, details: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text }], details, isError: false };
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[... truncated ...]`;
}

function clip(value: string, width: number): string {
  const compact = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
  return compact.length <= width ? compact : `${compact.slice(0, Math.max(1, width - 1))}…`;
}

function textComponent(render: (width: number) => string[]) {
  return { render: (width: number) => render(Math.max(20, width - 2)), invalidate() {} };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
