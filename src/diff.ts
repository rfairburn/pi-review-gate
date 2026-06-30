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
  const oldRange = rangeHeader(oldLines.length);
  const newRange = rangeHeader(newLines.length);
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return [
    `diff --git a/${change.path} b/${change.path}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...body,
    "",
  ].join("\n");
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

function rangeHeader(lineCount: number): string {
  return lineCount === 0 ? "0,0" : `1,${lineCount}`;
}
