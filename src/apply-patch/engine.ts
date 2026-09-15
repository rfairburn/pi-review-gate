/// ApplyPatch V4A diff engine.
///
/// Adapted from the OpenAI Agents JS implementation of the V4A ("apply_patch")
/// diff format:
///   https://github.com/openai/openai-agents-js — packages/agents-core/src/utils/applyDiff.ts
///   https://developers.openai.com/api/docs/guides/tools-apply-patch
///
/// Copyright (c) 2025 OpenAI. Modified 2026 Robert Fairburn (pi-review-gate).
/// Substantially copied and adapted; distributed under the MIT License. The
/// full MIT License text is reproduced in LICENSES/MIT-openai-agents-js.txt
/// and summarized in NOTICE.
///
/// Modifications from upstream:
/// - Retained the headerless V4A update application only; file headers
///   ("*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:")
///   are parsed by the canonical envelope parser (envelope.ts), and the
///   create-file mode is dropped because canonical `*** Add File:` hunks carry
///   their final content directly.
/// - Errors carry the same informative diagnostics as upstream.
///
/// Applies a headerless V4A update diff to the provided file content using
/// V4A sections ("@@" + +/-/space lines). The function preserves trailing
/// newlines from the original file and throws when the diff cannot be applied
/// cleanly.

export function applyDiff(input: string, diff: string): string {
  const diffLines = normalizeDiffLines(diff);
  const { chunks } = parseUpdateDiff(diffLines, input);
  return applyChunks(input, chunks);
}

type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

type ParserState = { lines: string[]; index: number; fuzz: number };

const END_PATCH = "*** End Patch";
const END_FILE = "*** End of File";
const END_SECTION_MARKERS = [
  END_PATCH,
  "*** Update File:",
  "*** Delete File:",
  "*** Add File:",
  END_FILE,
];

function normalizeDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
}

function isDone(state: ParserState, prefixes: string[]): boolean {
  if (state.index >= state.lines.length) return true;
  if (prefixes.some((p) => state.lines[state.index]?.startsWith(p))) return true;
  return false;
}

function readStr(state: ParserState, prefix: string): string {
  const current = state.lines[state.index];
  if (typeof current === "string" && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return "";
}

function parseUpdateDiff(lines: string[], input: string): { chunks: Chunk[]; fuzz: number } {
  const parser: ParserState = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0,
  };
  const inputLines = input.split("\n");
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (!isDone(parser, END_SECTION_MARKERS)) {
    const { anchors, anchorCount } = readAnchors(parser);

    if (!(anchorCount > 0 || cursor === 0)) {
      throw new Error(`Invalid Line:\n${parser.lines[parser.index]}`);
    }

    const requireAnchorMatch = anchorCount > 1;
    for (const [index, anchor] of anchors.entries()) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser, requireAnchorMatch, index > 0);
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index);
    const nextContextText = nextContext.join("\n");
    const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);

    if (newIndex === -1) {
      if (eof) {
        throw new Error(`Invalid EOF Context ${cursor}:\n${nextContextText}`);
      }
      throw new Error(`Invalid Context ${cursor}:\n${nextContextText}`);
    }

    parser.fuzz += fuzz;
    for (const ch of sectionChunks) {
      chunks.push({ ...ch, origIndex: ch.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  return { chunks, fuzz: parser.fuzz };
}

function readAnchors(parser: ParserState): { anchors: string[]; anchorCount: number } {
  const anchors: string[] = [];
  let anchorCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const startIndex = parser.index;
    const anchor = readStr(parser, "@@ ");
    let consumed = parser.index !== startIndex;

    if (!consumed && parser.lines[parser.index] === "@@") {
      parser.index += 1;
      consumed = true;
    }

    if (!consumed) break;
    anchorCount += 1;
    if (anchor.trim()) anchors.push(anchor);
  }

  return { anchors, anchorCount };
}

function advanceCursorToAnchor(
  anchor: string,
  inputLines: string[],
  cursor: number,
  parser: ParserState,
  requireMatch = false,
  forceForwardSearch = false,
): number {
  let found = false;
  const hasExactMatchBeforeCursor =
    !forceForwardSearch && inputLines.slice(0, cursor).some((line) => line === anchor);

  if (hasExactMatchBeforeCursor) {
    found = true;
  } else {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i] === anchor) {
        cursor = i + 1;
        found = true;
        break;
      }
    }
  }

  if (!found) {
    const hasTrimmedMatchBeforeCursor =
      !forceForwardSearch && inputLines.slice(0, cursor).some((line) => line.trim() === anchor.trim());

    if (hasTrimmedMatchBeforeCursor) {
      found = true;
    } else {
      for (let i = cursor; i < inputLines.length; i += 1) {
        if (inputLines[i].trim() === anchor.trim()) {
          cursor = i + 1;
          parser.fuzz += 1;
          found = true;
          break;
        }
      }
    }
  }

  if (requireMatch && !found) {
    throw new Error(`Invalid Anchor ${cursor}:\n${anchor}`);
  }

  return cursor;
}

