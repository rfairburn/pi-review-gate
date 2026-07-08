import type { ChangedFile } from "./capture";

export interface PatchBuildResult {
  patch: string;
  truncated: boolean;
  omitted: Array<{ path: string; reason: string }>;
}

export function buildUnifiedPatch(changes: ChangedFile[], maxPatchBytes: number): PatchBuildResult {
  const omitted: Array<{ path: string; reason: string }> = [];
  let patch = "";
  let truncated = false;

  for (const change of changes) {
    let section: string;
    if (change.diffOmittedReason || change.oldContent === undefined && change.status !== "added" || change.newContent === undefined && change.status !== "deleted") {
      const reason = change.diffOmittedReason ?? "content_unavailable";
      omitted.push({ path: change.path, reason });
      section = [
        `diff --git a/${change.path} b/${change.path}`,
        `# Diff omitted for ${change.path}: ${reason}`,
        "",
      ].join("\n");
    } else {
      section = buildFileDiff(change);
    }

    if (Buffer.byteLength(patch + section, "utf8") > maxPatchBytes) {
      truncated = true;
      const marker = `\n# Patch truncated after reaching maxPatchBytes=${maxPatchBytes}\n`;
      const remaining = Math.max(0, maxPatchBytes - Buffer.byteLength(patch, "utf8"));
      patch += marker.slice(0, remaining);
      break;
    }
    patch += section;
  }

  return { patch, truncated, omitted };
}

function buildFileDiff(change: ChangedFile): string {
  const oldContent = change.status === "added" ? "" : change.oldContent ?? "";
  const newContent = change.status === "deleted" ? "" : change.newContent ?? "";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldPath = change.status === "added" ? "/dev/null" : `a/${change.path}`;
  const newPath = change.status === "deleted" ? "/dev/null" : `b/${change.path}`;
  const body = buildHunks(oldLines, newLines);

  return [
    `diff --git a/${change.path} b/${change.path}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...body,
    "",
  ].join("\n");
}

type DiffOp = { type: "equal" | "delete" | "insert"; line: string; oldLine?: number; newLine?: number };

function buildHunks(oldLines: string[], newLines: string[]): string[] {
  const ops = diffLines(oldLines, newLines);
  const context = 3;
  const hunks: DiffOp[][] = [];
  let index = 0;

  while (index < ops.length) {
    while (index < ops.length && ops[index]?.type === "equal") {
      index += 1;
    }
    if (index >= ops.length) {
      break;
    }

    const start = Math.max(0, index - context);
    let end = index;
    let trailingEquals = 0;
    // Keep scanning through equal runs up to 2*context so nearby changes merge
    // into one hunk; splitting sooner would make the next hunk's leading
    // context overlap this hunk's trailing context.
    while (end < ops.length) {
      if (ops[end]?.type === "equal") {
        trailingEquals += 1;
        if (trailingEquals > context * 2) {
          break;
        }
      } else {
        trailingEquals = 0;
      }
      end += 1;
    }
    const hunkOps = ops.slice(start, end);
    let trailing = 0;
    while (trailing < hunkOps.length && hunkOps[hunkOps.length - 1 - trailing]?.type === "equal") {
      trailing += 1;
    }
    if (trailing > context) {
      hunkOps.length -= trailing - context;
    }
    hunks.push(hunkOps);
    index = end;
  }

  if (hunks.length === 0) {
    return [];
  }

  return hunks.flatMap(formatHunk);
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  if (oldLines.length * newLines.length > 4_000_000) {
    return diffLinesByPrefixSuffix(oldLines, newLines);
  }

  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      table[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[offset + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: "equal", line: oldLines[oldIndex] ?? "", oldLine: oldLine++, newLine: newLine++ });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      ops.push({ type: "delete", line: oldLines[oldIndex] ?? "", oldLine: oldLine++ });
      oldIndex += 1;
    } else {
      ops.push({ type: "insert", line: newLines[newIndex] ?? "", newLine: newLine++ });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    ops.push({ type: "delete", line: oldLines[oldIndex] ?? "", oldLine: oldLine++ });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    ops.push({ type: "insert", line: newLines[newIndex] ?? "", newLine: newLine++ });
    newIndex += 1;
  }
  return ops;
}

function diffLinesByPrefixSuffix(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ type: "equal", line: oldLines[index] ?? "", oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index <= oldSuffix; index += 1) {
    ops.push({ type: "delete", line: oldLines[index] ?? "", oldLine: index + 1 });
  }
  for (let index = prefix; index <= newSuffix; index += 1) {
    ops.push({ type: "insert", line: newLines[index] ?? "", newLine: index + 1 });
  }
  const oldTailStart = oldSuffix + 1;
  const newTailStart = newSuffix + 1;
  for (let offset = 0; oldTailStart + offset < oldLines.length && newTailStart + offset < newLines.length; offset += 1) {
    ops.push({
      type: "equal",
      line: oldLines[oldTailStart + offset] ?? "",
      oldLine: oldTailStart + offset + 1,
      newLine: newTailStart + offset + 1,
    });
  }
  return ops;
}

function formatHunk(ops: DiffOp[]): string[] {
  const oldStart = ops.find((op) => op.oldLine !== undefined)?.oldLine ?? 0;
  const newStart = ops.find((op) => op.newLine !== undefined)?.newLine ?? 0;
  const oldCount = ops.filter((op) => op.type !== "insert").length;
  const newCount = ops.filter((op) => op.type !== "delete").length;
  return [
    `@@ -${rangeHeader(oldStart, oldCount)} +${rangeHeader(newStart, newCount)} @@`,
    ...ops.map((op) => `${op.type === "insert" ? "+" : op.type === "delete" ? "-" : " "}${op.line}`),
  ];
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function rangeHeader(start: number, lineCount: number): string {
  if (lineCount === 0) {
    return `${Math.max(0, start - 1)},0`;
  }
  return lineCount === 1 ? String(start) : `${start},${lineCount}`;
}
