import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChangedFile } from "../capture";
import { sourceMutationCoordinator } from "../execution/source-mutation-lease";
import { buildUnifiedPatch } from "../diff";
import { applyDiff } from "./engine";

export const APPLY_PATCH_TOOL_NAME = "ApplyPatch";

export type ApplyPatchOperationType = "create_file" | "update_file" | "delete_file";

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

export interface ApplyPatchOutcome {
  operation: ApplyPatchOperationType;
  path: string;
  moveTo?: string;
  absolutePath: string;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  bytes: number;
  requestedDiff: string;
  finalDiff?: string;
  mutated: boolean;
}

const OPERATION_TYPES: readonly ApplyPatchOperationType[] = ["create_file", "update_file", "delete_file"];
const MAX_REQUESTED_DIFF_CHARS = 4_000;
const MAX_FINAL_DIFF_BYTES = 8_000;
const MAX_DELETE_SOURCE_BYTES = 262_144;

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
 * Validates the strict structured `operation` argument and rejects unknown or
 * operation-inconsistent fields with informative errors. Paths are normalized
 * (a single leading `@` convention marker is stripped) but not yet confined to
 * the workspace; confinement happens immediately before mutation.
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

  const path = normalizePath(operation.path, "operation.path");
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
  const moveTo = normalizePath(moveToRaw, "operation.moveTo");
  if (moveTo === path) throw new Error("operation.moveTo must differ from operation.path");
  return { type: operationType, path, diff, moveTo };
}

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
    required: ["operation"],
    properties: {
      operation: {
        description:
          "Exactly one structured OpenAI apply-patch file operation. One file operation per call; each operation type has its own required and forbidden fields.",
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
  };
}

export interface ApplyPatchToolOptions {
  cwd?: () => string;
}

