/// Canonical OpenAI/Codex apply_patch envelope parser.
///
/// Implements the public apply_patch grammar used by OpenAI Codex
/// (codex-rs/apply-patch in https://github.com/openai/codex):
///
///   *** Begin Patch
///   *** Add File: <path>
///   +<line>                     one or more; each line contributes "<line>\n"
///   *** Update File: <path>
///   *** Move to: <path>         optional rename, before the change lines
///   @@ [<anchor>]               starts a chunk (first chunk may omit it)
///   | <context>|+<added>|-<removed> lines
///   *** End of File             optional EOF anchor for the current chunk
///   *** Delete File: <path>
///   *** End Patch
///
/// Upstream behaviors mirrored here:
/// - lenient mode (Codex's default) unwraps a shell-style heredoc wrapper
///   (`<<EOF` ... `EOF`) before parsing;
/// - a bare empty line inside an update hunk is an empty context line;
/// - the first chunk of an update hunk may omit its `@@` marker;
/// - an update hunk without any change lines is rejected.
///
/// Deliberate deviations (documented in docs/security-model.md):
/// - `*** Environment ID:` lines are rejected: this tool patches the local
///   workspace only, and silently ignoring a remote environment id would be
///   unsafe;
/// - update-hunk bodies are handed to the existing V4A engine (engine.ts)
///   unmodified, so anchor/context/EOF application semantics stay identical to
///   single-file operations.

import { normalizeApplyPatchPathMarker } from "./paths";

export interface ApplyPatchFileOp {
  type: "create_file" | "update_file" | "delete_file";
  /** Normalized workspace path (a single leading `@` marker is stripped). */
  path: string;
  /** Normalized rename destination for update_file hunks (`*** Move to:`). */
  moveTo?: string;
  /** Headerless V4A diff body; always present for update_file operations. */
  diff?: string;
  /** Final file content for canonical `*** Add File:` hunks (each `+line` contributes `line + "\n"`). */
  createContent?: string;
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE_PREFIX = "*** Add File: ";
const DELETE_FILE_PREFIX = "*** Delete File: ";
const UPDATE_FILE_PREFIX = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const ENVIRONMENT_ID_PREFIX = "*** Environment ID:";

/** Parses a canonical apply_patch envelope into an ordered list of file operations. */
export function parseApplyPatchEnvelope(patch: unknown): ApplyPatchFileOp[] {
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new Error("patch is required and must be a non-empty canonical apply_patch envelope string");
  }
  const rawLines = patch.split(/\r?\n/);
  // Codex trims the whole patch text before checking the boundary markers.
  let start = 0;
  let end = rawLines.length;
  while (start < end && rawLines[start]!.trim() === "") start += 1;
  while (end > start && rawLines[end - 1]!.trim() === "") end -= 1;
  let lines = rawLines.slice(start, end);