function readSection(lines: string[], startIndex: number): {
  nextContext: string[];
  sectionChunks: Chunk[];
  endIndex: number;
  eof: boolean;
} {
  const context: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const sectionChunks: Chunk[] = [];
  let mode: "keep" | "add" | "delete" = "keep";
  let index = startIndex;
  const origIndex = index;

  while (index < lines.length) {
    const raw = lines[index];
    if (
      raw.startsWith("@@") ||
      raw.startsWith(END_PATCH) ||
      raw.startsWith("*** Update File:") ||
      raw.startsWith("*** Delete File:") ||
      raw.startsWith("*** Add File:") ||
      raw.startsWith(END_FILE)
    ) {
      break;
    }
    if (raw === "***") break;
    if (raw.startsWith("***")) {
      throw new Error(`Invalid Line: ${raw}`);
    }

    index += 1;
    const lastMode: "keep" | "add" | "delete" = mode;
    let line = raw;
    if (line === "") line = " ";

    if (line[0] === "+") {
      mode = "add";
    } else if (line[0] === "-") {
      mode = "delete";
    } else if (line[0] === " ") {
      mode = "keep";
    } else {
      throw new Error(`Invalid Line: ${line}`);
    }

    line = line.slice(1);

    const switchingToContext = mode === "keep" && lastMode !== mode;
    if (switchingToContext && (insLines.length || delLines.length)) {
      sectionChunks.push({
        origIndex: context.length - delLines.length,
        delLines,
        insLines,
      });
      delLines = [];
      insLines = [];
    }

    if (mode === "delete") {
      delLines.push(line);
      context.push(line);
    } else if (mode === "add") {
      insLines.push(line);
    } else {
      context.push(line);
    }
  }

  if (insLines.length || delLines.length) {
    sectionChunks.push({
      origIndex: context.length - delLines.length,
      delLines,
      insLines,
    });
    delLines = [];
    insLines = [];
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1;
    return { nextContext: context, sectionChunks, endIndex: index, eof: true };
  }

  if (index === origIndex) {
    throw new Error(`Nothing in this section - index=${index} ${lines[index]}`);
  }

  return { nextContext: context, sectionChunks, endIndex: index, eof: false };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { newIndex: number; fuzz: number } {
  if (eof) {
    const searchLines = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    const endStart = Math.max(0, searchLines.length - context.length);
    const endMatch = findContextCore(searchLines, context, endStart);
    if (endMatch.newIndex !== -1) return endMatch;
    const fallback = findContextCore(searchLines, context, Math.min(start, searchLines.length));
    return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10000 };
  }
  return findContextCore(lines, context, start);
}

function findContextCore(lines: string[], context: string[], start: number): { newIndex: number; fuzz: number } {
  if (!context.length) {
    return { newIndex: start, fuzz: 0 };
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s)) return { newIndex: i, fuzz: 0 };
  }
  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s.trimEnd())) return { newIndex: i, fuzz: 1 };
  }
  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s.trim())) return { newIndex: i, fuzz: 100 };
  }

  return { newIndex: -1, fuzz: 0 };
}

function equalsSlice(source: string[], target: string[], start: number, mapFn: (value: string) => string): boolean {
  if (start + target.length > source.length) return false;
  for (let i = 0; i < target.length; i += 1) {
    if (mapFn(source[start + i]) !== mapFn(target[i])) return false;
  }
  return true;
}

function applyChunks(input: string, chunks: Chunk[]): string {
  const origLines = input.split("\n");
  const destLines: string[] = [];
  let origIndex = 0;

  for (const chunk of chunks) {
    if (chunk.origIndex > origLines.length) {
      throw new Error(`applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${origLines.length}`);
    }
    if (origIndex > chunk.origIndex) {
      throw new Error(`applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex})`);
    }

    destLines.push(...origLines.slice(origIndex, chunk.origIndex));
    origIndex = chunk.origIndex;

    if (chunk.insLines.length) {
      destLines.push(...chunk.insLines);
    }

    origIndex += chunk.delLines.length;
  }

  destLines.push(...origLines.slice(origIndex));
  const result = destLines.join("\n");
  return result;
}