export async function performApplyPatchOperation(
  cwd: string,
  operation: ParsedApplyPatchOperation,
  signal?: AbortSignal,
): Promise<ApplyPatchOutcome> {
  ensureNotAborted(signal);
  const rootLexical = resolve(cwd);
  const rootReal = await realpath(rootLexical);

  const requestedDiff = clipText(operation.type === "delete_file" ? "" : operation.diff, MAX_REQUESTED_DIFF_CHARS);
  const base = {
    operation: operation.type,
    path: operation.path,
    ...(operation.type === "update_file" && operation.moveTo ? { moveTo: operation.moveTo } : {}),
    requestedDiff,
    mutated: false,
  };

  if (operation.type === "create_file") {
    const target = await confinePath(rootLexical, rootReal, operation.path, "operation.path");
    await requireAbsent(target.absolute, operation.path);
    ensureNotAborted(signal);
    const content = createContent(operation.diff, operation.path);
    // Commit through the same atomic no-overwrite link as move destinations:
    // a target created between the absence check and the commit is rejected
    // with EEXIST instead of being overwritten.
    await atomicCreate(target.absolute, content, operation.path, signal);
    const diff = renderFinalDiff({ path: operation.path, status: "added", newContent: content });
    return {
      ...base,
      absolutePath: target.absolute,
      changed: true,
      ...countDiffLines(diff),
      bytes: Buffer.byteLength(content, "utf8"),
      finalDiff: diff,
      mutated: true,
    };
  }

  if (operation.type === "delete_file") {
    const target = await confinePath(rootLexical, rootReal, operation.path, "operation.path");
    const stats = await requireRegularFile(target.absolute, operation.path);
    // Validate the complete source before mutating: ApplyPatch only handles
    // UTF-8 text files, and a cancellation arriving during this read must not
    // lead to an unlink.
    const original = await decodeText(target.absolute, operation.path);
    const { text: body } = splitEncoding(original);
    if (body.includes("\0")) {
      throw new Error(`delete_file ${operation.path}: refusing to delete binary content (NUL byte)`);
    }
    // Render a bounded deletion diff for reasonably sized sources.
    let finalDiff: string | undefined;
    if (stats.size <= MAX_DELETE_SOURCE_BYTES) {
      finalDiff = renderFinalDiff({ path: operation.path, status: "deleted", oldContent: body });
    }
    ensureNotAborted(signal);
    await unlink(target.absolute);
    return {
      ...base,
      absolutePath: target.absolute,
      changed: true,
      addedLines: 0,
      removedLines: finalDiff !== undefined ? countDiffLines(finalDiff).removedLines : 0,
      bytes: stats.size,
      ...(finalDiff !== undefined ? { finalDiff } : {}),
      mutated: true,
    };
  }

  // update_file: patch the content, then either write it in place or commit
  // it at the moveTo destination before removing the source.
  const source = await confinePath(rootLexical, rootReal, operation.path, "operation.path");
  const stats = await requireRegularFile(source.absolute, operation.path);
  const original = await decodeText(source.absolute, operation.path);
  const { text: body, hadBom, hadCrlf } = splitEncoding(original);

  let updated: string;
  try {
    updated = applyDiff(body, operation.diff, "default");
  } catch (error) {
    throw new Error(`update_file ${operation.path}: ${messageOf(error)}`);
  }
  if (updated.includes("\0") || body.includes("\0")) {
    throw new Error(`update_file ${operation.path}: refusing to write binary content (NUL byte)`);
  }
  const content = joinEncoding(updated, hadBom, hadCrlf);
  const changed = updated !== body;

  if (operation.moveTo === undefined) {
    if (!changed) {
      // A patch that changes nothing must not replace the file: rewriting
      // would change the inode and timestamps and could discard hard-link
      // identity or extended metadata.
      ensureNotAborted(signal);
      return {
        ...base,
        absolutePath: source.absolute,
        changed: false,
        addedLines: 0,
        removedLines: 0,
        bytes: Buffer.byteLength(content, "utf8"),
        mutated: false,
      };
    }
    const diff = renderFinalDiff({ path: operation.path, status: "modified", oldContent: body, newContent: updated });
    ensureNotAborted(signal);
    await atomicWrite(source.absolute, content, stats.mode, signal);
    return {
      ...base,
      absolutePath: source.absolute,
      changed,
      ...countDiffLines(diff),
      bytes: Buffer.byteLength(content, "utf8"),
      finalDiff: diff,
      mutated: true,
    };
  }

  const moveTo = operation.moveTo;
  // Validate the move destination before mutating anything so an unsafe move
  // rejects the whole operation without touching the source file.
  const destination = await confinePath(rootLexical, rootReal, moveTo, "operation.moveTo");
  if (destination.absolute === source.absolute || destination.real === source.real) {
    throw new Error(`operation.moveTo ${moveTo} resolves to the same file as operation.path ${operation.path}`);
  }
  await requireAbsent(destination.absolute, moveTo);

  // Stage and commit the patched content at the destination first; the source
  // is removed only after the destination exists, so any destination-side
  // failure leaves the original source bytes in place.
  const temp = await stageContent(dirname(destination.absolute), basename(destination.absolute), content, stats.mode, signal);
  try {
    await commitStaged(
      temp,
      destination.absolute,
      `operation.moveTo ${moveTo} already exists; refusing to overwrite an existing destination`,
    );
  } catch (error) {
    // The source was never touched; only the staged temporary file remains.
    await unlink(temp).catch(() => undefined);
    throw new Error(`update_file ${operation.path}: moving to ${moveTo} failed and the source was left unchanged: ${messageOf(error)}`);
  }
  try {
    ensureNotAborted(signal);
    await unlink(source.absolute);
  } catch (error) {
    // The destination commit succeeded but the source could not be removed;
    // roll back by removing the destination so the original file remains.
    await unlink(destination.absolute).catch(() => undefined);
    throw new Error(
      `update_file ${operation.path}: ${moveTo} was created but removing ${operation.path} failed, so the move was rolled back: ${messageOf(error)}`,
    );
  }

  const finalDiff = renderFinalDiff({ path: moveTo, renamedFrom: operation.path, status: "modified", oldContent: body, newContent: updated });
  return {
    ...base,
    absolutePath: destination.absolute,
    changed,
    ...countDiffLines(finalDiff),
    bytes: Buffer.byteLength(content, "utf8"),
    finalDiff,
    mutated: true,
  };
}

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
  const operation = isRecord(args) && isRecord(args.operation) ? args.operation : undefined;
  const type = typeof operation?.type === "string" ? operation.type : "operation";
  const path = typeof operation?.path === "string" ? operation.path : "";
  const moveTo = typeof operation?.moveTo === "string" ? ` → ${operation.moveTo}` : "";
  const suffix = path ? ` · ${type} · ${path}${moveTo}` : ` · ${type}`;
  return textComponent((width) => [
    clip(theme.fg("toolTitle", theme.bold(APPLY_PATCH_TOOL_NAME)) + theme.fg("accent", suffix), width),
  ]);
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
      // the shorter V4A body the model sent.
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
      "Apply one structured OpenAI apply_patch (V4A) file operation — create_file, update_file (with optional moveTo rename), or delete_file — to a single file inside the current workspace. " +
      "The headerless V4A diff body anchors changes with '@@' context lines and ' ' context, '-' removal, and '+' addition lines; failed calls never leave partial writes. " +
      "With moveTo, the patched content is committed at the destination before the source is removed, so a failed move leaves the source unchanged. " +
      "One file operation per call: call ApplyPatch repeatedly for multiple files; there is no cross-call or multi-file rollback.",
    promptSnippet:
      "Use ApplyPatch for precise single-file create/update/delete/rename mutations with V4A diffs; every call is sequential and confined to the current workspace.",
    promptGuidelines: [
      "ApplyPatch performs exactly one file operation per call; for several files, call it once per file and treat each result as independent.",
      "Pass the V4A diff headerless in operation.diff because operation.type and paths are structured fields; create_file diff lines must all start with '+'.",
      "ApplyPatch failures are atomic and reported as tool errors; fix the diff or path from the diagnostic and retry rather than working around it with shell commands.",
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
 * Parsing and validation complete before the mutation lease is acquired, and
 * each mutation is performed atomically, so a thrown failure never leaves a
 * partial write.
 */
async function executeApplyPatch(
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: unknown,
  options: ApplyPatchToolOptions,
): Promise<Record<string, unknown>> {
  const operation = parseApplyPatchOperation(params);
  const cwd = resolveToolCwd(options, ctx);
  // Serialize the validated mutation window against background-task landing
  // and honor an active conflict gate; abort while waiting is supported.
  const release = await sourceMutationCoordinator.acquire(cwd, signal);
  let outcome: ApplyPatchOutcome;
  try {
    outcome = await performApplyPatchOperation(cwd, operation, signal);
  } finally {
    release();
  }
  return textResult(successSummary(outcome), outcomeDetails(outcome));
}

function successSummary(outcome: ApplyPatchOutcome): string {
  switch (outcome.operation) {
    case "create_file":
      return `ApplyPatch created ${outcome.path} (${outcome.bytes} bytes).`;
    case "delete_file":
      return `ApplyPatch deleted ${outcome.path}.`;
    case "update_file": {
      const moved = outcome.moveTo ? ` and moved it to ${outcome.moveTo}` : "";
      if (!outcome.changed) return `ApplyPatch updated ${outcome.path}${moved} with no content change.`;
      return `ApplyPatch updated ${outcome.path}${moved} (+${outcome.addedLines} −${outcome.removedLines} lines).`;
    }
  }
}

function outcomeDetails(outcome: ApplyPatchOutcome): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

async function confinePath(rootLexical: string, rootReal: string, rawPath: string, field: string): Promise<{ absolute: string; real: string }> {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootLexical, rawPath);
  assertWithinRoot(rootLexical, absolute, field, rawPath);
  let real: string;
  try {
    real = await nearestRealPath(absolute);
  } catch (error) {
    throw new Error(`${field} ${rawPath} could not be resolved within the current workspace: ${messageOf(error)}`);
  }
  assertWithinRoot(rootReal, real, field, rawPath);
  return { absolute, real };
}