  // Codex's default lenient mode unwraps a shell-style heredoc wrapper that
  // models sometimes emit around the envelope.
  if (lines.length >= 4) {
    const first = lines[0]!.trim();
    const last = lines[lines.length - 1]!.trim();
    if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith("EOF")) {
      lines = lines.slice(1, -1);
    }
  }

  if (lines.length === 0 || lines[0]!.trim() !== BEGIN_PATCH) {
    throw new Error("The first line of the patch must be '*** Begin Patch'");
  }
  let last = lines.length - 1;
  while (last > 0 && lines[last]!.trim() === "") last -= 1;
  if (lines[last]!.trim() !== END_PATCH) {
    throw new Error("The last line of the patch must be '*** End Patch'");
  }

  const ops: ApplyPatchFileOp[] = [];
  type Mode = "between" | "add" | "delete" | "update";
  let mode: Mode = "between";
  let addContent = "";
  let bodyLines: string[] = [];
  // Update-hunk bookkeeping mirroring the upstream chunk model:
  // started = at least one chunk began; chunkLines = lines in the last chunk.
  let updateStarted = false;
  let chunkLines = 0;
  let sawMoveTo = false;
  let sawEof = false;
  let updateHunkLine = 0;

  const hunkError = (message: string, lineNo: number): Error =>
    new Error(`invalid hunk at line ${lineNo}, ${message}`);

  const headerPath = (line: string, prefix: string, lineNo: number): string => {
    const raw = line.slice(prefix.length);
    if (raw.includes("\0")) throw hunkError(`path in '${line.trim()}' contains a NUL byte`, lineNo);
    const path = normalizeApplyPatchPathMarker(raw);
    if (!path) throw hunkError(`${prefix.trim()} requires a non-empty path`, lineNo);
    return path;
  };

  const beginUpdateHunk = (line: string, lineNo: number): void => {
    ops.push({ type: "update_file", path: headerPath(line, UPDATE_FILE_PREFIX, lineNo) });
    bodyLines = [];
    updateStarted = false;
    chunkLines = 0;
    sawMoveTo = false;
    sawEof = false;
    updateHunkLine = lineNo;
  };

  /** Closes the open update hunk when a new header or End Patch terminates it. */
  const closeUpdateHunk = (terminator: string, lineNo: number): void => {
    if (mode !== "update") return;
    const op = ops[ops.length - 1]!;
    if (!updateStarted) {
      throw hunkError(`Update file hunk for path '${op.path}' is empty`, updateHunkLine);
    }
    if (chunkLines === 0) {
      if (terminator === END_PATCH) {
        throw hunkError("Update hunk does not contain any lines", lineNo);
      }
      throw hunkError(
        `Unexpected line found in update hunk: '${terminator}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNo,
      );
    }
    op.diff = bodyLines.join("\n");
    bodyLines = [];
  };

  const isFileHeader = (line: string): boolean =>
    line.startsWith(ADD_FILE_PREFIX) || line.startsWith(DELETE_FILE_PREFIX) || line.startsWith(UPDATE_FILE_PREFIX);

  for (let i = 1; i <= last; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (mode === "update") {
      // Upstream matches headers on the right-trimmed line inside update
      // hunks, so a leading space keeps a marker-like line a context line.
      const ul = line.replace(/[\s]+$/, "");
      if (ul === END_PATCH || isFileHeader(ul)) {
        closeUpdateHunk(ul === END_PATCH ? END_PATCH : ul, lineNo);
        mode = "between";
        if (ul === END_PATCH) continue;
        // Re-dispatch the new header below.
      } else {
        if (sawEof) {
          if (ul === "") continue;
          if (ul === "@@" || ul.startsWith("@@ ")) {
            sawEof = false;
            chunkLines = 0;
            bodyLines.push(line);
            updateStarted = true;
            continue;
          }
          throw hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNo);
        }
        if (!updateStarted && !sawMoveTo && ul.startsWith(MOVE_TO_PREFIX)) {
          const op = ops[ops.length - 1]!;
          op.moveTo = headerPath(ul, MOVE_TO_PREFIX, lineNo);
          sawMoveTo = true;
          continue;
        }
        if ((ul === "@@" || ul.startsWith("@@ ")) && updateStarted && chunkLines === 0) {
          throw hunkError(
            `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
            lineNo,
          );
        }
        if (ul === "@@" || ul.startsWith("@@ ")) {
          bodyLines.push(line);
          updateStarted = true;
          chunkLines = 0;
          continue;
        }
        if (ul === EOF_MARKER) {
          if (!updateStarted) continue; // upstream ignores an EOF marker with no chunk yet
          if (chunkLines === 0) throw hunkError("Update hunk does not contain any lines", lineNo);
          bodyLines.push(line);
          sawEof = true;
          continue;
        }
        if (line === "" || line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
          bodyLines.push(line);
          updateStarted = true;
          chunkLines += 1;
          continue;
        }
        if (updateStarted && chunkLines > 0) {
          throw hunkError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNo);
        }
        throw hunkError(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNo,
        );
      }
    }

    // "between", "add", and "delete" states match headers on the fully trimmed line.
    const t = line.trim();
    if (mode === "add") {
      if (t !== END_PATCH && !isFileHeader(t)) {
        if (!line.startsWith("+")) {
          throw hunkError(`'${t}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, lineNo);
        }
        addContent += `${line.slice(1)}\n`;
        continue;
      }
      ops[ops.length - 1]!.createContent = addContent;
      addContent = "";
      mode = "between";
    } else if (mode === "delete") {
      if (t !== END_PATCH && !isFileHeader(t)) {
        throw hunkError(`'${t}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, lineNo);
      }
      mode = "between";
    }

    if (t === END_PATCH) continue; // final line; loop ends after it
    if (t.startsWith(ENVIRONMENT_ID_PREFIX)) {
      throw new Error("apply_patch environment_id is not supported; ApplyPatch patches the current workspace only");
    }
    if (t.startsWith(ADD_FILE_PREFIX)) {
      ops.push({ type: "create_file", path: headerPath(t, ADD_FILE_PREFIX, lineNo), createContent: "" });
      mode = "add";
      addContent = "";
      continue;
    }
    if (t.startsWith(DELETE_FILE_PREFIX)) {
      ops.push({ type: "delete_file", path: headerPath(t, DELETE_FILE_PREFIX, lineNo) });
      mode = "delete";
      continue;
    }
    if (t.startsWith(UPDATE_FILE_PREFIX)) {
      beginUpdateHunk(t, lineNo);
      mode = "update";
      continue;
    }
    throw hunkError(`'${t}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, lineNo);
  }

  return ops;
}

/**
 * Extracts the file paths an envelope intends to mutate, for evidence capture.
 * Uses the full parser when the envelope is well formed and falls back to a
 * header-line scan otherwise so malformed calls still pre-capture their targets.
 */
export function extractEnvelopeCandidatePaths(patch: string): Array<{ path: string; source: string }> {
  try {
    const candidates: Array<{ path: string; source: string }> = [];
    for (const op of parseApplyPatchEnvelope(patch)) {
      candidates.push({ path: op.path, source: "patch" });
      if (op.moveTo) candidates.push({ path: op.moveTo, source: "patch.move" });
    }
    return candidates;
  } catch {
    const candidates: Array<{ path: string; source: string }> = [];
    for (const line of patch.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith(ADD_FILE_PREFIX) || t.startsWith(UPDATE_FILE_PREFIX) || t.startsWith(DELETE_FILE_PREFIX)) {
        const path = normalizeApplyPatchPathMarker(t.slice(t.indexOf(": ") + 2));
        if (path) candidates.push({ path, source: "patch" });
      } else if (t.startsWith(MOVE_TO_PREFIX)) {
        const path = normalizeApplyPatchPathMarker(t.slice(MOVE_TO_PREFIX.length));
        if (path) candidates.push({ path, source: "patch.move" });
      }
    }
    return candidates;
  }
}