function assertWithinRoot(root: string, candidate: string, field: string, rawPath: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    throw new Error(`${field} ${rawPath} must reference a file inside the current workspace, not the workspace root`);
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${field} ${rawPath} resolves outside the current workspace (${root}); traversal is rejected`);
  }
}

/** Realpath of the nearest existing ancestor with the remainder re-joined; detects symlink escapes. */
async function nearestRealPath(absolute: string): Promise<string> {
  let prefix = absolute;
  const suffixes: string[] = [];
  for (;;) {
    try {
      const real = await realpath(prefix);
      return suffixes.length > 0 ? join(real, ...suffixes) : real;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) throw new Error(`could not resolve path: ${absolute}`);
      suffixes.unshift(basename(prefix));
      prefix = parent;
    }
  }
}

async function requireAbsent(absolute: string, display: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR") {
      throw new Error(`${display} cannot exist because an intermediate path component is not a directory`);
    }
    throw new Error(`${display}: ${messageOf(error)}`);
  }
  if (stats.isDirectory()) {
    throw new Error(`${display} already exists and is a directory; create_file requires a non-existing file path`);
  }
  throw new Error(`${display} already exists; create_file and moveTo destinations must not exist`);
}

async function requireRegularFile(absolute: string, display: string): Promise<{ mode: number | undefined; size: number }> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${display} does not exist; only create_file may add a new file`);
    }
    throw new Error(`${display}: ${messageOf(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${display} is a symlink; ApplyPatch refuses to follow, modify, or replace symlinks`);
  }
  if (!stats.isFile()) {
    throw new Error(`${display} is not a regular file`);
  }
  return { mode: stats.mode, size: stats.size };
}

async function decodeText(absolute: string, display: string): Promise<string> {
  const bytes = await readFile(absolute);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${display} is binary or not valid UTF-8; ApplyPatch only mutates UTF-8 text files`);
  }
}

function splitEncoding(content: string): { text: string; hadBom: boolean; hadCrlf: boolean } {
  const hadBom = content.charCodeAt(0) === 0xfeff;
  const withoutBom = hadBom ? content.slice(1) : content;
  const hadCrlf = withoutCrlfAmbiguity(withoutBom);
  const text = hadCrlf ? withoutBom.replace(/\r\n/g, "\n") : withoutBom;
  return { text, hadBom, hadCrlf };
}

function joinEncoding(content: string, hadBom: boolean, hadCrlf: boolean): string {
  let result = hadCrlf ? content.replace(/\n/g, "\r\n") : content;
  if (hadBom) result = `\uFEFF${result}`;
  return result;
}

function withoutCrlfAmbiguity(content: string): boolean {
  return content.includes("\r\n");
}

/**
 * Strips surrounding whitespace and the single leading `@` convention marker
 * used by built-in file tools. Exported so evidence extraction normalizes
 * operation paths identically to the tool's own path handling.
 */
export function normalizeApplyPatchPathMarker(value: string): string {
  let candidate = value.trim();
  if (candidate.startsWith("@")) candidate = candidate.slice(1).trim();
  return candidate;
}

function normalizePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  const candidate = normalizeApplyPatchPathMarker(value);
  if (!candidate) throw new Error(`${field} is empty after removing the leading '@'`);
  if (candidate.includes("\0")) throw new Error(`${field} contains a NUL byte`);
  return candidate;
}

function resolveToolCwd(options: ApplyPatchToolOptions, ctx: unknown): string {
  const provided = options.cwd?.();
  if (typeof provided === "string" && isAbsolute(provided)) return provided;
  if (isRecord(ctx) && typeof ctx.cwd === "string" && isAbsolute(ctx.cwd)) return ctx.cwd;
  return process.cwd();
}

/**
 * Writes the replacement content to a same-directory temporary file and
 * returns its path. When a mode is provided, chmod restores the exact
 * original permission bits: open(2) masks the requested mode with the
 * process umask, so writeFile alone would not preserve e.g. 0o666 under
 * umask 022.
 */
async function stageContent(directory: string, fileName: string, content: string, mode: number | undefined, signal?: AbortSignal): Promise<string> {
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${fileName}.apply-patch-${process.pid}-${randomUUID()}.tmp`);
  try {
    ensureNotAborted(signal);
    await writeFile(temp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) await chmod(temp, mode & 0o7777);
    ensureNotAborted(signal);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  return temp;
}

async function atomicWrite(absolute: string, content: string, mode: number | undefined, signal?: AbortSignal): Promise<void> {
  const temp = await stageContent(dirname(absolute), basename(absolute), content, mode, signal);
  try {
    ensureNotAborted(signal);
    await rename(temp, absolute);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Creates a new file from staged content with no-overwrite semantics: the
 * link fails with EEXIST if the target appeared after requireAbsent, so a
 * concurrently created file is never destroyed.
 */
async function atomicCreate(absolute: string, content: string, display: string, signal?: AbortSignal): Promise<void> {
  const temp = await stageContent(dirname(absolute), basename(absolute), content, undefined, signal);
  try {
    ensureNotAborted(signal);
    await commitStaged(
      temp,
      absolute,
      `operation.path ${display} already exists; create_file refuses to overwrite an existing target`,
    );
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Commits staged content at the destination using link(), which is atomic and
 * fails with EEXIST when the destination already exists — no-overwrite
 * semantics without a separate check-then-commit window. If hard links are
 * unavailable, fail safely rather than falling back to rename(), which could
 * overwrite a destination created after validation.
 */
async function commitStaged(temp: string, destination: string, existsMessage: string): Promise<void> {
  try {
    await link(temp, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(existsMessage);
    throw error instanceof Error ? error : new Error(String(error));
  }
  await unlink(temp).catch(() => undefined);
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("ApplyPatch was cancelled");
  }
}

// ---------------------------------------------------------------------------
// Bounded rendering helpers
// ---------------------------------------------------------------------------

function renderFinalDiff(options: {
  path: string;
  renamedFrom?: string;
  status: "added" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
}): string {
  const change: ChangedFile = {
    path: options.path,
    status: options.status,
    binary: false,
    oversized: false,
    ...(options.renamedFrom ? { renamedFrom: options.renamedFrom } : {}),
    ...(options.oldContent !== undefined ? { oldContent: options.oldContent } : {}),
    ...(options.newContent !== undefined ? { newContent: options.newContent } : {}),
  };
  const { patch } = buildUnifiedPatch([change], MAX_FINAL_DIFF_BYTES);
  return patch.trimEnd();
}

/**
 * Counts added/removed content lines in a unified patch. Only the first
 * `--- `/`+++ ` line of each file section is a header; later lines that start
 * with those sequences are content (e.g. a removed line reading `-- flag`).
 */
function countDiffLines(patch: string): { addedLines: number; removedLines: number } {
  let added = 0;
  let removed = 0;
  let sawOldHeader = false;
  let sawNewHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      sawOldHeader = false;
      sawNewHeader = false;
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) continue;
    if (!sawOldHeader && line.startsWith("--- ")) { sawOldHeader = true; continue; }
    if (!sawNewHeader && line.startsWith("+++ ")) { sawNewHeader = true; continue; }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { addedLines: added, removedLines: removed };
}

function createContent(diff: string, display: string): string {
  let content: string;
  try {
    content = applyDiff("", diff, "create");
  } catch (error) {
    throw new Error(`create_file ${display}: ${messageOf(error)}`);
  }
  if (content.includes("\0")) {
    throw new Error(`create_file ${display}: refusing to write binary content (NUL byte)`);
  }
  return content;
}

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}